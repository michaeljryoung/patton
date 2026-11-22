// Check of Word comments written by the review tab (docs/review-tab.md R7,
// map node rt_comments). Bundles the REAL src/main/docx-zip.ts and
// docx-comments.ts with esbuild, builds a small .docx in memory (bold and
// plain runs, an entity, a phrase used three times, a page break), and:
//  1. the body's matching key ignores whitespace and markup;
//  2. a comment on the second of three "budget is fixed" (the quote crosses
//     run boundaries) lands in word/comments.xml, with its relationship and content
//     type, and listComments reads it back with its quote;
//  3. a second comment goes into the existing comments part, with a new id;
//  4. parts the comment doesn't touch are written back byte for byte;
//  5. an occurrence past the last match takes the last; a quote not in the
//     body, an empty quote and an empty comment are refused, the file unchanged;
//  6. a zip that isn't one is refused;
//  7. with LibreOffice installed: the commented file converts to PDF with the
//     comment's text in the margin (pdftotext) and to .odt with two
//     office:annotation elements (the file opens cleanly).
// Run: node scripts/check-review-comments.mjs
// Prints `ok <what>` or `not ok <what>: <detail>`; exit 1 on any failure.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'check-review-comments-'));
let failures = 0;
const ok = (cond, what, detail = '') => {
  if (cond) console.log(`ok ${what}`);
  else { failures++; console.log(`not ok ${what}${detail ? `: ${detail}` : ''}`); }
};

