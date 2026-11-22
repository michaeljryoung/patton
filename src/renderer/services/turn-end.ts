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

/**
 * The stored verdict after the working 7501 child records changed under the
 * root. A root that is done with children working is parked by 7501 itself;
 * when the last of them finishes (> 0 to 0) the old verdict must not re-park
 * the pane, or the S40 alert "the background work ended" never fires. The hook
 * counted what ran when the turn closed, which this drain has outlived. Under
 * a root that is not done (the hook speaks mid-turn) the verdict is kept.
 */
export function verdictAfterChildren(
  verdict: HookVerdict | null,
  rootState: ProgramState | null,
  previousWorking: number,
  nextWorking: number,
): { verdict: HookVerdict | null; cleared: boolean } {
  if (verdict && rootState === 'done' && previousWorking > 0 && nextWorking === 0) return { verdict: null, cleared: true };
  return { verdict, cleared: false };
}

/**
 * Claude Code 2.1.321 keeps its root `working` after a turn has ended while a
 * subagent it launched still runs: no `done` comes until the subagent's
 * `<task-notification>` starts the next turn (22 Nov 2026, House tab: Stop
 * hook at 19:37:51 with 1 task, root `working` with 1 child throughout, next
 * report 19:39:06 `working`, 0 children). Background shells don't do this
 * (the genome tab got its `done`). So a Stop verdict that lands while the root
 * works with working children marks the turn as ended, and the pane is parked
 * as if 7501 had said done with those children working.
 *
 * Whether a Stop over a working root marks the turn ended: the hook spoke and
 * 7501 shows at least one working child under it. With no working child the
 * verdict is only stored, as before (the done that normally follows decides).
 */
export function turnEndedOverWork(rootState: ProgramState | null, workingChildren: number): boolean {
  return rootState === 'working' && workingChildren > 0;
}

/**
 * Whether an ended-turn mark survives a 7501 change. Anything but the same
 * working root over the same number of working children means a new turn (or
 * a real turn end, which 7501 then reports itself): the root leaving `working`,
 * or a working child added (only a turn launches one) or finished (Claude
 * takes its notification into a new turn, as at 19:39:06).
 */
export function turnEndedAfterChange(
  ended: boolean,
  previousRoot: ProgramState | null,
  nextRoot: ProgramState | null,
  previousWorking: number,
  nextWorking: number,
): boolean {
  if (!ended) return false;
  return previousRoot === 'working' && nextRoot === 'working' && previousWorking === nextWorking && nextWorking > 0;
}

/**
 * The signal while a turn is marked ended over a working root: the ring, with
 * the larger of the hook's task count and the working children, the hook's
 * timers, and the children's titles. Any other signal passes through.
 */
export function endedTurnSignal(
  signal: ProgramSignal,
  ended: boolean,
  verdict: HookVerdict | null,
  workingTitles: string[],
): { signal: ProgramSignal; viaStop: boolean } {
  if (!ended || signal.kind !== 'working' || workingTitles.length === 0) return { signal, viaStop: false };
  return {
    signal: {
      kind: 'parked',
      tasks: Math.max(verdict?.tasks ?? 0, workingTitles.length),
      crons: verdict?.crons ?? 0,
      titles: workingTitles,
    },
    viaStop: true,
  };
}

/**
 * Whether a line sent to Claude may run without a turn: a slash command
 * (`/usage`, `/context` run locally and no Stop follows) or a bash-mode `!`
 * line. Such a send leaves the turn-end ring up; if it does start a turn (a
 * skill, a prompt command), the transcript feed's first assistant line clears
 * the ring instead.
 */
export function mayRunLocally(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('/') || t.startsWith('!');
}

/**
 * Whether a blocked Stop the transcript feed reported belongs to the Stop
 * verdict landing now: a fast blocking hook (the closing-block gate) writes its
 * line ~120 ms before Patton's own verdict reaches the pane (21 Nov 08:28:05,
 * 22 Nov 06:59:30), so the feed can report it first. It counts when its line
 * is at most `slackMs` older than this verdict and newer than the previous
 * verdict (an older block was that Stop's).
 */
export function blockedBeforeVerdict(
  blockedAt: number | null,
  verdictAtMs: number,
  previousVerdictAtMs: number,
  slackMs: number,
): boolean {
  if (blockedAt === null) return false;
  return blockedAt >= verdictAtMs - slackMs && blockedAt > previousVerdictAtMs;
}
