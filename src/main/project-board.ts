import { chmodSync, copyFileSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULTS, isBoardTint } from '../shared/constants';
import type { BoardAddRequest, BoardLayout, BoardPayload, BoardProject, BoardSubProject, BoardTheme, BoardTileOptions } from '../shared/types';
import { cleanBookmarkLabel } from './bookmarks';
import { isSafeAbsolutePath, linkedWorktreeMainRoot } from './projects';
import { isAllowedCwdPath } from './pty-manager';

/**
 * The project board's data: the project list (a Markdown table, the format the
 * `cc` launcher reads, ~/.claude/projects.md by default) and the board's own
 * arrangement (themes, tile order, tile options) in userData/project-board.json.
 *
 * The renderer is untrusted: every layout it sends is validated here, and the
 * one write to the project list (adding a row) checks the folder and the name
 * and leaves every other byte of the file as it was, because `cc` and Claude
 * sessions read that file too.
 */

export const LAYOUT_FILE_NAME = 'project-board.json';
const THEME_ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const SUB_SEPARATORS = [' — ', ' – ', ' - ', ': '];

/** One row of the list, as the launcher's parser reads it. */
export interface ListRow {
  name: string;
  /** The path as written, with a leading ~ expanded (not yet normalised). */
  path: string;
}

export function emptyLayout(): BoardLayout {
  return { version: 1, themes: [], tiles: {} };
}

