/**
 * The page-title backfill: once per launch, for artifact bookmarks with no
 * title learned and not searched in the last 7 days, find where each page was
 * published in the Claude Code transcripts and read its title.
 *
 * `~/.claude/projects` can hold 15 GB, so the search is one low-priority
 * child process (`nice grep -l -F`, no shell) over the top-level `*.jsonl`
 * of each project folder (subagent transcripts sit in subfolders and are
 * skipped); only the files it names are then read, line by line, and only
 * lines holding an id (or an Artifact call, for its `input.title`) are parsed,
 * by the same parser that follows live transcripts. Newest file first; within
 * a file the last publish wins. No Electron import.
 */
import { execFile } from 'node:child_process';
import { createReadStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ARTIFACT_ID } from '../shared/artifact-id';
import type { PageTitleBook } from './page-titles';
import { TranscriptParser, type PagePublish } from './transcript-parser';

/** The grep may take minutes under nice on a big folder; past this it is stopped. */
const GREP_TIMEOUT_MS = 10 * 60 * 1000;

/** Top-level `*.jsonl` files of each folder in `projectsDir`, newest mtime first. */
export async function listTranscripts(projectsDir: string): Promise<string[]> {
  const found: Array<{ path: string; mtime: number }> = [];
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
  return found.map((f) => f.path);
}

export type GrepRunner = (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export const runGrep: GrepRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 8 * 1024 * 1024, timeout: GREP_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
    if (!err) return resolve({ code: 0, stdout });
    const code = (err as { code?: unknown }).code;
    // Exit 1: no match. Exit 2: an unreadable file, matches still printed.
    if (code === 1 || code === 2) return resolve({ code, stdout: stdout ?? '' });
    reject(err);
  });
});

/** The arguments of the one grep: ids as fixed strings, files after `--`. */
export function grepArgs(ids: readonly string[], files: readonly string[]): string[] {
  const args = ['-n', '10', '/usr/bin/grep', '-l', '-s', '-F'];
  for (const id of ids) args.push('-e', id);
  args.push('--', ...files);
  return args;
}

/** The files naming any of `ids`, in `files`' order. */
export async function grepFiles(ids: readonly string[], files: readonly string[], run: GrepRunner = runGrep): Promise<string[]> {
  if (ids.length === 0 || files.length === 0) return [];
  const { stdout } = await run('/usr/bin/nice', grepArgs(ids, files));
  const hit = new Set(stdout.split('\n').filter(Boolean));
  return files.filter((f) => hit.has(f));
}

/** The last publish of each id in `pending` within one file. */
export async function publishesIn(file: string, pending: ReadonlySet<string>): Promise<Map<string, PagePublish>> {
  const out = new Map<string, PagePublish>();
  const parser = new TranscriptParser({
    home: '',
    onPublish: (p) => { if (pending.has(p.id)) out.set(p.id, p); },
  });
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"Artifact"')) {
      let named = false;
      for (const id of pending) if (line.includes(id)) { named = true; break; }
      if (!named) continue;
    }
    parser.parseLine(line);
  }
  return out;
}

export interface BackfillDeps {
  projectsDir: string;
  run?: GrepRunner;
  log?: (msg: string, data: Record<string, unknown>) => void;
  now?: () => number;
}

export interface BackfillResult { ids: number; found: number; missed: number; ms: number }

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
  const started = now();
  const ids = idsToSearch(book, bookmarkIds);
  if (ids.length === 0) return { ids: 0, found: 0, missed: 0, ms: 0 };
  const files = await listTranscripts(deps.projectsDir);
  const matched = await grepFiles(ids, files, deps.run);
  const pending = new Set(ids);
  let found = 0;
  for (const file of matched) {
    if (pending.size === 0) break;
    let pubs: Map<string, PagePublish>;
    try {
      pubs = await publishesIn(file, pending);
    } catch {
      continue;
    }
    for (const [id, pub] of pubs) {
      pending.delete(id);
      const title = await book.titleOf(pub);
      if (title) {
        book.learn(id, title, 'backfill');
        found++;
      }
    }
  }
  const missed = ids.filter((id) => !book.has(id));
  book.recordMisses(missed);
  const result = { ids: ids.length, found, missed: missed.length, ms: now() - started };
  log('[TITLE] backfill', { ...result });
  return result;
}
