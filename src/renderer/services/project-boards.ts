import { ProjectBoard, type ProjectBoardHost } from '../components/project-board';
import type { Tab } from '../components/tab';
import type { AppSettings, BoardPayload } from '../../shared/types';
import { announce } from './announcer';
import { findWakePane, wakeCommandOf } from './board-wake';
import { openProject, type OpenProjectHost } from './open-project';
import { projectLiveState, type LiveStateSnapshot, type ProjectLiveState } from './project-live-state';
import { rlog } from './renderer-logger';
import { PROMPT_FALLBACK_MS, runStartupCommand, typeWhenShellReady, type PendingSend } from './startup-command';
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

/** How long launch waits for the board before sending the startup command
 *  instead (the startup command's own prompt fallback). */
const LAUNCH_BOARD_TIMEOUT_MS = PROMPT_FALLBACK_MS;

/** The tab manager calls the board's tab-change refresh at most this often. */
const REFRESH_DELAY_MS = 50;

/**
 * What the Claude button types: plain `claude`, whatever the startup command
 * is. FORCE_HYPERLINK=1 is what the startup-command pane gets in its
 * environment (pty-manager.ts) so that Claude prints OSC 8 links; a board tab
 * is created before anyone knows it will run Claude, and exporting it into
 * every ⌘T shell is what SECURITY.md rules out, so it is set for this one
 * command only.
 */
export const PLAIN_CLAUDE_COMMAND = 'FORCE_HYPERLINK=1 claude';

/** Shells where `VAR=1 cmd` is not valid syntax (csh family). `env VAR=1` would
 *  work there but skips shell aliases, and `claude` is an alias for some users. */
const NO_INLINE_ENV_SHELLS = new Set(['csh', 'tcsh']);

/**
 * The line the Claude button types for a pane's shell (its path, '' when the
 * app named none, which counts as sh-family: Patton's default is zsh). csh and
 * tcsh get plain `claude`, without the hyperlink variable.
 */
export function claudeCommandFor(shellPath: string): { command: string; hyperlinks: boolean } {
  const name = shellPath.split('/').pop() ?? '';
  if (NO_INLINE_ENV_SHELLS.has(name)) return { command: 'claude', hyperlinks: false };
  return { command: PLAIN_CLAUDE_COMMAND, hyperlinks: true };
}

interface MountedBoard {
  board: ProjectBoard;
  payload: BoardPayload;
}

/**
 * Puts the project board over new tabs the user opens (⌘T, the palette's New
 * Tab, the tab bar's +) and over the tab Patton opens at launch
 * (startLaunchTab), and nowhere else: reopened, bookmark and split tabs never
 * come through TabManager.userNewTab(). A tile opens its
 * project the way a bookmark click does (open-project.ts), then the board's tab
 * goes; "Terminal" (or Esc) just lifts the board off its tab; "Wake" starts the
 * configured command in a new tab behind the board (see wake()); "Claude" lifts
 * the board and types `claude` into the tab's shell (see startClaude()).
 */
