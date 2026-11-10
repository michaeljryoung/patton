// "Pause all" (tab strip button, top right). Michael types `pause` into each
// Claude session before shutting the laptop and `resume` later; a Claude Code
// hook makes each session suspend (and later restart) the jobs it started. The
// button only delivers those words, as if typed: Patton stops no process itself.
//
// Tab state lives in each window's renderer, so a press in any window comes
// here and main asks EVERY window to act on its own panes:
//   renderer → main  PAUSE_ALL_PRESS   (invoke, 'next' | 'remaining') → PauseAllOutcome | null
//   main → renderer  PAUSE_ALL_RUN     { requestId, action, remaining }
//   renderer → main  PAUSE_ALL_REPORT  (requestId, PauseAllReport)
//   main → renderer  PAUSE_ALL_MODE    { next, left }, to every window
// Main keeps only what the button does next and how many Claude panes the
// last pause left unpaused ("Pause remaining" is offered while that is > 0);
// which panes were paused stays in each window's renderer (pane ids are per
// window). Nothing survives a relaunch.
// A window that doesn't answer within REPORT_TIMEOUT_MS is counted as asked but
// not answered; one that closes meanwhile is counted as closed, not silent, and
// stops holding the press. A late answer still counts toward the next action:
// a window that paused panes after the timeout turns the button to Resume all.
// One press at a time: a second press while one runs is refused.
// After a pause the button turns to "Resume all" only if some pane got the word.
// No runtime Electron import, so scripts/check-pause-all.mjs drives it with fakes.

import { randomUUID } from 'node:crypto';
import { IPC } from '../shared/constants';
import {
  PAUSE_CLAUDE_SKIPS, PAUSE_NAMED_MAX, PAUSE_SKIP_REASONS,
  type PauseAllAction, type PauseAllMode, type PauseAllOutcome, type PauseAllPress, type PauseAllReport,
  type PauseSkipName, type PauseSkipReason,
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

/** Claude panes a report left unpaused. */
function claudeSkips(r: PauseAllReport): number {
  let n = 0;
  for (const reason of PAUSE_CLAUDE_SKIPS) n += r.skipped[reason];
  return n;
}

interface Pending {
  requestId: string;
  action: PauseAllAction;
  waiting: Set<number>;
  total: PauseAllReport;
  answered: number;
  closed: number;
  finish: () => void;
}

/** A press that has finished but still had windows waiting: their late answers count. */
interface Late {
  requestId: string;
  action: PauseAllAction;
  waiting: Set<number>;
}

export class PauseAllCoordinator {
  private nextAction: PauseAllAction = 'pause';
  private left = 0;
  private pending: Pending | null = null;
  private late: Late | null = null;

  constructor(
    private readonly windows: () => PauseAllWindow[],
    private readonly timeoutMs: number = REPORT_TIMEOUT_MS,
    private readonly log: (msg: string, data: unknown) => void = (msg, data) => console.info(msg, data),
  ) {}

  get next(): PauseAllAction {
    return this.nextAction;
  }

  get mode(): PauseAllMode {
    return { next: this.nextAction, left: this.nextAction === 'resume' ? this.left : 0 };
  }

  /** Run the next action ('next'), or pause what the last pause skipped
   *  ('remaining', only while a paused set exists), in every live window.
   *  Null while a press is running. */
  async press(kind: PauseAllPress = 'next'): Promise<PauseAllOutcome | null> {
    if (this.pending) return null;
    const remaining = kind === 'remaining' && this.nextAction === 'resume';
    const action: PauseAllAction = remaining ? 'pause' : this.nextAction;
    const targets = this.windows().filter((w) => w.alive());
    const requestId = randomUUID();
    const total: PauseAllReport = { sent: 0, queued: 0, skipped: emptySkipped(), named: [] };
    this.late = null; // a new press: older late answers no longer count
    const offs: (() => void)[] = [];
    const pending = await new Promise<Pending>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const p: Pending = {
        requestId, action,
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
          w.send(IPC.PAUSE_ALL_RUN, { requestId, action, remaining });
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
    if (pending.waiting.size > 0) this.late = { requestId, action, waiting: new Set(pending.waiting) };
    if (remaining) {
      // Still Resume all; what's left is what this run skipped.
      this.left = claudeSkips(total);
    } else if (action === 'pause') {
      // A pause that reached no pane leaves it at Pause all (nothing to resume).
      this.nextAction = total.sent > 0 ? 'resume' : 'pause';
      this.left = claudeSkips(total);
    } else {
      // Resume always hands the button back to Pause all.
      this.nextAction = 'pause';
      this.left = 0;
    }
    const outcome: PauseAllOutcome = {
      ...total, action, remaining,
      windows: targets.length, answered: pending.answered, closed: pending.closed,
      next: this.nextAction, left: this.mode.left,
    };
    this.log('[PAUSE-ALL] press', {
      action, remaining, windows: targets.length, answered: pending.answered, closed: pending.closed,
      late: pending.waiting.size, sent: total.sent, queued: total.queued, skipped: total.skipped,
      next: this.nextAction, left: outcome.left,
    });
    this.broadcastMode();
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
      this.log('[PAUSE-ALL] late report', { window: windowId, action: l.action, sent: r.sent, skipped: r.skipped });
      // That window paused panes after all: it holds a paused set, so the
      // button must offer Resume all. A late resume changes nothing (its set is empty).
      if (l.action === 'pause') {
        if (r.sent > 0) this.nextAction = 'resume';
        this.left += claudeSkips(r);
        this.broadcastMode();
      }
      return true;
    }
    return false;
  }

  private broadcastMode(): void {
    const mode = this.mode;
    for (const w of this.windows()) {
      if (!w.alive()) continue;
      try {
        w.send(IPC.PAUSE_ALL_MODE, mode);
      } catch (err) {
        this.log('[PAUSE-ALL] mode send failed', { window: w.id, error: String(err) });
      }
    }
  }
}
