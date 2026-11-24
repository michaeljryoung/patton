/**
 * How the usage panel words and colours a reading (components/usage-panel.ts).
 * Pure: no DOM, no window, so the check runs it under plain Node. Times are
 * epoch seconds, shown in local time, 24 h.
 */
import type { PlanUsage, UsageWindow, WeekTokens } from '../../shared/plan-usage';
import { weekEstimate } from '../../shared/token-credit';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Amber from here (Patton's colour-for-meaning rule). */
export const WARN_PCT = 80;
/** Red, and "back" in place of "resets", at this. */
export const FULL_PCT = 100;

/** The percent shown: 100 only when the limit is truly reached (99.6 shows 99). */
export function shownPct(pct: number): number {
  if (pct >= FULL_PCT) return FULL_PCT;
  return Math.max(0, Math.min(FULL_PCT - 1, Math.round(pct)));
}

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

/** A token count, short: "640", "412k", "412M", "2.9 bn" (1 bn and up, one decimal). */
export function formatTokens(n: number): string {
  const v = Math.max(0, n);
  if (v < 1000) return String(Math.round(v));
  if (v < 999_500) return `${Math.round(v / 1e3)}k`;
  if (v < 999_500_000) return `${Math.round(v / 1e6)}M`;
  return `${(v / 1e9).toFixed(1)} bn`;
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

/** The token part of the week's line: "2.9 bn of ~4.6 bn", "1.2 bn" with no estimate, "≥ 412M since Tue 20:22" when partial. */
export function tokenLine(t: WeekTokens, pct: number): string {
  if (!t.complete) return `≥ ${formatTokens(t.tokens)}${t.since !== null ? ` since ${dayTime(t.since)}` : ''}`;
  const estimate = weekEstimate(t, pct, shownPct(pct));
  return estimate === null ? formatTokens(t.tokens) : `${formatTokens(t.tokens)} of ~${formatTokens(estimate)}`;
}

/** The week's whole sub line: "<tokens> · resets Sat 12:00", or the reset alone with no count. */
export function weekSubLine(w: UsageWindow, t: WeekTokens | null | undefined): string {
  const shown = shownTokens(w, t);
  return shown ? `${tokenLine(shown, w.pct)} · ${weekLine(w)}` : weekLine(w);
}

/** The count in full, for the tooltip and accessible name. */
export function tokenDetail(t: WeekTokens, pct: number): string {
  const exact = `${exactTokens(t.tokens)} tokens`;
  if (!t.complete) {
    const since = t.since !== null ? ` since ${dayTime(t.since)}, when the record of which login was live began` : '';
    return `at least ${exact} Claude Code recorded on this login${since}, cached re-reads included`;
  }
  const estimate = weekEstimate(t, pct, shownPct(pct));
  const of = estimate === null ? '' : ` (a whole week ~${exactTokens(estimate)}, from the percent)`;
  return `${exact} Claude Code recorded on this login since the week began, cached re-reads included${of}`;
}
