/**
 * What a double-clicked file link may do: open it, send it to the code editor,
 * or only reveal it in Finder. Pure (no Electron, no fs), so it can be checked
 * headlessly (scripts/check-link-open-policy.mjs).
 *
 * Threat: any program writing to the terminal (a `cat` of a downloaded file, a
 * package script, an ssh session, Claude echoing a hostile page) can print a
 * link, and with OSC 8 its text can say anything. One double-click must never
 * run code. On macOS `shell.openPath` hands a file to its default app, and
 * that RUNS `.app` bundles, `.command`/`.tool`/`.terminal` and extension-less
 * executables (Terminal), `.sh`/`.zsh`/`.pl` (iTerm on Michael's Mac), passes
 * `.pkg`/`.dmg`/`.jar`/`.workflow`/`.mobileconfig`/`.scpt` to installers and
 * runners, and `.webloc`/`.inetloc`/`.fileloc` open any URL scheme. So
 * `openPath` is used only for an explicit allow-list of view-only types whose
 * default app is a viewer (checked against Launch Services on this Mac,
 * 7 Nov 2026, by a read-only NSWorkspace lookup); everything else is revealed.
 */

/** Default app is a viewer: TextEdit, Preview, Console, Numbers, the browser
 *  (HTML/SVG run in the browser's file:// sandbox). */
const VIEW_TYPES = new Set([
  'txt', 'text', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml', 'diff', 'patch',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'tif', 'tiff', 'bmp', 'svg', 'pdf', 'html', 'htm',
]);

/** Source and config files: fine in a code editor, but their default app may
 *  run them (`.sh`/`.zsh`/`.pl` → iTerm, `.js` → browser, `.py` → Python
 *  Launcher on many Macs), map to an unrelated app (`.ts` → QuickTime,
 *  `.xml` → Word) or to nothing. Without an editor they are revealed. */
const CODE_TYPES = new Set([
  'py', 'sh', 'bash', 'zsh', 'fish', 'rb', 'pl', 'pm', 'php', 'lua', 'r',
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'jsx', 'vue', 'svelte',
  'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm', 'java', 'kt', 'kts', 'swift', 'cs', 'scala',
  'sql', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'css', 'scss', 'sass', 'less', 'gradle', 'lock',
]);

/** Types that run, install or redirect when opened. Revealed whatever else is
 *  true; listed so the log can say why (they are not on either list above). */
const RISKY_TYPES = new Set([
  'app', 'command', 'tool', 'terminal', 'pkg', 'mpkg', 'dmg', 'jar', 'workflow', 'action',
  'mobileconfig', 'scpt', 'scptd', 'applescript', 'webloc', 'inetloc', 'fileloc', 'url',
  'prefpane', 'saver', 'kext', 'plugin', 'osax', 'bundle', 'shortcut', 'definition', 'qlgenerator',
]);

export interface FileFacts {
  /** Extension of the RESOLVED path (after symlinks), lower-cased, no dot; '' for none. */
  ext: string;
  /** stat().isFile() of the resolved path. */
  isFile: boolean;
  /** stat().mode of the resolved path. */
  mode: number;
  /** A code editor CLI was found. */
  editorAvailable: boolean;
}

export type OpenDecision =
  | { action: 'open' }
  | { action: 'editor' }
  | { action: 'reveal'; reason: string };

/** Lower-cased extension of the last path segment, without the dot. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function decideFileOpen(facts: FileFacts): OpenDecision {
  const { ext, isFile, mode, editorAvailable } = facts;
  if (!isFile) return { action: 'reveal', reason: 'not a regular file' };
  if (RISKY_TYPES.has(ext)) return { action: 'reveal', reason: 'runs or installs when opened' };
  const textual = VIEW_TYPES.has(ext) || CODE_TYPES.has(ext);
  // The editor shows the file as text, so an executable script may go there.
  if (editorAvailable && textual) return { action: 'editor' };
  if ((mode & 0o111) !== 0) return { action: 'reveal', reason: 'executable' };
  if (VIEW_TYPES.has(ext)) return { action: 'open' };
  if (CODE_TYPES.has(ext)) return { action: 'reveal', reason: 'code file and no editor' };
  return { action: 'reveal', reason: ext ? 'type not on the open list' : 'no extension' };
}

/**
 * Validate a file-link path from the renderer: absolute (after `~/` expansion
 * by the caller), at most 1000 characters, an optional `:line[:col]` suffix,
 * no `..` segment, no control characters or bidi overrides. Any other
 * printable character is allowed (parentheses, commas, quotes, `+`, accents,
 * U+202F in macOS screenshot names): the path reaches only `execFile` argv
 * (no shell), `realpath`/`stat`, `shell.openPath` and `shell.showItemInFolder`.
 * Returns the path without its suffix and the suffix, or null if refused.
 */
export function parseLinkPath(filePath: string): { path: string; suffix: string } | null {
  if (filePath.length === 0 || filePath.length > 1000) return null;
  if (!filePath.startsWith('/')) return null;
  if (/[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(filePath)) return null;
  if (/(?:^|\/)\.\.(?:\/|$)/.test(filePath)) return null;
  const m = /^(.*?)((?::\d+(?::\d+)?)?)$/.exec(filePath);
  if (!m || m[1] === '' || m[1] === '/') return null;
  return { path: m[1], suffix: m[2] };
}
