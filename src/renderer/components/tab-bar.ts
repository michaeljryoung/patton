import { ContextMenu } from './context-menu';
import { onUiTextScaleApplied } from '../services/ui-text-scale';
import { DEFAULTS } from '../../shared/constants';
import type { TabFlag } from '../../shared/types';
import type { HoverBlock } from '../services/tab-hover';
import { TabHoverCard } from './tab-hover-card';
import { rlog } from '../services/renderer-logger';
import { GROUP_NAME_MAX, stateOf, stepMove, strongestState, type StrongestState } from '../services/tab-groups';

export interface TabBarCallbacks {
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onReorder: (fromId: string, toId: string) => void;
  /** Tab menu → Move Left (-1) / Move Right (1): one step on the strip
   *  (services/tab-groups.ts stepMove), announced by the caller. */
  onMoveStep?: (id: string, dir: -1 | 1) => void;
  onSettings: () => void;
  onRename: (id: string, name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onSetFlag: (id: string, flag: TabFlag | null) => void;
  onBookmarkProject?: (id: string) => void; // bookmarks sidebar
  /** Pause all was clicked: pause every window's Claude panes that can take it. */
  onPauseAll?: () => void;
  /** What the tab hover card shows for a tab, one block per pane (focused
   *  first), or null if the tab is gone. Given = the card is on, and tabs
   *  carry no native `title` tooltip (it would cover the card). */
  describeTab?: (id: string) => HoverBlock[] | null;
  // --- Tab groups (services/tab-groups.ts; TabManager keeps the rules) ---
  /** Tab menu → Add Tab to New Group: returns the new group's id (null: none made). */
  onNewGroup?: (tabId: string) => string | null;
  /** Tab menu → Add to <group>, or a tab dropped on a group's chip. */
  onAddToGroup?: (tabId: string, groupId: string) => void;
  onRemoveFromGroup?: (tabId: string) => void;
  onRenameGroup?: (groupId: string, name: string) => void;
  /** Fold an open group, unfold a folded one. */
  onToggleGroup?: (groupId: string, reason: 'click' | 'menu') => void;
  onNewTabInGroup?: (groupId: string) => void;
  onUngroup?: (groupId: string) => void;
  onCloseGroup?: (groupId: string) => void;
}

/** A tab group as the strip draws it. */
export interface TabGroupHeader {
  id: string;
  /** '' = unnamed: the chip reads "N tabs". */
  name: string;
  folded: boolean;
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
  /** The project the menu acts on, if there is one: the one the tab is named
   *  after while Claude runs in it (`Tab.menuProject`), else the focused
   *  pane's. Its current and automatic names. */
  project?: { name: string; defaultName: string } | null;
  /** The name on the tab comes from its project (Claude runs in it, and no
   *  name was typed): such a tab is renamed through the project's default
   *  name, not "Rename Tab…". */
  namedForProject?: boolean;
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
  /** Claude is mid-turn in one of its panes (Tab.working): a still grey dot,
   *  only when no other mark is (W1, docs/tab-select.md). */
  working?: boolean;
  /** Why the tab needs you (Claude Code's own status report), plain text. */
  waitingText?: string | null;
  /** The tab group it is in, if any (a group's tabs are one unbroken run). */
  groupId?: string | null;
  /** Wake runs in it (a pane titled exactly WAKE, `isWakeTab`): drawn compact,
   *  its own content's width, neither sharing the strip nor squeezed (tabs.css
   *  `.wake-compact`). */
  wake?: boolean;
}

/** Task titles listed in the parked tooltip before "and N more". */
const PARKED_TITLES_SHOWN = 5;

/** How many group shades main.css defines (--group1-* to --group3-*); a fourth group repeats the first. */
const GROUP_SHADES = 3;

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
function tabLabel(tab: TabHeaderInfo, needsYou: boolean, shownFlag: TabFlag | null, ckpt: boolean, working: boolean): string {
  const states: string[] = [];
  if (ckpt) states.push('checkpoint finished');
  if (needsYou) states.push(tab.waitingText ? `waiting for you (${tab.waitingText})` : 'waiting for you');
  if (shownFlag) states.push(`flagged ${shownFlag}`);
  if (tab.parked && !needsYou && !shownFlag) states.push(parkedText(tab.parked).toLowerCase());
  if (working) states.push('Claude working');
  return states.length > 0 ? `${tab.title}, ${states.join(', ')}` : tab.title;
}

/** What a state means, in a screen reader's label (plural forms for counts). */
function stateNote(s: StrongestState, count = 1): string {
  if (s.kind === 'checkpoint') return `${count} checkpoint${count === 1 ? '' : 's'} finished`;
  if (s.kind === 'needs-you') return `${count} waiting for you`;
  if (s.kind === 'flag') return `${count} flagged ${s.flag}`;
  return `${count} waiting on background work`;
}

/** Whether the pointer is over this element (false where :hover isn't known). */
function hovered(el: Element): boolean {
  try {
    return el.matches(':hover');
  } catch {
    return false;
  }
}

/** One indicator for a state: the same element and classes a tab's dot uses. */
function indicatorFor(s: StrongestState): HTMLElement {
  const dot = document.createElement('span');
  dot.setAttribute('role', 'img');
  if (s.kind === 'checkpoint') {
    dot.className = 'tab-bar-tab-indicator checkpoint-done';
    dot.setAttribute('aria-label', 'Checkpoint finished');
  } else if (s.kind === 'needs-you') {
    dot.className = 'tab-bar-tab-indicator';
    dot.setAttribute('aria-label', 'Awaiting input');
  } else if (s.kind === 'flag') {
    dot.className = `tab-bar-tab-indicator flag-${s.flag}`;
    dot.setAttribute('aria-label', `Flagged ${s.flag}`);
  } else {
    dot.className = 'tab-bar-tab-indicator parked';
    dot.setAttribute('aria-label', 'Waiting on its own background work');
  }
  return dot;
}

/** "Games group, 3 tabs, folded, 1 checkpoint finished, 1 waiting for you". */
function chipLabel(group: TabGroupHeader, members: TabHeaderInfo[]): string {
  const parts = [`${group.name || 'Unnamed'} group`, `${members.length} ${members.length === 1 ? 'tab' : 'tabs'}`, group.folded ? 'folded' : 'open'];
  if (group.folded) {
    // Each tab counted once, by its own strongest state, in the chip's rank order.
    const order: string[] = [];
    const counts = new Map<string, { s: StrongestState; n: number }>();
    for (const tab of members) {
      const s = stateOf(tab);
      if (!s) continue;
      const key = s.kind === 'flag' ? `flag-${s.flag}` : s.kind;
      const entry = counts.get(key);
      if (entry) entry.n++;
      else { counts.set(key, { s, n: 1 }); order.push(key); }
    }
    const rank = (k: string) => (k === 'checkpoint' ? 0 : k === 'needs-you' ? 1 : k.startsWith('flag-') ? 2 : 3);
    order.sort((a, b) => rank(a) - rank(b));
    for (const key of order) {
      const { s, n } = counts.get(key)!;
      parts.push(stateNote(s, n));
    }
  }
  return parts.join(', ');
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
  /** The groups as last handed to update() (held ones included). */
  private latestGroups: TabGroupHeader[] = [];
  private heldGroups: TabGroupHeader[] | null = null;
  /** Opens each chip's context menu (mouse and keyboard). */
  private chipMenuOpeners = new WeakMap<HTMLElement, (x: number, y: number, viaKeyboard: boolean) => void>();
  /** The list under a folded chip (hover or keyboard focus), and which group it lists. */
  private groupListEl: HTMLDivElement | null = null;
  private groupListFor: string | null = null;
  private groupListTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly GROUP_LIST_HIDE_MS = 150;
  /** The strip's last press was a key, not the pointer. A chip focused that
   *  way is focus-visible and shows its list; one focused by a click (or given
   *  focus back after the rebuild that click's fold caused) does not, so the
   *  list closes once the pointer leaves. */
  private keyboardModality = false;
  /** Tabs drawn compact on the last rebuild (wake runs in them), so the log
   *  line comes once when a tab turns compact or back, not on every redraw. */
  private compactIds = new Set<string>();

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
    // A group's chip is in the same arrow-key run (focus moves to it, but it is
    // never selected); Enter or Space on it folds or unfolds the group.
    this.tabsContainer.addEventListener('keydown', () => { this.keyboardModality = true; }, true);
    this.tabsContainer.addEventListener('mousedown', () => { this.keyboardModality = false; }, true);
    this.tabsContainer.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      const isChip = target.classList.contains('tab-bar-group-chip');
      if (!target.classList.contains('tab-bar-tab') && !isChip) return;
      const tabEls = Array.from(this.tabsContainer.querySelectorAll<HTMLElement>('.tab-bar-tab, .tab-bar-group-chip'));
      if (tabEls.length === 0) return;
      const currentIdx = tabEls.indexOf(target);
      if (currentIdx === -1) return;
      // Menu key / Shift+F10: the context menu is the only keyboard route to
      // Move Left / Move Right, flags and bookmarking.
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const rect = target.getBoundingClientRect();
        (isChip ? this.chipMenuOpeners : this.tabMenuOpeners).get(target)?.(rect.left + 12, rect.bottom, true);
        return;
      }
      if (isChip && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        const groupId = target.dataset.groupId;
        if (groupId) this.callbacks.onToggleGroup?.(groupId, 'click');
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
      if (nextEl.classList.contains('tab-bar-group-chip')) {
        nextEl.focus();
        return;
      }
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
    // by -webkit-app-region, so the mouse events still reach us. Since tabs grow
    // to share the strip (14 Nov) there is normally none left; the blank space
    // beside + and the strip's left padding are the places that are always there.
    this.tabsContainer.addEventListener('mousedown', (e) => {
      // Only handle clicks on the container itself, not on child tabs
      // (a chip runs its own drag: two would move the window twice as far)
      if ((e.target as HTMLElement).closest('.tab-bar-tab, .tab-bar-group-chip')) return;
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

    // Pause all, at the strip's far right (the checkpoint clock moved to the
    // session bar, docs/session-bar.md D7): types `pause` into every window's Claude panes. Idle it is
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
    const label = 'Pause all: type pause into every Claude session with something running, in every window, skipping any waiting on you';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  /** Whether Move Left (-1) / Move Right (1) would change anything for this
   *  tab, by the same rule TabManager applies (stepMove), on the latest tabs. */
  private canMoveStep(tabId: string, dir: -1 | 1): boolean {
    const tabs = this.latestTabs;
    const item = tabs.find((t) => t.id === tabId);
    if (!item) return false;
    const folded = new Set(this.latestGroups.filter((g) => g.folded).map((g) => g.id));
    return stepMove(tabs, item, dir, (t) => t.groupId ?? null, (g) => folded.has(g)) !== null;
  }

  /** Log each tab that turned compact (wake started in it) or back since the
   *  last rebuild. A tab that closed while compact just leaves the set. */
  private logCompactChanges(tabs: TabHeaderInfo[]): void {
    const now = new Set(tabs.filter((t) => t.wake).map((t) => t.id));
    const open = new Set(tabs.map((t) => t.id));
    for (const id of now) {
      if (!this.compactIds.has(id)) rlog('info', '[TAB] wake compact', { tabId: id, on: true });
    }
    for (const id of this.compactIds) {
      if (!now.has(id) && open.has(id)) rlog('info', '[TAB] wake compact', { tabId: id, on: false });
    }
    this.compactIds = now;
  }

  update(tabs: TabHeaderInfo[], groups: TabGroupHeader[] = []): void {
    this.latestTabs = tabs;
    this.latestGroups = groups;
    if (this.renameOpen) {
      this.heldUpdate = tabs;
      this.heldGroups = groups;
      return;
    }
    this.heldUpdate = null;
    this.heldGroups = null;
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const membersOf = (groupId: string) => tabs.filter((t) => t.groupId === groupId);
    // A group's shade (1-3, cycling) is its place among the groups on the strip.
    const shadeOf = new Map<string, number>();
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
    // The same for a group's chip.
    const focusedGroupId = focused instanceof HTMLElement && focused.classList.contains('tab-bar-group-chip')
      && this.tabsContainer.contains(focused) ? focused.dataset.groupId ?? null : null;
    this.tabsContainer.innerHTML = '';
    this.logCompactChanges(tabs);
    for (const tab of tabs) {
      // A chip sits immediately left of its group's tabs; a folded group's tabs
      // stay off the strip.
      const group = tab.groupId ? groupById.get(tab.groupId) : undefined;
      if (group && !shadeOf.has(group.id)) {
        shadeOf.set(group.id, (shadeOf.size % GROUP_SHADES) + 1);
        this.tabsContainer.appendChild(this.buildChip(group, membersOf(group.id), shadeOf.get(group.id)!));
      }
      if (group?.folded) continue;
      const el = document.createElement('div');
      el.className = `tab-bar-tab${tab.active ? ' active' : ''}${group ? ` in-group group-shade-${shadeOf.get(group.id)}` : ''}`;
      // Michael, 24 Nov: wake's tab "always just this size even if other tabs
      // open": as wide as its own label and dot, grouped or not (tabs.css).
      if (tab.wake) el.classList.add('wake-compact');
      el.dataset.tabId = tab.id;
      if (group) el.dataset.groupId = group.id;

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
        // Only a drag that began on this strip's grip counts: tab ids repeat
        // across windows, so foreign text must not move this window's tab.
        const fromId = e.dataTransfer!.getData('text/plain');
        if (fromId && fromId === this.draggedId && fromId !== tab.id) {
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
      // W1, his pick on the S63 try-out page: Claude is mid-turn and nothing
      // above applies, so a small still grey dot (tabs.css `.working`), on the
      // active tab too. Lowest of all: never hides a mark that asks for you.
      const showWorking = !shownFlag && !ckpt && !needsYou && !tab.parked && !!tab.working;
      if (showWorking) {
        const dot = document.createElement('span');
        dot.className = 'tab-bar-tab-indicator working';
        dot.setAttribute('aria-label', 'Claude working');
        dot.setAttribute('role', 'img');
        el.appendChild(dot);
      }

      // One label for screen readers and the hover tooltip: a tab's children
      // are presentational in ARIA, so the dots' own labels never reach the
      // tab's accessible name, and the dots themselves have no tooltip. With
      // the hover card on, the card is the tooltip and the tab has no title.
      const label = tabLabel(tab, needsYou, shownFlag, ckpt, showWorking)
        + (group ? `, in ${group.name ? `${group.name} group` : 'unnamed group'}` : '');
      el.setAttribute('aria-label', label);
      if (!this.hoverCard) el.title = label;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'tab-bar-tab-title';
      const shown = tab.displayTitle ?? tab.title;
      titleSpan.textContent = shown;
      // Reserves the bold (active) width in CSS so switching tabs doesn't shift the rest.
      titleSpan.dataset.title = shown;
      el.appendChild(titleSpan);

      // Double-click anywhere on the tab renames this one tab. Tabs grow to share
      // the strip and centre their label (tabs.css), so the title span no longer
      // reaches the tab's ends: listening on the tab keeps the whole width live.
      // Not the grip or the close button (their own controls), nor an open
      // rename box (a double-click there selects a word).
      el.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).closest('.tab-bar-tab-grip, .tab-bar-tab-close, .tab-bar-tab-rename')) return;
        if (this.dragMoved) return; // the end of a window drag, not a double-click
        e.stopPropagation();
        if (!titleSpan.isConnected) return; // a rename box already holds its place
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
            disabled: !this.canMoveStep(tab.id, dir),
            // One step on the strip (into, out of or past a group, else a
            // swap); TabManager looks again, as the bar may have been rebuilt
            // while the menu was open, and announces what happened.
            action: () => this.callbacks.onMoveStep?.(tab.id, dir),
          })),
          // --- Tab groups ---
          ...this.groupMenuItems(tab.id),
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
          // projects when right click". A tab named for its project (Claude
          // runs in it; the entry below renames that) gets no entry of its
          // own; a plain shell in a project folder does, as its name is
          // "Terminal" or its program's title.
          ...(!tab.namedForProject ? [
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
    // A focused tab now inside a folded group is off the strip: its chip
    // takes the focus rather than the page's body.
    const chipOfHidden = (tabId: string): HTMLElement | null => {
      const groupId = tabs.find((t) => t.id === tabId)?.groupId;
      return groupId && groupById.get(groupId)?.folded ? this.chipEl(groupId) : null;
    };
    if (focusedCloseTabId !== null) {
      // Back on that tab's close button; its tab element when it has none now
      // (the tab count fell to one), nothing when the tab itself is gone.
      const tabEl = this.tabsContainer.querySelector<HTMLElement>(`.tab-bar-tab[data-tab-id="${CSS.escape(focusedCloseTabId)}"]`);
      (tabEl?.querySelector<HTMLElement>('.tab-bar-tab-close') ?? tabEl ?? chipOfHidden(focusedCloseTabId))?.focus({ preventScroll: true });
    } else if (focusedTabId !== null) {
      (this.tabsContainer.querySelector<HTMLElement>(`.tab-bar-tab[data-tab-id="${CSS.escape(focusedTabId)}"]`)
        ?? chipOfHidden(focusedTabId))?.focus({ preventScroll: true });
    } else if (focusedGroupId !== null) {
      this.chipEl(focusedGroupId)?.focus({ preventScroll: true });
    }
    this.hoverCard?.afterUpdate();
    this.refreshGroupList();
  }

  // --- Tab groups ---

  /** The chip element of a group as the strip is now (null if not drawn). */
  private chipEl(groupId: string): HTMLElement | null {
    return this.tabsContainer.querySelector<HTMLElement>(`.tab-bar-group-chip[data-group-id="${CSS.escape(groupId)}"]`);
  }

  private currentGroup(groupId: string): TabGroupHeader | null {
    return this.latestGroups.find((g) => g.id === groupId) ?? null;
  }

  /** A group's chip: in its group's shade, its name in ink (or "N tabs" when unnamed), a
   *  chevron, and when folded the tab count and the strongest indicator of its
   *  tabs. A click that doesn't drag folds or unfolds it; a drag moves the
   *  window, as a tab's body does. */
  private buildChip(group: TabGroupHeader, members: TabHeaderInfo[], shade: number): HTMLElement {
    const chip = document.createElement('div');
    chip.className = `tab-bar-group-chip group-shade-${shade}${group.folded ? ' folded' : ''}`;
    chip.dataset.groupId = group.id;
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '-1');
    chip.setAttribute('aria-expanded', String(!group.folded));
    chip.setAttribute('aria-label', chipLabel(group, members));
    // An open chip may have its name cut short: the tooltip has it whole. A
    // folded chip has its list instead (a tooltip would cover it).
    if (!group.folded && group.name) chip.title = group.name;

    const chevron = document.createElement('span');
    chevron.className = 'tab-bar-group-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = group.folded ? '▸' : '▾';
    chip.appendChild(chevron);

    const name = document.createElement('span');
    name.className = `tab-bar-group-name${group.name ? '' : ' unnamed'}`;
    name.textContent = group.name || `${members.length} ${members.length === 1 ? 'tab' : 'tabs'}`;
    chip.appendChild(name);

    if (group.folded) {
      if (group.name) {
        const count = document.createElement('span');
        count.className = 'tab-bar-group-count';
        count.setAttribute('aria-hidden', 'true');
        count.textContent = String(members.length);
        chip.appendChild(count);
      }
      const strongest = strongestState(members);
      if (strongest) chip.appendChild(indicatorFor(strongest));
    }

    chip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.tab-bar-tab-rename')) return;
      // A press beside an open name box only leaves the box (its blur commits
      // the name): it doesn't fold the group as well.
      if (this.renameOpen) return;
      // keepFocus: the press doesn't take focus from the terminal, as the
      // strip's blank space doesn't (a fold that moves no selection never
      // refocuses the terminal).
      this.startWindowDrag(e, { keepFocus: true, onClickWithoutDrag: () => this.callbacks.onToggleGroup?.(group.id, 'click') });
    });
    // Two clicks fold and unfold; never the window's title-bar zoom.
    chip.addEventListener('dblclick', (e) => e.stopPropagation());

