/**
 * The next time a 5-field cron schedule fires, in local time (docs/session-bar.md, D4).
 *
 *   minute hour day-of-month month day-of-week
 *
 * Each field: `*`, a number, a range `a-b`, a step `*\/n` or `a-b/n`, or a comma list of
 * those; months and weekdays also by their three-letter names; weekday 0 and 7 are Sunday.
 * As in Vixie cron, when both day fields are restricted a day matching either one fires.
 * Pure: no DOM, no timers. Anything it can't read gives null, and the bar shows the
 * schedule itself.
 */

interface Field { values: Set<number>; star: boolean }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseNumber(s: string, names: string[] | null, nameBase: number): number | null {
  if (/^\d{1,2}$/.test(s)) return Number(s);
  if (names) {
    const i = names.indexOf(s.toLowerCase());
    if (i >= 0) return i + nameBase;
  }
  return null;
}

function parseField(text: string, min: number, max: number, names: string[] | null = null, nameBase = 0): Field | null {
  const values = new Set<number>();
  let star = false;
  for (const part of text.split(',')) {
    const m = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return null;
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = min; hi = max;
      if (m[2] === undefined) star = true;
    } else {
      const range = m[1].split('-');
      if (range.length > 2) return null;
      const a = parseNumber(range[0], names, nameBase);
      const b = range.length === 2 ? parseNumber(range[1], names, nameBase) : null;
      if (a === null || (range.length === 2 && b === null)) return null;
      lo = a;
      // `5/15` means 5 to the top, every 15.
      hi = b !== null ? b : m[2] !== undefined ? max : a;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, star };
}

export interface CronSchedule {
  minute: Field; hour: Field; dom: Field; month: Field; dow: Field;
}

/** Parse a 5-field expression, or null. */
export function parseCron(expr: string): CronSchedule | null {
  if (typeof expr !== 'string' || expr.length > 120) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12, MONTHS, 1);
  const dowRaw = parseField(parts[4], 0, 7, DAYS, 0);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  // 7 is Sunday too.
  const dow: Field = { star: dowRaw.star, values: new Set([...dowRaw.values].map((d) => (d === 7 ? 0 : d))) };
  return { minute, hour, dom, month, dow };
}

function dayMatches(s: CronSchedule, d: Date): boolean {
  if (!s.month.values.has(d.getMonth() + 1)) return false;
  const domOk = s.dom.values.has(d.getDate());
  const dowOk = s.dow.values.has(d.getDay());
  if (s.dom.star && s.dow.star) return true;
  if (s.dom.star) return dowOk;
  if (s.dow.star) return domOk;
  return domOk || dowOk;
}

/** Days searched before giving up (covers 29 February and every real schedule). */
const MAX_DAYS = 366 * 8;

/** The first minute strictly after `now` the schedule fires (ms since epoch, local time),
 *  or null when the expression doesn't parse or never fires. */
export function nextCronFire(expr: string, now: number): number | null {
  const s = parseCron(expr);
  if (!s) return null;
  const start = new Date(now);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const minutes = [...s.minute.values].sort((a, b) => a - b);
  const hours = [...s.hour.values].sort((a, b) => a - b);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < MAX_DAYS; i++) {
    if (dayMatches(s, day)) {
      for (const h of hours) {
        for (const m of minutes) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
          // A clock change can skip an hour: a time that isn't the one asked for doesn't fire.
          if (t.getHours() !== h || t.getMinutes() !== m) continue;
          if (t.getTime() >= start.getTime()) return t.getTime();
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}
