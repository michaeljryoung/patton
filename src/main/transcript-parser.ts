/**
 * The session bar's transcript parser (docs/session-bar.md D6, D9): Claude
 * Code transcript text in, `SessionFeedEvent`s out. Pure (no fs, no Electron),
 * so scripts/check-session-feed.mjs runs it over fixture lines headlessly; the
 * file following lives in transcript-tail.ts.
 *
 * Line shapes, read from the transcripts on this Mac (22 Nov 2026, structure
 * and counts only; Claude Code v2.1.3xx):
 * - Every line is one JSON object. Conversation lines (`assistant`, `user`,
 *   `attachment`, `system`) start with `"parentUuid"`; bookkeeping lines start
 *   with `"type"` (`api-request-blob` lines run to ~1 MB). Only
 *   `queue-operation` among those matters, so the rest are skipped unparsed.
 * - Tool calls: `assistant` → `message.content[]` `{type:'tool_use', id, name,
 *   input}`. The result: `user` → `message.content[]` `{type:'tool_result',
 *   tool_use_id, content}` plus a top-level `toolUseResult` object.
 * - Background shell: Bash `input.run_in_background`; result
 *   `toolUseResult.backgroundTaskId` (or `backgroundTaskId` alone when the
 *   2-minute timeout moved it), text "Command running in background with ID:
 *   <id>." or "…was moved to the background (ID: <id>)."
 * - Background agent: Agent `toolUseResult {status:'async_launched', isAsync,
 *   agentId, description}`, text "Async agent launched successfully. agentId: …".
 * - Monitor: `toolUseResult {taskId, persistent, timeoutMs}`, text "Monitor
 *   started (task <id>, …"; `input {command, description}`.
 * - Workflow: text "Workflow launched in background. Task ID: <id>".
 * - Task notices: a `<task-notification>` string with `<task-id>`,
 *   `<tool-use-id>`, `<status>` (completed, failed, killed seen), `<summary>`
 *   ("Background command "…" completed (exit code 0)", "…failed with exit code
 *   1", "…was stopped", "Agent "…" finished", "Agent "…" was stopped by
 *   Claude", "Monitor "…" stream ended"); Monitor events carry `<event>` and
 *   no status, and are not ends. A notice is written first as a
 *   `queue-operation` `enqueue` (`content`), then again as an `attachment`
 *   `queued_command` (`attachment.prompt`) or a `user` line whose content is
 *   the string; every copy is read, and an id ends once. A notice for an id
 *   this transcript never started (a subagent's own shell) is dropped.
 * - ScheduleWakeup: `input {delaySeconds, prompt, reason}` (or `{stop}`).
 * - Timestamps: top-level ISO `timestamp`.
 */
import type { FeedTaskEndStatus, FeedTaskKind, SessionFeedEvent } from '../shared/session-feed';

export const DESCRIPTION_MAX = 200;
export const LABEL_MAX = 120;
const URL_MAX = 2048;
const PATH_MAX = 1024;
/** A line longer than this is dropped whole (they are api blobs, not events). */
export const LINE_MAX = 16 * 1024 * 1024;
/** Tool calls remembered so a later result can name its description. */
const TOOL_USE_MEMORY = 2000;
/** Task ids remembered for start / end dedupe. */
const ID_MEMORY = 5000;

const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;

// C0 and C1 controls, DEL, and the bidi overrides and isolates that can make
// shown text read differently from what it is.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Strip control characters, collapse whitespace, cap the length. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + '…';
}

function timeOf(line: Record<string, unknown>, fallback: number): number {
  const t = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (isRecord(part) && typeof part.text === 'string') out += part.text + '\n';
  }
  return out;
}

// ---------------------------------------------------------------- links (D6)

