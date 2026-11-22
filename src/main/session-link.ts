/**
 * The session bar's session link (docs/session-bar.md D8): from a pane's shell
 * pid to the Claude Code session running under it and its transcript.
 *
 * - The Claude process is the shell's descendant (or the shell itself, after
 *   `exec claude`) whose pid has `~/.claude/sessions/<pid>.json`; the nearest
 *   one to the shell wins. One `/bin/ps -A -o pid=,ppid=,args=` per resolve.
 * - A sessions file counts only while its pid runs Claude Code (G): the
 *   program, or the script it runs, is named `claude` (`claude …` for the
 *   native install, `node …/claude …` for npm). A stale file whose pid was
 *   reused by another program is ignored.
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

export interface ProcRow {
  pid: number;
  ppid: number;
  /** The command line names Claude Code (absent: unknown, as from an older caller). */
  claude?: boolean;
}

export interface ResolvedSession {
  claudePid: number;
  sessionId: string;
  /** `~/.claude/sessions/<pid>.json`, realpath. */
  sessionsFile: string;
  /** The transcript, realpath; null while Claude Code hasn't written one yet. */
  transcriptPath: string | null;
  /** The session's cwd from its sessions file ('' when absent). */
  cwd: string;
}

export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), '.claude');
}

/** One `ps` for the whole process table (the absolute path, so a `ps` on
 *  PATH can't answer for it). ~270 KB of output on this Mac, 22 Nov 2026. */
export function listProcesses(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,args='], { timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) { resolve([]); return; }
      resolve(parsePs(stdout));
    });
  });
}

export function parsePs(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), claude: isClaudeCommand(m[3] ?? '') });
  }
  return rows;
}

/** The last path segment of one command-line word. */
function wordName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1).toLowerCase();
}

/** A command line that runs Claude Code: its program is named `claude…`; or
 *  an interpreter runs a script named `claude…`; or node, bun or deno runs a
 *  script under a `claude…` folder (npm's `@anthropic-ai/claude-code/cli.js`). */
export function isClaudeCommand(args: string): boolean {
  const words = args.trim().split(/\s+/, 2);
  if (!words[0]) return false;
  if (wordName(words[0]).startsWith('claude')) return true;
  if (words.length < 2) return false;
  const runner = wordName(words[0]);
  if (/^(?:node|bun|deno|sh|bash|zsh)$/.test(runner) && wordName(words[1]).startsWith('claude')) return true;
  return /^(?:node|bun|deno)$/.test(runner) && /(?:^|\/)claude[^/]*\//i.test(words[1]);
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

/** `sessionId` (and `cwd`) from `~/.claude/sessions/<pid>.json`, or null. */
export async function readSessionsFile(home: string, pid: number): Promise<{ sessionId: string; file: string; cwd: string } | null> {
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
    const cwd = typeof obj.cwd === 'string' && obj.cwd.length <= 4096 ? obj.cwd : '';
    return { sessionId: id, file, cwd };
  } catch {
    return null;
  }
}

/** Claude Code's folder name for a project: the cwd with every character
 *  but a letter or digit turned into `-` (5 of 5 live sessions here). */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** The transcript in the cwd's own project folder: one stat, cheap enough to
 *  repeat every second while a new session hasn't written its first line. */
export async function transcriptInCwdFolder(home: string, sessionId: string, cwd: string): Promise<string | null> {
  if (!SESSION_ID.test(sessionId) || !cwd.startsWith('/')) return null;
  const projects = join(home, 'projects');
  return realpathInside(join(projects, projectDirName(cwd), `${sessionId}.jsonl`), projects);
}

/** `~/.claude/projects/<any>/<sessionId>.jsonl`, realpath: the cwd's folder
 *  first, else the newest match in any folder. */
export async function findTranscript(home: string, sessionId: string, cwd = ''): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const direct = cwd ? await transcriptInCwdFolder(home, sessionId, cwd) : null;
  if (direct) return direct;
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
  const notClaude = new Set(table.filter((r) => r.claude === false).map((r) => r.pid));
  for (const pid of descendantsOf(shellPid, table)) {
    if (notClaude.has(pid)) continue; // a stale sessions file, its pid reused (G)
    const found = await readSessionsFile(home, pid);
    if (!found) continue;
    return {
      claudePid: pid,
      sessionId: found.sessionId,
      sessionsFile: found.file,
      transcriptPath: await findTranscript(home, found.sessionId, found.cwd),
      cwd: found.cwd,
    };
  }
  return null;
}
