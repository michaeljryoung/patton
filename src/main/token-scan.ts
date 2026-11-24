/**
 * Counts the tokens of Claude Code's API requests from its transcripts
 * (`~/.claude/projects/**\/*.jsonl`, subagents' files included). Runs inside
 * the token worker (main/token-scan-worker.ts), never on main's thread: a
 * first scan can read gigabytes. No Electron here, so the check runs it under
 * plain Node.
 *
 * A request is an `"type":"assistant"` line with `message.usage`; Claude Code
 * writes the same message several times (once per content block), so one
 * request is one (`message.id`, `requestId`) pair, and a repeat with more
 * tokens raises it to the larger figure. Its tokens are input + cache writes +
 * cache reads + output; its time is the line's ISO `timestamp`.
 *
 * Incremental: each file's inode, byte offset, size, mtime and a fingerprint
 * (a hash of the 256 bytes before the offset) are kept, so a later scan reads
 * only what was appended; a file that shrank, was replaced, or was rewritten in
 * place (its bytes before the offset no longer hash the same) is read from the
 * start again (requests already counted are not counted twice), and a partial
 * last line is left for the next scan. A line past the size cap is skipped, and
 * a file left inside one resumes after that line's newline. Of a request seen
 * in two files, the earliest time is kept. Memory is bounded by the floor: files
 * modified before it are not read, requests before it are dropped.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { TokenRequest } from '../shared/token-credit';

/** Read this much of a file at a time. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** A line longer than this is skipped unread (no assistant line with usage comes near it). */
export const LINE_CAP_BYTES = 32 * 1024 * 1024;
/** The fingerprint covers this many bytes before the saved offset. */
const FINGERPRINT_BYTES = 256;
/** At most this many newly failed files are named in one scan's stats. */
const MAX_REPORTED_ERRORS = 20;
/** A file whose mtime is this close before the floor is still read (clock and write slack). */
const MTIME_SLACK_S = 120;
/** The projects tree is two or three levels deep (project / session / subagents); never walk deeper than this. */
const MAX_DEPTH = 6;
const NEWLINE = 0x0a;
const ASSISTANT_MARK = Buffer.from('"type":"assistant"');
const USAGE_MARK = Buffer.from('"usage"');
const USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'] as const;

export interface ScanStats {
  /** Transcripts modified since the floor. */
  files: number;
  /** Of those, the ones with new bytes read this scan. */
  filesRead: number;
  bytes: number;
  /** Requests held after the scan. */
  requests: number;
  /** Files that could not be read this scan (gone mid-scan, no permission). */
  skipped: number;
  /** Transcripts listed under the root, of any age: 0 means no folder or none in it, so no count. */
  listed: number;
  /** Files that failed to read for a (file, code) not reported before: [file name, error code]. */
  errors: [string, string][];
}

interface FileState {
  ino: number;
  /** Bytes consumed: everything before this ends in a newline, or (with `skipping`) is part of a dropped line. */
  offset: number;
  /** Size and mtime when last read to the end of what was there, to tell an untouched file at a glance. */
  size: number;
  mtimeMs: number;
  /** Hash of the bytes just before `offset` (null at 0). */
  fp: string | null;
  /** The offset is inside a line past the cap: bytes are dropped up to its next newline. */
  skipping: boolean;
}

function freshState(ino: number): FileState {
  return { ino, offset: 0, size: -1, mtimeMs: NaN, fp: null, skipping: false };
}

function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown } | null;
  return typeof e?.code === 'string' ? e.code : typeof e?.name === 'string' ? e.name : 'unknown';
}

/** The hash of the (up to 256) bytes ending at `offset`, or null at offset 0. */
async function fingerprintAt(fh: FileHandle, offset: number): Promise<string | null> {
  if (offset <= 0) return null;
  const len = Math.min(FINGERPRINT_BYTES, offset);
  const buf = Buffer.allocUnsafe(len);
  const { bytesRead } = await fh.read(buf, 0, len, offset - len);
  return createHash('sha1').update(buf.subarray(0, bytesRead)).digest('hex');
}

interface ParsedRequest {
  key: string;
  t: number;
  n: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One transcript line as a request, or null when it is not an assistant line with usage, an id and a time. */
export function requestFromLine(text: string): ParsedRequest | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(o) || o.type !== 'assistant') return null;
  const m = o.message;
  if (!isRecord(m) || !isRecord(m.usage)) return null;
  const id = typeof m.id === 'string' && m.id ? m.id : null;
  if (!id) return null;
  const requestId = typeof o.requestId === 'string' ? o.requestId : '';
  const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) / 1000 : NaN;
  if (!Number.isFinite(t)) return null;
  let n = 0;
  for (const field of USAGE_FIELDS) {
    const v = m.usage[field];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) n += v;
  }
  return { key: `${id}\u0000${requestId}`, t, n };
}

export class TokenScanner {
  private files = new Map<string, FileState>();
  private held = new Map<string, TokenRequest>();
  private floor = -Infinity;
  /** Failures already reported, as "path\0code", so each distinct one is named once. */
  private reported = new Set<string>();

  /** The requests held (each once), for crediting. */
  requests(): Iterable<TokenRequest> {
    return this.held.values();
  }