const URL_PATTERNS: Array<{ re: RegExp; id: (m: RegExpMatchArray) => string }> = [
  // claude.ai artifacts: /code/artifact/<id>, /artifact/<id>, /public/artifacts/<id>
  { re: /^https:\/\/claude\.ai\/(?:[a-z]+\/)*artifacts?\/([A-Za-z0-9-]+)/, id: (m) => m[1] },
  { re: /^https:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/, id: (m) => m[1] },
  { re: /^https:\/\/drive\.google\.com\/(?:file\/(?:u\/\d+\/)?d\/|drive\/(?:u\/\d+\/)?folders\/|open\?id=)([A-Za-z0-9_-]+)/, id: (m) => m[1] },
  { re: /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)/, id: (m) => m[1] },
  { re: /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases(?:\/tag\/([^/?#\s]+))?/, id: (m) => m[1] ?? 'releases' },
];

const FILE_EXT = /\.(?:docx|pdf|xlsx|pptx|csv|html|png)$/i;
const TRAILING = /[.,;:!?'"`*_>\]})]+$/;

function urlLink(raw: string): { url: string; id: string } | null {
  let url = raw.replace(TRAILING, '');
  if (url.length > URL_MAX) return null;
  for (const p of URL_PATTERNS) {
    const m = url.match(p.re);
    if (m) {
      url = cleanText(url, URL_MAX);
      return { url, id: p.id(m) };
    }
  }
  return null;
}

function fileLink(raw: string, home: string): string | null {
  let p = raw.trim().replace(/^<|>$/g, '');
  if (p.startsWith('~/')) p = home + p.slice(1);
  const downloads = home.replace(/\/+$/, '') + '/Downloads/';
  if (!p.startsWith(downloads) || p.length > PATH_MAX) return null;
  if (!FILE_EXT.test(p)) return null;
  const rest = p.slice(downloads.length);
  // No climbing out, no empty segments, no control characters.
  if (rest.split('/').some((seg) => seg === '' || seg === '..' || seg === '.')) return null;
  if (p !== p.replace(CONTROL, '')) return null;
  return p;
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function pageLabel(id: string): string {
  return 'Page ' + id.slice(0, 8);
}

/** Links in one piece of Claude's text, in the order they appear. */
export function extractLinks(text: string, home: string, at: number): SessionFeedEvent[] {
  const found: Array<{ pos: number; ev: SessionFeedEvent }> = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) => taken.some(([s, e]) => a < e && b > s);

  // Markdown links first: [label](target), the label kept.
  const md = /\[([^\]\n]{1,300})\]\(\s*(<[^>\n]+>|[^)\s][^)\n]*?)\s*\)/g;
  for (const m of text.matchAll(md)) {
    const start = m.index ?? 0;
    const target = m[2].replace(/^<|>$/g, '');
    const label = cleanText(m[1].replace(/[`*_]/g, ''), LABEL_MAX);
    const u = urlLink(target);
    if (u) {
      found.push({ pos: start, ev: { type: 'link', url: u.url, label: label || pageLabel(u.id), at, ...(label ? {} : { fallback: true as const }) } });
      taken.push([start, start + m[0].length]);
      continue;
    }
    const f = fileLink(target, home);
    if (f) {
      found.push({ pos: start, ev: { type: 'link', path: f, label: label || cleanText(baseName(f), LABEL_MAX), at, ...(label ? {} : { fallback: true as const }) } });
      taken.push([start, start + m[0].length]);
    }
  }

  // Bare URLs.
  for (const m of text.matchAll(/https:\/\/[^\s<>"'`()[\]{}|\\^]+/g)) {
    const start = m.index ?? 0;
    if (overlaps(start, start + m[0].length)) continue;
    const u = urlLink(m[0]);
    if (u) found.push({ pos: start, ev: { type: 'link', url: u.url, label: pageLabel(u.id), at, fallback: true } });
  }

  // Bare paths under ~/Downloads (names may hold spaces, not after a slash).
  const homeRe = home.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathRe = new RegExp(
    `(?:~|${homeRe})/Downloads/(?:[^\\s/\`"'<>|*?\\n][^/\`"'<>|*?\\n]*?/)*[^\\s/\`"'<>|*?\\n][^/\`"'<>|*?\\n]*?\\.(?:docx|pdf|xlsx|pptx|csv|html|png)(?![A-Za-z0-9])`,
    'gi',
  );
  for (const m of text.matchAll(pathRe)) {
    const start = m.index ?? 0;
    if (overlaps(start, start + m[0].length)) continue;
    const f = fileLink(m[0], home);
    if (f) found.push({ pos: start, ev: { type: 'link', path: f, label: cleanText(baseName(f), LABEL_MAX), at, fallback: true } });
  }

  found.sort((a, b) => a.pos - b.pos);
  return found.map((x) => x.ev);
}

/**
 * One link event per URL or path within one assistant message (D6): the first
 * place it appears keeps its position, and a real label (the markdown text)
 * wins over a fallback one, wherever it appears.
 */
export function dedupeLinks(events: SessionFeedEvent[]): SessionFeedEvent[] {
  const out: SessionFeedEvent[] = [];
  const seen = new Map<string, number>();
  for (const ev of events) {
    if (ev.type !== 'link') {
      out.push(ev);
      continue;
    }
    const key = ev.url !== undefined ? `url:${ev.url}` : `path:${ev.path}`;
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, out.length);
      out.push(ev);
      continue;
    }
    const first = out[at];
    if (first.type === 'link' && first.fallback && !ev.fallback) {
      out[at] = first.url !== undefined
        ? { type: 'link', url: first.url, label: ev.label, at: first.at }
        : { type: 'link', path: first.path, label: ev.label, at: first.at };
    }
  }
  return out;
}

