/**
 * The page-title backfill: once per launch, for artifact bookmarks with no
 * title learned and not searched in the last 7 days, find where each page was
 * published in the Claude Code transcripts and read its title.
 *
 * `~/.claude/projects` can hold 15 GB, so the search is a low-priority child
 * process (`nice grep -H -o -E`, no shell) over the top-level `*.jsonl` of
 * each project folder (subagent transcripts sit in subfolders and are
 * skipped). One pattern for every publish, whatever the ids, so its cost does
 * not grow with the number of bookmarks (about 20 s for 2.6 GB here); run in
 * sequential batches of at most BATCH_FILES files, each with its own timeout
 * and output cap, so the command line stays far below ARG_MAX and one failed
 * batch keeps the others' results. The output itself names the file, the
 * published path, the page address and (on 95% of real publishes) the version
 * id, whose first number is the publish time in Unix seconds; without it the
 * transcript's mtime stands in.
 *
 * A path can be published under several ids over time, and the reader sees the
 * file as it is now, so a bookmarked id takes the file's `<title>` only when it
 * is the newest publish of that path among all found; an older id of a reused
 * path gets no title. No Electron import.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_ID, artifactIdOf } from '../shared/artifact-id';
import type { PageTitleBook } from './page-titles';
import { publishPath } from './transcript-parser';

/** Files per grep: 200 paths of ~120 characters is ~24 KB of argv (ARG_MAX 1 MB). */
export const BATCH_FILES = 200;
/** One batch may take a while under nice; past this it is stopped. */
const BATCH_TIMEOUT_MS = 3 * 60 * 1000;
/** One batch's output cap (the real output is ~300 KB for all 501 files here). */
const BATCH_MAX_BYTES = 4 * 1024 * 1024;

/** Every publish line Claude Code writes, with its version id when there is one. */
export const PUBLISH_PATTERN = 'Published /[^"\\\\]* at https://claude\\.ai/[^ )"\\\\]+( \\(Version [0-9]+, version id [0-9]+-[0-9a-f]+\\))?';
const PUBLISH_LINE = /^Published (\/[^"\\]*) at (https:\/\/claude\.ai\/[^ )"\\]+)(?: \(Version [0-9]+, version id ([0-9]+)-[0-9a-f]+\))?$/;

export interface Transcript { path: string; mtime: number }

/** Top-level `*.jsonl` files of each folder in `projectsDir`, newest mtime first. */
export async function listTranscripts(projectsDir: string): Promise<Transcript[]> {
  const found: Transcript[] = [];
  let dirs: import('node:fs').Dirent[];
  try {
    dirs = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(projectsDir, d.name);
    let files: import('node:fs').Dirent[];
    try {
      files = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const path = join(dir, f.name);
      try {
        found.push({ path, mtime: (await fsp.stat(path)).mtimeMs });
      } catch {
        // gone since the listing
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

export type GrepRunner = (file: string, args: string[], signal?: AbortSignal) => Promise<{ code: number; stdout: string }>;

/** A grep that failed: what may be logged (never its message, which holds the whole argv). */
export interface GrepFailure { code: string | number | null; killed: boolean; signal: string | null }

export function grepFailure(err: unknown): GrepFailure {
  const e = (err ?? {}) as { code?: unknown; killed?: unknown; signal?: unknown };
  const code = typeof e.code === 'string' || typeof e.code === 'number' ? e.code : null;
  return { code, killed: e.killed === true, signal: typeof e.signal === 'string' ? e.signal : null };
}

export const runGrep: GrepRunner = (file, args, signal) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: BATCH_MAX_BYTES, timeout: BATCH_TIMEOUT_MS, encoding: 'utf8', signal }, (err, stdout) => {
    if (!err) return resolve({ code: 0, stdout });
    const code = (err as { code?: unknown }).code;
    // Exit 1: no match. Exit 2: an unreadable file, matches still printed.
    if (code === 1 || code === 2) return resolve({ code, stdout: stdout ?? '' });
    reject(err);
  });
});

/** The arguments of one batch's grep: the one publish pattern, files after `--`. */
export function grepArgs(files: readonly string[]): string[] {
  return ['-n', '10', '/usr/bin/grep', '-H', '-o', '-s', '-E', '-e', PUBLISH_PATTERN, '--', ...files];
}

/** One publish the search found. */
export interface FoundPublish { id: string; path: string; at: number }

