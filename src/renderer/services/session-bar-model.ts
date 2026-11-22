/**
 * The session bar's state for one pane (docs/session-bar.md, D3–D6): what the
 * Claude session runs, what is scheduled, what failed and which links Claude
 * gave. Pure: no DOM, no IPC, no timers; every input carries its own `now`.
 *
 * Sources, merged here and nowhere else:
 *  - 7501 child records (agents, workflows, teammates, cloud sessions), live;
 *  - main's transcript feed (`SessionFeedEvent`, src/shared/session-feed.ts):
 *    task start and end, links, one-off wake-ups;
 *  - the Stop hook's lists (`taskList`, `cronList`), read through
 *    `stopListsOf` below, reconciling the running rows at every Stop.
 *
 * All text from those sources is untrusted: cleaned with `shownText` here and
 * only ever set as text by the bar.
 */
import type { FeedTaskEndStatus, FeedTaskKind, HookCron, HookTask, SessionFeedEvent } from '../../shared/session-feed';
import type { PattonState } from './patton-osc';
import type { ProgramRecord } from './program-status';
import { shownText } from './shown-text';
import { nextCronFire } from './cron-next';
import { checkpointTime } from './checkpoint-clock';

/** An ended row stays this long, struck through (D3). */
export const ENDED_LINGER_MS = 30_000;
/** Older than this: the accent colour (D3). */
export const LONG_RUNNING_MS = 60 * 60 * 1000;
export const MAX_FAILURES = 10;
export const MAX_LINKS = 8;
/** A scheduled prompt is cut to this many characters (D4). */
export const SCHEDULE_PROMPT_MAX = 60;
/** Rows a pane may hold, whatever its sources claim: a runaway list can't grow the bar without bound. */
const MAX_RUNS = 64;
const MAX_WAKES = 16;
const TEXT_MAX = 200;

export type RunKind = 'Agent' | 'Workflow' | 'Teammate' | 'Cloud' | 'Shell' | 'Monitor' | 'Task';
export type LinkKind = 'Page' | 'Doc' | 'Sheet' | 'Drive' | 'Release' | 'PR' | 'Link' | 'File';

export interface RunningRow {
  id: string;
  kind: RunKind;
  description: string;
  command: string | null;
  startedAt: number;
  ended: boolean;
  /** "done", "failed", "killed" or "stopped" once ended. */
  endLabel: string | null;
  /** "40 s", "6 min", "3 h 34". */
  age: string;
  /** Running for over an hour (D3: the accent colour). */
  long: boolean;
  /** Full text: description, a shell's command, when it started. */
  tooltip: string;
}

export interface ScheduledRow {
  key: string;
  kind: 'Loop' | 'Cron' | 'Wake';
  prompt: string;
  /** ms since epoch, null when the schedule didn't parse. */
  nextFire: number | null;
  /** HH:MM (local), or the schedule itself when it didn't parse. */
  when: string;
  tooltip: string;
}

export interface FailureRow {
  key: string;
  kind: string;
  text: string;
  at: number;
  when: string;
  tooltip: string;
}

export interface LinkRow {
  key: string;
  kind: LinkKind;
  label: string;
  url: string | null;
  path: string | null;
  at: number;
  when: string;
}

export interface BarView {
  running: RunningRow[];
  /** Running rows not yet ended (the strip's count). */
  liveCount: number;
  scheduled: ScheduledRow[];
  failures: FailureRow[];
  links: LinkRow[];
}

/** What the model just learnt that the log should say (D11). */
export type ModelNote =
  | { note: 'link'; kind: LinkKind }
  | { note: 'failure'; kind: string };

// ---------------------------------------------------------------- the Stop hook's lists

