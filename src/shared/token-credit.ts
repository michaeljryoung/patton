/**
 * Crediting Claude Code's API requests to the login that made them (pure, no
 * Node or DOM, so the check runs it as it is). Anthropic reports only each
 * login's percent and reset; the token count is ours, read from the
 * transcripts (main/token-scan.ts) and credited by the `switches` timeline the
 * status line's producer keeps in accounts.json: a request belongs to the
 * login live at its time, the last switch at or before it. Requests before the
 * first switch belong to no one. Times are epoch seconds.
 */
import { shownPct, type LoginSwitch, type NoEstimateReason, type WeekEstimate, type WeekTokens } from './plan-usage';

export const DAY_S = 24 * 60 * 60;
/** A weekly window starts this long before its reset. */
export const WEEK_S = 7 * DAY_S;
/** Transcripts and requests older than this are never read or kept. */
export const TOKEN_HORIZON_S = 8 * DAY_S;
/** A complete count's estimate needs this percent shown (below, it is noise). */
export const ESTIMATE_MIN_PCT = 5;
/** A rate's estimate needs this many points of rise since the count began: percents are whole numbers, so a 5-point rise can be up to about 20% wrong. */
export const ESTIMATE_MIN_RISE = 10;

/** One login's current week: requests at or after `start` and before `end` (its reset) count. */
export interface TokenWindow {
  id: string;
  start: number;
  end: number;
}

/** One API request: its time and its tokens. */
export interface TokenRequest {
  t: number;
  n: number;
}

/** The login live at `t` (the last switch at or before it), or null before the first switch. */
export function liveAt(switches: readonly LoginSwitch[], t: number): string | null {
  let lo = 0;
  let hi = switches.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (switches[mid][0] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? null : switches[found][1];
}

/** Each window's tokens: every request credited to the login live at its time, counted when it
 *  falls in that login's window. Every window's login is in the result, 0 when nothing counted. */
export function creditTokens(requests: Iterable<TokenRequest>, switches: readonly LoginSwitch[], windows: readonly TokenWindow[]): Map<string, number> {
  const totals = new Map<string, number>();
  const byId = new Map<string, TokenWindow>();
  for (const w of windows) {
    byId.set(w.id, w);
    totals.set(w.id, 0);
  }
  if (switches.length === 0 || byId.size === 0) return totals;
  for (const r of requests) {
    const id = liveAt(switches, r.t);
    if (id === null) continue;
    const w = byId.get(id);
    if (!w || r.t < w.start || r.t >= w.end) continue;
    totals.set(id, (totals.get(id) ?? 0) + r.n);
  }
  return totals;
}

/** A window's count as shown: complete when the timeline covers the whole week, else partial
 *  from the first switch. */
export function weekTokens(tokens: number, w: TokenWindow, switches: readonly LoginSwitch[]): WeekTokens {
  const first = switches.length > 0 ? switches[0][0] : null;
  const complete = first !== null && first <= w.start;
  return { tokens, complete, since: complete ? null : first, resetsAt: w.end };
}

/** The earliest time worth reading (epoch seconds), or null when no request can count (no
 *  switches or no window): the later of the horizon and the earliest time any window's
 *  login can be credited (the first switch, or the earliest window's start if later). */
export function scanFloor(switches: readonly LoginSwitch[], windows: readonly TokenWindow[], now: number): number | null {
  if (switches.length === 0 || windows.length === 0) return null;
  let earliestStart = Infinity;
  for (const w of windows) earliestStart = Math.min(earliestStart, w.start);
  return Math.max(now - TOKEN_HORIZON_S, switches[0][0], earliestStart);
}

/** The week's use and allowance, guessed from the count and the percent (`pct`, the week's
 *  percent now), and when there is none, why. A complete count (the whole week): allowance =
 *  tokens ÷ pct × 100 and used = tokens, from 5% shown. A partial count (from `since`): with `p0`
 *  the week's percent at `since` (seven-day-log.ts pctAt), allowance = tokens ÷ (pct − p0) × 100
 *  and used = pct × the allowance, once the week rose at least 10 points since. Not rounded: the
 *  words round both figures. `why` is null with an estimate (or when `pct` is not a number). */
export function estimateWeek(t: WeekTokens, pct: number, p0: number | null): { estimate: WeekEstimate | null; why: NoEstimateReason | null } {
  if (!(t.tokens > 0)) return { estimate: null, why: 'none-counted' };
  if (!Number.isFinite(pct)) return { estimate: null, why: null };
  if (t.complete) {
    if (shownPct(pct) < ESTIMATE_MIN_PCT || !(pct > 0)) return { estimate: null, why: 'low-pct' };
    return { estimate: { method: 'complete', used: t.tokens, allowance: (t.tokens / pct) * 100, p0: null, pct }, why: null };
  }
  if (p0 === null || !Number.isFinite(p0)) return { estimate: null, why: 'no-reading' };
  const rise = pct - p0;
  if (!(rise >= ESTIMATE_MIN_RISE)) return { estimate: null, why: 'small-rise' };
  const allowance = (t.tokens / rise) * 100;
  return { estimate: { method: 'rate', used: (pct / 100) * allowance, allowance, p0, pct }, why: null };
}

/** The estimate alone (null with none). */
export function weekEstimate(t: WeekTokens, pct: number, p0: number | null): WeekEstimate | null {
  return estimateWeek(t, pct, p0).estimate;
}
