/**
 * The Stop hook's lists (docs/session-bar.md D10), parsed. Pure: no DOM, no IPC.
 *
 * The hook (resources/claude-code-stop-hook.sh) adds three fields to its
 * `patton;stop` OSC 777 message:
 *   tl=<base64 of a JSON array of HookTask>   running, non-ambient tasks
 *   cl=<base64 of a JSON array of HookCron>   session_crons
 *   tp=<base64 of the transcript path>
 * Everything in them came from Claude Code's hook input and any program that
 * writes to the pane can forge them, so each is untrusted: strict base64
 * (padded), UTF-8 that must decode cleanly, JSON that must have the shape, no
 * control character in any string (the entry is refused, as program-status.ts
 * refuses a report), direction overrides and invisible formatting stripped
 * from free text, and a cap on every length and count. Whatever is malformed
 * is dropped, never thrown: a bad field costs only itself, a bad entry only
 * itself.
 */
import type { HookCron, HookTask } from '../../shared/session-feed';
import { INVISIBLE_RE, shownText } from './shown-text';

/** The most entries read from one list; the hook's byte cap keeps real ones far below. */
export const MAX_HOOK_TASKS = 64;
export const MAX_HOOK_CRONS = 32;
/** Characters of a description or prompt (the hook cuts at 80 too). */
export const HOOK_TEXT_MAX = 80;
const MAX_ID = 128;
const MAX_TYPE = 32;
const MAX_SCHEDULE = 100;
/** Encoded and decoded bytes of a list, and of the transcript path. */
const MAX_LIST_ENCODED = 4096;
const MAX_PATH_ENCODED = 1400;
const MAX_PATH = 1024;

const BASE64_PADDED_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Every control character (C0, DEL, C1).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
// shown-text's INVISIBLE_RE is global (stateful with .test), so keep a plain copy.
const INVISIBLE_ANY_RE = new RegExp(INVISIBLE_RE.source, 'u');

/** Decode padded base64 of UTF-8, or null for anything else (bad alphabet,
 *  bad padding, invalid UTF-8, too long). */
function decodeBase64Text(encoded: string, maxEncoded: number): string | null {
  if (encoded.length === 0 || encoded.length > maxEncoded || !BASE64_PADDED_RE.test(encoded)) return null;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeJsonArray(encoded: string): unknown[] | null {
  const text = decodeBase64Text(encoded, MAX_LIST_ENCODED);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A string field that must be shown or compared: non-empty (unless allowed
 *  empty), within `max` characters, no control character, no invisible formatting. */
function plainString(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0) return allowEmpty ? '' : null;
  if (Array.from(value).length > max || CONTROL_RE.test(value) || INVISIBLE_ANY_RE.test(value)) return null;
  return value;
}

/** Free text: no control character (entry refused), then cleaned for showing. */
function freeText(value: unknown): string | null {
  if (typeof value !== 'string' || CONTROL_RE.test(value) || Array.from(value).length > HOOK_TEXT_MAX) return null;
  return shownText(value, HOOK_TEXT_MAX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a `tl` field's value: the valid entries, or null when the field as a whole is unreadable. */
export function parseTaskList(encoded: string): HookTask[] | null {
  const raw = decodeJsonArray(encoded);
  if (raw === null) return null;
  const tasks: HookTask[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_HOOK_TASKS)) {
    if (!isRecord(item)) continue;
    const id = plainString(item.id, MAX_ID);
    const type = plainString(item.type, MAX_TYPE);
    const d = freeText(item.d);
    if (id === null || type === null || d === null || seen.has(id)) continue;
    seen.add(id);
    tasks.push({ id, type, d });
  }
  return tasks;
}

/** Parse a `cl` field's value: the valid entries, or null when the field as a whole is unreadable. */
export function parseCronList(encoded: string): HookCron[] | null {
  const raw = decodeJsonArray(encoded);
  if (raw === null) return null;
  const crons: HookCron[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_HOOK_CRONS)) {
    if (!isRecord(item)) continue;
    const id = plainString(item.id, MAX_ID);
    const s = plainString(item.s, MAX_SCHEDULE);
    const p = freeText(item.p);
    if (id === null || s === null || p === null || typeof item.r !== 'boolean' || seen.has(id)) continue;
    seen.add(id);
    crons.push({ id, s, r: item.r, p });
  }
  return crons;
}

/** Parse a `tp` field's value: an absolute path with nothing odd in it, or null. */
export function parseTranscriptPath(encoded: string): string | null {
  const text = decodeBase64Text(encoded, MAX_PATH_ENCODED);
  if (text === null || text.length > MAX_PATH || !text.startsWith('/')) return null;
  if (CONTROL_RE.test(text) || INVISIBLE_ANY_RE.test(text)) return null;
  return text;
}

export interface HookLists {
  taskList?: HookTask[];
  cronList?: HookCron[];
  transcriptPath?: string;
}

/** Read the `tl`, `cl` and `tp` fields out of a stop message's `;key=value` tail. A field
 *  that is absent or unreadable is left out; the first of a repeated key counts. */
export function hookListsFrom(tail: string | undefined): HookLists {
  const out: HookLists = {};
  for (const field of (tail ?? '').split(';')) {
    const m = /^(tl|cl|tp)=([A-Za-z0-9+/=]*)$/.exec(field);
    if (!m) continue;
    if (m[1] === 'tl' && out.taskList === undefined) {
      const list = parseTaskList(m[2]);
      if (list) out.taskList = list;
    } else if (m[1] === 'cl' && out.cronList === undefined) {
      const list = parseCronList(m[2]);
      if (list) out.cronList = list;
    } else if (m[1] === 'tp' && out.transcriptPath === undefined) {
      const path = parseTranscriptPath(m[2]);
      if (path !== null) out.transcriptPath = path;
    }
  }
  return out;
}
