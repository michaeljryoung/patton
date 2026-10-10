import type { ProjectInfo } from '../../shared/types';
import { rlog } from './renderer-logger';

/**
 * The names the user has given projects (right-click a tab → Rename Project…),
 * keyed by project root. The main process owns the store and broadcasts every
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

/** What a project's tabs are called: the user's name for it, else the automatic one. */
export function projectName(project: ProjectInfo): string {
  return names.get(project.root) ?? project.defaultName;
}

/** Run `callback` whenever any project's name changes. Returns an unsubscribe function. */
export function onProjectNamesChanged(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

function notify(): void {
  for (const callback of listeners) callback();
}
