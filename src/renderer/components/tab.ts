import { Pane } from './pane';
import { SplitContainer } from './split-container';
import { SearchOverlay } from './search-overlay';
import { HistoryManager } from '../services/history-manager';
import {
  splitPane as splitPaneInTree,
  closePane as closePaneInTree,
  findPaneInDirection as findPaneInDir,
  swapPanes as swapPanesInTree,
  isPane,
  type SplitTreeNode,
  type SplitDirection,
} from './split-tree';
import type { InputMode, SessionTreeNode, SessionTabState, SessionPaneState } from '../../shared/types';
import type { ITheme } from '@xterm/xterm';

let tabIdCounter = 0;

export class Tab {
  readonly id: string;
  readonly element: HTMLElement;
  private _focusedPane: Pane;
  private _panes: Pane[] = [];
  private rootNode: SplitTreeNode;
  private splitContainers: SplitContainer[] = [];
  private onPaneRegistered: ((pane: Pane) => void) | null = null;
  private onPaneUnregistered: ((pane: Pane) => void) | null = null;
  private onTitleChanged: (() => void) | null = null;
  private onCommandDone: (() => void) | null = null;
  title = 'Terminal';
  private _customTitle = false;
  private _broadcastInput = false;
  private _shell: string | undefined;
  private _historyManager: HistoryManager | undefined;

  constructor() {
    this.id = `tab-${++tabIdCounter}`;

    // Create DOM structure
    this.element = document.createElement('div');
    this.element.className = 'tab-content';
    this.element.id = this.id;
    this.element.setAttribute('role', 'tabpanel');

    // Create the initial pane
    const pane = this.createPaneInstance();
    this._focusedPane = pane;
    this.rootNode = pane;
    this.element.appendChild(pane.element);
  }

  setShell(shell: string): void {
    this._shell = shell;
  }

  setHistoryManager(hm: HistoryManager): void {
    this._historyManager = hm;
  }

  private createPaneInstance(cwd?: string): Pane {
    const pane = new Pane({
      ...(cwd ? { cwd } : {}),
      ...(this._shell ? { shell: this._shell } : {}),
      ...(this._historyManager ? { historyManager: this._historyManager } : {}),
      onFocus: (p) => this.setFocusedPane(p),
      onTitleChange: (p) => {
        if (p === this._focusedPane && !this._customTitle) {
          this.title = p.title;
          this.onTitleChanged?.();
        }
      },
      onCommandDone: () => this.onCommandDone?.(),
      onBroadcastWrite: (data) => {
        if (!this._broadcastInput) return;
        // Write to all OTHER panes
        for (const p of this._panes) {
          if (p !== pane && p.ptyId !== null) {
            window.patton.pty.write(p.ptyId, data);
          }
        }
      },
    });
    pane.element.addEventListener('pane-split', ((e: CustomEvent) => {
      if (e.detail === 'vertical') this.splitVertical().catch(console.error);
      else if (e.detail === 'horizontal') this.splitHorizontal().catch(console.error);
    }) as EventListener);
    pane.element.addEventListener('pane-swap', ((e: CustomEvent) => {
      const { sourceId, targetId } = e.detail;
      this.handlePaneSwap(sourceId, targetId);
    }) as EventListener);
    this._panes.push(pane);
    return pane;
  }

  setRegistrationCallbacks(
    onRegister: (pane: Pane) => void,
    onUnregister: (pane: Pane) => void,
    onTitleChange?: () => void,
    onCommandDone?: () => void,
  ): void {
    this.onPaneRegistered = onRegister;
    this.onPaneUnregistered = onUnregister;
    this.onTitleChanged = onTitleChange || null;
    this.onCommandDone = onCommandDone || null;
    // Register existing panes
    for (const pane of this._panes) {
      onRegister(pane);
    }
  }

  private setFocusedPane(pane: Pane): void {
    if (this._focusedPane === pane) return;
    this._focusedPane.setFocused(false);
    this._focusedPane = pane;
    this._focusedPane.setFocused(true);
    // Explicitly focus after enabling — the textarea was disabled so the
    // browser won't auto-focus it from the click that triggered this switch.
    requestAnimationFrame(() => pane.focus());
    if (!this._customTitle) {
      this.title = pane.title;
    }
  }

  get focusedPane(): Pane {
    return this._focusedPane;
  }

  get panes(): readonly Pane[] {
    return this._panes;
  }

  toggleBroadcastInput(): void {
    this._broadcastInput = !this._broadcastInput;
    // Visual indicator: add/remove glow on all panes
    for (const pane of this._panes) {
      pane.element.classList.toggle('broadcast', this._broadcastInput);
    }
  }

  get isBroadcasting(): boolean {
    return this._broadcastInput;
  }

  /** Write data to all panes in this tab (for broadcast mode) */
  broadcastWrite(data: string): void {
    for (const pane of this._panes) {
      if (pane.ptyId !== null) {
        window.patton.pty.write(pane.ptyId, data);
      }
    }
  }

  setCustomTitle(name: string): void {
    this.title = name;
    this._customTitle = true;
    this.onTitleChanged?.();
  }

