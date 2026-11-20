/**
 * Claude Code's own input bar, found from the screen (docs/compose-box.md,
 * Design D8). After every redraw Claude Code (classic renderer) parks the
 * terminal's cursor on its input line, drawn as three rows:
 *
 *   ────────────────────   R−1, one or more `─` and nothing else
 *   ❯ <input>              R, the cursor's row
 *   ────────────────────   R+1
 *
 * The bar is *found* when that shape is at the cursor's row; a found bar is
 * *empty* when every cell after the `❯` and its space is blank, dim (SGR 2,
 * Claude's own hint such as "Press up to edit queued messages"), or the
 * inverse caret cell when that cell is blank or the text after it is dim.
 * Anything else (typed text, drawn in the default colour, a `/`, a pasted
 * path) means it *holds text*.
 *
 * Pure: no DOM, no timers. It reads the narrow slice of xterm's IBuffer
 * declared below, so a check can feed it a real @xterm/xterm buffer headlessly
 * or a hand-made one.
 */

/** The cell methods the reader uses (a subset of xterm's IBufferCell). */
export interface BarCell {
  getChars(): string;
  isDim(): number | boolean;
  isInverse(): number | boolean;
}

/** The line methods the reader uses (a subset of xterm's IBufferLine). */
export interface BarLine {
  readonly length: number;
  getCell(x: number): BarCell | undefined;
  translateToString(trimRight?: boolean): string;
}

/** The buffer fields the reader uses (a subset of xterm's IBuffer). */
export interface BarBuffer {
  readonly cursorY: number;
  readonly baseY: number;
  getLine(y: number): BarLine | undefined;
}

/** Why a reading found no bar, in the order the reader tests them. */
export type BarMissReason = 'no-glyph' | 'no-rule-above' | 'no-rule-below';

export type ClaudeBarReading =
  /** `row` is the bar's input line (R), absolute in the buffer (baseY + cursorY). */
  | { found: true; empty: boolean; row: number }
  | { found: false; why: BarMissReason; row: number };

/** Claude Code's prompt glyph, the first cell of its input line. */
export const CLAUDE_BAR_GLYPH = '❯';

/** First cell after the `❯` and its space. */
const INPUT_START_X = 2;

const RULE = /^─+$/;

function isRule(line: BarLine | undefined): boolean {
  return line !== undefined && RULE.test(line.translateToString(true));
}

function isBlank(cell: BarCell): boolean {
  return cell.getChars().trim() === '';
}

/** Whether the input line R (glyph already checked) holds nothing of his. */
function inputIsEmpty(line: BarLine): boolean {
  let caretSeen = false;
  // Non-blank cells after an inverse caret that sat on a non-blank cell must
  // all be dim, and at least one must exist (a caret alone on a letter is a
  // letter he typed).
  let caretOnText = false;
  let dimAfterCaret = false;
  for (let x = INPUT_START_X; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || isBlank(cell)) continue;
    if (cell.isDim()) {
      if (caretOnText) dimAfterCaret = true;
      continue;
    }
    if (cell.isInverse() && !caretSeen) {
      caretSeen = true;
      caretOnText = true;
      continue;
    }
    return false; // default-colour (or any non-dim) text: he typed something
  }
  return !caretOnText || dimAfterCaret;
}

/** Read the bar at the cursor of the given (active) buffer. */
export function readClaudeBar(buffer: BarBuffer): ClaudeBarReading {
  const row = buffer.baseY + buffer.cursorY;
  const line = buffer.getLine(row);
  if (!line || !line.translateToString(true).startsWith(CLAUDE_BAR_GLYPH)) {
    return { found: false, why: 'no-glyph', row };
  }
  if (row < 1 || !isRule(buffer.getLine(row - 1))) return { found: false, why: 'no-rule-above', row };
  if (!isRule(buffer.getLine(row + 1))) return { found: false, why: 'no-rule-below', row };
  return { found: true, empty: inputIsEmpty(line), row };
}

/** The reading as one word: 'empty', 'holds-text' or 'none' (the fixture's verdicts). */
export function claudeBarVerdict(r: ClaudeBarReading): 'empty' | 'holds-text' | 'none' {
  if (!r.found) return 'none';
  return r.empty ? 'empty' : 'holds-text';
}
