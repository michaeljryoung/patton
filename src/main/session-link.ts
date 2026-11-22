/**
 * The session bar's session link (docs/session-bar.md D8): from a pane's shell
 * pid to the Claude Code session running under it and its transcript.
 *
 * - The Claude process is the shell's descendant (or the shell itself, after
 *   `exec claude`) whose pid has `~/.claude/sessions/<pid>.json`; the nearest
 *   one to the shell wins. One `ps -A -o pid=,ppid=` per resolve.
 * - That file (read on this Mac, 22 Nov 2026: `pid`, `sessionId`, `cwd`,
 *   `status`, `updatedAt`, …) names `sessionId`; a file whose `pid` field
 *   disagrees with its name is ignored.
 * - The transcript is `~/.claude/projects/<any>/<sessionId>.jsonl`, realpath
 *   inside `~/.claude/projects`.
 *
 * Threat (D12): read-only; every path realpath-checked inside `~/.claude`;
 * the session id is checked to a plain token before it names a file, so a
 * hostile sessions file can't point the feed anywhere else. HOME comes from
 * the environment, so the checks can point it at a temporary folder.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';

const SESSION_ID = /^[A-Za-z0-9_-]{8,100}$/;
const SESSIONS_FILE_MAX = 256 * 1024;

export interface ProcRow { pid: number; ppid: number }

export interface ResolvedSession {
  claudePid: number;
  sessionId: string;
  /** `~/.claude/sessions/<pid>.json`, realpath. */
  sessionsFile: string;
  /** The transcript, realpath; null while Claude Code hasn't written one yet. */
  transcriptPath: string | null;
}

export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), '.claude');
}

/** One `ps` for the whole process table. */
export function listProcesses(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) { resolve([]); return; }
      resolve(parsePs(stdout));
    });
  });
}

export function parsePs(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return rows;
}

/** The root and its descendants, nearest first. */
export function descendantsOf(root: number, table: ProcRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const { pid, ppid } of table) {
    if (pid === ppid) continue;
    const list = children.get(ppid);
    if (list) list.push(pid); else children.set(ppid, [pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const queue = [root];
  while (queue.length > 0 && out.length < 10000) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const c of children.get(pid) ?? []) queue.push(c);
  }
  return out;
}

async function realpathInside(path: string, dir: string): Promise<string | null> {
  try {
    const [real, realDir] = await Promise.all([fsp.realpath(path), fsp.realpath(dir)]);
    if (!real.startsWith(realDir + sep)) return null;
    const st = await fsp.stat(real);
    return st.isFile() ? real : null;
  } catch {
    return null;
  }
}

/** `sessionId` from `~/.claude/sessions/<pid>.json`, or null. */
export async function readSessionsFile(home: string, pid: number): Promise<{ sessionId: string; file: string } | null> {
  const dir = join(home, 'sessions');
  const file = await realpathInside(join(dir, `${pid}.json`), dir);
  if (!file) return null;
  try {
    const st = await fsp.stat(file);
    if (st.size > SESSIONS_FILE_MAX) return null;
    const obj = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
    if (typeof obj.pid === 'number' && obj.pid !== pid) return null;
    const id = obj.sessionId;
    if (typeof id !== 'string' || !SESSION_ID.test(id)) return null;
    return { sessionId: id, file };
  } catch {
    return null;
  }
}

/** `~/.claude/projects/<any>/<sessionId>.jsonl`, realpath; the newest if several. */
export async function findTranscript(home: string, sessionId: string): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const projects = join(home, 'projects');
  let dirs: string[];
  try {
    dirs = await fsp.readdir(projects);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const d of dirs) {
    const candidate = join(projects, d, `${sessionId}.jsonl`);
    const real = await realpathInside(candidate, projects);
    if (!real) continue;
    try {
      const st = await fsp.stat(real);
      if (!best || st.mtimeMs > best.mtime) best = { path: real, mtime: st.mtimeMs };
    } catch {
      // vanished between the two calls
    }
  }
  return best?.path ?? null;
}

/** A transcript path from the Stop hook (`tp`): accepted only when it is a
 *  `<session>.jsonl` file whose realpath sits inside `~/.claude/projects`. */
export async function checkTranscriptPath(home: string, path: unknown): Promise<{ path: string; sessionId: string } | null> {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || !path.startsWith('/')) return null;
  if (!path.endsWith('.jsonl')) return null;
  const real = await realpathInside(path, join(home, 'projects'));
  if (!real) return null;
  const id = basename(real, '.jsonl');
  return SESSION_ID.test(id) ? { path: real, sessionId: id } : null;
}

/** The Claude session under a shell, or null when none is running. */
export async function resolveSession(
  shellPid: number,
  home: string,
  ps: () => Promise<ProcRow[]> = listProcesses,
): Promise<ResolvedSession | null> {
  const table = await ps();
  for (const pid of descendantsOf(shellPid, table)) {
    const found = await readSessionsFile(home, pid);
    if (!found) continue;
    return {
      claudePid: pid,
      sessionId: found.sessionId,
      sessionsFile: found.file,
      transcriptPath: await findTranscript(home, found.sessionId),
    };
  }
  return null;
}
