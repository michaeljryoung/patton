import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { DEFAULTS } from '../shared/constants';
import { parseProjectList, resolveListFile } from './project-board';

/**
 * The folders the project list names (the file the board reads, ~/.claude/projects.md
 * by default), as absolute paths, for `resolveProject` to tell a registered
 * sub-project from the git repo that contains it.
 *
 * Parsed by the board's own `parseProjectList`, so the launcher, the board and
 * this agree on what a row is. The parse is cached and refreshed when the
 * file's path, size or mtime changes, so the many `resolveProject` calls a
 * window makes read the file once. A missing, unreadable, oversize or
 * non-file list gives [] (no registered projects: git decides, as before).
 */
let cache: { file: string; mtimeMs: number; size: number; home: string; paths: string[] } | null = null;

export function registeredProjectPaths(listSetting: unknown, home: string = homedir()): readonly string[] {
  const file = resolveListFile(listSetting, home);
  if (!file) return [];
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > DEFAULTS.BOARD_LIST_MAX_BYTES) return [];
    if (cache && cache.file === file && cache.mtimeMs === info.mtimeMs && cache.size === info.size && cache.home === home) {
      return cache.paths;
    }
    const paths = parseProjectList(readFileSync(file, 'utf8'), home).map((row) => row.path);
    cache = { file, mtimeMs: info.mtimeMs, size: info.size, home, paths };
    return paths;
  } catch {
    return [];
  }
}
