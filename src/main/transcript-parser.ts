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
 * - Page publish: Artifact `input {file_path, description, title?, url?}`;
 *   result text "Published <absolute path> at https://claude.ai/code/artifact/<id>
 *   (Version N, version id <unix seconds>-<hex>)". The same result line can be
 *   written twice. Only an Artifact call's own result counts. Handed to
 *   `onPublish` (page titles, main/page-titles.ts), never sent to the bar.
 */
import { ARTIFACT_ID, ARTIFACT_URL } from '../shared/artifact-id';
import type { FeedTaskEndStatus, FeedTaskKind, SessionFeedEvent } from '../shared/session-feed';

export const DESCRIPTION_MAX = 200;
export const LABEL_MAX = 120;
const URL_MAX = 2048;
const PATH_MAX = 1024;
/** A line longer than this is dropped whole (they are api blobs, not events). */
export const LINE_MAX = 16 * 1024 * 1024;
/** Tool calls remembered so a later result can name its description. */
const TOOL_USE_MEMORY = 2000;
/** A ScheduleWakeup further off than this is dropped (J: 7 days). */
export const WAKE_MAX_SECONDS = 7 * 24 * 3600;
/** Task ids remembered for start / end dedupe. */
const ID_MEMORY = 5000;

const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;

// C0 and C1 controls, DEL, and the bidi marks, embeddings, overrides and
// isolates (LRM, RLM, ALM, U+202A-202E, U+2066-2069), which can make shown
// text read differently from what it is: shown as a space.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Invisible characters inside a word (soft hyphen, Mongolian vowel separator,
// zero-width space, word joiner and the invisible operators, BOM), which can
// make two different names look the same: removed. U+200C/U+200D (ZWNJ/ZWJ)
// stay: some scripts and emoji need them.
const FORMAT_CHARS = /[\u00ad\u180e\u200b\u2060-\u2064\ufeff]/g;
// Either kind: a path holding one is refused.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Strip control characters, collapse whitespace, cap the length. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(FORMAT_CHARS, '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
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

/** The start of a tool result's text: launch sentences open the result, so
 *  the first 1 KB is all that is matched (a Read result can be megabytes). */
const RESULT_HEAD = 1024;
function resultText(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, RESULT_HEAD);
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (out.length >= RESULT_HEAD) break;
    if (isRecord(part) && typeof part.text === 'string') out += part.text.slice(0, RESULT_HEAD) + '\n';
  }
  return out.slice(0, RESULT_HEAD);
}

// ---------------------------------------------------------------- links (D6)

