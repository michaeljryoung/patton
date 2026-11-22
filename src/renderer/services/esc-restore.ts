import { CLAUDE_BAR_GLYPH, readClaudeBar, type BarBuffer, type BarLine } from './claude-bar';

/**
 * Esc after a send (docs/compose-box.md D18). When he presses Esc (in the
 * empty compose box or in the terminal) during the turn his last send from
 * the box started, the Escape reaches Claude Code, which interrupts the
 * turn and, before any answer, puts the
 * message back into its own input bar. His next Enter in the box would then
 * send that message and the box's text as one. Patton instead takes the
 * message back into the box and empties Claude's bar.
 *
 * Probed in Claude Code v2.1.321 through a pty (100x30, hooks off,
 * 2026-11-22): the message is back in Claude's bar 60-80 ms after the Esc,
 * one line or several (a 3-line and a 30-line bracketed paste both come back
 * whole, never as a `[Pasted text]` placeholder); Ctrl+C with text in the bar
 * empties the whole input, every line, in one key, and does not arm Claude's
 * "Press Ctrl-C again to exit" (a second Ctrl+C on the empty bar does);
 * Ctrl+U deletes only the caret's line; a Backspace deletes one character,
 * a line break included.
 *
 * Pure: no DOM, no timers. Reads the same slice of xterm's buffer as the
 * bar reader (services/claude-bar.ts).
 */

/** An Esc arms the watch while the last send from the box started the turn
 *  that is still the current one (Claude's 7501 root went `working` or
 *  `blocked` after it and has not since reported `idle`, `done` or `error`),
 *  however long Claude thinks. Before Claude's first report of the turn, an
 *  Esc this soon after the send counts too: in main.log (20-22 Nov 2026)
 *  `working` came 64-763 ms after the send. */
export const ESC_RESTORE_UNSTARTED_MS = 2_000;

/** How long after the Esc the watch waits for Claude to put the message back
 *  and stop working. Probed restore: 60-80 ms; in main.log Claude's `idle`
 *  came up to 842 ms after the Esc. */
export const ESC_RESTORE_WATCH_MS = 3_000;

/** Ctrl+C: empties Claude Code's whole input while it holds text (probed). */
export const CLAUDE_CLEAR_INPUT = '\x03';

/** Backspace (DEL), as xterm sends it: one character, a line break included (probed). */
export const CLAUDE_BACKSPACE = '\x7f';

/** Rows scanned above and below the cursor for a bar of several lines. */
const MAX_INPUT_ROWS = 400;

