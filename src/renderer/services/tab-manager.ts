import { Tab } from '../components/tab';
import { checkpointView, DEFAULT_CHECKPOINT_NUDGE_PCT } from './checkpoint-clock';
import { Pane } from '../components/pane';
import { TabBar } from '../components/tab-bar';
import { ConfirmDialog } from '../components/confirm-dialog';
import { HistoryManager } from './history-manager';
import { CONFIRM_SHORTCUT_DWELL_MS, DEFAULTS } from '../../shared/constants';
import { announce } from './announcer';
import { rlog } from './renderer-logger';
import { WAKE_TITLE, isWakeTab } from './board-wake';
import { onProjectNamesChanged, projectDisplay, projectName, projectNameKey, projectRenameFields, startProjectNames } from './project-names';
import { hoverBlocks, type HoverBlock, type HoverPaneInput } from './tab-hover';
import type { SessionState, SessionTabState, RendererMode, TabFlag, WindowCloseInfo, ConfirmRequest, PauseAllReport } from '../../shared/types';
import { runPause, emptyReport, pauseSummary, type PauseTarget } from './pause-all';
import { orderSessions, sessionNeedsYou, type SessionInfo, type SessionStatus } from './sessions';
import { SHELL_TITLE } from './tab-name';
import type { ITheme } from '@xterm/xterm';
import { SessionBar, type SessionBarTarget } from '../components/session-bar';
import type { LinkRow } from './session-bar-model';
import { resolveHyperlink } from './link-target';
import { ReviewTabs } from './review-tabs';
import {
  cleanGroupName, moveGroupFirst, nearestVisible, newGroupId, placeAfterGroup, repairRuns, stepMove, takeOutOfGroup,
  visibleItems, MAX_GROUPS, type TabGroup,
} from './tab-groups';