    const showMenu = (x: number, y: number, viaKeyboard: boolean): void => {
      this.hideGroupList();
      const now = this.currentGroup(group.id);
      if (!now) return;
      this.contextMenu.show(x, y, [
        { label: 'Rename Group…', action: () => this.startGroupRename(group.id) },
        { label: now.folded ? 'Unfold Group' : 'Fold Group', action: () => this.callbacks.onToggleGroup?.(group.id, 'menu') },
        { label: 'New Tab in Group', action: () => this.callbacks.onNewTabInGroup?.(group.id) },
        { separator: true as const },
        { label: 'Ungroup', action: () => this.callbacks.onUngroup?.(group.id) },
        { label: 'Close Group…', action: () => this.callbacks.onCloseGroup?.(group.id) },
      ], chip, viaKeyboard);
    };
    this.chipMenuOpeners.set(chip, showMenu);
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(e.clientX, e.clientY, false);
    });

    // A tab dropped on the chip joins the group (as "Add to").
    chip.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.tabsContainer.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
      if (this.draggedId) chip.classList.add('drag-over');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('drag-over'));
    chip.addEventListener('drop', (e) => {
      e.preventDefault();
      chip.classList.remove('drag-over');
      const fromId = e.dataTransfer?.getData('text/plain');
      if (!fromId || fromId !== this.draggedId) return; // a drag from another window or plain text
      const tab = this.currentTabInfo(fromId);
      if (tab && tab.groupId !== group.id) this.callbacks.onAddToGroup?.(fromId, group.id);
    });

    // The list of a folded group's tabs: on hover, and on keyboard focus (focus-visible: a click's focus doesn't count).
    chip.addEventListener('mouseenter', () => this.showGroupList(group.id));
    chip.addEventListener('mouseleave', () => this.scheduleHideGroupList());
    chip.addEventListener('focus', () => { if (this.keyboardModality) this.showGroupList(group.id); });
    chip.addEventListener('blur', () => this.scheduleHideGroupList());
    return chip;
  }

  /** The tab menu's group section: Add Tab to New Group, Add to <each other
   *  group>, and Remove from Group when the tab is in one. */
  private groupMenuItems(tabId: string): ({ label: string; action: () => void } | { separator: true })[] {
    if (!this.callbacks.onNewGroup) return [];
    const tab = this.currentTabInfo(tabId);
    const own = tab?.groupId ?? null;
    const items: ({ label: string; action: () => void } | { separator: true })[] = [{ separator: true }];
    items.push({
      label: 'Add Tab to New Group',
      action: () => {
        const groupId = this.callbacks.onNewGroup?.(tabId) ?? null;
        if (groupId !== null) this.startGroupRename(groupId, true);
      },
    });
    for (const group of this.latestGroups) {
      if (group.id === own) continue;
      items.push({
        label: `Add to ${group.name || 'Unnamed Group'}`,
        action: () => this.callbacks.onAddToGroup?.(tabId, group.id),
      });
    }
    if (own !== null) {
      items.push({ label: 'Remove from Group', action: () => this.callbacks.onRemoveFromGroup?.(tabId) });
    }
    return items;
  }

  /** The name box on a group's chip: Enter or a click away commits, Escape
   *  cancels (a new group stays unnamed), an empty box means unnamed. */
  startGroupRename(groupId: string, isNew = false): void {
    const chip = this.chipEl(groupId);
    const nameSpan = chip?.querySelector<HTMLElement>('.tab-bar-group-name');
    const group = this.currentGroup(groupId);
    if (!chip || !nameSpan || !group || this.renameOpen) return;
    this.startRename(nameSpan, {
      value: group.name,
      placeholder: isNew ? 'Name this group' : 'Unnamed',
      ariaLabel: 'Group name',
      maxLength: GROUP_NAME_MAX,
      onCommit: (name) => this.callbacks.onRenameGroup?.(groupId, name),
    });
  }

  /** Show the list under a folded group's chip (nothing for an open group). */
  private showGroupList(groupId: string): void {
    if (this.groupListTimer) { clearTimeout(this.groupListTimer); this.groupListTimer = null; }
    const group = this.currentGroup(groupId);
    const chip = this.chipEl(groupId);
    if (!group || !group.folded || !chip || this.renameOpen) { this.hideGroupList(); return; }
    if (this.groupListFor === groupId && this.groupListEl) return;
    this.hideGroupList();
    const list = document.createElement('div');
    list.className = 'tab-bar-group-list';
    // The chip's label already says what is inside; this list is for the pointer.
    list.setAttribute('aria-hidden', 'true');
    for (const tab of this.latestTabs.filter((t) => t.groupId === groupId)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tab-bar-group-list-row';
      row.tabIndex = -1;
      row.dataset.tabId = tab.id;
      const s = stateOf(tab);
      if (s) row.appendChild(indicatorFor(s));
      else {
        const gap = document.createElement('span');
        gap.className = 'tab-bar-group-list-nodot';
        row.appendChild(gap);
      }
      const title = document.createElement('span');
      title.className = 'tab-bar-group-list-title';
      title.textContent = tab.title;
      row.appendChild(title);
      // Opening a tab inside unfolds its group (TabManager.switchToId).
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        this.hideGroupList();
        this.callbacks.onSelect(tab.id);
      });
      list.appendChild(row);
    }
    const rect = chip.getBoundingClientRect();
    // Measured at the window's left edge, where it has all the room it wants:
    // placed at the chip first, a browser squeezes it to the space right of the
    // chip and the clamp below would see a narrow list and leave it there.
    list.style.left = '0px';
    list.style.top = `${rect.bottom}px`;
    list.addEventListener('mouseenter', () => {
      if (this.groupListTimer) { clearTimeout(this.groupListTimer); this.groupListTimer = null; }
    });
    list.addEventListener('mouseleave', () => this.scheduleHideGroupList());
    this.container.appendChild(list);
    // Under its chip, but inside the window: a chip near the right end would
    // otherwise draw a list that runs off it (measured once it is in the page).
    const maxLeft = window.innerWidth - list.getBoundingClientRect().width - 4;
    list.style.left = `${Math.max(4, Math.min(rect.left, maxLeft))}px`;
    this.groupListEl = list;
    this.groupListFor = groupId;
  }

  private scheduleHideGroupList(): void {
    if (this.groupListTimer) clearTimeout(this.groupListTimer);
    this.groupListTimer = setTimeout(() => {
      this.groupListTimer = null;
      // Still over the chip or the list, or the chip has keyboard focus: keep it.
      const chip = this.groupListFor ? this.chipEl(this.groupListFor) : null;
      if (chip && (hovered(chip) || (document.activeElement === chip && this.keyboardModality))) return;
      if (this.groupListEl && hovered(this.groupListEl)) return;
      this.hideGroupList();
    }, TabBar.GROUP_LIST_HIDE_MS);
  }

  private hideGroupList(): void {
    if (this.groupListTimer) { clearTimeout(this.groupListTimer); this.groupListTimer = null; }
    this.groupListEl?.remove();
    this.groupListEl = null;
    this.groupListFor = null;
  }

  /** After a rebuild: the list goes if its group unfolded or went, and is
   *  drawn again (rows and place) if it is still folded. */
  private refreshGroupList(): void {
    const groupId = this.groupListFor;
    if (groupId === null) return;
    const group = this.currentGroup(groupId);
    const hidePending = this.groupListTimer !== null;
    this.hideGroupList();
    if (!group?.folded) return;
    this.showGroupList(groupId);
    // The pointer was already on its way out: keep that going.
    if (hidePending) this.scheduleHideGroupList();
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
    // A group's chip takes a name box the same way (its name span).
    const chipGroupId = titleSpan.closest<HTMLElement>('.tab-bar-group-chip')?.dataset.groupId ?? null;
    const tabId = chipGroupId === null ? titleSpan.closest<HTMLElement>('.tab-bar-tab')?.dataset.tabId ?? null : null;
    const refocusTab = (hadFocus: boolean) => {
      if (!hadFocus) return;
      if (chipGroupId !== null) { this.chipEl(chipGroupId)?.focus(); return; }
      if (tabId === null) return;
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
    this.hideGroupList();
    titleSpan.replaceWith(input);
    input.select();
    input.focus();
  }

  /** Apply the update held back while a rename box was open, if it is still
   *  pending (a commit that renamed something has usually rebuilt the bar already). */
  private applyHeldUpdate(): void {
    if (this.heldUpdate) this.update(this.heldUpdate, this.heldGroups ?? this.latestGroups);
  }

  dispose(): void {
    this.stopScaleWatch?.();
    this.stopScaleWatch = null;
    if (this.pauseResultTimer) clearTimeout(this.pauseResultTimer);
    this.hoverCard?.dispose();
    this.hideGroupList();
    this.contextMenu.dispose();
    this.container.innerHTML = '';
  }
}
