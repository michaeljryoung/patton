import { ProjectBoard, type ProjectBoardHost } from '../components/project-board';
import type { Tab } from '../components/tab';
import type { AppSettings, BoardPayload } from '../../shared/types';
import { openProject, type OpenProjectHost } from './open-project';
import { projectLiveState, type LiveStateSnapshot, type ProjectLiveState } from './project-live-state';
import { rlog } from './renderer-logger';
import type { TabManager } from './tab-manager';

/** Whether a new tab the user opened gets the project board, and why not. */
export type BoardDecision = { show: true; payload: BoardPayload } | { show: false; reason: string };

/**
 * The board shows while the setting is on (absent in older settings: on) and
 * the project list file was found. Pure, so the rule is checked on its own.
 */
export function decideBoard(settings: Pick<AppSettings, 'projectBoard'> | null, payload: BoardPayload | null): BoardDecision {
  if (!settings) return { show: false, reason: 'settings unavailable' };
  if (settings.projectBoard === false) return { show: false, reason: 'setting off' };
  if (!payload) return { show: false, reason: 'board unavailable' };
  if (!payload.listFound) return { show: false, reason: 'list file not found' };
  return { show: true, payload };
}

/** The tab manager calls the board's tab-change refresh at most this often. */
const REFRESH_DELAY_MS = 50;

interface MountedBoard {
  board: ProjectBoard;
  payload: BoardPayload;
}

/**
 * Puts the project board over new tabs the user opens (⌘T, the palette's New
 * Tab, the tab bar's +) and nowhere else: restored, reopened, bookmark, split
 * and launch tabs never come through TabManager.userNewTab(). A tile opens its
 * project the way a bookmark click does (open-project.ts), then the board's tab
 * goes; "Plain terminal" just lifts the board off its tab.
 */
