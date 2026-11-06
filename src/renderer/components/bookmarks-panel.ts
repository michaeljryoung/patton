import { DEFAULTS } from '../../shared/constants';
import type { Bookmark } from '../../shared/types';
import { announce } from '../services/announcer';
import { projectName } from '../services/project-names';
import { rlog } from '../services/renderer-logger';
import { runStartupCommand } from '../services/startup-command';
import { ConfirmDialog } from './confirm-dialog';
import { ContextMenu } from './context-menu';
import type { Tab } from './tab';

const WIDTH_STORAGE_KEY = 'patton.bookmarks.width';
const OPEN_STORAGE_KEY = 'patton.bookmarks.open';
const REFRESH_DEBOUNCE_MS = 100;

/** What the panel needs from the window's tabs. Kept narrow so the panel
 *  doesn't reach into TabManager's internals. */
export interface BookmarksHost {
  getTabs(): readonly Tab[];
  getActiveTab(): Tab | null;
  switchToTab(id: string): void;
  createTab(cwd: string): Promise<Tab>;
  /** Hand keyboard focus back to the active terminal pane. */
  focusTerminal(): void;
}

/** "/Users/michael/Projects/patton" → "~/Projects/patton" (macOS home layout). */
function tildePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
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
 * startup command, which on Michael's Mac launches Claude Code) and an
 * artifact (an https link, opened in the browser).
 *
 * One tab per project: clicking a project that already has a tab in this
 * window activates that tab instead of opening a second one. Rows whose project
 * has a tab open are marked (dot + bold); the row for the active tab's project
 * gets the accent background and `aria-current`.
 *
 * The list lives in the encrypted store (main validates every save and
 * broadcasts it to all windows); width and open/closed state are renderer-local
 * preferences in localStorage, as with the notes panel.
 */
export class BookmarksPanel {
  private panel: HTMLElement;
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
  // Paths whose tab is being created, so a double-click can't open two tabs.
  private opening = new Set<string>();
  // Tab id → bookmark path for tabs a bookmark opened. A new tab doesn't know
  // its folder or project until the shell reports it; until then this is what
  // ties the tab to its bookmark.
  private openedBy = new Map<string, string>();
  // What the list last showed. Tab titles change every second while Claude
  // works and each change refreshes the panel, so an unchanged list is left
  // alone rather than rebuilt (which would also drop hover and an open row menu).
  private lastRendered = '';