// ------------------------------------------------------------ notices (D9)

const END_STATUSES: Record<string, FeedTaskEndStatus> = {
  completed: 'completed', failed: 'failed', killed: 'killed', stopped: 'stopped',
};

function tag(text: string, name: string): string | null {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
}

/** Every `<task-notification>` in a string, as task-end events. */
export function parseNotifications(text: string, at: number): SessionFeedEvent[] {
  const out: SessionFeedEvent[] = [];
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1];
    const id = (tag(body, 'task-id') ?? '').trim();
    const status = END_STATUSES[(tag(body, 'status') ?? '').trim()];
    if (!TASK_ID.test(id) || !status) continue; // Monitor events have no status
    const summaryRaw = tag(body, 'summary') ?? '';
    const ev: SessionFeedEvent = { type: 'task-end', id, status, at };
    const code = summaryRaw.match(/exit code (-?\d{1,4})\b/);
    if (code) ev.exitCode = Number(code[1]);
    const summary = cleanText(summaryRaw, DESCRIPTION_MAX);
    if (summary) ev.summary = summary;
    out.push(ev);
  }
  return out;
}

// ------------------------------------------------------------ the parser

interface ToolUse { name: string; description: string; command: string }

export interface ParserOptions {
  /** The HOME whose ~/Downloads links are listed. */
  home: string;
  /** Clock for lines without a timestamp (tests pass a fixed one). */
  now?: () => number;
}

/** Remembers at most `max` keys, dropping the oldest. */
class BoundedSet {
  private items = new Set<string>();
  constructor(private max: number) {}
  has(k: string): boolean { return this.items.has(k); }
  add(k: string): void {
    this.items.add(k);
    if (this.items.size > this.max) {
      const first = this.items.values().next().value;
      if (first !== undefined) this.items.delete(first);
    }
  }
}

/**
 * Stateful only in what the lines themselves need: the partial last line, the
 * tool calls a later result refers to, and the ids already started or ended.
 * No I/O. One parser per attached transcript.
 */
export class TranscriptParser {
  private carry = '';
  private skipping = false;
  private toolUses = new Map<string, ToolUse>();
  private started = new BoundedSet(ID_MEMORY);
  private ended = new BoundedSet(ID_MEMORY);
  private readonly home: string;
  private readonly now: () => number;
  /** Lines that were not JSON (counted, never thrown). */
  badLines = 0;

  constructor(opts: ParserOptions) {
    this.home = opts.home;
    this.now = opts.now ?? Date.now;
  }

  /** Feed raw file text; events come only from whole lines. */
  push(chunk: string): SessionFeedEvent[] {
    const out: SessionFeedEvent[] = [];
    let text = chunk;
    if (this.skipping) {
      const nl = text.indexOf('\n');
      if (nl < 0) return out;
      text = text.slice(nl + 1);
      this.skipping = false;
    }
    text = this.carry + text;
    const lines = text.split('\n');
    this.carry = lines.pop() ?? '';
    if (this.carry.length > LINE_MAX) {
      this.carry = '';
      this.skipping = true;
    }
    for (const line of lines) {
      for (const ev of this.parseLine(line)) out.push(ev);
    }
    return out;
  }