  /** Read what is new under `root` since the last scan. `floor` (epoch seconds): files modified
   *  before it are not read and requests before it are dropped; a floor earlier than the last
   *  one starts over, since what was skipped may now count. */
  async scan(root: string, floor: number): Promise<ScanStats> {
    if (floor < this.floor) {
      this.files.clear();
      this.held.clear();
    }
    this.floor = floor;
    for (const [key, r] of this.held) if (r.t < floor) this.held.delete(key);

    const stats: ScanStats = { files: 0, filesRead: 0, bytes: 0, requests: 0, skipped: 0, listed: 0, errors: [] };
    const paths = await listTranscripts(root);
    stats.listed = paths.length;
    const seen = new Set<string>();
    const fail = (path: string, err: unknown): void => {
      stats.skipped++;
      const code = errorCode(err);
      const key = `${path}\u0000${code}`;
      if (this.reported.has(key)) return;
      this.reported.add(key);
      if (stats.errors.length < MAX_REPORTED_ERRORS) stats.errors.push([basename(path), code]);
    };
    for (const path of paths) {
      let st;
      try {
        st = await fs.stat(path);
      } catch (err) {
        fail(path, err);
        continue;
      }
      if (!st.isFile() || st.mtimeMs / 1000 < floor - MTIME_SLACK_S) continue;
      seen.add(path);
      stats.files++;
      let state = this.files.get(path);
      if (!state || state.ino !== st.ino || st.size < state.offset) {
        state = freshState(st.ino);
        this.files.set(path, state);
      }
      // Untouched since it was last read (same size and mtime): nothing new, whatever the offset.
      if (state.size === st.size && state.mtimeMs === st.mtimeMs) continue;
      try {
        stats.bytes += await this.readNew(path, state, st.size, st.mtimeMs);
        stats.filesRead++;
        if (this.reported.size > 0) for (const key of [...this.reported]) if (key.startsWith(`${path}\u0000`)) this.reported.delete(key);
      } catch (err) {
        fail(path, err);
      }
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
    const listedSet = new Set(paths);
    for (const key of [...this.reported]) if (!listedSet.has(key.slice(0, key.indexOf('\u0000')))) this.reported.delete(key);
    stats.requests = this.held.size;
    return stats;
  }

  /** Read `path` from its offset up to `size`, taking every complete line; returns the bytes read.
   *  First checks that the bytes before the offset are the ones read before: if not (a rewrite in
   *  place), the file starts over. Only on success are the state's size and mtime brought up to date. */
  private async readNew(path: string, state: FileState, size: number, mtimeMs: number): Promise<number> {
    const fh = await fs.open(path, 'r');
    let read = 0;
    try {
      if (state.offset > 0 && (await fingerprintAt(fh, state.offset)) !== state.fp) {
        state.offset = 0;
        state.fp = null;
        state.skipping = false;
      }
      let pos = state.offset;
      /** Bytes of a line begun in an earlier chunk. */
      let carry: Buffer | null = null;
      /** Inside a line past the cap: its bytes are dropped up to its newline. */
      let skipping = state.skipping;
      while (pos < size) {
        const want = Math.min(CHUNK_BYTES, size - pos);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fh.read(buf, 0, want, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        read += bytesRead;
        const chunk = buf.subarray(0, bytesRead);
        const data: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
        const dataStart = pos - data.length;
        let start = 0;
        let nl = data.indexOf(NEWLINE, start);
        while (nl !== -1) {
          if (!skipping) this.takeLine(data.subarray(start, nl));
          skipping = false;
          start = nl + 1;
          nl = data.indexOf(NEWLINE, start);
        }
        // Consumed up to the last newline; with none in this chunk, the offset stays at the open line's start.
        if (start > 0) state.offset = dataStart + start;
        if (skipping || data.length - start > LINE_CAP_BYTES) {
          // A line past the cap: drop what is held and skip to its newline. All of it is consumed,
          // so the next scan resumes after the newline instead of reading the line again.
          skipping = true;
          carry = null;
          state.offset = pos;
        } else {
          carry = start < data.length ? Buffer.from(data.subarray(start)) : null;
        }
      }
      // A partial last line (no newline yet) stays unconsumed: the next scan reads it whole.
      state.skipping = skipping;
      state.fp = await fingerprintAt(fh, state.offset);
      state.size = size;
      state.mtimeMs = mtimeMs;
    } finally {
      await fh.close();
    }
    return read;
  }

  private takeLine(line: Buffer): void {
    if (line.indexOf(ASSISTANT_MARK) === -1 || line.indexOf(USAGE_MARK) === -1) return;
    const r = requestFromLine(line.toString('utf8'));
    if (!r || r.t < this.floor) return;
    const had = this.held.get(r.key);
    if (!had) {
      this.held.set(r.key, { t: r.t, n: r.n });
      return;
    }
    // The same request again (a later write of the message, or a copy in another file): the larger
    // figure, and the earliest time, which is when it happened.
    if (r.n > had.n) had.n = r.n;
    if (r.t < had.t) had.t = r.t;
  }
}

/** Every `.jsonl` file under `root` (not following links). A missing root is an empty list; an
 *  unreadable root throws, so the scan reports it; an unreadable folder below it is passed over. */
export async function listTranscripts(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0 && (err as { code?: unknown } | null)?.code !== 'ENOENT') throw err;
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(path, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push(path);
      }
    }
  };
  await walk(root, 0);
  return out;
}
