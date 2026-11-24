/**
 * The usage panel's IPC: `plan-usage:get` answers the last reading of every
 * Claude login (null when rate-limited, so the renderer keeps what it has; an
 * empty list when there is no file), and `plan-usage:changed` is pushed to
 * every window when the file's content or a login's token count changes. The
 * file is replaced by rename, so a watch on it would break: it is polled by
 * stat every 10 s. Token counts come from the token worker
 * (main/token-scan-host.ts), scanned every 60 s and right after the file's
 * logins, weeks or switches change, and travel on the same push.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IPC } from '../shared/constants';
import { EMPTY_PLAN_USAGE, usageIdentity, type LoginSwitch, type PlanUsage, type WeekTokens } from '../shared/plan-usage';
import { scanFloor, WEEK_S, weekTokens, type TokenWindow } from '../shared/token-credit';
import { isFailedRead, planUsagePath, readPlanUsage, statPlanUsage, type PlanUsageProblem } from './plan-usage-file';
import { RateLimiter } from './rate-limiter';
import { TokenScanHost } from './token-scan-host';
import type { TokenScanReply } from './token-scan-protocol';

const POLL_MS = 10 * 1000;
/** Token counts are rescanned this often (checked on the 10 s poll). */
export const TOKEN_SCAN_MS = 60 * 1000;
/** Forge builds the worker beside main.cjs (forge.config.ts). */
const TOKEN_WORKER_FILE = 'token-scan-worker.cjs';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let current: PlanUsage = EMPTY_PLAN_USAGE;
/** The file's reading and its login timeline, before token counts are joined in. */
let fileUsage: PlanUsage = EMPTY_PLAN_USAGE;
let switches: LoginSwitch[] = [];
/** The stat key of the file last read; '' before the first read. */
let readKey = '';
let lastContent = '';
/** The reading without its read times: what the log line is about. */
let lastIdentity = '';
let lastProblem: PlanUsageProblem = null;
let inFlight: Promise<void> | null = null;

/** The last token count of each login's week, by login id. */
let tokenFigures = new Map<string, WeekTokens>();
/** The worker's script; undefined until first asked (then beside this bundle, or null where there is none). */
let tokenScript: string | null | undefined;
let tokenHost: TokenScanHost | null = null;
let tokenInFlight: Promise<void> | null = null;
let tokenAgain = false;
/** When the last scan began (ms), for the 60 s cadence; 0 before the first. */
let lastTokenScanAt = 0;
/** The scan's inputs (windows and switches) at the last scan: a change scans at once. */
let lastTokenInputs = '';
/** The exact totals at the last `[USAGE] tokens` line. */
let lastTokenTotals = '';
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

/** Re-read the file when its mtime or size changed, and publish what it holds. */
async function refreshOnce(): Promise<void> {
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
      const f = tokenFigures.get(a.id);
      const fits = f !== undefined && a.week !== null && !a.week.passed && f.resetsAt === a.week.resetsAt;
      return { ...a, weekTokens: fits ? f : null };
    }),
  };
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
  const now = nowSeconds();
  const windows = tokenWindows(now);
  lastTokenInputs = JSON.stringify([windows, switches]);
  const floor = scanFloor(switches, windows, now);
  let figures = new Map<string, WeekTokens>();
  let stats: { files: number; filesRead: number; ms: number } | null = null;
  if (floor !== null) {
    tokenHost ??= new TokenScanHost(script);
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
    const totals = new Map(reply.totals);
    for (const w of windows) figures.set(w.id, weekTokens(totals.get(w.id) ?? 0, w, switches));
    stats = { files: reply.files, filesRead: reply.filesRead, ms: reply.ms };
  } else {
    figures = new Map();
  }
  const totalsKey = JSON.stringify([...figures]);
  if (totalsKey !== lastTokenTotals) {
    lastTokenTotals = totalsKey;
    const millions: Record<string, number> = {};
    for (const [id, f] of figures) millions[id] = Math.round(f.tokens / 1e6);
    console.info('[USAGE] tokens', { accounts: figures.size, totalsM: millions, files: stats?.files ?? 0, read: stats?.filesRead ?? 0, ms: stats?.ms ?? 0 });
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
      .finally(() => { inFlight = null; maybeScanTokens(); });
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
