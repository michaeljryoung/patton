/**
 * OSC 7501, the Program Status Protocol (revision 0.4, 2026-10-10): a program
 * tells its terminal what it is doing. Claude Code (2.1.295+) asks for it at
 * startup (`OSC 7501 ; ?`), and once a terminal answers it reports its own
 * state and stops putting ◐/◑/✳ in front of its title:
 *
 *   state=<s>:app=claude-code[:id=<task>][:kind=<k>][:progress=<n>][:title=<b64>][:msg=<b64>]
 *
 * The root record (no id) is the session: working (busy, or idle with queued
 * input), blocked (kind permission | question | auth, or none for an open
 * dialog; msg says what it waits on), done (the last turn completed), idle
 * (never ran, or interrupted), error. Each running background task is a child
 * record (`id=<task id>`, `title=<description>`, working or blocked), up to 32,
 * removed by `state=clear:id=<task id>`; a bare `state=clear` on exit removes
 * every record.
 *
 * This file is pure (no DOM, no IPC): parse one report, keep one pane's
 * records, and turn them into what the tab shows. Everything in a report is
 * untrusted: free text is base64 of UTF-8, refused whole if it holds a control
 * character, stripped of direction overrides and invisible formatting, and
 * only ever shown as text.
 */

export type ProgramState = 'idle' | 'working' | 'blocked' | 'done' | 'error';
export type BlockedKind = 'permission' | 'question' | 'auth';

/** One record as stored: a report replaces its record completely. */
export interface ProgramRecord {
  state: ProgramState;
  kind: BlockedKind | null;
  progress: number | null;
  app: string | null;
  title: string | null;
  msg: string | null;
}

export type ParsedSequence =
  | { type: 'query' }
  | { type: 'report'; id: string; record: ProgramRecord }
  | { type: 'clear'; id: string }
  | { type: 'invalid'; reason: string };

/** What Patton answers to `OSC 7501 ; ?`: the five states and three kinds of
 *  revision 0.4. Nothing in it comes from a report. */
export const PROGRAM_STATUS_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

// Limits from the spec's "Security and limits" table. A report over any of
// them is discarded whole.
const MAX_SEQUENCE_BYTES = 4096;
const MAX_KEY_BYTES = 16;
const MAX_MSG_ENCODED = 2732;
const MAX_MSG_DECODED = 2048;
const MAX_TITLE_ENCODED = 256;
const MAX_TITLE_DECODED = 192;
const MAX_APP_BYTES = 32;
const MAX_ID_BYTES = 128;
const MAX_ID_SEGMENT = 32;
const MAX_ID_DEPTH = 8;
/** Records per pane. The spec allows 64–256; Claude Code sends at most 33. */
export const MAX_RECORDS = 64;

const STATES: ReadonlySet<string> = new Set(['idle', 'working', 'blocked', 'done', 'error']);
const KINDS: ReadonlySet<string> = new Set(['permission', 'question', 'auth']);
const KEY_RE = /^[a-z]+$/;
const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/;
const APP_RE = /^[A-Za-z0-9_.+-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// Every control character (C0, DEL, C1): refused whole, per the spec.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
// Direction overrides and invisible formatting: removed before anything shows them.
const INVISIBLE_RE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

class ReportError extends Error {}

/** Decode base64 (padding optional) of UTF-8; throw on anything malformed. */
function decodeText(encoded: string, maxEncoded: number, maxDecoded: number, key: string): string {
  if (encoded.length > maxEncoded) throw new ReportError(`${key} over ${maxEncoded} bytes encoded`);
  if (!BASE64_RE.test(encoded) || encoded.length % 4 === 1) throw new ReportError(`${key} is not base64`);
  const padded = encoded.replace(/=+$/, '');
  const full = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(full);
  } catch {
    throw new ReportError(`${key} is not base64`);
  }
  if (binary.length > maxDecoded) throw new ReportError(`${key} over ${maxDecoded} bytes decoded`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReportError(`${key} is not UTF-8`);
  }
  if (CONTROL_RE.test(text)) throw new ReportError(`${key} holds a control character`);
  return text.replace(INVISIBLE_RE, '');
}

function checkId(id: string): void {
  if (id.length > MAX_ID_BYTES) throw new ReportError('id over 128 bytes');
  const segments = id.split('/');
  if (segments.length > MAX_ID_DEPTH) throw new ReportError('id over 8 segments');
  for (const s of segments) {
    if (s.length === 0) throw new ReportError('id has an empty segment');
    if (s.length > MAX_ID_SEGMENT) throw new ReportError('id segment over 32 bytes');
  }
}

/**
 * Parse the body of one OSC 7501 sequence (what follows `7501;`). A malformed
 * pair is skipped; a broken limit, bad base64, a control character in text or
 * a bad id discards the whole report (an id is checked strictly because a
 * skipped id would turn a child's report into the root's).
 */