/** "/Users/me/x" → "~/x" for display and log lines; other paths unchanged. */
export function tildePath(path: string, home: string = homedir()): string {
  if (!home || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

// ── The project list ──

/** Strip one leading and one trailing space, as the launcher's `${x## }` /
 *  `${x%% }` do (a single-space pattern removes one space). */
function stripOneSpace(text: string): string {
  let t = text;
  if (t.startsWith(' ')) t = t.slice(1);
  if (t.endsWith(' ')) t = t.slice(0, -1);
  return t;
}

/**
 * Parse the list exactly as `_cc_parse_projects` in the `cc` launcher does:
 * every line holding `|`, minus lines holding `---` and the header (`Project`
 * then `Path`); one leading and one trailing `|` off; the name is the text
 * before the next `|`; the path is the text after it from just past the first
 * backtick to the next backtick (so `[`~/p`](file://…)` link rows and trailing
 * annotations both work); a leading ~ is the home folder. Like the launcher's
 * `while read`, a last line without a newline is not read.
 */
export function parseProjectList(text: string, home: string = homedir()): ListRow[] {
  const rows: ListRow[] = [];
  const lines = text.split('\n');
  // The text after the last newline is an unterminated line (or empty).
  lines.pop();
  for (const line of lines) {
    if (!line.includes('|')) continue;
    if (line.includes('---')) continue;
    if (/Project.*Path/.test(line)) continue;
    let trimmed = line.startsWith('|') ? line.slice(1) : line;
    if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
    const bar = trimmed.indexOf('|');
    const namePart = bar === -1 ? trimmed : trimmed.slice(0, bar);
    let pathPart = bar === -1 ? trimmed : trimmed.slice(bar + 1);
    const name = stripOneSpace(namePart);
    pathPart = stripOneSpace(pathPart);
    const tick = pathPart.indexOf('`');
    if (tick !== -1) pathPart = pathPart.slice(tick + 1);
    const nextTick = pathPart.indexOf('`');
    if (nextTick !== -1) pathPart = pathPart.slice(0, nextTick);
    pathPart = stripOneSpace(pathPart);
    if (pathPart.startsWith('~')) pathPart = home + pathPart.slice(1);
    if (name && pathPart) rows.push({ name, path: pathPart });
  }
  return rows;
}

/** The list file the setting names: empty = ~/.claude/projects.md; `~/…`
 *  expands; anything not a safe absolute path gives null. */
export function resolveListFile(setting: unknown, home: string = homedir()): string | null {
  const raw = typeof setting === 'string' ? setting.trim() : '';
  if (!raw) return join(home, '.claude', 'projects.md');
  const expanded = raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw;
  return isSafeAbsolutePath(expanded) ? resolve(expanded) : null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Claude Code's session folder name for a project: every character outside
 *  [A-Za-z0-9] becomes `-` ("/Users/me/my.app" → "-Users-me-my-app"). */
export function claudeSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-');
}

/** When a Claude session last ran in this folder: the mtime of
 *  ~/.claude/projects/<slug>, in ms; undefined when there is none. */
export function lastSessionAt(path: string, home: string = homedir()): number | undefined {
  try {
    const info = statSync(join(home, '.claude', 'projects', claudeSlug(path)));
    return info.isDirectory() ? info.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** A sub-project's name inside its parent's tile: "Alpha — Beta worktree"
 *  under "Alpha" reads "Beta". Falls back to the full name. */
export function subProjectDisplayName(name: string, parentName: string): string {
  let shown = name;
  for (const sep of SUB_SEPARATORS) {
    const prefix = parentName + sep;
    if (shown.length > prefix.length && shown.startsWith(prefix)) {
      shown = shown.slice(prefix.length);
      break;
    }
  }
  const stripped = shown.replace(/\s+worktree$/i, '');
  if (stripped.trim()) shown = stripped;
  shown = shown.trim();
  return shown || name;
}

interface ListedProject {
  name: string;
  path: string;
}

/** The list's rows that may be shown: normalised, safe, allowed paths, the
 *  first row for each folder. Refusals are logged with the reason only. */
function usableRows(rows: ListRow[]): ListedProject[] {
  const seen = new Set<string>();
  const kept: ListedProject[] = [];
  for (const row of rows) {
    if (!isSafeAbsolutePath(row.path)) {
      console.warn('[BOARD] Row skipped', { reason: 'path is not a safe absolute path' });
      continue;
    }
    const path = resolve(row.path);
    if (!isAllowedCwdPath(path)) {
      console.warn('[BOARD] Row skipped', { reason: 'path outside the folders a tab can open in' });
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    kept.push({ name: row.name.trim(), path });
  }
  return kept;
}

/**
 * Group the rows one level deep. A row is a sub-project of another listed
 * project when it is a linked git worktree whose main folder is listed
 * (kind 'worktree'), or when its folder lies inside that project's folder,
 * the longest such match (kind 'folder'). A deeper descendant attaches to the
 * top of its chain. Order follows the list.
 */
export function nestProjects(rows: ListedProject[], home: string = homedir()): BoardProject[] {
  // git records a worktree's repository by its real path, so listed folders
  // are matched by theirs too (a list may name a folder through a symlink).
  const byRealPath = new Map<string, string>();
  for (const r of rows) {
    const real = realPathOrNull(r.path);
    if (real && !byRealPath.has(real)) byRealPath.set(real, r.path);
  }
  const direct = new Map<string, { parent: string; kind: 'worktree' | 'folder' }>();
  for (const row of rows) {
    const mainRoot = linkedWorktreeMainRoot(row.path);
    const mainListed = mainRoot ? byRealPath.get(realPathOrNull(mainRoot) ?? mainRoot) : undefined;
    if (mainListed && mainListed !== row.path) {
      direct.set(row.path, { parent: mainListed, kind: 'worktree' });
      continue;
    }
    let best: string | null = null;
    for (const other of rows) {
      if (other.path === row.path || other.path === '/') continue;
      if (row.path.startsWith(other.path + '/') && (!best || other.path.length > best.length)) best = other.path;
    }
    if (best) direct.set(row.path, { parent: best, kind: 'folder' });
  }

  const topOf = (path: string): string => {
    const visited = new Set<string>([path]);
    let current = path;
    for (;;) {
      const link = direct.get(current);
      if (!link || visited.has(link.parent)) return current;
      visited.add(link.parent);
      current = link.parent;
    }
  };

  const projects = new Map<string, BoardProject>();
  for (const row of rows) {
    if (direct.has(row.path) && topOf(row.path) !== row.path) continue;
    projects.set(row.path, {
      path: row.path,
      name: row.name,
      ...(isDirectory(row.path) ? {} : { missing: true }),
      ...optionalTime(lastSessionAt(row.path, home)),
      subProjects: [],
    });
  }
  for (const row of rows) {
    const link = direct.get(row.path);
    if (!link) continue;
    const top = projects.get(topOf(row.path));
    if (!top || top.path === row.path) continue;
    const sub: BoardSubProject = {
      path: row.path,
      name: row.name,
      displayName: subProjectDisplayName(row.name, top.name),
      kind: link.kind,
      ...(isDirectory(row.path) ? {} : { missing: true }),
      ...optionalTime(lastSessionAt(row.path, home)),
    };
    top.subProjects.push(sub);
  }
  return [...projects.values()];
}

function realPathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function optionalTime(ms: number | undefined): { lastSessionAt?: number } {
  return ms === undefined ? {} : { lastSessionAt: Math.round(ms) };
}

// ── The layout file ──

/** A theme's name as stored: a bookmark label's rules, capped at 40. */
export function cleanThemeName(raw: string): string {
  return cleanBookmarkLabel(raw).slice(0, DEFAULTS.BOARD_THEME_NAME_MAX_CHARS).trim();
}

/** A tile's note: one line, no control characters, capped at 80 (a bookmark
 *  label's rules with a longer cap). */
function cleanNote(raw: string): string {
  return raw.slice(0, 1000).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, DEFAULTS.BOARD_NOTE_MAX_CHARS).trim();
}

/**
 * Validate a whole layout from the renderer or the file. Returns the layout
 * worth storing, or null when it isn't a layout at all. Bad entries are dropped
 * or corrected (a bad tint becomes 'none', a long name is cut) and logged,
 * so one bad entry can't lose the rest. Paths are not checked against the disk
 * or the list: a project briefly missing keeps its place.
 */
export function validateLayout(raw: unknown): BoardLayout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.themes)) return null;

  const themes: BoardTheme[] = [];
  const ids = new Set<string>();
  const placed = new Set<string>();
  let pathCount = 0;
  for (const entry of obj.themes) {
    if (themes.length >= DEFAULTS.BOARD_THEMES_MAX) {
      console.warn('[BOARD] Layout themes truncated', { max: DEFAULTS.BOARD_THEMES_MAX, received: obj.themes.length });
      break;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.id !== 'string' || !THEME_ID_PATTERN.test(t.id) || ids.has(t.id)) {
      console.warn('[BOARD] Theme dropped', { reason: 'bad or duplicate id' });
      continue;
    }
    if (typeof t.name !== 'string' || t.name.length > 1000) {
      console.warn('[BOARD] Theme dropped', { reason: 'bad name' });
      continue;
    }
    const name = cleanThemeName(t.name);
    if (!name) {
      console.warn('[BOARD] Theme dropped', { reason: 'empty name' });
      continue;
    }
    const tint = isBoardTint(t.tint) ? t.tint : 'none';
    const projects: string[] = [];
    for (const p of Array.isArray(t.projects) ? t.projects : []) {
      if (pathCount >= DEFAULTS.BOARD_PATHS_MAX) break;
      if (!isSafeAbsolutePath(p) || placed.has(p)) continue;
      placed.add(p);
      projects.push(p);
      pathCount++;
    }
    ids.add(t.id);
    themes.push({ id: t.id, name, tint, projects });
  }

  const tiles: Record<string, BoardTileOptions> = {};
  const rawTiles = obj.tiles && typeof obj.tiles === 'object' && !Array.isArray(obj.tiles)
    ? (obj.tiles as Record<string, unknown>)
    : {};
  let tileCount = 0;
  for (const [path, value] of Object.entries(rawTiles)) {
    if (tileCount >= DEFAULTS.BOARD_PATHS_MAX) break;
    if (!isSafeAbsolutePath(path) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const options: BoardTileOptions = {};
    if (v.wide === true) options.wide = true;
    if (typeof v.note === 'string') {
      const note = cleanNote(v.note);
      if (note) options.note = note;
    }
    if (options.wide || options.note) {
      tiles[path] = options;
      tileCount++;
    }
  }
  return { version: 1, themes, tiles };
}

export function layoutPath(userDataDir: string): string {
  return join(userDataDir, LAYOUT_FILE_NAME);
}

/** The stored layout. A missing file is an empty layout; a corrupt one is
 *  copied to project-board.json.bad (before anything can overwrite it) and
 *  read as empty. */
export function readLayout(userDataDir: string): BoardLayout {
  const file = layoutPath(userDataDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return emptyLayout();
  }
  let layout: BoardLayout | null = null;
  try {
    layout = validateLayout(JSON.parse(text));
  } catch {
    layout = null;
  }
  if (layout) return layout;
  try {
    copyFileSync(file, `${file}.bad`);
    console.warn('[BOARD] Layout file unreadable; copied to project-board.json.bad and read as empty');
  } catch (err) {
    console.warn('[BOARD] Layout file unreadable and could not be copied aside', { err: String(err) });
  }
  return emptyLayout();
}

/** Write a file atomically: a temp file in the same folder, then a rename.
 *  Keeps the old file's permissions when there was one. */
function writeAtomic(file: string, content: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let mode: number | null = null;
  try {
    mode = statSync(file).mode & 0o777;
  } catch { /* new file */ }
  try {
    writeFileSync(tmp, content, 'utf8');
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

/** Validate and store a layout. Returns what was stored, or null when the
 *  payload wasn't a layout. Throws if the file can't be written. */
export function saveLayout(userDataDir: string, raw: unknown): BoardLayout | null {
  const layout = validateLayout(raw);
  if (!layout) {
    console.warn('[BOARD] Layout refused', { reason: 'not a layout' });
    return null;
  }
  // A corrupt file is set aside before this save replaces it.
  readLayout(userDataDir);
  writeAtomic(layoutPath(userDataDir), JSON.stringify(layout, null, 2) + '\n');
  const placed = layout.themes.reduce((n, t) => n + t.projects.length, 0);
  console.info('[BOARD] Layout saved', { themes: layout.themes.length, placed });
  return layout;
}

// ── The whole board ──

export interface BoardSources {
  /** The `projectListFile` setting (empty = the default). */
  listSetting: unknown;
  userDataDir: string;
  home?: string;
}

export function loadBoard(sources: BoardSources): BoardPayload {
  const home = sources.home ?? homedir();
  const listFile = resolveListFile(sources.listSetting, home);
  const layout = readLayout(sources.userDataDir);
  const shownFile = listFile ? tildePath(listFile, home) : String(sources.listSetting ?? '');
  if (!listFile || !isFile(listFile)) {
    console.info('[BOARD] Loaded', { listFound: false });
    return { listFile: shownFile, listFound: false, projects: [], layout };
  }
  let text = '';
  try {
    text = readFileSync(listFile, 'utf8');
  } catch (err) {
    console.warn('[BOARD] Project list unreadable', { err: String(err) });
    return { listFile: shownFile, listFound: false, projects: [], layout };
  }
  const projects = nestProjects(usableRows(parseProjectList(text, home)), home);
  const subs = projects.reduce((n, p) => n + p.subProjects.length, 0);
  console.info('[BOARD] Loaded', {
    listFound: true, projects: projects.length, subProjects: subs,
    missing: projects.filter((p) => p.missing).length, themes: layout.themes.length,
  });
  return { listFile: shownFile, listFound: true, projects, layout };
}

// ── Adding a project row ──

/** Percent-encode a path for a file:// link: each segment, plus ( and ),
 *  which would end the Markdown link. */
function fileUrl(path: string): string {
  const encoded = path.split('/').map((seg) => encodeURIComponent(seg).replace(/\(/g, '%28').replace(/\)/g, '%29')).join('/');
  return `file://${encoded}`;
}

/** The new row, in the form the file's rows already use: the clickable link
 *  form when any row has one, else the plain backticked path. */
export function formatListRow(name: string, path: string, linkForm: boolean, home: string = homedir()): string {
  const shown = tildePath(path, home);
  return linkForm ? `| ${name} | [\`${shown}\`](${fileUrl(path)}) |` : `| ${name} | \`${shown}\` |`;
}

/**
 * Insert a row directly after the last row of the table that holds the
 * project rows (the file can carry notes below it), leaving every other byte
 * as it was. With no project rows yet: after a header table if there is one,
 * else at the end.
 */
export function insertListRow(text: string, row: string, home: string = homedir()): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split('\n');
  const isTableLine = (line: string) => line.trimStart().startsWith('|');
  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    if (parseProjectList(lines[i] + '\n', home).length > 0) {
      anchor = i;
      break;
    }
  }
  if (anchor === -1) {
    anchor = lines.findIndex((line) => /Project.*Path/.test(line) && isTableLine(line));
  }
  if (anchor === -1) {
    const needsBreak = text.length > 0 && !text.endsWith('\n');
    return text + (needsBreak ? eol : '') + row + eol;
  }
  let last = anchor;
  while (last + 1 < lines.length && isTableLine(lines[last + 1])) last++;
  // Byte offset just past the table's last line (and its newline).
  let offset = 0;
  for (let i = 0; i <= last; i++) offset += lines[i].length + 1;
  if (offset > text.length) {
    // The table's last line ends the file with no newline: give it one, so
    // the launcher (which skips an unterminated last line) reads the new row.
    return text + eol + row + eol;
  }
  return text.slice(0, offset) + row + eol + text.slice(offset);
}

export type AddCheck = { ok: true; path: string; name: string; reason?: undefined } | { ok: false; reason: string };

/** Check an add request against the rules the launcher's own `cc add` keeps
 *  and the folders a tab may open in. */
export function checkAddRequest(raw: unknown, listedPaths: readonly string[]): AddCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not a request' };
  const req = raw as Record<string, unknown>;
  if (typeof req.path !== 'string' || typeof req.name !== 'string' || req.name.length > 1000) {
    return { ok: false, reason: 'bad request' };
  }
  if (/[|`\r\n]|---/.test(req.path)) return { ok: false, reason: 'the folder path contains |, a backtick or ---' };
  if (!isSafeAbsolutePath(req.path)) return { ok: false, reason: 'the folder path is not a safe absolute path' };
  const path = resolve(req.path);
  if (!isAllowedCwdPath(path)) return { ok: false, reason: 'the folder is outside the folders a tab can open in' };
  if (!isDirectory(path)) return { ok: false, reason: 'the folder does not exist' };
  if (/[\r\n]/.test(req.name)) return { ok: false, reason: 'the name has a line break' };
  // A bookmark label's cleaning, but refused rather than cut when too long.
  const name = req.name.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!name || name.length > DEFAULTS.BOARD_PROJECT_NAME_MAX_CHARS) {
    return { ok: false, reason: `the name must be 1 to ${DEFAULTS.BOARD_PROJECT_NAME_MAX_CHARS} characters` };
  }
  if (/[|`[\]]|---/.test(name)) return { ok: false, reason: 'the name contains |, a backtick, ---, [ or ]' };
  if (listedPaths.includes(path)) return { ok: false, reason: 'the folder is already in the list' };
  return { ok: true, path, name };
}

/** Add a project to the list file and place it in a theme. Returns the fresh
 *  board, with `error` set when the request was refused. */
export function addProject(sources: BoardSources, raw: unknown): BoardPayload {
  const home = sources.home ?? homedir();
  const refuse = (reason: string): BoardPayload => {
    console.warn('[BOARD] Add refused', { reason });
    return { ...loadBoard(sources), error: reason };
  };
  const listFile = resolveListFile(sources.listSetting, home);
  if (!listFile || !isFile(listFile)) return refuse('the project list file was not found');
  let target: string;
  let text: string;
  try {
    // Write through a symlink to the real file, never replacing the link.
    target = realpathSync(listFile);
    text = readFileSync(target, 'utf8');
  } catch {
    return refuse('the project list file could not be read');
  }
  const listed = parseProjectList(text, home)
    .filter((r) => isSafeAbsolutePath(r.path))
    .map((r) => resolve(r.path));
  const check = checkAddRequest(raw, listed);
  if (check.ok === false) return refuse(check.reason);

  const row = formatListRow(check.name, check.path, text.includes('](file://'), home);
  try {
    writeAtomic(target, insertListRow(text, row, home));
  } catch (err) {
    console.warn('[BOARD] Add failed', { err: String(err) });
    return refuse('the project list file could not be written');
  }

  const themeId = (raw as BoardAddRequest).themeId;
  if (typeof themeId === 'string' && themeId) {
    const layout = readLayout(sources.userDataDir);
    const theme = layout.themes.find((t) => t.id === themeId);
    if (theme) {
      for (const t of layout.themes) t.projects = t.projects.filter((p) => p !== check.path);
      theme.projects.push(check.path);
      try {
        saveLayout(sources.userDataDir, layout);
      } catch (err) {
        console.warn('[BOARD] Added, but its theme could not be saved', { err: String(err) });
      }
    }
  }
  console.info('[BOARD] Project added', { themed: Boolean(themeId), form: text.includes('](file://') ? 'link' : 'plain' });
  return loadBoard(sources);
}
