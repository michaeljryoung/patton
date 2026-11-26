/**
 * How the usage panel words and colours a reading (components/usage-panel.ts).
 * Pure: no DOM, no window, so the check runs it under plain Node. Times are
 * epoch seconds, shown in local time, 24 h.
 */
import { FULL_PCT, shownPct, type PlanUsage, type UsageWindow, type WeekEstimate, type WeekTokens } from '../../shared/plan-usage';
import { WEEK_S } from '../../shared/token-credit';

export { FULL_PCT, shownPct };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Amber from here (Patton's colour-for-meaning rule). */
export const WARN_PCT = 80;

/** 'full' at 100%, 'warn' from 80%, else ''. Follows the percent as shown: 79.5 shows 80% and is amber. */
export function usageLevel(pct: number): '' | 'warn' | 'full' {
  const shown = shownPct(pct);
  if (shown >= FULL_PCT) return 'full';
  if (shown >= WARN_PCT) return 'warn';
  return '';
}

/** "20:23". */
export function clockTime(sec: number): string {
  const d = new Date(sec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Sat 12:00". */
export function dayTime(sec: number): string {
  return `${WEEKDAYS[new Date(sec * 1000).getDay()]} ${clockTime(sec)}`;
}

/** The week's sub line: "resets Sat 12:00", "back Sat 08:00" at 100%, "reset Sat 08:00" once passed. */
export function weekLine(w: UsageWindow): string {
  if (w.passed) return `reset ${dayTime(w.resetsAt)}`;
  if (w.pct >= FULL_PCT) return `back ${dayTime(w.resetsAt)}`;
  return `resets ${dayTime(w.resetsAt)}`;
}

/** The newest reading time of any window of any login, or null. */
export function newestRead(usage: PlanUsage): number | null {
  let newest: number | null = null;
  for (const a of usage.accounts) {
    for (const w of [a.week, a.fiveHour]) {
      if (w?.readAt != null && (newest === null || w.readAt > newest)) newest = w.readAt;
    }
  }
  return newest;
}

/** The unit a token figure is shown in: as `formatTokens` picks it, by the figure's size. */
function tokenUnit(n: number): { div: number; suffix: string } {
  if (n < 999.5) return { div: 1, suffix: '' };
  if (n < 999_500) return { div: 1e3, suffix: 'k' };
  if (n < 999_500_000) return { div: 1e6, suffix: 'M' };
  return { div: 1e9, suffix: ' bn' };
}

/** A token count, short: "640", "412k", "412M", "2.9 bn" (1 bn and up, one decimal). */
export function formatTokens(n: number): string {
  const v = Math.max(0, n);
  const { div, suffix } = tokenUnit(v);
  if (div === 1) return String(Math.round(v));
  if (div < 1e9) return `${Math.round(v / div)}${suffix}`;
  return `${(v / 1e9).toFixed(1)}${suffix}`;
}

/** `x` to 2 significant figures, written out: "5.7", "0.41", "410", "0". */
function twoFigures(x: number): string {
  const v = Number(Math.max(0, x).toPrecision(2));
  if (v === 0) return '0';
  return v.toFixed(Math.max(0, 1 - Math.floor(Math.log10(v))));
}

/** Used and allowance in the allowance's unit, both to 2 significant figures: "1.9 of 5.7 bn", "0.41 of 4.6 bn", "410 of 800M". */
export function tokenPair(used: number, allowance: number): string {
  const whole = Number(Math.max(0, allowance).toPrecision(2));
  const { div, suffix } = tokenUnit(whole);
  return `${twoFigures(used / div)} of ${twoFigures(whole / div)}${suffix}`;
}

/** The count with thousands separators: "2,912,345,678". */
export function exactTokens(n: number): string {
  return Math.round(Math.max(0, n)).toLocaleString('en-GB');
}

/** The count that belongs on this week's line, or null: none on a passed week or one counted for another week. */
export function shownTokens(w: UsageWindow | null, t: WeekTokens | null | undefined): WeekTokens | null {
  if (!w || w.passed || !t || t.resetsAt !== w.resetsAt || !Number.isFinite(t.tokens)) return null;
  return t;
}

/** The count's estimate, when it has one with figures worth drawing. */
function shownEstimate(t: WeekTokens): WeekEstimate | null {
  const e = t.estimate ?? null;
  if (e === null || !Number.isFinite(e.used) || !Number.isFinite(e.allowance) || !(e.allowance > 0)) return null;
  return e;
}

/** The token part of the week's line, "1.9 of 5.7 bn", or null with no estimate (the line is then the reset alone). */
export function tokenLine(t: WeekTokens): string | null {
  const e = shownEstimate(t);
  return e === null ? null : tokenPair(e.used, e.allowance);
}

/** The week's sub line in its two parts, so a narrow sidebar wraps only between them: the token
 *  part with its "·" (null with no estimate to show), and the reset. */
export function weekSubParts(w: UsageWindow, t: WeekTokens | null | undefined): { tokens: string | null; reset: string } {
  const shown = shownTokens(w, t);
  const line = shown ? tokenLine(shown) : null;
  return { tokens: line === null ? null : `${line} ·`, reset: weekLine(w) };
}

/** The week's whole sub line: "1.9 of 5.7 bn · resets Sat 12:00", or the reset alone with no estimate. */
export function weekSubLine(w: UsageWindow, t: WeekTokens | null | undefined): string {
  const { tokens, reset } = weekSubParts(w, t);
  return tokens === null ? reset : `${tokens} ${reset}`;
}

/** The estimate in words, saying it is one and what it comes from: "about 5.6 of 5.7 bn tokens this
 *  week, estimated from 2.1 bn counted since Tue 20:22 while the week rose from 61% to 97%". Null with none. */
export function estimateDetail(t: WeekTokens): string | null {
  const e = shownEstimate(t);
  if (e === null) return null;
  const from = e.method === 'rate' && e.p0 !== null
    ? `counted since ${t.since !== null ? dayTime(t.since) : 'the record of which login was live began'} while the week rose from ${shownPct(e.p0)}% to ${shownPct(e.pct)}%`
    : `counted this week at ${shownPct(e.pct)}%`;
  return `about ${tokenPair(e.used, e.allowance)} tokens this week, estimated from ${formatTokens(t.tokens)} ${from}`;
}

/** The count in full, for the tooltip and accessible name: the estimate and what it comes from, or the
 *  count alone when there is too little to estimate from. The count is the tokens Claude Code recorded
 *  while this login was live by the status line's login record, which can be off around a switch (see
 *  docs/reference/key-files.md, Plan usage). */
export function tokenDetail(t: WeekTokens): string {
  const counted = t.complete
    ? `from ${dayTime(t.resetsAt - WEEK_S)}`
    : t.since !== null ? `from ${dayTime(t.since)}, when the record of which login was live began` : 'from when the record of which login was live began';
  const head = estimateDetail(t)
    ?? `${exactTokens(t.tokens)} tokens counted, too few to estimate the week from`;
  const when = t.countedAt != null && Number.isFinite(t.countedAt) ? `; tokens counted at ${clockTime(t.countedAt)}` : '';
  return `${head}; the count is what Claude Code recorded while this login was live (${counted}), approximate around switches, cached re-reads included${when}`;
}
