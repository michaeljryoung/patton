import type { Tab } from '../components/tab';
import { tabMatchesPath } from './project-live-state';
import { rlog } from './renderer-logger';
import { sessionMatchesPath, sessionNeedsYou, type SessionInfo } from './sessions';
import { runStartupCommand } from './startup-command';

/** What opening a project needs from the window's tabs. */
export interface OpenProjectHost {
  getTabs(): readonly Tab[];
  getActiveTab(): Tab | null;
  switchToTab(id: string): void;
  /** `forProject` tells the new tab's shell which project it was opened for
   *  (PATTON_PROJECT_DIR), so a launcher can open that project directly;
   *  `startupCommand` gives that shell FORCE_HYPERLINK=1 for Claude. */
  createTab(cwd: string, opts?: { forProject?: boolean; startupCommand?: boolean }): Promise<Tab>;
  /** Open sessions (every pane), waiting first, longest wait first. */
  listSessions(): SessionInfo[];
  /** Activate a tab and focus one of its panes; false if either has gone. */
  goToSession(tabId: string, paneId: string): boolean;
  /** Hand keyboard focus back to the active terminal pane. */
  focusTerminal(): void;
}

export type OpenProjectAction = 'went to waiting session' | 'went to existing session' | 'activated existing tab' | 'new tab' | 'already opening';

export interface OpenProjectResult {
  action: OpenProjectAction;
  /** The tab the project is now in (null while another click's tab is on the way). */
  tab: Tab | null;
}

// Paths whose tab is being created, so a double-click (or a click on the
// sidebar and the board at once) can't open two tabs.
const opening = new Set<string>();

/** The tab already showing this project — the active tab first, if it is one. */
export function findTabFor(host: Pick<OpenProjectHost, 'getTabs' | 'getActiveTab'>, path: string): Tab | null {
  const active = host.getActiveTab();
  if (active && tabMatchesPath(active, path)) return active;
  return host.getTabs().find((t) => tabMatchesPath(t, path)) ?? null;
}

/**
 * Open a project folder the way a bookmark click always has: a session of it
 * that waits for you first (the longest wait), else any session of it, else a
 * tab showing it, else a new tab there (opened `forProject`, with the startup
 * command typed in). Throws if the new tab can't be created.
 */
export async function openProject(host: OpenProjectHost, path: string, logTag: string, label: string): Promise<OpenProjectResult> {
  const sessions = host.listSessions();
  const waiting = sessions.find((s) => sessionNeedsYou(s) && sessionMatchesPath(s, path));
  if (waiting && host.goToSession(waiting.tabId, waiting.paneId)) {
    rlog('info', `${logTag} open waiting`, {
      label, tabId: waiting.tabId, paneId: waiting.paneId,
      waitedMs: waiting.awaitingSince ? Date.now() - waiting.awaitingSince : null,
    });
    host.focusTerminal();
    return { action: 'went to waiting session', tab: host.getTabs().find((t) => t.id === waiting.tabId) ?? null };
  }

  // Live state counts sessions per pane, so a click goes to one of those
  // before anything else (the first is the best-ranked: listSessions order).
  const session = sessions.find((s) => sessionMatchesPath(s, path));
  if (session && host.goToSession(session.tabId, session.paneId)) {
    host.focusTerminal();
    return { action: 'went to existing session', tab: host.getTabs().find((t) => t.id === session.tabId) ?? null };
  }

  const existing = findTabFor(host, path);
  if (existing) {
    host.switchToTab(existing.id);
    host.focusTerminal();
    return { action: 'activated existing tab', tab: existing };
  }
  if (opening.has(path)) return { action: 'already opening', tab: null };

  opening.add(path);
  try {
    const settings = await window.patton.settings.get();
    const tab = await host.createTab(path, { forProject: true, startupCommand: Boolean(settings.startupCommand) });
    if (settings.startupCommand) runStartupCommand(tab, settings.startupCommand);
    host.focusTerminal();
    return { action: 'new tab', tab };
  } finally {
    opening.delete(path);
  }
}
