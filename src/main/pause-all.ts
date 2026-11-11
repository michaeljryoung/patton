// "Pause all" (tab strip button, top right). Michael types `pause` into each
// Claude session before shutting the laptop; a Claude Code hook makes each
// session suspend the jobs it started. The button only delivers that word, as
// if typed: Patton stops no process itself. Resuming is typed by hand, tab by
// tab (each session is a bit different), so there is no Resume button.
//
// Tab state lives in each window's renderer, so a press in any window comes
// here and main asks EVERY window to act on its own panes:
//   renderer → main  PAUSE_ALL_PRESS   (invoke) → PauseAllOutcome | null
//   main → renderer  PAUSE_ALL_RUN     { requestId }
//   renderer → main  PAUSE_ALL_REPORT  (requestId, PauseAllReport)
// Every press is a pause, by the same rules; a pane already paused is paused
// again. Main keeps no state between presses and nothing survives a relaunch.
// A window that doesn't answer within REPORT_TIMEOUT_MS is counted as asked but
// not answered; one that closes meanwhile is counted as closed, not silent, and
// stops holding the press. A late answer is only logged.
// One press at a time: a second press while one runs is refused.
// No runtime Electron import, so scripts/check-pause-all.mjs drives it with fakes.

import { randomUUID } from 'node:crypto';
import { IPC } from '../shared/constants';
import {
  PAUSE_NAMED_MAX, PAUSE_SKIP_REASONS,
  type PauseAllOutcome, type PauseAllReport, type PauseSkipName, type PauseSkipReason,
} from '../shared/types';

/** One window, as the coordinator needs it. */
export interface PauseAllWindow {
  id: number;
  /** False once destroyed or crashed: not asked. */
  alive: () => boolean;
  send: (channel: string, payload: unknown) => void;
  /** Call `cb` once when the window closes; returns the unsubscribe. */
  onClosed: (cb: () => void) => () => void;
}

/** How long a window has to answer: the close-IPC timeout the renderer uses too. */
export const REPORT_TIMEOUT_MS = 1500;

/** A report's counts are capped here: no window has more panes. */
const MAX_COUNT = 10_000;
/** A tab title in a report is cut to this many characters. */
const MAX_TITLE = 80;

function emptySkipped(): Record<PauseSkipReason, number> {
  const out = {} as Record<PauseSkipReason, number>;
  for (const r of PAUSE_SKIP_REASONS) out[r] = 0;
  return out;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : 0;
}

/** A tab title from a renderer: text only, no control characters, short. */
function cleanTitle(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_TITLE);
  return t || null;
}

/** A renderer's report, untrusted: only known reasons, small whole numbers and short titles. */
export function cleanReport(raw: unknown): PauseAllReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { sent?: unknown; queued?: unknown; skipped?: unknown; named?: unknown };
  const skipped = emptySkipped();
  if (r.skipped && typeof r.skipped === 'object') {
    for (const reason of PAUSE_SKIP_REASONS) skipped[reason] = count((r.skipped as Record<string, unknown>)[reason]);
  }
  const named: PauseSkipName[] = [];
  if (Array.isArray(r.named)) {
    for (const n of r.named.slice(0, PAUSE_NAMED_MAX)) {
      const title = cleanTitle((n as { title?: unknown })?.title);
      const reason = (n as { reason?: unknown })?.reason;
      if (title && PAUSE_SKIP_REASONS.includes(reason as PauseSkipReason)) named.push({ title, reason: reason as PauseSkipReason });
    }
  }
  const sent = count(r.sent);
  return { sent, queued: Math.min(count(r.queued), sent), skipped, named };
}

interface Pending {
  requestId: string;
  waiting: Set<number>;
  total: PauseAllReport;
  answered: number;
  closed: number;
  finish: () => void;
}

/** A press that has finished but still had windows waiting: their late answers are only logged. */
interface Late {
  requestId: string;
  waiting: Set<number>;
}

export class PauseAllCoordinator {
  private pending: Pending | null = null;
  private late: Late | null = null;

  constructor(
    private readonly windows: () => PauseAllWindow[],
    private readonly timeoutMs: number = REPORT_TIMEOUT_MS,
    private readonly log: (msg: string, data: unknown) => void = (msg, data) => console.info(msg, data),
  ) {}

  /** Pause every live window's panes. Null while a press is running. */
  async press(): Promise<PauseAllOutcome | null> {
    if (this.pending) return null;
    const targets = this.windows().filter((w) => w.alive());
    const requestId = randomUUID();
    const total: PauseAllReport = { sent: 0, queued: 0, skipped: emptySkipped(), named: [] };
    this.late = null; // a new press: older late answers no longer count
    const offs: (() => void)[] = [];
    const pending = await new Promise<Pending>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const p: Pending = {
        requestId,
        waiting: new Set(targets.map((w) => w.id)),
        total, answered: 0, closed: 0,
        finish: () => {
          if (timer) clearTimeout(timer);
          if (this.pending === p) this.pending = null;
          resolve(p);
        },
      };
      this.pending = p;
      if (targets.length === 0) { p.finish(); return; }
      timer = setTimeout(() => p.finish(), this.timeoutMs);
      for (const w of targets) {
        // A window closed mid-press stops holding it, and isn't "didn't answer".
        try {
          offs.push(w.onClosed(() => {
            if (this.pending !== p || !p.waiting.delete(w.id)) return;
            p.closed += 1;
            if (p.waiting.size === 0) p.finish();
          }));
        } catch (err) {
          this.log('[PAUSE-ALL] could not watch a window', { window: w.id, error: String(err) });
        }
        try {
          w.send(IPC.PAUSE_ALL_RUN, { requestId });
        } catch (err) {
          p.waiting.delete(w.id);
          this.log('[PAUSE-ALL] send failed', { window: w.id, error: String(err) });
        }
      }
      if (p.waiting.size === 0) p.finish();
    });
    for (const off of offs) {
      try { off(); } catch { /* a window going away */ }
    }
    if (pending.waiting.size > 0) this.late = { requestId, waiting: new Set(pending.waiting) };
    const outcome: PauseAllOutcome = {
      ...total,
      windows: targets.length, answered: pending.answered, closed: pending.closed,
    };
    this.log('[PAUSE-ALL] press', {
      windows: targets.length, answered: pending.answered, closed: pending.closed,
      late: pending.waiting.size, sent: total.sent, queued: total.queued, skipped: total.skipped,
    });
    return outcome;
  }

  /** A window's answer. True if it matched a press (running, or finished with
   *  this window still owing an answer) and was counted. */
  report(windowId: number, requestId: unknown, raw: unknown): boolean {
    if (typeof requestId !== 'string') return false;
    const p = this.pending;
    if (p && requestId === p.requestId && p.waiting.has(windowId)) {
      const r = cleanReport(raw);
      if (!r) return false;
      p.waiting.delete(windowId);
      p.answered += 1;
      p.total.sent += r.sent;
      p.total.queued += r.queued;
      for (const reason of PAUSE_SKIP_REASONS) p.total.skipped[reason] += r.skipped[reason];
      for (const n of r.named) if (p.total.named.length < PAUSE_NAMED_MAX) p.total.named.push(n);
      if (p.waiting.size === 0) p.finish();
      return true;
    }
    const l = this.late;
    if (l && requestId === l.requestId && l.waiting.has(windowId)) {
      const r = cleanReport(raw);
      if (!r) return false;
      l.waiting.delete(windowId);
      this.log('[PAUSE-ALL] late report', { window: windowId, sent: r.sent, skipped: r.skipped });
      return true;
    }
    return false;
  }
}
