/**
 * The usage panel's IPC: `plan-usage:get` answers the last reading of every
 * Claude login (null when rate-limited, so the renderer keeps what it has; an
 * empty list when there is no file), and `plan-usage:changed` is pushed to
 * every window when the file's content or a login's token count changes. The
 * file is replaced by rename, so a watch on it would break: it is polled by
 * stat every 10 s. Token counts come from the token worker
 * (main/token-scan-host.ts), scanned every 60 s and right after the file's
 * logins, weeks or switches change, and travel on the same push. Each count
 * carries its estimate of the week (shared/token-credit.ts estimateWeek), drawn
 * from the percent when the scan ended and held until the next good scan (a
 * percent that moves between scans must not move the allowance), or the reason
 * there is none; a partial count's needs the week's percent at the count's
 * start, read from the status line's seven-day.log beside the file (re-read
 * when its stat changes, and at each scan, where it is captured with the count;
 * a failed read keeps the last good readings).
 */
import { BrowserWindow, ipcMain } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IPC } from '../shared/constants';
import { EMPTY_PLAN_USAGE, usageIdentity, type LoginSwitch, type NoEstimateReason, type PlanUsage, type PlanUsageAccount, type WeekTokens } from '../shared/plan-usage';
import { pctAt, type WeekReading } from '../shared/seven-day-log';
import { estimateWeek, scanFloor, scanPct, WEEK_S, weekTokens, type TokenWindow } from '../shared/token-credit';
import {
  isFailedRead, planUsagePath, readPlanUsage, readSevenDayLog, sevenDayLogPath, statPlanUsage, statSevenDayLog,
  type PlanUsageProblem, type SevenDayLogProblem,
} from './plan-usage-file';
import { RateLimiter } from './rate-limiter';
import { TokenScanHost } from './token-scan-host';
import type { TokenScanReply } from './token-scan-protocol';

const POLL_MS = 10 * 1000;
/** Token counts are rescanned this often (checked on the 10 s poll). */
export const TOKEN_SCAN_MS = 60 * 1000;
/** A count older than this (no good scan since) says when it was counted. */
export const TOKEN_STALE_MS = 5 * 60 * 1000;
/** Forge builds the worker beside main.cjs (forge.config.ts). */
const TOKEN_WORKER_FILE = 'token-scan-worker.cjs';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let current: PlanUsage = EMPTY_PLAN_USAGE;
/** The file's reading and its login timeline, before token counts are joined in. */
let fileUsage: PlanUsage = EMPTY_PLAN_USAGE;
let switches: LoginSwitch[] = [];
/** The stat key of the file last read; '' before the first read. */
let readKey = '';
/** What the windows were last sent; they start from the empty reading, so a poll that finds no file sends nothing. */
let lastContent = JSON.stringify(EMPTY_PLAN_USAGE);
/** The reading without its read times: what the log line is about. */
let lastIdentity = '';
let lastProblem: PlanUsageProblem = null;
let inFlight: Promise<void> | null = null;

/** The status line's weekly readings (seven-day.log): the last good read's, kept when a later read fails. */
let weekReadings: WeekReading[] = [];
/** Whether seven-day.log has ever been read without a problem (an empty log counts: it was readable). */
let weekReadingsGood = false;
/** The log's stat key last read; '' before the first read or after a failed one. */
let sevenDayKey = '';
/** The log's last problem and skipped-line count logged, so each is logged once. */
let lastSevenDayProblem: SevenDayLogProblem | undefined;
let lastSevenDaySkipped = 0;
/** Each login's estimate as last logged (`[USAGE] estimate`), by login id. */
const lastEstimates = new Map<string, string>();

/** One login's count as the last good scan left it, with the week's percent and (for a partial count) the percent at its
 *  start, both as of that scan: the estimate is drawn from all three, so it stays as it was until the next good scan
 *  however the percent or seven-day.log moves between scans. */
