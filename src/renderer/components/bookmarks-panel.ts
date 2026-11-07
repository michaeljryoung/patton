import { DEFAULTS } from '../../shared/constants';
import { shortcutKeys } from '../../shared/shortcuts';
import type { Bookmark } from '../../shared/types';
import { announce } from '../services/announcer';
import { projectName } from '../services/project-names';
import { rlog } from '../services/renderer-logger';
import { runStartupCommand } from '../services/startup-command';
import { sessionMatchesPath, sessionNeedsYou, type SessionInfo } from '../services/sessions';
import { ConfirmDialog } from './confirm-dialog';
import { ContextMenu } from './context-menu';
import type { Tab } from './tab';

const WIDTH_STORAGE_KEY = 'patton.bookmarks.width';
const OPEN_STORAGE_KEY = 'patton.bookmarks.open';
const REFRESH_DEBOUNCE_MS = 100;
// A private drag type: a bookmark dropped on the terminal or another app
// carries no text, so nothing gets typed or opened by accident.
const DRAG_TYPE = 'application/x-patton-bookmark';

const ICON_HIDE =
  '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M6.25 2 3.25 5l3 3" fill="none" stroke="currentColor" stroke-width="1.25"/></svg>';
const ICON_PLUS =
  '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M4 0.5v7M0.5 4h7" fill="none" stroke="currentColor" stroke-width="1"/></svg>';

/** What the panel needs from the window's tabs. Kept narrow so the panel
 *  doesn't reach into TabManager's internals. */
export interface BookmarksHost {
  getTabs(): readonly Tab[];
  getActiveTab(): Tab | null;
  switchToTab(id: string): void;
  /** `forProject` tells the new tab's shell which project it was opened for
   *  (PATTON_PROJECT_DIR), so a launcher can open that project directly;
   *  `startupCommand` gives that shell FORCE_HYPERLINK=1 for Claude. */
  createTab(cwd: string, opts?: { forProject?: boolean; startupCommand?: boolean }): Promise<Tab>;
  /** Open sessions (every pane), waiting first, longest wait first. */
  listSessions(): SessionInfo[];
  /** Activate a tab and focus one of its panes; false if either has gone. */
  goToSession(tabId: string, paneId: string): boolean;
  /** Hand keyboard focus back to the active terminal pane. */
  focusTerminal(): void;
}

/** A project row's live state: its tab, and its sessions by state. */
interface RowState {
  isOpen: boolean;
  isCurrent: boolean;
  /** Sessions (panes) in the project, and how many wait for you or are parked. */
  open: number;
  waiting: number;
  parked: number;
}

const CLOSED: RowState = { isOpen: false, isCurrent: false, open: 0, waiting: 0, parked: 0 };

/** The row's second line while sessions are open: "2 open · 1 waiting". */
function countText(state: RowState): string {
  const parts = [`${state.open} open`];
  if (state.waiting) parts.push(`${state.waiting} waiting`);
  if (state.parked) parts.push(`${state.parked} parked`);
  return parts.join(' \u00b7 ');
}

function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

function newId(): string {
  return crypto.randomUUID();
}

/**
 * A sidebar of bookmarks docked LEFT of the terminal, toggled by ⌃⌘B.
 *
 * Two kinds: a project (a folder — clicking it opens a tab there and runs the
 * startup command; the new tab's shell also gets PATTON_PROJECT_DIR, so a
 * launcher such as Michael's `cc` picker can open that project directly) and an
 * artifact (an https link, opened in the browser).
 *
 * One tab per project: clicking a project that already has a tab in this
 * window activates that tab instead of opening a second one. Rows whose project
 * has a tab open are marked (dot + bold); the row for the active tab's project
 * gets the accent background and `aria-current`.
 *
 * Rows drag to reorder within their group (projects among projects, links
 * among links); the row menu's Move Up / Move Down is the keyboard route.
 *
 * Hidden, the sidebar folds to a narrow strip with a small "+" where it stood:
 * the header's chevron, the strip and ⌃⌘B all toggle between those two states.
 *
 * The list lives in the encrypted store (main validates every save and
 * broadcasts it to all windows); width and open/closed state are renderer-local
 * preferences in localStorage, as with the notes panel.
 */
