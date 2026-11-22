// Check of Send to Drive (docs/review-tab.md R3, R8, map node rt_drive) with
// gcloud and fetch stubbed: nothing runs gcloud and nothing reaches Google.
// Bundles the REAL src/main/drive-upload.ts and review-docs.ts (Electron's
// ipcMain and the store faked; review-docs' sendToDrive recorded) and checks:
//  1. sendToDrive: no gcloud; the account from the setting or the one personal
//     account gcloud holds (two: refused as unknown); a token that can't be
//     fetched, or isn't token-shaped, stops before any request; an HTTP error
//     and a network error are reported, the upload not tried; the folder is
//     found or made at the top of My Drive (name escaped in the query); the
//     upload converts to a Google Doc inside it; the returned link is the
//     Doc's (a link that isn't docs.google.com falls back to the id's; none:
//     refused); every request goes to www.googleapis.com with the token, and
//     the token is in no result; the dry run sends nothing;
//  2. isLindusPath: Lindus anywhere in the path, any case; lindusSignal also
//     reads the Lindus Drive mount, a symlink's target, the document's
//     properties (creator, company, an @lindushealth.com author) and its
//     text (body, header), and asks about a file it can't read;
//  3. main's review:drive handler: a Lindus file (by name, or by its text
//     alone) is refused without confirmLindus (nothing sent), sent with it; a plain file sends without
//     asking; failures come back as his words; another window's id is refused;
//  4. the shared setting rules (src/shared/drive-settings.ts).
// Run: node scripts/check-drive-upload.mjs
// Prints `ok <what>` or `not ok <what>: <detail>`; exit 1 on any failure.
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Real path: esbuild keys modules by it, and tmpdir() is under the /var symlink.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'check-drive-upload-')));
let failures = 0;
const ok = (cond, what, detail = '') => {
  if (cond) console.log(`ok ${what}`);
  else { failures++; console.log(`not ok ${what}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};

const TOKEN = 'ya29.FAKE-token_value';

/** A stub gcloud: `auth list` and `auth print-access-token`, recorded. */
function gcloudStub({ accounts = ['michael@gmail.com', 'michael@lindushealth.com'], token = TOKEN, tokenFails = false } = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'auth' && args[1] === 'list') return accounts.join('\n') + '\n';
    if (args[0] === 'auth' && args[1] === 'print-access-token') {
      if (tokenFails) throw new Error('ERROR: (gcloud.auth.print-access-token) Reauthentication failed.');
      return token + '\n';
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { run, calls };
}

/** A stub fetch: answers by request, recorded. */
function fetchStub({ folderFound = true, findStatus = 200, uploadStatus = 200, throwOn = null, upload = null } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const res = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
    if (throwOn && url.includes(throwOn)) throw new TypeError('fetch failed: getaddrinfo ENOTFOUND www.googleapis.com');
    if (url.includes('/upload/')) return res(uploadStatus, upload ?? { id: 'doc_123', name: 'Quarterly plan', webViewLink: 'https://docs.google.com/document/d/doc_123/edit' });
    if ((init.method || 'GET') === 'GET') return res(findStatus, { files: folderFound ? [{ id: 'folder_9' }] : [] });
    return res(200, { id: 'folder_new' });
  };
  return { fetch, calls };
}

try {
  // ---- the bundle: drive-upload.ts, review-docs.ts with fakes, the shared rules
  const fakeElectron = join(work, 'electron.mjs');
  writeFileSync(fakeElectron, `
    export const handlers = new Map();
    export const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
    export const app = { getPath: () => ${JSON.stringify(work)} };
    export const shell = { openPath: async () => '' };
  `);
  const fakeStore = join(work, 'store.mjs');
  writeFileSync(fakeStore, `export let current = { driveFolder: 'Reviews', driveAccount: '' };\nexport const getSettings = () => current;\n`);
  const fakeDrive = join(work, 'drive-fake.mjs');
  writeFileSync(fakeDrive, `
    export { isLindusPath, lindusSignal, LINDUS_SIGNAL_WORDS } from ${JSON.stringify(join(root, 'src/main/drive-upload.ts'))};
    export const sent = [];
    export let reply = { ok: true, dryRun: false, link: 'https://docs.google.com/document/d/x/edit', name: 'x', account: 'michael@gmail.com' };
    export function setReply(r) { reply = r; }
    export async function sendToDrive(file, settings, opts) { sent.push({ name: file.name, bytes: file.bytes.length, settings, opts }); return reply; }
  `);
  const fakes = {
    name: 'fakes',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: fakeElectron }));
      b.onResolve({ filter: /^\.\/store$/ }, (a) => (a.importer.endsWith('review-docs.ts') ? { path: fakeStore } : undefined));
      b.onResolve({ filter: /^\.\/drive-upload$/ }, (a) => (a.importer.endsWith('review-docs.ts') ? { path: fakeDrive } : undefined));
    },
  };
  const entry = join(work, 'entry.ts');
  writeFileSync(entry, [
    `export * as D from ${JSON.stringify(join(root, 'src/main/drive-upload.ts'))};`,
    `export * as R from ${JSON.stringify(join(root, 'src/main/review-docs.ts'))};`,
    `export * as S from ${JSON.stringify(join(root, 'src/shared/drive-settings.ts'))};`,
    `export * as E from ${JSON.stringify(fakeElectron)};`,
    `export * as F from ${JSON.stringify(fakeDrive)};`,
    `export * as ST from ${JSON.stringify(fakeStore)};`,
    `export * as Z from ${JSON.stringify(join(root, 'src/main/docx-zip.ts'))};`,
  ].join('\n'));
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'bundle.mjs'), logLevel: 'error', plugins: [fakes] });
  const { D, R, S, E, F, Z } = await import(join(work, 'bundle.mjs'));
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const docxOf = ({ text = 'Quarterly plan for the shop.', core = '', app = '', header = '' } = {}) => {
    const entries = [];
    Z.setEntryText(entries, '[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    Z.setEntryText(entries, 'word/document.xml', `<w:document ${W}><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
    if (header) Z.setEntryText(entries, 'word/header1.xml', `<w:hdr ${W}><w:p><w:r><w:t>${header}</w:t></w:r></w:p></w:hdr>`);
    if (core) Z.setEntryText(entries, 'docProps/core.xml', `<cp:coreProperties xmlns:cp="c" xmlns:dc="d"><dc:creator>${core}</dc:creator></cp:coreProperties>`);
    if (app) Z.setEntryText(entries, 'docProps/app.xml', `<Properties xmlns="a"><Company>${app}</Company></Properties>`);
    return Z.writeZip(entries);
  };
  const file = { name: 'Quarterly plan.docx', bytes: Buffer.from('PK\x03\x04 fake docx bytes') };
  const settings = { driveFolder: "Mike's \\ docs", driveAccount: '' };

  // ---- 1. sendToDrive
  {
    const g = gcloudStub(); const f = fetchStub();
    const r = await D.sendToDrive(file, settings, { dryRun: false }, { run: g.run, fetch: f.fetch, gcloud: '' });
    ok(r.ok === false && r.why === 'no-gcloud' && g.calls.length === 0 && f.calls.length === 0, 'no gcloud: refused, nothing run or sent', r);
  }
  {
    const g = gcloudStub({ accounts: ['a@gmail.com', 'b@gmail.com'] }); const f = fetchStub();
    const r = await D.sendToDrive(file, settings, { dryRun: false }, { run: g.run, fetch: f.fetch, gcloud: '/stub/gcloud' });
    ok(r.ok === false && r.why === 'account-unknown' && f.calls.length === 0, 'two personal accounts and none set: account unknown, nothing sent', r);
    const g2 = gcloudStub({ accounts: ['a@gmail.com', 'b@gmail.com'] }); const f2 = fetchStub();
    const r2 = await D.sendToDrive(file, { ...settings, driveAccount: 'b@gmail.com' }, { dryRun: false }, { run: g2.run, fetch: f2.fetch, gcloud: '/stub/gcloud' });
    ok(r2.ok === true && r2.account === 'b@gmail.com' && g2.calls.some((c) => c.includes('--account=b@gmail.com')), 'the account setting is the one used', { r2, calls: g2.calls });
  }
  {
    const g = gcloudStub({ tokenFails: true }); const f = fetchStub();
    const r = await D.sendToDrive(file, settings, { dryRun: false }, { run: g.run, fetch: f.fetch, gcloud: '/stub/gcloud' });
    ok(r.ok === false && r.why === 'token' && f.calls.length === 0, 'a token gcloud can\'t give: refused before any request', r);
    ok(g.calls.some((c) => c[1] === 'auth' && c[2] === 'print-access-token' && c[3] === '--account=michael@gmail.com'), 'the token is asked for the one personal account (the Lindus one left alone)', g.calls);
    const g2 = gcloudStub({ token: 'WARNING: reauth needed\nya29.x' }); const f2 = fetchStub();
    const r2 = await D.sendToDrive(file, settings, { dryRun: false }, { run: g2.run, fetch: f2.fetch, gcloud: '/stub/gcloud' });
    ok(r2.ok === false && r2.why === 'token' && f2.calls.length === 0, 'output that isn\'t a token: refused before any request', r2);
  }
  {
    const g = gcloudStub(); const f = fetchStub({ findStatus: 403 });
    const r = await D.sendToDrive(file, settings, { dryRun: false }, { run: g.run, fetch: f.fetch, gcloud: '/stub/gcloud' });
    ok(r.ok === false && r.why === 'http' && r.detail === 'HTTP 403' && f.calls.length === 1, 'an HTTP error finding the folder: reported, the upload not tried', { r, calls: f.calls.length });
    const f2 = fetchStub({ uploadStatus: 500 });
    const r2 = await D.sendToDrive(file, settings, { dryRun: false }, { run: gcloudStub().run, fetch: f2.fetch, gcloud: '/stub/gcloud' });
    ok(r2.ok === false && r2.why === 'http' && r2.detail === 'HTTP 500', 'an HTTP error on the upload: reported', r2);
    const f3 = fetchStub({ throwOn: '/drive/v3/files?q=' });
    const r3 = await D.sendToDrive(file, settings, { dryRun: false }, { run: gcloudStub().run, fetch: f3.fetch, gcloud: '/stub/gcloud' });
    ok(r3.ok === false && r3.why === 'network' && /ENOTFOUND/.test(r3.detail || '') && !JSON.stringify(r3).includes(TOKEN), 'a network failure: reported, without the token', r3);
  }
  {
    const g = gcloudStub(); const f = fetchStub({ folderFound: false });
    const r = await D.sendToDrive(file, settings, { dryRun: false }, { run: g.run, fetch: f.fetch, gcloud: '/stub/gcloud' });
    ok(r.ok === true && r.dryRun === false && r.link === 'https://docs.google.com/document/d/doc_123/edit' && r.name === 'Quarterly plan', 'the returned link is the Google Doc\'s', r);
    const [find, make, up] = f.calls;
    const q = decodeURIComponent(new URL(find.url).searchParams.get('q') || '');
    ok(q === "name = 'Mike\\'s \\\\ docs' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false", 'the folder is looked for at the top of My Drive, its name escaped', q);
    const made = JSON.parse(make.body);
    ok(make.method === 'POST' && made.name === "Mike's \\ docs" && made.parents[0] === 'root' && made.mimeType === 'application/vnd.google-apps.folder', 'a missing folder is made at the top of My Drive', made);
    const body = Buffer.from(up.body).toString('latin1');
    const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n/.exec(body)[1]);
    ok(up.method === 'POST' && /uploadType=multipart/.test(up.url) && meta.mimeType === 'application/vnd.google-apps.document' && meta.parents[0] === 'folder_new' && meta.name === 'Quarterly plan', 'the upload converts to a Google Doc in that folder, named without .docx', meta);
    ok(body.includes('fake docx bytes') && /multipart\/related; boundary=/.test(up.headers['Content-Type']), 'the file\'s bytes go as the multipart body\'s second part', up.headers);
    ok(f.calls.every((c) => c.url.startsWith('https://www.googleapis.com/') && c.headers.Authorization === `Bearer ${TOKEN}`), 'every request goes to www.googleapis.com with the token', f.calls.map((c) => c.url));
    ok(!JSON.stringify(r).includes(TOKEN), 'the token is in no result');
    const f2 = fetchStub();
    await D.sendToDrive(file, settings, { dryRun: false }, { run: gcloudStub().run, fetch: f2.fetch, gcloud: '/stub/gcloud' });
    ok(f2.calls.length === 2 && JSON.parse(Buffer.from(f2.calls[1].body).toString('latin1').split('\r\n\r\n')[1].split('\r\n')[0]).parents[0] === 'folder_9', 'a folder that exists is used, not made again', f2.calls.map((c) => c.url));
  }
  {
    const f = fetchStub({ upload: { id: 'doc_77', name: 'x', webViewLink: 'https://evil.example/doc' } });
    const r = await D.sendToDrive(file, settings, { dryRun: false }, { run: gcloudStub().run, fetch: f.fetch, gcloud: '/stub/gcloud' });
    ok(r.ok === true && r.link === 'https://docs.google.com/document/d/doc_77/edit', 'a link that isn\'t docs.google.com is replaced by the id\'s', r);
    const f2 = fetchStub({ upload: { id: '../x', webViewLink: 'javascript:alert(1)' } });
    const r2 = await D.sendToDrive(file, settings, { dryRun: false }, { run: gcloudStub().run, fetch: f2.fetch, gcloud: '/stub/gcloud' });
    ok(r2.ok === false && r2.why === 'http' && r2.detail === 'no document link', 'no usable link or id: refused', r2);
  }
  {
    const g = gcloudStub(); const f = fetchStub();
    const r = await D.sendToDrive(file, settings, { dryRun: true }, { run: g.run, fetch: f.fetch, gcloud: '/stub/gcloud' });
    ok(r.ok === true && r.dryRun === true && r.requests.length === 3 && f.calls.length === 0 && !g.calls.some((c) => c.includes('print-access-token')), 'the dry run plans three requests and sends none (no token fetched)', { r, g: g.calls });
  }

  // ---- 2. isLindusPath
  const home = '/Users/me';
  ok(D.isLindusPath('/Users/me/Downloads/Lindus trial notes.docx', home), 'a file named Lindus is a Lindus path');
  ok(D.isLindusPath('/Users/me/Projects/lindus-citrus/docs/plan.docx', home), 'a file under a top-level Lindus project is a Lindus path');
  ok(D.isLindusPath('/Users/me/Projects/betterterm/docs/lindus/plan.docx', home), 'a lindus folder deeper in another project is one too');
  ok(D.isLindusPath('/Users/me/Documents/LINDUS/plan.docx', home) && D.isLindusPath('/Users/me/projects/Lindus-x/plan.docx', home), 'any folder, any case');
  ok(!D.isLindusPath('/Users/me/Downloads/Quarterly plan.docx', home), 'a plain file is not');
  {
    const plainBytes = docxOf();
    const sig = (p, b = plainBytes) => D.lindusSignal(p, b);
    ok(sig('/Users/me/Library/CloudStorage/GoogleDrive-michael@lindushealth.com/My Drive/plan.docx') === 'lindus-drive', 'the Lindus Google Drive mount asks first');
    ok(sig('/Users/me/Documents/Lindus/plan.docx') === 'path', 'a Lindus folder asks first');
    ok(sig('/Users/me/Downloads/plan.docx') === null, 'a plain file in Downloads with plain contents does not ask');
    ok(sig('/Users/me/Downloads/plan.docx', docxOf({ core: 'Jo Bloggs jo@lindushealth.com' })) === 'properties', 'an @lindushealth.com author asks first');
    ok(sig('/Users/me/Downloads/plan.docx', docxOf({ app: 'Lindus Health Ltd' })) === 'properties', 'a Lindus company asks first');
    ok(sig('/Users/me/Downloads/plan.docx', docxOf({ text: 'Notes from the Lin</w:t></w:r><w:r><w:t>dus call.' })) === 'text', 'Lindus in the text, split across runs, asks first');
    ok(sig('/Users/me/Downloads/plan.docx', docxOf({ header: 'LINDUS HEALTH CONFIDENTIAL' })) === 'text', 'Lindus in a header asks first');
    ok(sig('/Users/me/Downloads/plan.docx', Buffer.from('not a zip, long enough to be scanned for one')) === 'unreadable', 'a file that cannot be read asks first');
    const linkDir = join(work, 'links');
    mkdirSync(join(linkDir, 'Lindus share'), { recursive: true });
    writeFileSync(join(linkDir, 'Lindus share', 'target.docx'), plainBytes);
    symlinkSync(join(linkDir, 'Lindus share', 'target.docx'), join(linkDir, 'innocent.docx'));
    ok(sig(join(linkDir, 'innocent.docx')) === 'path', 'a symlink is resolved first (it points into a Lindus folder)');
  }

  // ---- 3. main's review:drive handler
  R.registerReviewHandlers();
  const drive = E.handlers.get('review:drive');
  const listeners = [];
  const makeSender = () => ({ sent: [], send(ch, ...a) { this.sent.push([ch, ...a]); }, once(ev, fn) { listeners.push(fn); }, isDestroyed: () => false });
  const sender = makeSender();
  const docsDir = join(work, 'docs');
  rmSync(docsDir, { recursive: true, force: true });
  mkdirSync(docsDir);
  const lindus = join(docsDir, 'Lindus trial notes.docx');
  const plain = join(docsDir, 'Quarterly plan.docx');
  const byText = join(docsDir, 'Call notes.docx');
  writeFileSync(lindus, docxOf()); writeFileSync(plain, docxOf()); writeFileSync(byText, docxOf({ text: 'Agenda for the Lindus board.' }));
  R.openReview(sender, byText);
  R.openReview(sender, lindus);
  R.openReview(sender, plain);
  const ids = sender.sent.filter((m) => m[0] === 'review:open').map((m) => m[1]);
  const lindusId = ids.find((i) => i.name === 'Lindus trial notes.docx');
  const plainId = ids.find((i) => i.name === 'Quarterly plan.docx');
  ok(lindusId?.lindus === true && plainId?.lindus === false, 'review:open tells the renderer which file is Lindus', ids);
  const ev = { sender };
  const refused = await drive(ev, lindusId.docId, { confirmLindus: false });
  ok(refused.ok === false && refused.why === 'confirm-lindus' && F.sent.length === 0, 'a Lindus file without confirmLindus is refused, nothing sent', refused);
  const refused2 = await drive(ev, lindusId.docId, null);
  ok(refused2.ok === false && refused2.why === 'confirm-lindus' && F.sent.length === 0, 'no options at all is the same refusal', refused2);
  const textId = ids.find((i) => i.name === 'Call notes.docx');
  const refused3 = await drive(ev, textId.docId, {});
  ok(refused3.ok === false && refused3.why === 'confirm-lindus' && /text mentions Lindus/.test(refused3.message) && F.sent.length === 0, 'a file whose text alone says Lindus is asked about, and says why', refused3);
  const confirmed = await drive(ev, lindusId.docId, { confirmLindus: true });
  ok(confirmed.ok === true && confirmed.link.startsWith('https://docs.google.com/') && F.sent.length === 1 && F.sent[0].name === 'Lindus trial notes.docx', 'with confirmLindus it is sent and the link returned', { confirmed, sent: F.sent });
  ok(F.sent[0].settings.driveFolder === 'Reviews' && F.sent[0].opts.dryRun === false, 'the folder setting reaches sendToDrive', F.sent[0]);
  const plainSent = await drive(ev, plainId.docId, {});
  ok(plainSent.ok === true && F.sent.length === 2, 'a plain file sends without asking');
  F.setReply({ ok: false, why: 'token' });
  const tokenFail = await drive(ev, plainId.docId, {});
  ok(tokenFail.ok === false && /gcloud auth login/.test(tokenFail.message), 'a token failure comes back in his words', tokenFail);
  F.setReply({ ok: false, why: 'http', detail: 'HTTP 403' });
  const httpFail = await drive(ev, plainId.docId, {});
  ok(httpFail.ok === false && httpFail.message === 'Google Drive refused the upload. (HTTP 403)', 'an HTTP failure comes back with its status', httpFail);
  const other = await drive({ sender: makeSender() }, plainId.docId, { confirmLindus: true });
  ok(other.ok === false && other.why === 'unknown', 'another window\'s id is refused', other);
  for (const fn of listeners) fn();

  // ---- 4. the shared setting rules
  ok(S.driveFolderValid('') && S.driveFolderValid('Patton reviews') && !S.driveFolderValid('a/b') && !S.driveFolderValid('a\nb') && !S.driveFolderValid('x'.repeat(101)), 'folder rule: empty or one name, no slash or control, ≤ 100');
  ok(S.driveAccountValid('') && S.driveAccountValid('me@gmail.com') && !S.driveAccountValid('me') && !S.driveAccountValid('me @gmail.com'), 'account rule: empty or an address');
} catch (err) {
  failures++;
  console.log(`not ok the check ran: ${err && err.stack || err}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `${failures} not ok` : 'all ok');
process.exit(failures ? 1 : 0);
