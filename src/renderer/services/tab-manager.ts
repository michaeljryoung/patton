import { Tab } from '../components/tab';
import { Pane } from '../components/pane';
import { TabBar } from '../components/tab-bar';
import { HistoryManager } from './history-manager';
import { announce } from './announcer';
import type { SessionState } from '../../shared/types';
import type { ITheme } from '@xterm/xterm';

interface ClosedPaneState {
  cwd: string;
  scrollback: string;
  title: string;
}

export class TabManager {
  private tabs: Tab[] = [];
  private activeTab: Tab | null = null;
  private tabBar: TabBar;
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
  private currentTerminalTheme: ITheme | null = null;

  constructor(
    tabBarContainer: HTMLElement,
    contentContainer: HTMLElement,
    options?: { onSettings?: () => void; onCommandDone?: (tabId: string, tabTitle: string) => void },
  ) {
    this.contentContainer = contentContainer;

    this.tabBar = new TabBar(tabBarContainer, {
      onSelect: (id) => this.switchToId(id),
      onClose: (id) => { this.closeById(id).catch(console.error); },
      onNew: () => { this.createTab().catch(console.error); },
      onReorder: (fromId, toId) => this.reorder(fromId, toId),
      onSettings: () => options?.onSettings?.(),
      onRename: (id, name) => this.renameTab(id, name),
    });
    this.onCommandDone = options?.onCommandDone || null;

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

  setTerminalTheme(theme: ITheme | null): void {
    this.currentTerminalTheme = theme;
    for (const tab of this.tabs) {
      tab.setTerminalTheme(theme);
    }
  }

  async createTab(cwd?: string): Promise<Tab> {
    // Only use explicitly provided CWD (e.g. session restore, reopen closed).
    // New tabs (Cmd+T / +) start at home directory.
    const tab = new Tab(cwd);
    if (this.currentShell) tab.setShell(this.currentShell);
    tab.setHistoryManager(this.sharedHistory);
    tab.setRegistrationCallbacks(
      (pane) => this.registerPane(pane),
      (pane) => this.unregisterPane(pane),
      () => this.updateTabBar(),
      () => this.onCommandDone?.(tab.id, tab.title),
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
    if (this.currentTerminalTheme) {
      tab.setTerminalTheme(this.currentTerminalTheme);
    }

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

  renameTab(id: string, name: string): void {
    const tab = this.tabs.find(t => t.id === id);
    if (tab) {
      tab.setCustomTitle(name);
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

    tab.dispose();
    this.tabs.splice(idx, 1);
    announce(`Closed tab: ${closedTitle}`);

    if (this.tabs.length === 0) {
      window.close();
      return;
    }

    if (this.activeTab?.id === id) {
      const newIdx = Math.min(idx, this.tabs.length - 1);
      this.switchToId(this.tabs[newIdx].id);
    } else {
      this.updateTabBar();
    }
  }

  async closeActiveTab(): Promise<void> {
    if (this.activeTab) {
      await this.closeById(this.activeTab.id);
    }
  }

  async closeActivePane(): Promise<void> {
    if (!this.activeTab) return;
    if (this.activeTab.panes.length <= 1) {
      await this.closeById(this.activeTab.id);
    } else {
      // Save focused pane state before closing it
      this.saveClosedPane(this.activeTab.focusedPane);
      this.activeTab.closePane();
    }
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

  getTabCount(): number {
    return this.tabs.length;
  }

  isActiveTab(tabId: string): boolean {
    return this.activeTab?.id === tabId;
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

  async restoreSession(): Promise<boolean> {
    try {
      const session = await window.patton.session.get();
      if (!session || !session.tabs || session.tabs.length === 0) return false;

      for (const tabState of session.tabs) {
        try {
          const tab = await Tab.createFromSession(tabState);

          if (this.currentShell) tab.setShell(this.currentShell);
          tab.setHistoryManager(this.sharedHistory);
          tab.setRegistrationCallbacks(
            (pane) => this.registerPane(pane),
            (pane) => this.unregisterPane(pane),
            () => this.updateTabBar(),
            () => this.onCommandDone?.(tab.id, tab.title),
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
          if (this.currentTerminalTheme) {
            tab.setTerminalTheme(this.currentTerminalTheme);
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

      // Switch to the previously active tab
      const activeIdx = Math.min(session.activeTabIndex, this.tabs.length - 1);
      if (this.tabs.length > 0) {
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
      tab.setCustomTitle(state.title);
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
        active: t.id === this.activeTab?.id,
      })),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d();
    for (const tab of this.tabs) tab.dispose();
    this.tabBar.dispose();
  }
}
