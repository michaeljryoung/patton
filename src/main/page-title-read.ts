/**
 * Reading a published page's `<title>` (page titles, main/page-titles.ts).
 * The path comes from transcript text, which is untrusted, so the reader
 * takes only an absolute path to a regular `.html` / `.htm` file and reads at
 * most its first TITLE_READ_BYTES through one file handle (opened without
 * blocking, so a FIFO can't hang it; the type is checked on that handle, so
 * the file can't be swapped between check and read). No Electron import.
 */
import { constants, promises as fsp } from 'node:fs';
import { cleanText } from './transcript-parser';

export const TITLE_MAX = 80;
export const TITLE_READ_BYTES = 8192;
const PATH_MAX = 1024;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the few entities a title uses: named amp/lt/gt/quot/apos, &#NNN; and &#xHH;. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** The page title in the start of an HTML file: '' when there is none. */
export function titleFromHtml(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return cleanText(decodeEntities(m[1]), TITLE_MAX);
}

/** `title` when found; otherwise `reason` says why not. */
export interface TitleRead { title: string; reason: string | null }

const refused = (reason: string): TitleRead => ({ title: '', reason });

/** The `<title>` of the page at `path`. A refusal says why (never the path). */
export async function readPageTitle(path: unknown): Promise<TitleRead> {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > PATH_MAX || path.includes('\0')) {
    return refused('not-absolute');
  }
  if (!/\.html?$/i.test(path)) return refused('not-html');
  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile()) return refused('not-a-file');
    const buf = Buffer.alloc(TITLE_READ_BYTES);
    let got = 0;
    while (got < TITLE_READ_BYTES) {
      const { bytesRead } = await fh.read(buf, got, TITLE_READ_BYTES - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    const title = titleFromHtml(buf.subarray(0, got).toString('utf8'));
    return title ? { title, reason: null } : refused('no-title');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return refused(code === 'ENOENT' ? 'missing' : code === 'EISDIR' ? 'not-a-file' : 'read-failed');
  } finally {
    await fh?.close().catch((): void => undefined);
  }
}
