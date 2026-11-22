import { CLAUDE_BAR_GLYPH, readClaudeBar, type BarBuffer, type BarLine } from './claude-bar';

/**
 * Esc after a send (docs/compose-box.md D18). When he presses Esc in the
 * empty compose box shortly after sending from it, Patton hands the Escape to
 * Claude Code, which interrupts the turn and, before any answer, puts the
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

/** An Esc this soon after a send from the box arms the watch. The five
 *  cases in main.log (20-22 Nov 2026) pressed Esc 0.97-2.1 s after the send. */
export const ESC_RESTORE_AFTER_SEND_MS = 10_000;

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

/**
 * Whether the bar holds the message Patton just sent (`sent`, as typed into
 * Claude), and what to do. Compared with all whitespace removed, since a
 * wrapped line and a line break look the same on screen; Claude's
 * `[Image #N]` placeholders are the pasted images, not text. A
 * `[Pasted text]` placeholder stands for text the screen doesn't show: the
 * bar matches when what it shows before it is the start of `sent`.
 * Otherwise the bar must show exactly `sent`.
 *
 * A bar holding anything else is text Patton didn't send (he typed in
 * Claude's bar): taken in from the screen only when it reads whole, one row,
 * no placeholders; else left where it is.
 */
export function planEscRestore(sent: string, input: { rows: string[]; images: number; pasted: boolean }): EscRestorePlan {
  const shown = input.rows.join('\n').replace(IMAGE_PLACEHOLDER, '');
  let matches: boolean;
  if (input.pasted) {
    const prefix = shown.slice(0, shown.search(PASTED_PLACEHOLDER));
    matches = squeeze(sent).startsWith(squeeze(prefix));
  } else {
    matches = squeeze(sent) !== '' && squeeze(shown) === squeeze(sent);
  }
  if (matches) {
    if (input.images > 0) {
      if (input.pasted) return { skip: 'images-and-paste' };
      return { source: 'sent', text: sent, keys: CLAUDE_BACKSPACE.repeat(graphemes(sent.trimEnd())), keepImages: true };
    }
    return { source: 'sent', text: sent, keys: CLAUDE_CLEAR_INPUT, keepImages: false };
  }
  if (input.rows.length === 1 && !input.pasted && input.images === 0) {
    return { source: 'screen', text: input.rows[0], keys: CLAUDE_CLEAR_INPUT, keepImages: false };
  }
  return { skip: 'not-readable' };
}

/** The keys as a log word, never the text: `ctrl-c` or `backspace×N`. */
export function describeClearKeys(keys: string): string {
  if (keys === CLAUDE_CLEAR_INPUT) return 'ctrl-c';
  return `backspace×${keys.length}`;
}