  get hasCustomTitle(): boolean {
    return this._customTitle;
  }

  // ---- Split operations ----

  async splitVertical(): Promise<void> {
    await this.split('vertical');
  }

  async splitHorizontal(): Promise<void> {
    await this.split('horizontal');
  }

  private splitting = false;
  private async split(direction: SplitDirection): Promise<void> {
    if (this.splitting) return; // Prevent concurrent splits
    this.splitting = true;
    try {
      const newPane = this.createPaneInstance();

      // Update tree
      this.rootNode = splitPaneInTree(this.rootNode, this._focusedPane, newPane, direction);

      // Initialize the new pane's PTY and register for PTY routing
      await newPane.init();
      this.onPaneRegistered?.(newPane);

      // Set focus state BEFORE re-rendering so the focus protection
      // layers know which pane is active immediately after DOM rebuild.
      this.setFocusedPane(newPane);

      // Re-render DOM (after PTY init so the pane is ready)
      this.renderTree();

      // Fit all panes immediately (don't wait for 100ms resize debounce)
      for (const pane of this._panes) {
        pane.show();
      }

      // Focus the new pane after DOM is rebuilt
      requestAnimationFrame(() => newPane.focus());
    } finally {
      this.splitting = false;
    }
  }

  closePane(target?: Pane): void {
    const pane = target || this._focusedPane;
    if (this._panes.length <= 1) return; // Don't close last pane

    // Remove from tree
    const newRoot = closePaneInTree(this.rootNode, pane);
    if (!newRoot) return;

    // If the closed pane was focused, switch to another
    const wasClosingFocused = pane === this._focusedPane;

    // Unregister and dispose
    this.onPaneUnregistered?.(pane);
    const idx = this._panes.indexOf(pane);
    if (idx !== -1) this._panes.splice(idx, 1);
    pane.dispose();

    this.rootNode = newRoot;

    // Set focus BEFORE DOM rebuild so focus protection works immediately
    if (wasClosingFocused && this._panes.length > 0) {
      this.setFocusedPane(this._panes[0]);
    }

    this.renderTree();

    // Fit remaining panes and restore focus after DOM rebuild
    for (const pane of this._panes) {
      pane.show();
    }
    if (wasClosingFocused) {
      requestAnimationFrame(() => this._focusedPane.focus());
    }
  }

  private handlePaneSwap(sourceId: string, targetId: string): void {
    const source = this._panes.find(p => p.id === sourceId);
    const target = this._panes.find(p => p.id === targetId);
    if (!source || !target || source === target) return;

    if (swapPanesInTree(this.rootNode, source, target)) {
      this.renderTree();
      // Fit all panes after DOM rebuild
      for (const pane of this._panes) {
        pane.show();
      }
    }
  }

  focusPaneInDirection(direction: 'up' | 'down' | 'left' | 'right'): void {
    const target = findPaneInDir(this.rootNode, this._focusedPane, direction);
    if (target) {
      this.setFocusedPane(target);
      // focus is deferred via rAF inside setFocusedPane to allow textarea enable transition
    }
  }

  // ---- DOM rendering ----

  private renderTree(): void {
    // Dispose old split containers
    for (const sc of this.splitContainers) {
      sc.dispose();
    }
    this.splitContainers = [];

    // Clear the tab element
    while (this.element.firstChild) {
      this.element.removeChild(this.element.firstChild);
    }

    // Detach all pane elements (they survive re-rendering)
    for (const pane of this._panes) {
      if (pane.element.parentNode) {
        pane.element.parentNode.removeChild(pane.element);
      }
    }

    // Build DOM from tree
    const rootEl = this.buildDomNode(this.rootNode);
    this.element.appendChild(rootEl);
  }

  private buildDomNode(node: SplitTreeNode): HTMLElement {
    if (isPane(node)) {
      return node.element;
    }

    const firstEl = this.buildDomNode(node.children[0]);
    const secondEl = this.buildDomNode(node.children[1]);

    const container = new SplitContainer(
      node.direction,
      node.ratio,
      firstEl,
      secondEl,
      (newRatio) => {
        node.ratio = newRatio;
      },
    );
    this.splitContainers.push(container);
    return container.element;
  }

  // ---- Forwarded to focused pane ----

  get ptyId(): number | null {
    return this._focusedPane.ptyId;
  }

  get searchOverlay(): SearchOverlay {
    return this._focusedPane.searchOverlay;
  }

  async init(): Promise<void> {
    // Initialize ALL panes in parallel (each creates its own PTY)
    await Promise.all(this._panes.map(pane => pane.init()));
    this._focusedPane.setFocused(true);
  }

  setProcessName(name: string): void {
    this._focusedPane.setProcessName(name);
  }

  getMode(): InputMode {
    return this._focusedPane.getMode();
  }

  togglePassthrough(): void {
    this._focusedPane.togglePassthrough();
  }

  showHistorySearch(): void {
    this._focusedPane.showHistorySearch();
  }

