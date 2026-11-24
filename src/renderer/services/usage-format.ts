/**
 * How the usage panel words and colours a reading (components/usage-panel.ts).
 * Pure: no DOM, no window, so the check runs it under plain Node. Times are
 * epoch seconds, shown in local time, 24 h.
 */
import type { PlanUsage, UsageWindow } from '../../shared/plan-usage';

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
