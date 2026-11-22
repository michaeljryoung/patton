/**
 * The page-title backfill: once per launch, for artifact bookmarks with no
 * title learned and not searched in the last 7 days, find where each page was
 * published in the Claude Code transcripts and read its title.
 *
 * `~/.claude/projects` can hold 15 GB, so the search is a low-priority child
 * process (`nice grep -H -o -E`, no shell) over the top-level `*.jsonl` of
 * each project folder (subagent transcripts sit in subfolders and are
 * skipped). One pattern for every publish, whatever the ids, so its cost does
 * not grow with the number of bookmarks (about 30 s for 2.6 GB here); run in
 * sequential batches of at most BATCH_FILES files, each with its own timeout
 * and output cap, so the command line stays far below ARG_MAX and one failed
 * batch keeps the others' results. The output itself names the file, the
 * published path, the page address and (on 95% of real publishes) the version
 * id, whose first number is the publish time in Unix seconds; without it the
 * transcript's mtime stands in.
 *
 * A path can be published under several ids over time, and the reader sees the
 * file as it is now, so a bookmarked id takes the file's `<title>` only when it
 * is the newest publish of that path among all found (publish-order.ts, the
 * rule the live learning shares); an older id of a reused path gets no title.
 * Only whole ids count (shared/artifact-id.ts): a quoted line cut mid-id is not
 * a page. grep sees every kind of text, so a line that opens a JSON string (a
 * tool result's text) outranks one quoted inside other text. No Electron import.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { completeArtifactIdOf, isCompleteArtifactId } from '../shared/artifact-id';
import type { PageTitleBook } from './page-titles';
import { FUTURE_SLACK_MS, NewestPublish, type RankedPublish } from './publish-order';
import { publishPath } from './transcript-parser';

/** Files per grep: 200 paths of ~120 characters is ~24 KB of argv (ARG_MAX 1 MB). */
export const BATCH_FILES = 200;
/** One batch may take a while under nice; past this it is stopped. */
const BATCH_TIMEOUT_MS = 3 * 60 * 1000;
/** One batch's output cap (the real output is ~300 KB for all 501 files here). */
const BATCH_MAX_BYTES = 4 * 1024 * 1024;

/** Every publish line Claude Code writes, with its version id when there is one,
 *  and the one character before it: `"` when the line opens a JSON string (a
 *  tool result's text), else a space or the `n` of an escaped newline (text
 *  quoting it). A publish after any other character is a quote and is not
 *  searched. One fixed character keeps grep fast: an optional prefix doubled
 *  its time (13 s to 28 s on the newest 200 transcripts here, 22 Nov 2026). */
