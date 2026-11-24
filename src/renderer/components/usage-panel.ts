/**
 * The usage panel at the foot of the bookmarks sidebar (layout U1, picked on
 * docs/mocks/usage-panel.html): every Claude login Michael has used, live one
 * first, each with its week's percent, a meter and its reset time, and a
 * 5-hour line where that login has a live 5-hour window. With the sidebar
 * hidden, the rail shows one small bar per login and the figures in its tooltip.
 *
 * The readings come from main (main/plan-usage-ipc.ts), which reads the file
 * Claude Code's status line writes. Every text is set through textContent.
 */
import { EMPTY_PLAN_USAGE, planUsageAt, usageIdentity, type PlanUsage, type PlanUsageAccount, type UsageWindow } from '../../shared/plan-usage';
import type { PattonAPI } from '../../shared/types';
import { rlog } from '../services/renderer-logger';
import { clockTime, dayTime, newestRead, shownPct, usageLevel, weekLine } from '../services/usage-format';

/** If main's first answer is null (rate-limited), ask once more after this (ms). */
const RETRY_DELAY_MS = 2000;
/** Re-draw this often, so a reset that passes shows without a new reading. */
const REDRAW_MS = 60 * 1000;
/** The rail is 22 px wide: at most this many 3 px bars fit with their gaps. */
export const RAIL_MAX_BARS = 5;

export interface UsagePanelOptions {
  /** The sidebar the panel goes in, and the element it goes before. */
  parent: HTMLElement;
  before: Element | null;
  /** The hidden sidebar's strip, and its tooltip without the figures. */
  rail: HTMLElement;
  railTitle: string;
  /** Epoch seconds now (the checks pass a fixed clock). */
  now?: () => number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function meter(className: string, pct: number): HTMLElement {
  const m = el('span', className);
  m.setAttribute('aria-hidden', 'true');
  const fill = el('i', '');
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  m.appendChild(fill);
  return m;
}

/** The full detail of one login, for its tooltip and accessible name. */
function detail(a: PlanUsageAccount): string {
  // The email is left out when the name already holds it (a widened name is the email).
  const email = a.email && !a.name.toLowerCase().includes(a.email.toLowerCase()) ? a.email : null;
  const who = [a.name + (a.live ? ' (live)' : ''), email, a.plan].filter(Boolean).join(', ');
  const parts: string[] = [];
  if (a.week) parts.push(`week ${shownPct(a.week.pct)}%, ${weekLine(a.week)}`);
  else parts.push('no recent weekly reading');
  if (a.fiveHour && !a.fiveHour.passed) parts.push(`5-hour ${shownPct(a.fiveHour.pct)}%, resets ${clockTime(a.fiveHour.resetsAt)}`);
  const read = a.week?.readAt ?? a.fiveHour?.readAt ?? null;
  if (read !== null) parts.push(`read ${clockTime(read)}`);
  return `${who}: ${parts.join('; ')}`;
}

export class UsagePanel {
  readonly el: HTMLElement;
  private railBars: HTMLElement;
  private rail: HTMLElement;
  private railTitle: string;
  private now: () => number;
  private usage: PlanUsage = EMPTY_PLAN_USAGE;
  private lastContent = '';
  /** The reading's identity (no read times) at the last log line. */
  private lastIdentity = '';
  /** The rendered strings last drawn (panel markup, rail markup, rail tooltip), so a re-draw that would
   *  draw the same leaves the DOM alone (a hovered tooltip stays) and the minute's tick costs nothing. */
  private lastDrawn: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by dispose(): a late answer or timer then does nothing. */
  private disposed = false;
  private disposables: (() => void)[] = [];

  constructor(opts: UsagePanelOptions) {
    this.rail = opts.rail;
    this.railTitle = opts.railTitle;
    this.now = opts.now ?? (() => Date.now() / 1000);

    this.el = el('section', 'usage-panel');
    this.el.setAttribute('aria-label', 'Plan usage');
    this.el.hidden = true;
    opts.parent.insertBefore(this.el, opts.before);

    this.railBars = el('span', 'usage-rail');
    this.railBars.setAttribute('aria-hidden', 'true');
    this.railBars.hidden = true;
    this.rail.appendChild(this.railBars);

    this.timer = setInterval(() => { if (!this.disposed) this.render(); }, REDRAW_MS);
    this.start();
  }

