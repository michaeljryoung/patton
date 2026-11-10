// "Pause all" (tab strip button, top right). Michael types `pause` into each
// Claude session before shutting the laptop and `resume` later; a Claude Code
// hook makes each session suspend (and later restart) the jobs it started. The
// button only delivers those words, as if typed: Patton stops no process itself.
//
// Tab state lives in each window's renderer, so a press in any window comes
// here and main asks EVERY window to act on its own panes:
//   renderer → main  PAUSE_ALL_PRESS   (invoke)  → PauseAllOutcome | null
//   main → renderer  PAUSE_ALL_RUN     { requestId, action }
//   renderer → main  PAUSE_ALL_REPORT  (requestId, PauseAllReport)
//   main → renderer  PAUSE_ALL_MODE    next action, to every window
// Main keeps only what the button does next; which panes were paused stays in
// each window's renderer (pane ids are per window). Nothing survives a relaunch.
// A window that doesn't answer within REPORT_TIMEOUT_MS is counted as asked but
// not answered. One press at a time: a second press while one runs is refused.
// After a pause the button turns to "Resume all" only if some pane got the word.
// No runtime Electron import, so scripts/check-pause-all.mjs drives it with fakes.

import { randomUUID } from 'node:crypto';
import { IPC } from '../shared/constants';
import {
  PAUSE_SKIP_REASONS,
  type PauseAllAction, type PauseAllOutcome, type PauseAllReport, type PauseSkipReason,
} from '../shared/types';

/** One window, as the coordinator needs it. */
export interface PauseAllWindow {
  id: number;
  /** False once destroyed or crashed: not asked. */
  alive: () => boolean;
  send: (channel: string, payload: unknown) => void;
}

/** How long a window has to answer: the close-IPC timeout the renderer uses too. */
export const REPORT_TIMEOUT_MS = 1500;

/** A report's counts are capped here: no window has more panes. */
const MAX_COUNT = 10_000;

function emptySkipped(): Record<PauseSkipReason, number> {
  const out = {} as Record<PauseSkipReason, number>;
  for (const r of PAUSE_SKIP_REASONS) out[r] = 0;
  return out;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : 0;
}

/** A renderer's report, untrusted: only known reasons and small whole numbers. */
export function cleanReport(raw: unknown): PauseAllReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { sent?: unknown; skipped?: unknown };
  const skipped = emptySkipped();
  if (r.skipped && typeof r.skipped === 'object') {
    for (const reason of PAUSE_SKIP_REASONS) skipped[reason] = count((r.skipped as Record<string, unknown>)[reason]);
  }
  return { sent: count(r.sent), skipped };
}

interface Pending {
  requestId: string;
  waiting: Set<number>;
  total: PauseAllReport;
  answered: number;
  finish: () => void;
}

export class PauseAllCoordinator {
  private nextAction: PauseAllAction = 'pause';
  private pending: Pending | null = null;

  constructor(
    private readonly windows: () => PauseAllWindow[],
    private readonly timeoutMs: number = REPORT_TIMEOUT_MS,
  ) {}

  get next(): PauseAllAction {
    return this.nextAction;
  }

  /** Run the next action in every live window. Null while a press is running. */
  async press(): Promise<PauseAllOutcome | null> {
    if (this.pending) return null;
    const action = this.nextAction;
    const targets = this.windows().filter((w) => w.alive());
    const requestId = randomUUID();
    const total: PauseAllReport = { sent: 0, skipped: emptySkipped() };
    const answered = await new Promise<number>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const pending: Pending = {
        requestId,
        waiting: new Set(targets.map((w) => w.id)),
        total,
        answered: 0,
        finish: () => {
          if (timer) clearTimeout(timer);
          this.pending = null;
          resolve(pending.answered);
        },
      };
      this.pending = pending;
      if (targets.length === 0) { pending.finish(); return; }
      timer = setTimeout(() => pending.finish(), this.timeoutMs);
      for (const w of targets) {
        try {
          w.send(IPC.PAUSE_ALL_RUN, { requestId, action });
        } catch {
          pending.waiting.delete(w.id);
        }
      }
      if (pending.waiting.size === 0) pending.finish();
    });
    // Resume always hands the button back to Pause all; a pause that reached
    // no pane leaves it at Pause all (there is nothing to resume).
    this.nextAction = action === 'pause' && total.sent > 0 ? 'resume' : 'pause';
    const outcome: PauseAllOutcome = {
      action, sent: total.sent, skipped: total.skipped,
      windows: targets.length, answered, next: this.nextAction,
    };
    console.info('[PAUSE-ALL] press', {
      action, windows: targets.length, answered, sent: total.sent, skipped: total.skipped, next: this.nextAction,
    });
    for (const w of this.windows()) {
      if (!w.alive()) continue;
      try { w.send(IPC.PAUSE_ALL_MODE, this.nextAction); } catch { /* a window going away */ }
    }
    return outcome;
  }

  /** A window's answer. True if it matched the running press and was counted. */
  report(windowId: number, requestId: unknown, raw: unknown): boolean {
    const p = this.pending;
    if (!p || typeof requestId !== 'string' || requestId !== p.requestId || !p.waiting.has(windowId)) return false;
    const r = cleanReport(raw);
    if (!r) return false;
    p.waiting.delete(windowId);
    p.answered += 1;
    p.total.sent += r.sent;
    for (const reason of PAUSE_SKIP_REASONS) p.total.skipped[reason] += r.skipped[reason];
    if (p.waiting.size === 0) p.finish();
    return true;
  }
}
