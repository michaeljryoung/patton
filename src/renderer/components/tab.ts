import { Pane } from './pane';
import { SplitContainer } from './split-container';
import { SearchOverlay } from './search-overlay';
import {
  splitPane as splitPaneInTree,
  closePane as closePaneInTree,
  findPaneInDirection as findPaneInDir,
  isPane,
  type SplitTreeNode,
  type SplitDirection,
} from './split-tree';
import type { InputMode } from '../../shared/types';

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

  private createPaneInstance(): Pane {
    const pane = new Pane({
      onFocus: (p) => this.setFocusedPane(p),
      onTitleChange: (p) => {
        if (p === this._focusedPane) {
          this.title = p.title;
          this.onTitleChanged?.();
        }
      },
      onCommandDone: () => this.onCommandDone?.(),
    });
    pane.element.addEventListener('pane-split', ((e: CustomEvent) => {
      if (e.detail === 'vertical') this.splitVertical();
      else if (e.detail === 'horizontal') this.splitHorizontal();
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
    this.title = pane.title;
  }

  get focusedPane(): Pane {
    return this._focusedPane;
  }

  get panes(): readonly Pane[] {
    return this._panes;
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

  focusPaneInDirection(direction: 'up' | 'down' | 'left' | 'right'): void {
    const target = findPaneInDir(this.rootNode, this._focusedPane, direction);
    if (target) {
      this.setFocusedPane(target);
      target.focus();
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
    await this._focusedPane.init();
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

  clear(): void {
    this._focusedPane.clear();
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