interface ScannedWeek {
  figure: WeekTokens;
  /** The week's percent when the scan ended; null when the file no longer showed that week. */
  pct: number | null;
  /** The week's percent at the count's start, from seven-day.log at the scan; null for a complete count or with no reading. */
  p0: number | null;
  /** False when seven-day.log had never been readable at the scan (so a missing p0 is not the week's fault). */
  logUsable: boolean;
}
/** The last count of each login's week, by login id. */
let tokenFigures = new Map<string, ScannedWeek>();
/** The worker's script; undefined until first asked (then beside this bundle, or null where there is none). */
let tokenScript: string | null | undefined;
let tokenHost: TokenScanHost | null = null;
let tokenInFlight: Promise<void> | null = null;
let tokenAgain = false;
/** When the last scan began (ms), for the 60 s cadence; 0 before the first. */
let lastTokenScanAt = 0;
/** The scan's inputs (windows and switches) at the last scan: a change scans at once. */
let lastTokenInputs = '';
/** The accounts and their totals in millions at the last `[USAGE] tokens` line. */
let lastTokenTotals = '';
/** When the last scan that answered ended (ms); 0 before one has. */
let lastGoodScanAt = 0;
/** The last scan error logged, so each distinct error is logged once ('' after a good scan). */
let lastTokenError = '';
let tokensStopped = false;

/** Where Claude Code keeps its transcripts; `PATTON_CLAUDE_PROJECTS_DIR` overrides it (for checks). */
export function claudeProjectsDir(): string {
  return process.env.PATTON_CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
}

/** For the checks: the worker script to run, or null for no token counts. */
export function setTokenWorkerScript(path: string | null): void {
  tokenScript = path;
}

function tokenWorkerScript(): string | null {
  if (tokenScript === undefined) tokenScript = typeof __dirname === 'string' ? join(__dirname, TOKEN_WORKER_FILE) : null;
  return tokenScript;
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

/** Re-read seven-day.log when its mtime or size changed. A problem (missing, too large, unreadable) keeps the
 *  last good readings (a reading at a count's start does not change), and is logged once per distinct problem;
 *  with no good read yet, a partial count's reason is `log-unusable`. */
async function refreshSevenDayLog(): Promise<void> {
  const path = sevenDayLogPath();
  const key = await statSevenDayLog(path);
  if (key !== '' && key === sevenDayKey) return;
  const read = await readSevenDayLog(path);
  sevenDayKey = read.key;
  if (read.problem === null) {
    weekReadings = read.readings;
    weekReadingsGood = true;
  }
  if (read.problem !== lastSevenDayProblem) {
    lastSevenDayProblem = read.problem;
    if (read.problem) console.warn('[USAGE] seven-day log unusable', { reason: read.problem, keptReadings: weekReadingsGood ? weekReadings.length : 0 });
  }
  if (read.skipped !== lastSevenDaySkipped) {
    lastSevenDaySkipped = read.skipped;
    if (read.skipped > 0) console.warn('[USAGE] seven-day log lines skipped', { skipped: read.skipped, readings: read.readings.length });
  }
}

/** Re-read the file when its mtime or size changed, and publish what it holds. */
async function refreshOnce(): Promise<void> {
  await refreshSevenDayLog();
  const path = planUsagePath();
  const st = await statPlanUsage(path);
  if (!st.failed && st.key === readKey) return;
  const read = await readPlanUsage(path, nowSeconds());
  if (read.problem !== lastProblem) {
    lastProblem = read.problem;
    if (read.problem) console.warn('[USAGE] no data', { reason: read.problem });
  }
  // A failed read (unreadable, half-written) keeps the last good reading and is
  // tried again next poll: it leaves no key behind ('' replaces the good one, so
  // a mend that leaves the file's stat as it was is still read), nothing is pushed.
  readKey = read.key;
  if (isFailedRead(read)) return;
  fileUsage = read.usage;
  switches = read.switches;
  publish();
}

/** The file's reading with each login's token count joined in: a count shows only against
 *  the week it was counted for, and never on a passed week. */
function withTokens(usage: PlanUsage): PlanUsage {
  return {
    liveId: usage.liveId,
    accounts: usage.accounts.map((a) => {
      const scanned = tokenFigures.get(a.id);
      const f = scanned?.figure;
      const fits = f !== undefined && a.week !== null && !a.week.passed && f.resetsAt === a.week.resetsAt;
      if (!fits || a.week === null) return { ...a, weekTokens: null };
      // Past 5 minutes with no good scan, the count says when it was counted.
      const stale = lastGoodScanAt > 0 && Date.now() - lastGoodScanAt > TOKEN_STALE_MS;
      // From the percent and p0 at the scan, never live ones: a count that stays while the percent climbs would drift.
      const { estimate, why } = scanned.pct == null ? { estimate: null, why: null } : estimateWeek(f, scanned.pct, scanned.p0, scanned.logUsable);
      return { ...a, weekTokens: { ...f, estimate, noEstimate: why, ...(stale ? { countedAt: Math.floor(lastGoodScanAt / 1000) } : {}) } };
    }),
  };
}

/** Billions to 2 significant figures, for the log. */
function billions(n: number): number {
  return Number((n / 1e9).toPrecision(2));
}

/** One `[USAGE] estimate` line per login whose estimate, as the panel rounds it, changed. */
function logEstimates(accounts: readonly PlanUsageAccount[]): void {
  for (const a of accounts) {
    const e = a.weekTokens?.estimate ?? null;
    const reason = a.weekTokens?.noEstimate ?? null;
    const line: { id: string; method: 'complete' | 'rate' | 'none'; usedB: number | null; allowanceB: number | null; dPct: number | null; reason: NoEstimateReason | null } = e === null
      ? { id: a.id, method: 'none', usedB: null, allowanceB: null, dPct: null, reason }
      : { id: a.id, method: e.method, usedB: billions(e.used), allowanceB: billions(e.allowance), dPct: Math.round((e.p0 === null ? e.pct : e.pct - e.p0) * 10) / 10, reason: null };
    const key = JSON.stringify(line);
    if (lastEstimates.get(a.id) === key) continue;
    lastEstimates.set(a.id, key);
    console.info('[USAGE] estimate', line);
  }
}

/** Push the reading when its content changed (a new read time or token count moves the panel), and log
 *  only when a login, its percent or the live one did (the producer rewrites read_at on every render). */
function publish(): void {
  const next = withTokens(fileUsage);
  const content = JSON.stringify(next);
  if (content === lastContent) return;
  lastContent = content;
  current = next;
  const identity = usageIdentity(current);
  if (identity !== lastIdentity) {
    lastIdentity = identity;
    console.info('[USAGE] read', { accounts: current.accounts.length, live: current.liveId });
  }
  logEstimates(current.accounts);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC.PLAN_USAGE_CHANGED, current);
  }
}

