import { stripPasteControls } from './paste-sanitize';

/**
 * Dropped files (design D5, docs/compose-box.md). Pure helpers: which drags
 * we handle, how a path is escaped for the shell, and where the text goes.
 * Nothing here reads a file; the path comes from the preload's
 * webUtils.getPathForFile.
 */

/** A drag that carries files. Tab drags and the pane-swap drag carry other
 *  types, so they never match. */
export function isFileDrag(dt: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  if (!dt || !dt.types) return false;
  return Array.from(dt.types as ArrayLike<string>).includes('Files');
}

// Characters Terminal.app leaves bare: letters and digits of any script, the
// combining marks that build them (é as e + U+0301, as macOS stores names),
// emoji with their skin tones, variation selector (U+FE0F, a mark) and
// joiner (U+200D), and these ASCII marks. Everything else (spaces, quotes,
// $ & ( ) ; * ? [ ] { } < > | ! # ` ^ and so on) gets a backslash.
const SAFE_PATH_CHAR = /[\p{L}\p{N}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}_\-.,:/@%+=~]/u;
const ZERO_WIDTH_JOINER = '\u200D';

/** One path, escaped as Terminal.app escapes a dropped file: a backslash
 *  before each space and shell special. Line breaks cannot be escaped (a
 *  backslash before one is a line continuation, and a bare one would run the
 *  line), so they are removed, as are tab, DEL and the other control
 *  characters. */
export function escapeDropPath(path: string): string {
  const clean = stripPasteControls(path).replace(/[\r\n\t\x7f]/g, '');
  let out = '';
  for (const ch of clean) out += ch === ZERO_WIDTH_JOINER || SAFE_PATH_CHAR.test(ch) ? ch : '\\' + ch;
  return out;
}

/** The paths escaped, joined by single spaces, with a trailing space so the
 *  next word does not run into the last path. '' when there is no path. */
export function formatDropPaths(paths: readonly string[]): string {
  const escaped = paths.map(escapeDropPath).filter((p) => p !== '');
  return escaped.length === 0 ? '' : escaped.join(' ') + ' ';
}

/** The text for a drop: each file's path, via `getPath` (webUtils.getPathForFile). */
export function dropText(files: ArrayLike<File>, getPath: (file: File) => string): string {
  const paths: string[] = [];
  for (const file of Array.from(files)) {
    try {
      const p = getPath(file);
      if (p) paths.push(p);
    } catch {
      // a file with no path on disk (an in-memory drag): skip it
    }
  }
  return formatDropPaths(paths);
}

/** Into the compose box at the caret when it is engaged, else to the terminal as a paste. */
export function dropTarget(composeEngaged: boolean): 'box' | 'terminal' {
  return composeEngaged ? 'box' : 'terminal';
}
