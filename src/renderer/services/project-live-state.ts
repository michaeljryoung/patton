import type { Tab } from '../components/tab';
import { sessionMatchesPath, sessionNeedsYou, type SessionInfo } from './sessions';

/**
 * A project folder's live state in this window: whether a tab shows it, and
 * its open sessions (panes) by state. The bookmarks sidebar's rows and the
 * project board's tiles both read it, so the two never disagree.
 */
export interface ProjectLiveState {
  isOpen: boolean;
  /** The active tab shows this project. */
  isCurrent: boolean;
  /** Sessions (panes) in the project, and how many wait for you, are parked or work. */
  open: number;
  waiting: number;
  parked: number;
  working: number;
}

export const CLOSED_STATE: ProjectLiveState = { isOpen: false, isCurrent: false, open: 0, waiting: 0, parked: 0, working: 0 };

/** What the live state is read from: a snapshot of the window's tabs. */
export interface LiveStateSnapshot {
  tabs: readonly Tab[];
  active: Tab | null;
  sessions: SessionInfo[];
}

/** The tab shows this project, or has a pane (focused or not) in this folder. */
export function tabMatchesPath(tab: Tab, path: string): boolean {
  if (tab.project?.root === path) return true;
  return tab.panes.some((pane) => pane.getCwd() === path);
}

export function projectLiveState(snapshot: LiveStateSnapshot, path: string): ProjectLiveState {
  const mine = snapshot.sessions.filter((s) => sessionMatchesPath(s, path));
  const isOpen = mine.length > 0 || snapshot.tabs.some((t) => tabMatchesPath(t, path));
  const isCurrent = isOpen && !!snapshot.active && tabMatchesPath(snapshot.active, path);
  return {
    isOpen,
    isCurrent,
    open: mine.length,
    waiting: mine.filter((s) => sessionNeedsYou(s)).length,
    parked: mine.filter((s) => s.state === 'parked').length,
    working: mine.filter((s) => s.state === 'working').length,
  };
}