const RULE = /^─+$/;
const IMAGE_PLACEHOLDER = /\[Image #\d+\]/g;
const PASTED_PLACEHOLDER = /\[Pasted text #\d+[^\]]*\]/;
const PASTED_PLACEHOLDERS = /\[Pasted text #\d+[^\]]*\]/g;
/** Claude Code's form: `+N lines` is the pasted text's line-break count
 *  (a 40-line paste shows `+39 lines`); none shown for a paste of one line. */
const PASTED_EXACT = /^\[Pasted text #\d+(?: \+(\d+) lines?)?\]$/;
const LINE_BREAK = /\r\n|\r|\n/g;

export type BarInputReading =
  | { kind: 'none' }
  | { kind: 'empty' }
  /** `rows`: the input's lines as drawn (the `❯ ` and the two-space indent
   *  removed, trailing blanks trimmed); a wrapped line and a line break look
   *  the same on screen. */
  | { kind: 'text'; rows: string[]; images: number; pasted: boolean };

function text(line: BarLine | undefined): string | null {
  return line === undefined ? null : line.translateToString(true);
}

function isRule(line: BarLine | undefined): boolean {
  const t = text(line);
  return t !== null && RULE.test(t);
}

/**
 * What Claude's bar holds, also when it spans several rows (the bar reader
 * proper finds only a one-row bar, D8). The cursor rests on one of the
 * input's rows: the input runs up to a row starting with `❯` with a rule
 * above it, and down to the next rule; every row in between is indented two
 * spaces.
 */
export function readClaudeBarInput(buffer: BarBuffer): BarInputReading {
  const one = readClaudeBar(buffer);
  if (one.found && one.empty) return { kind: 'empty' };
  const row = buffer.baseY + buffer.cursorY;
  let top = row;
  let bottom = row;
  if (!one.found) {
    // Up to the `❯` row.
    for (;;) {
      const t = text(buffer.getLine(top));
      if (t === null) return { kind: 'none' };
      if (t.startsWith(CLAUDE_BAR_GLYPH)) break;
      if (!t.startsWith('  ') || top <= 0 || row - top >= MAX_INPUT_ROWS) return { kind: 'none' };
      top--;
    }
    if (top < 1 || !isRule(buffer.getLine(top - 1))) return { kind: 'none' };
    // Down to the rule below.
    for (;;) {
      const next = buffer.getLine(bottom + 1);
      if (next === undefined) return { kind: 'none' };
      if (isRule(next)) break;
      if (!(text(next) ?? '').startsWith('  ') || bottom - row >= MAX_INPUT_ROWS) return { kind: 'none' };
      bottom++;
    }
  }
  const rows: string[] = [];
  for (let y = top; y <= bottom; y++) {
    rows.push((text(buffer.getLine(y)) ?? '').slice(2).trimEnd());
  }
  const joined = rows.join('\n');
  if (joined.trim() === '') return { kind: 'empty' };
  return {
    kind: 'text',
    rows,
    images: (joined.match(IMAGE_PLACEHOLDER) ?? []).length,
    pasted: PASTED_PLACEHOLDER.test(joined),
  };
}

export type EscRestorePlan =
  /** Take `text` into the box; send `keys` to Claude to empty its bar (or,
   *  with `keepImages`, to delete only the text, so the pasted images stay in
   *  Claude's message and their thumbnails come back to the box). */
  | { source: 'sent' | 'screen'; text: string; keys: string; keepImages: boolean }
  /** Leave Claude's bar as it is. */
  | { skip: 'not-readable' | 'images-and-paste' };

const squeeze = (s: string): string => s.replace(/\s+/g, '');

function graphemes(s: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length;
}

function lineBreaks(s: string): number {
  return (s.match(LINE_BREAK) ?? []).length;
}

/**
 * Whether a bar showing one `[Pasted text #N +M lines]` placeholder holds
 * `sent`: what it shows before the placeholder is the start of `sent`, what
 * it shows after it is the end, at least one character of `sent` is left
 * between them, and that part has M line breaks (give or take the line
 * breaks at its two edges, which a wrapped row hides). A placeholder with
 * nothing of `sent` behind it (a paste he made in Claude's own bar, his send
 * typed after it) never matches, so Ctrl+C can't wipe that paste.
 */
function pasteHoldsSent(sent: string, shown: string): boolean {
  const all = [...shown.matchAll(PASTED_PLACEHOLDERS)];
  if (all.length !== 1) return false;
  const exact = PASTED_EXACT.exec(all[0][0]);
  if (exact === null) return false;
  const claimed = exact[1] === undefined ? 0 : Number(exact[1]);
  const at = all[0].index ?? 0;
  const head = squeeze(shown.slice(0, at));
  const tail = squeeze(shown.slice(at + all[0][0].length));
  const whole = squeeze(sent);
  if (!whole.startsWith(head) || !whole.endsWith(tail) || head.length + tail.length >= whole.length) return false;
  // Where each non-blank character of `sent` sits, to find the hidden part.
  const at0: number[] = [];
  for (let i = 0; i < sent.length; i++) if (!/\s/.test(sent[i])) at0.push(i);
  const first = at0[head.length];
  const last = at0[whole.length - tail.length - 1];
  const fewest = lineBreaks(sent.slice(first, last + 1));
  const from = head.length === 0 ? 0 : at0[head.length - 1] + 1;
  const to = tail.length === 0 ? sent.length : at0[whole.length - tail.length];
  const most = lineBreaks(sent.slice(from, to));
  return claimed >= fewest && claimed <= most;
}

/**
 * Whether the bar holds the message Patton just sent (`sent`, as typed into
 * Claude), and what to do. Compared with all whitespace removed, since a
 * wrapped line and a line break look the same on screen; Claude's
 * `[Image #N]` placeholders are the pasted images, not text. A
 * `[Pasted text]` placeholder stands for text the screen doesn't show: the
 * bar matches only on the evidence `pasteHoldsSent` asks for. Otherwise the
 * bar must show exactly `sent`.
 *
 * A bar holding anything else is text Patton didn't send (he typed in
 * Claude's bar): taken in from the screen only when it reads whole, one row,
 * no placeholders; else left where it is. Every plan that sends Ctrl+C has
 * the bar's whole content in the box first.
 */
export function planEscRestore(sent: string, input: { rows: string[]; images: number; pasted: boolean }): EscRestorePlan {
  const shown = input.rows.join('\n').replace(IMAGE_PLACEHOLDER, '');
  let matches: boolean;
  if (input.pasted) {
    matches = pasteHoldsSent(sent, shown);
  } else {
    matches = squeeze(sent) !== '' && squeeze(shown) === squeeze(sent);
  }
  if (matches) {
    if (input.images > 0) {
      if (input.pasted) return { skip: 'images-and-paste' };
      // Claude puts the message back trimmed at both ends (probed in 2.1.321:
      // "  hello there  " came back as "hello there", a paste's trailing line
      // break dropped), so one Backspace more per leading blank would eat into
      // the `[Image #N]` before the text.
      return { source: 'sent', text: sent, keys: CLAUDE_BACKSPACE.repeat(graphemes(sent.trim())), keepImages: true };
    }
    return { source: 'sent', text: sent, keys: CLAUDE_CLEAR_INPUT, keepImages: false };
  }
  if (input.rows.length === 1 && !input.pasted && input.images === 0) {
    return { source: 'screen', text: input.rows[0], keys: CLAUDE_CLEAR_INPUT, keepImages: false };
  }
  return { skip: 'not-readable' };
}

/**
 * Whether a plan's bar provably holds the message Patton sent: the bar shows
 * exactly it, or one readable row that ends with it (his own text typed in
 * Claude's bar before the send, which Claude puts back with it). Used while
 * Claude Code keeps its 7501 root `working` for a subagent it launched: the
 * Esc that stops the send's turn then changes nothing in 7501 (probed in
 * 2.1.321), so only Claude's restore, the sent text back in its bar, shows
 * the turn has stopped. A bar holding anything else is left alone.
 */
export function planHoldsSent(plan: EscRestorePlan, sent: string): boolean {
  if ('skip' in plan) return false;
  if (plan.source === 'sent') return true;
  const whole = squeeze(sent);
  return whole !== '' && squeeze(plan.text).endsWith(whole);
}

/** Esc as the terminal sends it (plain, or CSI u when Claude asks for it). */
export function isEscKey(data: string): boolean {
  return data === '\x1b' || data === '\x1b[27u';
}

/**
 * Whether terminal input is a key he typed (text, Enter, Backspace, a control
 * or Alt key, an arrow or editing key, a paste), as opposed to xterm's own
 * replies to a program's queries, focus reports and mouse reports, which
 * change nothing in Claude's bar. A typed key during the watch is his own
 * edit of Claude's bar: the watch leaves the bar to him.
 */
export function isTypedInput(data: string): boolean {
  if (data === '' || isEscKey(data)) return false;
  if (data[0] !== '\x1b') return true;
  if (data.length === 2 && data[1] !== '[' && data[1] !== 'O') return true; // Alt+key
  if (data.startsWith('\x1b[200~')) return true; // a bracketed paste
  // eslint-disable-next-line no-control-regex -- the keys are escape sequences
  return /^\x1b\[[\d;]*[A-DHF~u]$/.test(data) || /^\x1bO[A-DHFPQRS]$/.test(data);
}

/** The keys as a log word, never the text: `ctrl-c` or `backspace×N`. */
export function describeClearKeys(keys: string): string {
  if (keys === CLAUDE_CLEAR_INPUT) return 'ctrl-c';
  return `backspace×${keys.length}`;
}
