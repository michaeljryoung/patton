/**
 * Lays a Word file out as LibreOffice prints it (docs/review-tab.md R1, R6):
 * `soffice --headless --convert-to pdf` of a private copy, in Patton's own
 * LibreOffice profile, comments in the margin. No Electron here (the caller
 * passes the folders), so scripts/check-review-tab.cjs drives it for real
 * (a hidden Electron and LibreOffice).
 *
 * Threat (R10): the file is one Claude named, so it may be hostile.
 *  - soffice runs through execFile (argv, no shell), on a copy named
 *    `document.docx` in a fresh private folder, so the file's own name never
 *    reaches LibreOffice's command line and its lock and output files never
 *    land beside his file.
 *  - The profile is Patton's, seeded before its first run with macros off
 *    (DisableMacrosExecution, MacroSecurityLevel 3 = only signed macros from
 *    trusted places, and there are none) and with links to other files and
 *    remote images not followed; a file holding a VBA project
 *    (`word/vbaProject.bin`, a .docm renamed) is refused before soffice sees it.
 *  - A timeout kills a conversion that hangs; one runs at a time (the profile
 *    allows one LibreOffice at a time).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readZip, ZipError } from './docx-zip';

export const SOFFICE_CANDIDATES = [
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
];

/** The PDF export filter, comments in the margin (R1). The page count stays
 *  the plain export's: LibreOffice scales the page to make room. */
export const PDF_FILTER = 'pdf:writer_pdf_Export:{"ExportNotesInMargin":{"type":"boolean","value":"true"}}';

export const LAYOUT_TIMEOUT_MS = 90 * 1000;
/** Larger files are refused: a review is of a document, not an archive. */
export const MAX_DOCX_BYTES = 50 * 1024 * 1024;
const CACHE_KEEP = 20;

/** Settings written into the profile before LibreOffice first runs it. */
export const PROFILE_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="UseLocking" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="ShowOfficeUpdateDialog" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
`;

export type LayoutFailure = 'no-soffice' | 'too-large' | 'macros' | 'not-docx' | 'timeout' | 'failed' | 'missing';

export type LayoutResult =
  | { ok: true; pdfPath: string; mtimeMs: number; size: number; cached: boolean; ms: number }
  | { ok: false; why: LayoutFailure; detail?: string };

export interface LayoutDeps {
  /** Patton's LibreOffice profile folder (userData/review/lo-profile). */
  profileDir: string;
  /** Where laid-out PDFs are kept (userData/review/cache). */
  cacheDir: string;
  /** Parent of each conversion's private folder (os.tmpdir()). */
  tmpDir: string;
  /** The soffice to run; null means look in SOFFICE_CANDIDATES. */
  soffice?: string | null;
  run?: (cmd: string, args: string[], timeoutMs: number) => Promise<void>;
}

export function findSoffice(candidates = SOFFICE_CANDIDATES): string | null {
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function runFile(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (err) => {
      if (!err) { resolve(); return; }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      reject(Object.assign(new Error(e.message), { timedOut: e.killed === true || e.signal === 'SIGKILL' }));
    });
  });
}

/** Seed the profile's settings once; LibreOffice adds the rest on first run. */
export async function ensureProfile(profileDir: string): Promise<void> {
  const user = join(profileDir, 'user');
  const file = join(user, 'registrymodifications.xcu');
  if (existsSync(file)) {
    // A profile LibreOffice already wrote: put our settings back if they went.
    const text = await readFile(file, 'utf8');
    if (text.includes('DisableMacrosExecution') && text.includes('MacroSecurityLevel')) return;
  }
  mkdirSync(user, { recursive: true, mode: 0o700 });
  await writeFile(file, PROFILE_SETTINGS, { mode: 0o600 });
}

/** Refuse what must not reach soffice: not a zip, a VBA project inside. */
export function vetDocx(bytes: Buffer): LayoutFailure | null {
  try {
    const names = readZip(bytes).map((e) => e.name.toLowerCase());
    if (names.some((n) => n.endsWith('vbaproject.bin') || n.endsWith('vbadata.xml'))) return 'macros';
    if (!names.includes('[content_types].xml')) return 'not-docx';
    return null;
  } catch (err) {
    return err instanceof ZipError ? 'not-docx' : 'failed';
  }
}

export function cacheKey(real: string, mtimeMs: number, size: number): string {
  return createHash('sha256').update(`${real}\0${mtimeMs}\0${size}`).digest('hex').slice(0, 32);
}

async function pruneCache(cacheDir: string): Promise<void> {
  const names = (await readdir(cacheDir)).filter((n) => n.endsWith('.pdf'));
  if (names.length <= CACHE_KEEP) return;
  const withTimes = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(cacheDir, n))).mtimeMs })));
  withTimes.sort((a, b) => b.t - a.t);
  for (const { n } of withTimes.slice(CACHE_KEEP)) await unlink(join(cacheDir, n)).catch(() => {});
}

let queue: Promise<unknown> = Promise.resolve();

/** Lay the file out (or answer the cached PDF for this path, mtime and size). */
export function layout(real: string, deps: LayoutDeps): Promise<LayoutResult> {
  const job = queue.then(() => layoutNow(real, deps), () => layoutNow(real, deps));
  queue = job.catch(() => {});
  return job;
}

async function layoutNow(real: string, deps: LayoutDeps): Promise<LayoutResult> {
  const started = Date.now();
  let st;
  try { st = await stat(real); } catch { return { ok: false, why: 'missing' }; }
  if (!st.isFile()) return { ok: false, why: 'missing' };
  if (st.size > MAX_DOCX_BYTES) return { ok: false, why: 'too-large' };
  mkdirSync(deps.cacheDir, { recursive: true, mode: 0o700 });
  const pdfPath = join(deps.cacheDir, `${cacheKey(real, st.mtimeMs, st.size)}.pdf`);
  if (existsSync(pdfPath)) return { ok: true, pdfPath, mtimeMs: st.mtimeMs, size: st.size, cached: true, ms: Date.now() - started };

  const soffice = deps.soffice === undefined || deps.soffice === null ? findSoffice() : deps.soffice;
  if (!soffice) return { ok: false, why: 'no-soffice' };
  const bytes = await readFile(real);
  const refused = vetDocx(bytes);
  if (refused) return { ok: false, why: refused };

  await ensureProfile(deps.profileDir);
  const work = await mkdtemp(join(deps.tmpDir, 'patton-review-'));
  try {
    const copy = join(work, 'document.docx');
    await writeFile(copy, bytes, { mode: 0o600 });
    const outDir = join(work, 'out');
    const args = [
      `-env:UserInstallation=file://${deps.profileDir}`,
      '--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck',
      '--convert-to', PDF_FILTER, '--outdir', outDir, copy,
    ];
    try {
      await (deps.run ?? runFile)(soffice, args, LAYOUT_TIMEOUT_MS);
    } catch (err) {
      const timedOut = (err as { timedOut?: boolean }).timedOut === true;
      return { ok: false, why: timedOut ? 'timeout' : 'failed', detail: String((err as Error).message).slice(0, 200) };
    }
    const made = join(outDir, 'document.pdf');
    if (!existsSync(made)) return { ok: false, why: 'failed', detail: 'no PDF written' };
    await copyFile(made, pdfPath);
    await pruneCache(deps.cacheDir).catch(() => {});
    return { ok: true, pdfPath, mtimeMs: st.mtimeMs, size: st.size, cached: false, ms: Date.now() - started };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