export interface StopLists {
  /** How many running tasks the hook counted (`tasks=`): more than `taskList` holds
   *  when the hook cut the list to fit Claude Code's 4096-byte limit. */
  tasks: number;
  /** Null when the hook sent no list (an older hook): nothing is reconciled. */
  taskList: HookTask[] | null;
  cronList: HookCron[] | null;
  transcriptPath: string | null;
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** The stop variant of a parsed OSC 777 message. */
export type StopState = Extract<PattonState, { kind: 'stop' }>;

/** The one place the bar reads the Stop hook's lists off a parsed Stop. The
 *  lists were checked entry by entry when parsed (services/hook-lists.ts), so
 *  they are taken as they are; a missing list stays null, never empty. */
export function stopListsOf(state: StopState): StopLists {
  return {
    tasks: state.tasks,
    taskList: state.taskList ?? null,
    cronList: state.cronList ?? null,
    transcriptPath: state.transcriptPath ?? null,
  };
}

// ---------------------------------------------------------------- text helpers

/** "40 s", "6 min", "3 h 34" (D3). */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** HH:MM today, "6 Nov 10:10" on another day. */
function clock(ms: number, now: number): string {
  return checkpointTime(Math.floor(ms / 1000), new Date(now));
}

function kindOfFeed(kind: FeedTaskKind): RunKind {
  switch (kind) {
    case 'shell': return 'Shell';
    case 'monitor': return 'Monitor';
    case 'agent': return 'Agent';
    case 'workflow': return 'Workflow';
    case 'teammate': return 'Teammate';
    case 'cloud': return 'Cloud';
    default: return 'Task';
  }
}

/** Claude Code's task type label, as the Stop hook lists it. */
export function kindOfHookType(type: string): RunKind {
  const t = type.toLowerCase();
  if (t === 'shell' || t === 'bash') return 'Shell';
  if (t === 'monitor') return 'Monitor';
  if (t === 'subagent' || t === 'agent') return 'Agent';
  if (t === 'workflow') return 'Workflow';
  if (t === 'teammate') return 'Teammate';
  if (t.startsWith('cloud')) return 'Cloud';
  return 'Task';
}

// ---------------------------------------------------------------- links (D6)

/** A URL's key: itself, trailing punctuation stripped. */
export function urlKey(url: string): string {
  return url.trim().replace(/[.,;:!?)\]}'"]+$/, '');
}

/** A file's key: its name, lower-cased, version marks removed (` v2`, `-v3`, `_v4`, ` (2)`), extension kept. */
export function fileKey(path: string): string {
  const name = path.split('/').pop() ?? path;
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  let stem = dot > 0 ? lower.slice(0, dot) : lower;
  const ext = dot > 0 ? lower.slice(dot) : '';
  for (;;) {
    const next = stem.replace(/(?:\s+v\d+|[-_]v\d+|\s*\(\d+\))$/, '');
    if (next === stem) break;
    stem = next;
  }
  return `file:${stem.trim()}${ext}`;
}

export function linkKindOfUrl(url: string): LinkKind {
  let u: URL;
  try { u = new URL(url); } catch { return 'Link'; }
  const host = u.hostname.toLowerCase();
  if (host === 'claude.ai' && u.pathname.includes('/artifact')) return 'Page';
  if (host === 'docs.google.com') {
    if (u.pathname.startsWith('/document')) return 'Doc';
    if (u.pathname.startsWith('/spreadsheets')) return 'Sheet';
    return 'Drive';
  }
  if (host === 'drive.google.com') return 'Drive';
  if (host === 'github.com') {
    if (/\/releases(\/|$)/.test(u.pathname)) return 'Release';
    if (/\/pull\/\d+/.test(u.pathname)) return 'PR';
  }
  return 'Link';
}

function defaultLinkLabel(kind: LinkKind, url: string | null, path: string | null): string {
  if (path) return path.split('/').pop() ?? path;
  if (url && kind === 'Page') {
    const id = url.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? '';
    return `Page ${id.slice(0, 8)}`;
  }
  return url ?? '';
}

// ---------------------------------------------------------------- the model

interface RunEntry {
  id: string;
  kind: RunKind;
  /** The kind came from the feed or the hook, not the 7501 default. */
  kindKnown: boolean;
  description: string;
  command: string | null;
  startedAt: number;
  endedAt: number | null;
  endLabel: string | null;
  /** Who ended it: a hook-ended row the hook lists again comes back. */
  endedBy: 'feed' | 'hook' | '7501' | null;
  /** Present in the pane's 7501 records right now. */
  in7501: boolean;
}

interface FailureEntry { key: string; kind: string; text: string; tooltip: string; at: number }
interface LinkEntry { key: string; kind: LinkKind; label: string; url: string | null; path: string | null; at: number; fallback: boolean }
interface WakeEntry { fireAt: number; prompt: string }

export class SessionBarModel {
  private runs = new Map<string, RunEntry>();
  private crons: HookCron[] = [];
  private wakes: WakeEntry[] = [];
  private failures: FailureEntry[] = [];
  private failedTaskIds = new Set<string>();
  private links: LinkEntry[] = [];
  private rootWasError = false;
  private sessionId: string | null = null;
  private failureSeq = 0;
  private listeners = new Set<() => void>();

