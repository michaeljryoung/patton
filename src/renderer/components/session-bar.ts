/**
 * The session bar (docs/session-bar.md, D1, D2, D7, D11): one per window, right
 * of the tab content (#content's next sibling inside #main) and so below the
 * tab strip, shown while the active tab's focused pane runs Claude Code. It
 * lists what that pane's session has running, scheduled, failed and linked
 * (services/session-bar-model.ts), and ends with the checkpoint clock moved
 * here from the tab strip.
 *
 * ⇥ folds it to a 26 px strip (⇤, the running count, the failure count and a
 * small checkpoint button); the choice is the window's, saved with its session
 * by TabManager. When the terminal would be under 80 columns with the bar
 * open, it shows as the strip without changing that choice.
 *
 * The terminal refits on its own: the bar takes width from #content, and each
 * pane's ResizeObserver on its terminal container runs the pane's normal fit.
 * Everything shown from the model is set with textContent only.
 */
import type { BarView, LinkRow, SessionBarModel } from '../services/session-bar-model';
import { formatAge } from '../services/session-bar-model';
import type { CheckpointView } from '../services/checkpoint-clock';
import { onUiTextScaleApplied } from '../services/ui-text-scale';
import { rlog } from '../services/renderer-logger';
import { onPageTitlesChanged } from '../services/page-titles';

/** D1, D2: widths at UI text scale 1. */
export const SESSION_BAR_WIDTH_PX = 248;
export const SESSION_BAR_STRIP_PX = 26;
/** D2: under this many terminal columns with the bar open, it shows as the strip. */
export const SESSION_BAR_MIN_COLS = 80;
/** D3: ages refresh this often while the bar is shown. */
const TICK_MS = 10_000;
const CHECKPOINT_REASON_MS = 4000;

/** What the bar follows: the active tab's focused pane. */
export interface SessionBarTarget {
  paneId: string;
  model: SessionBarModel;
  /** The pane's project name, shown after "Session" when its tab holds more than one Claude pane. */
  project: string | null;
  /** The pane's terminal: width its grid is cut from and one cell's width (px), null when unmeasurable. */
  widthInfo: () => { availWidth: number; cellWidth: number } | null;
}

export interface SessionBarCallbacks {
  /** The bar's or the strip's checkpoint button (TabManager.runCheckpoint). */
  onCheckpoint: () => void;
  /** ⇥ or ⇤ changed the window's saved choice. */
  onMinimizedChange: (minimized: boolean) => void;
  /** A link row was clicked: open it through main's link-open path. */
  onOpenLink: (link: LinkRow) => void;
  /** The bar opened, folded or hid: the terminal beside it has a new width. */
  onShownChange?: (state: 'hidden' | 'open' | 'strip') => void;
}

type Shown = 'hidden' | 'open' | 'strip';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A section's rows without their times, classes and labels: what must match for an in-place patch. */
function shapeOf(sec: HTMLElement): string {
  const rows = Array.from(sec.querySelectorAll('li'), (li) => [
    li.dataset.id ?? '',
    li.querySelector('.sb-kind')?.textContent ?? '',
    li.querySelector('.sb-what')?.textContent ?? '',
    li.querySelector<HTMLElement>('[data-focus-key]')?.dataset.focusKey ?? '',
    li.querySelector('.sb-x') ? 'x' : '',
  ].join('\u0001'));
  return `${sec.className}\u0002${sec.querySelector('.sb-count')?.textContent ?? ''}\u0002${rows.join('\u0002')}`;
}

