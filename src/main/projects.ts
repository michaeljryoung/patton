import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
 *
 * A linked git worktree (`git worktree add`, Claude Code's `.claude/worktrees/`)
 * belongs to its main repository, with `worktree` naming it, so its tab reads
 * "patton ⎇ feat-x" and the main project's bookmark finds it. A submodule stays
 * its own project.
 *
 * One exception to "nearest repo": a folder the project list registers lying
 * strictly inside that root (a sub-project such as personal-finances/em, which
 * is not a repo of its own) is its own project, so a session there is not an
 * open session of the parent. See `registeredSubProject`.
 */
export function resolveProject(cwd: string): ProjectInfo | null {
  const base = resolveByGit(cwd);
  if (!base || base.worktree) return base;
  return registeredSubProject(resolve(cwd), base) ?? base;
}

/** What a stored project name can be filed against: a real project root, or a
 *  linked worktree's own folder (a name set on a worktree's tab names that
 *  worktree, not its parent repository). */
export interface ProjectNameTarget {
  kind: 'root' | 'worktree';
  /** The key in the `projectNames` map: the root or the worktree's folder. */
  key: string;
  /** The automatic name a stored name equal to it falls back to; null for a
   *  worktree, whose automatic title is derived and has no name to match. */
  defaultName: string | null;
}

/** What `key` may be named as, or null when it is neither a project root nor a
 *  registered linked worktree's own folder (so an arbitrary path is refused). */
export function projectNameTarget(key: string): ProjectNameTarget | null {
  const project = resolveProject(key);
  if (!project) return null;
  if (project.worktree) {
    return project.worktree.path === key ? { kind: 'worktree', key, defaultName: null } : null;
  }
  return project.root === key ? { kind: 'root', key, defaultName: project.defaultName } : null;
}

/** Where the registered project folders come from (the project list, each with
 *  its real path resolved ahead of time: see registered-projects.ts), set once
 *  by the IPC layer; unset = none registered. */
let registeredSource: (() => readonly { path: string; real: string }[]) | null = null;
export function setRegisteredProjects(source: (() => readonly { path: string; real: string }[]) | null): void {
  registeredSource = source;
}

const MAX_LOGGED_OVERRIDES = 500;
const loggedOverrides = new Set<string>();
let warnedSourceFailure = false;
let warnedOverrideCap = false;

/**
 * The deepest registered project that equals or contains `start` and lies
 * strictly inside `base.root`, as a project; else null. Compared on real paths
 * (symlinks resolved, on-disk case), the project reported as the list writes it.
 * The registered rows' real paths are already resolved, so only the two paths
 * of this lookup are touched on disk. A registered folder that doesn't exist
 * is ignored.
 */
function registeredSubProject(start: string, base: ProjectInfo): ProjectInfo | null {
  if (!registeredSource) return null;
  let candidates: readonly { path: string; real: string }[];
  try {
    candidates = registeredSource();
  } catch (err) {
    if (!warnedSourceFailure) {
      warnedSourceFailure = true;
      console.warn('[PROJECTS] Registered project list unavailable (logged once)', { err: String(err) });
    }
    return null;
  }
  if (candidates.length === 0) return null;
  const realBase = realOrSelf(base.root);
  const realStart = realOrSelf(start);
  let best: { path: string; real: string } | null = null;
  for (const candidate of candidates) {
    const { real } = candidate;
    if (real === realBase || !isInside(real, realBase) || !isInside(realStart, real)) continue;
    if (!best || real.length > best.real.length) best = candidate;
  }
  if (!best) return null;
  if (!loggedOverrides.has(start)) {
    if (loggedOverrides.size < MAX_LOGGED_OVERRIDES) {
      loggedOverrides.add(start);
      console.info('[PROJECTS] Registered sub-project overrides the repo root', { cwd: start, repo: base.root, project: best.path });
    } else if (!warnedOverrideCap) {
      warnedOverrideCap = true;
      console.info('[PROJECTS] Override log cap reached; further overrides are not logged', { cap: MAX_LOGGED_OVERRIDES });
    }
  }
  return projectAt(best.path);
}

/** `child` is `parent` or lies inside it (both already resolved). */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Native realpath: it also returns the case the disk holds, which the plain
 *  one does not on this case-insensitive volume. */
function realPath(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/** The real path of `p`; when its tail doesn't exist (yet), the real path of
 *  the deepest folder that does, with the tail added back. */
function realOrSelf(p: string): string {
  let dir = p;
  let tail = '';
  while (dir !== dirname(dir)) {
    const real = realPath(dir);
    if (real) return tail ? join(real, tail) : real;
    tail = tail ? join(basename(dir), tail) : basename(dir);
    dir = dirname(dir);
  }
  return p;
}

function resolveByGit(cwd: string): ProjectInfo | null {
  const home = homedir();
  const start = resolve(cwd);

  // Walk up to (not including) home, or to the filesystem root for folders
  // outside home. `.git` is a directory in a normal repo and a file in a
  // worktree or submodule — existsSync catches both.
  let dir = start;
  while (dir !== home && dir !== dirname(dir)) {
    const marker = join(dir, '.git');
    if (existsSync(marker)) return linkedWorktreeProject(dir, marker) ?? projectAt(dir);
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

/**
 * The main repository's project, if `dir` is a linked worktree; else null.
 *
 * A linked worktree's `.git` is a file, `gitdir: <main>/.git/worktrees/<id>`,
 * and that private git dir holds `commondir`, the path of the shared `.git`.
 * A submodule's `.git` file points under `.git/modules/`, which has no
 * `commondir`, so it is left alone; so is a worktree of a bare repository,
 * which has no main folder to name. The registration must also point back
 * (`<id>/gitdir` names this folder's `.git` file), so a hand-made `.git` file
 * can't claim membership in a repository that never registered the folder.
 */
function linkedWorktreeProject(dir: string, marker: string): ProjectInfo | null {
  const gitdirLine = readSmallFile(marker)?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!gitdirLine) return null; // a normal repo: `.git` is a directory
  const gitdir = resolve(dir, gitdirLine);
  const common = readSmallFile(join(gitdir, 'commondir'))?.trim();
  if (!common) return null;
  const commonDir = resolve(gitdir, common);
  if (basename(commonDir) !== '.git' || dirname(gitdir) !== join(commonDir, 'worktrees')) return null;
  if (!registeredFor(gitdir, marker)) return null;
  const mainRoot = dirname(commonDir);
  if (mainRoot === dir || mainRoot === homedir() || !isSafeAbsolutePath(mainRoot) || !isDirectory(mainRoot)) return null;
  return { ...projectAt(mainRoot), worktree: { name: basename(dir), path: dir } };
}

/** The main repository folder of `dir` when `dir` is a registered linked git
 *  worktree (the same checks resolveProject makes), else null. The project
 *  board uses it to put a worktree inside its repository's tile. */
export function linkedWorktreeMainRoot(dir: string): string | null {
  return linkedWorktreeProject(dir, join(dir, '.git'))?.root ?? null;
}

/** Whether the worktree registration at `gitdir` names `marker` (this folder's
 *  `.git` file) as its own: `<gitdir>/gitdir` holds that path. */
function registeredFor(gitdir: string, marker: string): boolean {
  const backlink = readSmallFile(join(gitdir, 'gitdir'))?.trim();
  if (!backlink) return false;
  try {
    return realpathSync(resolve(gitdir, backlink)) === realpathSync(marker);
  } catch {
    return false;
  }
}

/** A git pointer file's text: a regular file of at most 4 KB, else undefined. */
function readSmallFile(p: string): string | undefined {
  try {
    const stat = statSync(p);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
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
