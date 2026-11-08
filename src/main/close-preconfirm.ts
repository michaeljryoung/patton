// ⌘W on the last tab asks in the app ("Quit Patton?"), so main's close guard
// must not ask a second time with its native box. The renderer records the
// confirmation here just before it asks main to close the window (window:close); the guard takes it.
//
// One-shot and short-lived on purpose: the record is consumed by the very next
// close of that window, and one older than the TTL counts for nothing, so ⌘Q,
// the red close button still meets the native prompt.
// Keyed by window id, so one window's confirmation never skips another's.
// No Electron import, so the check scripts can drive it directly.

export const CLOSE_PRECONFIRM_TTL_MS = 5_000;

/** What the guard found for a window: a fresh confirmation, a stale one, or none. */
export type PreconfirmState = 'confirmed' | 'expired' | 'none';

export class ClosePreconfirmations {
  private readonly markedAt = new Map<number, number>();

  constructor(
    private readonly ttlMs: number = CLOSE_PRECONFIRM_TTL_MS,
    private readonly now: () => number = () => performance.now(), // monotonic: a clock step can't revive an old record
  ) {}

  /** The renderer of window `windowId` confirmed closing it in the app. */
  mark(windowId: number): void {
    this.markedAt.set(windowId, this.now());
  }

  /** Consume the window's record (whatever its age) and say whether it counts. */
  take(windowId: number): PreconfirmState {
    const at = this.markedAt.get(windowId);
    if (at === undefined) return 'none';
    this.markedAt.delete(windowId);
    return this.now() - at <= this.ttlMs ? 'confirmed' : 'expired';
  }

  /** Drop a closed window's record so ids never carry one over. */
  forget(windowId: number): void {
    this.markedAt.delete(windowId);
  }
}

/** The one instance main's guard and the IPC handler share. */
export const closePreconfirmations = new ClosePreconfirmations();
