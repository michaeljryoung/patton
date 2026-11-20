/**
 * The "Okay?" button's decision and its words: whether a pane may be asked
 * "Is everything going okay?" now, and what the button and the announcer say
 * about the result. No DOM, no IPC.
 *
 * Michael, 18 Nov 2026: "Quite often, I find myself wanting to ask a project,
 * 'Is everything going okay?' ... Can we add a button in the bottom left? ...
 * you click it, it says 'Okay?' and prompts with 'Is everything going okay?'"
 *
 * The safety rules are Pause all's, reused (services/pause-all.ts
 * pauseSkipReason): the line is typed and sent only when Claude's root is done,
 * idle after a turn, or mid-turn (Claude Code queues a line typed mid-turn);
 * never while it waits on a permission or question (Enter would answer it),
 * in a menu, in a fresh session, or when the state is unclear. A draft in
 * Claude's input line is stashed with Ctrl+S first and Claude Code restores it.
 */
import { isQueued, pauseSkipReason, PAUSE_SKIP_WORDS, type PauseInput } from './pause-all';
import type { PauseSkipReason, StashKeyVerdict } from '../../shared/types';

/** The line typed into Claude. */
export const OKAY_PROMPT = 'Is everything going okay?';
/** The button at rest. */
export const OKAY_LABEL = 'Okay?';
/** How long the button shows what happened before it goes back to OKAY_LABEL. */
export const OKAY_RESULT_MS = 3000;
/** What the button says when the probes before a send failed (nothing was typed). */
export const OKAY_ERROR_WORDS = "couldn't check, try again";

export type OkayDecision =
  | { kind: 'send'; /** behind a running turn rather than at the prompt */ queued: boolean; /** Ctrl+S first */ stash: boolean }
  | { kind: 'skip'; reason: PauseSkipReason };

/** May the pane be asked now, and how. */
export function okayDecision(input: PauseInput, key: StashKeyVerdict): OkayDecision {
  const reason = pauseSkipReason(input, key);
  if (reason !== null) return { kind: 'skip', reason };
  return { kind: 'send', queued: isQueued(input), stash: input.draft };
}

/** What the button shows for OKAY_RESULT_MS. */
export function okayButtonText(d: OkayDecision): string {
  if (d.kind === 'skip') return PAUSE_SKIP_WORDS[d.reason];
  return d.queued ? 'Queued' : 'Sent';
}

/** A full sentence for the screen-reader announcer. */
export function okayAnnouncement(d: OkayDecision): string {
  if (d.kind === 'skip') return `Not sent: ${PAUSE_SKIP_WORDS[d.reason]}`;
  return d.queued ? `Asked Claude: ${OKAY_PROMPT} (queued behind a running turn)` : `Asked Claude: ${OKAY_PROMPT}`;
}

/** The button is offered only while Claude Code runs in the pane with a live
 *  shell: inside the compose box while the box is engaged, else in its row
 *  under the terminal (D11, components/okay-row.ts). */
export function okayAvailable(claudeActive: boolean, live: boolean): boolean {
  return claudeActive && live;
}