export const PUBLISH_PATTERN = '["n ]Published /[^"\\\\]* at https://claude\\.ai/[^ )"\\\\]+( \\(Version [0-9]+, version id [0-9]+-[0-9a-f]+\\))?';
/** One grep output line: the file, then the character before the publish. */
const LINE_HEAD = /^(.*?):(["n ])(?=Published \/)/;
/** The publishes in one match. The path is lazy, so two publishes in one string
 *  with no quote or escape between are read as two, not merged. */
const PUBLISH_IN = /Published (\/[^"\\]*?) at (https:\/\/claude\.ai\/[^ )"\\]+)(?: \(Version [0-9]+, version id ([0-9]+)-[0-9a-f]+\))?/g;
/** A clock skew allowed between a version id's time and a file's mtime. */
const SKEW_MS = 5 * 60 * 1000;

export interface Transcript { path: string; mtime: number }

/** What `listTranscripts` found; `unreadable` counts folders it could not list
 *  (the projects folder itself included), whose transcripts went unsearched. */
export interface TranscriptListing { files: Transcript[]; unreadable: number }

/** Top-level `*.jsonl` files of each folder in `projectsDir`, newest mtime first. */
export async function listTranscripts(projectsDir: string): Promise<TranscriptListing> {
  const found: Transcript[] = [];
  let unreadable = 0;
  let dirs: import('node:fs').Dirent[];
  try {
    dirs = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { files: [], unreadable: 1 };
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(projectsDir, d.name);
    let files: import('node:fs').Dirent[];
    try {
      files = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      unreadable++;
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
  return { files: found, unreadable };
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
export type FoundPublish = RankedPublish;

/** The publishes in one batch's output, in line order. `mtimes` gives each
 *  file's mtime (ms), the publish time of a line with no believable version id
 *  (none, or one more than FUTURE_SLACK_MS ahead of `now`). */
export function parseGrepOutput(stdout: string, mtimes: ReadonlyMap<string, number>, now: number = Date.now()): FoundPublish[] {
  const out: FoundPublish[] = [];
  for (const line of stdout.split('\n')) {
    const head = line.match(LINE_HEAD);
    if (!head) continue;
    const mtime = mtimes.get(head[1]);
    if (mtime === undefined) continue;
    const body = line.slice(head[0].length);
    for (const m of body.matchAll(PUBLISH_IN)) {
      const id = completeArtifactIdOf(m[2]);
      const path = publishPath(m[1]);
      if (!id || !path) continue;
      const secs = m[3] === undefined ? NaN : Number(m[3]);
      const versioned = Number.isSafeInteger(secs) && secs > 0 && secs * 1000 <= now + FUTURE_SLACK_MS;
      out.push({ id, path, at: versioned ? secs * 1000 : mtime, start: head[2] === '"' && m.index === 0, versioned });
    }
  }
  return out;
}

/** For each wanted id, the path whose current `<title>` is its title: its newest
 *  publish's path, when no other id was published there later (publish-order.ts).
 *  `unsearchedMtime` is the newest mtime of the transcripts not searched (a
 *  failed batch, an unreadable folder): a newer publish could sit there only if
 *  it is older than that file, so a winner counts only when it starts a result,
 *  carries its version time and is newer than every unsearched file. */
export function pathsToRead(found: readonly FoundPublish[], wanted: ReadonlySet<string>, unsearchedMtime = -Infinity): Map<string, string> {
  const newestOfId = new NewestPublish<FoundPublish>((p) => p.id);
  const newestOfPath = new NewestPublish<FoundPublish>((p) => p.path);
  for (const p of found) {
    newestOfId.see(p);
    newestOfPath.see(p);
  }
  const out = new Map<string, string>();
  for (const id of wanted) {
    const pub = newestOfId.get(id);
    if (!pub || newestOfPath.get(pub.path) !== pub) continue;
    if (unsearchedMtime > -Infinity && !(pub.start && pub.versioned && pub.at > unsearchedMtime + SKEW_MS)) continue;
    out.set(id, pub.path);
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

export interface BackfillResult { ids: number; found: number; missed: number; batches: number; failed: number; unreadable: number; ms: number }

/** The ids worth searching: whole page ids (a UUID: Claude Code publishes no
 *  other), no title yet, not missed within 7 days. The store is read once. */
export function idsToSearch(book: PageTitleBook, ids: readonly string[]): string[] {
  const whole = new Set<string>();
  for (const id of ids) if (isCompleteArtifactId(id)) whole.add(id);
  return book.untitled([...whole]);
}

export async function runBackfill(book: PageTitleBook, bookmarkIds: readonly string[], deps: BackfillDeps): Promise<BackfillResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg, data) => console.info(msg, data));
  const run = deps.run ?? runGrep;
  const started = now();
  const ids = idsToSearch(book, bookmarkIds);
  if (ids.length === 0) return { ids: 0, found: 0, missed: 0, batches: 0, failed: 0, unreadable: 0, ms: 0 };
  const { files, unreadable } = await listTranscripts(deps.projectsDir);
  const mtimes = new Map(files.map((f) => [f.path, f.mtime] as const));
  const found: FoundPublish[] = [];
  let batches = 0;
  let failed = 0;
  // The newest mtime of a transcript not searched; an unreadable folder's are unknown.
  let unsearchedMtime = unreadable > 0 ? Infinity : -Infinity;
  for (let i = 0; i < files.length; i += BATCH_FILES) {
    const slice = files.slice(i, i + BATCH_FILES);
    if (deps.signal?.aborted) {
      failed++;
      unsearchedMtime = Math.max(unsearchedMtime, ...files.slice(i).map((f) => f.mtime));
      break;
    }
    batches++;
    try {
      const { stdout } = await run('/usr/bin/nice', grepArgs(slice.map((f) => f.path)), deps.signal);
      found.push(...parseGrepOutput(stdout, mtimes, now()));
    } catch (err) {
      failed++;
      unsearchedMtime = Math.max(unsearchedMtime, ...slice.map((f) => f.mtime));
      log('[TITLE] backfill batch failed', { batch: batches, files: slice.length, ...grepFailure(err) });
    }
  }
  const learned: Array<[string, string]> = [];
  for (const [id, path] of pathsToRead(found, new Set(ids), unsearchedMtime)) {
    if (deps.signal?.aborted) break;
    const title = await book.fileTitle(id, path);
    if (title) learned.push([id, title]);
  }
  book.learnMany(learned, 'backfill');
  const learnedIds = new Set(learned.map(([id]) => id));
  const missed = ids.filter((id) => !learnedIds.has(id));
  // A miss is recorded only when every transcript was searched: a page in a
  // failed batch or an unreadable folder may be there.
  if (failed === 0 && unreadable === 0 && !deps.signal?.aborted) book.recordMisses(missed);
  const result = { ids: ids.length, found: learned.length, missed: missed.length, batches, failed, unreadable, ms: now() - started };
  log('[TITLE] backfill', { ...result });
  return result;
}