/** The publishes in one batch's output. `mtimes` gives each file's mtime (ms),
 *  the publish time of a line with no version id. */
export function parseGrepOutput(stdout: string, mtimes: ReadonlyMap<string, number>): FoundPublish[] {
  const out: FoundPublish[] = [];
  for (const line of stdout.split('\n')) {
    const cut = line.indexOf(':Published /');
    if (cut < 0) continue;
    const mtime = mtimes.get(line.slice(0, cut));
    if (mtime === undefined) continue;
    const m = line.slice(cut + 1).match(PUBLISH_LINE);
    if (!m) continue;
    const id = artifactIdOf(m[2]);
    const path = publishPath(m[1]);
    if (!id || !path) continue;
    const secs = m[3] === undefined ? NaN : Number(m[3]);
    out.push({ id, path, at: Number.isSafeInteger(secs) && secs > 0 ? secs * 1000 : mtime });
  }
  return out;
}

/** For each wanted id, the path whose current `<title>` is its title: its newest
 *  publish's path, when no other id was published there later. */
export function pathsToRead(found: readonly FoundPublish[], wanted: ReadonlySet<string>): Map<string, string> {
  const newestOfId = new Map<string, FoundPublish>();
  const newestOfPath = new Map<string, FoundPublish>();
  for (const p of found) {
    const byId = newestOfId.get(p.id);
    if (!byId || p.at > byId.at) newestOfId.set(p.id, p);
    const byPath = newestOfPath.get(p.path);
    if (!byPath || p.at > byPath.at) newestOfPath.set(p.path, p);
  }
  const out = new Map<string, string>();
  for (const id of wanted) {
    const pub = newestOfId.get(id);
    if (pub && newestOfPath.get(pub.path)?.id === id) out.set(id, pub.path);
  }
  return out;
}

export interface BackfillDeps {
  projectsDir: string;
  run?: GrepRunner;
  /** Aborted on quit: the running grep is killed and no further batch starts. */
  signal?: AbortSignal;
  log?: (msg: string, data: Record<string, unknown>) => void;
  now?: () => number;
}

export interface BackfillResult { ids: number; found: number; missed: number; batches: number; failed: number; ms: number }

/** The ids worth searching: well-formed, no title yet, not missed within 7 days. */
export function idsToSearch(book: PageTitleBook, ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!ARTIFACT_ID.test(id) || out.includes(id)) continue;
    if (book.has(id) || book.missedRecently(id)) continue;
    out.push(id);
  }
  return out;
}

export async function runBackfill(book: PageTitleBook, bookmarkIds: readonly string[], deps: BackfillDeps): Promise<BackfillResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg, data) => console.info(msg, data));
  const run = deps.run ?? runGrep;
  const started = now();
  const ids = idsToSearch(book, bookmarkIds);
  if (ids.length === 0) return { ids: 0, found: 0, missed: 0, batches: 0, failed: 0, ms: 0 };
  const files = await listTranscripts(deps.projectsDir);
  const mtimes = new Map(files.map((f) => [f.path, f.mtime] as const));
  const found: FoundPublish[] = [];
  let batches = 0;
  let failed = 0;
  for (let i = 0; i < files.length; i += BATCH_FILES) {
    if (deps.signal?.aborted) { failed++; break; }
    const batch = files.slice(i, i + BATCH_FILES).map((f) => f.path);
    batches++;
    try {
      const { stdout } = await run('/usr/bin/nice', grepArgs(batch), deps.signal);
      found.push(...parseGrepOutput(stdout, mtimes));
    } catch (err) {
      failed++;
      log('[TITLE] backfill batch failed', { batch: batches, files: batch.length, ...grepFailure(err) });
    }
  }
  const learned: Array<[string, string]> = [];
  for (const [id, path] of pathsToRead(found, new Set(ids))) {
    if (deps.signal?.aborted) break;
    const title = await book.fileTitle(id, path);
    if (title) learned.push([id, title]);
  }
  book.learnMany(learned, 'backfill');
  const missed = ids.filter((id) => !book.has(id));
  // A miss is recorded only when every batch finished: a page in a failed one may be there.
  if (failed === 0 && !deps.signal?.aborted) book.recordMisses(missed);
  const result = { ids: ids.length, found: learned.length, missed: missed.length, batches, failed, ms: now() - started };
  log('[TITLE] backfill', { ...result });
  return result;
}
