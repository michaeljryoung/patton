import { ContextMenu } from './context-menu';
import { announce } from '../services/announcer';
import { onUiTextScaleApplied } from '../services/ui-text-scale';
import { DEFAULTS } from '../../shared/constants';
import type { TabFlag } from '../../shared/types';
import type { CheckpointView } from '../services/checkpoint-clock';
import type { HoverBlock } from '../services/tab-hover';
import { TabHoverCard } from './tab-hover-card';

export interface TabBarCallbacks {
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onReorder: (fromId: string, toId: string) => void;
  onSettings: () => void;
  onRename: (id: string, name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onSetFlag: (id: string, flag: TabFlag | null) => void;
  onBookmarkProject?: (id: string) => void; // bookmarks sidebar
  /** The checkpoint clock was clicked: run /checkpoint in the focused pane. */
  onCheckpoint?: () => void;
  /** Pause all was clicked: pause every window's Claude panes that can take it. */
  onPauseAll?: () => void;
  /** What the tab hover card shows for a tab, one block per pane (focused
   *  first), or null if the tab is gone. Given = the card is on, and tabs
   *  carry no native `title` tooltip (it would cover the card). */
  describeTab?: (id: string) => HoverBlock[] | null;
}

interface TabHeaderInfo {
  id: string;
  title: string;
  /** What the tab strip writes on the tab, when shorter than `title` (an
   *  automatic name cut to 15 characters); `title` stays the tooltip, the
   *  accessible name and the rename box's value. */
  displayTitle?: string;
  /** What the tab shows without a name of its own — the rename box's placeholder. */
  autoTitle?: string;
  /** The tab's project, if it is in one: its current and automatic names. */
  project?: { name: string; defaultName: string } | null;
  active: boolean;
  awaitingInput?: boolean;
  /** A /checkpoint finished in this tab and it hasn't been selected since. */
  checkpointDone?: boolean;
  flag?: TabFlag | null;
  /** Set from the pane title (`WAKE` → yellow); shown only when no manual flag is. */
  autoFlag?: TabFlag | null;
  /** Claude Code is waiting on its own background work (Stop hook or OSC
   *  7501 task records, whose titles are untrusted text), not on you. */
  parked?: { tasks: number; crons: number; titles?: string[] } | null;
  /** Why the tab needs you (Claude Code's own status report), plain text. */
  waitingText?: string | null;
}

/** Task titles listed in the parked tooltip before "and N more". */
const PARKED_TITLES_SHOWN = 5;

function parkedText({ tasks, crons, titles }: { tasks: number; crons: number; titles?: string[] }): string {
  const counts: string[] = [];
  if (tasks > 0 || crons === 0) counts.push(`${tasks} ${tasks === 1 ? 'task' : 'tasks'}`);
  if (crons > 0) counts.push(`${crons} ${crons === 1 ? 'timer' : 'timers'}`);
  let text = `Waiting on its own background work (${counts.join(', ')})`;
  if (titles && titles.length > 0) {
    const shown = titles.slice(0, PARKED_TITLES_SHOWN).join('; ');
    const more = titles.length - PARKED_TITLES_SHOWN;
    text += `: ${shown}${more > 0 ? ` and ${more} more` : ''}`;
  }
  return text;
}

/** The tab's title plus whatever its dot says, e.g. "patton, waiting for you". */
function tabLabel(tab: TabHeaderInfo, needsYou: boolean, shownFlag: TabFlag | null, ckpt: boolean): string {
  const states: string[] = [];
  if (ckpt) states.push('checkpoint finished');
  if (needsYou) states.push(tab.waitingText ? `waiting for you (${tab.waitingText})` : 'waiting for you');
  if (shownFlag) states.push(`flagged ${shownFlag}`);
  if (tab.parked && !needsYou && !shownFlag) states.push(parkedText(tab.parked).toLowerCase());
  return states.length > 0 ? `${tab.title}, ${states.join(', ')}` : tab.title;
}

interface RenameOptions {
  value: string;
  /** Shown when the box is emptied: what committing an empty box goes back to. */
  placeholder: string;
  ariaLabel: string;
  maxLength: number;
  onCommit: (name: string) => void;
}

/** Right-click menu entries for the colour flags, in a fixed order so the
 *  positions stay muscle-memory stable. */
const FLAG_CHOICES: { flag: TabFlag; label: string }[] = [
  { flag: 'green', label: 'Green' },
  { flag: 'yellow', label: 'Yellow' },
  { flag: 'red', label: 'Red' },
];

export class TabBar {
  private container: HTMLElement;
  private tabsContainer: HTMLElement;
  private checkpointBtn: HTMLButtonElement;
  /** The clock's last view, restored when a "why not" message ends. */
  private checkpointView: CheckpointView | null = null;
  private checkpointReasonTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly CHECKPOINT_REASON_MS = 4000;
  private pauseBtn: HTMLButtonElement;
  /** The popover under the Pause all icon that carries a press's result. */
  private pauseResultEl: HTMLDivElement;
  private pauseResultTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PAUSE_RESULT_MS = 4000;
  private callbacks: TabBarCallbacks;
  private draggedId: string | null = null;
  private contextMenu = new ContextMenu();
  /** Opens each tab element's context menu; the keyboard route to the same menu. */
  private tabMenuOpeners = new WeakMap<HTMLElement, (x: number, y: number, viaKeyboard: boolean) => void>();
  // update() rebuilds every tab element, which would destroy an open rename
  // box mid-typing whenever any tab's title or dot changes. While a box is
  // open, the latest update is held here and applied when the box closes.
  private renameOpen = false;
  /** The latest window-drag press moved past the threshold (see startWindowDrag). */
  private dragMoved = false;
  private heldUpdate: TabHeaderInfo[] | null = null;
  /** The tabs as last handed to update() (held ones included), so an action
   *  from a menu opened earlier reads the tab as it is now. */
  private latestTabs: TabHeaderInfo[] = [];
  private lastActiveId: string | null = null;
  private lastTabCount = 0;
  private stopScaleWatch: (() => void) | null = null;
  private hoverCard: TabHoverCard | null = null;

