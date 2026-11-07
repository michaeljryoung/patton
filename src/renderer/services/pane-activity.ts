/**
 * One word for what a pane is doing, from its Claude Code state: the reading
 * the tab hover card shows, and the thing whose change restarts the pane's
 * "for how long" clock (`Pane.claudeState.since`). Pure: no DOM, no IPC.
 */
import type { ProgramStanding } from './program-status';

export type PaneActivity =
  | 'shell'    // no Claude Code running here
  | 'working'  // mid-turn
  | 'blocked'  // a permission, question, login or dialog (or a background task asking)
  | 'error'    // Claude stopped on an error (7501)
  | 'parked'   // stopped, waiting on its own background work
  | 'waiting'  // stopped: waiting for you
  | 'idle';    // 7501 `idle`: never ran, or interrupte/** The parts of a pane's Claude state the activity depends on. */
export interface ActivityInput {
  /** Claude Code, or another program reporting OSC 7501, runs here. */
  active: boolean;
  working: boolean;
  /** The pane's 7501 records ranked (rankProgram), null on the title path. */
  standing: ProgramStanding['kind'] | null;
  parked: boolean;
}

/** Same precedence as the dot: on the 7501 path it is rankProgram's, the one
 *  programSignal reads, so the card and the dot never disagree. */
export function paneActivity(s: ActivityInput): PaneActivity {
  if (!s.active) return 'shell';
  switch (s.standing) {
    case 'working': return 'working';
    case 'blocked':
    case 'task-blocked': return 'blocked';
    case 'error': return 'error';
    case 'parked': return 'parked';
    // A cron-only turn end parks the pane on the Stop hook's word (pane.ts).
    case 'done': return s.parked ? 'parked' : 'waiting';
    case 'idle': return s.parked ? 'parked' : 'idle';
    case null: break;
  }
  // The title path knows only busy or stopped; a stopped Claude waits for you.
  if (s.working) return 'working';
  if (s.parked) return 'parked';
  return 'waiting';
}
