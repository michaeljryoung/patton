import { Pane, type ParkedInfo } from './pane';
import { SplitContainer } from './split-container';
import { SearchOverlay } from './search-overlay';
import { HistoryManager } from '../services/history-manager';
import { projectName } from '../services/project-names';
import { rlog } from '../services/renderer-logger';
import { formatProjectTitle } from '../services/sessions';
import {
  splitPane as splitPaneInTree,
  closePane as closePaneInTree,
  findPaneInDirection as findPaneInDir,
  swapPanes as swapPanesInTree,
  isPane,
  type SplitTreeNode,
  type SplitDirection,
} from './split-tree';
import type { SessionTreeNode, SessionTabState, SessionPaneState, TabFlag, ProjectInfo } from '../../shared/types';
import type { ITheme } from '@xterm/xterm';
import { DEFAULTS } from '../../shared/constants';

let tabIdCounter = 0;

/** Something shown over a tab's panes (the project board). While a tab has
 *  one, the tab is called "Projects" and keyboard focus stays inside it. */
export interface TabCover {
  element: HTMLElement;
  focus(): void;
}

/** The tab's name while a cover shows. */
export const COVERED_TAB_TITLE = 'Projects';

/** Wait before retrying a project lookup main refused (its 100/s cap at restore). */
const PROJECT_RETRY_MS = 1500;

/** Same project and same worktree of it. */
function sameProject(a: ProjectInfo | null, b: ProjectInfo | null): boolean {
  return a?.root === b?.root && a?.worktree?.path === b?.worktree?.path;
}

/** A project's tab title: its name, plus the worktree for a linked worktree
 *  ("patton ⎇ feat-x"). */