try {
  const entry = join(work, 'entry.ts');
  writeFileSync(entry, `export * from ${JSON.stringify(join(root, 'src/main/docx-zip.ts'))};\nexport * from ${JSON.stringify(join(root, 'src/main/docx-comments.ts'))};\n`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'bundle.mjs'), logLevel: 'error' });
  const m = await import(join(work, 'bundle.mjs'));

  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>The budget is fixed.</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">Costs &amp; the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>budget is</w:t></w:r><w:r><w:t xml:space="preserve"> fixed for the year.</w:t></w:r></w:p>'
    + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
    + '<w:p><w:r><w:t>Page two: the budget is fixed again.</w:t></w:r></w:p>'
    + '<w:sectPr/></w:body></w:document>';
  const make = () => {
    const entries = [];
    for (const [name, text] of [['[Content_Types].xml', types], ['_rels/.rels', rootRels], ['word/_rels/document.xml.rels', docRels], ['word/document.xml', doc]]) m.setEntryText(entries, name, text);
    return m.readZip(m.writeZip(entries));
  };

  // 1
  const body = m.bodyText(doc);
  ok(body.key === 'Thebudgetisfixed.Costs&thebudgetisfixedfortheyear.Pagetwo:thebudgetisfixedagain.', 'body key ignores whitespace, markup and entities', body.key);
  ok(m.matchesOf(body.key, m.textKey('budget  is\nfixed')).length === 3, 'the PDF-side key matches across line breaks');

  // 2
  const original = make();
  const rawBefore = new Map(original.map((e) => [e.name, Buffer.from(e.raw)]));
  const date = new Date('2026-11-22T17:00:00Z');
  const r1 = m.addComment(original, { quote: 'budget is fixed', occurrence: 1, text: 'Say which budget.', author: 'Michael Young', initials: 'MY', date });
  ok(r1.ok && r1.matched === 'exact', 'comment added on the second match', JSON.stringify(r1));
  const after1 = m.readZip(m.writeZip(original));
  const comments = m.entryText(after1, 'word/comments.xml') ?? '';
  ok(/<w:comment w:id="0" w:author="Michael Young" w:date="2026-11-22T17:00:00Z" w:initials="MY">.*Say which budget\./.test(comments), 'word/comments.xml holds the comment', comments.slice(0, 200));
  ok((m.entryText(after1, 'word/_rels/document.xml.rels') ?? '').includes('relationships/comments" Target="comments.xml"'), 'document relationship to comments.xml added');
  ok((m.entryText(after1, '[Content_Types].xml') ?? '').includes('PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"'), 'content type override added');
  const doc1 = m.entryText(after1, 'word/document.xml') ?? '';
  ok(doc1.indexOf('<w:commentRangeStart w:id="0"/>') > doc1.indexOf('Costs &amp;') && doc1.indexOf('<w:commentRangeEnd w:id="0"/>') < doc1.indexOf('for the year'), 'range markers sit around the second match', doc1.slice(200, 700));
  ok(doc1.includes('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">budget is') || doc1.includes('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">budget is</w:t>'), 'the bold run keeps its properties');
  ok(m.bodyText(doc1).key === body.key, 'the body text is unchanged by the split');
  const listed = m.listComments(after1);
  ok(listed.length === 1 && listed[0].quote === 'budget is fixed' && listed[0].text === 'Say which budget.', 'listComments reads it back with its quote', JSON.stringify(listed));

  // 3
  const r2 = m.addComment(after1, { quote: 'Page two', occurrence: 0, text: 'Line one\nLine <two> & "three"', author: 'Michael Young', initials: 'MY', date });
  const after2 = m.readZip(m.writeZip(after1));
  const listed2 = m.listComments(after2);
  ok(r2.ok && r2.id === '1' && listed2.length === 2 && listed2[1].text === 'Line one\nLine <two> & "three"', 'second comment, new id, escaped text round-trips', JSON.stringify(listed2[1]));
  ok(((m.entryText(after2, 'word/_rels/document.xml.rels') ?? '').match(/relationships\/comments"/g) ?? []).length === 1, 'still one comments relationship');

  // 4
  const untouched = after2.find((e) => e.name === '_rels/.rels');
  ok(untouched && Buffer.compare(untouched.raw, rawBefore.get('_rels/.rels')) === 0, 'untouched parts are copied byte for byte');

  // 5
  const r3 = m.addComment(m.readZip(m.writeZip(after2)), { quote: 'budget is fixed', occurrence: 9, text: 'x', author: 'A', initials: 'A', date });
  ok(r3.ok && r3.matched === 'last', 'an occurrence past the last match takes the last', JSON.stringify(r3));
  for (const [quote, text, reason] of [['not in this file', 'x', 'not-found'], ['  \n', 'x', 'empty-quote'], ['budget', '  ', 'empty-text']]) {
    const entries = make();
    const before = m.entryText(entries, 'word/document.xml');
    const r = m.addComment(entries, { quote, occurrence: 0, text, author: 'A', initials: 'A', date });
    ok(!r.ok && r.reason === reason && m.entryText(entries, 'word/document.xml') === before && !m.entryText(entries, 'word/comments.xml'), `refused: ${reason}, file unchanged`, JSON.stringify(r));
  }
  ok(m.initialsOf('Michael  Young') === 'MY', 'initials');

  // 6
  let refused = false;
  try { m.readZip(Buffer.from('not a zip at all, just text that is long enough to scan')); } catch (e) { refused = e instanceof m.ZipError; }
  ok(refused, 'a file that is not a zip is refused');

  // 7
  const soffice = ['/opt/homebrew/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'].find((p) => existsSync(p));
  if (!soffice) {
    console.log('skip LibreOffice round trip: soffice not found');
  } else {
    const file = join(work, 'commented.docx');
    writeFileSync(file, m.writeZip(after2));
    const profile = `file://${join(work, 'lo-profile')}`;
    const margin = 'pdf:writer_pdf_Export:{"ExportNotesInMargin":{"type":"boolean","value":"true"}}';
    execFileSync(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', margin, '--outdir', join(work, 'pdf'), file], { stdio: 'ignore', timeout: 90000 });
    execFileSync(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', 'odt', '--outdir', join(work, 'odt'), file], { stdio: 'ignore', timeout: 90000 });
    const pdf = join(work, 'pdf', 'commented.pdf');
    let text = '';
    try { text = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' }); } catch { text = ''; }
    if (text) ok(text.includes('Say which budget.'), 'LibreOffice renders the comment in the margin', text.slice(0, 200));
    else ok(existsSync(pdf) && readFileSync(pdf).length > 1000, 'LibreOffice converts the commented file to PDF (pdftotext missing)');
    const odt = m.readZip(readFileSync(join(work, 'odt', 'commented.odt')));
    const content = m.entryText(odt, 'content.xml') ?? '';
    ok((content.match(/<office:annotation[ >]/g) ?? []).length === 2 && content.includes('Say which budget.'), 'LibreOffice opens it with both comments (.odt has two annotations)');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all ok');
