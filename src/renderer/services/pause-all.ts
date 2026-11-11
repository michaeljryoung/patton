/**
 * "Pause all" for one window: which panes get `pause` typed into them, which
 * are skipped and why, and the line the button and the announcer show. Main
 * runs a press across every window (main/pause-all.ts); this file decides for
 * this window's panes. No DOM, no IPC. Every press pauses every pane that can
 * take it, panes already paused included; nothing is remembered between
 * presses. Resume is typed by hand, tab by tab (no Resume button).
 *
 * The rules (Michael, 10 Nov 2026: a shut MacBook overheated on jobs left
 * running after "pause"; a Claude Code hook acts on a bare `pause`):
 * - Claude's root done, or idle after at least one turn: send.
 * - Claude mid-turn with no background task blocked: send. Claude Code queues
 *   a line typed mid-turn and takes it at its next step (seen 10 Nov:
 *   `enqueue pause` … `absorbed_mid_turn`). Counted as queued.
 * - Claude waiting on a permission, question or login, the root's or a
 *   background task's (7501 `blocked`): skip ('waiting'), Enter would answer it.
 * - A session that has only ever reported idle: skip ('fresh').
 * - The last line submitted began with `/` and no 7501 report or Stop hook
 *   came since: skip ('menu'), a picker may be open where Enter selects.
 * - Claude on the title path (no 7501 reports) that has stopped without a Stop
 *   hook since its last turn: skip ('unclear'); a dialog looks like that there.
 * - No Claude (a plain shell, the `wake` tab), or no live shell: skip.
 * A draft in Claude's input line (main's unsent-input tracker) is stashed
 * with Ctrl+S first, and Claude Code puts it back after the submit. Skipped
 * instead when Ctrl+S isn't the stash key ('draft') or a stash may already be
 * held ('stashed'): Ctrl+S would then overwrite or pop it.
 */
import {
  PAUSE_NAMED_MAX, PAUSE_SKIP_REASONS,
  type PauseAllOutcome, type PauseAllReport, type PauseSkipName, type PauseSkipReason,
  type StashKeyVerdict,
} from '../../shared/types';

/** Claude's root state as its 7501 reports give it. */
export type PauseRootState = 'idle' | 'working' | 'blocked' | 'done' | 'error';

/** What a pane knows that decides whether it gets the word. */
export interface PauseInput {
  /** A shell is attached and hasn't exited. */
  live: boolean;
  /** Claude Code runs here (7501 `app=claude-code`, or a title glyph). */
  claude: boolean;
  /** Where the state comes from: Claude Code's own reports, or its title. */
  source: '7501' | 'title';
  /** The root's 7501 state (null on the title path). */
  root: PauseRootState | null;
  working: boolean;
  /** The root waits on a permission, question or login (7501). */
  blocked: boolean;
  /** A background task waits on one (a 7501 child record `blocked`). */
  taskBlocked: boolean;
  /** Since 7501 reports began the root has been something other than idle. */
  hadTurn: boolean;
  /** Title path: the Stop hook has reported since the last turn and nothing was typed after it. */
  stopSeen: boolean;
  /** A `/` line went in and Claude hasn't reported since. */
  menu: boolean;
  /** Something may be in the input line. */
  draft: boolean;
  /** A stash may already be held: the user pressed Ctrl+S this Claude
   *  session, or Patton did and no line was submitted since. */
  stashed: boolean;
}

/** A pane as Pause all sees it, read once per press. */
export interface PauseTarget {
  readonly id: string;
  /** Its tab's title, for the summary. */
  readonly title: string;
  readonly ptyId: number | null;
  readonly input: PauseInput;
  /** Type `pause` and Enter; with `stash`, Ctrl+S first. */
  send(stash: boolean): void;
}