export class BookmarksPanel {
  private panel: HTMLElement;
  private rail: HTMLButtonElement;
  private hideButton: HTMLButtonElement;
  private listEl: HTMLElement;
  private form: HTMLFormElement;
  private urlInput: HTMLInputElement;
  private labelInput: HTMLInputElement;
  private formError: HTMLElement;
  private addButton: HTMLButtonElement;
  private host: BookmarksHost;
  private bookmarks: Bookmark[] = [];
  private loaded: Promise<void> | null = null;
  private contextMenu = new ContextMenu();
  private confirmDialog = new ConfirmDialog(document.body);
  private disposables: (() => void)[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // While a row is being renamed, re-rendering would destroy the input box
  // mid-typing; the render is skipped and run when the rename ends.
  private renamingId: string | null = null;
  // The row being dragged. Renders wait for the drop for the same reason as
  // renames: rebuilding the list mid-drag would remove the row being dragged.
  private dragId: string | null = null;
  // Paths whose tab is being created, so a double-click can't open two tabs.
  private opening = new Set<string>();
  /** The row whose menu was opened last, so a rebuild can re-aim its focus return. */
  private menuRowId: string | null = null;
  // Clicks are ignored until App.init has restored the session and run the
  // startup command: a tab opened meanwhile could become the active one and get
  // the startup command twice.
  private ready = false;
  // What the list last showed. Tab titles change every second while Claude
  // works and each change refreshes the panel, so an unchanged list is left
  // alone rather than rebuilt (which would also drop hover and an open row menu).
  private lastRendered = '';

  constructor(container: HTMLElement, host: BookmarksHost) {
    this.host = host;
    const keys = shortcutKeys('toggle-bookmarks');

    this.panel = document.createElement('nav');
    this.panel.id = 'bookmarks-panel';
    this.panel.className = 'collapsed';
    this.panel.setAttribute('aria-label', 'Bookmarks');
    this.panel.innerHTML = `
      <div class="bookmarks-header">
        <span id="bookmarks-heading">Bookmarks</span>
        <div class="bookmarks-header-actions">
          <button type="button" class="bookmarks-hide" aria-label="Hide bookmarks" aria-controls="bookmarks-panel"
            aria-expanded="true" title="Hide bookmarks (${keys})">${ICON_HIDE}</button>
          <button type="button" class="bookmarks-add" aria-label="Add bookmark" aria-haspopup="menu" title="Add bookmark">+</button>
        </div>
      </div>
      <form class="bookmarks-form" hidden aria-label="Add artifact link">
        <input class="bookmarks-form-url" type="text" inputmode="url" spellcheck="false"
          placeholder="https://…" aria-label="Artifact link (https)" />
        <input class="bookmarks-form-label" type="text" spellcheck="false"
          maxlength="${DEFAULTS.BOOKMARK_LABEL_MAX_CHARS}"
          placeholder="Label (optional)" aria-label="Bookmark label" />
        <div class="bookmarks-form-error" role="alert"></div>
        <div class="bookmarks-form-actions">
          <button type="button" class="bookmarks-form-cancel">Cancel</button>
          <button type="submit" class="bookmarks-form-submit">Add</button>
        </div>
      </form>
      <div class="bookmarks-list"></div>
      <div class="bookmarks-resizer" aria-hidden="true"></div>
    `;
    // Docked left: first in #main's row, before #content.
    container.insertBefore(this.panel, container.firstChild);

    // What stays of the sidebar while it is hidden: a narrow strip whose whole
    // height is the button, marked with a small "+" level with the header.
    this.rail = document.createElement('button');
    this.rail.type = 'button';
    this.rail.id = 'bookmarks-rail';
    this.rail.setAttribute('aria-label', 'Show bookmarks');
    this.rail.setAttribute('aria-controls', 'bookmarks-panel');
    this.rail.setAttribute('aria-expanded', 'false');
    this.rail.title = `Show bookmarks (${keys})`;
    this.rail.innerHTML = `<span class="bookmarks-rail-mark" aria-hidden="true">${ICON_PLUS}</span>`;
    container.insertBefore(this.rail, this.panel);

    this.hideButton = this.panel.querySelector('.bookmarks-hide') as HTMLButtonElement;
    this.listEl = this.panel.querySelector('.bookmarks-list') as HTMLElement;
    this.form = this.panel.querySelector('.bookmarks-form') as HTMLFormElement;
    this.urlInput = this.panel.querySelector('.bookmarks-form-url') as HTMLInputElement;
    this.labelInput = this.panel.querySelector('.bookmarks-form-label') as HTMLInputElement;
    this.formError = this.panel.querySelector('.bookmarks-form-error') as HTMLElement;
    this.addButton = this.panel.querySelector('.bookmarks-add') as HTMLButtonElement;

    const savedWidth = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    if (Number.isFinite(savedWidth) && savedWidth >= DEFAULTS.BOOKMARKS_PANEL_MIN_WIDTH) {
      this.panel.style.width = `${savedWidth}px`;
    }

    this.setupHeader();
    this.setupRail();
    this.setupForm();
    this.setupListKeys();
    this.setupDragReorder();
    this.setupResizer();

    // Escape anywhere in the panel hands focus back to the terminal; the
    // sidebar stays open (⌃⌘B hides it). The form and rename box handle their
    // own Escape first.
    const onPanelKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.stopPropagation();
      this.host.focusTerminal();
    };
    this.panel.addEventListener('keydown', onPanelKeydown);
    this.disposables.push(() => this.panel.removeEventListener('keydown', onPanelKeydown));

    // Other windows (and this one) hear every saved change.
    this.disposables.push(
      window.patton.bookmarks.onChanged((list) => {
        this.bookmarks = list;
        this.render();
      }),
    );

    // Saved open: keep the strip out of the way while the list loads, so the
    // terminal is resized once (to the panel) rather than twice.
    const restoreOpen = localStorage.getItem(OPEN_STORAGE_KEY) === '1';
    this.rail.hidden = restoreOpen;
    if (restoreOpen) {
      this.show(false).catch((err) => {
        this.rail.hidden = false;
        rlog('warn', '[BOOKMARK] Could not restore panel', err);
      });
    }
  }

