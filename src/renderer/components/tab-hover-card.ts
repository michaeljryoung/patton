import { rlog } from '../services/renderer-logger';
import type { HoverBlock } from '../services/tab-hover';

/**
 * The tab hover card: what each pane of a tab is doing, shown just under the
 * tab after the pointer (or keyboard focus) rests on it. It replaces the
 * tab's native `title` tooltip, which would otherwise sit on top of it.
 *
 * Shows after SHOW_DELAY_MS; moving to another tab while it is up switches at
 * once. The card takes no pointer events (`pointer-events: none`), so it never
 * covers the terminal for the mouse. Hides on leaving the tab (after
 * HIDE_GRACE_MS, so moving between tabs doesn't flicker), a click or drag on
 * the strip, the strip scrolling, the window resizing or losing focus, and
 * Esc. Esc is consumed only when keyboard focus on a tab brought the card up;
 * under a mouse hover it passes on (it interrupts Claude). At most MAX_BLOCKS
 * panes are listed, then "+N more panes". Durations refresh once a minute
 * while it is open, and any pane's status change refreshes it. Every string
 * is set with `textContent`; the blocks arrive already cleaned and capped
 * (services/tab-hover.ts). With focus on a tab, `aria-describedby` points at
 * the card at once (its text filled while it is still hidden), so a screen
 * reader hears it without the delay.
 *
 * The strip is rebuilt on every TabBar.update(), so events are delegated to
 * the strip and the anchor is looked up by tab id (`afterUpdate`).
 */
export class TabHoverCard {
  static readonly SHOW_DELAY_MS = 400;
  static readonly HIDE_GRACE_MS = 150;
  static readonly REFRESH_MS = 60_000;
  static readonly MAX_BLOCKS = 4;
  private static readonly GAP_PX = 4;
  private static readonly MARGIN_PX = 8;
  static readonly ELEMENT_ID = 'tab-hover-card';

  readonly element: HTMLElement;
  private shownId: string | null = null;
  private anchor: HTMLElement | null = null;
  // What brought the card up: a pointer hover, or keyboard focus on a tab.
  private trigger: 'pointer' | 'focus' = 'pointer';
  private pendingId: string | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private renderedKey = '';
  // After a click on a tab, its card stays down until the pointer leaves it.
  private suppressedId: string | null = null;
  // The last input was the pointer: a focus that follows a click is not a
  // keyboard user resting on a tab.
  private pointerInput = false;
  // The strip's scrollLeft as update() left it: a scroll event that only
  // restores it is the rebuild, not the user scrolling.
  private expectedScroll = 0;
  private disposers: (() => void)[] = [];

