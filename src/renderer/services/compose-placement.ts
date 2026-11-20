/**
 * Where the compose box sits under a Claude Code tab (docs/compose-box.md,
 * Design D9, D10, D12). No DOM, no timers: Pane takes the readings
 * (services/claude-bar.ts), owns the 400 ms lost timer and the layout, and
 * asks these rules what a reading means.
 *
 * - 'over': Claude's bar is found and empty and its three rows are all in the
 *   viewport. The box lies over those rows, an overlay on the terminal.
 * - 'dock': found and empty, but scrolled up so its rows aren't all in view.
 *   The same overlay on the terminal's bottom edge.
 * - 'under': the bar is lost (no match for COMPOSE_BAR_LOST_MS) or holds
 *   text, the setting is off, the keyboard is handed to Claude's own bar, or
 *   no reading has matched yet. The box sits under the terminal in the flow
 *   (the v1.31 layout).
 * While Claude asks (the live 7501 `blocked` fact) or the box is aside,
 * placement is frozen: Pane takes no readings (D10).
 */
import type { ClaudeBarReading } from './claude-bar';

export type ComposePlacement = 'over' | 'dock' | 'under';

/** Why the placement changed, as logged on `[COMPOSE] place`. `disengage`
 *  (the box closed or Claude left) resets a closed box to `under`. */
export type ComposePlacementReason =
  | 'found' | 'scrolled' | 'in-view' | 'holds-text' | 'lost' | 'handoff' | 'setting' | 'aside-end' | 'disengage';

/** A bar not matched this long counts as lost (D8: 4 of 26 real output
 *  bursts ended mid-redraw, so one bad reading must not move the box). */
export const COMPOSE_BAR_LOST_MS = 400;

/** `[COMPOSE] bar not found` at most this often per pane. */
export const COMPOSE_BAR_NOT_FOUND_LOG_MS = 60_000;

/** The overlays grow upward to at most this share of the pane's height. */
export const COMPOSE_OVERLAY_MAX_FRACTION = 1 / 3;

/** The bar's three rows (R−1 to R+1, absolute) all lie in the viewport. */
export function barRowsInView(row: number, viewportY: number, rows: number): boolean {
  return row - 1 >= viewportY && row + 1 <= viewportY + rows - 1;
}

export interface PlacementFacts {
  /** The `composeOverBar` setting, read `!== false`. */
  overSetting: boolean;
  /** The keyboard is handed to Claude's own bar (Esc with a draft). */
  handedOff: boolean;
  reading: ClaudeBarReading;
  /** For a found bar: its three rows are in the viewport. */
  inView: boolean;
  current: ComposePlacement;
}

/** What one reading means: a new placement and its reason, or null when the
 *  reading didn't match (the last good position is kept; Pane's lost timer
 *  decides whether it goes under). */
export function placementForReading(
  f: PlacementFacts,
): { placement: ComposePlacement; reason: ComposePlacementReason } | null {
  if (!f.overSetting) return { placement: 'under', reason: 'setting' };
  if (f.handedOff) return { placement: 'under', reason: 'handoff' };
  const r = f.reading;
  if (!r.found) return null;
  if (!r.empty) return { placement: 'under', reason: 'holds-text' };
  const placement: ComposePlacement = f.inView ? 'over' : 'dock';
  if (f.current === 'under') return { placement, reason: 'found' };
  return { placement, reason: placement === 'dock' ? 'scrolled' : 'in-view' };
}