export function projectTitle(project: ProjectInfo): string {
  return formatProjectTitle(projectName(project), project.worktree);
}

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
  // The focused pane's checkpoint clock changed, or another pane took focus.
  private onCheckpointChanged: (() => void) | null = null;
  private onStatusChanged: (() => void) | null = null;
  title = 'Terminal';
  private _customTitle = false;
  // The project the focused pane's folder belongs to, if any. Its name outranks
  // the title the running program sets (OSC 0/2), so the tab reads "football"
  // rather than whatever Claude Code last wrote there; a name the user typed
  // for this one tab outranks both. See refreshTitle().
  private _project: ProjectInfo | null = null;
  // Bumped on every lookup so a slow answer for a folder the pane has already
  // left can't overwrite a newer one; each pane remembers its latest lookup.
  private _projectLookup = 0;
  private _paneLookups = new Map<Pane, number>();
  // Every pane's project (the focused one's is also _project), so the palette
  // and the bookmarks sidebar can place each pane of a split on its own.
  private _paneProjects = new Map<Pane, ProjectInfo | null>();
  private _broadcastInput = false;
  // Compose-first in Claude Code tabs: the Settings value, and this tab's
  // session-only override from the palette (null = follow the setting).
  private _composeFirstSetting = false;
  private _composeFirstOverride: boolean | null = null;
  // The window's terminal settings, kept here so a pane made later (a split)
  // gets them too, not only the panes open when they were set. Unset = the
  // terminal's own defaults.
  private _fontSize: number | undefined;
  private _fontFamily: string | undefined;
  private _scrollback: number | undefined;
  private _copyOnSelect = false;
  private _renderer: 'webgl' | 'dom' | undefined;
  private _terminalTheme: ITheme | null = null;
  private _zoomed = false;
  private _shell: string | undefined;
  private _historyManager: HistoryManager | undefined;
  // True when this tab is the currently-visible tab in the window.
  // Used to decide whether a prompt-ready signal should raise the
  // "awaiting input" indicator — active tabs never show it (the user
  // is already looking at them).
  private _isActive = false;
  // Panes that need the user (Claude stopped, a command finished, a bell or
  // notification) while this tab was inactive; the green dot shows while any
  // do. Tracked per pane so one pane resuming work can't clear a dot another
  // pane raised. Emptied when the tab becomes active; a pane leaves the set
  // when it starts working again or closes. The value is when it started
  // waiting (ms), so the palette and sidebar can go to the longest wait first.
  private _panesNeedingYou = new Map<Pane, number>();
  // User-set colour flag (right-click a tab → Flag). Unlike the green dot this
  // is never touched by shell activity or by activating the tab — only the user
  // sets or clears it. See TabFlag in shared/types.ts.
  private _flag: TabFlag | null = null;
  // Automatic flags raised by a pane's title (a `WAKE` title → yellow). Runtime
  // only, never persisted; the manual flag wins when both are set, and
  // "Clear Flag" clears only the manual one.
  private _autoFlags = new Map<Pane, TabFlag>();
  // Panes whose Claude Code session ended its turn but is waiting on its own
  // background tasks or timers (Stop hook). Runtime only, never persisted.
  private _parkedPanes = new Map<Pane, ParkedInfo>();
  // The cover over the panes (the project board), and the element holding it.
  // The shell beneath keeps running; only focus and the title change.
  private _cover: TabCover | null = null;
  private _coverHost: HTMLElement | null = null;

  /** `forProject`: the first pane's shell is told its project (PATTON_PROJECT_DIR).
   *  Only that pane: splits and restored panes never get it. */
  constructor(initialCwd?: string, forProject = false) {
    this.id = `tab-${++tabIdCounter}`;

    // Create DOM structure
    this.element = document.createElement('div');
    this.element.className = 'tab-content';
    this.element.id = this.id;
    this.element.setAttribute('role', 'tabpanel');

    // Create the initial pane (inherit CWD if provided)
    const pane = this.createPaneInstance(initialCwd, forProject);
    this._focusedPane = pane;
    this.rootNode = pane;
    this.element.appendChild(pane.element);

    // While a cover shows, nothing beneath it may take focus (a click-through,
    // focusTerminal(), a split's deferred focus): send it back to the cover.
    this.element.addEventListener('focusin', (e) => {
      if (!this._cover || !this._coverHost) return;
      if (e.target instanceof Node && this._coverHost.contains(e.target)) return;
      this._cover.focus();
    });
  }

  /** Show something over the panes (or remove it with null). Removing it gives
   *  the tab its usual title back and focuses the terminal. */
  setCover(cover: TabCover | null): void {
    if (cover === this._cover) return;
    this._coverHost?.remove();
    this._coverHost = null;
    this._cover = cover;
    if (cover) {
      const host = document.createElement('div');
      host.className = 'tab-cover';
      host.appendChild(cover.element);
      this.element.appendChild(host);
      this._coverHost = host;
    }
    if (this._isActive) requestAnimationFrame(() => this.focusFront());
    this.refreshTitle();
  }

  get hasCover(): boolean {
    return this._cover !== null;
  }

  /** Focus what the user sees in this tab: its cover, else the focused pane. */
  private focusFront(): void {
    if (this._cover) this._cover.focus();
    else this._focusedPane.focus();
  }

  setShell(shell: string): void {
    this._shell = shell;
  }

  setHistoryManager(hm: HistoryManager): void {
    this._historyManager = hm;
  }

  private createPaneInstance(cwd?: string, forProject = false): Pane {
    const pane = new Pane({
      ...(cwd ? { cwd } : {}),
      ...(cwd && forProject ? { projectDir: true } : {}),
      ...(this._shell ? { shell: this._shell } : {}),
      ...(this._historyManager ? { historyManager: this._historyManager } : {}),
      onFocus: (p) => this.setFocusedPane(p),
      onTitleChange: (p) => {
        if (p === this._focusedPane) this.refreshTitle();
      },
      onCwdChange: (p) => this.lookUpProject(p),
      onCommandDone: () => {
        // The pane needs the user: Claude stopped working, a shell command
        // finished, a bell or an OSC 9 notification. pane.ts filters and
        // debounces these (fireCommandDone), so every call is a real event.
        this.raiseAwaitingInput(pane);
        this.onCommandDone?.();
      },
      onWorkStarted: () => this.clearAwaitingInput(pane),
      onCheckpointChange: (p) => {
        if (p === this._focusedPane) this.onCheckpointChanged?.();
      },
      onStatusChange: (p) => {
        // A waiting pane's reason is in the tab's tooltip and aria-label.
        if (this._panesNeedingYou.has(p)) this.onTitleChanged?.();
        this.onStatusChanged?.();
      },
      onParked: (p, info) => this.setPaneParked(p, info),
      onAutoFlag: (p, flag) => this.setPaneAutoFlag(p, flag),
      onBroadcastWrite: (data) => {
        if (!this._broadcastInput) return;
        // Write to all OTHER panes
        for (const p of this._panes) {
          if (p !== pane && p.ptyId !== null) {
            window.patton.pty.write(p.ptyId, data);
          }
        }
      },
      onBroadcastPaste: (text) => {
        if (!this._broadcastInput) return;
        for (const p of this._panes) {
          if (p !== pane) p.pasteBroadcast(text);
        }
      },
    });
    pane.setComposeFirst(this._composeFirstSetting, this._composeFirstOverride);
    if (this._fontSize !== undefined) pane.setFontSize(this._fontSize);
    if (this._fontFamily !== undefined) pane.setFontFamily(this._fontFamily);
    if (this._scrollback !== undefined) pane.setScrollback(this._scrollback);
    if (this._copyOnSelect) pane.setCopyOnSelect(true);
    if (this._renderer !== undefined) pane.setRenderer(this._renderer);
    if (this._terminalTheme) pane.setTerminalTheme(this._terminalTheme);
    pane.element.addEventListener('pane-split', ((e: CustomEvent) => {
      if (e.detail === 'vertical') this.splitVertical().catch(console.error);
      else if (e.detail === 'horizontal') this.splitHorizontal().catch(console.error);
    }) as EventListener);
    pane.element.addEventListener('pane-swap', ((e: CustomEvent) => {
      const { sourceId, targetId } = e.detail;
      this.handlePaneSwap(sourceId, targetId);
    }) as EventListener);
    // Clear the dot the instant a new command starts — the prior signal is
    // stale the moment work resumes in this pane (Claude resuming work clears
    // it the same way, via onWorkStarted). OSC 133 'prompt' events are NOT
    // used to SET the dot (they fire too liberally — on every prompt redraw,
    // resize, session restore); the only SET path is onCommandDone.
    pane.terminalView.onPromptState((state) => {
      if (state === 'command') this.clearAwaitingInput(pane);
    });
    this._panes.push(pane);
    return pane;
  }

  private raiseAwaitingInput(pane: Pane): void {
    if (this._isActive || this._panesNeedingYou.has(pane)) return;
    this._panesNeedingYou.set(pane, Date.now());
    // Every pane, not only the first: the tab's dot changes once, but the
    // sidebar's count follows each waiting pane.
    this.onTitleChanged?.();
  }

  private clearAwaitingInput(pane: Pane): void {
    if (!this._panesNeedingYou.delete(pane)) return;
    this.onTitleChanged?.();
  }

  get awaitingInput(): boolean {
    return this._panesNeedingYou.size > 0;
  }

  /** When this pane started waiting for the user (ms), or null if it isn't. */
  awaitingSince(pane: Pane): number | null {
    return this._panesNeedingYou.get(pane) ?? null;
  }

  /** Whether this pane's Claude Code session is parked on its own background work. */
  isPaneParked(pane: Pane): boolean {
    return this._parkedPanes.has(pane);
  }

  /** The project this pane's folder belongs to, once looked up. */
  paneProject(pane: Pane): ProjectInfo | null {
    // A resolved null ("not in a project") is an answer; only a pane not yet
    // looked up falls back to the tab's project.
    if (this._paneProjects.has(pane)) return this._paneProjects.get(pane) ?? null;
    return pane === this._focusedPane ? this._project : null;
  }

  /** Focus one of this tab's panes by id (palette, bookmarks). False if it's gone. */
  focusPaneById(paneId: string): boolean {
    const pane = this._panes.find((p) => p.id === paneId);
    if (!pane) return false;
    if (this._zoomed) this.toggleZoom(); // a zoomed tab shows only its focused pane
    this.setFocusedPane(pane);
    requestAnimationFrame(() => pane.focus());
    return true;
  }

  private setPaneParked(pane: Pane, info: ParkedInfo | null): void {
    if (info) {
      this._parkedPanes.set(pane, info);
      // A parked pane doesn't need you, even if the ✳ title path got there
      // first and raised the dot: the hook's verdict is the better signal.
      this._panesNeedingYou.delete(pane);
    } else if (!this._parkedPanes.delete(pane)) {
      return;
    }
    this.onTitleChanged?.();
  }

  /** Summed background work across this tab's parked panes, or null if none is parked. */
  get parked(): ParkedInfo | null {
    if (this._parkedPanes.size === 0) return null;
    let tasks = 0;
    let crons = 0;
    const titles: string[] = [];
    for (const info of this._parkedPanes.values()) {
      tasks += info.tasks;
      crons += info.crons;
      if (info.titles) titles.push(...info.titles);
    }
    return { tasks, crons, titles };
  }

  /** Why a pane of this tab needs you, as plain text (Claude Code's own
   *  status reports only; null on the title and hook path). */
  get waitingText(): string | null {
    for (const pane of this._panesNeedingYou.keys()) {
      const text = pane.claudeState.needsYouText;
      if (text) return text;
    }
    return null;
  }

  private setPaneAutoFlag(pane: Pane, flag: TabFlag | null): void {
    const before = this.autoFlag;
    if (flag) this._autoFlags.set(pane, flag);
    else this._autoFlags.delete(pane);
    if (this.autoFlag !== before) this.onTitleChanged?.();
  }

  /** The automatic flag, if any pane raised one (see _autoFlags). */
  get autoFlag(): TabFlag | null {
    for (const flag of this._autoFlags.values()) return flag;
    return null;
  }

  setRegistrationCallbacks(
    onRegister: (pane: Pane) => void,
    onUnregister: (pane: Pane) => void,
    onTitleChange?: () => void,
    onCommandDone?: () => void,
    onCheckpointChange?: () => void,
    onStatusChange?: () => void,
  ): void {
    this.onCheckpointChanged = onCheckpointChange || null;
    this.onStatusChanged = onStatusChange || null;
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
    // The newly focused pane may be in a different folder, so a different project.
    this.lookUpProject();
    this.refreshTitle();
    this.onCheckpointChanged?.();
  }

  /** Find out which project a pane's folder belongs to (the focused pane's
   *  names the tab). `retry`: one more try after a refused lookup. */
  private lookUpProject(pane: Pane = this._focusedPane, retry = true): void {
    const lookup = ++this._projectLookup;
    this._paneLookups.set(pane, lookup);
    const cwd = pane.getCwd();
    if (!cwd) {
      // Not known yet — don't keep showing another pane's project. The pane
      // reports its folder once its first poll lands.
      this._paneProjects.delete(pane);
      if (pane === this._focusedPane) this.setProject(null);
      return;
    }
    window.patton.projects.resolve(cwd)
      .then((project) => {
        if (this._paneLookups.get(pane) !== lookup) return; // superseded by a newer lookup
        const before = this._paneProjects.get(pane);
        this._paneProjects.set(pane, project);
        if (pane === this._focusedPane) this.setProject(project);
        else if (!sameProject(before ?? null, project)) this.onTitleChanged?.();
      })
      // Main couldn't check (rate limit, bad path): keep the current name
      // rather than treating it as "not in a project", and try once more.
      .catch((err) => {
        rlog('warn', '[PROJECTS] Project lookup failed', err);
        if (retry) {
          setTimeout(() => {
            if (this._paneLookups.get(pane) === lookup && this._panes.includes(pane)) this.lookUpProject(pane, false);
          }, PROJECT_RETRY_MS);
        }
      });
  }

  private setProject(project: ProjectInfo | null): void {
    if (sameProject(project, this._project)) return;
    this._project = project;
    const titleChanged = this.refreshTitle();
    // Even when the title stays put (e.g. the user named this tab), the tab
    // bar needs the new project for its "Set Default Tab Name for Project…" menu item.
    if (!titleChanged) this.onTitleChanged?.();
  }

  /** The project this tab's focused pane is in, if any. */
  get project(): ProjectInfo | null {
    return this._project;
  }

  /** What the tab is called when the user hasn't named it: its project's name,
   *  else the title the program in the focused pane set. */
  get autoTitle(): string {
    if (this._cover) return COVERED_TAB_TITLE;
    return this._project ? projectTitle(this._project) : this._focusedPane.title;
  }

  /** Recompute the displayed title — after a title, folder or project-name
   *  change. A name the user typed for this tab always wins. Returns whether
   *  the title changed. */
  refreshTitle(): boolean {
    if (this._customTitle) return false;
    const next = this.autoTitle;
    if (next === this.title) return false;
    this.title = next;
    this.onTitleChanged?.();
    return true;
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

  /** Forget the user's name for this tab, so it follows its project's name (or
   *  the program's title) again. */
  clearCustomTitle(): void {
    if (!this._customTitle) return;
    this._customTitle = false;
    this.refreshTitle();
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
      this.onTitleChanged?.(); // the bookmarks sidebar counts panes
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
    this.clearAwaitingInput(pane); // a closed pane can't still need you
    this._paneProjects.delete(pane);
    this._paneLookups.delete(pane);
    this.setPaneParked(pane, null);
    this.setPaneAutoFlag(pane, null);
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
    this.onTitleChanged?.(); // the bookmarks sidebar counts panes
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
    // The cover stays on top of a re-rendered tree.
    if (this._coverHost) this.element.appendChild(this._coverHost);
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

  /** The focused pane will run the startup command: give its shell
   *  FORCE_HYPERLINK=1. Call before init(). */
  markStartupPane(): void {
    this._focusedPane.enableHyperlinkEnv();
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

  /** The Settings value changed: every pane follows it unless this tab overrides it. */
  setComposeFirst(enabled: boolean): void {
    this._composeFirstSetting = enabled;
    // An override equal to the new setting no longer overrides anything.
    if (this._composeFirstOverride === enabled) this._composeFirstOverride = null;
    this.applyComposeFirst();
  }

  /** Palette: flip compose-first for this tab only, until Patton quits. */
  toggleComposeFirst(): void {
    const effective = this._composeFirstOverride ?? this._composeFirstSetting;
    const next = !effective;
    this._composeFirstOverride = next === this._composeFirstSetting ? null : next;
    this.applyComposeFirst();
    this.showToast(`Compose-first ${next ? 'on' : 'off'} for this tab`);
  }

  private applyComposeFirst(): void {
    for (const pane of this._panes) {
      pane.setComposeFirst(this._composeFirstSetting, this._composeFirstOverride);
    }
  }

  showHistorySearch(): void {
    this._focusedPane.showHistorySearch();
  }

  show(): void {
    this._isActive = true;
    // Becoming active clears any pending "awaiting input" dot — user is
    // now looking at this tab. Notify so the tab-bar drops the indicator.
    const wasAwaiting = this._panesNeedingYou.size > 0;
    this._panesNeedingYou.clear();
    this.element.style.display = 'flex';
    for (const pane of this._panes) {
      pane.show();
    }
    // Deferred to ensure focus wins over xterm.js internal focus grabs from fit()
    requestAnimationFrame(() => this.focusFront());
    if (wasAwaiting) this.onTitleChanged?.();
  }

  hide(): void {
    this._isActive = false;
    this.element.style.display = 'none';
  }

  setFontSize(size: number): void {
    this._fontSize = size;
    for (const pane of this._panes) {
      pane.setFontSize(size);
    }
  }

  setFontFamily(family: string): void {
    this._fontFamily = family;
    for (const pane of this._panes) {
      pane.setFontFamily(family);
    }
  }

  setScrollback(lines: number): void {
    this._scrollback = lines;
    for (const pane of this._panes) {
      pane.setScrollback(lines);
    }
  }

  setCopyOnSelect(enabled: boolean): void {
    this._copyOnSelect = enabled;
    for (const pane of this._panes) {
      pane.setCopyOnSelect(enabled);
    }
  }

  setRenderer(mode: 'webgl' | 'dom'): void {
    this._renderer = mode;
    for (const pane of this._panes) {
      pane.setRenderer(mode);
    }
  }

  setTerminalTheme(theme: ITheme | null): void {
    this._terminalTheme = theme;
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
        // Serialise from the pane's cache: main rate-limits getCwd to 10/s and
        // answers '' past that, which used to be saved over a known folder when
        // 11+ panes were open. The periodic autosave refreshes the caches first
        // (TabManager.refreshPaneCwds, spaced calls), because a cache only
        // updates at a shell prompt or by the focused pane's poll, and `cc`
        // runs for hours without a prompt. Ask main here only when the cache
        // is empty, and never save '' over a folder we know.
        let cwd = pane.getCwd();
        if (!cwd && pane.ptyId !== null) {
          try { cwd = await window.patton.pty.getCwd(pane.ptyId); } catch { /* ignore */ }
        }
        if (!cwd) rlog('warn', '[SESSION] Pane folder not found; saving it empty');
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
