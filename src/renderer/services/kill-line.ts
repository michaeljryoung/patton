/**
 * Ctrl-U in the compose box (docs/compose-box.md, Design D16): delete the
 * whole line the caret is on, as zsh's Ctrl-U does; with a selection, every
 * line it touches. No DOM: EditorInput selects the range and deletes it
 * through the text field's own editing command, so ⌘Z brings it back.
 */

export interface KillRange {
  /** Delete value.slice(start, end); the caret lands on `start`. */
  start: number;
  end: number;
  /** How many lines go. */
  lines: number;
}

/** null when there is nothing to delete (an empty box). In a draft of several
 *  lines the line goes with its line break: the one after it, so the caret
 *  starts the line that takes its place; for the last line, the one before
 *  it, so the caret ends the line above. A selection that ends at the start of
 *  a line (just after a line break) does not touch that line. */
export function killLineRange(value: string, selStart: number, selEnd: number): KillRange | null {
  if (value === '') return null;
  const lo = Math.max(0, Math.min(selStart, selEnd, value.length));
  let hi = Math.min(Math.max(selStart, selEnd), value.length);
  const lineStart = value.lastIndexOf('\n', lo - 1) + 1;
  if (hi > lo && hi > lineStart && value[hi - 1] === '\n') hi -= 1;
  const nl = value.indexOf('\n', hi);
  const lineEnd = nl === -1 ? value.length : nl;
  let lines = 1;
  for (let i = lineStart; i < lineEnd; i++) if (value[i] === '\n') lines++;
  if (nl !== -1) return { start: lineStart, end: lineEnd + 1, lines };
  if (lineStart > 0) return { start: lineStart - 1, end: value.length, lines };
  return { start: 0, end: value.length, lines };
}