export function parseProgramStatus(data: string): ParsedSequence {
  if (data.length > MAX_SEQUENCE_BYTES) return { type: 'invalid', reason: 'over 4096 bytes' };
  if (data.trim() === '?') return { type: 'query' };
  const pairs = new Map<string, string>();
  for (const raw of data.split(':')) {
    const eq = raw.indexOf('=');
    if (eq <= 0) continue; // malformed pair: skipped
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (key.length > MAX_KEY_BYTES) return { type: 'invalid', reason: 'key over 16 bytes' };
    if (!KEY_RE.test(key)) continue;
    if (!VALUE_RE.test(value)) {
      // A value outside the alphabet is a malformed pair, except an id: see above.
      if (key === 'id') return { type: 'invalid', reason: 'id has a byte the spec does not allow' };
      continue;
    }
    pairs.set(key, value); // the last one wins
  }
  try {
    const state = pairs.get('state');
    if (state === undefined) return { type: 'invalid', reason: 'no state' };
    const idValue = pairs.get('id');
    const id = idValue === undefined || idValue === '' ? '' : idValue;
    if (id) checkId(id);
    if (state === 'clear') return { type: 'clear', id };
    if (!STATES.has(state)) return { type: 'invalid', reason: 'unknown state' };

    const app = pairs.get('app');
    if (app !== undefined && app.length > MAX_APP_BYTES) throw new ReportError('app over 32 bytes');
    const title = pairs.get('title');
    const msg = pairs.get('msg');
    const record: ProgramRecord = {
      state: state as ProgramState,
      kind: null,
      progress: null,
      app: app !== undefined && APP_RE.test(app) ? app : null,
      title: title === undefined ? null : decodeText(title, MAX_TITLE_ENCODED, MAX_TITLE_DECODED, 'title'),
      msg: msg === undefined ? null : decodeText(msg, MAX_MSG_ENCODED, MAX_MSG_DECODED, 'msg'),
    };
    const kind = pairs.get('kind');
    if (state === 'blocked' && kind !== undefined && KINDS.has(kind)) record.kind = kind as BlockedKind;
    const progress = pairs.get('progress');
    if ((state === 'working' || state === 'blocked') && progress !== undefined && /^\d{1,3}$/.test(progress)) {
      const n = Number(progress);
      if (n <= 100) record.progress = n;
    }
    return { type: 'report', id, record };
  } catch (e) {
    if (e instanceof ReportError) return { type: 'invalid', reason: e.message };
    throw e;
  }
}

/** One pane's records: the root under '' and children by id, least recently
 *  updated first (so the oldest makes way past MAX_RECORDS). */
export class ProgramStatusRecords {
  private records = new Map<string, ProgramRecord>();

  get size(): number {
    return this.records.size;
  }

  get root(): ProgramRecord | null {
    return this.records.get('') ?? null;
  }

  /** Child records (every id but the root), in id order. */
  children(): { id: string; record: ProgramRecord }[] {
    const out: { id: string; record: ProgramRecord }[] = [];
    for (const [id, record] of this.records) if (id !== '') out.push({ id, record });
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  set(id: string, record: ProgramRecord): void {
    this.records.delete(id);
    this.records.set(id, record);
    while (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value as string;
      this.records.delete(oldest);
    }
  }

  /** Remove a record and everything beneath it; no id removes every record. */
  clear(id = ''): void {
    if (id === '') {
      this.records.clear();
      return;
    }
    for (const key of [...this.records.keys()]) {
      if (key === id || key.startsWith(`${id}/`)) this.records.delete(key);
    }
  }
}

/** What the pane's records mean for its tab, in the S40 vocabulary: busy,
 *  needs you (dot, with the reason as text), parked (hollow ring, with the
 *  running tasks' titles) or nothing. */
export type ProgramSignal =
  | { kind: 'none' }
  | { kind: 'working' }
  | { kind: 'needs-you'; reason: string }
  | { kind: 'parked'; tasks: number; titles: string[] };

const SHOWN_TEXT_MAX = 120;

/** Shorten untrusted text for a tooltip (it is already control- and override-free). */
export function shortText(text: string, max = SHOWN_TEXT_MAX): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Every control character, for text from anywhere (a pane title set over
// OSC 0/2 included), replaced rather than refused: what is left is shown.
// eslint-disable-next-line no-control-regex
const CONTROL_ALL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** Untrusted text from any program, made safe to show as text: control
 *  characters become spaces, direction overrides and invisible formatting go,
 *  runs of white space collapse, and it is cut to `max` characters. Still to
 *  be set with `textContent` only. */
export function shownText(text: string, max = SHOWN_TEXT_MAX): string {
  const clean = text.replace(CONTROL_ALL_RE, ' ').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ');
  return shortText(clean, max);
}

function withMsg(lead: string, msg: string | null): string {
  return msg ? `${lead}: ${shortText(msg)}` : lead;
}

function blockedReason(record: ProgramRecord): string {
  switch (record.kind) {
    case 'permission': return withMsg('Claude needs permission', record.msg);
    case 'question': return withMsg('Claude asks', record.msg);
    case 'auth': return withMsg('Claude needs a login', record.msg);
    default: return withMsg('Claude has a dialog open', record.msg);
  }
}

/**
 * Root working → busy. Root blocked or error → needs you. A blocked child
 * (a task waiting on input) → needs you. Root done or idle with children
 * working → parked; done with none → needs you; idle with none → nothing.
 * Where two readings compete, the one that alerts wins (S40: a missed alert
 * is the worse failure).
 */
export function programSignal(records: ProgramStatusRecords): ProgramSignal {
  const root = records.root;
  const rootState: ProgramState = root?.state ?? 'idle';
  if (rootState === 'working') return { kind: 'working' };
  if (rootState === 'blocked' && root) return { kind: 'needs-you', reason: blockedReason(root) };
  if (rootState === 'error') return { kind: 'needs-you', reason: withMsg('Claude stopped on an error', root?.msg ?? null) };

  const children = records.children();
  const blockedChild = children.find((c) => c.record.state === 'blocked');
  if (blockedChild) {
    return { kind: 'needs-you', reason: withMsg('A background task needs you', blockedChild.record.title) };
  }
  const working = children.filter((c) => c.record.state === 'working');
  if (working.length > 0) {
    const titles = working.map((c) => shortText(c.record.title ?? c.id, 60));
    return { kind: 'parked', tasks: working.length, titles };
  }
  if (rootState === 'done') return { kind: 'needs-you', reason: withMsg('Claude finished', root?.msg ?? null) };
  return { kind: 'none' };
}
