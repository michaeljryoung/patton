/**
 * The usage panel's IPC: `plan-usage:get` answers the last reading of every
 * Claude login (null when rate-limited, so the renderer keeps what it has; an
 * empty list when there is no file), and `plan-usage:changed` is pushed to
 * every window when the file's content changes. The file is replaced by
 * rename, so a watch on it would break: it is polled by stat every 10 s.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../shared/constants';
import { EMPTY_PLAN_USAGE, type PlanUsage } from '../shared/plan-usage';
import { planUsagePath, readPlanUsage, statPlanUsage, type PlanUsageProblem } from './plan-usage-file';
import { RateLimiter } from './rate-limiter';

const POLL_MS = 10 * 1000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let current: PlanUsage = EMPTY_PLAN_USAGE;
/** The stat key of the file last read; '' before the first read. */
let readKey = '';
let lastContent = '';
let lastProblem: PlanUsageProblem = null;
let inFlight: Promise<void> | null = null;

function nowSeconds(): number {
  return Date.now() / 1000;
}

/** Re-read the file when its mtime or size changed; push and log only when its content did. */
async function refreshOnce(): Promise<void> {
  const path = planUsagePath();
  const st = await statPlanUsage(path);
  if (st.key === readKey) return;
  const read = await readPlanUsage(path, nowSeconds());
  readKey = read.key;
  if (read.problem !== lastProblem) {
    lastProblem = read.problem;
    if (read.problem) console.warn('[USAGE] no data', { reason: read.problem });
  }
  const content = JSON.stringify(read.usage);
  if (content === lastContent) return;
  lastContent = content;
  current = read.usage;
  console.info('[USAGE] read', { accounts: current.accounts.length, live: current.liveId });
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC.PLAN_USAGE_CHANGED, current);
  }
}

/** One refresh at a time; a caller during one waits for it. */
function refresh(): Promise<void> {
  if (!inFlight) {
    inFlight = refreshOnce()
      .catch((err) => console.warn('[USAGE] refresh failed', { code: (err as { code?: unknown } | null)?.code ?? null }))
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** On quit: no more polls. */
export function stopPlanUsagePoll(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

export function registerPlanUsageHandlers(): void {
  // Each window asks once at start; changes come by push.
  const getLimiter = new RateLimiter(20);
  ipcMain.handle(IPC.PLAN_USAGE_GET, async () => {
    if (!getLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.PLAN_USAGE_GET });
      return null;
    }
    await refresh();
    return current;
  });

  refresh().catch(() => { /* logged in refresh */ });
  pollTimer = setInterval(() => { refresh().catch(() => { /* logged in refresh */ }); }, POLL_MS);
  pollTimer.unref?.();
}