/** Why the pane gets nothing, or null when it gets the word. */
export function pauseSkipReason(i: PauseInput, key: StashKeyVerdict): PauseSkipReason | null {
  if (!i.live) return 'no-shell';
  if (!i.claude) return 'not-claude';
  if (i.blocked || i.taskBlocked) return 'waiting';
  if (i.menu) return 'menu';
  if (i.source === '7501') {
    if (i.root === 'idle' && !i.hadTurn) return 'fresh';
    if (i.root !== 'done' && i.root !== 'idle' && i.root !== 'working') return 'unclear';
  } else if (!i.working && !i.stopSeen) {
    return 'unclear';
  }
  if (i.draft && !key.ok) return 'draft';
  if (i.draft && i.stashed) return 'stashed';
  return null;
}

/** The word goes in behind a running turn rather than at the prompt. */
function isQueued(i: PauseInput): boolean {
  return i.source === '7501' ? i.root === 'working' : i.working;
}

export function emptyReport(): PauseAllReport {
  const skipped = {} as Record<PauseSkipReason, number>;
  for (const r of PAUSE_SKIP_REASONS) skipped[r] = 0;
  return { sent: 0, queued: 0, skipped, named: [] };
}

/** One window's run: the report for main, and every pane id with what happened, for the log. */
export interface PauseRun {
  report: PauseAllReport;
  sent: string[];
  skipped: { pane: string; reason: PauseSkipReason }[];
}

/** Pause: every pane by the rules; the ones that can take the word get it,
 *  with a draft stashed first. The rest are skipped and counted, and the
 *  Claude ones named in the summary. */
export function runPause(panes: PauseTarget[], key: StashKeyVerdict): PauseRun {
  const out: PauseRun = { report: emptyReport(), sent: [], skipped: [] };
  for (const pane of panes) {
    const reason = pauseSkipReason(pane.input, key);
    if (reason !== null) {
      out.skipped.push({ pane: pane.id, reason });
      out.report.skipped[reason] += 1;
      if (nameable(reason) && out.report.named.length < PAUSE_NAMED_MAX) out.report.named.push({ title: pane.title, reason });
      continue;
    }
    pane.send(pane.input.draft);
    out.sent.push(pane.id);
    out.report.sent += 1;
    if (isQueued(pane.input)) out.report.queued += 1;
  }
  return out;
}

/** Named in the summary: Claude panes left unpaused, not plain shells. */
function nameable(reason: PauseSkipReason): boolean {
  return reason !== 'not-claude' && reason !== 'no-shell';
}

/** Each skip reason in plain words. */
export const PAUSE_SKIP_WORDS: Record<PauseSkipReason, string> = {
  waiting: 'waiting on you',
  menu: 'in a menu?',
  fresh: 'new session',
  draft: 'draft: stash key rebound',
  stashed: 'draft: you have stashed text here',
  unclear: 'state unclear',
  'not-claude': 'not Claude',
  'no-shell': 'shell exited',
};

const sessions = (n: number): string => `${n} Claude session${n === 1 ? '' : 's'}`;

/** The skips the summary counts: Claude panes. */
function countedSkips(o: PauseAllOutcome): PauseSkipReason[] {
  return PAUSE_SKIP_REASONS.filter((r) => o.skipped[r] > 0 && nameable(r));
}

/** The line the button shows for a few seconds and the announcer reads. */
export function pauseSummary(o: PauseAllOutcome): string {
  const parts: string[] = [];
  if (o.sent > 0) {
    const atPrompt = o.sent - o.queued;
    parts.push(`Paused ${sessions(o.sent)} (${atPrompt} at the prompt, ${o.queued} queued behind a running turn)`);
  } else {
    parts.push('Nothing paused');
  }
  const reasons = countedSkips(o);
  const total = reasons.reduce((n, r) => n + o.skipped[r], 0);
  if (total > 0) {
    const named = o.named.slice(0, PAUSE_NAMED_MAX).map((n: PauseSkipName) => `${n.title} (${PAUSE_SKIP_WORDS[n.reason]})`);
    const rest = total - named.length;
    if (rest > 0) named.push(`${rest} more`);
    parts.push(`skipped ${total}: ${named.join(', ')}`);
  } else if (o.sent === 0) {
    parts.push('no Claude session found');
  }
  const silent = o.windows - o.answered;
  if (silent > 0) parts.push(`${silent} window${silent === 1 ? '' : 's'} didn't answer`);
  return parts.join('; ');
}
