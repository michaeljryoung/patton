/**
 * The review tab's main half (docs/review-tab.md): which documents each
 * window has open, their layout, comments, Open in Word and Send to Drive.
 *
 * A document enters only through the file-link handler (ipc-handlers.ts),
 * after link-open-policy.ts decided it may open (realpath, regular file, not
 * executable, `.docx`; `.docm` is revealed). Main keeps the real path under
 * an opaque id per window; the renderer sends back only the id, so a
 * compromised page can't name another file to write comments into or upload.
 * Every action re-checks the path (still a regular `.docx`, not executable).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync, unwatchFile, watchFile, type Stats } from 'node:fs';
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { app, ipcMain, shell, type WebContents } from 'electron';
import { REVIEW_COMMENT_MAX, REVIEW_IPC, REVIEW_QUOTE_MAX, type ReviewAddReply, type ReviewComment, type ReviewDocInfo, type ReviewDriveReply, type ReviewLayoutReply } from '../shared/review';
import { addComment, initialsOf, listComments } from './docx-comments';
import { readZip, writeZip, ZipError } from './docx-zip';
import { isLindusPath, sendToDrive } from './drive-upload';
import { extensionOf } from './link-open-policy';
import { layout, type LayoutFailure } from './review-layout';
import * as store from './store';

interface OpenDoc {
  real: string;
  owner: WebContents;
  watching: boolean;
}

const docs = new Map<string, OpenDoc>();

function shownPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The path as the log may show it: `~/…`, else only its name. */
function logPath(path: string): string {
  const shown = shownPath(path);
  return shown.startsWith('~') ? shown : basename(path);
}

/** Still the regular, non-executable .docx it was when opened. */
function stillReviewable(real: string): boolean {
  try {
    const st = statSync(real);
    return st.isFile() && (st.mode & 0o111) === 0 && extensionOf(real) === 'docx';
  } catch {
    return false;
  }
}

const LAYOUT_MESSAGES: Record<LayoutFailure, string> = {
  'no-soffice': 'LibreOffice is needed to lay this document out, and it is not installed (brew install --cask libreoffice).',
  'too-large': 'This file is over 50 MB, too large to lay out here.',
  macros: 'This file holds macros, so Patton will not lay it out.',
  'not-docx': 'This file is not a Word document Patton can read.',
  timeout: 'LibreOffice took too long to lay this document out.',
  failed: 'LibreOffice could not lay this document out.',
  missing: 'The file is no longer there: moved, renamed or deleted. The pages shown are the last laid out; they show again if it comes back where it was.',
};

let authorName: string | null = null;
/** The comment's author: the account's full name (`id -F`), else its user name. */
function author(): string {
  if (authorName !== null) return authorName;
  try {
    authorName = execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch { authorName = ''; }
  if (!authorName) authorName = userInfo().username;
  return authorName;
}

/** Word holds the file open (its owner file `~$…` sits beside it). */
export function wordHoldsOpen(real: string): boolean {
  const dir = dirname(real);
  const name = basename(real);
  return [name, name.slice(1), name.slice(2)].some((n) => n && existsSync(join(dir, `~$${n}`)));
}

function watch(docId: string, doc: OpenDoc): void {
  if (doc.watching) return;
  doc.watching = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // What the file was at the last poll, by our own count: Node's `prev` is the
  // last stats it saw of a present file, so a file renamed away and back (the
  // same mtime and size) would look unchanged against it and the tab would
  // keep saying the file is gone.
  const keyOf = (st: Stats | null): string => (st && st.mtimeMs > 0 ? `${st.ino}:${st.mtimeMs}:${st.size}` : 'missing');
  let last = keyOf((() => { try { return statSync(doc.real); } catch { return null; } })());
  // Polled, not fs.watch: an editor that saves by replacing the file (as
  // Patton's own comment writer does) ends an fs.watch on the old inode.
  watchFile(doc.real, { interval: 1000, persistent: false }, (cur: Stats) => {
    const now = keyOf(cur);
    if (now === last) return;
    last = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!docs.has(docId) || doc.owner.isDestroyed()) return;
      console.info('[REVIEW] file changed', { path: logPath(doc.real) });
      doc.owner.send(REVIEW_IPC.CHANGED, docId);
    }, 400);
  });
}