  constructor(container: HTMLElement, host: BookmarksHost) {
    this.host = host;

    this.panel = document.createElement('nav');
    this.panel.id = 'bookmarks-panel';
    this.panel.className = 'collapsed';
    this.panel.setAttribute('aria-label', 'Bookmarks');
    this.panel.innerHTML = `
      <div class="bookmarks-header">
        <span id="bookmarks-heading">Bookmarks</span>
        <button type="button" class="bookmarks-add" aria-label="Add bookmark" aria-haspopup="menu" title="Add bookmark">+</button>
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
    this.setupForm();
    this.setupListKeys();
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

    if (localStorage.getItem(OPEN_STORAGE_KEY) === '1') {
      this.show(false).catch((err) => rlog('warn', '[BOOKMARK] Could not restore panel', err));
    }
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
    localStorage.setItem(OPEN_STORAGE_KEY, '1');
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
    this.lastRendered = ''; // rebuild on the next show
    localStorage.setItem(OPEN_STORAGE_KEY, '0');
    announce('Bookmarks closed', 'polite');
    this.host.focusTerminal();
  }

  // ── Persistence ──

  /** Save the whole list; main validates it and answers with what it stored.
   *  Returns false when an entry was refused (e.g. its folder is gone). */
  private async save(next: Bookmark[]): Promise<boolean> {
    try {
      const stored = await window.patton.bookmarks.set(next);
      this.bookmarks = stored;
      this.render();
      if (stored.length < next.length) {
        announce('A bookmark could not be saved — its folder or link was not valid', 'assertive');
        rlog('warn', '[BOOKMARK] main refused entries', { sent: next.length, stored: stored.length });
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

  private tabMatches(tab: Tab, path: string): boolean {
    if (tab.project?.root === path) return true;
    const cwd = tab.focusedPane.getCwd();
    if (cwd === path) return true;
    // Freshly opened by this bookmark and the shell hasn't reported its folder yet.
    return !tab.project && !cwd && this.openedBy.get(tab.id) === path;
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
      const tab = await this.host.createTab(path);
      this.openedBy.set(tab.id, path);
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

  // ── Rendering ──

  private render(): void {
    if (this.renamingId || !this.isOpen) return;

    const tabs = this.host.getTabs();
    // Forget tabs that have closed.
    for (const tabId of [...this.openedBy.keys()]) {
      if (!tabs.some((t) => t.id === tabId)) this.openedBy.delete(tabId);
    }
    const active = this.host.getActiveTab();
    const states = new Map<string, { isOpen: boolean; isCurrent: boolean }>();
    for (const bookmark of this.bookmarks) {
      const path = bookmark.kind === 'project' ? bookmark.path : undefined;
      const isOpen = !!path && tabs.some((t) => this.tabMatches(t, path));
      const isCurrent = isOpen && !!path && !!active && this.tabMatches(active, path);
      states.set(bookmark.id, { isOpen, isCurrent });
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
      heading.textContent = group.title;
      section.appendChild(heading);

      const ul = document.createElement('ul');
      ul.className = 'bookmarks-items';
      for (const bookmark of items) {
        const state = states.get(bookmark.id) ?? { isOpen: false, isCurrent: false };
        ul.appendChild(this.renderRow(bookmark, state.isOpen, state.isCurrent));
      }
      section.appendChild(ul);
      this.listEl.appendChild(section);
    }

    if (hadFocusId) this.focusRow(hadFocusId);
  }

  private renderRow(bookmark: Bookmark, isOpen: boolean, isCurrent: boolean): HTMLElement {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bookmark-row';
    row.dataset.bookmarkId = bookmark.id;
    row.classList.toggle('is-open', isOpen);
    row.classList.toggle('is-current', isCurrent);
    if (isCurrent) row.setAttribute('aria-current', 'true');
    row.setAttribute('aria-haspopup', 'menu');

    const subtitle = bookmark.kind === 'project' ? tildePath(bookmark.path ?? '') : hostOf(bookmark.url ?? '');
    const state = isCurrent ? ', open in the active tab' : isOpen ? ', open' : '';
    row.setAttribute('aria-label', `${bookmark.label}, ${subtitle}${state}`);
    row.title = bookmark.kind === 'project' ? (bookmark.path ?? '') : (bookmark.url ?? '');

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

    row.addEventListener('click', () => {
      this.open(bookmark).catch((err) => rlog('error', '[BOOKMARK] open failed', String(err)));
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showRowMenu(bookmark, e.clientX, e.clientY, row);
    });

    li.appendChild(row);
    return li;
  }

  private focusRow(id: string): void {
    const row = this.listEl.querySelector<HTMLElement>(`.bookmark-row[data-bookmark-id="${CSS.escape(id)}"]`);
    row?.focus();
  }

  // ── Row menu: rename, move, remove ──

  private showRowMenu(bookmark: Bookmark, x: number, y: number, row: HTMLElement): void {
    const sameKind = this.bookmarks.filter((b) => b.kind === bookmark.kind);
    const pos = sameKind.findIndex((b) => b.id === bookmark.id);
    this.contextMenu.show(x, y, [
      { label: bookmark.kind === 'project' ? 'Open' : 'Open in Browser', action: () => { this.open(bookmark).catch(console.error); } },
      { label: 'Rename…', action: () => this.startRename(bookmark) },
      ...(pos > 0 ? [{ label: 'Move Up', action: () => { this.move(bookmark, -1).catch(console.error); } }] : []),
      ...(pos < sameKind.length - 1 ? [{ label: 'Move Down', action: () => { this.move(bookmark, 1).catch(console.error); } }] : []),
      { separator: true as const },
      { label: 'Remove…', action: () => { this.remove(bookmark).catch(console.error); } },
    ], row);
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
    await this.save(next);
    this.focusRow(bookmark.id);
    announce(`Moved ${bookmark.label} ${direction < 0 ? 'up' : 'down'}`);
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
    const index = this.bookmarks.findIndex((b) => b.id === bookmark.id);
    const saved = await this.save(this.bookmarks.filter((b) => b.id !== bookmark.id));
    if (saved) {
      rlog('info', '[BOOKMARK] removed', { kind: bookmark.kind, label: bookmark.label });
      announce(`Removed ${bookmark.label}`);
      const rows = this.listEl.querySelectorAll<HTMLElement>('.bookmark-row');
      (rows[Math.min(index, rows.length - 1)] ?? this.addButton).focus();
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
    const openMenu = () => {
      const tab = this.host.getActiveTab();
      const hasProject = !!tab?.project;
      const rect = this.addButton.getBoundingClientRect();
      this.contextMenu.show(rect.left, rect.bottom + 2, [
        {
          label: hasProject || !tab ? 'Bookmark Current Project' : 'Bookmark Current Folder (not a project)',
          action: () => { this.addProjectFromTab(tab).catch(console.error); },
        },
        { label: 'Add Artifact Link…', action: () => { this.openForm().catch(console.error); } },
      ], this.addButton);
    };
    this.addButton.addEventListener('click', openMenu);
    this.disposables.push(() => this.addButton.removeEventListener('click', openMenu));
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
        if (bookmark) this.showRowMenu(bookmark, rect.left + 12, rect.bottom, target);
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
    this.panel.remove();
  }
}
