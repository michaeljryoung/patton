/**
 * Follows a transcript file for the session bar (docs/session-bar.md D9): the
 * last 2 MB at start, then every byte appended, through fs.watch plus a 1 s
 * size poll (fs.watch alone misses writes on some volumes and after a rename).
 * Hands raw text to the caller; whole-line parsing is transcript-parser.ts's.
 *
 * A poll reads at most BACKLOG_BYTES. When the file is replaced (another
 * inode), shrinks below what was read, or grows by more than BACKLOG_BYTES at
 * once, the tail re-attaches: it reads the last BACKLOG_BYTES, skips the cut
 * first line, and calls `onReset` first so the caller drops its partial line.
 */
import { watch, type FSWatcher, promises as fsp } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export const BACKLOG_BYTES = 2 * 1024 * 1024;
const READ_CHUNK = 1024 * 1024;
const POLL_MS = 1000;

export interface TailHandlers {
  /** Text read from the file, in order. The first call is the backlog. */
  onText: (text: string) => void;
  onError: (why: string) => void;
  /** The next text no longer continues the last (a re-attach): drop any partial line. */
  onReset?: (why: string) => void;
}

export class TranscriptTail {
  private offset = 0;
  private ino = -1;
  private decoder = new StringDecoder('utf8');
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private again = false;
  private stopped = false;

  constructor(private readonly path: string, private readonly handlers: TailHandlers) {}

  /** False when the file can't be read: nothing is followed, and the caller
   *  should drop this tail (D). */
  async start(): Promise<boolean> {
    let st: { size: number; ino: number };
    try {
      st = await fsp.stat(this.path);
    } catch {
      this.handlers.onError('transcript unreadable');
      return false;
    }
    if (await this.refuseSymlink()) return false;
    await this.readBacklog(st);
    if (this.stopped) return true;
    try {
      this.watcher = watch(this.path, { persistent: false }, () => { void this.poll(); });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch {
      this.watcher = null; // the poll still runs
    }
    this.timer = setInterval(() => { void this.poll(); }, POLL_MS);
    return true;
  }

  /** The path was checked as a real file inside ~/.claude/projects before the
   *  attach; one swapped for a symbolic link since then is refused, and the tail
   *  stops (a link could lead anywhere the user can read). */
  private async refuseSymlink(): Promise<boolean> {
    let link = false;
    try {
      link = (await fsp.lstat(this.path)).isSymbolicLink();
    } catch {
      return false; // gone: the caller's stat already said so
    }
    if (!link) return false;
    this.stop();
    this.handlers.onError('transcript is a symlink');
    return true;
  }

  /** The last BACKLOG_BYTES of the file, without the cut first line. */
  private async readBacklog(st: { size: number; ino: number }): Promise<void> {
    this.ino = st.ino;
    this.decoder = new StringDecoder('utf8');
    this.offset = Math.max(0, st.size - BACKLOG_BYTES);
    const midFile = this.offset > 0;
    let text = await this.readTo(st.size);
    if (this.stopped) return;
    // Starting mid-file, everything up to the first newline is a cut line.
    if (midFile) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    if (text) this.handlers.onText(text);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  /** Read whatever was appended since the last read. */
  async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    try {
      do {
        this.again = false;
        let st: { size: number; ino: number };
        try {
          st = await fsp.stat(this.path);
        } catch {
          this.handlers.onError('transcript gone');
          return;
        }
        const why = st.ino !== this.ino ? 'transcript replaced'
          : st.size < this.offset ? 'transcript shrank'
            : st.size - this.offset > BACKLOG_BYTES ? 'transcript jumped' : '';
        if (why === 'transcript replaced' && (await this.refuseSymlink())) return;
        if (why) {
          // Re-attach (E): the last 2 MB, never the whole file in one poll.
          this.handlers.onError(why);
          this.handlers.onReset?.(why);
          await this.readBacklog(st);
          continue;
        }
        if (st.size === this.offset) continue;
        const text = await this.readTo(st.size);
        if (!this.stopped && text) this.handlers.onText(text);
      } while (this.again && !this.stopped);
    } finally {
      this.reading = false;
    }
  }

  private async readTo(end: number): Promise<string> {
    let out = '';
    let fh: fsp.FileHandle | null = null;
    try {
      fh = await fsp.open(this.path, 'r');
      while (this.offset < end && !this.stopped) {
        const len = Math.min(READ_CHUNK, end - this.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.offset);
        if (bytesRead <= 0) break;
        this.offset += bytesRead;
        out += this.decoder.write(buf.subarray(0, bytesRead));
      }
    } catch {
      this.handlers.onError('transcript read failed');
    } finally {
      await fh?.close().catch((): void => undefined);
    }
    return out;
  }
}
