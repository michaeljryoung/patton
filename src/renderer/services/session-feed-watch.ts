/**
 * How a pane asks main to follow its Claude session (docs/session-bar.md D8):
 * the watch() calls, the one retry when main refuses one (I), and the
 * re-watch on a 7501 Claude report while main hasn't found the session (F),
 * which restarts main's fast retries. Pure: no DOM; timers and the clock come
 * in, so scripts/check-session-feed-watch.mjs drives it under plain Node.
 */
import type { SessionFeedEvent } from '../../shared/session-feed';

export interface FeedWatchApi {
  watch: (ptyId: number, hint?: { transcriptPath?: string }) => Promise<boolean>;
}

export interface FeedWatchDeps {
  /** The bridge's sessionFeed, or undefined when there is none. */
  api: () => FeedWatchApi | undefined;
  /** The pty the pane follows now (null: none); a retry for another is dropped. */
  current: () => number | null;
  log: (level: 'info' | 'warn', msg: string, data: Record<string, unknown>) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** The wait before the one retry of a refused watch. */
export const WATCH_RETRY_MS = 2000;
/** A 7501 report re-sends watch() at most this often while unattached. */
export const REWATCH_EVERY_MS = 60_000;

export class SessionFeedWatch {
  private attached = false;
  private watchedAt = 0;
  private retry: unknown = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: FeedWatchDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Ask main to follow `ptyId` (with the Stop hook's transcript path, if any). */
  watch(ptyId: number, transcriptPath?: string, retried = false): void {
    const api = this.deps.api();
    if (!api) return;
    this.watchedAt = this.now();
    api.watch(ptyId, transcriptPath ? { transcriptPath } : undefined).then((ok) => {
      if (ok !== false || this.deps.current() !== ptyId) return;
      // Refused (main's rate limit, or the pty not known there yet): once more
      // after 2 s, then leave it to the next Claude start, report or Stop.
      this.deps.log('warn', '[BAR] watch refused', { pty: ptyId, retry: !retried });
      if (retried) return;
      this.cancelRetry();
      this.retry = this.setTimer(() => {
        this.retry = null;
        if (this.deps.current() === ptyId) this.watch(ptyId, transcriptPath, true);
      }, WATCH_RETRY_MS);
    }).catch((err: unknown) => {
      this.deps.log('warn', '[BAR] feed error', { pty: ptyId, why: `watch failed: ${String(err)}` });
    });
  }

  /** Whether main has attached the session (an `attached` event, no
   *  `detached` since): the transcript feed's events can arrive. */
  get isAttached(): boolean {
    return this.attached;
  }

  /** A 7501 report from Claude Code in the pane. */
  claudeReport(): void {
    const ptyId = this.deps.current();
    if (ptyId === null || this.attached) return;
    if (this.now() - this.watchedAt < REWATCH_EVERY_MS) return;
    this.watch(ptyId);
  }

  /** A feed event main sent for the followed pty. */
  noteEvent(event: SessionFeedEvent): void {
    if (event.type === 'attached') this.attached = true;
    else if (event.type === 'detached') this.attached = false;
  }

  /** The pane stopped following (or follows another pty). */
  reset(): void {
    this.attached = false;
    this.cancelRetry();
  }

  private cancelRetry(): void {
    if (this.retry !== null) this.clearTimer(this.retry);
    this.retry = null;
  }
}