/** Why a group unfolded, as the `[GROUP] unfolded` log line names it. */
export type GroupUnfoldReason = 'click' | 'menu' | 'jump' | 'add' | 'new-tab' | 'restore';

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
  /** Id of the quit / close-window confirmation main asked this window for, while its dialog is up. */
  private mainConfirmId: string | null = null;
  /** How long Cmd-W on the last tab waits for main's close-guard IPC before it
   *  falls back to the page's window.close() (which skips main's close guard;
   *  main's 'closed' handler then still ends the shells). A field, not a
   *  constant, so the headless check can shorten it. */
  closeIpcTimeoutMs = 1500;
  private contentContainer: HTMLElement;
  private disposables: (() => void)[] = [];
  /** The window's session bar (docs/session-bar.md D1, D2). */
  private sessionBar: SessionBar;
  /** One bar target per pane, so following the same pane again is a no-op. */
  private barTargets = new WeakMap<Pane, SessionBarTarget>();
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
  private currentComposeFirst: boolean = DEFAULTS.COMPOSE_BOX;
  private currentComposeOverBar: boolean = DEFAULTS.COMPOSE_OVER_BAR;
  private currentTerminalTheme: ITheme | null = null;
  private currentRenderer: RendererMode = 'webgl';
  private onTabsChanged: (() => void) | null = null; // bookmarks sidebar
  private checkpointNudgePct: number = DEFAULT_CHECKPOINT_NUDGE_PCT;
  /** A press is waiting on main: a second click does nothing until it answers. */
  private pausePressInFlight = false;
  /** Tabs where `wake` runs (a pane titled exactly WAKE), so a tab moves to
   *  the far left once when wake starts, not again on later title changes. */
  private wakeTabIds = new Set<string>();
  // --- Project board ---
  // Opens a new tab the user asked for (⌘T, the palette, the tab bar's +), so
  // the project board can cover it. Unset: a plain createTab().
  private userNewTabHandler: (() => Promise<Tab>) | null = null;
  // Told about every tab that leaves the window, however it went.
  private tabClosedListeners: ((tab: Tab) => void)[] = [];
  /** Word files open as review tabs over a shell tab (docs/review-tab.md). */
  readonly reviewTabs: ReviewTabs;
  // --- end project board ---
  // --- Tab groups (services/tab-groups.ts) ---
  // This window's groups, and which group each tab is in. A group's tabs are
  // always one unbroken run in `this.tabs`; a group with no tabs is deleted.
  private groups = new Map<string, TabGroup>();
  private groupOfTab = new Map<string, string>();
  private readonly groupOf = (tab: Tab): string | null => this.groupOfTab.get(tab.id) ?? null;
  /** Shown on the strip: not in a folded group. */
  private readonly isTabVisible = (tab: Tab): boolean => {
    const groupId = this.groupOf(tab);
    return groupId === null || this.groups.get(groupId)?.folded !== true;
  };
  // --- end tab groups ---

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
      onMoveStep: (id, dir) => this.moveTabStep(id, dir),
      onSettings: () => options?.onSettings?.(),
      onRename: (id, name) => this.renameTab(id, name),
      onRenameProject: (id, name) => this.renameProject(id, name),
      onSetFlag: (id, flag) => this.setTabFlag(id, flag),
      onPauseAll: () => { void this.pressPauseAll(); },
      describeTab: (id) => this.describeTab(id),
      // --- Tab groups ---
      onNewGroup: (tabId) => this.addTabToNewGroup(tabId),
      onAddToGroup: (tabId, groupId) => this.addTabToGroup(tabId, groupId),
      onRemoveFromGroup: (tabId) => this.removeTabFromGroup(tabId),
      onRenameGroup: (groupId, name) => this.renameGroup(groupId, name),
      onToggleGroup: (groupId, reason) => this.toggleGroupFolded(groupId, reason),
      onNewTabInGroup: (groupId) => { this.newTabInGroup(groupId).catch(console.error); },
      onUngroup: (groupId) => this.ungroup(groupId),
      onCloseGroup: (groupId) => { this.closeGroup(groupId).catch(console.error); },
      // --- Bookmarks ---
      onBookmarkProject: (id) => {
        const tab = this.tabs.find(t => t.id === id);
        if (tab) options?.onBookmarkProject?.(tab);
      },
      // --- end bookmarks ---
    });
    this.onCommandDone = options?.onCommandDone || null;
    this.listenForMainConfirmations();
    this.listenForPauseAll();
    this.onTabsChanged = options?.onTabsChanged ?? null;

    // The session bar: one per window, after #content inside #main.
    this.sessionBar = new SessionBar(contentContainer, {
      onCheckpoint: () => { void this.runCheckpoint(); },
      onMinimizedChange: () => { this.saveSession().catch(() => {}); },
      onOpenLink: (link) => { void this.openBarLink(link); },
      onShownChange: () => this.refitForBar(),
    });
    // main's transcript feed, routed by pty to the pane that asked for it.
    const offFeed = window.patton.sessionFeed?.onEvent((ptyId, event) => {
      this.paneForPty(ptyId)?.applyFeedEvent(ptyId, event);
    });
    if (offFeed) this.disposables.push(offFeed);

    // Word files open in review tabs (services/review-tabs.ts, docs/review-tab.md).
    this.reviewTabs = new ReviewTabs({
      focusedPane: () => this.activeTab?.focusedPane ?? null,
      createTab: (cwd) => this.createTab(cwd),
      onTabClosed: (listener) => this.onTabClosed(listener),
      paneAlive: (pane) => this.tabs.some((t) => t.panes.includes(pane)),
      showPane: (pane) => {
        const tab = this.tabs.find((t) => t.panes.includes(pane));
        if (tab) this.goToSession(tab.id, pane.id);
      },
      confirm: (opts) => this.confirmDialog.confirm(opts),
    });

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

  /** The compose box under Claude Code tabs: applies to every open pane at once. */
  setComposeFirst(enabled: boolean): void {
    this.currentComposeFirst = enabled;
    for (const tab of this.tabs) {
      tab.setComposeFirst(enabled);
    }
  }

  /** The compose box over Claude Code's own bar (D12): every open pane at once. */
  setComposeOverBar(enabled: boolean): void {
    this.currentComposeOverBar = enabled;
    for (const tab of this.tabs) {
      tab.setComposeOverBar(enabled);
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
      () => { this.moveWakeTabFirst(tab); this.updateTabBar(); },
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
    tab.setComposeOverBar(this.currentComposeOverBar);
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
    if (!tab) return;
    // Any jump to a tab inside a folded group (the hover list, the palette, a
    // bookmark, a board tile) unfolds the group first.
    const groupId = this.groupOf(tab);
    const group = groupId !== null ? this.groups.get(groupId) : undefined;
    if (group?.folded) {
      this.unfoldGroup(group, 'jump');
      if (tab === this.activeTab) { this.updateTabBar(); return; }
    }
    if (tab === this.activeTab) return;

    if (this.activeTab) {
      this.activeTab.hide();
    }

    this.activeTab = tab;
    tab.show();
    this.updateTabBar();
  }

  /** ⌘1–9: counts only the tabs on the strip (not those in a folded group). */
  switchToIndex(index: number): void {
    const visible = visibleItems(this.tabs, this.isTabVisible);
    if (index >= 0 && index < visible.length) {
      this.switchToId(visible[index].id);
    }
  }

  /** ⌘⇧] / ⌘⇧[: the next or previous tab on the strip, skipping folded groups. */
  nextTab(): void {
    this.stepTab(1);
  }

  prevTab(): void {
    this.stepTab(-1);
  }

  private stepTab(dir: 1 | -1): void {
    if (!this.activeTab) return;
    const visible = visibleItems(this.tabs, this.isTabVisible);
    if (visible.length === 0) return;
    const idx = visible.indexOf(this.activeTab);
    if (idx === -1) { this.switchToId(visible[0].id); return; }
    if (visible.length <= 1) return;
    const nextIdx = (idx + dir + visible.length) % visible.length;
    this.switchToId(visible[nextIdx].id);
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
   *  window, shows the new name. In a linked worktree it names that worktree
   *  alone (the parent repository keeps its own name). An empty name restores
   *  the automatic one.
   *  The tabs update when main broadcasts the change back. */
  renameProject(id: string, name: string): void {
    const project = this.tabs.find(t => t.id === id)?.menuProject;
    if (!project) return;
    window.patton.projects.setName(projectNameKey(project), name).catch(console.error);
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

    // The moved tab takes the group of the tab it was dropped on (Move Left /
    // Move Right come here too): a grouped target means joining that group,
    // an ungrouped one leaving any group.
    const targetGroup = this.groupOf(this.tabs[toIdx]);
    const [moved] = this.tabs.splice(fromIdx, 1);
    this.tabs.splice(toIdx, 0, moved);
    const fromGroup = this.groupOf(moved);
    if (targetGroup !== fromGroup) {
      if (targetGroup === null) this.groupOfTab.delete(moved.id);
      else this.groupOfTab.set(moved.id, targetGroup);
      rlog('info', '[GROUP] tab moved between groups', { tabId: moved.id, from: fromGroup, to: targetGroup, by: 'reorder' });
    }
    this.updateTabBar();
  }

  /** Tab menu → Move Left (-1) / Move Right (1): exactly one step on the
   *  strip (tab-groups.ts stepMove): out of a group at its edge, into an open
   *  group beside it, past a folded group whole, else a swap. Drag-and-drop
   *  keeps reorder()'s rule. Announced; nothing happens where nothing would change. */
  moveTabStep(id: string, dir: -1 | 1): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const step = stepMove(this.tabs, tab, dir, this.groupOf, (g) => this.groups.get(g)?.folded === true);
    if (!step) return;
    const from = this.groupOf(tab);
    this.setTabOrder(step.list);
    if (step.group === null) this.groupOfTab.delete(tab.id);
    else this.groupOfTab.set(tab.id, step.group);
    if (from !== step.group) {
      rlog('info', '[GROUP] tab moved between groups', { tabId: tab.id, from, to: step.group, by: 'move-step' });
    }
    const way = dir < 0 ? 'left' : 'right';
    const group = step.groupId !== null ? this.groups.get(step.groupId) : undefined;
    const label = group ? this.groupLabel(group) : 'its group';
    if (step.kind === 'into') announce(`${tab.title} moved into ${label}`);
    else if (step.kind === 'out-of') announce(`${tab.title} moved out of ${label}`);
    else if (step.kind === 'past') announce(`${tab.title} moved ${way} past ${label}`);
    else announce(`${tab.title} moved ${way}`);
    this.updateTabBar();
  }

  /** Michael, 10 Nov: "when one types our wake command … always shift it to
   *  first tab on left". When a pane of this tab takes the WAKE title (typed
   *  `wake` or the board's Wake button), the tab moves to the far left of its
   *  window, once per run: a drag elsewhere afterwards sticks, and the tab
   *  stays put when wake ends. The caller redraws the strip. */
  private moveWakeTabFirst(tab: Tab): void {
    const waking = isWakeTab(tab);
    if (!waking) {
      this.wakeTabIds.delete(tab.id);
      return;
    }
    if (this.wakeTabIds.has(tab.id)) return;
    this.wakeTabIds.add(tab.id);
    // In a group, the whole group goes to the far left, its order and fold kept.
    const groupId = this.groupOf(tab);
    if (groupId !== null) {
      const first = this.tabs.findIndex((t) => this.groupOf(t) === groupId);
      if (first <= 0) return;
      this.setTabOrder(moveGroupFirst(this.tabs, groupId, this.groupOf));
      rlog('info', '[GROUP] wake moved', { groupId, tabId: tab.id, from: first });
      return;
    }
    const from = this.tabs.indexOf(tab);
    if (from <= 0) return;
    this.tabs.splice(from, 1);
    this.tabs.unshift(tab);
    rlog('info', '[WAKE] tab moved first', { tabId: tab.id, from });
  }

  async closeById(id: string): Promise<void> {
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;

    const tab = this.tabs[idx];
    const closedTitle = tab.title;

    // Save pane state for undo before disposing. Not a review tab's: its
    // shell is only what the document lies over, and Reopen Closed Tab
    // would bring back an empty terminal instead of the document.
    if (!this.reviewTabs.viewOf(tab)) {
      for (const pane of tab.panes) {
        this.saveClosedPane(pane);
      }
    }

    this.removeTab(tab);
    announce(`Closed tab: ${closedTitle}`);

    if (this.tabs.length === 0) {
      await this.closeWindow('no-tabs-left');
      return;
    }

    if (this.activeTab?.id === id) {
      // The nearest tab on the strip (right first), never one inside a folded group.
      const next = nearestVisible(this.tabs, idx, idx - 1, this.isTabVisible);
      if (next !== -1) {
        this.switchToId(this.tabs[next].id);
      } else {
        // Every tab left is in a folded group: open a new one rather than unfold.
        this.activeTab = null;
        this.updateTabBar();
        this.userNewTab().catch((err) => {
          console.error('New tab after closing the selected tab failed:', err);
          if (!this.activeTab && this.tabs.length > 0) {
            this.switchToId(this.tabs[Math.min(idx, this.tabs.length - 1)].id);
          }
        });
      }
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
    this.wakeTabIds.delete(tab.id);
    this.groupOfTab.delete(tab.id);
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
    const discardedGroup = this.groupOf(tab);
    this.removeTab(tab);

    const placed = placeTabId ? this.tabs.find(t => t.id === placeTabId) : undefined;
    if (placed) {
      this.tabs.splice(this.tabs.indexOf(placed), 1);
      this.tabs.splice(Math.min(idx, this.tabs.length), 0, placed);
      // The placed tab takes the board's place in its group too.
      const group = discardedGroup !== null ? this.groups.get(discardedGroup) : undefined;
      if (group) {
        this.groupOfTab.set(placed.id, group.id);
        // The group may have folded while the tile's open was in flight: the
        // placed tab is selected, so its group unfolds rather than hide it.
        if (placed === this.activeTab) this.unfoldGroup(group, 'jump');
      } else {
        this.groupOfTab.delete(placed.id);
      }
    }
    if (wasActive) {
      // The nearest tab on the strip, as closing a tab picks (a folded group's
      // tab only if nothing else is left: switchToId unfolds it).
      const visibleIdx = nearestVisible(this.tabs, idx, idx - 1, this.isTabVisible);
      const next = placed ?? (visibleIdx !== -1 ? this.tabs[visibleIdx] : this.tabs[Math.min(idx, this.tabs.length - 1)]);
      this.switchToId(next.id);
    } else {
      this.updateTabBar();
    }
    return true;
  }
  // --- end project board ---

  // --- Tab groups ---
  /** A group's spoken and announced name: its own, or "Unnamed". */
  private groupLabel(group: TabGroup): string {
    return group.name || 'Unnamed';
  }

  private groupMembers(groupId: string): Tab[] {
    return this.tabs.filter((t) => this.groupOf(t) === groupId);
  }

  /** Replace the tab order in place (other code may hold `this.tabs`). */
  private setTabOrder(order: Tab[]): void {
    this.tabs.splice(0, this.tabs.length, ...order);
  }

  /** Keep the group rules true before every redraw: memberships of tabs that
   *  are gone are forgotten, broken runs repaired (none expected outside a
   *  restore, so a repair is logged), and groups with no tabs deleted. */
  private normaliseGroups(): void {
    if (this.groups.size === 0 && this.groupOfTab.size === 0) return;
    const ids = new Set(this.tabs.map((t) => t.id));
    for (const [tabId, groupId] of this.groupOfTab) {
      if (!ids.has(tabId) || !this.groups.has(groupId)) this.groupOfTab.delete(tabId);
    }
    const { list, moved } = repairRuns(this.tabs, this.groupOf);
    if (moved > 0) {
      this.setTabOrder(list);
      rlog('warn', '[GROUP] broken run repaired', { moved });
    }
    const used = new Set(this.groupOfTab.values());
    for (const groupId of [...this.groups.keys()]) {
      if (!used.has(groupId)) {
        this.groups.delete(groupId);
        rlog('info', '[GROUP] emptied', { groupId });
      }
    }
  }

  /** This window's groups in strip order, with their tabs (checks and callers). */
  getTabGroups(): { id: string; name: string; folded: boolean; tabIds: string[] }[] {
    const order: string[] = [];
    for (const tab of this.tabs) {
      const groupId = this.groupOf(tab);
      if (groupId !== null && !order.includes(groupId)) order.push(groupId);
    }
    return order.flatMap((groupId) => {
      const group = this.groups.get(groupId);
      return group ? [{ ...group, tabIds: this.groupMembers(groupId).map((t) => t.id) }] : [];
    });
  }

  /** Tab menu → Add Tab to New Group: a group holding this tab where it is (a
   *  tab already in a group first leaves it). Returns the new group's id, so
   *  the strip can open the name box on its chip at once. */
  addTabToNewGroup(tabId: string): string | null {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    if (this.groups.size >= MAX_GROUPS) {
      announce(`A window holds at most ${MAX_GROUPS} groups.`);
      return null;
    }
    if (this.groupOf(tab) !== null) {
      this.setTabOrder(takeOutOfGroup(this.tabs, tab, this.groupOf));
      this.groupOfTab.delete(tab.id);
    }
    const id = newGroupId();
    this.groups.set(id, { id, name: '', folded: false });
    this.groupOfTab.set(tab.id, id);
    rlog('info', '[GROUP] created', { groupId: id, tabId });
    announce(`New group made with ${tab.title}`);
    this.updateTabBar();
    return id;
  }

  /** Add to an existing group: the tab goes after the group's last tab. Into
   *  a folded group it disappears, except the selected tab, whose group unfolds. */
  addTabToGroup(tabId: string, groupId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    const group = this.groups.get(groupId);
    if (!tab || !group || this.groupOf(tab) === groupId) return;
    this.setTabOrder(placeAfterGroup(this.tabs, tab, groupId, this.groupOf));
    this.groupOfTab.set(tab.id, groupId);
    rlog('info', '[GROUP] tab added', { groupId, tabId });
    if (group.folded && tab === this.activeTab) this.unfoldGroup(group, 'add');
    announce(`${tab.title} added to ${this.groupLabel(group)} group`);
    this.updateTabBar();
  }

  /** Tab menu → Remove from Group: the tab lands just after the group. */
  removeTabFromGroup(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    const groupId = tab ? this.groupOf(tab) : null;
    if (!tab || groupId === null) return;
    this.setTabOrder(takeOutOfGroup(this.tabs, tab, this.groupOf));
    this.groupOfTab.delete(tab.id);
    rlog('info', '[GROUP] tab removed', { groupId, tabId });
    const group = this.groups.get(groupId);
    announce(`${tab.title} removed from ${group ? this.groupLabel(group) : 'its'} group`);
    this.updateTabBar();
  }

  /** Name a group (trimmed, 60 characters at most; '' = unnamed). */
  renameGroup(groupId: string, name: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    const clean = cleanGroupName(name);
    if (clean === group.name) return;
    group.name = clean;
    rlog('info', '[GROUP] named', { groupId, length: clean.length });
    this.updateTabBar();
  }

  /** Chip click, Enter/Space, or its menu: fold an open group, unfold a folded one. */
  toggleGroupFolded(groupId: string, reason: 'click' | 'menu'): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    if (group.folded) {
      this.unfoldGroup(group, reason);
      this.updateTabBar();
    } else {
      this.foldGroup(groupId);
    }
  }

  /** Unfold without redrawing (the caller redraws). */
  private unfoldGroup(group: TabGroup, reason: GroupUnfoldReason): void {
    if (!group.folded) return;
    group.folded = false;
    rlog('info', '[GROUP] unfolded', { groupId: group.id, reason });
    if (reason === 'click' || reason === 'menu') announce(`${this.groupLabel(group)} group unfolded`);
  }

  /** Fold a group: its tabs leave the strip. Folding the group that holds the
   *  selected tab selects the nearest tab on the strip outside it (right of
   *  the group first, then left), or opens a new tab if there is none. */
  foldGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group || group.folded) return;
    const members = this.groupMembers(groupId);
    const finish = (movedSelection: string | false) => {
      group.folded = true;
      rlog('info', '[GROUP] folded', { groupId, tabs: members.length, movedSelection });
      announce(`${this.groupLabel(group)} group folded, ${members.length} ${members.length === 1 ? 'tab' : 'tabs'}`);
    };
    if (!this.activeTab || !members.includes(this.activeTab)) {
      finish(false);
      this.updateTabBar();
      return;
    }
    const first = this.tabs.indexOf(members[0]);
    const last = this.tabs.indexOf(members[members.length - 1]);
    const next = nearestVisible(this.tabs, last + 1, first - 1, (t) => this.groupOf(t) !== groupId && this.isTabVisible(t));
    if (next !== -1) {
      finish(next > last ? 'right' : 'left');
      this.switchToId(this.tabs[next].id);
      return;
    }
    // Nothing else on the strip: a new tab first (the group stays open while
    // it opens, so the selected tab is never hidden), then fold.
    this.userNewTab().then(() => {
      if (this.groups.get(groupId) !== group || group.folded) return;
      if (this.activeTab && this.groupOf(this.activeTab) === groupId) return;
      finish('new-tab');
      this.updateTabBar();
    }).catch((err) => console.error('New tab before folding failed:', err));
  }

  /** Chip menu → Ungroup: the chip goes, the tabs stay where they are. */
  ungroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    const members = this.groupMembers(groupId);
    for (const tab of members) this.groupOfTab.delete(tab.id);
    this.groups.delete(groupId);
    rlog('info', '[GROUP] ungrouped', { groupId, tabs: members.length });
    announce(`${this.groupLabel(group)} group ungrouped`);
    this.updateTabBar();
  }

  /** Chip menu → New Tab in Group: a tab opened as ⌘T opens one (so the
   *  project board shows), put after the group's last tab, in the group,
   *  which unfolds; the new tab is selected. */
  async newTabInGroup(groupId: string): Promise<void> {
    if (!this.groups.has(groupId)) return;
    const tab = await this.userNewTab();
    const group = this.groups.get(groupId);
    if (!group || !this.tabs.includes(tab)) return;
    this.setTabOrder(placeAfterGroup(this.tabs, tab, groupId, this.groupOf));
    this.groupOfTab.set(tab.id, groupId);
    rlog('info', '[GROUP] tab added', { groupId, tabId: tab.id, by: 'new-tab' });
    this.unfoldGroup(group, 'new-tab');
    if (this.activeTab !== tab) this.switchToId(tab.id);
    else this.updateTabBar();
  }

  /** Chip menu → Close Group…: asks once, in the app, then closes every tab
   *  in the group without asking per tab. A group holding every tab of the
   *  window opens a new tab first, so the window stays. */
  async closeGroup(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) return;
    const members = this.groupMembers(groupId);
    if (members.length === 0) return;
    const claude = members.reduce((n, t) => n + t.panes.filter((p) => p.claudeState.active).length, 0);
    const ok = await this.confirmGroupClose(group, members.length, claude);
    if (!ok) return;
    // The group as it is now: tabs may have closed or moved while the dialog was up.
    const closing = members.filter((t) => this.tabs.includes(t) && this.groupOf(t) === groupId);
    if (closing.length === 0) return;
    if (this.tabs.every((t) => closing.includes(t))) {
      try {
        await this.userNewTab();
      } catch (err) {
        console.error('New tab before closing the group failed:', err);
      }
      if (this.tabs.every((t) => closing.includes(t))) {
        rlog('warn', '[GROUP] close stopped: no other tab to keep the window', { groupId });
        return;
      }
    } else if (this.activeTab && closing.includes(this.activeTab)) {
      const first = this.tabs.indexOf(closing[0]);
      const last = this.tabs.indexOf(closing[closing.length - 1]);
      const next = nearestVisible(this.tabs, last + 1, first - 1, (t) => !closing.includes(t) && this.isTabVisible(t));
      if (next !== -1) {
        this.switchToId(this.tabs[next].id);
      } else {
        try {
          await this.userNewTab();
        } catch (err) {
          console.error('New tab before closing the group failed:', err);
        }
      }
    }
    for (const tab of closing) {
      if (this.tabs.includes(tab) && this.tabs.length > 1) await this.closeById(tab.id);
    }
    rlog('info', '[GROUP] closed', { groupId, tabs: closing.length });
    announce(`Closed ${closing.length} ${closing.length === 1 ? 'tab' : 'tabs'} in ${this.groupLabel(group)} group`);
  }

  /** The one in-app question Close Group asks (the close dialogs' look and keys). */
  private async confirmGroupClose(group: TabGroup, tabs: number, claude: number): Promise<boolean> {
    const where = group.name ? `“${group.name}”` : 'this group';
    const tabsText = `${tabs} ${tabs === 1 ? 'tab' : 'tabs'}`;
    const claudeText = claude > 0
      ? ` ${claude} Claude ${claude === 1 ? 'session ends' : 'sessions end'} with them.`
      : '';
    rlog('info', '[CLOSE] confirm shown', { kind: 'group', defaultFocus: 'confirm', tabs, claude });
    const ok = await this.confirmDialog.confirm({
      title: `Close ${tabsText} in ${where}?`,
      message: `Closing the group ends the shell in each of its tabs and any process running inside them.${claudeText}`,
      confirmLabel: 'Close Group',
      cancelLabel: 'Cancel',
      defaultFocus: 'confirm',
      // Opened from a menu, not by ⌘W: a ⌘W while it is up is swallowed, so
      // only its button (or Enter after the dwell) closes the group.
      shortcutIgnored: true,
      confirmDwellMs: CONFIRM_SHORTCUT_DWELL_MS,
    });
    rlog('info', '[CLOSE] confirm answered', { kind: 'group', ok, by: this.confirmDialog.lastAnswer });
    return ok;
  }

  /** Rebuild the saved groups after a restore: memberships to groups that
   *  exist, broken runs repaired, empty groups dropped, and a folded group
   *  holding the tab about to be selected unfolded. */
  private restoreGroups(session: SessionState, savedGroupOf: Map<Tab, string>, target: Tab | null): void {
    const saved = Array.isArray(session.groups) ? session.groups : [];
    const valid = new Map<string, TabGroup>();
    for (const g of saved) {
      if (!g || typeof g.id !== 'string' || typeof g.name !== 'string' || valid.has(g.id)) continue;
      valid.set(g.id, { id: g.id, name: cleanGroupName(g.name), folded: g.folded === true });
    }
    let members = 0;
    for (const [tab, groupId] of savedGroupOf) {
      const group = valid.get(groupId);
      if (!group || !this.tabs.includes(tab)) continue;
      if (!this.groups.has(groupId)) this.groups.set(groupId, group);
      this.groupOfTab.set(tab.id, groupId);
      members++;
    }
    if (this.groups.size === 0) return;
    const { list, moved } = repairRuns(this.tabs, this.groupOf);
    if (moved > 0) this.setTabOrder(list);
    const targetGroup = target ? this.groupOf(target) : null;
    const group = targetGroup !== null ? this.groups.get(targetGroup) : undefined;
    if (group?.folded) this.unfoldGroup(group, 'restore');
    rlog('info', '[GROUP] restored', { groups: this.groups.size, tabs: members, repaired: moved });
  }
  // --- end tab groups ---

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

  /**
   * Main asks for the quit / red-button confirmations (v1.19; main/close-confirm.ts)
   * instead of showing a native box that ⌘W cannot answer. Shown with the same
   * dialog and keys as the last-tab ⌘W: Quit/Close Window is focused, so Enter
   * confirms, ⌘W confirms (closeActivePane → confirmByShortcut), a second ⌘Q
   * is confirmed by main (it sends a dismiss), Esc and Cancel cancel.
   */
  private listenForMainConfirmations(): void {
    const guard = window.patton.closeGuard;
    const offRequest = guard.onConfirmRequest((request) => {
      this.showMainConfirm(request).catch((err) => rlog('error', '[CLOSE] main confirmation failed', { err: String(err) }));
    });
    const offDismiss = guard.onConfirmDismiss((requestId) => {
      if (this.mainConfirmId !== requestId) return;
      rlog('info', '[CLOSE] main took its confirmation down', { requestId });
      this.confirmDialog.dismiss();
    });
    // The stubbed window.patton of the jsdom checks returns promises here.
    for (const off of [offRequest, offDismiss]) if (typeof off === 'function') this.disposables.push(off);
  }

  private async showMainConfirm(request: ConfirmRequest): Promise<void> {
    const { requestId, kind, terminals } = request;
    const count = `${terminals} terminal${terminals === 1 ? '' : 's'}`;
    let title: string;
    let message: string;
    let confirmLabel: string;
    if (kind === 'quit') {
      title = 'Quit Patton?';
      message = `${count} still running. Quitting ends every terminal session and any process running inside them (Claude Code conversations, dev servers, watchers, remote shells). Transcripts on disk are kept; in-memory session state is not.`;
      confirmLabel = 'Quit';
    } else {
      title = 'Close this window?';
      message = `${count} still running in this window. Closing it ends them and any process running inside them. Your other windows stay open.`;
      confirmLabel = 'Close Window';
    }
    // A dialog of ours that is already up (say "Close this tab?") gives way:
    // confirm() cancels it, and the user is asked about the bigger thing.
    if (this.confirmDialog.isOpen) rlog('info', '[CLOSE] main confirmation replaces an open dialog', { requestId });
    this.mainConfirmId = requestId;
    rlog('info', '[CLOSE] confirm shown', { kind: `main-${kind}`, requestId, terminals, defaultFocus: 'confirm' });
    // confirm() builds the dialog synchronously, so the ack below really means "on screen".
    const answered = this.confirmDialog.confirm({
      title,
      message,
      confirmLabel,
      cancelLabel: 'Cancel',
      defaultFocus: 'confirm',
      shortcutConfirms: true,
      // A double-tapped ⌘W is not a decision about quitting (main applies the same dwell to ⌘Q).
      shortcutDwellMs: CONFIRM_SHORTCUT_DWELL_MS,
      // An Enter already in flight when the dialog appears must not quit.
      confirmDwellMs: CONFIRM_SHORTCUT_DWELL_MS,
    });
    let acked = false;
    try {
      acked = (await this.askMain('confirm-ack', () => window.patton.closeGuard.ackConfirm(requestId))).value === true;
    } catch {
      acked = false;
    }
    if (!acked) {
      // Main no longer wants it (it timed out and went native, or the request is stale).
      rlog('warn', '[CLOSE] main did not accept the confirmation ack; dialog withdrawn', { requestId });
      if (this.mainConfirmId === requestId) this.confirmDialog.dismiss();
      await answered;
      if (this.mainConfirmId === requestId) this.mainConfirmId = null;
      // Tell main it was withdrawn: when main did record the ack (the reply was
      // lost or slow) it would otherwise stay "acked" for a dialog that is gone,
      // hold the red button and let the next ⌘Q quit unasked. A request main
      // already retired ignores this.
      try {
        await window.patton.closeGuard.answerConfirm(requestId, false);
      } catch (err) {
        rlog('warn', '[CLOSE] could not tell main the confirmation was withdrawn', { requestId, err: String(err) });
      }
      return;
    }
    const ok = await answered;
    const by = this.confirmDialog.lastAnswer;
    const dismissedByMain = by === 'dismissed';
    const superseded = by === 'superseded';
    if (this.mainConfirmId === requestId) this.mainConfirmId = null;
    rlog('info', '[CLOSE] confirm answered', { kind: `main-${kind}`, requestId, ok, by });
    // Main took it down itself (it has the answer), or another dialog replaced
    // ours: there is nothing to tell it.
    if (dismissedByMain) return;
    try {
      await window.patton.closeGuard.answerConfirm(requestId, ok && !superseded);
    } catch (err) {
      rlog('warn', '[CLOSE] could not send the confirmation answer', { requestId, err: String(err) });
    }
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
      // Enter / a click wait out the dwell; the second ⌘W does not (shortcutDwellMs stays 0).
      confirmDwellMs: CONFIRM_SHORTCUT_DWELL_MS,
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
    // Numbered as ⌘1–9 count: visible tabs only; a tab in a folded group
    // names its group instead.
    let visibleCount = 0;
    this.tabs.forEach((tab) => {
      const visible = this.isTabVisible(tab);
      if (visible) visibleCount++;
      const groupId = visible ? null : this.groupOf(tab);
      const hiddenIn = groupId !== null ? this.groups.get(groupId) : undefined;
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
          tabIndex: visible ? visibleCount : 0,
          foldedGroup: hiddenIn ? this.groupLabel(hiddenIn) : null,
          paneCount: tab.panes.length,
          project,
          projectName: project ? projectName(project) : null,
          worktree: project ? projectDisplay(project).worktree : null,
          cwd: pane.getCwd(),
          tabTitle: tab.title,
          hasCustomTitle: tab.hasCustomTitle,
          // A shell at its prompt gives '' (not "Terminal"), so the palette
          // tells two idle shells of a split apart by their folders.
          paneTitle: !pane.isClaudePane && pane.shownTitle === SHELL_TITLE ? '' : pane.shownTitle,
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
      // A review tab is not saved (docs/review-tab.md R9): after a relaunch it
      // would come back as the bare shell it lies over. Kept only when it is
      // all there is, so the session is never saved empty.
      const kept = this.tabs.filter((t) => !this.reviewTabs.viewOf(t));
      const tabs = kept.length > 0 ? kept : [...this.tabs];
      const results = await Promise.allSettled(tabs.map(t => t.serializeTree()));
      const tabStates: SessionTabState[] = [];
      const usedGroups = new Set<string>();
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') return;
        const groupId = this.groupOf(tabs[i]);
        if (groupId !== null && this.groups.has(groupId)) {
          usedGroups.add(groupId);
          tabStates.push({ ...r.value, groupId });
        } else {
          tabStates.push(r.value);
        }
      });
      if (tabStates.length === 0) {
        console.warn('Failed to save session: no tabs serialized successfully');
        return;
      }
      // Adjust active index if some tabs failed serialization
      // (By the saved tabs: a review tab in front counts as the tab before it.)
      let activeIdx = 0;
      if (this.activeTab) {
        const all = this.tabs.indexOf(this.activeTab);
        activeIdx = Math.max(0, tabs.filter((t) => this.tabs.indexOf(t) <= all).length - 1);
      }
      const session: SessionState = {
        tabs: tabStates,
        activeTabIndex: Math.min(Math.max(0, activeIdx), tabStates.length - 1),
      };
      const groups = [...this.groups.values()].filter((g) => usedGroups.has(g.id));
      if (groups.length > 0) session.groups = groups.map((g) => ({ id: g.id, name: g.name, folded: g.folded }));
      session.sessionBar = { minimized: this.sessionBar.isMinimized };
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
      // D2: the window's bar choice; absent in sessions saved before the bar.
      this.sessionBar.setMinimized(session.sessionBar?.minimized === true, 'restore');

      const savedActive = Math.max(0, Math.min(session.activeTabIndex, session.tabs.length - 1));
      let startupTab: Tab | null = null;
      const savedGroupOf = new Map<Tab, string>();
      for (const [index, tabState] of session.tabs.entries()) {
        try {
          const tab = await Tab.createFromSession(tabState);
          if (typeof tabState.groupId === 'string') savedGroupOf.set(tab, tabState.groupId);
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
          tab.setComposeOverBar(this.currentComposeOverBar);
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
      const target = startupTab && this.tabs.includes(startupTab)
        ? startupTab
        : (this.tabs.length > 0 ? this.tabs[Math.max(0, activeIdx)] : null);
      this.restoreGroups(session, savedGroupOf, target);
      if (target) this.switchToId(target.id);

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
      // A title Claude set names Claude's topic, not the shell that reopens.
      title: pane.isClaudePane ? SHELL_TITLE : pane.shownTitle,
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
    if (state.title && state.title !== SHELL_TITLE) {
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
    this.normaliseGroups();
    this.tabBar.update(
      this.tabs.map(t => ({
        groupId: this.groupOf(t),
        id: t.id,
        title: t.title,
        displayTitle: t.displayTitle,
        autoTitle: t.autoTitle,
        project: t.menuProject ? projectRenameFields(t.menuProject) : null,
        namedForProject: t.namedForProject,
        active: t.id === this.activeTab?.id,
        awaitingInput: t.awaitingInput,
        checkpointDone: t.checkpointDone,
        flag: t.flag,
        autoFlag: t.autoFlag,
        parked: t.parked,
        waitingText: t.waitingText,
        wake: isWakeTab(t),
      })),
      [...this.groups.values()].map((g) => ({ ...g })),
    );
    // Every tab change funnels through here, so the bookmarks sidebar hears it too.
    this.onTabsChanged?.();
    this.updateCheckpoint();
  }

  // ---- Checkpoint clock (services/checkpoint-clock.ts) ----

  /** Settings → "Checkpoint reminder after N% of the context window since the last checkpoint". */
  setCheckpointNudgePct(pct: number): void {
    this.checkpointNudgePct = pct;
    this.updateCheckpoint();
  }

  /** Show the active tab's focused pane's checkpoint clock, which lives in the
   *  session bar only (docs/session-bar.md D7). */
  private updateCheckpoint(): void {
    const pane = this.activeTab?.focusedPane;
    const view = checkpointView(pane ? pane.checkpointSource : null, this.checkpointNudgePct);
    this.updateSessionBar(view);
  }

  // ---- Session bar (components/session-bar.ts) ----

  /** The bar follows the active tab's focused pane while it runs Claude (D1).
   *  Every tab switch, focus change and Claude start or exit reaches here
   *  through updateCheckpoint. */
  private updateSessionBar(view: ReturnType<typeof checkpointView>): void {
    const tab = this.activeTab;
    const pane = tab?.focusedPane ?? null;
    const showing = pane !== null && pane.isClaudePane && pane.title !== WAKE_TITLE;
    let target: SessionBarTarget | null = null;
    if (tab && pane && showing) {
      target = this.barTargets.get(pane) ?? null;
      if (!target) {
        target = {
          paneId: pane.id,
          model: pane.sessionBarModel,
          project: null,
          widthInfo: () => pane.sessionBarWidthInfo(),
        };
        this.barTargets.set(pane, target);
      }
      const claudePanes = tab.panes.filter((p) => p.isClaudePane).length;
      target.project = claudePanes > 1 && tab.project ? projectName(tab.project) : null;
    }
    this.sessionBar.follow(target);
    this.sessionBar.setCheckpoint(target ? view : null);
  }

  /** The bar opened, folded or hid: fit the active tab's terminals once the
   *  layout has the new width, through each pane's normal resize path (its
   *  observer would, 100 ms later). A tab switch with the same bar state calls
   *  nothing; a tab hidden meanwhile refits from its own observer when shown.
   *  A width change from the UI text scale reaches the observers alone. */
  private refitForBar(): void {
    const tab = this.activeTab;
    if (!tab) return;
    requestAnimationFrame(() => {
      if (this.activeTab !== tab) return;
      for (const p of tab.panes) p.refitAfterLayout();
    });
  }

  private paneForPty(ptyId: number): Pane | null {
    const known = this.panesByPtyId.get(ptyId);
    if (known && known.ptyId === ptyId) return known;
    // A respawned pane's new pty may not be in the map: look.
    for (const tab of this.tabs) {
      for (const p of tab.panes) if (p.ptyId === ptyId) return p;
    }
    return null;
  }

  /** A link row's click (D6, D12): a web URL through openExternal, a file
   *  through the editor path, both judged by main (link-open-policy.ts). */
  private async openBarLink(link: LinkRow): Promise<void> {
    try {
      if (link.url) {
        const target = resolveHyperlink(link.url, '', []);
        if (target.kind !== 'web') {
          rlog('warn', '[BAR] link refused', { kind: link.kind });
          return;
        }
        await window.patton.openExternal(target.url);
      } else if (link.path) {
        await window.patton.editor.openFile(link.path);
      } else {
        return;
      }
      rlog('info', '[BAR] link open', { kind: link.kind });
    } catch (err) {
      rlog('warn', '[BAR] link open failed', { kind: link.kind, error: String(err) });
    }
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
        // flip then leaves its text (and so its DOM) unchanged. A shell's
        // reads "Terminal", not a title Claude left when it quit.
        title: pane.shownTitle,
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
        checkpointDone: pane.checkpointDone,
      };
      return { focused, input };
    });
    return hoverBlocks(panes, Date.now());
  }

  /** The clock's click and the palette's "Checkpoint this session". Never
   *  rejects: a failure is logged and announced. */
  async runCheckpoint(): Promise<void> {
    const pane = this.activeTab?.focusedPane;
    if (!pane) return;
    let why: string | null;
    try {
      why = await pane.runCheckpoint();
    } catch (err) {
      rlog('error', '[CKPT] run failed', { pane: pane.id, error: String(err) });
      why = 'Checkpoint failed';
    }
    if (why) {
      // Seen and heard, from the clock's click and the palette alike.
      announce(why, 'assertive');
      this.sessionBar.showCheckpointReason(why);
    }
    // The click left focus on the bar's button; the keyboard belongs to Claude.
    pane.focus();
  }

  // --- Pause all (tab strip button; main/pause-all.ts runs a press in every window) ---

  /** Main asks this window to act on its panes. */
  private listenForPauseAll(): void {
    const offRun = window.patton.pauseAll.onRun((request) => {
      if (!request || typeof request.requestId !== 'string') return;
      void this.answerPauseAll(request.requestId);
    });
    if (typeof offRun === 'function') this.disposables.push(offRun);
  }

  /** Run main's request in this window and send the report back; on failure
   *  an empty report, so main isn't left waiting. */
  private async answerPauseAll(requestId: string): Promise<void> {
    let report: PauseAllReport;
    try {
      report = await this.runPauseAll();
    } catch (err) {
      rlog('error', '[PAUSE-ALL] run failed', { error: String(err) });
      report = emptyReport();
    }
    try {
      await window.patton.pauseAll.report(requestId, report);
    } catch (err) {
      rlog('error', '[PAUSE-ALL] report failed', { requestId, error: String(err) });
    }
  }

  /** Type the word into this window's panes by the Pause all rules, and log
   *  one line: the pane ids sent to and the ones skipped, with reasons. Reads
   *  main's unsent-input state for every pane and the stash key first. */
  async runPauseAll(): Promise<PauseAllReport> {
    const entries: { pane: Pane; title: string }[] = [];
    for (const tab of this.tabs) for (const pane of tab.panes) entries.push({ pane, title: tab.title });
    const ids = entries.map((e) => e.pane.ptyId ?? -1);
    const [states, key] = await Promise.all([
      window.patton.pty.inputState(ids.filter((id) => id >= 0)),
      window.patton.pauseAll.stashKey(),
    ]);
    const byPty = new Map<number, (typeof states)[number]>();
    ids.filter((id) => id >= 0).forEach((id, i) => byPty.set(id, states[i] ?? null));
    const targets: PauseTarget[] = entries.map(({ pane, title }) => {
      const ptyId = pane.ptyId;
      return {
        id: pane.id,
        title,
        input: pane.pauseInput(ptyId === null ? null : byPty.get(ptyId) ?? null),
        send: (stash: boolean) => pane.typePauseWord({ stash }),
      };
    });
    const run = await runPause(targets, key);
    rlog('info', '[PAUSE-ALL] run', {
      sent: run.sent, queued: run.report.queued, skipped: run.skipped,
      ...(run.unsettled.length > 0 ? { unsettled: run.unsettled } : {}),
      ...('why' in key ? { stashKey: key.why } : {}),
    });
    return run.report;
  }

  /** The button's click: main runs a pause in every window and answers with
   *  the totals, shown on the button and announced. Never rejects: a failure
   *  is logged and announced. */
  async pressPauseAll(): Promise<void> {
    if (this.pausePressInFlight) return;
    this.pausePressInFlight = true;
    const focusAfter = this.activeTab?.focusedPane ?? null;
    try {
      const outcome = await window.patton.pauseAll.press();
      if (!outcome) {
        const why = 'Pause all is busy: try again in a moment';
        rlog('info', '[PAUSE-ALL] press refused by main');
        announce(why, 'assertive');
        this.tabBar.showPauseResult(why);
        return;
      }
      const summary = pauseSummary(outcome);
      rlog('info', '[PAUSE-ALL] press', {
        sent: outcome.sent, queued: outcome.queued, skipped: outcome.skipped,
        windows: outcome.windows, answered: outcome.answered,
      });
      announce(summary, 'assertive');
      this.tabBar.showPauseResult(summary);
    } catch (err) {
      rlog('error', '[PAUSE-ALL] press failed', { error: String(err) });
      announce('Pause all failed', 'assertive');
      this.tabBar.showPauseResult('Pause all failed');
    } finally {
      this.pausePressInFlight = false;
      // The click left focus on the strip's button; the keyboard belongs to the terminal.
      focusAfter?.focus();
    }
  }
  // --- end Pause all ---

  dispose(): void {
    for (const d of this.disposables) d();
    this.reviewTabs.dispose();
    for (const tab of this.tabs) tab.dispose();
    this.sessionBar.dispose();
    this.tabBar.dispose();
    this.confirmDialog.dispose();
  }
}