  /** Called after anything the bar shows changed. Returns an unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private changed(): void {
    for (const cb of [...this.listeners]) cb();
  }

  /** The pane's 7501 records after every report or clear (null and [] once they are dropped). */
  applyProgramRecords(root: ProgramRecord | null, children: { id: string; record: ProgramRecord }[], now: number): ModelNote[] {
    const notes: ModelNote[] = [];
    let dirty = false;
    // D5: the root reporting `error` is a failure, once per spell in error.
    const isError = root?.state === 'error';
    if (isError && !this.rootWasError) {
      const msg = root?.msg ? shownText(root.msg, TEXT_MAX) : 'Claude reported an error';
      this.addFailure('Claude', msg, msg, now);
      notes.push({ note: 'failure', kind: 'Claude' });
      dirty = true;
    }
    this.rootWasError = isError;
    const present = new Set<string>();
    for (const { id, record } of children) {
      present.add(id);
      const title = record.title ? shownText(record.title, TEXT_MAX) : '';
      const run = this.runs.get(id);
      if (!run) {
        if (this.runs.size >= MAX_RUNS) this.dropOldestEnded();
        if (this.runs.size >= MAX_RUNS) continue;
        this.runs.set(id, {
          id, kind: 'Agent', kindKnown: false, description: title || id, command: null,
          startedAt: now, endedAt: null, endLabel: null, endedBy: null, in7501: true,
        });
        dirty = true;
        continue;
      }
      if (!run.in7501) { run.in7501 = true; dirty = true; }
      if (run.endedAt !== null && run.endedBy === 'hook') { this.revive(run); dirty = true; }
      if (title && !run.kindKnown && run.description !== title) { run.description = title; dirty = true; }
    }
    for (const run of this.runs.values()) {
      if (!run.in7501 || present.has(run.id)) continue;
      run.in7501 = false;
      // Claude Code clears a child's record when its task ends.
      if (run.endedAt === null) this.end(run, 'done', '7501', now);
      dirty = true;
    }
    if (dirty) this.changed();
    return notes;
  }

  /** One event from main's transcript feed. */
  applyFeed(event: SessionFeedEvent, now: number): ModelNote[] {
    const notes: ModelNote[] = [];
    switch (event.type) {
      case 'attached': {
        // A different session in the same pane (`/clear`, resume): its links
        // and wake-ups are the old conversation's. Running rows wait for the
        // next Stop's reconcile; failures stay until dismissed.
        const id = isStr(event.sessionId) ? event.sessionId : null;
        if (this.sessionId !== null && id !== null && id !== this.sessionId) {
          this.links = [];
          this.wakes = [];
          this.crons = [];
          this.changed();
        }
        if (id !== null) this.sessionId = id;
        return notes;
      }
      case 'detached':
      case 'error':
        return notes;
      case 'task-start': {
        if (!isStr(event.id) || event.id === '') return notes;
        const at = Number.isFinite(event.at) ? Math.min(event.at, now) : now;
        const description = shownText(isStr(event.description) ? event.description : '', TEXT_MAX);
        const command = isStr(event.command) && event.command ? shownText(event.command, TEXT_MAX) : null;
        const run = this.runs.get(event.id);
        if (run) {
          run.kind = kindOfFeed(event.kind);
          run.kindKnown = true;
          if (description) run.description = description;
          if (command) run.command = command;
          run.startedAt = Math.min(run.startedAt, at);
        } else {
          if (this.runs.size >= MAX_RUNS) this.dropOldestEnded();
          if (this.runs.size >= MAX_RUNS) return notes;
          this.runs.set(event.id, {
            id: event.id, kind: kindOfFeed(event.kind), kindKnown: true,
            description: description || command || event.id, command, startedAt: at,
            endedAt: null, endLabel: null, endedBy: null, in7501: false,
          });
        }
        this.changed();
        return notes;
      }
      case 'task-end': {
        if (!isStr(event.id) || event.id === '') return notes;
        const at = Number.isFinite(event.at) ? Math.min(event.at, now) : now;
        const run = this.runs.get(event.id);
        const status: FeedTaskEndStatus = event.status;
        if (run && run.endedAt === null) this.end(run, status === 'completed' ? 'done' : status, 'feed', at);
        if ((status === 'failed' || status === 'killed') && !this.failedTaskIds.has(event.id)) {
          this.failedTaskIds.add(event.id);
          const kind = run ? run.kind : 'Task';
          const what = run ? run.description : shownText(event.id, 40);
          const tail = typeof event.exitCode === 'number' && Number.isFinite(event.exitCode) ? `exit ${event.exitCode}` : status;
          const summary = isStr(event.summary) && event.summary ? shownText(event.summary, TEXT_MAX) : '';
          const text = `${what}: ${tail}`;
          this.addFailure(kind, text, summary ? `${text} · ${summary}` : text, at);
          notes.push({ note: 'failure', kind });
        }
        this.changed();
        return notes;
      }
      case 'link': {
        const note = this.addLink(event, now);
        if (note) {
          notes.push(note);
          this.changed();
        }
        return notes;
      }
      case 'wake': {
        if (!Number.isFinite(event.fireAt) || event.fireAt <= now) return notes;
        const prompt = isStr(event.prompt) ? shownText(event.prompt, TEXT_MAX) : '';
        if (this.wakes.some((w) => w.fireAt === event.fireAt && w.prompt === prompt)) return notes;
        this.wakes.push({ fireAt: event.fireAt, prompt });
        if (this.wakes.length > MAX_WAKES) this.wakes.shift();
        this.changed();
        return notes;
      }
      default:
        return notes;
    }
  }