  constructor(container: HTMLElement, callbacks: TabBarCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.container.className = 'tab-bar';
    // --- Accessibility ---
    this.container.setAttribute('role', 'toolbar');
    this.container.setAttribute('aria-label', 'Tab bar');

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'tab-bar-settings';
    settingsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.title = 'Settings (Cmd+,)';
    settingsBtn.addEventListener('click', () => this.callbacks.onSettings());
    this.container.appendChild(settingsBtn);

    this.tabsContainer = document.createElement('div');
    this.tabsContainer.className = 'tab-bar-tabs';
    this.tabsContainer.setAttribute('role', 'tablist');
    this.container.appendChild(this.tabsContainer);
    // A new Interface Text Size changes every tab's width (and the strip's
    // scroll extent), which can leave the active tab off-screen: bring it back.
    this.stopScaleWatch = onUiTextScaleApplied(() => this.revealActive());
    if (callbacks.describeTab) {
      this.hoverCard = new TabHoverCard(this.tabsContainer, callbacks.describeTab);
    }

    // --- Keyboard navigation (WAI-ARIA roving tabindex pattern) ---
    // Arrow keys move focus between tabs and activate them; Home/End jump
    // to the ends. Only fires when a tab already has focus (so we don't
    // hijack arrow keys inside rename inputs or unrelated UI).
    this.tabsContainer.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('tab-bar-tab')) return;
      const tabEls = Array.from(this.tabsContainer.querySelectorAll<HTMLElement>('.tab-bar-tab'));
      if (tabEls.length === 0) return;
      const currentIdx = tabEls.indexOf(target);
      if (currentIdx === -1) return;
      // Menu key / Shift+F10: the context menu is the only keyboard route to
      // Move Left / Move Right, flags and bookmarking.
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const rect = target.getBoundingClientRect();
        this.tabMenuOpeners.get(target)?.(rect.left + 12, rect.bottom, true);
        return;
      }
      let nextIdx: number | null = null;
      if (e.key === 'ArrowLeft') nextIdx = (currentIdx - 1 + tabEls.length) % tabEls.length;
      else if (e.key === 'ArrowRight') nextIdx = (currentIdx + 1) % tabEls.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = tabEls.length - 1;
      if (nextIdx === null) return;
      e.preventDefault();
      const nextEl = tabEls[nextIdx];
      const nextId = nextEl.dataset.tabId;
      if (nextId) {
        this.callbacks.onSelect(nextId);
        // After update(), the new active tab is focusable (tabindex=0)
        requestAnimationFrame(() => {
          const refreshed = this.tabsContainer.querySelector<HTMLElement>(`.tab-bar-tab[data-tab-id="${CSS.escape(nextId)}"]`);
          refreshed?.focus();
        });
      }
    });

    // Empty space in the tabs container moves the window like a title bar
    // (drag, and double-click for the Mac's title-bar action). Done by JS, not
    // by -webkit-app-region, so the mouse events still reach us.
    this.tabsContainer.addEventListener('mousedown', (e) => {
      // Only handle clicks on the container itself, not on child tabs
      if ((e.target as HTMLElement).closest('.tab-bar-tab')) return;
      this.startWindowDrag(e, { keepFocus: true });
    });
    this.tabsContainer.addEventListener('dblclick', (e) => {
      if (e.target !== this.tabsContainer || this.dragMoved) return;
      window.patton.titleBarDoubleClick();
    });

    const newBtn = document.createElement('button');
    newBtn.className = 'tab-bar-new';
    newBtn.textContent = '+';
    newBtn.setAttribute('aria-label', 'New Tab');
    newBtn.title = 'New Tab (Cmd+T)';
    newBtn.addEventListener('click', () => this.callbacks.onNew());
    this.container.appendChild(newBtn);

    // A blank spacer as wide as the + button, always present (it never shrinks;
    // the tabs scroll instead), so there is somewhere to grab or double-click
    // the window even when the tabs fill the strip. Drags and double-clicks like
    // the empty tabs area; no-drag (see tabs.css) so the events reach us.
    const dragSpace = document.createElement('div');
    dragSpace.className = 'tab-bar-drag-space';
    dragSpace.setAttribute('aria-hidden', 'true');
    dragSpace.addEventListener('mousedown', (e) => this.startWindowDrag(e, { keepFocus: true }));
    dragSpace.addEventListener('dblclick', () => {
      if (this.dragMoved) return;
      window.patton.titleBarDoubleClick();
    });
    this.container.appendChild(dragSpace);

    // Checkpoint clock, pinned at the strip's right end outside the scrolling
    // tabs: total context used by the focused Claude session (amber when it has
    // grown past the reminder share since its last /checkpoint).
    // Hidden until setCheckpoint() has a Claude pane to show.
    this.checkpointBtn = document.createElement('button');
    this.checkpointBtn.type = 'button';
    this.checkpointBtn.className = 'tab-bar-checkpoint';
    this.checkpointBtn.hidden = true;
    // Always handled, ready or not: while Claude can't take /checkpoint the
    // click shows why (TabManager.runCheckpoint → showCheckpointReason).
    this.checkpointBtn.addEventListener('click', () => {
      this.callbacks.onCheckpoint?.();
    });
    this.container.appendChild(this.checkpointBtn);

    // Pause all, at the strip's far right (the checkpoint clock sits just left
    // of it): types `pause` into every window's Claude panes. Idle it is
    // only the "⏸" icon, and every press pauses again; resume is typed by hand, tab
    // by tab. Always shown.
    this.pauseBtn = document.createElement('button');
    this.pauseBtn.type = 'button';
    this.pauseBtn.className = 'tab-bar-pause-all';
    this.pauseBtn.addEventListener('click', () => {
      this.callbacks.onPauseAll?.();
    });
    this.container.appendChild(this.pauseBtn);
    // A press's result is shown in this popover (tabs.css), not in the button:
    // the button keeps its icon size, so the tabs never move. The caller
    // announces the text, so the popover is hidden from screen readers.
    this.pauseResultEl = document.createElement('div');
    this.pauseResultEl.className = 'tab-bar-pause-result';
    this.pauseResultEl.setAttribute('aria-hidden', 'true');
    this.pauseResultEl.hidden = true;
    // Before the button, which stays the strip's last child; the popover is out of the flow.
    this.container.insertBefore(this.pauseResultEl, this.pauseBtn);
    this.renderPauseButton();
  }

  /** Moves the window with the mouse after a 5 px threshold (left button only).
   *  keepFocus: the press doesn't take keyboard focus from the terminal (the
   *  blank areas; a tab keeps its default focus behaviour). Not while a rename
   *  box is open: the press must blur it so the name commits. A press that
   *  moves sets dragMoved, so the dblclick of a press-release-press-drag
   *  doesn't zoom. onClickWithoutDrag runs on release if the mouse never
   *  passed the threshold (a tab's select-on-click). */
  private startWindowDrag(e: MouseEvent, opts: { keepFocus?: boolean; onClickWithoutDrag?: () => void } = {}): void {
    if (e.button !== 0) return;
    if (opts.keepFocus && !this.renameOpen) e.preventDefault();
    this.dragMoved = false;
    let dragging = false;
    let lastX = e.screenX;
    let lastY = e.screenY;
    const startX = e.screenX;
    const startY = e.screenY;
    const onMove = (me: MouseEvent) => {
      if (!dragging && Math.abs(me.screenX - startX) < 5 && Math.abs(me.screenY - startY) < 5) return;
      dragging = true;
      this.dragMoved = true;
      const dx = me.screenX - lastX;
      const dy = me.screenY - lastY;
      lastX = me.screenX;
      lastY = me.screenY;
      window.patton.moveWindowBy(dx, dy);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!dragging) opts.onClickWithoutDrag?.();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /** A press's result in a popover under the icon for a few seconds (the
   *  caller announces it too); the button keeps its size and its icon. */
  showPauseResult(text: string): void {
    if (this.pauseResultTimer) clearTimeout(this.pauseResultTimer);
    this.pauseResultEl.textContent = text;
    this.pauseResultEl.hidden = false;
    this.pauseBtn.title = text;
    this.pauseResultTimer = setTimeout(() => {
      this.pauseResultTimer = null;
      this.pauseResultEl.hidden = true;
      this.pauseResultEl.textContent = '';
      this.renderPauseButton();
    }, TabBar.PAUSE_RESULT_MS);
  }

  private renderPauseButton(): void {
    const btn = this.pauseBtn;
    // Idle, the button is only the icon (the strip's room is for tabs); the
    // full words stay in the accessible name and the tooltip.
    btn.textContent = '\u23f8';
    const label = 'Pause all: type pause into every Claude session in every window, skipping any waiting on you';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  /** The tab next to this one in the strip (-1 left, 1 right), or null at an end. */
  private neighbourId(tabId: string, dir: -1 | 1): string | null {
    const ids = Array.from(this.tabsContainer.querySelectorAll<HTMLElement>('.tab-bar-tab'))
      .map((el) => el.dataset.tabId);
    const idx = ids.indexOf(tabId);
    if (idx === -1) return null;
    return ids[idx + dir] ?? null;
  }

  update(tabs: TabHeaderInfo[]): void {
    this.latestTabs = tabs;
    if (this.renameOpen) {
      this.heldUpdate = tabs;
      return;
    }
    this.heldUpdate = null;
    // The strip scrolls sideways (hidden scrollbar) and is rebuilt on every
    // update, which empties it and resets scrollLeft: keep the position, and
    // bring the active tab into view when it is a different tab or the count
    // changed (not on every title tick, which would drag the strip back while
    // the user looks along it).
    const savedScroll = this.tabsContainer.scrollLeft;
    // A tab holding keyboard focus gets it back on its new element below, so
    // a rebuild (a title tick) doesn't drop the keyboard user, or their card.
    const focused = document.activeElement;
    const focusedTabId = focused instanceof HTMLElement && focused.classList.contains('tab-bar-tab')
      && this.tabsContainer.contains(focused) ? focused.dataset.tabId ?? null : null;
    // The same for a focused close button (a title tick rebuilds it too).
    const focusedCloseTabId = focused instanceof HTMLElement && focused.classList.contains('tab-bar-tab-close')
      && this.tabsContainer.contains(focused) ? focused.closest<HTMLElement>('.tab-bar-tab')?.dataset.tabId ?? null : null;
    this.tabsContainer.innerHTML = '';
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = `tab-bar-tab${tab.active ? ' active' : ''}`;
      el.dataset.tabId = tab.id;

      // --- Accessibility ---
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', tab.active ? 'true' : 'false');
      el.setAttribute('tabindex', tab.active ? '0' : '-1');

      // --- Drag grip for tab reordering (only this small handle initiates drag) ---
      if (tabs.length > 1) {
        const grip = document.createElement('span');
        grip.className = 'tab-bar-tab-grip';
        grip.textContent = '\u2847'; // ⡇ braille dots as grip indicator
        grip.draggable = true;
        grip.addEventListener('dragstart', (e) => {
          e.stopPropagation();
          this.draggedId = tab.id;
          e.dataTransfer!.effectAllowed = 'move';
          e.dataTransfer!.setData('text/plain', tab.id);
          el.classList.add('dragging');
        });
        grip.addEventListener('dragend', () => {
          this.draggedId = null;
          el.classList.remove('dragging');
          this.tabsContainer.querySelectorAll('.drag-over').forEach(
            el => el.classList.remove('drag-over'),
          );
        });
        el.appendChild(grip);
      }

      // --- Drop target for reordering (the whole tab accepts drops) ---
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        this.tabsContainer.querySelectorAll('.drag-over').forEach(
          el => el.classList.remove('drag-over'),
        );
        if (this.draggedId && this.draggedId !== tab.id) {
          el.classList.add('drag-over');
        }
      });
      el.addEventListener('dragleave', () => {
        el.classList.remove('drag-over');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drag-over');
        const fromId = e.dataTransfer!.getData('text/plain');
        if (fromId && fromId !== tab.id) {
          this.callbacks.onReorder(fromId, tab.id);
        }
      });

      // One dot slot, several sources, in this order. A user-set flag wins and
      // shows even on the active tab — it's a deliberate marker, so hiding it
      // on the tab you're looking at would defeat the point. The automatic
      // "awaiting input" dot comes next (inactive tabs only, pulsing), so a
      // pane that needs you is never hidden behind an automatic flag (a
      // `WAKE` title in a split pane), which uses the flag styles otherwise.
      // A flag is static, so at a glance you can tell "something just
      // happened here" from "I marked this". A hollow ring means Claude Code
      // is parked on its own background work: nothing for you yet.
      // A finished checkpoint is a red circle (automatic, so a circle), ahead
      // of the green dot, the ring and an automatic flag; inactive tabs only,
      // like the green dot. A manual flag's square shows beside it.
      const needsYou = tab.awaitingInput && !tab.active;
      const ckpt = !!tab.checkpointDone && !tab.active;
      const shownFlag = tab.flag ?? (needsYou || ckpt ? null : tab.autoFlag) ?? null;
      if (shownFlag) {
        const dot = document.createElement('span');
        dot.className = `tab-bar-tab-indicator flag-${shownFlag}`;
        dot.setAttribute('aria-label', `Flagged ${shownFlag}`);
        dot.setAttribute('role', 'img');
        el.appendChild(dot);
      }
      if (ckpt) {
        // Two indicators need a taller floor than one (tabs.css).
        if (shownFlag) el.classList.add('has-flag-and-ckpt');
        const dot = document.createElement('span');
        dot.className = 'tab-bar-tab-indicator checkpoint-done';
        dot.setAttribute('aria-label', 'Checkpoint finished');
        dot.setAttribute('role', 'img');
        el.appendChild(dot);
      } else if (!shownFlag && needsYou) {
        const dot = document.createElement('span');
        dot.className = 'tab-bar-tab-indicator';
        dot.setAttribute('aria-label', 'Awaiting input');
        dot.setAttribute('role', 'img');
        el.appendChild(dot);
      } else if (!shownFlag && tab.parked) {
        const ring = document.createElement('span');
        ring.className = 'tab-bar-tab-indicator parked';
        const text = parkedText(tab.parked);
        ring.setAttribute('aria-label', text);
        if (!this.hoverCard) ring.title = text;
        ring.setAttribute('role', 'img');
        el.appendChild(ring);
      }

      // One label for screen readers and the hover tooltip: a tab's children
      // are presentational in ARIA, so the dots' own labels never reach the
      // tab's accessible name, and the dots themselves have no tooltip. With
      // the hover card on, the card is the tooltip and the tab has no title.
      const label = tabLabel(tab, needsYou, shownFlag, ckpt);
      el.setAttribute('aria-label', label);
      if (!this.hoverCard) el.title = label;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'tab-bar-tab-title';
      const shown = tab.displayTitle ?? tab.title;
      titleSpan.textContent = shown;
      // Reserves the bold (active) width in CSS so switching tabs doesn't shift the rest.
      titleSpan.dataset.title = shown;
      el.appendChild(titleSpan);

      // Double-click to rename this one tab
      titleSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.startTabRename(titleSpan, tab);
      });

      // Right-click → set/clear the colour flag, or rename the tab's project.
      const showTabMenu = (x: number, y: number, viaKeyboard: boolean): void => {
        const project = tab.project;
        this.contextMenu.show(x, y, [
          ...FLAG_CHOICES.map(({ flag, label }) => ({
            // A check marks the current flag, and re-picking it clears — so the
            // menu doubles as the toggle rather than needing a separate step.
            label: tab.flag === flag ? `✓ ${label}` : label,
            action: () => this.callbacks.onSetFlag(tab.id, flag),
          })),
          { separator: true as const },
          {
            label: 'Clear Flag',
            action: () => this.callbacks.onSetFlag(tab.id, null),
          },
          // --- Reorder from the keyboard-reachable menu (the grip is mouse-only) ---
          { separator: true as const },
          ...([-1, 1] as const).map((dir) => ({
            label: dir < 0 ? 'Move Left' : 'Move Right',
            disabled: this.neighbourId(tab.id, dir) === null,
            action: () => {
              // The bar may have been rebuilt while the menu was open: look again.
              const neighbour = this.neighbourId(tab.id, dir);
              if (!neighbour) return;
              this.callbacks.onReorder(tab.id, neighbour);
              announce(`${tab.title} moved ${dir < 0 ? 'left' : 'right'}`);
            },
          })),
          // --- Bookmarks ---
          ...(this.callbacks.onBookmarkProject ? [
            { separator: true as const },
            {
              // Outside any project the tab's folder is bookmarked instead.
              label: project ? 'Bookmark Project' : 'Bookmark Folder (not a project)',
              action: () => this.callbacks.onBookmarkProject?.(tab.id),
            },
          ] : []),
          // --- end bookmarks ---
          // Double-click renames a tab too, but the menu is the way in from the
          // keyboard, and Michael: "should be a rename option on tabs that arent
          // projects when right click". A project's tabs are named for the
          // project (the entry below), so they get no entry of their own.
          ...(!project ? [
            { separator: true as const },
            {
              label: 'Rename Tab…',
              action: () => {
                // The bar may have been rebuilt while the menu was open: look again.
                // Both the span and the title it prefills are read again: a rename
                // from another route, or a new title, may have landed since.
                const liveTitle = this.liveTitleSpan(tab.id);
                if (!liveTitle) return; // the tab closed meanwhile
                this.startTabRename(liveTitle, this.currentTabInfo(tab.id) ?? tab);
              },
            },
          ] : []),
          // Unlike double-click, this names every tab in the project, now and later;
          // on a tab in a linked worktree it names that worktree alone.
          ...(project ? [
            { separator: true as const },
            {
              label: 'Set Default Tab Name for Project…',
              action: () => {
                // The bar may have been rebuilt while the menu was open, so use
                // this tab's title as it is now, not the one captured above.
                const liveTitle = this.liveTitleSpan(tab.id);
                if (!liveTitle) return; // the tab closed meanwhile
                this.startRename(liveTitle, {
                  value: project.name,
                  placeholder: project.defaultName,
                  ariaLabel: 'Default tab name for this project',
                  maxLength: DEFAULTS.PROJECT_NAME_MAX_CHARS,
                  onCommit: (name) => this.callbacks.onRenameProject(tab.id, name),
                });
              },
            },
          ] : []),
        ], el, viaKeyboard);
      };
      this.tabMenuOpeners.set(el, showTabMenu);
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabMenu(e.clientX, e.clientY, false);
      });

      if (tabs.length > 1) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-bar-tab-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.setAttribute('aria-label', `Close ${tab.title}`);
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.callbacks.onClose(tab.id);
        });
        el.appendChild(closeBtn);
      }

      // --- Window drag / click-to-select ---
      // Left-click on tab body (not grip/close) drags the window if moved,
      // or selects the tab if released without moving.
      el.addEventListener('mousedown', (e) => {
        // Middle-click to close
        if (e.button === 1) {
          e.preventDefault();
          if (tabs.length > 1) {
            this.callbacks.onClose(tab.id);
          }
          return;
        }
        if (e.button !== 0) return;
        // Don't intercept grip, close button, or an open rename box — a click or
        // drag there is for the text; selecting the tab would rebuild the bar
        // and drop the box, and dragging would move the window.
        if ((e.target as HTMLElement).closest('.tab-bar-tab-grip, .tab-bar-tab-close, .tab-bar-tab-rename')) return;

        // Drags the window past a 5 px threshold, selects the tab if released without moving.
        this.startWindowDrag(e, { onClickWithoutDrag: () => this.callbacks.onSelect(tab.id) });
      });

      this.tabsContainer.appendChild(el);
    }

    this.tabsContainer.scrollLeft = savedScroll;
    const active = tabs.find((t) => t.active);
    if (active && (active.id !== this.lastActiveId || tabs.length !== this.lastTabCount)) {
      this.revealTab(active.id);
    }
    this.lastActiveId = active?.id ?? null;
    this.lastTabCount = tabs.length;
    if (focusedCloseTabId !== null) {
      // Back on that tab's close button; its tab element when it has none now
      // (the tab count fell to one), nothing when the tab itself is gone.
      const tabEl = this.tabsContainer.querySelector<HTMLElement>(`.tab-bar-tab[data-tab-id="${CSS.escape(focusedCloseTabId)}"]`);
      (tabEl?.querySelector<HTMLElement>('.tab-bar-tab-close') ?? tabEl)?.focus({ preventScroll: true });
    } else if (focusedTabId !== null) {
      this.tabsContainer
        .querySelector<HTMLElement>(`.tab-bar-tab[data-tab-id="${CSS.escape(focusedTabId)}"]`)
        ?.focus({ preventScroll: true });
    }
    this.hoverCard?.afterUpdate();
  }

  private revealTab(id: string): void {
    this.tabsContainer
      .querySelector<HTMLElement>(`.tab-bar-tab[data-tab-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  /** Scroll the active tab (as of the last update) into view. */
  private revealActive(): void {
    if (this.lastActiveId !== null) this.revealTab(this.lastActiveId);
  }

  /** A pane's state changed: re-read the open hover card, if any. */
  refreshHoverCard(): void {
    this.hoverCard?.refresh();
  }

  /** This tab's header info as of the latest update() (null once it closed). */
  private currentTabInfo(tabId: string): TabHeaderInfo | null {
    return this.latestTabs.find((t) => t.id === tabId) ?? null;
  }

  /** The title span of this tab as it is in the bar now (null once it closed). */
  private liveTitleSpan(tabId: string): HTMLElement | null {
    return this.tabsContainer.querySelector<HTMLElement>(
      `.tab-bar-tab[data-tab-id="${CSS.escape(tabId)}"] .tab-bar-tab-title`,
    );
  }

  /** Rename this one tab: the box starts at its full name, and an empty box
   *  goes back to the automatic one. Double-click and the menu both come here. */
  private startTabRename(titleSpan: HTMLElement, tab: TabHeaderInfo): void {
    this.startRename(titleSpan, {
      value: tab.title,
      placeholder: tab.autoTitle ?? '',
      ariaLabel: 'Rename tab',
      maxLength: 100,
      onCommit: (name) => this.callbacks.onRename(tab.id, name),
    });
  }

  /** Swap a tab's title for an inline text box. Enter or clicking away commits,
   *  Escape cancels. An empty box commits too: it means "back to the automatic
   *  name", which the placeholder shows. */
  private startRename(titleSpan: HTMLElement, opts: RenameOptions): void {
    const input = document.createElement('input');
    input.className = 'tab-bar-tab-rename';
    input.type = 'text';
    input.value = opts.value;
    input.placeholder = opts.placeholder;
    input.maxLength = opts.maxLength;
    input.setAttribute('aria-label', opts.ariaLabel);

    let committed = false;
    // The tab this box belongs to, to give it keyboard focus again when the box
    // closes with focus still inside it (Enter, Escape); a click elsewhere has
    // already moved focus on and keeps it there.
    const tabId = titleSpan.closest<HTMLElement>('.tab-bar-tab')?.dataset.tabId ?? null;
    const refocusTab = (hadFocus: boolean) => {
      if (!hadFocus || tabId === null) return;
      this.tabsContainer
        .querySelector<HTMLElement>(`.tab-bar-tab[data-tab-id="${CSS.escape(tabId)}"]`)
        ?.focus();
    };

    // Put the title back and let updates through again. The update held while
    // the box was open is applied after any rebuild the commit itself causes.
    const close = () => {
      input.replaceWith(titleSpan);
      this.renameOpen = false;
    };

    const commit = () => {
      if (committed) return;
      committed = true;
      const name = input.value.trim();
      const hadFocus = document.activeElement === input;
      close();
      if (name !== opts.value) {
        opts.onCommit(name);
      }
      this.applyHeldUpdate();
      refocusTab(hadFocus);
    };

    const cancel = () => {
      if (committed) return;
      committed = true;
      const hadFocus = document.activeElement === input;
      close();
      this.applyHeldUpdate();
      refocusTab(hadFocus);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      e.stopPropagation();
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());

    this.renameOpen = true;
    titleSpan.replaceWith(input);
    input.select();
    input.focus();
  }

  /** Apply the update held back while a rename box was open, if it is still
   *  pending (a commit that renamed something has usually rebuilt the bar already). */
  private applyHeldUpdate(): void {
    if (this.heldUpdate) this.update(this.heldUpdate);
  }

  /** Show the checkpoint clock for the focused pane, or hide it (null). */
  setCheckpoint(view: CheckpointView | null): void {
    const btn = this.checkpointBtn;
    this.checkpointView = view;
    btn.hidden = view === null;
    if (!view) {
      this.endCheckpointReason();
      return;
    }
    // A "why not" message holds the text until it ends; the rest updates.
    if (this.checkpointReasonTimer === null && btn.textContent !== view.text) btn.textContent = view.text;
    btn.classList.toggle('due', view.due);
    btn.classList.toggle('blocked', view.blocked);
    btn.setAttribute('aria-disabled', String(view.blocked));
    btn.setAttribute('aria-label', view.label);
    btn.title = view.label;
  }

  /** Why /checkpoint wasn't sent, in the clock's place for a few seconds
   *  (the caller announces it too). Nothing to show while the clock is hidden. */
  showCheckpointReason(text: string): void {
    const btn = this.checkpointBtn;
    if (btn.hidden) return;
    if (this.checkpointReasonTimer) clearTimeout(this.checkpointReasonTimer);
    btn.textContent = text;
    btn.classList.add('reason');
    this.checkpointReasonTimer = setTimeout(() => this.endCheckpointReason(), TabBar.CHECKPOINT_REASON_MS);
  }

  private endCheckpointReason(): void {
    if (this.checkpointReasonTimer === null) return;
    clearTimeout(this.checkpointReasonTimer);
    this.checkpointReasonTimer = null;
    this.checkpointBtn.classList.remove('reason');
    if (this.checkpointView) this.checkpointBtn.textContent = this.checkpointView.text;
  }

  dispose(): void {
    this.stopScaleWatch?.();
    this.stopScaleWatch = null;
    if (this.checkpointReasonTimer) clearTimeout(this.checkpointReasonTimer);
    if (this.pauseResultTimer) clearTimeout(this.pauseResultTimer);
    this.hoverCard?.dispose();
    this.contextMenu.dispose();
    this.container.innerHTML = '';
  }
}
