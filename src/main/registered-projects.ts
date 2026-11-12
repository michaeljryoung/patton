import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULTS } from '../shared/constants';
import { isSafeAbsolutePath } from './projects';
import { parseProjectList, resolveListFile } from './project-board';

/**
 * The folders the project list names (the file the board reads, ~/.claude/projects.md
 * by default), for `resolveProject` to tell a registered sub-project from the
 * git repo that contains it.
 *
 * Each row is kept as `{ path, real }`: the path as the list writes it and its
 * real path (symlinks resolved, and on this case-insensitive volume the case
 * the disk holds, so a row typed in another case still matches). The real
 * paths are resolved once, when the list is (re)parsed, so a lookup is string
 * comparison only: no stat per row per call, which a row on a stalled volume
 * would otherwise turn into a freeze of the main process. A row whose folder
 * does not exist when the list is parsed is dropped, and is picked up when the
 * list file next changes.
 *
 * Parsed by the board's own `parseProjectList`, so the launcher, the board and
 * this agree on what a row is. The parse is cached under the list file's path,
 * size, mtime, ctime and inode (ctime and inode catch a copy that kept the
 * mtime, or a rename-replace) and the home folder. A missing, unreadable,
 * oversize or non-file list gives [] (no registered projects: git decides, as
 * before), logged once per file and reason.
 *
 * The `projectListFile` setting is held here, set by the IPC layer when it
 * registers and whenever that setting is saved, so a lookup never reads the
 * (encrypted) settings store.
 */
export interface RegisteredProject {
  path: string;
  real: string;
}

interface Cache {
  file: string;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  size: number;
  home: string;
  projects: readonly RegisteredProject[];
}

let cache: Cache | null = null;
let listSetting: unknown = '';
const loggedProblems = new Set<string>();

/** Set the `projectListFile` setting the lookups read the list by. */
export function setProjectListSetting(value: unknown): void {
  listSetting = value;
}

/** A list row as a registered project: a safe absolute path to a folder that
 *  exists, with its real path; null otherwise. */
export function toRegisteredProject(raw: string): RegisteredProject | null {
  if (!isSafeAbsolutePath(raw)) return null;
  const path = resolve(raw);
  try {
    return { path, real: realpathSync.native(path) };
  } catch {
    return null;
  }
}

function logOnce(file: string, reason: string, extra?: Record<string, unknown>): void {
  const key = `${file}\0${reason}`;
  if (loggedProblems.has(key) || loggedProblems.size >= 50) return;
  loggedProblems.add(key);
  console.warn('[PROJECTS] Registered project list gives no projects', { file, reason, ...extra });
}

export function registeredProjects(home: string = homedir()): readonly RegisteredProject[] {
  const file = resolveListFile(listSetting, home);
  if (!file) {
    logOnce(String(listSetting), 'setting is not a usable path');
    return [];
  }
  try {
    const info = statSync(file);
    if (!info.isFile()) {
      logOnce(file, 'not a file');
      return [];
    }
    if (info.size > DEFAULTS.BOARD_LIST_MAX_BYTES) {
      logOnce(file, 'too large', { bytes: info.size });
      return [];
    }
    if (
      cache && cache.file === file && cache.home === home && cache.size === info.size && cache.mtimeMs === info.mtimeMs
      && cache.ctimeMs === info.ctimeMs && cache.ino === info.ino
    ) {
      return cache.projects;
    }
    const projects: RegisteredProject[] = [];
    for (const row of parseProjectList(readFileSync(file, 'utf8'), home)) {
      const project = toRegisteredProject(row.path);
      if (project) projects.push(project);
    }
    cache = { file, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, size: info.size, home, projects };
    if (projects.length === 0) logOnce(file, 'no usable rows');
    return projects;
  } catch (err) {
    logOnce(file, 'unreadable', { err: String(err) });
    return [];
  }
}
