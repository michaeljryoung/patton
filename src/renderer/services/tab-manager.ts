import { Tab } from '../components/tab';
import { Pane } from '../components/pane';
import { TabBar } from '../components/tab-bar';

export class TabManager {
  private tabs: Tab[] = [];
  private activeTab: Tab | null = null;
  private tabBar: TabBar;
  private contentContainer: HTMLElement;
  private disposables: (() => void)[] = [];
  private currentFontSize: number | undefined;
  private panesByPtyId: Map<number, Pane> = new Map();

  constructor(
    tabBarContainer: HTMLElement,
    contentContainer: HTMLElement,
    options?: { onSettings?: () => void },
  ) {
    this.contentContainer = contentContainer;

    this.tabBar = new TabBar(tabBarContainer, {
      onSelect: (id) => this.switchToId(id),
      onClose: (id) => { this.closeById(id).catch(console.error); },
      onNew: () => { this.createTab().catch(console.error); },
      onReorder: (fromId, toId) => this.reorder(fromId, toId),
      onSettings: () => options?.onSettings?.(),
    });

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

  setFontSize(size: number): void {
    this.currentFontSize = size;
    for (const tab of this.tabs) {
      tab.setFontSize(size);
    }
  }

  async createTab(): Promise<Tab> {
    const tab = new Tab();
    tab.setRegistrationCallbacks(
      (pane) => this.registerPane(pane),
      (pane) => this.unregisterPane(pane),
      () => this.updateTabBar(),
    );
    this.tabs.push(tab);
    this.contentContainer.appendChild(tab.element);

    // Apply current font size to new tab before init
    if (this.currentFontSize !== undefined) {
      tab.setFontSize(this.currentFontSize);
    }

    await tab.init();

    // Register the initial pane now that it has a ptyId
    for (const pane of tab.panes) {
      this.registerPane(pane);
    }

    this.switchToId(tab.id);
    return tab;
  }

  switchToId(id: string): void {
    const tab = this.tabs.find(t => t.id === id);
    if (!tab) return;

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

    // Check if any pane has an active process (passthrough mode = TUI running)
    const hasActiveProcess = tab.panes.some(p => p.getMode() === 'passthrough');
    if (hasActiveProcess) {
      const proceed = window.confirm('A process is still running in this tab. Close anyway?');
      if (!proceed) return;
    }

    tab.dispose();
    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) {
      await this.createTab();
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
      this.activeTab.closePane();
    }
  }

  splitVertical(): void {
    this.activeTab?.splitVertical();
  }

  splitHorizontal(): void {
    this.activeTab?.splitHorizontal();
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
