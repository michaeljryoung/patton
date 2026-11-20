/**
 * When the compose box under a Claude Code pane steps aside, and where the
 * keyboard goes as it comes back (docs/compose-box.md, Design D2 and D3). No
 * DOM, no timers: Pane owns the 250 ms timer and the focus moves, and asks
 * these rules what to do, so a check can drive them headlessly.
 *
 * - 'blocked' (D2): Claude's 7501 root is `blocked` (any kind), or a background
 *   task's record is (Pause all's `taskBlocked`), and that has held
 *   COMPOSE_ASIDE_HOLD_MS. A shorter spell changes nothing.
 * - 'menu' (D3): the box sent a line beginning with `/` (his own send, never
 *   Patton's own typing) and no 7501 report or Stop hook has come since, the
 *   rule Pause all's `menu` fact uses: a picker such as /model may be open.
 * The box is dimmed, its draft kept, and the keyboard goes to the terminal
 * (for 'blocked', only once the box has had no keydown for
 * COMPOSE_TYPING_GRACE_MS, so a word being typed is never cut in two, and
 * never later than COMPOSE_TYPING_GRACE_MAX_MS after the aside began).
 */
import type { BlockedKind, ProgramRecord } from './program-status';

export type ComposeAsideReason = 'blocked' | 'menu';

/** How long Claude must stay blocked before the box steps aside. */
export const COMPOSE_ASIDE_HOLD_MS = 250;

/** While the box has had a keydown this recently, a 'blocked' aside dims it
 *  at once but leaves the keyboard in it until it has been quiet this long. */
export const COMPOSE_TYPING_GRACE_MS = 1000;

/** However steady his typing, a 'blocked' aside moves the keyboard at most
 *  this long after it began (keys hammered into the dimmed box never keep it). */
export const COMPOSE_TYPING_GRACE_MAX_MS = 3000;

/** The full words while the box is aside: the label's title, and what the
 *  live region announces. */
export const COMPOSE_ASIDE_HINT: Readonly<Record<ComposeAsideReason, string>> = {
  blocked: 'Claude is asking you something above · your draft is kept',
  menu: 'Claude may be showing a menu above · click the box to type here',
};

/** The short label in the Send button's slot while the box is aside. */
export const COMPOSE_ASIDE_LABEL: Readonly<Record<ComposeAsideReason, string>> = {
  blocked: 'Answer above',
  menu: 'Menu above',
};

/** Enter (or Send) in a box while Claude asks sends nothing, from the first
 *  report on (the 250 ms hold or not): the label
 *  reads this for COMPOSE_SEND_HELD_MS and the draft stays. */
export const COMPOSE_SEND_HELD_LABEL = 'Answer above first';
export const COMPOSE_SEND_HELD_MS = 1500;

/** How long a 'blocked' aside waits before moving the keyboard to the
 *  terminal: 0 unless the box has it and had a keydown within
 *  COMPOSE_TYPING_GRACE_MS, else what is left of that grace, never past
 *  COMPOSE_TYPING_GRACE_MAX_MS from `asideAtMs` (when the aside began). */
export function composeKeyboardWaitMs(
  boxHasKeyboard: boolean, nowMs: number, lastBoxKeydownMs: number, asideAtMs: number,
): number {
  if (!boxHasKeyboard || lastBoxKeydownMs <= 0) return 0;
  const until = Math.min(lastBoxKeydownMs + COMPOSE_TYPING_GRACE_MS, asideAtMs + COMPOSE_TYPING_GRACE_MAX_MS);
  const left = until - nowMs;
  return left > 0 ? left : 0;
}

/** Whether Claude waits on him: the root, else the first background task,
 *  `blocked`; `kind` is that record's (permission, question, auth or null). */
export function composeBlockedFact(
  root: ProgramRecord | null,
  children: readonly { record: ProgramRecord }[],
): { blocked: boolean; kind: BlockedKind | null } {
  if (root?.state === 'blocked') return { blocked: true, kind: root.kind };
  const child = children.find((c) => c.record.state === 'blocked');
  if (child) return { blocked: true, kind: child.record.kind };
  return { blocked: false, kind: null };
}

export interface ComposeAsideFacts {
  /** The box is open because Claude Code runs here (compose box engaged). */
  engaged: boolean;
  /** composeBlockedFact(...).blocked, on a pane with 7501 reports. */
  blocked: boolean;
  /** blocked has held COMPOSE_ASIDE_HOLD_MS without a break. */
  blockedHeld: boolean;
  /** A `/` line went from the box and no report or Stop hook came since. */
  menuPending: boolean;
  /** The aside in force now, if any. */
  current: ComposeAsideReason | null;
}

/** Which aside applies now, or null for the box in place. A box already
 *  aside for a menu turns to 'blocked' at once when Claude asks, rather than
 *  coming back for the 250 ms hold and stepping aside again. */
export function composeAsideReason(f: ComposeAsideFacts): ComposeAsideReason | null {
  if (!f.engaged) return null;
  if (f.blocked && (f.blockedHeld || f.current !== null)) return 'blocked';
  if (f.menuPending) return 'menu';
  return null;
}

/** A slash command: `/name` (letters, digits, _, : and -) then a space or
 *  the end. A path such as /Users/me/x.png is not one. */
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(\s|$)/;

/** A line sent from the box that may open a picker in Claude Code: its
 *  first line, trimmed, is a slash command. */
export function isMenuLine(command: string): boolean {
  const first = command.trimStart().split(/\r\n|\r|\n/)[0].trim();
  return SLASH_COMMAND.test(first);
}

/** Where the keyboard is as the box comes back. */
export interface ComposeFocusFacts {
  /** This pane's terminal (not its search bar) has the keyboard. */
  terminalHasFocus: boolean;
  /** Nothing in the window has it (the body). */
  nothingFocused: boolean;
  /** This is its tab's focused pane. */
  paneFocused: boolean;
  /** A dialog, the search bar or another overlay has it. */
  overlayFocused: boolean;
}

/** Whether the box takes the keyboard back as it comes back: only from this
 *  pane's terminal or from nowhere, never from a panel, dialog or another
 *  pane. */
export function composeBackTakesKeyboard(f: ComposeFocusFacts): boolean {
  if (f.overlayFocused) return false;
  if (f.terminalHasFocus) return true;
  return f.nothingFocused && f.paneFocused;
}