  /** The Stop hook's lists at a Stop (D3, D4): an id missing from `taskList`
   *  ends (unless 7501 still reports it), an unknown listed id is added. A list
   *  shorter than the hook's count was cut to fit Claude Code's length limit, so
   *  an id missing from it may still run: nothing ends, listed ids still merge. */
  applyStop(lists: StopLists, now: number): void {
    let dirty = false;
    if (lists.taskList !== null) {
      const listed = new Map(lists.taskList.map((t) => [t.id, t]));
      const complete = lists.taskList.length >= lists.tasks;
      for (const run of this.runs.values()) {
        if (!complete || run.endedAt !== null || run.in7501 || listed.has(run.id)) continue;
        this.end(run, 'done', 'hook', now);
        dirty = true;
      }
      for (const t of listed.values()) {
        const run = this.runs.get(t.id);
        if (!run) {
          if (this.runs.size >= MAX_RUNS) this.dropOldestEnded();
          if (this.runs.size >= MAX_RUNS) continue;
          const d = shownText(t.d, TEXT_MAX);
          this.runs.set(t.id, {
            id: t.id, kind: kindOfHookType(t.type), kindKnown: true, description: d || shownText(t.id, 40), command: null,
            startedAt: now, endedAt: null, endLabel: null, endedBy: null, in7501: false,
          });
          dirty = true;
          continue;
        }
        if (!run.kindKnown) { run.kind = kindOfHookType(t.type); run.kindKnown = true; dirty = true; }
        if (run.endedAt !== null && run.endedBy === 'hook') { this.revive(run); dirty = true; }
      }
    }
    if (lists.cronList !== null) {
      this.crons = lists.cronList.map((c) => ({ id: c.id, s: c.s, r: c.r, p: c.p }));
      dirty = true;
    }
    if (dirty) this.changed();
  }

  dismissFailure(key: string): boolean {
    const before = this.failures.length;
    this.failures = this.failures.filter((f) => f.key !== key);
    if (this.failures.length === before) return false;
    this.changed();
    return true;
  }

  /** Claude left the pane: everything goes. */
  reset(): void {
    const had = this.runs.size + this.crons.length + this.wakes.length + this.failures.length + this.links.length > 0;
    this.runs.clear();
    this.crons = [];
    this.wakes = [];
    this.failures = [];
    this.failedTaskIds.clear();
    this.links = [];
    this.rootWasError = false;
    this.sessionId = null;
    if (had) this.changed();
  }

