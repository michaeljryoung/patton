/**
 * The recent assistant text blocks of a Claude session's transcript, for
 * copying Claude's original text (copy-match.ts). Bounded reads: the last
 * `maxBytes` of the file at first, then only what was appended since, kept per
 * transcript; at most `maxMessages` blocks, newest last.
 *
 * Line shape (read in real transcripts on this Mac): an `assistant` line holds
 * `message.content`, an array whose `{type: "text", text}` entries are the
 * reply's text blocks, each drawn by Claude Code as its own `⏺` item.
 * Subagent lines (`isSidechain: true`) are never drawn in the pane, so skipped.
 */
import { promises as fsp } from 'node:fs';

export const TEXTS_MAX_BYTES = 8 * 1024 * 1024;
export const TEXTS_MAX_MESSAGES = 200;
const MAX_TEXT_CHARS = 200_000;

interface Cached {
  path: string;
  ino: number;
  /** Bytes read so far: always just past a whole line's newline. */
  size: number;
  texts: string[];
}

export function assistantTexts(line: string): string[] {
  if (!line.includes('"assistant"')) return [];
  let o: unknown;
  try { o = JSON.parse(line); } catch { return []; }
  if (typeof o !== 'object' || o === null) return [];
  const rec = o as { type?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
  if (rec.type !== 'assistant' || rec.isSidechain === true) return [];
  const content = rec.message?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue;
    const blk = b as { type?: unknown; text?: unknown };
    if (blk.type === 'text' && typeof blk.text === 'string' && blk.text.trim() !== '' && blk.text.length <= MAX_TEXT_CHARS) out.push(blk.text);
  }
  return out;
}

export class TranscriptTexts {
  private cached: Cached | null = null;

  constructor(
    private readonly maxBytes = TEXTS_MAX_BYTES,
    private readonly maxMessages = TEXTS_MAX_MESSAGES,
  ) {}

  /** The newest assistant text blocks of `path`, oldest first. */
  async recent(path: string): Promise<string[]> {
    const fh = await fsp.open(path, 'r');
    try {
      const st = await fh.stat();
      let c = this.cached;
      if (!c || c.path !== path || c.ino !== st.ino || st.size < c.size || st.size - c.size > this.maxBytes) {
        const from = Math.max(0, st.size - this.maxBytes);
        const buf = await readRange(fh, from, st.size);
        // Starting mid-file, the first line is cut: skip it.
        const skip = from > 0 ? buf.indexOf(0x0a) + 1 : 0;
        c = { path, ino: st.ino, size: from + skip, texts: [] };
        this.absorb(c, buf.subarray(skip));
        this.cached = c;
      } else if (st.size > c.size) {
        this.absorb(c, await readRange(fh, c.size, st.size));
      }
      return c.texts.slice();
    } finally {
      await fh.close();
    }
  }

  /** Takes the whole lines of `buf` (read from `c.size`); an unfinished last
   *  line, perhaps cut mid-character, is read again next time. */
  private absorb(c: Cached, buf: Buffer): void {
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return;
    c.size += lastNl + 1;
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) c.texts.push(...assistantTexts(line));
    if (c.texts.length > this.maxMessages) c.texts.splice(0, c.texts.length - this.maxMessages);
  }
}

async function readRange(fh: fsp.FileHandle, from: number, to: number): Promise<Buffer> {
  const len = to - from;
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, from + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}
