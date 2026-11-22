/**
 * Send to Drive (docs/review-tab.md R3, R8): the .docx goes to his personal
 * Google Drive converted to a Google Doc, in a folder at the top of My Drive
 * (setting `driveFolder`, default "Patton"), through the Drive API with the
 * access token gcloud already holds for his personal account.
 *
 * Why not rclone (R8): this Mac's `gdrive:` remote reaches the Lindus Drive and
 * was granted read-only (`drive.readonly`), so it can neither take the upload
 * nor take it to the right account. The personal gcloud login already carries
 * the `drive` scope; no new access is asked for.
 *
 * Threat: the token is read with execFile (argv, no shell), held only for the
 * requests, never logged, never sent to the renderer. Requests go only to
 * www.googleapis.com. The folder name is a setting, escaped inside the Drive
 * query. A dry run builds the same requests and sends none (the
 * Authorization header shows as "Bearer <token>").
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export const DEFAULT_DRIVE_FOLDER = 'Patton';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
const DOC_TYPE = 'application/vnd.google-apps.document';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface PlannedRequest {
  method: 'GET' | 'POST';
  url: string;
  /** The request's JSON metadata (the upload's first part), for the dry run. */
  metadata?: Record<string, unknown>;
  bytes?: number;
}

export type DriveResult =
  | { ok: true; link: string; name: string; account: string; dryRun: false }
  | { ok: true; dryRun: true; account: string; requests: PlannedRequest[] }
  | { ok: false; why: 'no-gcloud' | 'account-unknown' | 'token' | 'http' | 'network'; detail?: string };

export interface DriveDeps {
  /** Run a command, resolving its stdout (execFile, no shell). */
  run?: (cmd: string, args: string[]) => Promise<string>;
  fetch?: typeof fetch;
  gcloud?: string;
}

const GCLOUD_CANDIDATES = ['/opt/homebrew/bin/gcloud', '/usr/local/bin/gcloud', '/opt/homebrew/share/google-cloud-sdk/bin/gcloud'];

function runFile(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout));
    });
  });
}

/** A Drive query string literal: backslash and quote escaped. */
export function driveQueryLiteral(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** The folder setting cleaned: one line, no slash (a folder at the top only), ≤ 100 chars. */
export function driveFolderOf(setting: unknown): string {
  const s = typeof setting === 'string' ? setting.replace(/[\p{Cc}/]/gu, '').trim().slice(0, 100) : '';
  return s || DEFAULT_DRIVE_FOLDER;
}

/** The Google Doc's name: the file's name without `.docx`. */
export function docNameOf(fileName: string): string {
  return fileName.replace(/\.docx$/i, '') || fileName;
}

/**
 * Which gcloud account sends: the setting when set, else the one personal
 * (@gmail.com / @googlemail.com) account gcloud holds. Null when that can't be told.
 */
export function chooseAccount(setting: unknown, accounts: string[]): string | null {
  if (typeof setting === 'string' && /^[^\s@]+@[^\s@]+$/.test(setting.trim())) return setting.trim();
  const personal = accounts.filter((a) => /@(gmail|googlemail)\.com$/i.test(a));
  return personal.length === 1 ? personal[0] : null;
}

function multipartBody(metadata: Record<string, unknown>, bytes: Buffer, boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${DOCX_TYPE}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

export async function sendToDrive(
  file: { name: string; bytes: Buffer },
  settings: { driveFolder?: unknown; driveAccount?: unknown },
  opts: { dryRun: boolean },
  deps: DriveDeps = {},
): Promise<DriveResult> {
  const run = deps.run ?? runFile;
  const doFetch = deps.fetch ?? fetch;
  const gcloud = deps.gcloud ?? GCLOUD_CANDIDATES.find((p) => existsSync(p));
  if (!gcloud) return { ok: false, why: 'no-gcloud' };

  let accounts: string[] = [];
  try {
    accounts = (await run(gcloud, ['auth', 'list', '--format=value(account)'])).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { /* a set account still works */ }
  const account = chooseAccount(settings.driveAccount, accounts);
  if (!account) return { ok: false, why: 'account-unknown' };

  const folder = driveFolderOf(settings.driveFolder);
  const q = `name = ${driveQueryLiteral(folder)} and mimeType = '${FOLDER_TYPE}' and 'root' in parents and trashed = false`;
  const findUrl = `${API}?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive&pageSize=1`;
  const metadata = { name: docNameOf(file.name), mimeType: DOC_TYPE, parents: ['<folder id>'] };
  if (opts.dryRun) {
    return {
      ok: true, dryRun: true, account, requests: [
        { method: 'GET', url: findUrl },
        { method: 'POST', url: `${API}?fields=id`, metadata: { name: folder, mimeType: FOLDER_TYPE, parents: ['root'] } },
        { method: 'POST', url: UPLOAD, metadata, bytes: file.bytes.length },
      ],
    };
  }

  let token: string;
  try {
    token = (await run(gcloud, ['auth', 'print-access-token', `--account=${account}`])).trim();
  } catch {
    return { ok: false, why: 'token' };
  }
  if (!/^[\w.~+/-]+=*$/.test(token)) return { ok: false, why: 'token' };
  const auth = { Authorization: `Bearer ${token}` };

  const call = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
    let res: Response;
    try { res = await doFetch(url, init); } catch (err) {
      throw Object.assign(new Error('network'), { why: 'network', detail: String((err as Error).message).slice(0, 120) });
    }
    if (!res.ok) throw Object.assign(new Error('http'), { why: 'http', detail: `HTTP ${res.status}` });
    return (await res.json()) as Record<string, unknown>;
  };

  try {
    const found = await call(findUrl, { headers: auth });
    let folderId = Array.isArray(found.files) && typeof (found.files[0] as { id?: unknown })?.id === 'string'
      ? (found.files[0] as { id: string }).id : null;
    if (!folderId) {
      const made = await call(`${API}?fields=id`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name: folder, mimeType: FOLDER_TYPE, parents: ['root'] }),
      });
      folderId = typeof made.id === 'string' ? made.id : null;
      if (!folderId) return { ok: false, why: 'http', detail: 'no folder id' };
    }
    const boundary = `patton${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const uploaded = await call(UPLOAD, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: new Uint8Array(multipartBody({ ...metadata, parents: [folderId] }, file.bytes, boundary)),
    });
    const id = typeof uploaded.id === 'string' ? uploaded.id : '';
    const link = typeof uploaded.webViewLink === 'string' && uploaded.webViewLink.startsWith('https://docs.google.com/')
      ? uploaded.webViewLink
      : (/^[\w-]+$/.test(id) ? `https://docs.google.com/document/d/${id}/edit` : '');
    if (!link) return { ok: false, why: 'http', detail: 'no document link' };
    return { ok: true, dryRun: false, link, name: typeof uploaded.name === 'string' ? uploaded.name : metadata.name, account };
  } catch (err) {
    const e = err as { why?: 'http' | 'network'; detail?: string };
    return { ok: false, why: e.why ?? 'network', detail: e.detail };
  }
}

/** A path he may hold Lindus work in (his rule on Lindus accounts): asked before sending. */
export function isLindusPath(real: string, home: string): boolean {
  const name = real.slice(real.lastIndexOf('/') + 1);
  if (/lindus/i.test(name)) return true;
  const projects = `${home}/Projects/`;
  if (!real.startsWith(projects)) return false;
  const top = real.slice(projects.length).split('/')[0];
  return /lindus/i.test(top);
}
