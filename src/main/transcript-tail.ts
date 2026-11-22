/**
 * Follows a transcript file for the session bar (docs/session-bar.md D9): the
 * last 2 MB at start, then every byte appended, through fs.watch plus a 1 s
 * size poll (fs.watch alone misses writes on some volumes and after a rename).
 * Hands raw text to the caller; whole-line parsing is transcript-parser.ts's.
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
}

export class TranscriptTail {
  private offset = 0;
  private decoder = new StringDecoder('utf8');
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private again = false;
  private stopped = false;

  constructor(private readonly path: string, private readonly handlers: TailHandlers) {}

  async start(): Promise<void> {
    let size: number;
    try {
      size = (await fsp.stat(this.path)).size;
    } catch {
      this.handlers.onError('transcript unreadable');
      return;
    }
    this.offset = Math.max(0, size - BACKLOG_BYTES);
    const midFile = this.offset > 0;
    const backlog = await this.readTo(size);
    if (this.stopped) return;
    // Starting mid-file, everything up to the first newline is a cut line.
    let text = backlog;
    if (midFile) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    if (text) this.handlers.onText(text);
    try {
      this.watcher = watch(this.path, { persistent: false }, () => { void this.poll(); });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch {
      this.watcher = null; // the poll still runs
    }
    this.timer = setInterval(() => { void this.poll(); }, POLL_MS);
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
        let size: number;
        try {
          size = (await fsp.stat(this.path)).size;
        } catch {
          this.handlers.onError('transcript gone');
          return;
        }
        if (size < this.offset) {
          // Rewritten shorter: follow from its new end rather than replay it.
          this.handlers.onError('transcript shrank');
          this.offset = size;
          this.decoder = new StringDecoder('utf8');
          continue;
        }
        if (size === this.offset) continue;
        const text = await this.readTo(size);
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
