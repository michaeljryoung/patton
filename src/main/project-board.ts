import {
  chmodSync, closeSync, constants as fsConstants, copyFileSync, fstatSync, openSync, readFileSync, realpathSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { keepPlacements } from '../shared/board-placements';
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
 * one write to the project list (adding a row) checks the folder and the name,
 * writes only to a file that already is a project list (a regular UTF-8 text
 * file holding a table whose header row names "Project" and then "Path", the
 * row the launcher skips as the header), adds the row inside that table, and
 * leaves every other byte of the file as it was, because `cc` and Claude
 * sessions read it too.
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

/** What the disk says about a listed folder, gathered off the main thread. */
export interface RowFacts {
  isDirectory: boolean;
  /** The folder's real path (git records worktrees by it), or null. */
  realPath: string | null;
  /** For a linked git worktree, its repository's main folder (real path when
   *  it resolves), else null. */
  worktreeMain: string | null;
  lastSessionAt?: number;
}

/** A listed folder that doesn't answer in this long counts as missing, so a
 *  stalled network or cloud volume can't hold the board back. */
const ROW_FACTS_TIMEOUT_MS = 2000;
const NO_FACTS: RowFacts = { isDirectory: false, realPath: null, worktreeMain: null };

async function rowFacts(path: string, home: string): Promise<RowFacts> {
  const [info, real, session, git] = await Promise.all([
    stat(path).catch((): null => null),
    realpath(path).catch((): null => null),
    stat(join(home, '.claude', 'projects', claudeSlug(path))).catch((): null => null),
    stat(join(path, '.git')).catch((): null => null),
  ]);
  let worktreeMain: string | null = null;
  // Only a linked worktree has a .git FILE; its pointer files are read (small,
  // synchronous) only after the folder has just answered.
  if (git?.isFile()) {
    const main = linkedWorktreeMainRoot(path);
    if (main) worktreeMain = (await realpath(main).catch((): null => null)) ?? main;
  }
  return {
    isDirectory: Boolean(info?.isDirectory()),
    realPath: real,
    worktreeMain,
    ...(session?.isDirectory() ? { lastSessionAt: session.mtimeMs } : {}),
  };
}

/** Each listed folder's facts, all at once, none waiting past the timeout. */
export async function gatherRowFacts(rows: readonly ListedProject[], home: string = homedir()): Promise<Map<string, RowFacts>> {
  let slow = 0;
  const entries = await Promise.all(rows.map(async (row): Promise<[string, RowFacts]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<RowFacts>((done) => {
      timer = setTimeout(() => { slow++; done(NO_FACTS); }, ROW_FACTS_TIMEOUT_MS);
    });
    const facts = await Promise.race([rowFacts(row.path, home).catch(() => NO_FACTS), late]);
    clearTimeout(timer);
    return [row.path, facts];
  }));
  if (slow > 0) console.warn('[BOARD] Folders slow to answer, shown as missing', { count: slow });
  return new Map(entries);
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
export function nestProjects(rows: ListedProject[], facts: ReadonlyMap<string, RowFacts>): BoardProject[] {
  const factsOf = (path: string): RowFacts => facts.get(path) ?? NO_FACTS;
  // git records a worktree's repository by its real path, so listed folders
  // are matched by theirs too (a list may name a folder through a symlink).
  const byRealPath = new Map<string, string>();
  for (const r of rows) {
    const real = factsOf(r.path).realPath;
    if (real && !byRealPath.has(real)) byRealPath.set(real, r.path);
  }
  const direct = new Map<string, { parent: string; kind: 'worktree' | 'folder' }>();
  for (const row of rows) {
    const mainRoot = factsOf(row.path).worktreeMain;
    const mainListed = mainRoot ? byRealPath.get(mainRoot) : undefined;
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
      ...(factsOf(row.path).isDirectory ? {} : { missing: true }),
      ...optionalTime(factsOf(row.path).lastSessionAt),
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
      ...(factsOf(row.path).isDirectory ? {} : { missing: true }),
      ...optionalTime(factsOf(row.path).lastSessionAt),
    };
    top.subProjects.push(sub);
  }
  return [...projects.values()];
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

  // Bounded work and bounded size whatever arrives: at most this many entries
  // are looked at, paths longer than BOARD_PATH_MAX_CHARS are dropped, and all
  // paths together stay within BOARD_LAYOUT_PATH_BUDGET characters. Drops are
  // counted and logged once per call, never once per entry.
  const scanMax = 2 * DEFAULTS.BOARD_PATHS_MAX;
  const drops: Record<string, number> = {};
  const drop = (reason: string) => { drops[reason] = (drops[reason] ?? 0) + 1; };
  let budget = DEFAULTS.BOARD_LAYOUT_PATH_BUDGET;
  const storablePath = (p: unknown): p is string =>
    isSafeAbsolutePath(p) && p.length <= DEFAULTS.BOARD_PATH_MAX_CHARS;

  const themes: BoardTheme[] = [];
  const ids = new Set<string>();
  const placed = new Set<string>();
  let pathCount = 0;
  if (obj.themes.length > 2 * DEFAULTS.BOARD_THEMES_MAX) drop('themes beyond those looked at');
  for (const entry of obj.themes.slice(0, 2 * DEFAULTS.BOARD_THEMES_MAX)) {
    if (themes.length >= DEFAULTS.BOARD_THEMES_MAX) {
      drop('themes over the maximum');
      break;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      drop('theme not an object');
      continue;
    }
    const t = entry as Record<string, unknown>;
    if (typeof t.id !== 'string' || !THEME_ID_PATTERN.test(t.id) || ids.has(t.id)) {
      drop('theme with a bad or duplicate id');
      continue;
    }
    if (typeof t.name !== 'string' || t.name.length > 1000) {
      drop('theme with a bad name');
      continue;
    }
    const name = cleanThemeName(t.name);
    if (!name) {
      drop('theme with an empty name');
      continue;
    }
    const tint = isBoardTint(t.tint) ? t.tint : 'none';
    const projects: string[] = [];
    const rawProjects = Array.isArray(t.projects) ? t.projects.slice(0, scanMax) : [];
    for (const p of rawProjects) {
      if (pathCount >= DEFAULTS.BOARD_PATHS_MAX) break;
      if (!storablePath(p) || placed.has(p)) continue;
      if (p.length > budget) {
        drop('paths over the size budget');
        continue;
      }
      budget -= p.length;
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
  let scanned = 0;
  for (const path in rawTiles) {
    if (!Object.prototype.hasOwnProperty.call(rawTiles, path)) continue;
    if (tileCount >= DEFAULTS.BOARD_PATHS_MAX || ++scanned > scanMax) break;
    const value = rawTiles[path];
    if (!storablePath(path) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const options: BoardTileOptions = {};
    if (v.wide === true) options.wide = true;
    if (typeof v.note === 'string') {
      const note = cleanNote(v.note);
      if (note) options.note = note;
    }
    if (!options.wide && !options.note) continue;
    if (path.length > budget) {
      drop('paths over the size budget');
      continue;
    }
    budget -= path.length;
    tiles[path] = options;
    tileCount++;
  }
  if (Object.keys(drops).length > 0) console.warn('[BOARD] Layout entries dropped', drops);
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
function writeAtomic(file: string, content: string | Buffer): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let mode: number | null = null;
  try {
    mode = statSync(file).mode & 0o777;
  } catch { /* new file */ }
  try {
    writeFileSync(tmp, content);
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

/** Validate and store a layout. Returns what was stored, or null when the
 *  payload wasn't a layout. Throws if the file can't be written.
 *  `unseenAdds`: projects added after the saving board last read the list;
 *  each keeps the theme the stored layout gives it when this layout places it
 *  nowhere (that board could not have meant to unsort a tile it never had). */
export function saveLayout(userDataDir: string, raw: unknown, unseenAdds: readonly string[] = []): BoardLayout | null {
  const layout = validateLayout(raw);
  if (!layout) {
    console.warn('[BOARD] Layout refused', { reason: 'not a layout' });
    return null;
  }
  // A corrupt file is set aside before this save replaces it.
  const previous = readLayout(userDataDir);
  if (unseenAdds.length > 0) {
    const kept = keepPlacements(layout, previous, unseenAdds);
    if (kept > 0) console.info('[BOARD] Kept placements of projects the saving board had not seen', { kept });
  }
  writeAtomic(layoutPath(userDataDir), JSON.stringify(layout, null, 2) + '\n');
  const placed = layout.themes.reduce((n, t) => n + t.projects.length, 0);
  console.info('[BOARD] Layout saved', { themes: layout.themes.length, placed });
  return layout;
}

/**
 * The projects + Project added while the app runs, numbered. A board's payload
 * carries the number it was read at and its layout saves send it back, so a
 * save from a board that hadn't seen an add can't drop the new tile's theme.
 */
export class AdditionLog {
  private static readonly KEEP = 500;
  private entries: { generation: number; path: string }[] = [];
  private current = 0;

  get generation(): number {
    return this.current;
  }

  record(path: string): number {
    this.current++;
    this.entries.push({ generation: this.current, path });
    if (this.entries.length > AdditionLog.KEEP) this.entries.shift();
    return this.current;
  }

  /** Paths added after `seen` (anything not a whole number counts as 0). */
  addedSince(seen: unknown): string[] {
    const from = typeof seen === 'number' && Number.isInteger(seen) && seen >= 0 ? seen : 0;
    return this.entries.filter((e) => e.generation > from).map((e) => e.path);
  }
}

// ── The whole board ──

export interface BoardSources {
  /** The `projectListFile` setting (empty = the default). */
  listSetting: unknown;
  userDataDir: string;
  home?: string;
}

export async function loadBoard(sources: BoardSources, additions?: AdditionLog): Promise<BoardPayload> {
  const home = sources.home ?? homedir();
  const listFile = resolveListFile(sources.listSetting, home);
  // The add count is taken before the list is read and the layout after the
  // last await, so a payload never claims an add its list may lack, nor holds
  // a layout older than a save that landed while it loaded.
  const generation = additions?.generation;
  const withGeneration = generation === undefined ? {} : { generation };
  const shownFile = listFile ? tildePath(listFile, home) : String(sources.listSetting ?? '');
  const notFound = (): BoardPayload => ({
    listFile: shownFile, listFound: false, listTable: false, projects: [], layout: readLayout(sources.userDataDir), ...withGeneration,
  });
  if (!listFile) {
    console.info('[BOARD] Loaded', { listFound: false });
    return notFound();
  }
  let text: string;
  try {
    const info = await stat(listFile);
    if (!info.isFile()) {
      console.info('[BOARD] Loaded', { listFound: false });
      return notFound();
    }
    if (info.size > DEFAULTS.BOARD_LIST_MAX_BYTES) {
      console.warn('[BOARD] Project list too large to read', { bytes: info.size });
      return notFound();
    }
    text = await readFile(listFile, 'utf8');
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    if (missing) console.info('[BOARD] Loaded', { listFound: false });
    else console.warn('[BOARD] Project list unreadable', { err: String(err) });
    return notFound();
  }
  const rows = usableRows(parseProjectList(text, home));
  const projects = nestProjects(rows, await gatherRowFacts(rows, home));
  const layout = readLayout(sources.userDataDir);
  const listTable = hasListTable(text);
  const subs = projects.reduce((n, p) => n + p.subProjects.length, 0);
  console.info('[BOARD] Loaded', {
    listFound: true, listTable, projects: projects.length, subProjects: subs,
    missing: projects.filter((p) => p.missing).length, themes: layout.themes.length,
  });
  return { listFile: shownFile, listFound: true, listTable, projects, layout, ...withGeneration };
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

/** The header row of a project table: the line the launcher's reader skips
 *  for holding "Project" and later "Path". */
const LIST_HEADER = /Project.*Path/;
/** A Markdown table's separator row: cells of dashes, colons allowed. */
const TABLE_SEPARATOR = /^\s*\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** What + Project says when the file has no project table. */
const NO_LIST_TABLE = 'the file has no project table to add to: a Markdown table whose header row names "Project" '
  + 'and then "Path" (as | Project | Path |), with its separator row (|---|---|) under it';

/**
 * The index of the last line of the file's project table, or -1 when it has
 * none. A project table is a Markdown table outside code fences whose header
 * row names "Project" and then "Path" (the launcher's own convention: its
 * reader skips that line as the header), with its separator row right under
 * it; it runs on over the table lines that follow. The first such table
 * counts. Only terminated lines count, since the launcher never reads a last
 * line without a newline: it stays last.
 */
function listTableEnd(lines: readonly string[]): number {
  const isTableLine = (line: string) => line.trimStart().startsWith('|');
  // lines[unterminated] is the text after the last newline ('' when the text ends with one).
  const unterminated = lines.length - 1;
  let inFence = false;
  for (let i = 0; i + 1 < unterminated; i++) {
    const start = lines[i].trimStart();
    if (start.startsWith('```') || start.startsWith('~~~')) inFence = !inFence;
    if (inFence) continue;
    if (!isTableLine(lines[i]) || !LIST_HEADER.test(lines[i]) || !TABLE_SEPARATOR.test(lines[i + 1])) continue;
    let last = i + 1;
    while (last + 1 < unterminated && isTableLine(lines[last + 1])) last++;
    return last;
  }
  return -1;
}

/** Whether the text holds a project table + Project can add a row to. */
export function hasListTable(text: string): boolean {
  return listTableEnd(text.split('\n')) !== -1;
}

/**
 * Insert a row directly after the last row of the project table (directly
 * after its separator when it has no rows yet), leaving every other byte as
 * it was; the file can carry notes and other tables. The row ends with the
 * line ending of the table line it follows. Returns null when the file has no
 * project table: + Project adds there, never anywhere else.
 */
export function insertListRow(text: string, row: string): string | null {
  const lines = text.split('\n');
  const last = listTableEnd(lines);
  if (last === -1) return null;
  const eol = lines[last].endsWith('\r') ? '\r\n' : '\n';
  // Offset just past the table's last line and its newline.
  let offset = 0;
  for (let i = 0; i <= last; i++) offset += lines[i].length + 1;
  return text.slice(0, offset) + row + eol + text.slice(offset);
}

/** The extensions a project list file may have. */
const LIST_EXTENSIONS = ['.md', '.markdown', '.txt'];

type ListFileRead =
  | { ok: true; target: string; bytes: Buffer; text: string }
  | { ok: false; reason: string };

/**
 * Read the list file for writing, refusing anything that isn't plainly a
 * project list: the setting's file (through a symlink, its real file) must be
 * a regular .md/.markdown/.txt file of at most BOARD_LIST_MAX_BYTES holding
 * valid UTF-8 text. The bytes are kept so the write can be checked against
 * them. Opened without following a link and without blocking (a FIFO swapped
 * in after the realpath can't hang main), then checked through the open file.
 */
export function readListForWrite(listFile: string): ListFileRead {
  let target: string;
  try {
    target = realpathSync(listFile);
  } catch {
    return { ok: false, reason: 'the project list file was not found' };
  }
  if (!LIST_EXTENSIONS.includes(extname(target).toLowerCase())) {
    return { ok: false, reason: 'the project list file is not a .md, .markdown or .txt file, so it is left alone' };
  }
  let fd: number;
  try {
    fd = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return { ok: false, reason: 'the project list file could not be read' };
  }
  let bytes: Buffer;
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { ok: false, reason: 'the project list file is not a regular file' };
    const maxMb = DEFAULTS.BOARD_LIST_MAX_BYTES / (1024 * 1024);
    if (info.size > DEFAULTS.BOARD_LIST_MAX_BYTES) return { ok: false, reason: `the project list file is larger than ${maxMb} MB` };
    bytes = readFileSync(fd);
    if (bytes.length > DEFAULTS.BOARD_LIST_MAX_BYTES) return { ok: false, reason: `the project list file is larger than ${maxMb} MB` };
  } catch {
    return { ok: false, reason: 'the project list file could not be read' };
  } finally {
    closeSync(fd);
  }
  let text: string;
  try {
    // ignoreBOM keeps a byte-order mark in the text, so it is written back.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'the project list file is not UTF-8 text, so it is left alone' };
  }
  if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes)) {
    return { ok: false, reason: 'the project list file is not UTF-8 text, so it is left alone' };
  }
  return { ok: true, target, bytes, text };
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

/** Why a row the board built would not be read back as written. */
const ROW_UNREADABLE = 'the list reader would skip this row (it skips any row holding "Project" and later "Path", '
  + 'in the name or the folder\'s path); choose another name or folder';

/** Add a project to the list file and place it in a theme. Returns the fresh
 *  board, with `error` set when the request was refused, and `added` (the
 *  folder) when a row was written; the add is recorded in `additions`. */
export async function addProject(
  sources: BoardSources, raw: unknown, additions?: AdditionLog,
): Promise<BoardPayload & { added?: string }> {
  const home = sources.home ?? homedir();
  const refuse = async (reason: string): Promise<BoardPayload> => {
    console.warn('[BOARD] Add refused', { reason });
    return { ...(await loadBoard(sources, additions)), error: reason };
  };
  const listFile = resolveListFile(sources.listSetting, home);
  if (!listFile) return refuse('the project list file setting is not a usable path');
  const read = readListForWrite(listFile);
  if (read.ok === false) return refuse(read.reason);
  const { target, bytes, text } = read;
  if (!hasListTable(text)) return refuse(NO_LIST_TABLE);
  const rows = parseProjectList(text, home);
  const listed = rows.filter((r) => isSafeAbsolutePath(r.path)).map((r) => resolve(r.path));
  const check = checkAddRequest(raw, listed);
  if (check.ok === false) return refuse(check.reason);

  const linkForm = text.includes('](file://');
  const row = formatListRow(check.name, check.path, linkForm, home);
  // "Added" only for a row the launcher (and so the board) reads back as written.
  const readBack = parseProjectList(row + '\n', home);
  if (readBack.length !== 1 || readBack[0].name !== check.name || readBack[0].path !== check.path) {
    return refuse(ROW_UNREADABLE);
  }
  const next = insertListRow(text, row);
  if (next === null) return refuse(NO_LIST_TABLE);
  const out = Buffer.from(next, 'utf8');
  try {
    writeAtomic(target, out);
  } catch (err) {
    console.warn('[BOARD] Add failed', { err: String(err) });
    return refuse('the project list file could not be written');
  }
  // Recorded before anything awaits, so no layout save can slip in between
  // the write and the record and drop the new tile's theme.
  additions?.record(check.path);

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
  console.info('[BOARD] Project added', {
    themed: Boolean(themeId), form: linkForm ? 'link' : 'plain', bytesBefore: bytes.length, bytesAfter: out.length,
  });
  return { ...(await loadBoard(sources, additions)), added: check.path };
}