  /** App.init is done; bookmark clicks may open tabs now. */
  setReady(): void {
    this.ready = true;
  }

  get isOpen(): boolean {
    return !this.panel.classList.contains('collapsed');
  }

  async toggle(): Promise<void> {
    if (this.isOpen) {
      this.hide();
    } else {
      await this.show(true);
    }
  }

  /** Tabs were created, closed or activated, or a tab's project changed. */
  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.render();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Bookmark a tab's project (or, outside any project, its folder). Used by
   *  the "+" menu and the tab right-click menu. */
  async addProjectFromTab(tab: Tab | null): Promise<void> {
    if (!tab) return;
    const project = tab.project;
    const path = project?.root ?? tab.focusedPane.getCwd();
    if (!path) {
      announce("This tab's folder isn't known yet — try again in a moment", 'assertive');
      return;
    }
    await this.ensureLoaded();
    if (!this.isOpen) await this.show(false);

    const existing = this.bookmarks.find((b) => b.kind === 'project' && b.path === path);
    if (existing) {
      announce(`${existing.label} is already bookmarked`);
      this.focusRow(existing.id);
      return;
    }
    const label = (project ? projectName(project) : folderName(path)).slice(0, DEFAULTS.BOOKMARK_LABEL_MAX_CHARS);
    const bookmark: Bookmark = { id: newId(), kind: 'project', label, path, addedAt: Date.now() };
    const saved = await this.save([...this.bookmarks, bookmark]);
    if (saved) {
      rlog('info', '[BOOKMARK] added', { kind: 'project', label, inProject: project !== null });
      announce(`Bookmarked ${label}`);
      this.focusRow(bookmark.id);
    }
  }

  // ── Show / hide ──

