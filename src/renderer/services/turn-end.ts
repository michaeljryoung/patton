/**
 * How a Claude Code turn ends when OSC 7501 reports and the Stop hook has
 * also spoken. Pure: no DOM, no IPC, no clock (callers pass times in).
 *
 * 7501 knows the root's state and the child records Claude Code reports, but
 * not every background task or timer: the hook counts Claude Code's own
 * `background_tasks` and `crons`. Field data (8 Nov 2026): a root `done` with
 * no child records while the hook said 2 tasks were still running raised a
 * false "needs you" dot. So the hook's counts are merged in for the turn it
 * closed, and only that turn.
 */
import type { ProgramSignal, ProgramState } from './program-status';

/** The Stop hook's count of background work for the turn it closed. */
export interface HookVerdict {
  tasks: number;
  crons: number;
  /** When the verdict arrived (ms). */
  atMs: number;
}

/**
 * The signal at a turn end. Only a plain "root done, nothing else going on"
 * (`needs-you` keyed `root:done`) can be turned into the ring, and only by a
 * verdict that reported work (tasks + crons > 0) and came within `ttlMs` of
 * the root's done time (either order). A working child already parks with its
 * own titles; a blocked root, an error or a blocked child always alert.
 * `viaHook` is true when the verdict made the ring.
 */
export function turnEndSignal(
  signal: ProgramSignal,
  verdict: HookVerdict | null,
  rootDoneAtMs: number | null,
  ttlMs: number,
): { signal: ProgramSignal; viaHook: boolean } {
  if (signal.kind !== 'needs-you' || signal.key !== 'root:done') return { signal, viaHook: false };
  if (!verdict || rootDoneAtMs === null) return { signal, viaHook: false };
  if (verdict.tasks + verdict.crons <= 0) return { signal, viaHook: false };
  if (Math.abs(verdict.atMs - rootDoneAtMs) > ttlMs) return { signal, viaHook: false };
  return {
    signal: { kind: 'parked', tasks: verdict.tasks, crons: verdict.crons, titles: [] },
    viaHook: true,
  };
}

/**
 * The stored verdict after the root moved from `previous` to `next`. A verdict
 * belongs to one turn: the root entering `working` from any other state means
 * a new turn began, so it goes. Repeated `working` reports keep it (the hook
 * speaks while the root is still working, just before it turns done).
 */
export function verdictAfterRootChange(
  verdict: HookVerdict | null,
  previous: ProgramState | null,
  next: ProgramState | null,
): { verdict: HookVerdict | null; cleared: boolean } {
  if (verdict && next === 'working' && previous !== 'working') return { verdict: null, cleared: true };
  return { verdict, cleared: false };
}