export class ProjectBoards {
  private boards = new Map<Tab, MountedBoard>();
  private disposables: (() => void)[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // One live-state snapshot per refresh, shared by every tile asking for one.
  private snapshot: LiveStateSnapshot | null = null;
  // The Wake button's command (Settings; '' hides it), read with the settings
  // each board load and updated live from the Settings panel.
  private wakeCommand = wakeCommandOf(null);
  // A Wake click is opening its tab: a second click waits for it.
  private wakeStarting = false;
  // Claude sends waiting for their tab's shell, cancelled when the tab closes.
  private claudePending = new Map<Tab, PendingSend>();

  constructor(
    private readonly tabs: TabManager,
    private readonly projectHost: OpenProjectHost,
  ) {
    tabs.setUserNewTabHandler(() => this.openNewTab());
    this.disposables.push(
      () => tabs.setUserNewTabHandler(null),
      tabs.onTabClosed((tab) => {
        this.claudePending.get(tab)?.cancel();
        this.claudePending.delete(tab);
        this.forget(tab, 'tab closed');
      }),
      window.patton.board.onChanged((layout) => {
        for (const mounted of this.boards.values()) {
          mounted.payload = { ...mounted.payload, layout };
          mounted.board.setLayout(layout);
        }
      }),
      // A project was added on some board: every board gets the new list.
      window.patton.board.onListChanged((payload) => {
        for (const mounted of this.boards.values()) {
          mounted.payload = payload;
          mounted.board.setPayload(payload);
        }
        rlog('info', '[BOARD] list changed', { boards: this.boards.size, projects: payload.projects.length });
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
    this.mount(tab, decided.payload, '[BOARD] shown');
    return tab;
  }

  /**
   * The tab Patton opens at launch (fresh, or the restored active tab, wherever
   * its shell starts) gets the board, as a new tab does, and no startup
   * command: "Terminal" or Esc leaves a plain shell, as on ⌘T. A board that is
   * off, unlisted, failing or slower than 1.5 s leaves the tab to the startup
   * command as before. Resolves whether the board was shown.
   */
  startLaunchTab(tab: Tab, startupCommand: string): Promise<boolean> {
    const covered = this.coverLaunchTab(tab);
    if (startupCommand) runStartupCommand(tab, startupCommand, covered.then((shown) => !shown));
    return covered;
  }

  private async coverLaunchTab(tab: Tab): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<BoardDecision>((resolve) => {
      timer = setTimeout(() => resolve({ show: false, reason: 'board too slow' }), LAUNCH_BOARD_TIMEOUT_MS);
    });
    const decided = await Promise.race([this.loadDecision(), timeout]);
    if (timer) clearTimeout(timer);
    if (decided.show === false) {
      rlog('info', '[BOARD] skipped at launch', { tabId: tab.id, reason: decided.reason });
      return false;
    }
    if (!this.tabs.getTabs().includes(tab)) {
      rlog('info', '[BOARD] skipped at launch', { tabId: tab.id, reason: 'tab closed before the board loaded' });
      return false;
    }
    this.mount(tab, decided.payload, '[BOARD] shown at launch');
    return true;
  }

  /** Whether the tab is showing a board. */
  hasBoard(tab: Tab): boolean {
    return this.boards.has(tab);
  }

  /** Settings → "Wake button command" changed: repaint every board's button. */
  setWakeCommand(command: string): void {
    const next = wakeCommandOf({ boardWakeCommand: command });
    if (next === this.wakeCommand) return;
    this.wakeCommand = next;
    rlog('info', '[BOARD] wake command changed', { shown: next !== '' });
    for (const mounted of this.boards.values()) mounted.board.refreshLiveState();
  }

  /** Tabs changed (opened, closed, activated, a session's state, a pane's
   *  title turning WAKE or back, via the tab's automatic flag): refresh the
   *  tiles' live state and the Wake button, coalesced. */
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
      this.wakeCommand = wakeCommandOf(settings);
      if (settings.projectBoard === false) return decideBoard(settings, null);
      const payload = await window.patton.board.get();
      return decideBoard(settings, payload);
    } catch (err) {
      rlog('warn', '[BOARD] could not load the board', { error: String(err) });
      return { show: false, reason: 'load failed' };
    }
  }

  private mount(tab: Tab, payload: BoardPayload, event = '[BOARD] shown'): void {
    const host: ProjectBoardHost = {
      // The board announces a failure, so the rejection goes back to it.
      openProject: (path) => this.openFromBoard(tab, path).catch((err: unknown) => {
        rlog('error', '[BOARD] open failed', { tabId: tab.id, error: String(err) });
        throw err;
      }),
      dismiss: () => {
        if (this.forget(tab, 'terminal')) tab.setCover(null);
      },
      liveState: (path) => this.liveState(path),
      wakeState: () => ({ command: this.wakeCommand, awake: findWakePane(this.tabs.getTabs()) !== null }),
      startClaude: () => this.startClaude(tab),
      wake: () => {
        this.wake(tab).catch((err: unknown) => rlog('error', '[BOARD] wake failed', { tabId: tab.id, error: String(err) }));
      },
    };
    const board = new ProjectBoard(host, payload);
    this.boards.set(tab, { board, payload });
    tab.setCover({ element: board.element, focus: () => board.focus() });
    rlog('info', event, {
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

  /**
   * The Claude button. Lifts the board exactly as "Terminal" does, then types
   * a plain `claude` into this tab's shell (never the startup command, which is
   * a project picker for some users): the folder is wherever the shell is, home
   * for a new tab. The board is gone after the first click, so a second click
   * (or a double click) finds nothing to do. A shell that has shown its first
   * prompt gets the command at once; one still loading, at its first prompt
   * (typeWhenShellReady), and keys typed meanwhile cancel the send rather than
   * get glued onto `claude`.
   */
  private startClaude(tab: Tab): void {
    rlog('info', '[BOARD] claude clicked', { tabId: tab.id });
    if (!this.forget(tab, 'claude')) {
      rlog('info', '[BOARD] claude ignored', { tabId: tab.id, reason: 'board already gone' });
      return;
    }
    tab.setCover(null);
    const shellPath = tab.focusedPane.shellPath;
    const { command, hyperlinks } = claudeCommandFor(shellPath);
    if (!hyperlinks) {
      rlog('info', '[BOARD] claude typed without FORCE_HYPERLINK=1', { tabId: tab.id, shell: shellPath, reason: 'csh-family shell cannot set a variable inline' });
    }
    // onDone can run before typeWhenShellReady returns (a shell already at its prompt).
    let over = false;
    const pending = typeWhenShellReady(tab, command, {
      label: 'Plain claude',
      // The send is over however it ended (sent, typed over, pane or tab closed).
      onDone: () => {
        over = true;
        this.claudePending.delete(tab);
      },
      onTyped: () => {
        announce('Claude not started: you typed first', 'assertive');
      },
    });
    if (!pending) {
      rlog('warn', '[BOARD] claude not started', { tabId: tab.id, reason: 'no terminal in this tab' });
      announce('Claude could not start: this tab has no terminal', 'assertive');
      return;
    }
    if (!over) this.claudePending.set(tab, pending);
    rlog('info', '[BOARD] claude started', { tabId: tab.id });
    announce('Starting Claude', 'polite');
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

  /**
   * The Wake button. While a pane is titled WAKE, go to it (Ctrl+C there stops
   * it). Otherwise open a new tab at home (never a board, no project), type the
   * command once its prompt shows, and hand the window straight back to the
   * board's tab, so picking a project carries on. createTab adds the tab at the
   * end of the strip.
   */
  private async wake(boardTab: Tab): Promise<void> {
    const running = findWakePane(this.tabs.getTabs());
    if (running) {
      this.tabs.goToSession(running.tab.id, running.pane.id);
      rlog('info', '[BOARD] wake jumped', { tabId: boardTab.id, toTabId: running.tab.id });
      return;
    }
    const command = this.wakeCommand;
    if (!command || this.wakeStarting) return;
    this.wakeStarting = true;
    try {
      const wakeTab = await this.tabs.createTab(undefined, { startupCommand: true });
      runStartupCommand(wakeTab, command);
      // createTab made the new tab active; the board's tab stays in front
      // (switched back before the next paint, and it focuses its board).
      if (this.tabs.getTabs().includes(boardTab)) this.tabs.switchToId(boardTab.id);
      rlog('info', '[BOARD] wake started', { tabId: boardTab.id, wakeTabId: wakeTab.id, index: this.tabs.getTabs().indexOf(wakeTab) });
    } finally {
      this.wakeStarting = false;
    }
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