function forget(docId: string): void {
  const doc = docs.get(docId);
  if (!doc) return;
  docs.delete(docId);
  if (doc.watching && ![...docs.values()].some((d) => d.real === doc.real && d.watching)) unwatchFile(doc.real);
}

/** Open a review tab in the window that asked (from the file-link handler). */
export function openReview(sender: WebContents, real: string): void {
  const docId = randomUUID();
  const doc: OpenDoc = { real, owner: sender, watching: false };
  docs.set(docId, doc);
  sender.once('destroyed', () => forget(docId));
  const info: ReviewDocInfo = { docId, name: basename(real), shownPath: shownPath(real), lindus: isLindusPath(real, homedir()) };
  console.info('[REVIEW] open', { path: logPath(real), lindus: info.lindus });
  sender.send(REVIEW_IPC.OPEN, info);
}

function docFor(sender: WebContents, docId: unknown): OpenDoc | null {
  if (typeof docId !== 'string') return null;
  const doc = docs.get(docId);
  if (!doc || doc.owner !== sender) return null;
  return doc;
}

function reviewDirs(): { profileDir: string; cacheDir: string; tmpDir: string } {
  const base = join(app.getPath('userData'), 'review');
  return { profileDir: join(base, 'lo-profile'), cacheDir: join(base, 'cache'), tmpDir: tmpdir() };
}

