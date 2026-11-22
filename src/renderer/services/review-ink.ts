/**
 * Snaps a comment highlight's edges to the ink actually drawn on a page's
 * canvas. The highlight is laid from pdf.js's text layer, which sets each line
 * in a fallback font stretched to the line's width, so a word in the middle of
 * a line sits a few pixels off the glyphs the canvas shows (the quote's first
 * letter was 1-2 px outside the box, its last space inside it). The canvas is
 * the truth: the edge moves to the nearest edge of ink, never further than
 * SNAP_CSS_PX, and stays where it is when the canvas has no ink nearby (a
 * blank or not yet drawn page, text on a dark fill).
 */

/** The farthest an edge moves, in CSS pixels. */
export const SNAP_CSS_PX = 6;
/** A pixel is ink when it is this much darker than the brightest pixel in the window. */
const INK_DROP = 70;

export interface MarkBox {
  left: number;
  right: number;
  top: number;
  height: number;
}

/** Which edges may move: only an edge that bounds a word (a space, a line or a span beyond it). */
export interface SnapEdges {
  left: boolean;
  right: boolean;
}

/** Ink flags for the pixel columns [x0, x1) of the canvas, over the rows [y0, y1). */
function inkColumns(ctx: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number): boolean[] {
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return [];
  const data = ctx.getImageData(x0, y0, w, h).data;
  const luma = new Float32Array(w * h);
  let max = 0;
  for (let i = 0; i < w * h; i++) {
    const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    luma[i] = l;
    if (l > max) max = l;
  }
  const ink: boolean[] = [];
  for (let x = 0; x < w; x++) {
    let dark = false;
    for (let y = 0; y < h && !dark; y++) dark = luma[y * w + x] < max - INK_DROP;
    ink.push(dark);
  }
  return ink;
}

/** A stretch of ink columns [from, to) with no gap of the word-space size inside it: one word (or a few, when set tight). */
interface Run {
  from: number;
  to: number;
}

/** Ink columns merged into words: gaps narrower than `gap` columns belong to the word. */
function wordRuns(ink: boolean[], gap: number): Run[] {
  const runs: Run[] = [];
  let blank = 0;
  for (let x = 0; x < ink.length; x++) {
    if (!ink[x]) { blank++; continue; }
    const last = runs[runs.length - 1];
    if (last && blank < gap) last.to = x + 1; else runs.push({ from: x, to: x + 1 });
    blank = 0;
  }
  return runs;
}

/**
 * The box with its left and/or right edge on the nearest word edge of the
 * ink. `box` is in CSS pixels from the page's top-left, the same space as the
 * canvas's CSS size. The nearest edge, not the ink at the nominal edge: the
 * text layer's edge can fall inside the neighbouring word, whose own end is not
 * the quote's.
 */
export function snapToInk(canvas: HTMLCanvasElement, box: MarkBox, edges: SnapEdges): { left: number; right: number } {
  const out = { left: box.left, right: box.right };
  const cssW = parseFloat(canvas.style.width);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || !(cssW > 0) || canvas.width === 0) return out;
  const k = canvas.width / cssW;
  const win = Math.ceil(SNAP_CSS_PX * k);
  // A gap this wide (a word space is about a quarter of the line's height) ends a word.
  const gap = Math.max(1.5, box.height * 0.15) * k;
  // The middle of the line: clear of the neighbouring lines' ascenders and descenders.
  const y0 = Math.max(0, Math.floor((box.top + box.height * 0.2) * k));
  const y1 = Math.min(canvas.height, Math.ceil((box.top + box.height * 0.8) * k));

  const window = (edge: number): { x0: number; runs: Run[] } => {
    const x0 = Math.max(0, edge - win);
    const x1 = Math.min(canvas.width, edge + win);
    return { x0, runs: wordRuns(inkColumns(ctx, x0, x1, y0, y1), gap) };
  };
  const nearest = (xs: number[], to: number): number | null => {
    let best: number | null = null;
    for (const x of xs) if (best === null || Math.abs(x - to) < Math.abs(best - to)) best = x;
    return best;
  };

  if (edges.left) {
    const edge = Math.round(box.left * k);
    const { x0, runs } = window(edge);
    // A run touching the window's left edge may be the rest of a word that began outside it.
    const starts = runs.filter((r) => r.from >= gap || x0 === 0).map((r) => x0 + r.from);
    const hit = nearest(starts, edge);
    if (hit !== null) out.left = hit / k;
  }
  if (edges.right) {
    const edge = Math.round(box.right * k);
    const { x0, runs } = window(edge);
    const lastCol = Math.min(canvas.width, edge + win) - x0;
    const ends = runs.filter((r) => r.to <= lastCol - gap || x0 + lastCol >= canvas.width).map((r) => x0 + r.to);
    const hit = nearest(ends, edge);
    if (hit !== null) out.right = hit / k;
  }
  if (out.right - out.left < 1) return { left: box.left, right: box.right };
  return out;
}
