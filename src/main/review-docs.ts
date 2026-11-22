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
import { chmod, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { app, ipcMain, shell, type WebContents } from 'electron';
import { REVIEW_COMMENT_MAX, REVIEW_IPC, REVIEW_QUOTE_MAX, type ReviewAddReply, type ReviewComment, type ReviewDocInfo, type ReviewDriveReply, type ReviewLayoutReply } from '../shared/review';
import { addComment, initialsOf, listComments } from './docx-comments';
import { entryText, readZip, writeZip, ZipError, type ZipEntry } from './docx-zip';
import { isLindusPath, LINDUS_SIGNAL_WORDS, lindusSignal, sendToDrive } from './drive-upload';
import { extensionOf } from './link-open-policy';
import { layout, verifyOpens, type LayoutFailure } from './review-layout';
import { checkWellFormed } from './xml-wellformed';
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

/** Backups of his files as they were before each comment, newest kept. */
export const BACKUP_KEEP = 20;

function versionOf(st: { mtimeMs: number; size: number }): string {
  return `${st.mtimeMs}:${st.size}`;
}

/** Write the file through a uniquely named temporary file beside it, synced,
 *  then rename over it (atomic on one volume). */
async function replaceFile(real: string, bytes: Buffer, mode: number): Promise<void> {
  const tmp = join(dirname(real), `.${basename(real)}.patton-${randomUUID()}.tmp`);
  try {
    const fh = await open(tmp, 'wx', mode & 0o666);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await chmod(tmp, mode & 0o666);
    await rename(tmp, real);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Keep `bytes` (his file before the comment) in userData/review-backups,
 *  private, the newest BACKUP_KEEP kept. Never beside his file. */
async function keepBackup(real: string, bytes: Buffer): Promise<string> {
  const dir = join(app.getPath('userData'), 'review-backups');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}-${randomUUID().slice(0, 8)}-${basename(real).replace(/\.docx$/i, '')}.patton-backup.docx`;
  const file = join(dir, name);
  await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
  const all = (await readdir(dir)).filter((n) => n.endsWith('.patton-backup.docx')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) await unlink(join(dir, old)).catch(() => {});
  return file;
}

/** One write at a time per file: each comment reads the file the last one wrote. */
const writeQueues = new Map<string, Promise<unknown>>();
function serialised<T>(real: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(real) ?? Promise.resolve();
  const job = prev.then(fn, fn);
  const tail = job.catch(() => {});
  writeQueues.set(real, tail);
  void tail.then(() => { if (writeQueues.get(real) === tail) writeQueues.delete(real); });
  return job;
}

/** Versions of a file whose body text is the current one's: Patton's own
 *  comments change the file but not its text, so a comment anchored on the
 *  page laid out before them still lands where he selected. */
const sameText = new Map<string, Set<string>>();

/** The parts addComment changed or added, by comparing raw bytes. */
function changedParts(before: Map<string, Buffer>, after: ZipEntry[]): string[] {
  return after.filter((e) => {
    const raw = before.get(e.name);
    return !raw || Buffer.compare(raw, e.raw) !== 0;
  }).map((e) => e.name);
}

type Refusal = { ok: false; why: string; message: string };

const COMMENT_MESSAGES: Record<string, string> = {
  'not-found': 'That text could not be found in the document itself (it may be in a header, a footer or a comment). Select text in the body.',
  'empty-quote': 'Select some text in the document first.',
  'empty-text': 'Write the comment first.',
  'no-document': 'This file has no document body Patton can find.',
  'crosses-box': 'That selection runs from a text box into the page around it. Select text inside one of them.',
  'odd-comments': 'This file keeps its comments somewhere Patton does not follow, so it will not add one. Add it in Word.',
  changed: 'The file changed since this page was laid out. It is laid out again now: select the text and add the comment again.',
  'changed-while-saving': 'The file changed while the comment was being saved, so Patton left it alone. Add the comment again.',
  unsafe: 'Patton made a copy with the comment that would not open cleanly, so your file was left as it was.',
  'no-soffice': 'LibreOffice is needed to check the file before saving a comment into it, and it is not installed.',
  'backup-failed': 'Patton could not keep a backup of the file first, so it left the file as it was.',
};

function refuse(why: string, detail?: Record<string, unknown>): Refusal {
  console.info('[REVIEW] comment not added', { why, ...(detail ?? {}) });
  return { ok: false, why, message: COMMENT_MESSAGES[why] ?? 'The comment could not be saved into the file.' };
}

/** Add one comment to his file (R7), every guard in order; his file is
 *  replaced only after all pass, and stays untouched otherwise. */
async function addCommentSafely(real: string, c: { quote: string; occurrence: number; text: string }, anchored: string | null): Promise<ReviewAddReply> {
  if (!stillReviewable(real)) return { ok: false, why: 'missing', message: LAYOUT_MESSAGES.missing };
  if (wordHoldsOpen(real)) {
    console.info('[REVIEW] comment held: open in Word');
    return { ok: false, why: 'word-open', message: 'Word has this file open. Close it in Word, then add the comment again.' };
  }
  const before = await stat(real);
  const bytes = await readFile(real);
  const current = versionOf(before);
  const same = sameText.get(real);
  // The page he selected on must show the file's current text.
  if (anchored !== null && anchored !== current && !(same?.has(anchored) && same.has(current))) {
    return refuse('changed', { anchored, current });
  }
  const entries = readZip(bytes);
  const rawBefore = new Map(entries.map((e) => [e.name, Buffer.from(e.raw)]));
  const name = author();
  const result = addComment(entries, { quote: c.quote, occurrence: c.occurrence, text: c.text, author: name, initials: initialsOf(name), date: new Date() });
  if (result.ok === false) return refuse(result.reason);
  const out = writeZip(entries);

  // Guard 1: every part the comment changed parses as XML.
  const written = readZip(out);
  for (const part of changedParts(rawBefore, written)) {
    const xml = entryText(written, part) ?? '';
    const wf = checkWellFormed(xml);
    if (wf.ok === false) return refuse('unsafe', { part, at: wf.at, error: wf.why });
  }
  // Guard 2: LibreOffice opens and lays out the result.
  const opens = await verifyOpens(out, reviewDirs());
  if (opens.ok === false) {
    return refuse(opens.why === 'no-soffice' ? 'no-soffice' : 'unsafe', { reopen: opens.why, ...(opens.detail ? { detail: opens.detail } : {}) });
  }
  // Guard 3: nothing else wrote the file meanwhile.
  const again = await stat(real);
  if (versionOf(again) !== current) return refuse('changed-while-saving');
  // Guard 4: the file as it was, kept first.
  try {
    await keepBackup(real, bytes);
  } catch (err) {
    return refuse('backup-failed', { error: String((err as NodeJS.ErrnoException).code ?? 'error') });
  }
  const last = await stat(real);
  if (versionOf(last) !== current) return refuse('changed-while-saving');
  await replaceFile(real, out, before.mode);
  const now = versionOf(await stat(real));
  const set = same?.has(current) ? same : new Set([current]);
  set.add(now);
  sameText.set(real, set);
  console.info('[REVIEW] comment added', { matched: result.matched, chars: c.text.length, backup: true });
  return { ok: true, id: result.id, matched: result.matched };
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
    // The version of the page he selected on (the layout reply's), when sent.
    const anchored = typeof (raw as { version?: unknown }).version === 'string' ? (raw as { version: string }).version : null;
    try {
      return await serialised(doc.real, () => addCommentSafely(doc.real, { quote: c.quote as string, occurrence: c.occurrence as number, text: c.text as string }, anchored));
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
    const bytes = await readFile(doc.real);
    const signal = lindusSignal(doc.real, bytes);
    if (signal && !confirmLindus) {
      console.info('[REVIEW] drive asks first', { signal });
      return { ok: false, why: 'confirm-lindus', message: `This may be a Lindus document (${LINDUS_SIGNAL_WORDS[signal]}). Send it to your personal Drive anyway?` };
    }
    const settings = store.getSettings();
    const dryRun = process.env.PATTON_DRIVE_DRY_RUN === '1';
    const result = await sendToDrive({ name: basename(doc.real), bytes },
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
    console.info('[REVIEW] drive sent', { lindusConfirmed: confirmLindus, signal });
    return result;
  });

  ipcMain.handle(REVIEW_IPC.CLOSE, (event, docId: unknown) => {
    if (docFor(event.sender, docId)) forget(docId as string);
  });
}