export class SessionBar {
  readonly element: HTMLElement;
  private readonly callbacks: SessionBarCallbacks;
  private readonly projectEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly listsEl: HTMLElement;
  private readonly ckptBig: HTMLElement;
  private readonly ckptNote: HTMLElement;
  private readonly ckptBtn: HTMLButtonElement;
  private readonly stripRunning: HTMLElement;
  private readonly stripFailures: HTMLElement;
  private readonly stripCkpt: HTMLButtonElement;
  private target: SessionBarTarget | null = null;
  private offModel: (() => void) | null = null;
  private minimized = false;
  /** Shown as the strip because the terminal would be too narrow (D2), whatever was chosen. */
  private narrow = false;
  private shown: Shown = 'hidden';
  private checkpoint: CheckpointView | null = null;
  private reasonText: string | null = null;
  private reasonTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private foldTimer: ReturnType<typeof setTimeout> | null = null;
  private lastListsKey = '';
  /** What the shown rows are, apart from their times (see renderLists). */
  private lastShape = '';
  private readonly disposables: (() => void)[] = [];

  constructor(contentEl: HTMLElement, callbacks: SessionBarCallbacks) {
    this.callbacks = callbacks;
    const aside = el('aside', 'session-bar');
    aside.setAttribute('aria-label', 'Session bar');
    aside.hidden = true;
    aside.dataset.state = 'hidden';
    this.element = aside;

    // --- open: header, the lists, the checkpoint
    this.bodyEl = el('div', 'sb-open');
    const head = el('div', 'sb-head');
    const title = el('h2', 'sb-title', 'Session');
    this.projectEl = el('span', 'sb-project');
    this.projectEl.hidden = true;
    title.appendChild(this.projectEl);
    const minBtn = el('button', 'sb-btn sb-icon sb-min', '⇥');
    minBtn.type = 'button';
    minBtn.setAttribute('aria-label', 'Minimize the session bar');
    minBtn.title = 'Minimize the session bar';
    minBtn.addEventListener('click', () => this.setMinimizedByButton(true));
    head.append(title, minBtn);
    this.listsEl = el('div', 'sb-lists');
    this.listsEl.addEventListener('click', (e) => this.onListClick(e));

    const ckptSec = el('section', 'sb-sec sb-sec-checkpoint');
    ckptSec.setAttribute('aria-labelledby', 'sb-h-checkpoint');
    const ckptHead = el('h3', 'sb-h', 'Checkpoint');
    ckptHead.id = 'sb-h-checkpoint';
    const ckptRow = el('div', 'sb-ckpt');
    const ckptText = el('span', 'sb-ckpt-text');
    this.ckptBig = el('span', 'sb-big', '—');
    this.ckptNote = el('span', 'sb-note');
    this.ckptNote.setAttribute('role', 'status');
    ckptText.append(this.ckptBig, ' ', this.ckptNote);
    this.ckptBtn = el('button', 'sb-btn sb-ckpt-btn', 'Checkpoint');
    this.ckptBtn.type = 'button';
    // Always handled, ready or not: while Claude can't take /checkpoint the
    // click shows why (TabManager.runCheckpoint → showCheckpointReason).
    this.ckptBtn.addEventListener('click', () => this.callbacks.onCheckpoint());
    ckptRow.append(ckptText, this.ckptBtn);
    ckptSec.append(ckptHead, ckptRow);

    this.bodyEl.append(head, this.listsEl, ckptSec);

    // --- the minimized strip
    const strip = el('div', 'sb-strip');
    const openBtn = el('button', 'sb-btn sb-icon sb-restore', '⇤');
    openBtn.type = 'button';
    openBtn.setAttribute('aria-label', 'Open the session bar');
    openBtn.title = 'Open the session bar';
    openBtn.addEventListener('click', () => this.setMinimizedByButton(false));
    this.stripRunning = el('span', 'sb-n sb-n-running', '0');
    this.stripRunning.setAttribute('role', 'img');
    this.stripFailures = el('span', 'sb-n sb-n-failures', '');
    this.stripFailures.hidden = true;
    this.stripFailures.setAttribute('role', 'img');
    this.stripCkpt = el('button', 'sb-btn sb-icon sb-strip-ckpt', '✓');
    this.stripCkpt.type = 'button';
    this.stripCkpt.addEventListener('click', () => this.callbacks.onCheckpoint());
    strip.append(openBtn, this.stripRunning, this.stripFailures, this.stripCkpt);

    aside.append(this.bodyEl, strip);
    contentEl.after(aside);

    // The window or the notes panel changed the room the terminal has: fold or unfold (D2).
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => this.scheduleFold());
      ro.observe(contentEl);
      if (contentEl.parentElement) ro.observe(contentEl.parentElement);
      this.disposables.push(() => ro.disconnect());
    }
    this.disposables.push(onUiTextScaleApplied(() => this.scheduleFold()));
    // A page's title learned: a link showing "Page <id start>" shows it.
    this.disposables.push(onPageTitlesChanged(() => this.renderLists()));
  }

  /** The window's saved choice (D2), as restored from its session. */
  setMinimized(minimized: boolean, reason: 'restore' | 'button'): void {
    if (minimized === this.minimized) return;
    this.minimized = minimized;
    rlog('info', '[BAR] minimize', { state: minimized ? 'strip' : 'open', reason });
    this.applyShown();
  }

  get isMinimized(): boolean {
    return this.minimized;
  }

  private setMinimizedByButton(minimized: boolean): void {
    // ⇤ on a strip shown only because the terminal is narrow: the choice is
    // already open, and the bar opens once there is room (D2).
    if (minimized === this.minimized) return;
    this.setMinimized(minimized, 'button');
    this.callbacks.onMinimizedChange(minimized);
    // Keep the keyboard on the bar: the other state's button.
    const next = this.element.querySelector<HTMLButtonElement>(minimized ? '.sb-restore' : '.sb-min');
    if (next && this.shown !== 'hidden') next.focus();
  }

  /** Follow a pane, or hide (null: no Claude in the active tab's focused pane, the board, wake). */
  follow(target: SessionBarTarget | null): void {
    if (target !== this.target) {
      this.offModel?.();
      this.offModel = null;
      this.target = target;
      this.lastListsKey = '';
      this.lastShape = '';
      if (target) this.offModel = target.model.onChange(() => this.renderLists());
    }
    if (target) {
      this.projectEl.hidden = !target.project;
      this.projectEl.textContent = target.project ? ` · ${target.project}` : '';
    }
    this.narrow = this.computeNarrow();
    this.applyShown();
    this.renderLists();
  }

  /** The checkpoint clock for the followed pane (D7). */
  setCheckpoint(view: CheckpointView | null): void {
    this.checkpoint = view;
    this.renderCheckpoint();
  }

  /** Why /checkpoint wasn't sent, in the checkpoint's note for a few seconds (the caller announces it). */
  showCheckpointReason(text: string): void {
    if (this.shown === 'hidden') return;
    if (this.reasonTimer) clearTimeout(this.reasonTimer);
    this.reasonText = text;
    this.reasonTimer = setTimeout(() => {
      this.reasonTimer = null;
      this.reasonText = null;
      this.renderCheckpoint();
    }, CHECKPOINT_REASON_MS);
    this.renderCheckpoint();
  }

  /** Shown as open, as the strip, or hidden. */
  get state(): Shown {
    return this.shown;
  }

  private applyShown(): void {
    const next: Shown = !this.target ? 'hidden' : this.minimized || this.narrow ? 'strip' : 'open';
    if (next !== this.shown) {
      this.shown = next;
      this.element.hidden = next === 'hidden';
      this.element.dataset.state = next;
      this.element.setAttribute('aria-label', next === 'strip' ? 'Session bar, minimized' : 'Session bar');
      this.callbacks.onShownChange?.(next);
    }
    // Folded only for want of room: ⇤ can't open it, and says why.
    const restore = this.element.querySelector<HTMLButtonElement>('.sb-restore');
    if (restore) {
      const held = next === 'strip' && !this.minimized;
      const label = held ? 'Open the session bar (the window is too narrow for it now)' : 'Open the session bar';
      restore.setAttribute('aria-disabled', String(held));
      restore.setAttribute('aria-label', label);
      restore.title = label;
    }
    this.element.dataset.narrow = String(this.narrow);
    if (next === 'hidden') this.stopTick();
    else this.startTick();
  }

  private startTick(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = setInterval(() => this.renderLists(), TICK_MS);
  }

  private stopTick(): void {
    if (this.tickTimer === null) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private scheduleFold(): void {
    if (this.foldTimer !== null) clearTimeout(this.foldTimer);
    this.foldTimer = setTimeout(() => {
      this.foldTimer = null;
      this.refold();
    }, 100);
  }

  /** Re-judge the narrow fold now (also called after a tab switch or font change). */
  refold(): void {
    if (!this.target) return;
    const narrow = this.computeNarrow();
    if (narrow === this.narrow) return;
    this.narrow = narrow;
    if (!this.minimized) rlog('info', '[BAR] minimize', { state: narrow ? 'strip' : 'open', reason: narrow ? 'narrow' : 'wide' });
    this.applyShown();
    this.renderLists();
  }

  /** D2: would the followed pane's terminal be under 80 columns with the bar open?
   *  Measured from widths, not the grid, so a fit still pending doesn't matter. */
  private computeNarrow(): boolean {
    const info = this.target?.widthInfo() ?? null;
    if (!info || !(info.cellWidth > 0) || !(info.availWidth > 0)) return this.narrow;
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const openW = SESSION_BAR_WIDTH_PX * scale;
    const nowW = this.element.hidden ? 0 : this.element.getBoundingClientRect().width;
    const cols = Math.floor((info.availWidth + nowW - openW) / info.cellWidth);
    return cols < SESSION_BAR_MIN_COLS;
  }

  private renderCheckpoint(): void {
    const v = this.checkpoint;
    this.ckptBig.textContent = v && v.pct !== null ? `${v.pct}%` : '—';
    let note: string;
    if (this.reasonText) note = this.reasonText;
    else if (!v) note = 'context';
    else if (v.pct === null) note = 'context · no reading yet';
    else if (v.checkpointAt === null) note = 'context · no checkpoint yet';
    else note = `context · last ${formatAge(Date.now() - v.checkpointAt * 1000)} ago`;
    this.ckptNote.textContent = note;
    for (const btn of [this.ckptBtn, this.stripCkpt]) {
      btn.hidden = v === null;
      btn.classList.toggle('due', !!v?.due);
      btn.classList.toggle('blocked', !!v?.blocked);
      btn.setAttribute('aria-disabled', String(!!v?.blocked));
      const label = v ? v.label : 'Checkpoint';
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    // Folded, the note above is hidden: a refused click shows its reason on the
    // strip's button for the same few seconds (a "!" and the reason as its label).
    const refused = !!this.reasonText;
    this.stripCkpt.classList.toggle('reason', refused);
    this.stripCkpt.textContent = refused ? '!' : '✓';
    if (this.reasonText) {
      this.stripCkpt.setAttribute('aria-label', this.reasonText);
      this.stripCkpt.title = this.reasonText;
    }
    this.ckptBig.classList.toggle('due', !!v?.due);
  }

  /** Rebuild the four lists when what they show changed (ages included, every 10 s). */
  private renderLists(): void {
    this.renderCheckpoint();
    if (!this.target) return;
    const view = this.target.model.view(Date.now());
    this.renderStrip(view);
    if (this.shown !== 'open') {
      this.lastListsKey = '';
      this.lastShape = '';
      return;
    }
    const key = JSON.stringify(view);
    if (key === this.lastListsKey) return;
    this.lastListsKey = key;
    const sections = this.buildSections(view);
    // Only a row's time, class or labels changed (an age ticked): patch the rows in place,
    // so a native tooltip being read and the keyboard focus are not dismissed every 10 s.
    const shape = sections.map(shapeOf).join('\u0003');
    if (shape === this.lastShape && this.patchRows(sections)) return;
    this.lastShape = shape;
    // Keep the keyboard where it was across the rebuild.
    const focused = document.activeElement as HTMLElement | null;
    const focusKey = focused && this.listsEl.contains(focused) ? focused.dataset.focusKey ?? null : null;
    this.listsEl.replaceChildren(...sections);
    if (focusKey) this.listsEl.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  /** Copy the time text, class, and the title and label of each freshly built row and of its
   *  inner elements onto the row already shown (same shape, checked by the caller). False when the rows don't line up. */
  private patchRows(fresh: HTMLElement[]): boolean {
    const old = Array.from(this.listsEl.querySelectorAll<HTMLElement>('li'));
    const next = fresh.flatMap((sec) => Array.from(sec.querySelectorAll<HTMLElement>('li')));
    if (old.length !== next.length) return false;
    for (let i = 0; i < old.length; i++) {
      const o = old[i];
      const n = next[i];
      if (o.className !== n.className) o.className = n.className;
      // The row and everything in it that carries a title or label (a link's button holds its own).
      const oe = [o, ...Array.from(o.querySelectorAll<HTMLElement>('*'))];
      const ne = [n, ...Array.from(n.querySelectorAll<HTMLElement>('*'))];
      if (oe.length !== ne.length) return false;
      for (let j = 0; j < oe.length; j++) {
        for (const a of ['title', 'aria-label']) {
          const v = ne[j].getAttribute(a);
          if (v !== oe[j].getAttribute(a)) {
            if (v === null) oe[j].removeAttribute(a);
            else oe[j].setAttribute(a, v);
          }
        }
      }
      const ot = o.querySelector('.sb-t');
      const nt = n.querySelector('.sb-t');
      if (ot && nt && ot.textContent !== nt.textContent) ot.textContent = nt.textContent;
    }
    return true;
  }

  private renderStrip(view: BarView): void {
    this.stripRunning.textContent = String(view.liveCount);
    this.stripRunning.setAttribute('aria-label', `${view.liveCount} running`);
    this.stripRunning.title = `${view.liveCount} running`;
    const f = view.failures.length;
    // No failures: no box, so the strip's one number is plainly the running count.
    // Failures: "!N" in the failure colour, never mistaken for it.
    this.stripFailures.hidden = f === 0;
    this.stripFailures.textContent = f > 0 ? `!${f}` : '';
    this.stripFailures.classList.toggle('some', f > 0);
    const fl = `${f} failure${f === 1 ? '' : 's'}`;
    this.stripFailures.setAttribute('aria-label', fl);
    this.stripFailures.title = fl;
  }

  private section(id: string, title: string, count: number): { sec: HTMLElement; list: HTMLUListElement } {
    const sec = el('section', `sb-sec sb-sec-${id}`);
    sec.setAttribute('aria-labelledby', `sb-h-${id}`);
    const h = el('h3', 'sb-h', title);
    h.id = `sb-h-${id}`;
    const n = el('span', 'sb-count', String(count));
    h.append(' ', n);
    const list = el('ul', 'sb-list');
    sec.append(h, list);
    return { sec, list };
  }

  /** The Failures section's "dismiss all" ×, in its header beside the count: same glyph and look as a row's ×. */
  private addDismissAll(sec: HTMLElement): void {
    const h = sec.querySelector('.sb-h');
    if (!h) return;
    const head = el('div', 'sb-sec-head');
    const x = el('button', 'sb-x-all', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss all failures');
    x.title = 'Dismiss all failures';
    x.dataset.dismissAll = '1';
    x.dataset.focusKey = 'x:all';
    h.replaceWith(head);
    head.append(h, x);
  }

  private item(kind: string, what: HTMLElement, when: string, cls = ''): HTMLLIElement {
    const li = el('li', `sb-item${cls ? ' ' + cls : ''}`);
    li.append(el('span', 'sb-kind', kind), what, el('span', 'sb-t', when));
    return li;
  }

  private buildSections(view: BarView): HTMLElement[] {
    const out: HTMLElement[] = [];
    // Running: always there, so the bar says when nothing is.
    {
      const { sec, list } = this.section('running', 'Running', view.liveCount);
      if (view.running.length === 0) {
        list.append(el('li', 'sb-empty', 'Nothing in the background'));
      }
      for (const r of view.running) {
        const what = el('span', 'sb-what', r.description);
        const when = r.ended ? (r.endLabel ?? 'done') : r.age;
        const li = this.item(r.kind, what, when, `${r.long ? 'long' : ''}${r.ended ? ' done' : ''}`.trim());
        li.title = r.tooltip;
        li.setAttribute('aria-label', `${r.kind}: ${r.tooltip.replace(/\n/g, ', ')}, ${r.ended ? when : `running ${when}`}${r.long ? ', over an hour' : ''}`);
        li.dataset.id = r.id;
        list.append(li);
      }
      out.push(sec);
    }
    if (view.scheduled.length > 0) {
      const { sec, list } = this.section('scheduled', 'Scheduled', view.scheduled.length);
      for (const s of view.scheduled) {
        const li = this.item(s.kind, el('span', 'sb-what', s.prompt), s.when);
        li.title = s.tooltip;
        li.setAttribute('aria-label', `${s.kind}: ${s.prompt}, ${s.nextFire === null ? `schedule ${s.when}` : `next at ${s.when}`}`);
        list.append(li);
      }
      out.push(sec);
    }
    if (view.failures.length > 0) {
      const { sec, list } = this.section('failures', 'Failures', view.failures.length);
      for (const f of view.failures) {
        const li = this.item(f.kind, el('span', 'sb-what', f.text), f.when, 'fail');
        li.title = f.tooltip;
        li.setAttribute('aria-label', `${f.kind} failed: ${f.tooltip}, ${f.when}`);
        const x = el('button', 'sb-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Dismiss');
        x.title = 'Dismiss';
        x.dataset.dismiss = f.key;
        x.dataset.focusKey = `x:${f.key}`;
        li.append(x);
        list.append(li);
      }
      this.addDismissAll(sec);
      out.push(sec);
    }
    if (view.links.length > 0) {
      const { sec, list } = this.section('links', 'Links', view.links.length);
      for (const l of view.links) {
        const btn = el('button', 'sb-what sb-link', l.label);
        btn.type = 'button';
        btn.dataset.link = l.key;
        btn.dataset.focusKey = `l:${l.key}`;
        // The label (clamped in the row), then where it goes on a second line.
        const target = l.url ?? l.path;
        btn.title = target && target !== l.label ? `${l.label}\n${target}` : l.label;
        btn.setAttribute('aria-label', `Open ${l.label} (${l.kind}, ${l.when})`);
        list.append(this.item(l.kind, btn, l.when, 'link'));
      }
      out.push(sec);
    }
    return out;
  }

  private onListClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-dismiss], [data-dismiss-all], [data-link]');
    if (!t || !this.target) return;
    const model = this.target.model;
    if (t.dataset.dismissAll) {
      const hadFocus = document.activeElement === t;
      const count = model.dismissAllFailures();
      if (count > 0) rlog('info', '[BAR] failures dismissed', { pane: this.target.paneId, count });
      // The section is gone: the keyboard goes to the next section's first button, else the bar's own ⇥.
      if (hadFocus) {
        const next = this.listsEl.querySelector<HTMLElement>('.sb-sec button') ?? this.element.querySelector<HTMLElement>('.sb-min');
        next?.focus();
      }
      return;
    }
    if (t.dataset.dismiss) {
      model.dismissFailure(t.dataset.dismiss);
      return;
    }
    const key = t.dataset.link;
    const link = model.view(Date.now()).links.find((l) => l.key === key);
    if (link) this.callbacks.onOpenLink(link);
  }

  dispose(): void {
    this.offModel?.();
    this.stopTick();
    if (this.reasonTimer) clearTimeout(this.reasonTimer);
    if (this.foldTimer) clearTimeout(this.foldTimer);
    for (const d of this.disposables) d();
    this.element.remove();
  }
}
