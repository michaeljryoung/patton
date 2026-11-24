/**
 * Plan usage per Claude login: the shapes the usage panel draws, and the pure
 * parser of `~/.claude/plan-usage/accounts.json`. That file is written by
 * Michael's Claude Code status line (central-claude-md
 * scripts/plan_usage_snapshot.py), never by Patton, so every field is checked
 * here and a bad entry is dropped, never thrown on. Times are epoch seconds.
 */

/** One limit window of one login (the week, or the 5-hour window). */
export interface UsageWindow {
  /** Used share, 0..100 (a reading above 100 is shown as 100). */
  pct: number;
  /** When the window starts over (epoch seconds). */
  resetsAt: number;
  /** When this reading was taken (epoch seconds), or null if the file had none. */
  readAt: number | null;
  /** The window has reset since the reading: its use starts over, so it shows 0%. */
  passed: boolean;
}

export interface PlanUsageAccount {
  /** The producer's short login id (the key in `accounts`). */
  id: string;
  /** The email's part before @, or `Login <first 4 of id>`. */
  name: string;
  email: string | null;
  plan: string | null;
  /** The login Claude Code is signed in with now. */
  live: boolean;
  /** The last time this login was live (epoch seconds), or null. */
  lastLive: number | null;
  week: UsageWindow | null;
  fiveHour: UsageWindow | null;
}

export interface PlanUsage {
  /** The live login's id, or null. */
  liveId: string | null;
  /** Live login first, then by last time live, newest first; at most MAX_ACCOUNTS. */
  accounts: PlanUsageAccount[];
}

export const MAX_ACCOUNTS = 12;
export const EMPTY_PLAN_USAGE: PlanUsage = { liveId: null, accounts: [] };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EMAIL = 254;
const MAX_PLAN = 40;
const DAY_S = 24 * 60 * 60;
/** A reset further back than this is not a window we can show (a stale or wrong time). */
const RESET_PAST_S = 30 * DAY_S;
/** A weekly window resets within 7 days; a reset further ahead than this is wrong (e.g. milliseconds). */
const RESET_AHEAD_S = 8 * DAY_S;
/** No reading was taken before this (1 Jan 2020, epoch seconds) ... */
const READ_FLOOR_S = 1577836800;
/** ... or more than a day from now. */
const READ_AHEAD_S = DAY_S;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function shortString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= max ? s : null;
}

function parseWindow(v: unknown, now: number): UsageWindow | null {
  if (!isRecord(v)) return null;
  const used = finite(v.used_percentage);
  const resetsAt = finite(v.resets_at);
  if (used === null || resetsAt === null) return null;
  // A time outside the plausible range (a millisecond epoch, 1e15) is a bad window: drop it,
  // so no NaN or absurd date ever reaches the formatting.
  if (resetsAt < now - RESET_PAST_S || resetsAt > now + RESET_AHEAD_S) return null;
  const rawRead = finite(v.read_at);
  const readAt = rawRead !== null && rawRead >= READ_FLOOR_S && rawRead <= now + READ_AHEAD_S ? rawRead : null;
  const passed = resetsAt <= now;
  return {
    pct: passed ? 0 : Math.min(100, Math.max(0, used)),
    resetsAt,
    readAt,
    passed,
  };
}

/** The name shown for a login: the email's local part, else `Login <first 4 of id>`. */
export function accountName(id: string, email: string | null): string {
  const local = email ? email.split('@')[0].trim() : '';
  return local || `Login ${id.slice(0, 4)}`;
}

/** Parse the accounts file's JSON. Null when it is not the file's shape at all
 *  (not an object, no `accounts` object, or a version other than 1). */
export function parsePlanUsage(json: unknown, now: number): PlanUsage | null {
  if (!isRecord(json) || !isRecord(json.accounts)) return null;
  if (json.version !== undefined && json.version !== 1) return null;

  const liveRaw = isRecord(json.live) ? json.live.account : null;
  const accountsRaw = json.accounts;
  const liveId = typeof liveRaw === 'string' && ID_RE.test(liveRaw) && Object.hasOwn(accountsRaw, liveRaw) && isRecord(accountsRaw[liveRaw]) ? liveRaw : null;

  const accounts: PlanUsageAccount[] = [];
  for (const id of Object.keys(accountsRaw)) {
    if (!ID_RE.test(id)) continue;
    const a = accountsRaw[id];
    if (!isRecord(a)) continue;
    const email = shortString(a.email, MAX_EMAIL);
    const lastLive = finite(a.last_live);
    accounts.push({
      id,
      name: accountName(id, email),
      email,
      plan: shortString(a.plan, MAX_PLAN),
      live: id === liveId,
      lastLive,
      week: parseWindow(a.seven_day, now),
      fiveHour: parseWindow(a.five_hour, now),
    });
  }

  accounts.sort((x, y) => {
    if (x.live !== y.live) return x.live ? -1 : 1;
    const dx = x.lastLive ?? -Infinity;
    const dy = y.lastLive ?? -Infinity;
    if (dx !== dy) return dy - dx;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });

  const shown = accounts.slice(0, MAX_ACCOUNTS);
  disambiguateNames(shown);
  return { liveId, accounts: shown };
}

/** Two shown logins with the same email local part would read alike: those (only
 *  those) are named `local@domain`. */
function disambiguateNames(accounts: PlanUsageAccount[]): void {
  const count = new Map<string, number>();
  for (const a of accounts) {
    if (a.email) count.set(a.name.toLowerCase(), (count.get(a.name.toLowerCase()) ?? 0) + 1);
  }
  for (const a of accounts) {
    if (a.email && (count.get(a.name.toLowerCase()) ?? 0) > 1) a.name = a.email;
  }
}

function windowAt(w: UsageWindow | null, now: number): UsageWindow | null {
  if (!w || w.passed || w.resetsAt > now) return w;
  return { ...w, pct: 0, passed: true };
}

/** The same usage as seen at `now`: a window whose reset has come since it was
 *  parsed is marked passed and shows 0% (the panel re-draws once a minute). */
export function planUsageAt(usage: PlanUsage, now: number): PlanUsage {
  return {
    liveId: usage.liveId,
    accounts: usage.accounts.map((a) => ({ ...a, week: windowAt(a.week, now), fiveHour: windowAt(a.fiveHour, now) })),
  };
}