  /** Ask main once, then follow its pushes. No bridge (some checks): stays hidden. */
  private start(): void {
    const api = (window.patton as Partial<PattonAPI> | undefined)?.planUsage;
    if (!api) return;
    let pushed = false;
    this.disposables.push(api.onChanged((usage) => {
      if (this.disposed) return;
      pushed = true;
      this.setUsage(usage);
    }));
    const ask = (retry: boolean): void => {
      api.get()
        .then((usage) => {
          if (this.disposed || pushed) return;
          if (usage) this.setUsage(usage);
          else if (!retry) {
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              if (!this.disposed && !pushed) ask(true);
            }, RETRY_DELAY_MS);
          }
        })
        .catch((err) => {
          if (!this.disposed) rlog('warn', '[USAGE] could not load', { error: (err as Error)?.name ?? 'unknown' });
        });
    };
    ask(false);
  }

  /** A reading from main (or a check). Re-draws when its content changed (render skips an identical
   *  picture) and logs only when a login, its figures or the live one did, not for a new read time. */
  setUsage(usage: PlanUsage | null | undefined): void {
    if (this.disposed) return;
    const next = usage && Array.isArray(usage.accounts) ? usage : EMPTY_PLAN_USAGE;
    const content = JSON.stringify(next);
    if (content === this.lastContent) return;
    this.lastContent = content;
    this.usage = next;
    const identity = usageIdentity(next);
    if (identity !== this.lastIdentity) {
      this.lastIdentity = identity;
      rlog('info', '[USAGE] panel', { accounts: next.accounts.length, live: next.liveId });
    }
    this.render();
  }

  render(): void {
    if (this.disposed) return;
    const usage = planUsageAt(this.usage, this.now());
    // Build off-screen, compare what would be drawn with what is, and touch the live DOM only for a difference.
    const panel = this.buildPanel(usage);
    const bars = this.buildRail(usage);
    const title = this.railTitleFor(usage);
    const drawn = JSON.stringify([panel.innerHTML, bars.innerHTML, title]);
    if (drawn === this.lastDrawn) return;
    this.lastDrawn = drawn;
    this.el.hidden = usage.accounts.length === 0;
    this.el.replaceChildren(...panel.childNodes);
    this.railBars.hidden = usage.accounts.length === 0;
    this.railBars.replaceChildren(...bars.childNodes);
    this.rail.title = title;
  }

  private buildPanel(usage: PlanUsage): HTMLElement {
    const out = el('div', '');
    if (usage.accounts.length === 0) return out;

    const head = el('div', 'usage-head');
    head.appendChild(el('span', 'usage-title', 'Usage this week'));
    const newest = newestRead(usage);
    if (newest !== null) {
      const time = el('span', 'usage-time', clockTime(newest));
      time.title = `Newest reading ${dayTime(newest)}`;
      head.appendChild(time);
    }
    out.appendChild(head);

    for (const a of usage.accounts) out.appendChild(this.block(a));
    return out;
  }

  private block(a: PlanUsageAccount): HTMLElement {
    const week = a.week;
    const level = week ? usageLevel(week.pct) : '';
    const block = el('div', ['usage-acct', level, a.live ? 'live' : ''].filter(Boolean).join(' '));
    block.dataset.account = a.id;
    block.setAttribute('role', 'group');
    const full = detail(a);
    block.setAttribute('aria-label', full);
    block.title = full;

    const top = el('div', 'usage-acct-top');
    // The tag is the name's sibling, so a long name clips alone and the tag stays.
    top.appendChild(el('span', 'usage-name', a.name));
    if (a.live) top.appendChild(el('span', 'usage-tag', 'live'));
    top.appendChild(el('span', 'usage-pct', week ? `${shownPct(week.pct)}%` : '–'));
    block.appendChild(top);

    block.appendChild(meter('usage-meter', week ? week.pct : 0));
    // A later token figure goes before the reset here, as "<tokens> · resets …".
    block.appendChild(el('div', 'usage-sub usage-reset', week ? weekLine(week) : 'no recent reading'));

    const five: UsageWindow | null = a.fiveHour && !a.fiveHour.passed ? a.fiveHour : null;
    if (five) {
      const fiveLevel = usageLevel(five.pct);
      const line = el('div', ['usage-sub', 'usage-five', fiveLevel].filter(Boolean).join(' '));
      line.appendChild(el('span', 'usage-five-pct', `5-hour ${shownPct(five.pct)}%`));
      line.appendChild(meter('usage-meter', five.pct));
      line.appendChild(el('span', 'usage-five-reset', clockTime(five.resetsAt)));
      block.appendChild(line);
    }
    return block;
  }

  private buildRail(usage: PlanUsage): HTMLElement {
    const out = el('div', '');
    for (const a of usage.accounts.slice(0, RAIL_MAX_BARS)) {
      const pct = a.week ? a.week.pct : 0;
      const level = a.week ? usageLevel(pct) : '';
      const bar = el('span', ['usage-rail-bar', level].filter(Boolean).join(' '));
      bar.dataset.account = a.id;
      const fill = el('i', '');
      fill.style.height = `${Math.min(100, Math.max(0, pct))}%`;
      bar.appendChild(fill);
      out.appendChild(bar);
    }
    return out;
  }

  private railTitleFor(usage: PlanUsage): string {
    if (usage.accounts.length === 0) return this.railTitle;
    const figures = usage.accounts.map((a) => `${a.name} ${a.week ? `${shownPct(a.week.pct)}%` : '–'}`).join(', ');
    return `${this.railTitle} — ${figures}`;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
    for (const d of this.disposables) d();
    this.disposables = [];
    this.railBars.remove();
    this.el.remove();
  }
}
