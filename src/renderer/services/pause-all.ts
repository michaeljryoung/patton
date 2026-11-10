/**
 * "Pause all" for one window: which panes get `pause` (later `resume`) typed
 * into them, which are skipped and why, and the line the button and the
 * announcer show. Main runs a press across every window (main/pause-all.ts);
 * this file decides for this window's panes. No DOM, no IPC.
 *
 * The rules (Michael, 10 Nov 2026: a shut MacBook overheated on jobs left
 * running after "pause"; a Claude Code hook acts on a bare `pause` / `resume`):
 * - Claude idle or done at its prompt: send.
 * - Claude mid-turn: send. Claude Code queues a line typed mid-turn and takes
 *   it at its next step (seen 10 Nov: `enqueue pause` … `absorbed_mid_turn`).
 * - Claude waiting on a permission, question or login, the root's or a
 *   background task's (7501 `blocked`): skip, since Enter would answer it.
 * - Claude on the title path (no 7501 reports) that has stopped without a Stop
 *   hook since its last turn: skip. That is how a dialog looks there
 *   (checkpointReady treats it the same), and a fresh session looks alike.
 * - No Claude (a plain shell, the `wake` tab), or no live shell: skip.
 * A draft half-typed in Claude's input line is not seen (Patton can't read
 * it): the word is appended to it, as with the checkpoint clock's
 * /checkpoint. Nothing erases it.
 */
import {
  PAUSE_SKIP_REASONS,
  type PauseAllAction, type PauseAllOutcome, type PauseAllReport, type PauseSkipReason,
} from '../../shared/types';

/** What a pane knows that decides whether it gets the word. */
export interface PauseInput {
  /** A shell is attached and hasn't exited. */
  live: boolean;
  /** Claude Code runs here (7501 `app=claude-code`, or a title glyph). */
  claude: boolean;
  /** Where the state comes from: Claude Code's own reports, or its title. */
  source: '7501' | 'title';
  working: boolean;
  /** The root waits on a permission, question or login (7501). */
  blocked: boolean;
  /** A background task waits on one (a 7501 child record `blocked`). */
  taskBlocked: boolean;
  /** Title path: the Stop hook has reported since the last turn began. */
  stopSeen: boolean;
}

/** A pane as Pause all sees it. */
export interface PauseTarget {
  readonly id: string;
  readonly pauseInput: PauseInput;
  /** Type the word and Enter through the compose box's submit path. */
  typePauseWord(word: PauseAllAction): void;
}

/** Why the pane gets nothing, or null when it gets the word. */
export function pauseSkipReason(i: PauseInput): PauseSkipReason | null {
  if (!i.live) return 'no-shell';
  if (!i.claude) return 'not-claude';
  if (i.blocked || i.taskBlocked) return 'waiting';
  if (i.source === 'title' && !i.working && !i.stopSeen) return 'unclear';
  return null;
}

export function emptyReport(): PauseAllReport {
  const skipped = {} as Record<PauseSkipReason, number>;
  for (const r of PAUSE_SKIP_REASONS) skipped[r] = 0;
  return { sent: 0, skipped };
}

/** One window's run: the report for main, and every pane id with what happened, for the log. */
export interface PauseRun {
  report: PauseAllReport;
  sent: string[];
  skipped: { pane: string; reason: PauseSkipReason }[];
}

/** The panes this window paused, so resume goes to exactly those. */
export class PauseAllState {
  private paused = new Set<string>();

  get pausedIds(): string[] {
    return Array.from(this.paused);
  }

  /** Pause: every pane by the rules; the ones sent to become the paused set.
   *  Resume: only the paused panes still open, by the same rules at this
   *  moment; the set empties either way (the button goes back to Pause all). */
  run(action: PauseAllAction, panes: PauseTarget[]): PauseRun {
    const out: PauseRun = { report: emptyReport(), sent: [], skipped: [] };
    let targets = panes;
    if (action === 'resume') {
      targets = panes.filter((p) => this.paused.has(p.id));
      for (const id of this.paused) {
        if (!panes.some((p) => p.id === id)) {
          out.skipped.push({ pane: id, reason: 'closed' });
          out.report.skipped.closed += 1;
        }
      }
    }
    for (const pane of targets) {
      const reason = pauseSkipReason(pane.pauseInput);
      if (reason === null) {
        pane.typePauseWord(action);
        out.sent.push(pane.id);
        out.report.sent += 1;
      } else {
        out.skipped.push({ pane: pane.id, reason });
        out.report.skipped[reason] += 1;
      }
    }
    this.paused = action === 'pause' ? new Set(out.sent) : new Set();
    return out;
  }
}

const sessions = (n: number): string => `${n} Claude session${n === 1 ? '' : 's'}`;

/** The line the button shows for a few seconds and the announcer reads. */
export function pauseSummary(o: PauseAllOutcome): string {
  const parts: string[] = [];
  const verb = o.action === 'pause' ? 'Paused' : 'Resumed';
  parts.push(o.sent > 0 ? `${verb} ${sessions(o.sent)}` : `Nothing ${o.action === 'pause' ? 'paused' : 'resumed'}`);
  if (o.skipped.waiting > 0) {
    parts.push(o.action === 'resume'
      ? `${o.skipped.waiting} waiting on you: type resume there`
      : `skipped ${o.skipped.waiting} waiting on you`);
  }
  if (o.skipped.unclear > 0) parts.push(`skipped ${o.skipped.unclear} whose state is unclear`);
  if (o.skipped.closed > 0) parts.push(`${o.skipped.closed} closed since`);
  if (o.action === 'pause' && o.sent === 0 && o.skipped.waiting === 0 && o.skipped.unclear === 0) {
    parts.push('no Claude session found');
  }
  const silent = o.windows - o.answered;
  if (silent > 0) parts.push(`${silent} window${silent === 1 ? '' : 's'} didn't answer`);
  return parts.join(', ');
}
