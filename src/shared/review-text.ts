/**
 * The quote key both halves of the review tab match comments by
 * (docs/review-tab.md R7): main matches it against the .docx body
 * (main/docx-comments.ts), the renderer counts it in the PDF's text before a
 * selection (components/review-view.ts). Pure, no Node or DOM.
 *
 * All whitespace removed, NFKC-normalised (ligatures, wide forms), soft
 * hyphens and zero-width marks dropped.
 */

const DROP = /[\s\u00ad\u200b-\u200f\u2060\ufeff]/u;

/** Normalise one source character into its key characters ('' to drop). */
export function keyOf(ch: string): string {
  if (DROP.test(ch)) return '';
  return ch.normalize('NFKC').replace(/[\s\u00ad\u200b-\u200f\u2060\ufeff]/gu, '');
}

/** The key of any text (the PDF side uses the same rule). */
export function textKey(text: string): string {
  let out = '';
  for (const ch of text) out += keyOf(ch);
  return out;
}

/** Start indexes of every match of `needle` in `hay` (overlapping). */
export function matchesOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}
