/**
 * Reads the plan-usage file Michael's Claude Code status line writes
 * (`~/.claude/plan-usage/accounts.json`, replaced by write-and-rename). No
 * Electron here, so the check runs it under plain Node. A missing file is no
 * data, not an error; a file over SIZE_CAP or not JSON is no data with a reason.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_PLAN_USAGE, parsePlanUsage, parseSwitches, type LoginSwitch, type PlanUsage } from '../shared/plan-usage';

export const PLAN_USAGE_SIZE_CAP = 256 * 1024;

/** The file's path; `PATTON_PLAN_USAGE_FILE` overrides it (for checks). */
export function planUsagePath(): string {
  return process.env.PATTON_PLAN_USAGE_FILE || join(homedir(), '.claude', 'plan-usage', 'accounts.json');
}

export interface PlanUsageStat {
  /** `<mtimeMs>:<ctimeMs>:<ino>:<size>`, 'none' when there is no file, '' when the stat failed. Changes when the file is replaced. */
  key: string;
  size: number;
  /** The stat failed for a reason other than a missing file (permissions, I/O): no verdict on the file. */
  failed?: boolean;
}

/** Why a file gave no data, for the log (never a path or the file's text). */
export type PlanUsageProblem = 'too-large' | 'not-json' | 'wrong-shape' | 'unreadable' | null;

export interface PlanUsageRead {
  /** The stat key to remember as read; '' after a failed read, so the next poll reads again. */
  key: string;
  usage: PlanUsage;
  /** The file's login timeline, oldest first (empty unless the read gave usage). */
  switches: LoginSwitch[];
  problem: PlanUsageProblem;
}

/** A read that failed in a way that may mend itself (permissions, a half-written
 *  file): the caller keeps its last good reading and reads again next poll. */
export function isFailedRead(read: PlanUsageRead): boolean {
  return read.problem === 'unreadable' || read.problem === 'not-json';
}

export async function statPlanUsage(path: string): Promise<PlanUsageStat> {
  try {
    const st = await fs.stat(path);
    if (!st.isFile()) return { key: 'none', size: 0 };
    return { key: `${st.mtimeMs}:${st.ctimeMs}:${st.ino}:${st.size}`, size: st.size };
  } catch (err) {
    // Only a missing file means "no data"; EACCES, EIO and the like say nothing about the file.
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return { key: 'none', size: 0 };
    return { key: '', size: 0, failed: true };
  }
}

/** Read and parse the file as it is now (`now` in epoch seconds). */
export async function readPlanUsage(path: string, now: number): Promise<PlanUsageRead> {
  const st = await statPlanUsage(path);
  if (st.failed) return { key: '', usage: EMPTY_PLAN_USAGE, switches: [], problem: 'unreadable' };
  if (st.key === 'none') return { key: st.key, usage: EMPTY_PLAN_USAGE, switches: [], problem: null };
  if (st.size > PLAN_USAGE_SIZE_CAP) return { key: st.key, usage: EMPTY_PLAN_USAGE, switches: [], problem: 'too-large' };
  let text: string;
  try {
    const buf = await fs.readFile(path);
    // Replaced between the stat and the read: the next poll sees the new key.
    if (buf.length > PLAN_USAGE_SIZE_CAP) return { key: st.key, usage: EMPTY_PLAN_USAGE, switches: [], problem: 'too-large' };
    text = buf.toString('utf8');
  } catch (err) {
    // Gone between the stat and the read (a rename in flight): no data this time.
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return { key: 'none', usage: EMPTY_PLAN_USAGE, switches: [], problem: null };
    return { key: '', usage: EMPTY_PLAN_USAGE, switches: [], problem: 'unreadable' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { key: '', usage: EMPTY_PLAN_USAGE, switches: [], problem: 'not-json' };
  }
  const usage = parsePlanUsage(json, now);
  return usage ? { key: st.key, usage, switches: parseSwitches(json, now), problem: null } : { key: st.key, usage: EMPTY_PLAN_USAGE, switches: [], problem: 'wrong-shape' };
}
