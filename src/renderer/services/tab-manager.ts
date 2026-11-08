import { Tab } from '../components/tab';
import { checkpointView, DEFAULT_CHECKPOINT_NUDGE_PCT } from './checkpoint-clock';
import { Pane } from '../components/pane';
import { TabBar } from '../components/tab-bar';
import { ConfirmDialog } from '../components/confirm-dialog';
import { HistoryManager } from './history-manager';
import { DEFAULTS } from '../../shared/constants';
import { announce } from './announcer';
import { rlog } from './renderer-logger';
import { onProjectNamesChanged, projectName, startProjectNames } from './project-names';
import { hoverBlocks, type HoverBlock, type HoverPaneInput } from './tab-hover';
import type { SessionState, RendererMode, TabFlag, WindowCloseInfo } from '../../shared/types';
import { orderSessions, sessionNeedsYou, stripClaudeGlyph, type SessionInfo, type SessionStatus } from './sessions';
import type { ITheme } from '@xterm/xterm';

interface ClosedPaneState {
  cwd: string;
  scrollback: string;
  title: string;
}

export class TabManager {
  /** Gap between autosave's getCwd calls: main allows 10/s, so >100 ms. */
  private static readonly CWD_REFRESH_SPACING_MS = 120;
  private autosaveRunning = false;
  private tabs: Tab[] = [];
  private activeTab: Tab | null = null;
  private tabBar: TabBar;
  private confirmDialog: ConfirmDialog;
  /** True while a last-tab close is asking main what closing means (the
   *  dialog isn't open yet, so a fast second ⌘W must not start another). */
  private lastTabCloseQuerying = false;
  /** How long Cmd-W on the last tab waits for main's close-guard IPC before it
   *  falls back to the page's window.close() (which skips main's close guard;
   *  main's 'closed' handler then still ends the shells). A field, not a
   *  constant, so the headless check can shorten it. */
  closeIpcTimeoutMs = 1500;
  private contentContainer: HTMLElement;
  private disposables: (() => void)[] = [];
  private currentFontSize: number | undefined;
  private currentFontFamily: string | undefined;
  private currentScrollback: number | undefined;
  private onCommandDone: ((tabId: string, tabTitle: string) => void) | null = null;
  private panesByPtyId: Map<number, Pane> = new Map();
  private currentShell: string | undefined;
  private sharedHistory: HistoryManager = new HistoryManager();
  private closedPanes: ClosedPaneState[] = [];
  private static readonly MAX_CLOSED = 10;
  private currentCopyOnSelect = false;
  private currentComposeFirst: boolean = DEFAULTS.COMPOSE_FIRST;
  private currentTerminalTheme: ITheme | null = null;
  private currentRenderer: RendererMode = 'webgl';
  private onTabsChanged: (() => void) | null = null; // bookmarks sidebar
  private checkpointNudgePct: number = DEFAULT_CHECKPOINT_NUDGE_PCT;
  // --- Project board ---
  // Opens a new tab the user asked for (⌘T, the palette, the tab bar's +), so
  // the project board can cover it. Unset: a plain createTab().
  private userNewTabHandler: (() => Promise<Tab>) | null = null;
  // Told about every tab that leaves the window, however it went.
  private tabClosedListeners: ((tab: Tab) => void)[] = [];
  // --- end project board ---

  constructor(
    tabBarContainer: HTMLElement,
    contentContainer: HTMLElement,
    options?: {
      onSettings?: () => void;
      onCommandDone?: (tabId: string, tabTitle: string) => void;
      // --- Bookmarks ---
      /** Tabs created, closed or activated, or a tab's title/project changed. */
      onTabsChanged?: () => void;
      /** Tab right-click → Bookmark Project. */
      onBookmarkProject?: (tab: Tab) => void;
      // --- end bookmarks ---
    },
  ) {
    this.contentContainer = contentContainer;
    this.confirmDialog = new ConfirmDialog(document.body);

    this.tabBar = new TabBar(tabBarContainer, {
      onSelect: (id) => this.switchToId(id),
      onClose: (id) => { this.confirmAndCloseTab(id).catch(console.error); },
      onNew: () => { this.userNewTab().catch(console.error); },
      onReorder: (fromId, toId) => this.reorder(fromId, toId),
      onSettings: () => options?.onSettings?.(),
      onRename: (id, name) => this.renameTab(id, name),
      onRenameProject: (id, name) => this.renameProject(id, name),
      onSetFlag: (id, flag) => this.setTabFlag(id, flag),
      onCheckpoint: () => { this.runCheckpoint(); },
      describeTab: (id) => this.describeTab(id),
      // --- Bookmarks ---
      onBookmarkProject: (id) => {
        const tab = this.tabs.find(t => t.id === id);
        if (tab) options?.onBookmarkProject?.(tab);
      },
      // --- end bookmarks ---
    });
    this.onCommandDone = options?.onCommandDone || null;
    this.onTabsChanged = options?.onTabsChanged ?? null;

    // Tabs are named after their project. A project renamed in any window
    // renames its tabs here too.
    startProjectNames().catch(console.error);
    this.disposables.push(
      onProjectNamesChanged(() => {
        for (const tab of this.tabs) tab.refreshTitle();
        this.updateTabBar();
      }),
    );

    // Listen for PTY exit — route via panesByPtyId
    this.disposables.push(
      window.patton.pty.onExit((id) => {
        const pane = this.panesByPtyId.get(id);
        if (pane) {
          // Find the tab that owns this pane
          const tab = this.tabs.find(t => t.panes.includes(pane));
          if (tab) {
            if (tab.panes.length <= 1) {
              this.closeById(tab.id).catch(console.error);
            } else {
              tab.closePane(pane);
            }
          }
        }
      }),
    );
  }

