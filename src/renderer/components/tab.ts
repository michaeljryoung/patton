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
import type { SessionTreeNode, SessionTabState, SessionPaneState, TabFlag } from '../../shared/types';
import type { ITheme } from '@xterm/xterm';
import { DEFAULTS } from '../../shared/constants';

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
  private _zoomed = false;
  private _shell: string | undefined;
  private _historyManager: HistoryManager | undefined;
  // True when this tab is the currently-visible tab in the window.
  // Used to decide whether a prompt-ready signal should raise the
  // "awaiting input" indicator — active tabs never show it (the user
  // is already looking at them).
  private _isActive = false;
  // True when an inactive tab's shell has returned to a prompt and is
  // waiting for input. Cleared when the tab becomes active or when any
  // pane starts running a new command.
  private _awaitingInput = false;
  // User-set colour flag (right-click a tab → Flag). Unlike _awaitingInput this
  // is never touched by shell activity or by activating the tab — only the user
  // sets or clears it. See TabFlag in shared/types.ts.
  private _flag: TabFlag | null = null;

  constructor(initialCwd?: string) {
    this.id = `tab-${++tabIdCounter}`;

    // Create DOM structure
    this.element = document.createElement('div');
    this.element.className = 'tab-content';
    this.element.id = this.id;
    this.element.setAttribute('role', 'tabpanel');

    // Create the initial pane (inherit CWD if provided)
    const pane = this.createPaneInstance(initialCwd);
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
        // Path B: Claude Code signals "needs attention" by prepending "·" to
        // its terminal title via OSC 2. Treat any pane whose title arrives
        // with a leading middle-dot / bullet as awaiting input. Gated on
        // !_customTitle so a user-chosen tab name like "· notes" doesn't
        // keep the indicator permanently lit.
        if (!this._customTitle && /^[·•]/.test(p.title)) {
          this.raiseAwaitingInput();
        }
      },
      onCommandDone: () => {
        // Path A: any pane command completion (OSC 133 transition, idle
        // heuristic, bell, OSC 9) is a meaningful attention signal — the
        // signal is already transition-filtered and cross-source debounced
        // by fireCommandDone() in pane.ts.
        this.raiseAwaitingInput();
        this.onCommandDone?.();
      },
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
    // Clear the dot the instant a new command starts — the prior signal is
    // stale the moment work resumes in this pane. OSC 133 'prompt' events
    // are NOT used to SET the dot any more (they fire too liberally — on
    // every prompt redraw, resize, session restore); the SET paths are
    // onCommandDone (Path A) and the title-prefix check (Path B).
    pane.terminalView.onPromptState((state) => {
      if (state === 'command' && this._awaitingInput) {
        this._awaitingInput = false;
        this.onTitleChanged?.();
      }
    });
    this._panes.push(pane);
    return pane;
  }

  private raiseAwaitingInput(): void {
    if (this._isActive || this._awaitingInput) return;
    this._awaitingInput = true;
    this.onTitleChanged?.();
  }

  get awaitingInput(): boolean {
    return this._awaitingInput;
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

  setCustomTitle(name: string): void {
    this.title = name;
    this._customTitle = true;
    this.onTitleChanged?.();
  }

  get hasCustomTitle(): boolean {
    return this._customTitle;
  }

  /** Set or clear the manual colour flag. Passing the flag already set clears
   *  it, so picking the same colour twice toggles it off. */
  setFlag(flag: TabFlag | null): void {
    const next = this._flag === flag ? null : flag;
    if (next === this._flag) return;
    this._flag = next;
    this.onTitleChanged?.();
  }

  get flag(): TabFlag | null {
    return this._flag;
  }

  // ---- Split operations ----

  async splitVertical(cwd?: string): Promise<void> {
    await this.split('vertical', cwd);
  }

  async splitHorizontal(cwd?: string): Promise<void> {
    await this.split('horizontal', cwd);
  }

  private splitting = false;
  private async split(direction: SplitDirection, cwd?: string): Promise<void> {
    if (this.splitting) return; // Prevent concurrent splits
    if (this._panes.length >= DEFAULTS.MAX_PANES_PER_TAB) {
      this.showToast(`Maximum ${DEFAULTS.MAX_PANES_PER_TAB} panes per tab`);
      return;
    }
    this.splitting = true;
    try {
      // Use provided CWD (from focused pane) or fall back to focused pane's CWD
      const inheritedCwd = cwd || this._focusedPane.getCwd() || undefined;
      const newPane = this.createPaneInstance(inheritedCwd);

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

  toggleCompose(): void {
    this._focusedPane.toggleCompose();
  }

  showHistorySearch(): void {
    this._focusedPane.showHistorySearch();
  }

  show(): void {
    this._isActive = true;
    // Becoming active clears any pending "awaiting input" dot — user is
    // now looking at this tab. Notify so the tab-bar drops the indicator.
    const wasAwaiting = this._awaitingInput;
    this._awaitingInput = false;
    this.element.style.display = 'flex';
    for (const pane of this._panes) {
      pane.show();
    }
    // Deferred to ensure focus wins over xterm.js internal focus grabs from fit()
    requestAnimationFrame(() => this._focusedPane.focus());
    if (wasAwaiting) this.onTitleChanged?.();
  }

  hide(): void {
    this._isActive = false;
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

  setRenderer(mode: 'webgl' | 'dom'): void {
    for (const pane of this._panes) {
      pane.setRenderer(mode);
    }
  }

  setTerminalTheme(theme: ITheme | null): void {
    for (const pane of this._panes) {
      pane.setTerminalTheme(theme);
    }
  }

  // ---- Split zoom ----

  toggleZoom(): void {
    if (this._panes.length <= 1) return; // Nothing to zoom if single pane
    this._zoomed = !this._zoomed;

    if (this._zoomed) {
      // Hide all panes except the focused one
      for (const pane of this._panes) {
        if (pane !== this._focusedPane) {
          pane.element.style.display = 'none';
        }
      }
      // Hide split containers' dividers
      const dividers = this.element.querySelectorAll('.split-divider');
      for (const d of dividers) {
        (d as HTMLElement).style.display = 'none';
      }
      // Make the focused pane fill everything
      this._focusedPane.element.style.flex = '1';
      this._focusedPane.element.style.display = 'flex';
      // Hide split-container chrome but keep structure
      const containers = this.element.querySelectorAll('.split-container');
      for (const c of containers) {
        (c as HTMLElement).style.display = 'flex';
      }
    } else {
      // Restore: show all panes and dividers
      for (const pane of this._panes) {
        pane.element.style.display = 'flex';
        pane.element.style.flex = '';
      }
      const dividers = this.element.querySelectorAll('.split-divider');
      for (const d of dividers) {
        (d as HTMLElement).style.display = '';
      }
    }

    // Refit all visible panes
    requestAnimationFrame(() => {
      for (const pane of this._panes) {
        if (!this._zoomed || pane === this._focusedPane) {
          pane.show();
        }
      }
    });
  }

  get isZoomed(): boolean {
    return this._zoomed;
  }

  // ---- Prompt jumping ----

  jumpToPrompt(direction: 'up' | 'down'): void {
    this._focusedPane.jumpToPrompt(direction);
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
      flag: this._flag ?? undefined,
      tree: await serialize(this.rootNode),
      focusedPaneIndex: focusedIndex >= 0 ? focusedIndex : 0,
    };
  }

  /** Restore a tab from serialized session state (creates panes and splits) */
  static async createFromSession(
    state: SessionTabState,
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

    tab._flag = state.flag ?? null;

    if (state.customTitle && state.title) {
      tab.title = state.title;
      tab._customTitle = true;
    }

    return tab;
  }


  private showToast(message: string): void {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    this.element.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
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
