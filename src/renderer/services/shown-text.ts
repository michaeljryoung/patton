/**
 * The one cleaner for untrusted text a program sends that Patton shows: OSC
 * 7501 messages and task titles, pane titles (OSC 0/2) and folders in the tab
 * hover card. Pure: no DOM. Whatever it returns is still set with
 * `textContent` only.
 */

// Direction overrides and invisible formatting: removed before anything shows
// them. Arabic letter mark, zero-width and bidi marks, embeddings and
// overrides, word joiner and isolates, BOM, plus the soft hyphen, the
// Mongolian vowel separator, the blank Braille pattern (shows as nothing in
// most fonts) and the Unicode tag block (invisible "ASCII smuggling").
export const INVISIBLE_RE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2800\ufeff\u{E0000}-\u{E007F}]/gu;

// Every control character (C0, DEL, C1), for text from anywhere, replaced
// rather than refused: what is left is shown.
// eslint-disable-next-line no-control-regex
const CONTROL_ALL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

export const SHOWN_TEXT_MAX = 120;

/** Cut to `max` characters (code points, so a surrogate pair is never split),
 *  with an ellipsis when cut. */
export function shortText(text: string, max = SHOWN_TEXT_MAX): string {
  const t = text.trim();
  const points = Array.from(t);
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : t;
}

/** Untrusted text from any program, made safe to show as text: control
 *  characters become spaces, direction overrides and invisible formatting go,
 *  runs of white space collapse, and it is cut to `max` characters. */
export function shownText(text: string, max = SHOWN_TEXT_MAX): string {
  const clean = text.replace(CONTROL_ALL_RE, ' ').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ');
  return shortText(clean, max);
}