  private ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = window.patton.bookmarks.get()
        .then((list) => {
          this.bookmarks = list;
          this.render();
        })
        .catch((err) => {
          this.loaded = null; // let the next open retry
          rlog('warn', '[BOOKMARK] Could not load bookmarks', err);
        });
    }
    return this.loaded;
  }

  private async show(focus: boolean): Promise<void> {
    await this.ensureLoaded();
    this.panel.classList.remove('collapsed');
    this.rail.hidden = true;
    localStorage.setItem(OPEN_STORAGE_KEY, '1');
    this.refreshMissing();
    this.render();
    if (focus) {
      announce('Bookmarks opened', 'polite');
      requestAnimationFrame(() => {
        const current = this.listEl.querySelector<HTMLElement>('.bookmark-row[aria-current="true"]');
        (current ?? this.listEl.querySelector<HTMLElement>('.bookmark-row') ?? this.addButton).focus();
      });
    }
  }

  private hide(): void {
    if (!this.isOpen) return;
    this.cancelForm();
    this.panel.classList.add('collapsed');
    this.rail.hidden = false;
    this.lastRendered = ''; // rebuild on the next show
    localStorage.setItem(OPEN_STORAGE_KEY, '0');
    announce('Bookmarks closed', 'polite');
    this.host.focusTerminal();
  }

  // ── Persistence ──

  /** Save the whole list; main validates it and answers with what it stored.
   *  Returns false when an entry was refused (e.g. a new link that isn't valid). */
  private async save(next: Bookmark[]): Promise<boolean> {
    try {
      const stored = await window.patton.bookmarks.set(next);
      this.bookmarks = stored;
      this.render();
      const storedIds = new Set(stored.map((b) => b.id));
      const refused = next.filter((b) => !storedIds.has(b.id));
      if (refused.length > 0) {
        announce('A bookmark could not be saved — its folder or link was not valid', 'assertive');
        rlog('warn', '[BOOKMARK] main refused entries', { sent: next.length, stored: stored.length, refused: refused.length });
        return false;
      }
      return true;
    } catch (err) {
      rlog('error', '[BOOKMARK] save failed', err);
      announce('Bookmarks could not be saved', 'assertive');
      return false;
    }
  }

  // ── Which tab belongs to a bookmark ──

  /** The tab shows this project, or has a pane (focused or not) in this folder. */
  private tabMatches(tab: Tab, path: string): boolean {
    if (tab.project?.root === path) return true;
    return tab.panes.some((pane) => pane.getCwd() === path);
  }

  /** The tab already showing this project — the active tab first, if it is one. */
  private findTabFor(path: string): Tab | null {
    const active = this.host.getActiveTab();
    if (active && this.tabMatches(active, path)) return active;
    return this.host.getTabs().find((t) => this.tabMatches(t, path)) ?? null;
  }

  // ── Opening ──

  private async open(bookmark: Bookmark): Promise<void> {
    if (bookmark.kind === 'artifact' && bookmark.url) {
      // Log the host only: an artifact URL can carry a share token.
      rlog('info', '[BOOKMARK] open', { kind: 'artifact', host: hostOf(bookmark.url) });
      await window.patton.openExternal(bookmark.url);
      return;
    }
    const path = bookmark.path;
    if (!path) return;
    if (!this.ready) return; // startup is still restoring tabs
    if (bookmark.missing || (await this.isMissingNow(bookmark))) {
      announce(`${bookmark.label}'s folder is missing — remove the bookmark or restore the folder`, 'assertive');
      return;
    }

    // A session of this project that's waiting for you comes first, the
    // longest wait first (listSessions is already in that order).
    const waiting = this.host.listSessions().find((s) => sessionNeedsYou(s) && sessionMatchesPath(s, path));
    if (waiting && this.host.goToSession(waiting.tabId, waiting.paneId)) {
      rlog('info', '[BOOKMARK] open waiting', {
        label: bookmark.label, tabId: waiting.tabId, paneId: waiting.paneId,
        waitedMs: waiting.awaitingSince ? Date.now() - waiting.awaitingSince : null,
      });
      this.host.focusTerminal();
      this.scheduleRefresh();
      return;
    }

    // Row state counts sessions per pane, so a click goes to one of those
    // before anything else (the first is the best-ranked: listSessions order).
    const session = this.host.listSessions().find((s) => sessionMatchesPath(s, path));
    if (session && this.host.goToSession(session.tabId, session.paneId)) {
      rlog('info', '[BOOKMARK] open', { kind: 'project', label: bookmark.label, action: 'went to existing session' });
      this.host.focusTerminal();
      this.scheduleRefresh();
      return;
    }

    const existing = this.findTabFor(path);
    if (existing) {
      rlog('info', '[BOOKMARK] open', { kind: 'project', label: bookmark.label, action: 'activated existing tab' });
      this.host.switchToTab(existing.id);
      this.host.focusTerminal();
      this.scheduleRefresh();
      return;
    }
    if (this.opening.has(path)) return; // its tab is already on the way

    this.opening.add(path);
    try {
      const settings = await window.patton.settings.get();
      const tab = await this.host.createTab(path, { forProject: true, startupCommand: Boolean(settings.startupCommand) });
      if (settings.startupCommand) runStartupCommand(tab, settings.startupCommand);
      rlog('info', '[BOOKMARK] open', {
        kind: 'project', label: bookmark.label, action: 'new tab', startupCommand: Boolean(settings.startupCommand),
      });
      this.host.focusTerminal();
    } catch (err) {
      rlog('error', '[BOOKMARK] open failed', { label: bookmark.label, err: String(err) });
      announce(`Could not open ${bookmark.label}`, 'assertive');
    } finally {
      this.opening.delete(path);
      this.scheduleRefresh();
    }
  }

  /** Re-read the list from main (which re-checks each folder), so a folder
   *  deleted since the list was loaded greys its row. */
  private refreshMissing(): void {
    window.patton.bookmarks.get()
      .then((list) => {
        this.bookmarks = list;
        this.render();
      })
      .catch((err) => rlog('warn', '[BOOKMARK] Could not refresh bookmarks', err));
  }

  /** A fresh check at click time: the row may not have been greyed yet. */
  private async isMissingNow(bookmark: Bookmark): Promise<boolean> {
    try {
      const list = await window.patton.bookmarks.get();
      const fresh = list.find((b) => b.id === bookmark.id);
      if (fresh?.missing) {
        this.bookmarks = list;
        this.render();
        return true;
      }
    } catch (err) {
      rlog('warn', '[BOOKMARK] Could not re-check folder', err);
    }
    return false;
  }

  // ── Rendering ──

  private render(): void {
    if (this.renamingId || this.dragId || !this.isOpen) return;

    const tabs = this.host.getTabs();
    const active = this.host.getActiveTab();
    const sessions = this.host.listSessions();
    const states = new Map<string, RowState>();
    for (const bookmark of this.bookmarks) {
      const path = bookmark.kind === 'project' ? bookmark.path : undefined;
      const mine = path ? sessions.filter((s) => sessionMatchesPath(s, path)) : [];
      const isOpen = !!path && (mine.length > 0 || tabs.some((t) => this.tabMatches(t, path)));
      const isCurrent = isOpen && !!path && !!active && this.tabMatches(active, path);
      states.set(bookmark.id, {
        isOpen,
        isCurrent,
        open: mine.length,
        waiting: mine.filter((s) => sessionNeedsYou(s)).length,
        parked: mine.filter((s) => s.state === 'parked').length,
      });
    }
    const signature = JSON.stringify([this.bookmarks, [...states.entries()]]);
    if (signature === this.lastRendered) return;
    this.lastRendered = signature;

    const hadFocusId = (document.activeElement as HTMLElement | null)?.dataset?.bookmarkId ?? null;
    this.listEl.innerHTML = '';
    if (this.bookmarks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'bookmarks-empty';
      empty.textContent = 'No bookmarks yet. Use + to bookmark the current project or an artifact link.';
      this.listEl.appendChild(empty);
      return;
    }

    const groups: { kind: Bookmark['kind']; title: string }[] = [
      { kind: 'project', title: 'Projects' },
      { kind: 'artifact', title: 'Artifacts' },
    ];
    for (const group of groups) {
      const items = this.bookmarks.filter((b) => b.kind === group.kind);
      if (items.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'bookmarks-group';
      section.setAttribute('role', 'group');
      const headingId = `bookmarks-group-${group.kind}`;
      section.setAttribute('aria-labelledby', headingId);

      const heading = document.createElement('div');
      heading.className = 'bookmarks-group-title';
      heading.id = headingId;
      const headingTitle = document.createElement('span');
      headingTitle.textContent = group.title;
      // The count is visual: each row is announced on its own.
      const headingCount = document.createElement('span');
      headingCount.className = 'bookmarks-group-count';
      headingCount.setAttribute('aria-hidden', 'true');
      headingCount.textContent = String(items.length);
      heading.append(headingTitle, headingCount);
      section.appendChild(heading);

      const ul = document.createElement('ul');
      ul.className = 'bookmarks-items';
      for (const bookmark of items) {
        ul.appendChild(this.renderRow(bookmark, states.get(bookmark.id) ?? CLOSED, items.length > 1));
      }
      section.appendChild(ul);
      this.listEl.appendChild(section);
    }

    if (hadFocusId) this.focusRow(hadFocusId);
    // A row menu open while the rows rebuilt would hand focus back to a row
    // that is gone; give it the rebuilt one.
    if (this.menuRowId && this.contextMenu.isShown) {
      const row = this.listEl.querySelector<HTMLElement>(`.bookmark-row[data-bookmark-id="${CSS.escape(this.menuRowId)}"]`);
      if (row) this.contextMenu.retargetFocus(row);
    }
  }

  private renderRow(bookmark: Bookmark, rowState: RowState, canDrag: boolean): HTMLElement {
    const { isOpen, isCurrent } = rowState;
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bookmark-row';
    row.dataset.bookmarkId = bookmark.id;
    row.classList.toggle('is-open', isOpen);
    row.classList.toggle('is-current', isCurrent);
    if (isCurrent) row.setAttribute('aria-current', 'true');
    row.setAttribute('aria-haspopup', 'menu');

    row.classList.toggle('is-missing', bookmark.missing === true);
    // While the project has sessions open, the second line counts them
    // ("2 open · 1 waiting"); the folder stays in the tooltip.
    const counts = bookmark.kind === 'project' && !bookmark.missing && rowState.open > 0 ? countText(rowState) : '';
    const subtitle = bookmark.kind === 'project'
      ? (bookmark.missing ? 'Folder missing' : counts || (bookmark.displayPath ?? bookmark.path ?? ''))
      : hostOf(bookmark.url ?? '');
    const state = isCurrent ? ', open in the active tab' : isOpen && !counts ? ', open' : '';
    row.setAttribute('aria-label', `${bookmark.label}, ${subtitle}${state}`);
    // Green dot: a session here waits for you; hollow ring: one is parked on
    // its own background work. The tab bar's glyphs, static here.
    row.classList.toggle('has-waiting', rowState.waiting > 0);
    row.classList.toggle('has-parked', rowState.waiting === 0 && rowState.parked > 0);
    row.title = `${bookmark.label}\n${bookmark.kind === 'project' ? (bookmark.path ?? '') : (bookmark.url ?? '')}`;
    if (bookmark.missing) row.setAttribute('aria-disabled', 'true');

    const dot = document.createElement('span');
    dot.className = 'bookmark-dot';
    dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);

    const text = document.createElement('span');
    text.className = 'bookmark-text';
    const label = document.createElement('span');
    label.className = 'bookmark-label';
    label.textContent = bookmark.label;
    const sub = document.createElement('span');
    sub.className = 'bookmark-subtitle';
    sub.textContent = subtitle;
    text.append(label, sub);
    row.appendChild(text);

    if (canDrag) {
      // The whole row drags; the grip only says so, on hover.
      row.draggable = true;
      const grip = document.createElement('span');
      grip.className = 'bookmark-grip';
      grip.setAttribute('aria-hidden', 'true');
      grip.textContent = '\u2847'; // ⡇ braille dots, the tab bar's grip
      row.appendChild(grip);

      row.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer) return;
        this.dragId = bookmark.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DRAG_TYPE, bookmark.id);
        // The drag image is painted from the row as it stands when this handler
        // returns: give it a card look for that one paint, then dim the row
        // left behind in the list.
        row.classList.add('drag-ghost');
        requestAnimationFrame(() => {
          row.classList.remove('drag-ghost');
          if (this.dragId === bookmark.id) row.classList.add('is-dragging');
        });
      });
      row.addEventListener('dragend', () => this.endDrag());
    }

    row.addEventListener('click', () => {
      this.open(bookmark).catch((err) => rlog('error', '[BOOKMARK] open failed', String(err)));
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showRowMenu(bookmark, e.clientX, e.clientY, row, false);
    });

    li.appendChild(row);
    return li;
  }

  private focusRow(id: string): void {
    const row = this.listEl.querySelector<HTMLElement>(`.bookmark-row[data-bookmark-id="${CSS.escape(id)}"]`);
    row?.focus();
  }

  // ── Drag to reorder, within a group ──

  private setupDragReorder(): void {
    const hitRow = (e: DragEvent): { li: HTMLElement; id: string } | null => {
      const row = (e.target as Element | null)?.closest?.<HTMLElement>('.bookmark-row');
      const id = row?.dataset.bookmarkId;
      const li = row?.parentElement;
      return id && li ? { li, id } : null;
    };
    // Lower half of a row = drop after it.
    const isAfter = (e: DragEvent, li: HTMLElement): boolean => {
      const rect = li.getBoundingClientRect();
      return e.clientY > rect.top + rect.height / 2;
    };

    const onDragOver = (e: DragEvent) => {
      if (!this.dragId || !e.dataTransfer) return; // a file or text from elsewhere: not ours
      const hit = hitRow(e);
      const dragged = this.bookmarks.find((b) => b.id === this.dragId);
      const target = hit ? this.bookmarks.find((b) => b.id === hit.id) : undefined;
      if (!hit || !dragged || !target || target.kind !== dragged.kind) {
        // Between groups or off the rows: no drop here (the cursor says so).
        this.clearDropMarks();
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const after = isAfter(e, hit.li);
      // Mark only a drop that would change the order: not the row itself, nor
      // the gap it already sits in.
      const wouldMove = this.reordered(this.dragId, hit.id, after) !== null;
      const cls = after ? 'drop-after' : 'drop-before';
      if (wouldMove && hit.li.classList.contains(cls)) return; // unchanged: no restyle
      this.clearDropMarks();
      if (wouldMove) hit.li.classList.add(cls);
    };
    const onDragLeave = (e: DragEvent) => {
      const into = e.relatedTarget as Node | null;
      if (!into || !this.listEl.contains(into)) this.clearDropMarks();
    };
    const onDrop = (e: DragEvent) => {
      const dragId = this.dragId;
      const hit = hitRow(e);
      if (!dragId || !hit) return;
      e.preventDefault();
      const next = this.reordered(dragId, hit.id, isAfter(e, hit.li));
      this.endDrag();
      if (next) this.commitReorder(dragId, next).catch((err) => rlog('error', '[BOOKMARK] reorder failed', String(err)));
    };

    // Chromium skips dragend when a drag is torn down inside dragstart (a
    // DevTools break, say). A new press in the panel means any earlier drag is
    // over, so it releases a hold that would otherwise freeze the list.
    const onPointerDown = () => this.endDrag();

    this.listEl.addEventListener('dragover', onDragOver);
    this.listEl.addEventListener('dragleave', onDragLeave);
    this.listEl.addEventListener('drop', onDrop);
    this.panel.addEventListener('mousedown', onPointerDown, true);
    this.disposables.push(
      () => this.panel.removeEventListener('mousedown', onPointerDown, true),
      () => this.listEl.removeEventListener('dragover', onDragOver),
      () => this.listEl.removeEventListener('dragleave', onDragLeave),
      () => this.listEl.removeEventListener('drop', onDrop),
    );
  }

  private clearDropMarks(): void {
    this.listEl.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  }

  /** The drag is over (dropped, or cancelled with Escape or outside the list). */
  private endDrag(): void {
    if (!this.dragId) return;
    this.dragId = null;
    this.clearDropMarks();
    this.listEl.querySelectorAll('.is-dragging, .drag-ghost').forEach((el) => el.classList.remove('is-dragging', 'drag-ghost'));
    this.render(); // catch up on any change held back during the drag
  }

  /** The list with `dragId` moved before or after `targetId`, or null when that
   *  crosses groups or leaves the group's order as it was. Works on the whole
   *  list: rows are drawn grouped by kind, so placing it next to a row of its own
   *  kind is enough. "As it was" is judged within the group, because the stored
   *  list interleaves kinds: moving a project past a link changes the list but
   *  not a single row on screen. */
  private reordered(dragId: string, targetId: string, after: boolean): Bookmark[] | null {
    const dragged = this.bookmarks.find((b) => b.id === dragId);
    const target = this.bookmarks.find((b) => b.id === targetId);
    if (!dragged || !target || dragged.kind !== target.kind || dragId === targetId) return null;
    const next = this.bookmarks.filter((b) => b.id !== dragId);
    next.splice(next.indexOf(target) + (after ? 1 : 0), 0, dragged);
    const groupOrder = (list: Bookmark[]) => list.filter((b) => b.kind === dragged.kind).map((b) => b.id).join('\n');
    return groupOrder(next) !== groupOrder(this.bookmarks) ? next : null;
  }

  private async commitReorder(dragId: string, next: Bookmark[]): Promise<void> {
    const bookmark = this.bookmarks.find((b) => b.id === dragId);
    if (!bookmark) return;
    const group = (list: Bookmark[]) => list.filter((b) => b.kind === bookmark.kind);
    const from = group(this.bookmarks).findIndex((b) => b.id === dragId);
    const to = group(next).findIndex((b) => b.id === dragId);
    if (await this.saveOrder(next)) {
      rlog('info', '[BOOKMARK] reordered', { kind: bookmark.kind, from, to, via: 'drag' });
      announce(`Moved ${bookmark.label} to position ${to + 1} of ${group(next).length}`);
    }
  }

  /** Save a reordered list, drawing the new order at once rather than after the
   *  IPC round trip (which would show the old order for a moment and then jump).
   *  True only when main stored exactly this order: its rate limit answers with
   *  the old list, which save() alone would count as success. */
  private async saveOrder(next: Bookmark[]): Promise<boolean> {
    const prev = this.bookmarks;
    this.bookmarks = next;
    this.render();
    const saved = await this.save(next);
    if (this.bookmarks === next) {
      // save() threw before main answered: put back what was there.
      this.bookmarks = prev;
      this.render();
    }
    const ids = (list: Bookmark[]) => list.map((b) => b.id).join('\n');
    if (saved && ids(this.bookmarks) === ids(next)) return true;
    if (saved) {
      rlog('warn', '[BOOKMARK] order not stored', { sent: next.length, stored: this.bookmarks.length });
      announce('The new order could not be saved', 'assertive');
    }
    return false;
  }

  // ── Row menu: rename, move, remove ──

  private showRowMenu(bookmark: Bookmark, x: number, y: number, row: HTMLElement, viaKeyboard: boolean): void {
    const sameKind = this.bookmarks.filter((b) => b.kind === bookmark.kind);
    const pos = sameKind.findIndex((b) => b.id === bookmark.id);
    this.menuRowId = bookmark.id;
    this.contextMenu.show(x, y, [
      { label: bookmark.kind === 'project' ? 'Open' : 'Open in Browser', action: () => { this.open(bookmark).catch(console.error); } },
      { label: 'Rename…', action: () => this.startRename(bookmark) },
      ...(pos > 0 ? [{ label: 'Move Up', action: () => { this.move(bookmark, -1).catch(console.error); } }] : []),
      ...(pos < sameKind.length - 1 ? [{ label: 'Move Down', action: () => { this.move(bookmark, 1).catch(console.error); } }] : []),
      { separator: true as const },
      { label: 'Remove…', action: () => { this.remove(bookmark).catch(console.error); } },
    ], row, viaKeyboard);
  }

  /** Swap with the neighbouring bookmark of the same kind (groups are by kind). */
  private async move(bookmark: Bookmark, direction: -1 | 1): Promise<void> {
    const next = [...this.bookmarks];
    const from = next.findIndex((b) => b.id === bookmark.id);
    if (from === -1) return;
    let to = from + direction;
    while (to >= 0 && to < next.length && next[to].kind !== bookmark.kind) to += direction;
    if (to < 0 || to >= next.length) return;
    [next[from], next[to]] = [next[to], next[from]];
    const moved = await this.saveOrder(next);
    this.focusRow(bookmark.id);
    if (moved) {
      rlog('info', '[BOOKMARK] reordered', { kind: bookmark.kind, via: 'menu', direction });
      announce(`Moved ${bookmark.label} ${direction < 0 ? 'up' : 'down'}`);
    }
  }

  private async remove(bookmark: Bookmark): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: 'Remove bookmark?',
      message: `"${bookmark.label}" will be removed from the sidebar. Its folder or page is not touched.`,
      confirmLabel: 'Remove',
    });
    if (!ok) {
      this.focusRow(bookmark.id);
      return;
    }
    // Position among the rows as drawn (DOM order, grouped by kind), so focus can
    // land on the row that takes its place.
    const domIds = Array.from(this.listEl.querySelectorAll<HTMLElement>('.bookmark-row')).map((r) => r.dataset.bookmarkId);
    const index = domIds.indexOf(bookmark.id);
    const saved = await this.save(this.bookmarks.filter((b) => b.id !== bookmark.id));
    if (saved) {
      rlog('info', '[BOOKMARK] removed', { kind: bookmark.kind, label: bookmark.label });
      announce(`Removed ${bookmark.label}`);
      const rows = this.listEl.querySelectorAll<HTMLElement>('.bookmark-row');
      // The row now at the removed row's position, else the one before it.
      (rows[Math.min(Math.max(index, 0), rows.length - 1)] ?? this.addButton).focus();
    }
  }

  private startRename(bookmark: Bookmark): void {
    const row = this.listEl.querySelector<HTMLElement>(`.bookmark-row[data-bookmark-id="${CSS.escape(bookmark.id)}"]`);
    const li = row?.parentElement;
    if (!row || !li) return;

    this.renamingId = bookmark.id;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bookmark-rename';
    input.value = bookmark.label;
    input.maxLength = DEFAULTS.BOOKMARK_LABEL_MAX_CHARS;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Rename bookmark');
    row.hidden = true;
    li.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.renamingId = null;
      const label = input.value.trim();
      input.remove();
      row.hidden = false;
      if (commit && label && label !== bookmark.label) {
        const next = this.bookmarks.map((b) => (b.id === bookmark.id ? { ...b, label } : b));
        this.save(next).then(() => this.focusRow(bookmark.id)).catch(console.error);
      } else {
        this.render(); // catch up on any change held back during the rename
        this.focusRow(bookmark.id);
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault(); // tells the panel's Escape handler this one is handled
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ── Header "+" menu and the artifact form ──

  private setupHeader(): void {
    const openMenu = (e?: MouseEvent) => {
      const viaKeyboard = !e || e.detail === 0; // Enter/Space on the button fires a click with detail 0
      const tab = this.host.getActiveTab();
      const hasProject = !!tab?.project;
      const rect = this.addButton.getBoundingClientRect();
      this.contextMenu.show(rect.left, rect.bottom + 2, [
        {
          label: hasProject || !tab ? 'Bookmark Current Project' : 'Bookmark Current Folder (not a project)',
          action: () => { this.addProjectFromTab(tab).catch(console.error); },
        },
        { label: 'Add Artifact Link…', action: () => { this.openForm().catch(console.error); } },
      ], this.addButton, viaKeyboard);
    };
    this.addButton.addEventListener('click', openMenu);
    this.disposables.push(() => this.addButton.removeEventListener('click', openMenu));

    const onHide = () => {
      rlog('info', '[BOOKMARK] panel hidden', { via: 'button' });
      this.hide();
    };
    this.hideButton.addEventListener('click', onHide);
    this.disposables.push(() => this.hideButton.removeEventListener('click', onHide));
  }

  private setupRail(): void {
    const onShow = () => {
      rlog('info', '[BOOKMARK] panel shown', { via: 'strip' });
      this.show(true).catch((err) => rlog('warn', '[BOOKMARK] Could not open panel', err));
    };
    this.rail.addEventListener('click', onShow);
    this.disposables.push(() => this.rail.removeEventListener('click', onShow));
  }

  private setupForm(): void {
    const onSubmit = (e: Event) => {
      e.preventDefault();
      this.submitForm().catch(console.error);
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelForm();
        this.addButton.focus();
      }
    };
    const cancelBtn = this.form.querySelector('.bookmarks-form-cancel') as HTMLButtonElement;
    const onCancel = () => {
      this.cancelForm();
      this.addButton.focus();
    };
    this.form.addEventListener('submit', onSubmit);
    this.form.addEventListener('keydown', onKeydown);
    cancelBtn.addEventListener('click', onCancel);
    this.disposables.push(
      () => this.form.removeEventListener('submit', onSubmit),
      () => this.form.removeEventListener('keydown', onKeydown),
      () => cancelBtn.removeEventListener('click', onCancel),
    );
  }

  private async openForm(): Promise<void> {
    if (!this.isOpen) await this.show(false);
    this.formError.textContent = '';
    this.urlInput.value = '';
    this.labelInput.value = '';
    // Prefill from the clipboard when it holds an https link — the usual case
    // is "copy the artifact's URL, then bookmark it".
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (isHttpsUrl(clip)) this.urlInput.value = clip;
    } catch {
      // Clipboard unavailable — the box just starts empty.
    }
    this.form.hidden = false;
    (this.urlInput.value ? this.labelInput : this.urlInput).focus();
  }

  private cancelForm(): void {
    this.form.hidden = true;
    this.formError.textContent = '';
  }

  private async submitForm(): Promise<void> {
    const url = this.urlInput.value.trim();
    if (!isHttpsUrl(url)) {
      this.formError.textContent = 'Enter a link starting with https://';
      this.urlInput.focus();
      return;
    }
    const label = (this.labelInput.value.trim() || hostOf(url)).slice(0, DEFAULTS.BOOKMARK_LABEL_MAX_CHARS);
    const bookmark: Bookmark = { id: newId(), kind: 'artifact', label, url, addedAt: Date.now() };
    const saved = await this.save([...this.bookmarks, bookmark]);
    if (!saved) {
      this.formError.textContent = 'That link could not be saved.';
      return;
    }
    rlog('info', '[BOOKMARK] added', { kind: 'artifact', host: hostOf(url) });
    announce(`Bookmarked ${label}`);
    this.cancelForm();
    this.focusRow(bookmark.id);
  }

  // ── Keyboard: arrows move between rows, menu key opens the row menu ──

  private setupListKeys(): void {
    const onKeydown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('bookmark-row')) return;
      const rows = Array.from(this.listEl.querySelectorAll<HTMLElement>('.bookmark-row'));
      const idx = rows.indexOf(target);
      let next = -1;
      if (e.key === 'ArrowDown') next = Math.min(idx + 1, rows.length - 1);
      else if (e.key === 'ArrowUp') next = Math.max(idx - 1, 0);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = rows.length - 1;
      else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const bookmark = this.bookmarks.find((b) => b.id === target.dataset.bookmarkId);
        const rect = target.getBoundingClientRect();
        if (bookmark) this.showRowMenu(bookmark, rect.left + 12, rect.bottom, target, true);
        return;
      } else {
        return;
      }
      e.preventDefault();
      rows[next]?.focus();
    };
    this.listEl.addEventListener('keydown', onKeydown);
    this.disposables.push(() => this.listEl.removeEventListener('keydown', onKeydown));
  }

  // ── Resizer on the right edge ──

  private setupResizer(): void {
    const resizer = this.panel.querySelector('.bookmarks-resizer') as HTMLElement;
    let startX = 0;
    let startWidth = 0;
    let dragging = false;

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      // Docked left, so dragging the right edge rightward widens it.
      const delta = e.clientX - startX;
      const next = Math.max(DEFAULTS.BOOKMARKS_PANEL_MIN_WIDTH, Math.min(window.innerWidth * 0.5, startWidth + delta));
      this.panel.style.width = `${next}px`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(
        WIDTH_STORAGE_KEY,
        String(parseInt(this.panel.style.width, 10) || DEFAULTS.BOOKMARKS_PANEL_WIDTH),
      );
    };
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startWidth = this.panel.getBoundingClientRect().width;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    };

    resizer.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    this.disposables.push(
      () => resizer.removeEventListener('mousedown', onDown),
      () => document.removeEventListener('mousemove', onMove),
      () => document.removeEventListener('mouseup', onUp),
    );
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d();
    this.contextMenu.dispose();
    this.confirmDialog.dispose();
    this.rail.remove();
    this.panel.remove();
  }
}