/** Each login's current week, as the worker credits it. */
function tokenWindows(now: number): TokenWindow[] {
  const out: TokenWindow[] = [];
  for (const a of fileUsage.accounts) {
    if (a.week && !a.week.passed && a.week.resetsAt > now) out.push({ id: a.id, start: a.week.resetsAt - WEEK_S, end: a.week.resetsAt });
  }
  return out;
}

function logTokenError(error: string): void {
  if (error === lastTokenError) return;
  lastTokenError = error;
  console.warn('[USAGE] tokens scan failed', { error });
}

async function scanTokens(): Promise<void> {
  const script = tokenWorkerScript();
  if (!script || tokensStopped) return;
  lastTokenScanAt = Date.now();
  await refreshSevenDayLog();
  const now = nowSeconds();
  const windows = tokenWindows(now);
  lastTokenInputs = JSON.stringify([windows, switches]);
  const floor = scanFloor(switches, windows, now);
  let figures = new Map<string, ScannedWeek>();
  let stats: { files: number; filesRead: number; ms: number; skipped: number; bytes: number; requests: number } | null = null;
  if (floor !== null) {
    tokenHost ??= new TokenScanHost(script, (n) => {
      if (n > 1) console.warn('[USAGE] tokens worker restarted', { starts: n });
    });
    let reply: TokenScanReply;
    try {
      reply = await tokenHost.scan({ root: claudeProjectsDir(), floor, switches, windows });
    } catch (err) {
      const e = err as { code?: unknown; name?: unknown } | null;
      if (e?.code !== 'STOPPED') logTokenError(typeof e?.code === 'string' ? e.code : typeof e?.name === 'string' ? e.name : 'unknown');
      return; // the last counts stay
    }
    if ('error' in reply) {
      logTokenError(reply.error);
      return;
    }
    lastTokenError = '';
    lastGoodScanAt = Date.now();
    for (const [file, code] of reply.errors) console.warn('[USAGE] tokens read failed', { file, code });
    // No transcripts folder (or none in it): nothing was counted, so no count is shown, not a 0.
    if (reply.listed > 0) {
      const totals = new Map(reply.totals);
      for (const w of windows) {
        // The percent as the file shows it now, if it is still the week this window counted.
        const week = fileUsage.accounts.find((a) => a.id === w.id)?.week;
        const figure = weekTokens(totals.get(w.id) ?? 0, w, switches);
        // A partial count is estimated from the week's rise since its start: the percent then, by the week's reset alone.
        const p0 = !figure.complete && figure.since !== null ? pctAt(weekReadings, figure.resetsAt, figure.since) : null;
        figures.set(w.id, { figure, pct: scanPct(week, w.end), p0, logUsable: weekReadingsGood });
      }
    }
    stats = { files: reply.files, filesRead: reply.filesRead, ms: reply.ms, skipped: reply.skipped, bytes: reply.bytes, requests: reply.requests };
  } else {
    figures = new Map();
  }
  // Logged when the accounts or a total in rounded millions change, not on every exact change.
  const millions: Record<string, number> = {};
  for (const [id, f] of figures) millions[id] = Math.round(f.figure.tokens / 1e6);
  const totalsKey = JSON.stringify(millions);
  if (totalsKey !== lastTokenTotals) {
    lastTokenTotals = totalsKey;
    console.info('[USAGE] tokens', {
      accounts: figures.size, totalsM: millions, files: stats?.files ?? 0, read: stats?.filesRead ?? 0, skipped: stats?.skipped ?? 0,
      bytes: stats?.bytes ?? 0, requests: stats?.requests ?? 0, ms: stats?.ms ?? 0,
    });
  }
  tokenFigures = figures;
  publish();
}