  constructor(
    private strip: HTMLElement,
    private describe: (tabId: string) => HoverBlock[] | null,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'tab-hover-card';
    this.element.id = TabHoverCard.ELEMENT_ID;
    this.element.setAttribute('role', 'tooltip');
    this.element.hidden = true;
    document.body.appendChild(this.element);

    this.listen(strip, 'mouseover', (e) => this.onPointerOver(e as MouseEvent));
    this.listen(strip, 'mouseout', (e) => this.onPointerOut(e as MouseEvent));
    this.listen(strip, 'mousedown', (e) => this.onPointerDown(e as MouseEvent), true);
    this.listen(strip, 'dragstart', () => this.hide('drag'), true);
    this.listen(strip, 'scroll', () => {
      if (Math.abs(this.strip.scrollLeft - this.expectedScroll) >= 1) this.hide('scroll');
    });
    this.listen(strip, 'wheel', () => this.hide('scroll'), { passive: true });
    this.listen(strip, 'focusin', (e) => this.onFocusIn(e as FocusEvent));
    this.listen(strip, 'focusout', (e) => this.onFocusOut(e as FocusEvent));
    this.listen(window, 'blur', () => this.hide('blur'));
    this.listen(window, 'resize', () => this.hide('resize'));
    this.listen(document, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent), true);
    this.listen(document, 'mousedown', () => { this.pointerInput = true; }, true);
    // A rebuild removes the hovered tab's node, and Chromium sends no mouseout
    // for a removed node: a pointer that left within a frame of a rebuild
    // would leave the card up. Any pointer move over something that isn't a
    // tab ends a pointer-raised card (or its pending show) instead.
    this.listen(document, 'mouseover', (e) => this.onDocumentPointerOver(e as MouseEvent), true);
  }

  get visibleTabId(): string | null {
    return this.shownId;
  }

  /** The strip was rebuilt: re-anchor to the tab's new element (or hide if
   *  it closed) and refresh the text if what it says changed. */
  afterUpdate(): void {
    this.expectedScroll = this.strip.scrollLeft;
    if (this.shownId === null) return;
    const el = this.tabElement(this.shownId);
    if (!el) {
      this.hide('closed');
      return;
    }
    this.setAnchor(el);
    this.refresh();
  }

  /** Re-read the shown tab (a state change, or the minute tick). Renders only
   *  when the text changed. */
  refresh(): void {
    if (this.shownId === null || !this.anchor) return;
    const blocks = this.describe(this.shownId);
    if (!blocks) {
      this.hide('closed');
      return;
    }
    this.render(blocks);
    this.place();
  }

  /** Why the card last went down (for checks and debugging; not logged). */
  lastHideReason = '';

  hide(reason: string): void {
    this.cancelShow();
    this.cancelHide();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.shownId === null) {
      // A focus-described tab whose card never showed.
      this.setAnchor(null);
      return;
    }
    this.lastHideReason = reason;
    this.shownId = null;
    this.setAnchor(null);
    this.element.hidden = true;
    this.renderedKey = '';
  }

  dispose(): void {
    this.hide('dispose');
    for (const d of this.disposers) d();
    this.element.remove();
  }

  // --- Triggers ---

  private onKeyDown(e: KeyboardEvent): void {
    this.pointerInput = false;
    if (e.key !== 'Escape') return;
    if (this.shownId !== null && this.trigger === 'focus') {
      // The keyboard user dismisses the card they are reading; the tab keeps focus.
      e.preventDefault();
      e.stopPropagation();
      this.hide('esc');
      return;
    }
    // A mouse hover's card: hidden, and Esc goes on to the terminal (it
    // interrupts Claude).
    this.hide('esc');
  }

  private onPointerOver(e: MouseEvent): void {
    const tab = this.tabFrom(e.target);
    if (!tab) return;
    const id = tab.dataset.tabId!;
    if (id === this.suppressedId) return;
    this.suppressedId = null;
    this.trigger = 'pointer';
    this.request(id);
  }

  private onPointerOut(e: MouseEvent): void {
    const from = this.tabFrom(e.target);
    const to = e.relatedTarget as Node | null;
    if (from && to && from.contains(to)) return; // moving within the tab
    if (!this.tabFrom(to)) this.suppressedId = null; // left the tabs altogether
    if (this.pendingId !== null && this.trigger === 'pointer') this.cancelShow();
    if (this.shownId !== null && this.trigger === 'pointer') this.scheduleHide();
  }

  private onDocumentPointerOver(e: MouseEvent): void {
    if (this.trigger !== 'pointer' || this.tabFrom(e.target)) return;
    if (this.pendingId !== null) this.cancelShow();
    if (this.shownId !== null) this.scheduleHide();
  }

  private onPointerDown(e: MouseEvent): void {
    this.pointerInput = true;
    const tab = this.tabFrom(e.target);
    this.suppressedId = tab?.dataset.tabId ?? null;
    this.hide('click');
  }

  private onFocusIn(e: FocusEvent): void {
    const tab = this.tabFrom(e.target);
    if (!tab || this.pointerInput) return;
    // Only the tab itself: a rename box inside it is for typing.
    if (e.target !== tab) return;
    this.trigger = 'focus';
    const id = tab.dataset.tabId!;
    // Described at once for a screen reader; shown after the delay.
    if (this.shownId === null) {
      const blocks = this.describe(id);
      if (blocks && blocks.length > 0) {
        this.renderedKey = '';
        this.render(blocks);
        this.setAnchor(tab);
      }
    }
    this.request(id);
  }

  private onFocusOut(e: FocusEvent): void {
    if (this.trigger !== 'focus') return;
    if (this.tabFrom(e.relatedTarget)) return; // focusin on the next tab handles it
    // A rebuild removes the focused tab; TabBar.update() refocuses the same
    // tab's new element at once (and arrow keys a frame later), inside the grace.
    if (this.pendingId !== null) this.cancelShow();
    if (this.shownId !== null) this.scheduleHide();
    else this.setAnchor(null); // described but never shown
  }

  /** Show `id`'s card: at once if a card is already up, else after the delay. */
  private request(id: string): void {
    this.cancelHide();
    if (this.shownId !== null) {
      this.cancelShow();
      if (id !== this.shownId) this.show(id);
      return;
    }
    if (this.pendingId === id && this.showTimer) return;
    this.cancelShow();
    this.pendingId = id;
    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      const pending = this.pendingId;
      this.pendingId = null;
      if (pending !== null) this.show(pending);
    }, TabHoverCard.SHOW_DELAY_MS);
  }

  private show(id: string): void {
    const el = this.tabElement(id);
    const blocks = el ? this.describe(id) : null;
    if (!el || !blocks || blocks.length === 0) {
      this.hide('nothing');
      return;
    }
    this.shownId = id;
    this.setAnchor(el);
    this.renderedKey = '';
    this.render(blocks);
    this.element.hidden = false;
    this.place();
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.refresh(), TabHoverCard.REFRESH_MS);
    }
    rlog('info', '[HOVER] card shown', { tab: id, panes: blocks.length, via: this.trigger });
  }

  // --- Helpers ---

  private listen(
    target: EventTarget,
    type: string,
    fn: (e: Event) => void,
    opts?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn, opts);
    this.disposers.push(() => target.removeEventListener(type, fn, opts));
  }

  private tabFrom(target: EventTarget | null): HTMLElement | null {
    if (!target || !(target instanceof Element)) return null;
    const tab = target.closest<HTMLElement>('.tab-bar-tab');
    return tab && this.strip.contains(tab) && tab.dataset.tabId ? tab : null;
  }

  private tabElement(id: string): HTMLElement | null {
    return this.strip.querySelector<HTMLElement>(`.tab-bar-tab[data-tab-id="${CSS.escape(id)}"]`);
  }

  private setAnchor(el: HTMLElement | null): void {
    if (this.anchor && this.anchor !== el && this.anchor.getAttribute('aria-describedby') === TabHoverCard.ELEMENT_ID) {
      this.anchor.removeAttribute('aria-describedby');
    }
    this.anchor = el;
    el?.setAttribute('aria-describedby', TabHoverCard.ELEMENT_ID);
  }

  private cancelShow(): void {
    if (this.showTimer) clearTimeout(this.showTimer);
    this.showTimer = null;
    this.pendingId = null;
  }

  private scheduleHide(): void {
    if (this.hideTimer) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hide('leave');
    }, TabHoverCard.HIDE_GRACE_MS);
  }

  private cancelHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private render(blocks: HoverBlock[]): void {
    const key = JSON.stringify(blocks);
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    this.element.replaceChildren();
    const shown = blocks.slice(0, TabHoverCard.MAX_BLOCKS);
    shown.forEach((block) => {
      const section = document.createElement('section');
      section.className = 'tab-hover-block';
      if (block.label) section.appendChild(this.line('tab-hover-head', block.label));
      section.appendChild(this.line('tab-hover-title', block.title));
      if (block.place) section.appendChild(this.line('tab-hover-place', block.place));
      const state = this.line('tab-hover-state', block.state);
      state.dataset.activity = block.activity;
      section.appendChild(state);
      if (block.detail) section.appendChild(this.line('tab-hover-detail', block.detail));
      if (block.tasks.length > 0) {
        const list = document.createElement('ul');
        list.className = 'tab-hover-tasks';
        for (const task of block.tasks) {
          const item = document.createElement('li');
          item.textContent = task;
          list.appendChild(item);
        }
        section.appendChild(list);
      }
      if (block.checkpoint) section.appendChild(this.line('tab-hover-checkpoint', block.checkpoint));
      this.element.appendChild(section);
    });
    const more = blocks.length - shown.length;
    if (more > 0) {
      this.element.appendChild(this.line('tab-hover-more', `+${more} more ${more === 1 ? 'pane' : 'panes'}`));
    }
  }

  private line(className: string, text: string): HTMLElement {
    const div = document.createElement('div');
    div.className = className;
    div.textContent = text;
    return div;
  }

  /** Just under the tab, left-aligned with it, clamped inside the window. */
  private place(): void {
    if (!this.anchor) return;
    const tab = this.anchor.getBoundingClientRect();
    // Measured at the left edge: the previous card's `left` would squeeze the
    // width (a card after a far-right one wrapped at ~200 px).
    this.element.style.left = '0px';
    const card = this.element.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth || window.innerWidth;
    const margin = TabHoverCard.MARGIN_PX;
    let left = tab.left;
    if (left + card.width > viewport - margin) left = viewport - margin - card.width;
    left = Math.max(margin, left);
    const top = Math.round(tab.bottom + TabHoverCard.GAP_PX);
    this.element.style.left = `${Math.round(left)}px`;
    this.element.style.top = `${top}px`;
    // Never past the window's bottom: whatever doesn't fit is cut (the card
    // takes no pointer events, so it can't scroll; MAX_BLOCKS keeps it short).
    const height = window.innerHeight || document.documentElement.clientHeight;
    if (height > 0) this.element.style.maxHeight = `${Math.max(0, height - top - margin)}px`;
  }
}