  show(): void {
    this.element.style.display = 'flex';
    for (const pane of this._panes) {
      pane.show();
    }
    // Deferred to ensure focus wins over xterm.js internal focus grabs from fit()
    requestAnimationFrame(() => this._focusedPane.focus());
  }

  hide(): void {
    this.element.style.display = 'none';
  }

  setFontSize(size: number): void {
    for (const pane of this._panes) {
      pane.setFontSize(size);
    }
  }

  setFontFamily(family: string): void {
    for (const pane of this._panes) {
      pane.setFontFamily(family);
    }
  }

  setScrollback(lines: number): void {
    for (const pane of this._panes) {
      pane.setScrollback(lines);
    }
  }

  setCopyOnSelect(enabled: boolean): void {
    for (const pane of this._panes) {
      pane.setCopyOnSelect(enabled);
    }
  }

  setTerminalTheme(theme: ITheme | null): void {
    for (const pane of this._panes) {
      pane.setTerminalTheme(theme);
    }
  }

  clear(): void {
    this._focusedPane.clear();
  }

  getScrollbackContent(): string {
    return this._focusedPane.getScrollbackContent();
  }

  /** Serialize the tab's tree structure for session save */
  async serializeTree(): Promise<SessionTabState> {
    const serialize = async (node: SplitTreeNode): Promise<SessionTreeNode> => {
      if (isPane(node)) {
        const pane = node as Pane;
        let cwd = '';
        if (pane.ptyId !== null) {
          try { cwd = await window.patton.pty.getCwd(pane.ptyId); } catch { /* ignore */ }
        }
        return { cwd: cwd || '' } as SessionPaneState;
      }
      const split = node as { direction: 'vertical' | 'horizontal'; ratio: number; children: [SplitTreeNode, SplitTreeNode] };
      const [c0, c1] = await Promise.all([serialize(split.children[0]), serialize(split.children[1])]);
      return { type: 'split', direction: split.direction, ratio: split.ratio, children: [c0, c1] };
    };

    const focusedIndex = this._panes.indexOf(this._focusedPane);
    return {
      title: this._customTitle ? this.title : undefined,
      customTitle: this._customTitle || undefined,
      tree: await serialize(this.rootNode),
      focusedPaneIndex: focusedIndex >= 0 ? focusedIndex : 0,
    };
  }

  /** Restore a tab from serialized session state (creates panes and splits) */
  static async createFromSession(
    state: SessionTabState,
    makeCallbacks: () => {
      onFocus: (p: Pane) => void;
      onTitleChange: (p: Pane) => void;
      onCommandDone: () => void;
    },
  ): Promise<Tab> {
    const tab = new Tab();

    // If we have a session tree, we need to rebuild the structure
    if (state.tree && 'type' in state.tree && state.tree.type === 'split') {
      // Remove the initial pane created by constructor
      const initialPane = tab._panes[0];
      tab._panes = [];

      const buildTree = (node: SessionTreeNode): { treeNode: SplitTreeNode; panes: Pane[] } => {
        if (!('type' in node) || node.type !== 'split') {
          // It's a pane
          const paneState = node as SessionPaneState;
          const pane = tab.createPaneInstance(paneState.cwd || undefined);
          return { treeNode: pane, panes: [pane] };
        }
        const left = buildTree(node.children[0]);
        const right = buildTree(node.children[1]);
        const splitNode = {
          type: 'split' as const,
          direction: node.direction,
          ratio: node.ratio,
          children: [left.treeNode, right.treeNode] as [SplitTreeNode, SplitTreeNode],
        };
        return { treeNode: splitNode, panes: [...left.panes, ...right.panes] };
      };

      const result = buildTree(state.tree);
      tab.rootNode = result.treeNode;
      // Dispose the initial pane cleanly (it never got a PTY via init(), but dispose() is safe)
      initialPane.dispose();

      // Set focused pane
      const focusIdx = Math.min(state.focusedPaneIndex, tab._panes.length - 1);
      if (tab._panes.length > 0) {
        tab._focusedPane = tab._panes[Math.max(0, focusIdx)];
      }

      // Render the split tree into the DOM (without this, pane elements are orphaned)
      tab.renderTree();
    } else if (state.tree && !('type' in state.tree)) {
      // Single pane with cwd
      const paneState = state.tree as SessionPaneState;
      if (paneState.cwd) {
        // Replace the initial pane with one that has the correct cwd
        const initialPane = tab._panes[0];
        tab._panes = [];
        initialPane.dispose();
        const pane = tab.createPaneInstance(paneState.cwd);
        tab._focusedPane = pane;
        tab.rootNode = pane;
        tab.element.appendChild(pane.element);
      }
    }

    if (state.customTitle && state.title) {
      tab.title = state.title;
      tab._customTitle = true;
    }

    return tab;
  }

  dispose(): void {
    for (const sc of this.splitContainers) {
      sc.dispose();
    }
    for (const pane of this._panes) {
      this.onPaneUnregistered?.(pane);
      pane.dispose();
    }
    this._panes = [];
    this.splitContainers = [];
    this.element.remove();
  }
}