  /** What the bar shows at `now`. Drops ended rows past their linger and wake-ups past their time. */
  view(now: number): BarView {
    for (const run of [...this.runs.values()]) {
      if (run.endedAt !== null && now - run.endedAt >= ENDED_LINGER_MS) this.runs.delete(run.id);
    }
    this.wakes = this.wakes.filter((w) => w.fireAt > now);
    const running: RunningRow[] = [...this.runs.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((r) => {
        const ageMs = (r.endedAt ?? now) - r.startedAt;
        const tip = [r.description];
        if (r.command && r.command !== r.description) tip.push(r.command);
        tip.push(`${r.kind}, started ${clock(r.startedAt, now)}${r.endLabel ? `, ${r.endLabel}` : ''}`);
        return {
          id: r.id, kind: r.kind, description: r.description, command: r.command, startedAt: r.startedAt,
          ended: r.endedAt !== null, endLabel: r.endLabel, age: formatAge(ageMs),
          long: r.endedAt === null && ageMs >= LONG_RUNNING_MS, tooltip: tip.join('\n'),
        };
      });
    const scheduled = this.scheduledRows(now);
    const failures: FailureRow[] = [...this.failures].reverse().map((f) => ({
      key: f.key, kind: f.kind, text: f.text, at: f.at, when: clock(f.at, now), tooltip: f.tooltip,
    }));
    const links: LinkRow[] = this.links.map((l) => ({ key: l.key, kind: l.kind, label: l.label, url: l.url, path: l.path, at: l.at, when: clock(l.at, now) }));
    return { running, liveCount: running.filter((r) => !r.ended).length, scheduled, failures, links };
  }

  private scheduledRows(now: number): ScheduledRow[] {
    const rows: ScheduledRow[] = [];
    for (const c of this.crons) {
      const next = nextCronFire(c.s, now);
      const prompt = shownText(c.p, SCHEDULE_PROMPT_MAX);
      const schedule = shownText(c.s, 40);
      rows.push({
        key: `cron:${c.id}`, kind: c.r ? 'Loop' : 'Cron', prompt, nextFire: next,
        when: next === null ? schedule : clock(next, now),
        tooltip: `${shownText(c.p, TEXT_MAX)}\n${schedule}${next === null ? ' (not a schedule Patton can read)' : ''}`,
      });
    }
    for (const w of this.wakes) {
      const prompt = shownText(w.prompt, SCHEDULE_PROMPT_MAX);
      // D4: a wake-up the hook's cron list also carries is one row.
      const dup = rows.some((r) => r.kind === 'Cron' && (
        (r.nextFire !== null && Math.abs(r.nextFire - w.fireAt) < 60_000) || (prompt !== '' && r.prompt === prompt)));
      if (dup) continue;
      rows.push({
        key: `wake:${w.fireAt}`, kind: 'Wake', prompt: prompt || 'Wake-up', nextFire: w.fireAt,
        when: clock(w.fireAt, now), tooltip: w.prompt || 'Wake-up',
      });
    }
    return rows.sort((a, b) => (a.nextFire ?? Infinity) - (b.nextFire ?? Infinity));
  }

  private addLink(event: Extract<SessionFeedEvent, { type: 'link' }>, now: number): ModelNote | null {
    const at = Number.isFinite(event.at) ? Math.min(event.at, now) : now;
    let url: string | null = null;
    let path: string | null = null;
    let key: string;
    let kind: LinkKind;
    if (isStr(event.url) && event.url) {
      const clean = urlKey(event.url);
      if (!/^https:\/\//i.test(clean) || clean.length > 2048) return null;
      url = clean;
      key = `url:${clean}`;
      kind = linkKindOfUrl(clean);
    } else if (isStr(event.path) && event.path) {
      if (!(event.path.startsWith('/') || event.path.startsWith('~/')) || event.path.length > 1024) return null;
      path = event.path;
      key = fileKey(event.path);
      kind = 'File';
    } else {
      return null;
    }
    const existing = this.links.find((l) => l.key === key);
    // Shared again (a URL) or a newer version (a file): one row, at the top.
    if (existing && existing.at > at) return null;
    this.links = this.links.filter((l) => l.key !== key);
    let label = shownText(isStr(event.label) ? event.label : '', 120) || shownText(defaultLinkLabel(kind, url, path), 120);
    // Shared again with only a made-up label: keep the real one the row had (it still moves to the top).
    let fallback = event.fallback === true;
    if (fallback && existing && !existing.fallback) {
      label = existing.label;
      fallback = false;
    }
    this.links.unshift({ key, kind, label, url, path, at, fallback });
    this.links.sort((a, b) => b.at - a.at);
    if (this.links.length > MAX_LINKS) this.links.length = MAX_LINKS;
    return { note: 'link', kind };
  }

  private addFailure(kind: string, text: string, tooltip: string, at: number): void {
    this.failures.push({ key: `f${++this.failureSeq}`, kind, text, tooltip, at });
    while (this.failures.length > MAX_FAILURES) this.failures.shift();
  }

  private end(run: RunEntry, label: string, by: 'feed' | 'hook' | '7501', at: number): void {
    run.endedAt = at;
    run.endLabel = label;
    run.endedBy = by;
  }

  private revive(run: RunEntry): void {
    run.endedAt = null;
    run.endLabel = null;
    run.endedBy = null;
  }

  private dropOldestEnded(): void {
    let oldest: RunEntry | null = null;
    for (const r of this.runs.values()) if (r.endedAt !== null && (!oldest || r.endedAt < (oldest.endedAt ?? 0))) oldest = r;
    if (oldest) this.runs.delete(oldest.id);
  }
}