  registerPane(pane: Pane): void {
    if (pane.ptyId !== null) {
      this.panesByPtyId.set(pane.ptyId, pane);
    }
  }

  /**
   * Replace the shell of a tab's only pane, keeping the tab itself (id,
   * position, name rules): the project board opens a project in the board's
   * own tab this way. The pane is re-registered under its new PTY id, so the
   * exit of the NEW shell closes the tab as usual and the old one's end does
   * nothing. Throws, with the old shell and its registration intact, on failure.
   */
  async respawnTab(tab: Tab, opts: { cwd?: string; projectDir?: boolean; hyperlinks?: boolean }): Promise<void> {
    const pane = tab.focusedPane;
    const { oldId, newId } = await tab.respawnShell(opts);
    this.panesByPtyId.delete(oldId);
    // The tab may have been closed while main started the shell (the pane then
    // destroyed the new one itself and threw above), so only a live pane counts.
    if (this.tabs.includes(tab)) this.panesByPtyId.set(newId, pane);
  }

  unregisterPane(pane: Pane): void {
    if (pane.ptyId !== null) {
      this.panesByPtyId.delete(pane.ptyId);
    }
  }

  setShell(shell: string): void {
    this.currentShell = shell;
  }

  /** Pre-load shared history so panes don't each make an IPC call. */
  async loadHistory(): Promise<void> {
    await this.sharedHistory.load();
  }

  setFontSize(size: number): void {
    this.currentFontSize = size;
    for (const tab of this.tabs) {
      tab.setFontSize(size);
    }
  }

  setFontFamily(family: string): void {
    this.currentFontFamily = family;
    for (const tab of this.tabs) {
      tab.setFontFamily(family);
    }
  }

  setScrollback(lines: number): void {
    this.currentScrollback = lines;
    for (const tab of this.tabs) {
      tab.setScrollback(lines);
    }
  }

  setCopyOnSelect(enabled: boolean): void {
    this.currentCopyOnSelect = enabled;
    for (const tab of this.tabs) {
      tab.setCopyOnSelect(enabled);
    }
  }

  /** Compose-first in Claude Code tabs: applies to every open pane at once. */
  setComposeFirst(enabled: boolean): void {
    this.currentComposeFirst = enabled;
    for (const tab of this.tabs) {
      tab.setComposeFirst(enabled);
    }
  }

  setTerminalTheme(theme: ITheme | null): void {
    this.currentTerminalTheme = theme;
    for (const tab of this.tabs) {
      tab.setTerminalTheme(theme);
    }
  }

  setRenderer(mode: RendererMode): void {
    this.currentRenderer = mode;
    for (const tab of this.tabs) {
      tab.setRenderer(mode);
    }
  }

  getRenderer(): RendererMode {
    return this.currentRenderer;
  }

