/**
 * Whether a terminal selection lies inside Claude's reply lines on a Claude
 * Code screen, so copying it may put Claude's original text on the clipboard
 * (main/copy-original.ts). Pure: rows come in through `rowAt`.
 *
 * Claude Code draws each item from column 0: `⏺` starts a reply (or a tool
 * call's header), `⎿` (indented) starts a tool's output, and anything else at
 * column 0 (`>` or `❯` for his prompt, `─` for the input bar's rules, `✻` for
 * the status line) is not Claude's reply. Rows under an item are indented, so
 * a row belongs to the nearest item start above it. A selection is a reply's
 * only if every item it touches is a reply and the item its first row sits in
 * is one too; anything not found within `MAX_WALK_ROWS` counts as not.
 */

export interface ScreenRow {
  text: string;
  /** A soft wrap of the row above (xterm's `isWrapped`): never an item start. */
  wrapped: boolean;
}

const MAX_WALK_ROWS = 20_000;
const REPLY_START = /^[⏺●]/u;
const TOOL_OUTPUT = /^\s*⎿/u;

export type RowKind = 'reply-start' | 'other-start' | 'tool-output' | 'body';

export function rowKind(row: ScreenRow): RowKind {
  if (row.wrapped || row.text.trim() === '') return 'body';
  if (TOOL_OUTPUT.test(row.text)) return 'tool-output';
  if (REPLY_START.test(row.text)) return 'reply-start';
  if (!/\s/.test(row.text[0])) return 'other-start';
  return 'body';
}

/**
 * True if rows `startY`..`endY` (buffer rows, inclusive) are all Claude's
 * reply text. `rowAt` returns null past the buffer.
 */
export function selectionInReply(rowAt: (y: number) => ScreenRow | null, startY: number, endY: number): boolean {
  if (startY < 0 || endY < startY) return false;
  const floor = Math.max(0, endY - MAX_WALK_ROWS);
  for (let y = endY; y >= floor; y--) {
    const row = rowAt(y);
    if (!row) return false;
    const kind = rowKind(row);
    if (kind === 'tool-output' || kind === 'other-start') return false;
    if (kind === 'reply-start' && y <= startY) return true;
  }
  return false;
}