const URL_PATTERNS: Array<{ re: RegExp; id: (m: RegExpMatchArray) => string }> = [
  // claude.ai artifacts: /code/artifact/<id>, /artifact/<id>, /public/artifacts/<id>
  { re: ARTIFACT_URL, id: (m) => m[1] },
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

/** Text scanned per block: a link or notice past this is not looked for (A). */
export const SCAN_MAX = 64 * 1024;
/** Link events one transcript line may give, after dedupe (A). */
export const LINKS_PER_LINE = 20;
/** Raw link matches collected per block before dedupe. */
const LINKS_PER_BLOCK = 200;
/** A markdown link's target is at most a URL's length, and its label 300. */
const MD_TARGET_MAX = URL_MAX + 2;
const MD_LABEL_MAX = 300;
const FILE_EXT_AT = /\.(?:docx|pdf|xlsx|pptx|csv|html|png)(?![A-Za-z0-9])/gi;
/** Characters a bare ~/Downloads path never holds. */
const PATH_STOP = new Set(['`', '"', "'", '<', '>', '|', '*', '?', '\n']);

/** For each index, the first index at or after it holding one of `stops`
 *  (text.length when none): one backward pass, so every lookup is O(1). */
function nextIndexOf(text: string, stops: (c: string) => boolean): Int32Array {
  const out = new Int32Array(text.length + 1);
  out[text.length] = text.length;
  for (let i = text.length - 1; i >= 0; i--) out[i] = stops(text[i]) ? i : out[i + 1];
  return out;
}

/** Markdown links `[label](target)` in order, found by one linear scan (the
 *  regex this replaces went quadratic on `[a](x` and a long run of spaces). */
function markdownLinks(text: string): Array<{ start: number; end: number; label: string; target: string }> {
  const out: Array<{ start: number; end: number; label: string; target: string }> = [];
  const closeParen = nextIndexOf(text, (c) => c === ')' || c === '\n');
  const closeAngle = nextIndexOf(text, (c) => c === '>' || c === '\n');
  let from = 0;
  while (out.length < LINKS_PER_BLOCK) {
    const mid = text.indexOf('](', from);
    if (mid < 0) break;
    from = mid + 2;
    // The label: back to the earliest `[` with no `]` or newline between.
    let open = -1;
    for (let j = mid - 1; j >= 0 && mid - j <= MD_LABEL_MAX + 1; j--) {
      const c = text[j];
      if (c === ']' || c === '\n') break;
      if (c === '[') open = j;
    }
    if (open < 0 || open + 1 === mid) continue;
    let t = mid + 2;
    while (t < text.length && (text[t] === ' ' || text[t] === '\t')) t++;
    let target: string;
    let end: number;
    if (text[t] === '<') {
      const gt = closeAngle[t];
      if (gt >= text.length || text[gt] !== '>' || gt - t > MD_TARGET_MAX || gt === t + 1) continue;
      let k = gt + 1;
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
      if (text[k] !== ')') continue;
      target = text.slice(t, gt + 1);
      end = k + 1;
    } else {
      const close = closeParen[t];
      if (close >= text.length || text[close] !== ')' || close === t || close - t > MD_TARGET_MAX) continue;
      target = text.slice(t, close).trim();
      if (!target) continue;
      end = close + 1;
    }
    out.push({ start: open, end, label: text.slice(open + 1, mid), target });
    from = end;
  }
  return out;
}

/** Bare paths under ~/Downloads (names may hold spaces, not after a slash),
 *  by one linear scan: each candidate runs from `~/Downloads/` (or
 *  `<home>/Downloads/`) to the first `.docx`-style extension before a stop
 *  character, within PATH_MAX. */
function downloadsPaths(text: string, home: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const homeDir = home.replace(/\/+$/, '');
  const stop = nextIndexOf(text, (c) => PATH_STOP.has(c));
  const ext = new RegExp(FILE_EXT_AT.source, 'gi');
  let extAt = -1;
  let extEnd = -1;
  let from = 0;
  while (out.length < LINKS_PER_BLOCK) {
    const d = text.indexOf('/Downloads/', from);
    if (d < 0) break;
    from = d + 1;
    let start = -1;
    if (d >= 1 && text[d - 1] === '~') start = d - 1;
    else if (homeDir && d >= homeDir.length && text.startsWith(homeDir, d - homeDir.length)) start = d - homeDir.length;
    if (start < 0) continue;
    const bodyAt = d + '/Downloads/'.length;
    // The next extension at or after the body (the cursor only moves forward).
    if (extAt < bodyAt) {
      ext.lastIndex = bodyAt;
      const m = ext.exec(text);
      if (!m) break; // no extension anywhere later: no more paths
      extAt = m.index;
      extEnd = m.index + m[0].length;
    }
    if (extAt === bodyAt || extEnd - start > PATH_MAX || stop[bodyAt] < extEnd) continue;
    const rest = text.slice(bodyAt, extEnd);
    // Every segment starts with neither whitespace nor a slash, and the
    // file name has a character before its extension.
    if (/^[\s/]|\/[\s/]/.test(rest) || text[extAt - 1] === '/') continue;
    out.push({ start, end: extEnd });
    from = extEnd;
  }
  return out;
}

/** Links in one piece of Claude's text, in the order they appear. Only the
 *  first SCAN_MAX characters are read, and at most LINKS_PER_BLOCK kept. */
export function extractLinks(fullText: string, home: string, at: number): SessionFeedEvent[] {
  const text = fullText.length > SCAN_MAX ? fullText.slice(0, SCAN_MAX) : fullText;
  const found: Array<{ pos: number; ev: SessionFeedEvent }> = [];
  // Taken spans in order of start; md spans are found in order and don't overlap.
  const taken: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) => {
    for (const [s, e] of taken) if (a < e && b > s) return true;
    return false;
  };

  // Markdown links first: [label](target), the label kept.
  for (const m of markdownLinks(text)) {
    const target = m.target.replace(/^<|>$/g, '');
    const label = cleanText(m.label.replace(/[`*_]/g, ''), LABEL_MAX);
    const u = urlLink(target);
    if (u) {
      found.push({ pos: m.start, ev: { type: 'link', url: u.url, label: label || pageLabel(u.id), at, ...(label ? {} : { fallback: true as const }) } });
      taken.push([m.start, m.end]);
      continue;
    }
    const f = fileLink(target, home);
    if (f) {
      found.push({ pos: m.start, ev: { type: 'link', path: f, label: label || cleanText(baseName(f), LABEL_MAX), at, ...(label ? {} : { fallback: true as const }) } });
      taken.push([m.start, m.end]);
    }
  }

  // Bare URLs.
  for (const m of text.matchAll(/https:\/\/[^\s<>"'`()[\]{}|\\^]+/g)) {
    if (found.length >= LINKS_PER_BLOCK * 2) break;
    const start = m.index ?? 0;
    if (overlaps(start, start + m[0].length)) continue;
    const u = urlLink(m[0]);
    if (u) found.push({ pos: start, ev: { type: 'link', url: u.url, label: pageLabel(u.id), at, fallback: true } });
  }

  // Bare paths under ~/Downloads.
  for (const m of downloadsPaths(text, home)) {
    if (overlaps(m.start, m.end)) continue;
    const f = fileLink(text.slice(m.start, m.end), home);
    if (f) found.push({ pos: m.start, ev: { type: 'link', path: f, label: cleanText(baseName(f), LABEL_MAX), at, fallback: true } });
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

/** At most LINKS_PER_LINE link events from one line; other events all kept. */
function capLinks(events: SessionFeedEvent[]): SessionFeedEvent[] {
  let links = 0;
  return events.filter((ev) => ev.type !== 'link' || ++links <= LINKS_PER_LINE);
}

// ------------------------------------------------------------ notices (D9)

const END_STATUSES: Record<string, FeedTaskEndStatus> = {
  completed: 'completed', failed: 'failed', killed: 'killed', stopped: 'stopped',
};

/** The first `<name>…</name>` in a string: indexOf, so linear (a lazy regex
 *  over many unclosed opens was quadratic). */
function tag(text: string, name: string): string | null {
  const open = `<${name}>`;
  const i = text.indexOf(open);
  if (i < 0) return null;
  const j = text.indexOf(`</${name}>`, i + open.length);
  return j < 0 ? null : text.slice(i + open.length, j);
}

/** Notices read per string: a real one is a few hundred bytes. */
const NOTICES_MAX = 50;

/** Every `<task-notification>` in a string, as task-end events. Linear: the
 *  first SCAN_MAX characters, at most NOTICES_MAX notices. */
export function parseNotifications(fullText: string, at: number): SessionFeedEvent[] {
  const text = fullText.length > SCAN_MAX ? fullText.slice(0, SCAN_MAX) : fullText;
  const out: SessionFeedEvent[] = [];
  const OPEN = '<task-notification>';
  const CLOSE = '</task-notification>';
  let from = 0;
  for (let n = 0; n < NOTICES_MAX; n++) {
    const i = text.indexOf(OPEN, from);
    if (i < 0) break;
    const j = text.indexOf(CLOSE, i + OPEN.length);
    if (j < 0) break; // no close after this open: none after any later open either
    from = j + CLOSE.length;
    const body = text.slice(i + OPEN.length, j);
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

interface ToolUse { name: string; description: string; command: string; background: boolean; filePath: string; title: string }

/** A page Claude published: where its file is, and the title Claude gave it. */
export interface PagePublish {
  id: string;
  /** The published file (the result's path, else the call's `file_path`); untrusted. */
  path: string | null;
  /** The Artifact call's `input.title`, cleaned; '' when none. */
  inputTitle: string;
  at: number;
}

const PUBLISHED = /^\s*Published (\/[^\n]*?) at (https:\/\/claude\.ai\/[^\s)]+)/;

/** A path from transcript text that may be handed to the title reader. */
export function publishPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > PATH_MAX) return null;
  return p === p.replace(CONTROL, '') ? p : null;
}

/** Tools whose results quote files, pages or command output: a launch
 *  sentence in their text is quoted, never a launch (B). */
const QUOTING_TOOLS = new Set(['Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Edit', 'Write', 'NotebookEdit']);

export interface ParserOptions {
  /** The HOME whose ~/Downloads links are listed. */
  home: string;
  /** Clock for lines without a timestamp (tests pass a fixed one). */
  now?: () => number;
  /** Told of each page publish (once per tool call). */
  onPublish?: (p: PagePublish) => void;
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
  private published = new BoundedSet(ID_MEMORY);
  private readonly onPublish: ((p: PagePublish) => void) | undefined;
  private readonly home: string;
  private readonly now: () => number;
  /** Lines that were not JSON (counted, never thrown). */
  badLines = 0;

  constructor(opts: ParserOptions) {
    this.home = opts.home;
    this.now = opts.now ?? Date.now;
    this.onPublish = opts.onPublish;
  }

  /** The next text starts a fresh line (the tail re-attached): drop the
   *  partial line held, keep the ids already started and ended. */
  resetLine(): void {
    this.carry = '';
    this.skipping = false;
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
          background: input.run_in_background === true,
          filePath: block.name === 'Artifact' && typeof input.file_path === 'string' ? input.file_path.slice(0, PATH_MAX + 1) : '',
          title: block.name === 'Artifact' ? cleanText(input.title, DESCRIPTION_MAX) : '',
        });
        if (block.name === 'ScheduleWakeup' && typeof input.delaySeconds === 'number'
            && Number.isFinite(input.delaySeconds) && input.delaySeconds >= 0
            && input.delaySeconds <= WAKE_MAX_SECONDS) {
          const ev: SessionFeedEvent = { type: 'wake', fireAt: at + Math.round(input.delaySeconds * 1000), at };
          const prompt = cleanText(input.prompt, DESCRIPTION_MAX);
          if (prompt) ev.prompt = prompt;
          out.push(ev);
        }
      }
    }
    return capLinks(dedupeLinks(out));
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
      const text = resultText(block.content);
      const start = this.backgroundStart(use, tur, text, at);
      if (start && !this.started.has(start.id)) {
        this.started.add(start.id);
        out.push(start);
      }
      if (this.onPublish && !this.published.has(block.tool_use_id)) {
        const pub = publishOf(use, text, at);
        if (pub) {
          this.published.add(block.tool_use_id);
          this.onPublish(pub);
        }
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
    } else if (name === 'Bash' && use?.background
        && (m = text.match(/^\s*Command running in background with ID: ([A-Za-z0-9_-]+)/))) {
      // Text only from a Bash call that asked for the background, at the
      // start of its result: a Read or a foreground grep may quote it (B).
      id = m[1]; kind = 'shell';
    } else if (name === 'Bash'
        && (m = text.match(/^\s*Command did not complete within its \d+s timeout and was moved to the background \(ID: ([A-Za-z0-9_-]+)\)/))) {
      id = m[1]; kind = 'shell';
    } else if (tur.isAsync === true && typeof tur.agentId === 'string') {
      id = tur.agentId; kind = 'agent';
      if (!description) description = cleanText(tur.description, DESCRIPTION_MAX);
    } else if ((name === 'Agent' || name === 'Task')
        && (m = text.match(/^Async agent launched successfully\.\s*agentId: ([A-Za-z0-9_-]+)/))) {
      id = m[1]; kind = 'agent';
    } else if (name === 'Monitor' && typeof tur.taskId === 'string') {
      id = tur.taskId; kind = 'monitor';
    } else if (name === 'Monitor' && (m = text.match(/^Monitor started \(task ([A-Za-z0-9_-]+)/))) {
      id = m[1]; kind = 'monitor';
    } else if (name !== '' && !QUOTING_TOOLS.has(name)
        && (m = text.match(/^Workflow launched in background\.\s*Task ID: ([A-Za-z0-9_-]+)/))) {
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

/** A tool result that says a page was published, at the start of its text.
 *  Only the result of a call named exactly `Artifact` counts (an allow-list):
 *  a quoting tool, an MCP tool, an agent or a result whose call was never seen
 *  (the tail starting mid-file) could carry any text, so never one. */
function publishOf(use: ToolUse | undefined, text: string, at: number): PagePublish | null {
  if (use?.name !== 'Artifact') return null;
  const m = text.match(PUBLISHED);
  if (!m) return null;
  const id = m[2].match(ARTIFACT_URL)?.[1] ?? '';
  if (!ARTIFACT_ID.test(id)) return null;
  const path = publishPath(m[1]) ?? publishPath(use.filePath);
  return { id, path, inputTitle: use.title, at };
}