  /** `startupCommand`: the startup command will be typed into this tab, so
   *  its first pane's shell gets FORCE_HYPERLINK=1 (Claude's OSC 8 links). */
  async createTab(cwd?: string, opts?: { forProject?: boolean; startupCommand?: boolean }): Promise<Tab> {
    // Only use explicitly provided CWD (e.g. session restore, reopen closed).
    // New tabs (Cmd+T / +) start at home directory.
    const tab = new Tab(cwd, opts?.forProject === true);
    if (this.currentShell) tab.setShell(this.currentShell);
    tab.setHistoryManager(this.sharedHistory);
    tab.setRegistrationCallbacks(
      (pane) => this.registerPane(pane),
      (pane) => this.unregisterPane(pane),
      () => this.updateTabBar(),
      () => this.onCommandDone?.(tab.id, tab.title),
      () => { if (tab === this.activeTab) this.updateCheckpoint(); this.tabBar.refreshHoverCard(); },
      () => { this.tabBar.refreshHoverCard(); this.onTabsChanged?.(); },
    );
    this.tabs.push(tab);
    this.contentContainer.appendChild(tab.element);

    // Apply current settings to new tab before init
    if (this.currentFontSize !== undefined) {
      tab.setFontSize(this.currentFontSize);
    }
    if (this.currentFontFamily !== undefined) {
      tab.setFontFamily(this.currentFontFamily);
    }
    if (this.currentScrollback !== undefined) {
      tab.setScrollback(this.currentScrollback);
    }
    if (this.currentCopyOnSelect) {
      tab.setCopyOnSelect(this.currentCopyOnSelect);
    }
    tab.setComposeFirst(this.currentComposeFirst);
    if (this.currentTerminalTheme) {
      tab.setTerminalTheme(this.currentTerminalTheme);
    }
    if (this.currentRenderer === 'dom') {
      tab.setRenderer(this.currentRenderer);
    }
    if (opts?.startupCommand === true) tab.markStartupPane();

    try {
      await tab.init();
    } catch (err) {
      // Init failed (PTY creation error) — remove ghost tab
      console.error('Tab init failed:', err);
      const idx = this.tabs.indexOf(tab);
      if (idx !== -1) this.tabs.splice(idx, 1);
      tab.dispose();
      this.updateTabBar();
      throw err;
    }

    // Register the initial pane now that it has a ptyId
    for (const pane of tab.panes) {
      this.registerPane(pane);
    }

    this.switchToId(tab.id);
    announce(`Opened tab ${this.tabs.length}: ${tab.title}`);
    return tab;
  }

  switchToId(id: string): void {
    const tab = this.tabs.find(t => t.id === id);
    if (!tab || tab === this.activeTab) return;

    if (this.activeTab) {
      this.activeTab.hide();
    }

    this.activeTab = tab;
    tab.show();
    this.updateTabBar();
  }

  switchToIndex(index: number): void {
    if (index >= 0 && index < this.tabs.length) {
      this.switchToId(this.tabs[index].id);
    }
  }

  nextTab(): void {
    if (this.tabs.length <= 1 || !this.activeTab) return;
    const idx = this.tabs.indexOf(this.activeTab);
    const nextIdx = (idx + 1) % this.tabs.length;
    this.switchToId(this.tabs[nextIdx].id);
  }

  prevTab(): void {
    if (this.tabs.length <= 1 || !this.activeTab) return;
    const idx = this.tabs.indexOf(this.activeTab);
    const prevIdx = (idx - 1 + this.tabs.length) % this.tabs.length;
    this.switchToId(this.tabs[prevIdx].id);
  }

  /** Name one tab. An empty name forgets it, so the tab follows its project's
   *  name (or the program's title) again. */
  renameTab(id: string, name: string): void {
    const tab = this.tabs.find(t => t.id === id);
    if (tab) {
      if (name) tab.setCustomTitle(name);
      else tab.clearCustomTitle();
      this.updateTabBar();
    }
  }

  /** Rename the project a tab is in: every tab in that project, in every
   *  window, shows the new name. An empty name restores the automatic one.
   *  The tabs update when main broadcasts the change back. */
  renameProject(id: string, name: string): void {
    const project = this.tabs.find(t => t.id === id)?.project;
    if (!project) return;
    window.patton.projects.setName(project.root, name).catch(console.error);
  }

  /** Set or clear a tab's manual colour flag. Persistence rides the existing
   *  30s session autosave, same as renameTab. */
  setTabFlag(id: string, flag: TabFlag | null): void {
    const tab = this.tabs.find(t => t.id === id);
    if (tab) {
      tab.setFlag(flag);
      this.updateTabBar();
    }
  }

