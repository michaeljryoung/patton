/**
 * The text half of the Send to Drive Lindus check (docs/review-tab.md R8):
 * does a .docx part say "Lindus" as a word? Streaming, so a large file costs
 * neither the main process's memory nor its event loop: each part is inflated
 * a slice at a time (zlib's thread pool, the loop free between slices), its
 * tags stripped as it comes, and only a few characters carried from one slice
 * to the next. Pure Node, no Electron (scripts/check-drive-upload.mjs).
 *
 * "As a word": the match must start a word, so "medical industry" or
 * "Global industry" (whose letters run "l indus" once gaps are dropped) never
 * count, while "Lindus Health", "LindusHealth" and "@lindushealth.com" do.
 * Text runs inside a paragraph join as Word shows them ("Lin" + "dus" is one
 * word); a paragraph, cell, row, tab or line break ends a word.
 */
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createInflateRaw } from 'node:zlib';
import type { ZipEntry } from './docx-zip';

/** "lindus" starting a word, any case. */
export const LINDUS_WORD = /(?<![\p{L}\p{N}_])lindus/iu;
/** Characters kept from one slice for the next: "lindus" less one, and the
 *  character before it. */
const CARRY = 6;
/** Tags that end a word in Word's text: paragraph, cell, row, tab, breaks. */
const GAP_TAGS = new Set(['w:p', 'w:tc', 'w:tr', 'w:tab', 'w:br', 'w:cr', 'w:ptab']);
/** Inflated XML scanned per click, at most; past it the file is "unreadable"
 *  (asked about), never read further. */
export const LINDUS_SCAN_MAX = 256 * 1024 * 1024;
const SLICE = 64 * 1024;

export class ScanTooLarge extends Error {}

/** Feeds of one part's XML, tags stripped, testing for LINDUS_WORD. */
export class TextScanner {
  private inTag = false;
  private name = '';
  private nameDone = false;
  private carry = '';

  /** Feed the next slice; true once the text so far says Lindus. */
  feed(s: string): boolean {
    let text = this.carry;
    let i = 0;
    while (i < s.length) {
      if (this.inTag) {
        const end = s.indexOf('>', i);
        const stop = end === -1 ? s.length : end;
        let j = i;
        while (!this.nameDone && j < stop) {
          const c = s[j];
          if (c === '/' && this.name === '') { j++; continue; }
          if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '/') { this.nameDone = true; break; }
          this.name += c;
          j++;
        }
        if (end === -1) break;
        if (GAP_TAGS.has(this.name)) text += ' ';
        this.inTag = false;
        i = end + 1;
      } else {
        const lt = s.indexOf('<', i);
        if (lt === -1) { text += s.slice(i); break; }
        text += s.slice(i, lt);
        this.inTag = true;
        this.name = '';
        this.nameDone = false;
        i = lt + 1;
      }
    }
    if (LINDUS_WORD.test(text)) return true;
    this.carry = text.slice(-CARRY);
    return false;
  }
}

/** Raw XML (properties: attribute values count too), testing for LINDUS_WORD. */
class RawScanner {
  private carry = '';
  feed(s: string): boolean {
    const text = this.carry + s;
    if (LINDUS_WORD.test(text)) return true;
    this.carry = text.slice(-CARRY);
    return false;
  }
}

async function* slicesOf(buf: Buffer): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += SLICE) yield buf.subarray(i, i + SLICE);
}

/** An entry's uncompressed bytes, a slice at a time; never more than its
 *  declared size (a lying header is refused) or the budget left. */
async function* chunksOf(entry: ZipEntry, budget: { left: number }): AsyncGenerator<Buffer> {
  let seen = 0;
  const take = (n: number): void => {
    seen += n;
    budget.left -= n;
    if (seen > entry.size) throw new ScanTooLarge(`${entry.name} inflates past its declared size`);
    if (budget.left < 0) throw new ScanTooLarge('too much text to check');
  };
  if (entry.method === 0) {
    for (let i = 0; i < entry.raw.length; i += SLICE) {
      const chunk = entry.raw.subarray(i, i + SLICE);
      take(chunk.length);
      yield chunk;
      await nextTurn();
    }
    return;
  }
  const src = Readable.from(slicesOf(entry.raw));
  const inflate = createInflateRaw({ chunkSize: SLICE });
  src.pipe(inflate);
  try {
    for await (const chunk of inflate as AsyncIterable<Buffer>) {
      take(chunk.length);
      yield chunk;
    }
  } finally {
    src.destroy();
    inflate.destroy();
  }
}

/** Whether a part says Lindus as a word: its text (tags stripped) or, with
 *  `raw`, the XML as it is. Throws ScanTooLarge or zlib's error. */
export async function partSaysLindus(entry: ZipEntry, budget: { left: number }, raw = false): Promise<boolean> {
  const scanner = raw ? new RawScanner() : new TextScanner();
  const decoder = new StringDecoder('utf8');
  for await (const chunk of chunksOf(entry, budget)) {
    if (scanner.feed(decoder.write(chunk))) return true;
  }
  return scanner.feed(decoder.end());
}