/** One token scan at a time; a call during one runs one more after it, and waits for that.
 *  Exported for the check, which drives scans by hand. */
export function scanTokensOnce(): Promise<void> {
  if (tokenInFlight) {
    tokenAgain = true;
    return tokenInFlight;
  }
  tokenInFlight = (async () => {
    do {
      tokenAgain = false;
      await scanTokens().catch((err) => logTokenError(String((err as { name?: unknown } | null)?.name ?? 'unknown')));
    } while (tokenAgain && !tokensStopped);
  })().finally(() => { tokenInFlight = null; });
  return tokenInFlight;
}

/** After a poll: scan when the minute is up, or at once when the file's weeks or switches changed. */
function maybeScanTokens(): void {
  if (!tokenWorkerScript() || tokensStopped) return;
  const inputs = JSON.stringify([tokenWindows(nowSeconds()), switches]);
  if (inputs !== lastTokenInputs || Date.now() - lastTokenScanAt >= TOKEN_SCAN_MS) {
    scanTokensOnce().catch(() => { /* logged in scanTokens */ });
  }
}

/** One refresh at a time; a caller during one waits for it. Exported for the check, which drives polls by hand. */
export function pollPlanUsageOnce(): Promise<void> {
  if (!inFlight) {
    inFlight = refreshOnce()
      .catch((err) => console.warn('[USAGE] refresh failed', { code: (err as { code?: unknown } | null)?.code ?? null }))
      .finally(() => { inFlight = null; publish(); maybeScanTokens(); });
  }
  return inFlight;
}

/** On quit: no more polls. */
export function stopPlanUsagePoll(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  tokensStopped = true;
  tokenHost?.stop();
  tokenHost = null;
}

export function registerPlanUsageHandlers(): void {
  // Each window asks once at start; changes come by push.
  const getLimiter = new RateLimiter(20);
  ipcMain.handle(IPC.PLAN_USAGE_GET, async () => {
    if (!getLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.PLAN_USAGE_GET });
      return null;
    }
    await pollPlanUsageOnce();
    return current;
  });

  pollPlanUsageOnce().catch(() => { /* logged in pollPlanUsageOnce */ });
  pollTimer = setInterval(() => { pollPlanUsageOnce().catch(() => { /* logged in pollPlanUsageOnce */ }); }, POLL_MS);
  pollTimer.unref?.();
}
