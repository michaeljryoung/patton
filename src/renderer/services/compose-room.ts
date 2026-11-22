/**
 * How many whole rows the terminal gives up at its bottom so a long draft in
 * the compose box grows DOWN rather than over Claude's newest output
 * (docs/compose-box.md, Design D15). No DOM: Pane measures and applies.
 *
 * The box's top edge stays on the top of row R-1 ('over') or of the third row
 * up from the terminal's bottom ('dock'). It grows down, first over the
 * terminal rows below Claude's bar (its footer, blank rows; none in 'dock'),
 * then into rows the terminal gives up:
 *   k = rows the box needs, less the bar's three, less the rows below the bar,
 * never below 0. The box's need is capped at a third of the pane (past that
 * the text scrolls inside), so k is too.
 *
 * Pane works k out only when the box's content height or its placement
 * changes, never from a reading of Claude's bar alone: after the resize,
 * Claude redraws its bar k rows higher, and that redraw must not feed back.
 */
import { COMPOSE_OVERLAY_MAX_FRACTION, type ComposePlacement } from './compose-placement';

/** A need this close (px) to a whole number of rows takes no extra row. */
export const COMPOSE_ROOM_SLACK_PX = 1;

export interface RoomFacts {
  placement: ComposePlacement;
  /** The draft is one line (k is 0 then, whatever its height). */
  oneLine: boolean;
  /** The box's natural height (px): its contents uncapped, plus its chrome. */
  neededPx: number;
  /** xterm's cell height (px). */
  cellH: number;
  /** The pane's height (px): the cap is a third of it. */
  paneH: number;
  /** In 'over': the terminal rows below row R+1 as the terminal stands now
   *  (rows already given up are not terminal rows). Ignored in 'dock'. */
  rowsBelowBar: number;
}

export function composeRoomRows(f: RoomFacts): number {
  if (f.placement === 'under' || f.oneLine) return 0;
  if (!(f.cellH > 0) || !(f.paneH > 0) || !(f.neededPx > 0)) return 0;
  const capPx = Math.floor(f.paneH * COMPOSE_OVERLAY_MAX_FRACTION);
  const needPx = Math.min(f.neededPx, capPx);
  const needRows = Math.ceil(Math.max(0, needPx - COMPOSE_ROOM_SLACK_PX) / f.cellH);
  const below = f.placement === 'over' ? Math.max(0, Math.floor(f.rowsBelowBar)) : 0;
  return Math.max(0, needRows - 3 - below);
}
