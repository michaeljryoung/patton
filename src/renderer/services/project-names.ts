import type { ProjectInfo } from '../../shared/types';
import { rlog } from './renderer-logger';
import { formatProjectTitle } from './sessions';
import { shortTabName } from './tab-name';

/**
 * The names the user has given projects (right-click a tab → Set Default Tab Name for Project…),
 * keyed by project root, or by a linked worktree's own folder when the name was
 * set from a tab in that worktree. The main process owns the store and broadcasts every
 * change to all windows, so this copy stays current without re-fetching.
 */
let names = new Map<string, string>();
const listeners = new Set<() => void>();
let started: Promise<void> | null = null;

/** Load the names once and follow every later change. Safe to call repeatedly. */
export function startProjectNames(): Promise<void> {
  if (!started) {
    let heardChange = false;
    window.patton.projects.onNamesChanged((next) => {
      heardChange = true;
      names = new Map(Object.entries(next));
      notify();
    });
    started = window.patton.projects.getNames()
      .then((initial) => {
        // A rename broadcast that beat the initial load is newer — keep it.
        if (heardChange) return;
        names = new Map(Object.entries(initial));
        notify();
      })
      .catch((err) => rlog('warn', '[PROJECTS] Could not load project names', err));
  }
  return started;
}

/** The name the user gave this linked worktree itself, if any. */
function worktreeOwnName(project: ProjectInfo): string | undefined {
  return project.worktree ? names.get(project.worktree.path) : undefined;
}

/**
 * How a project is shown: the name, and the linked worktree to append to it.
 * THE one place the rule lives (tab title, palette, hover card, bookmark label,
 * rename box all go through it): a worktree with a name of its own shows that
 * name alone; any other worktree shows its parent's name plus "⎇ folder".
 */
export function projectDisplay(project: ProjectInfo): { name: string; worktree: { name: string; path: string } | null } {
  const own = worktreeOwnName(project);
  if (own !== undefined) return { name: own, worktree: null };
  return { name: projectRootName(project), worktree: project.worktree ?? null };
}

/** What a project's tabs are called: the user's name for it, else the automatic one
 *  (a worktree's own name, else its parent's; no "⎇ folder": see `projectTitle`). */
export function projectName(project: ProjectInfo): string {
  return projectDisplay(project).name;
}

/** The name of a project's root (the main repo, for a linked worktree): the
 *  user's name for the root, else its automatic one. Ignores any name the
 *  worktree has of its own: use it where the thing named is the root itself
 *  (a bookmark points at the root, so it is labelled with the root's name). */
export function projectRootName(project: ProjectInfo): string {
  return names.get(project.root) ?? project.defaultName;
}

/** A project's tab title: its name, plus the worktree for a linked worktree
 *  without a name of its own ("patton ⎇ feat-x"). */
export function projectTitle(project: ProjectInfo): string {
  const shown = projectDisplay(project);
  return formatProjectTitle(shown.name, shown.worktree);
}

/** The last folder of a path, either separator, trailing ones ignored. */
function folderName(path: string): string {
  return path.split(/[\\/]+/u).filter(Boolean).pop() ?? '';
}

/**
 * The short name of a linked worktree's folder: the folder's name with the
 * parent repo folder's name and one following separator ("-", "_", "." or a
 * space) taken off the front, compared case-insensitively ("next-venture-lifesci"
 * under "next-venture" is "lifesci"). A folder that doesn't start that way, or
 * that would be left with nothing, keeps its whole name.
 */
export function worktreeShortName(worktreeFolder: string, parentFolder: string): string {
  const prefix = parentFolder.toLowerCase();
  if (prefix && worktreeFolder.toLowerCase().startsWith(prefix)) {
    const rest = worktreeFolder.slice(prefix.length);
    if (/^[-_. ]/u.test(rest) && rest.length > 1) return rest.slice(1);
  }
  return worktreeFolder;
}

/**
 * What the tab STRIP writes for a project's tab. A project and a worktree with
 * a name of its own show their title whole; a worktree without one shows only
 * its short folder name (`worktreeShortName`), cut like a program's title
 * (`shortTabName`, 15 characters). The full "parent ⎇ folder" stays `projectTitle`,
 * for the tooltip, the screen-reader label, the hover card, the dialogs and the palette.
 */
export function projectStripTitle(project: ProjectInfo): string {
  if (!project.worktree || worktreeOwnName(project) !== undefined) return projectTitle(project);
  return shortTabName(worktreeShortName(project.worktree.name, folderName(project.root)));
}

/** What the "Set Default Tab Name for Project…" box starts with and shows when
 *  empty. A worktree's box holds only its own name (empty if none) and
 *  placeholders the automatic title; a project's holds its current name. */
export function projectRenameFields(project: ProjectInfo): { name: string; defaultName: string } {
  if (!project.worktree) return { name: projectName(project), defaultName: project.defaultName };
  const automatic = formatProjectTitle(projectRootName(project), project.worktree);
  return { name: worktreeOwnName(project) ?? '', defaultName: automatic };
}

/** The key a rename of this project's tabs is filed under: the worktree's own
 *  folder in a linked worktree, else the project root. */
export function projectNameKey(project: ProjectInfo): string {
  return project.worktree?.path ?? project.root;
}

/** Run `callback` whenever any project's name changes. Returns an unsubscribe function. */
export function onProjectNamesChanged(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

function notify(): void {
  for (const callback of listeners) callback();
}
