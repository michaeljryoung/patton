import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DEFAULTS } from '../shared/constants';
import type { ProjectInfo } from '../shared/types';

/**
 * Which project a folder belongs to, so its tab can be named after it.
 *
 * A project is the nearest enclosing git repository; failing that, the
 * top-level folder under ~/Projects, so a project there that isn't a repo
 * still counts. The home folder itself is never a project, or a dotfiles repo
 * at ~ would give every tab the same name.
 */
export function resolveProject(cwd: string): ProjectInfo | null {
  const home = homedir();
  const start = resolve(cwd);

  // Walk up to (not including) home, or to the filesystem root for folders
  // outside home. `.git` is a directory in a normal repo and a file in a
  // worktree or submodule — existsSync catches both.
  let dir = start;
  while (dir !== home && dir !== dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return projectAt(dir);
    dir = dirname(dir);
  }

  const projectsDir = join(home, 'Projects');
  if (start.startsWith(projectsDir + sep)) {
    const root = join(projectsDir, start.slice(projectsDir.length + 1).split(sep)[0]);
    // A real folder only — this also gates which keys a name can be stored under.
    if (isDirectory(root)) return projectAt(root);
  }
  return null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** "fantasy-football" → "football": the last word of the folder name. */
export function defaultProjectName(root: string): string {
  const folder = basename(root);
  const words = folder.split(/[-_.\s]+/).filter(Boolean);
  return words[words.length - 1] || folder;
}

/** How a name the user typed is stored: one line, no control characters, capped. */
export function cleanProjectName(raw: string): string {
  return String(raw)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEFAULTS.PROJECT_NAME_MAX_CHARS);
}

/** Absolute, no NUL, no `..` segments, sane length — safe to walk or store.
 *  Same traversal rule as pty-manager's validateCwd. */
export function isSafeAbsolutePath(p: unknown): p is string {
  return typeof p === 'string'
    && p.startsWith('/')
    && p.length <= 4096
    && !p.includes('\0')
    && !/(?:^|\/)\.\.(?:\/|$)/.test(p);
}

function projectAt(root: string): ProjectInfo {
  return { root, defaultName: defaultProjectName(root) };
}
