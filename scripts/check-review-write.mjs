// Check of how the review tab writes comments into his file and lays it out
// (docs/review-tab.md R1, R7, R10; the main-side review's findings 1-3).
// Bundles the REAL src/main/review-docs.ts, review-layout.ts, docx-comments.ts
// and xml-wellformed.ts with Electron and the store faked; userData sits under
// "Application Support" as the installed app's does. Needs LibreOffice for
// 1, 2 and 6 (skipped without it):
//  1. layout() lays a file out with its profile in a folder with a space;
//  2. two comments sent in the same tick both land (one write at a time per
//     file), no temporary file is left beside his file, each write keeps the
//     file as it was in userData/review-backups (private), never beside it,
//     the newest 20 kept;
//  3. a comment anchored on a page of another version is refused, the file
//     untouched; one anchored before Patton's own comments still lands;
//  4. a file changed while the comment is being saved is left as the other
//     writer left it, no backup taken;
//  5. an addComment that writes broken XML (faked) is caught before the file
//     is touched, and the reply says why;
//  6. verifyOpens refuses a .docx LibreOffice can't open.
// Run: node scripts/check-review-write.mjs
// Prints `ok <what>` or `not ok <what>: <detail>`; exit 1 on any failure.
import { build } from 'esbuild';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = realpathSync(mkdtempSync(join(tmpdir(), 'check-review-write-')));
const userData = join(work, 'Library', 'Application Support', 'Patton');
mkdirSync(userData, { recursive: true });
let failures = 0;
const ok = (cond, what, detail = '') => {
  if (cond) console.log(`ok ${what}`);
  else { failures++; console.log(`not ok ${what}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
const soffice = ['/opt/homebrew/bin/soffice', '/usr/local/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'].find((p) => existsSync(p));

async function bundle(name, brokenComments) {
  const fakeElectron = join(work, 'electron.mjs');
  writeFileSync(fakeElectron, `
    export const handlers = new Map();
    export const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
    export const app = { getPath: () => ${JSON.stringify(userData)} };
    export const shell = { openPath: async () => '' };
  `);
  const fakeStore = join(work, 'store.mjs');
  writeFileSync(fakeStore, 'export const getSettings = () => ({ driveFolder: "", driveAccount: "" });\n');
  const fakeComments = join(work, 'comments-broken.mjs');
  writeFileSync(fakeComments, `
    import { setEntryText } from ${JSON.stringify(join(root, 'src/main/docx-zip.ts'))};
    export * from ${JSON.stringify(join(root, 'src/main/docx-comments.ts'))};
    export function addComment(entries) {
      setEntryText(entries, 'word/document.xml', '<w:document xmlns:w="x"><w:body><w:r><w:rPr></w:r></w:body></w:document>');
      return { ok: true, id: '0', matched: 'exact' };
    }
  `);
  const plugin = {
    name: 'fakes',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: fakeElectron }));
      b.onResolve({ filter: /^\.\/store$/ }, (a) => (a.importer.endsWith('review-docs.ts') ? { path: fakeStore } : undefined));
      if (brokenComments) b.onResolve({ filter: /^\.\/docx-comments$/ }, (a) => (a.importer.endsWith('review-docs.ts') ? { path: fakeComments } : undefined));
    },
  };
  const entry = join(work, `${name}.ts`);
  writeFileSync(entry, [
    `export * as R from ${JSON.stringify(join(root, 'src/main/review-docs.ts'))};`,
    `export * as L from ${JSON.stringify(join(root, 'src/main/review-layout.ts'))};`,
    `export * as C from ${JSON.stringify(join(root, 'src/main/docx-comments.ts'))};`,
    `export * as Z from ${JSON.stringify(join(root, 'src/main/docx-zip.ts'))};`,
    `export * as E from ${JSON.stringify(fakeElectron)};`,
  ].join('\n'));
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: join(work, `${name}.mjs`), logLevel: 'error', plugins: [plugin] });
  return import(join(work, `${name}.mjs`));
}

const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
const docXml = (text) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
  + text.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('') + '<w:sectPr/></w:body></w:document>';
function docx(Z, text, doc = docXml(text)) {
  const entries = [];
  for (const [name, t] of [['[Content_Types].xml', types], ['_rels/.rels', rootRels], ['word/_rels/document.xml.rels', docRels], ['word/document.xml', doc]]) Z.setEntryText(entries, name, t);
  return Z.writeZip(entries);
}

try {
  const M = await bundle('real', false);
  const { R, L, C, Z, E } = M;
  R.registerReviewHandlers();
  const add = E.handlers.get('review:add-comment');
  const sender = { sent: [], send(ch, ...a) { this.sent.push([ch, ...a]); }, once() {}, isDestroyed: () => false };
  const docsDir = join(work, 'docs');
  mkdirSync(docsDir);
  const file = join(docsDir, 'Plan.docx');
  writeFileSync(file, docx(Z, ['Alpha beta gamma.', 'Delta epsilon zeta.', 'Eta theta iota.']));
  const open = (p) => { R.openReview(sender, p); return sender.sent.filter((s) => s[0] === 'review:open').at(-1)[1].docId; };
  const id = open(file);
  const ev = { sender };
  const listed = () => C.listComments(Z.readZip(readFileSync(file)));
  const backups = () => { const d = join(userData, 'review-backups'); return existsSync(d) ? readdirSync(d).sort() : []; };
  const besideFile = () => readdirSync(docsDir).filter((n) => n !== 'Plan.docx' && n !== 'Other.docx');

  if (!soffice) {
    console.log('skip 1, 2, 3, 4 and 6: soffice not found');
  } else {
    // 1
    const dirs = { profileDir: join(userData, 'review', 'lo-profile'), cacheDir: join(userData, 'review', 'cache'), tmpDir: work };
    const laid = await L.layout(file, dirs);
    ok(laid.ok === true && statSync(laid.pdfPath).size > 1000, 'layout works with its profile under "Application Support"', laid);
    ok(L.profileArg?.('/a b/c').endsWith('file:///a%20b/c'), 'the profile URL is percent-encoded');
    const version0 = `${statSync(file).mtimeMs}:${statSync(file).size}`;

    // 2
    const [a, b] = await Promise.all([
      add(ev, id, { quote: 'beta', occurrence: 0, text: 'First', version: version0 }),
      add(ev, id, { quote: 'epsilon', occurrence: 0, text: 'Second', version: version0 }),
    ]);
    const after = listed();
    ok(a.ok && b.ok && after.length === 2 && after.map((x) => x.text).sort().join() === 'First,Second', 'two comments sent together both land', { a, b, after });
    ok(besideFile().length === 0, 'nothing left beside his file (no temporary file, no backup)', besideFile());
    const bk = backups();
    ok(bk.length === 2 && bk.every((n) => n.endsWith('-Plan.patton-backup.docx')), 'each write kept a backup in userData/review-backups', bk);
    const bkDir = join(userData, 'review-backups');
    ok((statSync(bkDir).mode & 0o777) === 0o700 && bk.every((n) => (statSync(join(bkDir, n)).mode & 0o777) === 0o600), 'backups are private (folder 700, files 600)');
    ok(C.listComments(Z.readZip(readFileSync(join(bkDir, bk[0])))).length <= 1, 'a backup is the file as it was before that comment');

    // 3
    const before3 = readFileSync(file);
    const stale = await add(ev, id, { quote: 'theta', occurrence: 0, text: 'Stale', version: '1:1' });
    ok(stale.ok === false && stale.why === 'changed' && Buffer.compare(before3, readFileSync(file)) === 0 && /changed/.test(stale.message), 'a comment anchored on another version is refused, file untouched', stale);
    const own = await add(ev, id, { quote: 'theta', occurrence: 0, text: 'Third', version: version0 });
    ok(own.ok === true && listed().length === 3, 'a comment anchored before Patton\'s own comments still lands', own);

    // 2 (pruning)
    for (let i = 0; i < 25; i++) writeFileSync(join(bkDir, `2000-01-01T00-00-${String(i).padStart(2, '0')}-000Z-aaaaaaaa-Old.patton-backup.docx`), 'x');
    const r4 = await add(ev, id, { quote: 'Alpha', occurrence: 0, text: 'Fourth' });
    const kept = backups();
    ok(r4.ok && kept.length === 20 && kept.filter((n) => n.startsWith('2000-')).length === 16, 'the newest 20 backups are kept', kept.length);

    // 4
    const backupsBefore = backups().length;
    const other = docx(Z, ['Someone else saved this.']);
    const pending = add(ev, id, { quote: 'gamma', occurrence: 0, text: 'Racing' });
    setTimeout(() => writeFileSync(file, other), 150);
    const raced = await pending;
    ok(raced.ok === false && raced.why === 'changed-while-saving' && Buffer.compare(readFileSync(file), other) === 0 && backups().length === backupsBefore, 'a file changed mid-save is left as the other writer left it', raced);

    // 6
    const broken = docx(Z, [], '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr></w:r></w:p></w:body></w:document>');
    const v = L.verifyOpens ? await L.verifyOpens(broken, dirs) : { ok: true, missing: true };
    ok(v.ok === false, 'verifyOpens refuses a .docx LibreOffice cannot open', v);
    const good = L.verifyOpens ? await L.verifyOpens(readFileSync(file), dirs) : { ok: false, missing: true };
    ok(good.ok === true, 'verifyOpens takes a good one', good);
  }

  // 5
  const B = await bundle('broken', true);
  B.R.registerReviewHandlers();
  const addBroken = B.E.handlers.get('review:add-comment');
  const file5 = join(docsDir, 'Other.docx');
  writeFileSync(file5, docx(Z, ['Plain words here.']));
  const before5 = readFileSync(file5);
  const backups5 = backups().length;
  B.R.openReview(sender, file5);
  const id5 = sender.sent.filter((s) => s[0] === 'review:open').at(-1)[1].docId;
  const r5 = await addBroken({ sender }, id5, { quote: 'words', occurrence: 0, text: 'x' });
  ok(r5.ok === false && r5.why === 'unsafe' && /left as it was/.test(r5.message) && Buffer.compare(before5, readFileSync(file5)) === 0 && backups().length === backups5, 'broken XML from addComment is caught, his file untouched', r5);
} catch (err) {
  failures++;
  console.log(`not ok the check ran: ${err && err.stack || err}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `${failures} not ok` : 'all ok');
process.exit(failures ? 1 : 0);