  // --- Tab reordering ---
  reorder(fromId: string, toId: string): void {
    const fromIdx = this.tabs.findIndex(t => t.id === fromId);
    const toIdx = this.tabs.findIndex(t => t.id === toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

    const [moved] = this.tabs.splice(fromIdx, 1);
    this.tabs.splice(toIdx, 0, moved);
    this.updateTabBar();
  }

  async closeById(id: string): Promise<void> {
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;

    const tab = this.tabs[idx];
    const closedTitle = tab.title;

    // Save pane state for undo before disposing
    for (const pane of tab.panes) {
      this.saveClosedPane(pane);
    }

    this.removeTab(tab);
    announce(`Closed tab: ${closedTitle}`);

    if (this.tabs.length === 0) {
      await this.closeWindow('no-tabs-left');
      return;
    }

    if (this.activeTab?.id === id) {
      const newIdx = Math.min(idx, this.tabs.length - 1);
      this.switchToId(this.tabs[newIdx].id);
    } else {
      this.updateTabBar();
    }
  }

  /** Dispose a tab and take it out of the list (the caller picks what's next). */
  private removeTab(tab: Tab): void {
    const idx = this.tabs.indexOf(tab);
    if (idx === -1) return;
    tab.dispose();
    this.tabs.splice(idx, 1);
    for (const listener of this.tabClosedListeners) {
      try {
        listener(tab);
      } catch (err) {
        console.error('tab-closed listener failed:', err);
      }
    }
  }

  // --- Project board ---
  /** Open a new tab because the user asked for one (⌘T, the palette's New Tab,
   *  the tab bar's +). Restored, reopened, bookmark and split tabs don't come
   *  through here, so only these can show the project board. */
  userNewTab(): Promise<Tab> {
    return this.userNewTabHandler ? this.userNewTabHandler() : this.createTab();
  }

  setUserNewTabHandler(handler: (() => Promise<Tab>) | null): void {
    this.userNewTabHandler = handler;
  }

  /** Hear about every tab that leaves the window. Returns an unsubscribe. */
  onTabClosed(listener: (tab: Tab) => void): () => void {
    this.tabClosedListeners.push(listener);
    return () => {
      this.tabClosedListeners = this.tabClosedListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Close a tab that was only ever a project board: no confirmation (its shell
   * never ran anything) and not saved for Reopen Closed. Never the last tab, so
   * this never closes the window and never has to get past its close guard.
   * `placeTabId`: a tab just opened from the board, moved to the board's place.
   * Returns whether the tab was closed.
   */
  discardTab(id: string, placeTabId?: string): boolean {
    const tab = this.tabs.find(t => t.id === id);
    if (!tab || this.tabs.length <= 1) return false;
    const idx = this.tabs.indexOf(tab);
    const wasActive = this.activeTab === tab;
    this.removeTab(tab);

    const placed = placeTabId ? this.tabs.find(t => t.id === placeTabId) : undefined;
    if (placed) {
      this.tabs.splice(this.tabs.indexOf(placed), 1);
      this.tabs.splice(Math.min(idx, this.tabs.length), 0, placed);
    }
    if (wasActive) {
      const next = placed ?? this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.switchToId(next.id);
    } else {
      this.updateTabBar();
    }
    return true;
  }
  // --- end project board ---

  async closeActiveTab(): Promise<void> {
    if (this.activeTab) {
      await this.closeById(this.activeTab.id);
    }
  }

  async closeActivePane(): Promise<void> {
    // ⌘W while the close dialog is already up confirms it (⌘W twice closes)
    // instead of opening a second dialog over the first.
    if (this.confirmDialog.confirmByShortcut()) return;
    const tab = this.activeTab;
    if (!tab) return;
    const closingWholeTab = tab.panes.length <= 1;

    if (closingWholeTab) {
      // Closing the whole tab ends every shell in it — the accidental ⌘W the
      // S22/S31 guard exists for. Confirm it.
      if (this.tabs.length <= 1) {
        await this.closeLastTab(tab);
        return;
      }
      const ok = await this.confirmClose('tab', tab.title);
      if (!ok) return;
      // The PTY may have exited (auto-closing the tab) while the dialog was up.
      if (!this.tabs.includes(tab)) return;
      // The other tabs may have gone too: this is now the window's last tab,
      // and closeById would dispose it before the window closes (S37 hazard).
      if (this.tabs.length <= 1) {
        await this.closeLastTab(tab);
        return;
      }
      await this.closeById(tab.id);
    } else {
      // Closing one pane of a split is low-stakes — the tab and sibling panes
      // survive, and the pane's scrollback is saved for ⌘⇧T (Reopen Closed).
      // No confirmation: the prompt made deliberate pane-closing feel broken,
      // because the Cancel-defaulted dialog turned the natural ⌘W-then-Enter
      // into a cancel. Instant close matches iTerm2's idle-split behaviour.
      this.saveClosedPane(tab.focusedPane);
      tab.closePane();
    }
  }

  /** ✕-button / middle-click close: confirm first, then close the whole tab. */
  private async confirmAndCloseTab(id: string): Promise<void> {
    const tab = this.tabs.find(t => t.id === id);
    if (!tab) return;
    // The window's only tab: closing it closes the window (or quits), so it
    // takes the same path and wording as ⌘W, never the "Close this tab?" one.
    if (this.tabs.length <= 1) {
      await this.closeLastTab(tab);
      return;
    }
    const ok = await this.confirmClose('tab', tab.title);
    if (!ok) return;
    if (!this.tabs.includes(tab)) return; // disposed while dialog was open
    if (this.tabs.length <= 1) { // the others went while it was open: now the last tab
      await this.closeLastTab(tab);
      return;
    }
    await this.closeById(id);
  }

  /**
   * Close the window's last tab, which closes the window (and quits Patton
   * when it is the only one). Asks in the app, like any other tab, so ⌘W
   * twice or ⌘W then Enter goes through (Michael: ⌘W twice "should shut
   * patton"). On confirm it tells main's close guard this window's close is
   * already confirmed, then asks main to close the window (closeWindow())
   * WITHOUT tearing the tab down first: the guard still saves state and ends
   * the shells, and the S37 rule holds (a guard that finds the shells already
   * dead can't ask). A window with no live shells closes straight away. If main
   * can't answer the close-info question (refused, failed, too slow) no dialog
   * could be shown, and closing would end every shell unasked, so nothing
   * closes: the user is told to press ⌘W again or ⌘Q.
   */
  private async closeLastTab(tab: Tab): Promise<void> {
    if (this.lastTabCloseQuerying) return;
    this.lastTabCloseQuerying = true;
    let info: WindowCloseInfo | null = null;
    let timedOut = false;
    try {
      const r = await this.askMain('info', () => window.patton.closeGuard.info());
      info = r.value ?? null;
      timedOut = r.timedOut;
    } catch {
      info = null;
    } finally {
      this.lastTabCloseQuerying = false;
    }
    if (!info) {
      // Fail closed: with no answer about live shells there was no dialog, and
      // the fallback window.close() would end every shell with no prompt.
      rlog('warn', '[CLOSE] last tab not closed: main did not answer', {
        reason: timedOut ? 'close-info-timeout' : 'no-close-info',
      });
      announce('Patton could not check for running sessions. Press Command W again, or Command Q.', 'assertive');
      return;
    }
    if (info.liveShells <= 0) {
      rlog('info', '[CLOSE] last tab closed without the app dialog', { reason: 'no-live-shells' });
      await this.closeWindow('no-dialog');
      return;
    }
    const ok = await this.confirmClose('last-tab', tab.title, info.isLastWindow);
    if (!ok) return;
    // The dialog was open for a while: act only if it still describes the
    // window (its tab still here and still the only one). Otherwise do
    // nothing: the user confirmed a different situation.
    if (!this.tabs.includes(tab) || this.tabs.length !== 1) {
      rlog('info', '[CLOSE] last-tab confirm ignored: the tabs changed while the dialog was open', {
        tabStillOpen: this.tabs.includes(tab), tabs: this.tabs.length,
      });
      return;
    }
    let preconfirmed = false;
    let preconfirmTimedOut = false;
    try {
      const r = await this.askMain('preconfirm', () => window.patton.closeGuard.preconfirm());
      preconfirmed = r.value === true;
      preconfirmTimedOut = r.timedOut;
    } catch {
      preconfirmed = false;
    }
    // Not recorded (refused, failed or too slow): main's native box asks instead.
    rlog('info', '[CLOSE] window close handed to main', { preconfirmed, timedOut: preconfirmTimedOut });
    await this.closeWindow('last-tab-confirmed');
  }

  /** Close this window through main (BrowserWindow.close() emits the 'close'
   *  event, so main's guard, saveState and PTY teardown run). The page's own
   *  window.close() destroys the window WITHOUT that event (measured on
   *  Electron 44.9.3), so it is only the fallback when main refuses, fails or
   *  is too slow AFTER the user already confirmed (or there is nothing to
   *  lose); main's 'closed' handler then still ends the shells. */
  private async closeWindow(why: string): Promise<void> {
    let accepted = false;
    try {
      const r = await this.askMain('close', () => window.patton.closeGuard.closeWindow());
      accepted = r.value === true;
    } catch {
      accepted = false;
    }
    if (accepted) return;
    rlog('warn', '[CLOSE] main did not take the window close; falling back to window.close()', { why });
    window.close();
  }

  /** Await one close-guard IPC for at most `closeIpcTimeoutMs`: a stalled main
   *  (it blocks inside any native message box) must not leave Cmd-W dead. */
  private async askMain<T>(what: string, call: () => Promise<T>): Promise<{ value: T | undefined; timedOut: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.closeIpcTimeoutMs);
    });
    try {
      const r = await Promise.race([call(), timeout]);
      if (r === 'timeout') {
        rlog('warn', '[CLOSE] close-guard call timed out', { what, ms: this.closeIpcTimeoutMs });
        return { value: undefined, timedOut: true };
      }
      return { value: r as T, timedOut: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Shared "are you sure you want to close this?" prompt for user-initiated
   *  closes. Not used by automatic closes (PTY exit), which must not prompt.
   *  'last-tab' closes the window: `isLastWindow` says whether that quits. */
  private async confirmClose(kind: 'tab' | 'pane' | 'last-tab', title: string, isLastWindow = false): Promise<boolean> {
    const name = title?.trim();
    const subject = name ? `“${name}”` : (kind === 'pane' ? 'this pane' : 'this tab');
    // Close is focused (Enter closes) and ⌘W again confirms: Michael's
    // "Command+W, press it twice, and it will close immediately".
    const defaultFocus = 'confirm';
    let heading: string;
    let message: string;
    let confirmLabel: string;
    if (kind === 'last-tab' && isLastWindow) {
      heading = 'Quit Patton?';
      message = `${subject} is the last tab, so closing it quits Patton and ends every shell in this window, and any process running inside them.`;
      confirmLabel = 'Quit';
    } else if (kind === 'last-tab') {
      heading = 'Close this window?';
      message = `${subject} is this window's last tab, so closing it closes the window and ends every shell in it. Your other windows stay open.`;
      confirmLabel = 'Close Window';
    } else if (kind === 'tab') {
      heading = 'Close this tab?';
      message = `Closing ${subject} ends the shell and any process running inside it.`;
      confirmLabel = 'Close Tab';
    } else {
      heading = 'Close this pane?';
      message = `Closing ${subject} ends the shell and any process running inside it.`;
      confirmLabel = 'Close Pane';
    }
    rlog('info', '[CLOSE] confirm shown', kind === 'last-tab' ? { kind, defaultFocus, isLastWindow } : { kind, defaultFocus });
    const ok = await this.confirmDialog.confirm({
      title: heading,
      message: message.charAt(0).toUpperCase() + message.slice(1),
      confirmLabel,
      cancelLabel: 'Cancel',
      defaultFocus,
      shortcutConfirms: true,
    });
    rlog('info', '[CLOSE] confirm answered', { kind, ok, by: this.confirmDialog.lastAnswer });
    return ok;
  }

  splitVertical(): void {
    this.activeTab?.splitVertical(this.getActiveCwd())?.catch(console.error);
  }

  splitHorizontal(): void {
    this.activeTab?.splitHorizontal(this.getActiveCwd())?.catch(console.error);
  }

  private getActiveCwd(): string | undefined {
    return this.activeTab?.focusedPane?.getCwd() || undefined;
  }

  focusPaneInDirection(direction: 'up' | 'down' | 'left' | 'right'): void {
    this.activeTab?.focusPaneInDirection(direction);
  }

  getActiveTab(): Tab | null {
    return this.activeTab;
  }

  /** Every tab in this window, in tab-bar order (the bookmarks sidebar reads it). */
  getTabs(): readonly Tab[] {
    return this.tabs;
  }

  /**
   * Every pane of every tab as a session, in the state the hover card shows:
   * needing you first (longest wait first), then parked, then the rest in tab
   * order. The palette and the bookmarks
   * sidebar both read this.
   */
  listSessions(): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    this.tabs.forEach((tab, index) => {
      for (const pane of tab.panes) {
        const project = tab.paneProject(pane);
        const dotSince = tab.awaitingSince(pane);
        const claude = pane.claudeState;
        // The card's and the dot's reading (pane-activity.ts). The dot also
        // rises for a finished command, a bell or a notification, which a
        // shell or idle pane's activity can't show.
        let state: SessionStatus = claude.activity;
        if (dotSince !== null && (state === 'shell' || state === 'idle')) state = 'waiting';
        const needsYou = sessionNeedsYou({ state });
        // Ordering only: the dot's time where it rose, else (the active tab,
        // where it never does) when the pane's activity began.
        const awaitingSince = needsYou ? (dotSince ?? claude.since) : null;
        sessions.push({
          tabId: tab.id,
          paneId: pane.id,
          tabIndex: index + 1,
          paneCount: tab.panes.length,
          project,
          projectName: project ? projectName(project) : null,
          worktree: project?.worktree ?? null,
          cwd: pane.getCwd(),
          tabTitle: tab.title,
          hasCustomTitle: tab.hasCustomTitle,
          paneTitle: stripClaudeGlyph(pane.title),
          state,
          awaitingSince,
        });
      }
    });
    return orderSessions(sessions);
  }

  /** Activate a tab and focus one of its panes. False if either has gone. */
  goToSession(tabId: string, paneId: string): boolean {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || !tab.panes.some((p) => p.id === paneId)) return false;
    this.switchToId(tabId);
    tab.focusPaneById(paneId);
    return true;
  }

  getTabCount(): number {
    return this.tabs.length;
  }

  isActiveTab(tabId: string): boolean {
    return this.activeTab?.id === tabId;
  }

  /**
   * Refresh every pane's cached folder, one call at a time and spaced so the
   * burst stays under main's 10/s getCwd limit. A refused or failed answer
   * keeps the pane's cached folder. Used by the periodic autosave only; the
   * save on quit serialises from the caches without this wait.
   */
  async refreshPaneCwds(spacingMs = TabManager.CWD_REFRESH_SPACING_MS): Promise<void> {
    let first = true;
    for (const tab of [...this.tabs]) {
      for (const pane of [...tab.panes]) {
        if (pane.ptyId === null) continue;
        if (!first) await new Promise<void>((resolve) => setTimeout(resolve, spacingMs));
        first = false;
        await pane.refreshCwdNow();
      }
    }
  }

  /** Periodic autosave: fresh folders first, then the normal save. Never overlaps itself. */
  async autosaveSession(): Promise<void> {
    if (this.autosaveRunning) return;
    this.autosaveRunning = true;
    try {
      await this.refreshPaneCwds();
      await this.saveSession();
    } finally {
      this.autosaveRunning = false;
    }
  }

  async saveSession(): Promise<void> {
    try {
      const results = await Promise.allSettled(this.tabs.map(t => t.serializeTree()));
      const tabStates = results
        .filter((r): r is PromiseFulfilledResult<ReturnType<Tab['serializeTree']> extends Promise<infer T> ? T : never> => r.status === 'fulfilled')
        .map(r => r.value);
      if (tabStates.length === 0) {
        console.warn('Failed to save session: no tabs serialized successfully');
        return;
      }
      // Adjust active index if some tabs failed serialization
      const activeIdx = this.activeTab ? this.tabs.indexOf(this.activeTab) : 0;
      const session: SessionState = {
        tabs: tabStates,
        activeTabIndex: Math.min(Math.max(0, activeIdx), tabStates.length - 1),
      };
      await window.patton.session.set(session);
    } catch (err) {
      console.warn('Failed to save session:', err);
    }
  }

  /** `startupCommand`: the startup command will be typed into the restored
   *  active tab, so its focused pane's shell gets FORCE_HYPERLINK=1. */
  async restoreSession(startupCommand = false): Promise<boolean> {
    try {
      const session = await window.patton.session.get();
      if (!session || !session.tabs || session.tabs.length === 0) return false;

      const savedActive = Math.max(0, Math.min(session.activeTabIndex, session.tabs.length - 1));
      let startupTab: Tab | null = null;
      for (const [index, tabState] of session.tabs.entries()) {
        try {
          const tab = await Tab.createFromSession(tabState);
          if (startupCommand && index === savedActive) {
            tab.markStartupPane();
            startupTab = tab;
          }

          if (this.currentShell) tab.setShell(this.currentShell);
          tab.setHistoryManager(this.sharedHistory);
          tab.setRegistrationCallbacks(
            (pane) => this.registerPane(pane),
            (pane) => this.unregisterPane(pane),
            () => this.updateTabBar(),
            () => this.onCommandDone?.(tab.id, tab.title),
            () => { if (tab === this.activeTab) this.updateCheckpoint(); this.tabBar.refreshHoverCard(); },
            () => { this.tabBar.refreshHoverCard(); this.onTabsChanged?.(); },
          );
          this.tabs.push(tab);
          this.contentContainer.appendChild(tab.element);

          if (this.currentFontSize !== undefined) {
            tab.setFontSize(this.currentFontSize);
          }
          if (this.currentFontFamily !== undefined) {
            tab.setFontFamily(this.currentFontFamily);
          }
          if (this.currentScrollback !== undefined) {
            tab.setScrollback(this.currentScrollback);
          }
          if (this.currentCopyOnSelect) {
            tab.setCopyOnSelect(this.currentCopyOnSelect);
          }
          tab.setComposeFirst(this.currentComposeFirst);
          if (this.currentTerminalTheme) {
            tab.setTerminalTheme(this.currentTerminalTheme);
          }
          if (this.currentRenderer === 'dom') {
            tab.setRenderer(this.currentRenderer);
          }

          // Initialize all panes (creates PTYs)
          await tab.init();

          // Register panes for PTY routing
          for (const pane of tab.panes) {
            this.registerPane(pane);
          }

          // Render the split tree if it has splits
          if (tab.panes.length > 1) {
            // Force tree re-render by calling show
            tab.show();
            tab.hide();
          }
        } catch (tabErr) {
          console.warn('Failed to restore individual tab, skipping:', tabErr);
          // Continue restoring other tabs — don't lose the entire session
        }
      }

      // Switch to the previously active tab (the startup command then lands
      // in the pane that was given FORCE_HYPERLINK, even if a tab before it
      // failed to restore and shifted the indexes).
      const activeIdx = Math.min(session.activeTabIndex, this.tabs.length - 1);
      if (startupTab && this.tabs.includes(startupTab)) {
        this.switchToId(startupTab.id);
      } else if (this.tabs.length > 0) {
        this.switchToId(this.tabs[Math.max(0, activeIdx)].id);
      }

      // Clear saved session after restore attempt
      await window.patton.session.set(null);
      return this.tabs.length > 0;
    } catch (err) {
      console.warn('Session restore failed:', err);
      // Clear stale session to prevent repeated partial restores
      await window.patton.session.set(null).catch(() => {});
      return false;
    }
  }

  private static readonly MAX_SCROLLBACK_BYTES = 100 * 1024; // 100KB cap for closed pane scrollback

  private saveClosedPane(pane: Pane): void {
    let scrollback = pane.getScrollbackContent() || '';
    // Cap scrollback to prevent IPC payload overflow (1MB IPC limit)
    if (scrollback.length > TabManager.MAX_SCROLLBACK_BYTES) {
      scrollback = scrollback.slice(-TabManager.MAX_SCROLLBACK_BYTES);
    }
    const state: ClosedPaneState = {
      cwd: pane.getCwd() || '',
      scrollback,
      title: pane.title || 'Terminal',
    };
    this.closedPanes.push(state);
    if (this.closedPanes.length > TabManager.MAX_CLOSED) {
      this.closedPanes.shift();
    }
  }

  /** Reopen the most recently closed pane as a new tab */
  async reopenClosed(): Promise<void> {
    const state = this.closedPanes.pop();
    if (!state) return;

    const tab = await this.createTab(state.cwd || undefined);
    // Write the saved scrollback content to the new terminal
    if (state.scrollback) {
      const focusedPane = tab.focusedPane;
      // Write scrollback as dimmed text so it's visually distinct from new output
      focusedPane.terminalView.write(
        `\x1b[2m${state.scrollback.replace(/\n/g, '\r\n')}\x1b[0m\r\n`
      );
    }
    if (state.title && state.title !== 'Terminal') {
      // The closed pane's last program title, at the program title's usual
      // rank: a project's name still wins, and the next title the program
      // sets replaces it — rather than pinning it as a user-chosen name.
      tab.setProcessName(state.title);
    }
  }

  hasClosedPanes(): boolean {
    return this.closedPanes.length > 0;
  }

  // ---- Split zoom ----

  toggleZoom(): void {
    this.activeTab?.toggleZoom();
  }

  // ---- Prompt jumping ----

  jumpToPrompt(direction: 'up' | 'down'): void {
    this.activeTab?.jumpToPrompt(direction);
  }

  private updateTabBar(): void {
    this.tabBar.update(
      this.tabs.map(t => ({
        id: t.id,
        title: t.title,
        autoTitle: t.autoTitle,
        project: t.project ? { name: projectName(t.project), defaultName: t.project.defaultName } : null,
        active: t.id === this.activeTab?.id,
        awaitingInput: t.awaitingInput,
        flag: t.flag,
        autoFlag: t.autoFlag,
        parked: t.parked,
        waitingText: t.waitingText,
      })),
    );
    // Every tab change funnels through here, so the bookmarks sidebar hears it too.
    this.onTabsChanged?.();
    this.updateCheckpoint();
  }

  // ---- Checkpoint clock (services/checkpoint-clock.ts) ----

  /** Settings → "Checkpoint reminder after N% of the context window". */
  setCheckpointNudgePct(pct: number): void {
    this.checkpointNudgePct = pct;
    this.updateCheckpoint();
  }

  /** Show the active tab's focused pane on the strip's checkpoint clock. */
  private updateCheckpoint(): void {
    const pane = this.activeTab?.focusedPane;
    this.tabBar.setCheckpoint(checkpointView(pane ? pane.checkpointSource : null, this.checkpointNudgePct));
  }

  // ---- Tab hover card (services/tab-hover.ts) ----

  /** One block per pane of the tab, the focused pane first. */
  private describeTab(id: string): HoverBlock[] | null {
    const tab = this.tabs.find(t => t.id === id);
    if (!tab) return null;
    const project = tab.project ? projectName(tab.project) : null;
    const panes = tab.panes.map((pane) => {
      const focused = pane === tab.focusedPane;
      const c = pane.claudeState;
      const input: HoverPaneInput = {
        // Without the ◐/◑/✳ glyph: the card shows the name, and a spinner
        // flip then leaves its text (and so its DOM) unchanged.
        title: stripClaudeGlyph(pane.title),
        cwd: pane.getCwd(),
        project: focused ? project : null,
        claude: {
          activity: c.activity,
          since: c.since,
          title: c.title,
          blockedKind: c.blockedKind,
          msg: c.msg,
          blockedTask: c.blockedTask,
          parked: c.parked,
        },
        checkpoint: pane.checkpointSource,
      };
      return { focused, input };
    });
    return hoverBlocks(panes, Date.now());
  }

  /** The clock's click and the palette's "Checkpoint this session". */
  runCheckpoint(): void {
    const pane = this.activeTab?.focusedPane;
    if (!pane) return;
    const why = pane.runCheckpoint();
    if (why) {
      // Seen and heard, from the clock's click and the palette alike.
      announce(why, 'assertive');
      this.tabBar.showCheckpointReason(why);
    }
    // The click left focus on the strip's button; the keyboard belongs to Claude.
    pane.focus();
  }

  dispose(): void {
    for (const d of this.disposables) d();
    for (const tab of this.tabs) tab.dispose();
    this.tabBar.dispose();
    this.confirmDialog.dispose();
  }
}
