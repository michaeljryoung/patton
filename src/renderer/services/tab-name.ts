import { stripClaudeGlyph } from './sessions';

/** How long a tab's automatic name may be, the "…" included (Michael, 12 Nov:
 *  "it should always default to 10 to 15 characters max"). */
export const TAB_NAME_MAX = 15;
/** Whole words are kept only while they leave at least this many characters. */
const TAB_NAME_MIN_WORDS = 10;
/** Only this much of a title is looked at: a megabyte-long one would cost ~100 ms
 *  per tab-bar update in the word and grapheme logic, and nothing past the first
 *  few dozen characters can show. */
const TAB_NAME_INPUT_MAX = 200;

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** Characters as the eye counts them: grapheme clusters where the runtime has
 *  Intl.Segmenter, else code points, so a surrogate pair is never cut in half. */
function glyphs(text: string): string[] {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

function trimEnd(text: string): string {
  return text.replace(/[\s.,;:\-–—_/\\|([{]+$/u, '');
}

/**
 * The short name an automatic tab shows (a title the program in the pane set;
 * never a name the user typed, a project's name or its default name): at most
 * TAB_NAME_MAX characters including the "…". A title that fits is kept whole.
 * A longer one keeps whole words while they stay within 14 characters, and if
 * that leaves fewer than 10 characters it is cut at 14 instead, so a first
 * word of three letters doesn't leave a tab reading "Fix…". Claude Code's
 * state glyph ("✳ ", "◐ ") is dropped first: the tab's dot shows the state, and
 * the glyph would otherwise eat two of the characters.
 */
export function shortTabName(title: string): string {
  const full = stripClaudeGlyph(title.slice(0, TAB_NAME_INPUT_MAX)).trim().replace(/\s+/gu, ' ');
  const chars = glyphs(full);
  if (chars.length <= TAB_NAME_MAX) return full;
  const room = TAB_NAME_MAX - 1;

  let kept = '';
  for (const word of full.split(' ')) {
    const next = kept ? `${kept} ${word}` : word;
    if (glyphs(next).length > room) break;
    kept = next;
  }
  const byWords = trimEnd(kept);
  if (glyphs(byWords).length >= TAB_NAME_MIN_WORDS) return `${byWords}…`;
  return `${trimEnd(chars.slice(0, room).join(''))}…`;
}