/** Write the file through a temporary file beside it, then rename (atomic). */
async function replaceFile(real: string, bytes: Buffer): Promise<void> {
  const before = await stat(real);
  const tmp = join(dirname(real), `.${basename(real)}.patton-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(tmp, bytes, { mode: before.mode & 0o666, flag: 'wx' });
    await chmod(tmp, before.mode & 0o666);
    await rename(tmp, real);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function registerReviewHandlers(): void {
  ipcMain.handle(REVIEW_IPC.LAYOUT, async (event, docId: unknown): Promise<ReviewLayoutReply> => {
    const doc = docFor(event.sender, docId);
    if (!doc) return { ok: false, why: 'unknown', message: 'This document is no longer open.' };
    if (!stillReviewable(doc.real)) return { ok: false, why: 'missing', message: LAYOUT_MESSAGES.missing };
    watch(docId as string, doc);
    const result = await layout(doc.real, reviewDirs());
    if (result.ok === false) {
      console.warn('[REVIEW] layout failed', { why: result.why, path: logPath(doc.real), ...(result.detail ? { detail: result.detail } : {}) });
      return { ok: false, why: result.why, message: LAYOUT_MESSAGES[result.why] };
    }
    const pdf = await readFile(result.pdfPath);
    console.info('[REVIEW] layout', { ms: result.ms, cached: result.cached, bytes: pdf.length });
    return { ok: true, pdf: new Uint8Array(pdf), version: `${result.mtimeMs}:${result.size}`, ms: result.ms, cached: result.cached };
  });

  ipcMain.handle(REVIEW_IPC.COMMENTS, async (event, docId: unknown): Promise<ReviewComment[]> => {
    const doc = docFor(event.sender, docId);
    if (!doc || !stillReviewable(doc.real)) return [];
    try {
      return listComments(readZip(await readFile(doc.real)));
    } catch (err) {
      console.warn('[REVIEW] comments unreadable', { error: err instanceof ZipError ? err.message : 'read failed' });
      return [];
    }
  });

  ipcMain.handle(REVIEW_IPC.ADD_COMMENT, async (event, docId: unknown, raw: unknown): Promise<ReviewAddReply> => {
    const doc = docFor(event.sender, docId);
    if (!doc) return { ok: false, why: 'unknown', message: 'This document is no longer open.' };
    const c = raw as { quote?: unknown; occurrence?: unknown; text?: unknown } | null;
    if (!c || typeof c.quote !== 'string' || typeof c.text !== 'string' || typeof c.occurrence !== 'number'
      || !Number.isFinite(c.occurrence) || c.quote.length > REVIEW_QUOTE_MAX || c.text.length > REVIEW_COMMENT_MAX) {
      console.warn('[SECURITY] review comment validation failed');
      return { ok: false, why: 'invalid', message: 'That comment could not be read.' };
    }
    if (!stillReviewable(doc.real)) return { ok: false, why: 'missing', message: LAYOUT_MESSAGES.missing };
    if (wordHoldsOpen(doc.real)) {
      console.info('[REVIEW] comment held: open in Word');
      return { ok: false, why: 'word-open', message: 'Word has this file open. Close it in Word, then add the comment again.' };
    }
    try {
      const entries = readZip(await readFile(doc.real));
      const name = author();
      const result = addComment(entries, { quote: c.quote, occurrence: c.occurrence, text: c.text, author: name, initials: initialsOf(name), date: new Date() });
      if (result.ok === false) {
        console.info('[REVIEW] comment not added', { why: result.reason });
        const message = result.reason === 'not-found'
          ? 'That text could not be found in the document itself (it may be in a header, a footer or a comment). Select text in the body.'
          : result.reason === 'empty-quote' ? 'Select some text in the document first.' : 'Write the comment first.';
        return { ok: false, why: result.reason, message };
      }
      await replaceFile(doc.real, writeZip(entries));
      console.info('[REVIEW] comment added', { matched: result.matched, chars: c.text.length });
      return { ok: true, id: result.id, matched: result.matched };
    } catch (err) {
      console.warn('[REVIEW] comment write failed', { error: err instanceof ZipError ? err.message : String((err as NodeJS.ErrnoException).code ?? 'error') });
      return { ok: false, why: 'failed', message: 'The comment could not be saved into the file.' };
    }
  });

  ipcMain.handle(REVIEW_IPC.OPEN_IN_WORD, async (event, docId: unknown): Promise<boolean> => {
    const doc = docFor(event.sender, docId);
    if (!doc || !stillReviewable(doc.real)) return false;
    const error = await shell.openPath(doc.real);
    if (error) console.warn('[REVIEW] open in Word failed', { error });
    else console.info('[REVIEW] opened in Word', { path: logPath(doc.real) });
    return !error;
  });

  ipcMain.handle(REVIEW_IPC.DRIVE, async (event, docId: unknown, raw: unknown): Promise<ReviewDriveReply> => {
    const doc = docFor(event.sender, docId);
    if (!doc) return { ok: false, why: 'unknown', message: 'This document is no longer open.' };
    if (!stillReviewable(doc.real)) return { ok: false, why: 'missing', message: LAYOUT_MESSAGES.missing };
    const confirmLindus = (raw as { confirmLindus?: unknown } | null)?.confirmLindus === true;
    if (isLindusPath(doc.real, homedir()) && !confirmLindus) {
      return { ok: false, why: 'confirm-lindus', message: 'This looks like a Lindus document. Send it to your personal Drive anyway?' };
    }
    const settings = store.getSettings();
    const dryRun = process.env.PATTON_DRIVE_DRY_RUN === '1';
    const result = await sendToDrive({ name: basename(doc.real), bytes: await readFile(doc.real) },
      { driveFolder: settings.driveFolder, driveAccount: settings.driveAccount }, { dryRun });
    if (result.ok === false) {
      console.warn('[REVIEW] drive failed', { why: result.why, ...(result.detail ? { detail: result.detail } : {}) });
      const message = {
        'no-gcloud': 'Send to Drive uses the Google Cloud command line (gcloud), and it is not installed.',
        'account-unknown': 'Patton could not tell which Google account is your personal one. Set it under Settings → Drive account.',
        token: 'gcloud could not give a sign-in for that account. Run gcloud auth login in a terminal, then try again.',
        http: 'Google Drive refused the upload.',
        network: 'Google Drive could not be reached.',
      }[result.why];
      return { ok: false, why: result.why, message: result.detail ? `${message} (${result.detail})` : message };
    }
    if (result.dryRun === true) {
      const summary = result.requests.map((r) => `${r.method} ${r.url.split('?')[0]}${r.metadata ? ` ${JSON.stringify(r.metadata)}` : ''}`).join('\n');
      console.info('[REVIEW] drive dry run', { requests: result.requests.length });
      return { ok: true, dryRun: true, account: result.account, summary };
    }
    console.info('[REVIEW] drive sent', { lindusConfirmed: confirmLindus });
    return result;
  });

  ipcMain.handle(REVIEW_IPC.CLOSE, (event, docId: unknown) => {
    if (docFor(event.sender, docId)) forget(docId as string);
  });
}
