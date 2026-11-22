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
  const availH = fitAvailHeight(f);
  const availW = fitAvailWidth(f);
  return {
    cols: Math.max(FIT_MIN_COLS, Math.floor(availW / f.cellWidth)),
    rows: Math.max(FIT_MIN_ROWS, Math.floor(availH / f.cellHeight)),
  };
}

/** The width (px) the grid's columns are cut from: the parent's, less its
 *  padding (when its size includes it), the `.xterm` element's own and the
 *  scrollbar's. */
export function fitAvailWidth(f: FitInput): number {
  const outerH = f.borderBox ? f.padLeft + f.padRight : 0;
  return Math.max(0, f.width - outerH - f.innerPadH - f.scrollbarWidth);
}

/** The height (px) the grid's rows are cut from: the parent's, less its padding
 *  (when its size includes it) and the `.xterm` element's own. */
export function fitAvailHeight(f: FitInput): number {
  const outerV = f.borderBox ? f.padTop + f.padBottom : 0;
  return Math.max(0, f.height - outerV - f.innerPadV);
}

/**
 * Extra bottom padding (px) for the parent so the grid is `rowsGivenUp` rows
 * shorter than `f` fits (the compose box's room below, docs/compose-box.md
 * D15). `f` is measured with no extra padding. The padding leaves the grid's
 * available height half a row past its last whole row, not on a row's edge, so
 * rounding (Chromium lays padding out in 1/64 px) can never cost or gain a
 * row. 0 when nothing is given up or the cell size is unknown.
 */
export function roomPadding(f: FitInput, rowsGivenUp: number): number {
  const base = fitGrid(f);
  if (!base || rowsGivenUp <= 0) return 0;
  const target = Math.max(FIT_MIN_ROWS, base.rows - Math.floor(rowsGivenUp));
  if (target >= base.rows) return 0;
  return Math.max(0, fitAvailHeight(f) - (target + 0.5) * f.cellHeight);
}
