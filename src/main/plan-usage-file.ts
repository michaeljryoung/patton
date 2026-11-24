/**
 * Reads the plan-usage file Michael's Claude Code status line writes
 * (`~/.claude/plan-usage/accounts.json`, replaced by write-and-rename). No
 * Electron here, so the check runs it under plain Node. A missing file is no
 * data, not an error; a file over SIZE_CAP or not JSON is no data with a reason.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_PLAN_USAGE, parsePlanUsage, type PlanUsage } from '../shared/plan-usage';

export const PLAN_USAGE_SIZE_CAP = 256 * 1024;

/** The file's path; `PATTON_PLAN_USAGE_FILE` overrides it (for checks). */
export function planUsagePath(): string {
  return process.env.PATTON_PLAN_USAGE_FILE || join(homedir(), '.claude', 'plan-usage', 'accounts.json');
}

export interface PlanUsageStat {
  /** `<mtimeMs>:<size>`, or 'none' when there is no file. Changes when the file is replaced. */
  key: string;
  size: number;
}

/** Why a file gave no data, for the log (never a path or the file's text). */
export type PlanUsageProblem = 'too-large' | 'not-json' | 'wrong-shape' | 'unreadable' | null;

export interface PlanUsageRead {
  key: string;
  usage: PlanUsage;
  problem: PlanUsageProblem;
}

export async function statPlanUsage(path: string): Promise<PlanUsageStat> {
  try {
    const st = await fs.stat(path);
    if (!st.isFile()) return { key: 'none', size: 0 };
    return { key: `${st.mtimeMs}:${st.size}`, size: st.size };
  } catch {
    return { key: 'none', size: 0 };
  }
}

/** Read and parse the file as it is now (`now` in epoch seconds). */
export async function readPlanUsage(path: string, now: number): Promise<PlanUsageRead> {
  const st = await statPlanUsage(path);
  if (st.key === 'none') return { key: st.key, usage: EMPTY_PLAN_USAGE, problem: null };
  if (st.size > PLAN_USAGE_SIZE_CAP) return { key: st.key, usage: EMPTY_PLAN_USAGE, problem: 'too-large' };
  let text: string;
  try {
    const buf = await fs.readFile(path);
    // Replaced between the stat and the read: the next poll sees the new key.
    if (buf.length > PLAN_USAGE_SIZE_CAP) return { key: st.key, usage: EMPTY_PLAN_USAGE, problem: 'too-large' };
    text = buf.toString('utf8');
  } catch (err) {
    // Gone between the stat and the read (a rename in flight): no data this time.
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return { key: 'none', usage: EMPTY_PLAN_USAGE, problem: null };
    return { key: st.key, usage: EMPTY_PLAN_USAGE, problem: 'unreadable' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { key: st.key, usage: EMPTY_PLAN_USAGE, problem: 'not-json' };
  }
  const usage = parsePlanUsage(json, now);
  return usage ? { key: st.key, usage, problem: null } : { key: st.key, usage: EMPTY_PLAN_USAGE, problem: 'wrong-shape' };
}
