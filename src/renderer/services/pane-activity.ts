/**
 * One word for what a pane is doing, from its Claude Code state: the reading
 * the tab hover card shows, and the thing whose change restarts the pane's
 * "for how long" clock (`Pane.claudeState.since`). Pure: no DOM, no IPC.
 */
import type { ProgramState } from './program-status';

export type PaneActivity =
  | 'shell'    // no Claude Code running here
  | 'working'  // mid-turn
  | 'blocked'  // a permission, question, login or dialog (or a background task asking)
  | 'error'    // Claude stopped on an error (7501)
  | 'parked'   // stopped, waiting on its own background work
  | 'waiting'  // stopped: waiting for you
  | 'idle';    // 7501 `idle`: never ran, or interrupted

/** The parts of a pane's Claude state the activity depends on. */
export interface ActivityInput {
  active: boolean;
  working: boolean;
  blocked: boolean;
  /** The 7501 root state, null on the title path. */
  root: ProgramState | null;
  /** True once the pane has had a 7501 report (title path otherwise). */
  reporting: boolean;
  parked: boolean;
  /** A 7501 child task is blocked on input. */
  taskBlocked: boolean;
}

/** Same precedence as the dot: whatever needs you wins over parked or idle. */
export function paneActivity(s: ActivityInput): PaneActivity {
  if (!s.active) return 'shell';
  if (s.root === 'error') return 'error';
  if (s.blocked || s.taskBlocked) return 'blocked';
  if (s.working) return 'working';
  if (s.parked) return 'parked';
  // The title path knows only busy or stopped; a stopped Claude waits for you.
  if (s.reporting && s.root !== 'done') return 'idle';
  return 'waiting';
}
