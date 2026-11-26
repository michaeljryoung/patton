/**
 * Plan usage per Claude login: the shapes the usage panel draws, and the pure
 * parser of `~/.claude/plan-usage/accounts.json`. That file is written by
 * Michael's Claude Code status line (central-claude-md
 * scripts/plan_usage_snapshot.py), never by Patton, so every field is checked
 * here and a bad entry is dropped, never thrown on. Times are epoch seconds.
 */

/** A window's percent at which its limit is reached ("back" in place of "resets", red). */
export const FULL_PCT = 100;

/** The percent shown: 100 only when the limit is truly reached (99.6 shows 99). Shared, so the
 *  estimate's 5%-shown minimum (token-credit.ts) follows the same rounding the panel draws. */
export function shownPct(pct: number): number {
  if (pct >= FULL_PCT) return FULL_PCT;
  return Math.max(0, Math.min(FULL_PCT - 1, Math.round(pct)));
}

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
  /** Tokens Claude Code recorded on this login in its current week (main/token-scan.ts), or null:
   *  none counted yet, no week, or a count for another week than `week`. Never set by the parser. */
  weekTokens: WeekTokens | null;
}

/** The token count of one login's current week, counted from Claude Code's transcripts and
 *  credited by the producer's `switches` timeline (shared/token-credit.ts). */
export interface WeekTokens {
  /** input + cache writes + cache reads + output, one per API request. */
  tokens: number;
  /** The timeline covers the whole week (its first switch at or before the week's start). */
  complete: boolean;
  /** When partial: the first switch's time, from which the count runs (epoch seconds); else null. */
  since: number | null;
  /** The week this count is for (its reset), so a count is never shown against another week. */
  resetsAt: number;
  /** Set (epoch seconds) only when the count is more than 5 minutes old, because scans since have failed. */
  countedAt?: number | null;
  /** The week's use and allowance guessed from this count (shared/token-credit.ts weekEstimate), set by
   *  main when it joins the count in; null (or absent) when there is too little to guess from. */
  estimate?: WeekEstimate | null;
  /** Why `estimate` is null, for the hover (set by main with the estimate); null or absent otherwise. */
  noEstimate?: NoEstimateReason | null;
}

/** Why a count has no estimate: nothing counted for this login (in this week, or since the login record began), under 5% of the
 *  week used (complete count), no reading of the week at or before the count's start, or too little rise since it began. */
export type NoEstimateReason = 'none-counted' | 'low-pct' | 'no-reading' | 'small-rise';

/** A guess at a login's week in tokens, from the count and the percent Anthropic reports. */
export interface WeekEstimate {
  /** 'complete': the count covers the whole week, so allowance = tokens ÷ percent × 100.
   *  'rate': the count runs from `since`, so allowance = tokens ÷ (percent now − percent at since) × 100. */
  method: 'complete' | 'rate';
  /** Tokens used this week (the count itself when complete; percent now × allowance when a rate). */
  used: number;
  /** The whole week's tokens. Neither figure is rounded here: the words round them. */
  allowance: number;
  /** The week's percent at `since` (from the status line's seven-day.log), for 'rate'; else null. */
  p0: number | null;
  /** The week's percent the estimate was drawn with. */
  pct: number;
}

/** One entry of the file's `switches`: from `at` (epoch seconds), `account` was the live login. */
export type LoginSwitch = readonly [at: number, account: string];

export interface PlanUsage {
  /** The live login's id, or null. */
  liveId: string | null;
  /** Live login first, then by last time live, newest first; at most MAX_ACCOUNTS. */
  accounts: PlanUsageAccount[];
}

export const MAX_ACCOUNTS = 12;
export const EMPTY_PLAN_USAGE: PlanUsage = { liveId: null, accounts: [] };

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
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
      weekTokens: null,
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

/** At most this many switches are kept (the producer keeps 500). */
export const MAX_SWITCHES = 2000;

/** The file's `switches` timeline, oldest first: entries that are not `[epoch seconds, login id]`
 *  with a plausible time are dropped. An empty list when there is none. */
export function parseSwitches(json: unknown, now: number): LoginSwitch[] {
  if (!isRecord(json) || !Array.isArray(json.switches)) return [];
  const out: LoginSwitch[] = [];
  for (const entry of json.switches) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const at = finite(entry[0]);
    const account = entry[1];
    if (at === null || at < READ_FLOOR_S || at > now + READ_AHEAD_S) continue;
    if (typeof account !== 'string' || !ID_RE.test(account)) continue;
    out.push([at, account]);
  }
  out.sort((x, y) => x[0] - y[0]);
  return out.length > MAX_SWITCHES ? out.slice(out.length - MAX_SWITCHES) : out;
}

function nameGroups(accounts: PlanUsageAccount[]): PlanUsageAccount[][] {
  const groups = new Map<string, PlanUsageAccount[]>();
  for (const a of accounts) {
    const key = a.name.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Two shown logins that would read alike are told apart: first those with the same
 *  email local part are named `local@domain`; any still alike (the same email twice,
 *  two logins with no email and the same first 4 of id) get the first characters of
 *  their ids, as many as it takes to differ. Only the clashing logins are renamed. */
function disambiguateNames(accounts: PlanUsageAccount[]): void {
  for (const group of nameGroups(accounts)) {
    for (const a of group) if (a.email) a.name = a.email;
  }
  for (const group of nameGroups(accounts)) {
    let n = 4;
    while (n < 64 && new Set(group.map((a) => a.id.slice(0, n))).size < group.length) n++;
    for (const a of group) a.name = a.email ? `${a.name} (${a.id.slice(0, n)})` : `Login ${a.id.slice(0, Math.max(n, 5))}`;
  }
}

/** A reading's identity: everything but the times the producer re-stamps on every
 *  status line (`readAt`) and the token counts (which move every minute while Claude
 *  works and have their own `[USAGE] tokens` line), so the `[USAGE] read` and
 *  `[USAGE] panel` log lines are for a change of a login, its percent or the live one.
 *  Re-draws follow the full content and the drawn strings, tokens included. */
export function usageIdentity(usage: PlanUsage): string {
  return JSON.stringify(usage, (key, value) => (key === 'readAt' || key === 'weekTokens' ? undefined : value));
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
