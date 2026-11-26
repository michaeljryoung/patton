/**
 * The status line's log of weekly readings (`seven-day.log`, beside accounts.json,
 * written by the status line's statusline.sh in ~/Projects/central-claude-md/scripts,
 * never by Patton; plan_usage_snapshot.py writes accounts.json). Pure, no Node, so the
 * check runs it as it is. One reading per line, appended when a reading rises:
 * `<epoch seconds> <pct> <resets_at epoch> [<8-char login id>]`; older lines have no id.
 * The id column is never used, so it is not checked.
 *
 * Readings are keyed by their week (resets_at) only, never by the id column: ids there
 * can name the wrong login (on 24 Nov 17:50 a 100% reading of the week resetting
 * Sat 08:00 was tagged 38e237e1, whose own week resets Sat 12:00). Each login's week
 * resets at its own time, so the reset says whose week a reading is; two logins whose
 * weeks reset at the same second would mix (not seen in the log so far).
 */

/** Main refuses a log bigger than this (it was about 23 KB on 26 Nov 2026). */
export const SEVEN_DAY_LOG_SIZE_CAP = 2 * 1024 * 1024;

/** One reading: at `t` the week resetting at `resetsAt` stood at `pct`. Epoch seconds. */
export interface WeekReading {
  t: number;
  pct: number;
  resetsAt: number;
}

export interface SevenDayLog {
  readings: WeekReading[];
  /** Lines that were not a reading (blank lines are not counted). */
  skipped: number;
}

/** Parse the log's text; a bad line is skipped and counted, never thrown on. */
export function parseSevenDayLog(text: string): SevenDayLog {
  const readings: WeekReading[] = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const f = line.split(/\s+/);
    if (f.length < 3 || f.length > 4) {
      skipped++;
      continue;
    }
    const t = Number(f[0]);
    const pct = Number(f[1]);
    const resetsAt = Number(f[2]);
    if (!(Number.isFinite(t) && t > 0) || !(Number.isFinite(pct) && pct >= 0 && pct <= 1000) || !(Number.isFinite(resetsAt) && resetsAt > 0)) {
      skipped++;
      continue;
    }
    readings.push({ t, pct: Math.min(100, pct), resetsAt });
  }
  return { readings, skipped };
}

/** The week's percent at `at`: the highest reading at or before it of the week resetting at
 *  `resetsAt`, or null when the log has none. A week's percent only rises, so the highest is the
 *  latest on a clean log, and a stale lower reading appended just before `at` cannot lower it. */
export function pctAt(readings: readonly WeekReading[], resetsAt: number, at: number): number | null {
  let best: number | null = null;
  for (const r of readings) {
    if (r.resetsAt !== resetsAt || r.t > at) continue;
    if (best === null || r.pct > best) best = r.pct;
  }
  return best;
}