export class ProjectBoards {
  private boards = new Map<Tab, MountedBoard>();
  private disposables: (() => void)[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // One live-state snapshot per refresh, shared by every tile asking for one.
  private snapshot: LiveStateSnapshot | null = null;

  constructor(
    private readonly tabs: TabManager,
    private readonly projectHost: OpenProjectHost,
  ) {
    tabs.setUserNewTabHandler(() => this.openNewTab());
    this.disposables.push(
      () => tabs.setUserNewTabHandler(null),
      tabs.onTabClosed((tab) => this.forget(tab, 'tab closed')),
      window.patton.board.onChanged((layout) => {
        for (const mounted of this.boards.values()) {
          mounted.payload = { ...mounted.payload, layout };
          mounted.board.setLayout(layout);
        }
      }),
    );
  }

  /** A new tab the user asked for, with the board over it when it applies.
   *  The settings and the board are read while the tab's shell starts. */
  async openNewTab(): Promise<Tab> {
    const decision = this.loadDecision();
    const tab = await this.tabs.createTab();
    const decided = await decision;
    if (decided.show === false) {
      rlog('info', '[BOARD] skipped', { tabId: tab.id, reason: decided.reason });
      return tab;
    }
    if (!this.tabs.getTabs().includes(tab)) {
      rlog('info', '[BOARD] skipped', { tabId: tab.id, reason: 'tab closed before the board loaded' });
      return tab;
    }
    this.mount(tab, decided.payload);
    return tab;
  }

  /** Whether the tab is showing a board. */
  hasBoard(tab: Tab): boolean {
    return this.boards.has(tab);
  }

  /** Tabs changed (opened, closed, activated, a session's state): refresh the
   *  tiles' live state, coalesced. */
  scheduleRefresh(): void {
    if (this.boards.size === 0 || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.snapshot = null;
      for (const mounted of this.boards.values()) mounted.board.refreshLiveState();
    }, REFRESH_DELAY_MS);
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const d of this.disposables) d();
    this.disposables = [];
    for (const tab of [...this.boards.keys()]) this.forget(tab, 'window closing');
  }

  private async loadDecision(): Promise<BoardDecision> {
    try {
      const settings = await window.patton.settings.get();
      if (settings.projectBoard === false) return decideBoard(settings, null);
      const payload = await window.patton.board.get();
      return decideBoard(settings, payload);
    } catch (err) {
      rlog('warn', '[BOARD] could not load the board', { error: String(err) });
      return { show: false, reason: 'load failed' };
    }
  }

  private mount(tab: Tab, payload: BoardPayload): void {
    const host: ProjectBoardHost = {
      openProject: (path) => {
        this.openFromBoard(tab, path).catch((err) => {
          rlog('error', '[BOARD] open failed', { tabId: tab.id, error: String(err) });
        });
      },
      dismiss: () => {
        if (this.forget(tab, 'plain terminal')) tab.setCover(null);
      },
      liveState: (path) => this.liveState(path),
    };
    const board = new ProjectBoard(host, payload);
    this.boards.set(tab, { board, payload });
    tab.setCover({ element: board.element, focus: () => board.focus() });
    rlog('info', '[BOARD] shown', {
      tabId: tab.id,
      projects: payload.projects.length,
      themes: payload.layout.themes.length,
    });
  }

  /** Take a tab's board away and dispose it. False if it had none. */
  private forget(tab: Tab, reason: string): boolean {
    const mounted = this.boards.get(tab);
    if (!mounted) return false;
    this.boards.delete(tab);
    mounted.board.dispose();
    rlog('info', '[BOARD] removed', { tabId: tab.id, reason });
    return true;
  }

  private async openFromBoard(boardTab: Tab, path: string): Promise<void> {
    const mounted = this.boards.get(boardTab);
    if (!mounted) return;
    const label = projectLabel(mounted.payload, path);
    rlog('info', '[BOARD] open', { tabId: boardTab.id, label });
    const result = await openProject(this.projectHost, path, '[BOARD]', label);
    rlog('info', '[BOARD] opened', { tabId: boardTab.id, label, action: result.action, toTabId: result.tab?.id ?? null });

    // Another click's tab is still on its way: keep the board until it lands.
    if (!result.tab) return;
    if (!this.boards.has(boardTab)) return; // closed or dismissed meanwhile
    if (result.tab === boardTab) {
      // The board's own shell already sits in that folder: just lift the board.
      this.forget(boardTab, 'project is this tab');
      boardTab.setCover(null);
      return;
    }
    const placeTabId = result.action === 'new tab' ? result.tab.id : undefined;
    // forget() first, so the tab-closed listener has nothing left to do.
    this.forget(boardTab, 'project opened');
    const discarded = this.tabs.discardTab(boardTab.id, placeTabId);
    rlog('info', '[BOARD] discard', { tabId: boardTab.id, discarded, placedTabId: placeTabId ?? null });
    if (!discarded) boardTab.setCover(null);
  }

  private liveState(path: string): ProjectLiveState {
    if (!this.snapshot) {
      // Board tabs are only shells at home under a board: they show no project.
      const tabs = this.tabs.getTabs().filter((t) => !this.boards.has(t));
      const active = this.tabs.getActiveTab();
      this.snapshot = {
        tabs,
        active: active && !this.boards.has(active) ? active : null,
        sessions: this.tabs.listSessions().filter((s) => tabs.some((t) => t.id === s.tabId)),
      };
      // Good for this burst of tile reads only.
      queueMicrotask(() => { this.snapshot = null; });
    }
    return projectLiveState(this.snapshot, path);
  }
}

/** The name the list gives a path (a project or a sub-project), for the logs. */
function projectLabel(payload: BoardPayload, path: string): string {
  for (const project of payload.projects) {
    if (project.path === path) return project.name;
    const sub = project.subProjects.find((s) => s.path === path);
    if (sub) return sub.name;
  }
  return path.split('/').filter(Boolean).pop() ?? path;
}
