/**
 * The terminal grid that fits `.terminal-container`'s content box.
 *
 * @xterm/addon-fit's proposeDimensions sizes the grid from the parent's computed height and width
 * and subtracts only the `.xterm` element's own padding. Patton pads the parent instead
 * (`.terminal-container`: 4 px top and sides, 10 px bottom) and every element is `border-box`
 * (main.css), so the computed height includes that padding: with less than 4 px left over below
 * the last whole row, the addon gave one row too many and the container clipped the last row
 * (UI scale 1.5 with the box under the terminal: 27 rows x 16 px + 4 px = 436 px in a 433.6 px
 * container). Same arithmetic as the addon (minimums 2 cols and 1 row, the scrollbar's width
 * kept off the cols), with the parent's padding taken off when its box-sizing includes it.
 */

export interface FitInput {
  /** The parent's computed `height` and `width` (px). */
  height: number;
  width: number;
  /** The parent's padding (px). */
  padTop: number; padBottom: number; padLeft: number; padRight: number;
  /** Whether the parent's computed size includes its padding (`box-sizing: border-box`). */
  borderBox: boolean;
  /** The `.xterm` element's own padding (px), as the addon subtracts it. */
  innerPadV: number; innerPadH: number;
  /** Width kept for the scrollbar (the addon: 0 with no scrollback, else the overview ruler's or 14). */
  scrollbarWidth: number;
  cellWidth: number; cellHeight: number;
}

export const FIT_MIN_COLS = 2;
export const FIT_MIN_ROWS = 1;

export function fitGrid(f: FitInput): { cols: number; rows: number } | null {
  if (!(f.cellWidth > 0) || !(f.cellHeight > 0)) return null;
  if (!Number.isFinite(f.height) || !Number.isFinite(f.width)) return null;
  const outerV = f.borderBox ? f.padTop + f.padBottom : 0;
  const outerH = f.borderBox ? f.padLeft + f.padRight : 0;
  const availH = Math.max(0, f.height - outerV - f.innerPadV);
  const availW = Math.max(0, f.width - outerH - f.innerPadH - f.scrollbarWidth);
  return {
    cols: Math.max(FIT_MIN_COLS, Math.floor(availW / f.cellWidth)),
    rows: Math.max(FIT_MIN_ROWS, Math.floor(availH / f.cellHeight)),
  };
}