  /** One whole line. Malformed lines give no events. */
  parseLine(raw: string): SessionFeedEvent[] {
    const line = raw.trim();
    if (!line || line.length > LINE_MAX) return [];
    // Bookkeeping lines start with "type"; of those only queue-operation matters.
    if (line.startsWith('{"type":"') && !line.startsWith('{"type":"queue-operation"')) return [];
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      this.badLines++;
      return [];
    }
    if (!isRecord(obj) || obj.isSidechain === true) return [];
    const at = timeOf(obj, this.now());
    switch (obj.type) {
      case 'assistant': return this.assistant(obj, at);
      case 'user': return this.user(obj, at);
      case 'queue-operation':
        return obj.operation === 'enqueue' && typeof obj.content === 'string' ? this.ends(obj.content, at) : [];
      case 'attachment': {
        const a = obj.attachment;
        return isRecord(a) && a.type === 'queued_command' && typeof a.prompt === 'string' ? this.ends(a.prompt, at) : [];
      }
      default: return [];
    }
  }

  private ends(text: string, at: number): SessionFeedEvent[] {
    if (!text.includes('<task-notification>')) return [];
    const out: SessionFeedEvent[] = [];
    for (const ev of parseNotifications(text, at)) {
      // Only what this transcript started: a subagent's background shells
      // send their notices to the parent session's queue too (939 of 2005
      // ends in 60 recent transcripts here), and are not the session's own.
      if (ev.type !== 'task-end' || !this.started.has(ev.id) || this.ended.has(ev.id)) continue;
      this.ended.add(ev.id);
      out.push(ev);
    }
    return out;
  }

  private assistant(obj: Record<string, unknown>, at: number): SessionFeedEvent[] {
    const msg = obj.message;
    if (!isRecord(msg) || !Array.isArray(msg.content)) return [];
    const out: SessionFeedEvent[] = [];
    for (const block of msg.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        for (const ev of extractLinks(block.text, this.home, at)) out.push(ev);
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const input = isRecord(block.input) ? block.input : {};
        this.rememberToolUse(block.id, {
          name: block.name,
          description: cleanText(input.description, DESCRIPTION_MAX),
          command: cleanText(input.command, DESCRIPTION_MAX),
        });
        if (block.name === 'ScheduleWakeup' && typeof input.delaySeconds === 'number'
            && Number.isFinite(input.delaySeconds) && input.delaySeconds >= 0) {
          const ev: SessionFeedEvent = { type: 'wake', fireAt: at + Math.round(input.delaySeconds * 1000), at };
          const prompt = cleanText(input.prompt, DESCRIPTION_MAX);
          if (prompt) ev.prompt = prompt;
          out.push(ev);
        }
      }
    }
    return dedupeLinks(out);
  }

  private rememberToolUse(id: string, use: ToolUse): void {
    this.toolUses.set(id, use);
    if (this.toolUses.size > TOOL_USE_MEMORY) {
      const first = this.toolUses.keys().next().value;
      if (first !== undefined) this.toolUses.delete(first);
    }
  }

  private user(obj: Record<string, unknown>, at: number): SessionFeedEvent[] {
    const msg = obj.message;
    if (!isRecord(msg)) return [];
    if (typeof msg.content === 'string') return this.ends(msg.content, at);
    if (!Array.isArray(msg.content)) return [];
    const out: SessionFeedEvent[] = [];
    const tur = isRecord(obj.toolUseResult) ? obj.toolUseResult : {};
    for (const block of msg.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        for (const ev of this.ends(block.text, at)) out.push(ev);
        continue;
      }
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const use = this.toolUses.get(block.tool_use_id);
      const start = this.backgroundStart(use, tur, resultText(block.content), at);
      if (start && !this.started.has(start.id)) {
        this.started.add(start.id);
        out.push(start);
      }
    }
    return out;
  }

  /** A tool result that names a background id: what started. */
  private backgroundStart(
    use: ToolUse | undefined,
    tur: Record<string, unknown>,
    text: string,
    at: number,
  ): Extract<SessionFeedEvent, { type: 'task-start' }> | null {
    let id = '';
    let kind: FeedTaskKind = 'other';
    let description = use?.description ?? '';
    const name = use?.name ?? '';
    let m: RegExpMatchArray | null;

    if (typeof tur.backgroundTaskId === 'string') {
      id = tur.backgroundTaskId; kind = 'shell';
    } else if ((m = text.match(/Command running in background with ID: ([A-Za-z0-9_-]+)/))
        || (m = text.match(/moved to the background \(ID: ([A-Za-z0-9_-]+)\)/))) {
      id = m[1]; kind = 'shell';
    } else if (tur.isAsync === true && typeof tur.agentId === 'string') {
      id = tur.agentId; kind = 'agent';
      if (!description) description = cleanText(tur.description, DESCRIPTION_MAX);
    } else if ((m = text.match(/^Async agent launched successfully\.\s*agentId: ([A-Za-z0-9_-]+)/))) {
      id = m[1]; kind = 'agent';
    } else if (name === 'Monitor' && typeof tur.taskId === 'string') {
      id = tur.taskId; kind = 'monitor';
    } else if ((m = text.match(/^Monitor started \(task ([A-Za-z0-9_-]+)/))) {
      id = m[1]; kind = 'monitor';
    } else if ((m = text.match(/^Workflow launched in background\.\s*Task ID: ([A-Za-z0-9_-]+)/))) {
      id = m[1]; kind = 'workflow';
    } else {
      return null;
    }
    if (!TASK_ID.test(id)) return null;
    const ev: Extract<SessionFeedEvent, { type: 'task-start' }> = { type: 'task-start', id, kind, description, at };
    if ((kind === 'shell' || kind === 'monitor') && use?.command) ev.command = use.command;
    return ev;
  }
}
