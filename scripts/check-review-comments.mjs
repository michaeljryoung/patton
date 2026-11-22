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
//  8. a run whose properties hold a tracked formatting change (w:rPrChange,
//     a nested w:rPr) is split into well-formed XML (xmllint), runs nest;
//  9. a strict-OOXML file's existing comments part is kept and added to;
//     a `../word/comments.xml` target is followed, not orphaned;
// 10. a selection across a tracked deletion is matched, its reference run
//     placed after the deletion;
// 11. checkWellFormed agrees with xmllint on good and broken parts;
//  7. with LibreOffice installed (its profile in a folder with a space, as
//     userData's "Application Support" is): the commented file converts to PDF with the
//     comment's text in the margin (pdftotext) and to .odt with two
//     office:annotation elements (the file opens cleanly).
// Run: node scripts/check-review-comments.mjs
// Prints `ok <what>` or `not ok <what>: <detail>`; exit 1 on any failure.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'check-review-comments-'));
let failures = 0;
const ok = (cond, what, detail = '') => {
  if (cond) console.log(`ok ${what}`);
  else { failures++; console.log(`not ok ${what}${detail ? `: ${detail}` : ''}`); }
};

try {
  const entry = join(work, 'entry.ts');
  writeFileSync(entry, `export * from ${JSON.stringify(join(root, 'src/main/docx-zip.ts'))};\nexport * from ${JSON.stringify(join(root, 'src/main/docx-comments.ts'))};\nexport * from ${JSON.stringify(join(root, 'src/main/xml-wellformed.ts'))};\n`);
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


  const xmllintOk = (xml) => {
    const f = join(work, `part-${Math.random().toString(36).slice(2)}.xml`);
    writeFileSync(f, xml);
    try { execFileSync('/usr/bin/xmllint', ['--noout', f], { stdio: 'ignore' }); return true; } catch { return false; }
  };
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const makeWith = (docXml, extra = [], rels = docRels, root = rootRels) => {
    const entries = [];
    for (const [name, text] of [['[Content_Types].xml', types], ['_rels/.rels', root], ['word/_rels/document.xml.rels', rels], ['word/document.xml', docXml], ...extra]) m.setEntryText(entries, name, text);
    return m.readZip(m.writeZip(entries));
  };

  // 8. w:rPrChange: the run's properties hold a nested rPr.
  {
    const d = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body><w:p>`
      + '<w:r><w:rPr><w:b/><w:rPrChange w:id="5" w:author="A" w:date="2026-01-01T00:00:00Z"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr><w:t>Revenue grows each quarter.</w:t></w:r>'
      + '</w:p><w:sectPr/></w:body></w:document>';
    const e = makeWith(d);
    const r = m.addComment(e, { quote: 'grows each', occurrence: 0, text: 'By how much?', author: 'A', initials: 'A', date });
    const out = m.entryText(e, 'word/document.xml') ?? '';
    ok(r.ok && xmllintOk(out), 'a run with w:rPrChange splits into well-formed XML (xmllint)', out.slice(0, 600));
    ok(m.checkWellFormed(out).ok, 'checkWellFormed accepts the split');
    ok((out.match(/<w:rPrChange /g) ?? []).length === 3 && m.bodyText(out).key === m.bodyText(d).key, 'every half keeps the whole properties, tracked change included; text unchanged');
    // Nested runs: a text box inside a run's drawing, text after it.
    const n = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body><w:p>`
      + '<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>Before box </w:t><w:pict><w:txbxContent><w:p><w:r><w:t>Inside the box</w:t></w:r></w:p></w:txbxContent></w:pict><w:t>after box.</w:t></w:r>'
      + '</w:p><w:sectPr/></w:body></w:document>';
    const e2 = makeWith(n);
    const r2 = m.addComment(e2, { quote: 'after box', occurrence: 0, text: 'x', author: 'A', initials: 'A', date });
    const out2 = m.entryText(e2, 'word/document.xml') ?? '';
    ok(r2.ok && xmllintOk(out2) && /<w:r><w:rPr><w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">after box/.test(out2), 'text after a text box in the same run keeps that run\'s properties', out2);
    const r3 = m.addComment(makeWith(n), { quote: 'the box after', occurrence: 0, text: 'x', author: 'A', initials: 'A', date });
    ok(!r3.ok && r3.reason === 'crosses-box', 'a selection from a text box into the page is refused as such', r3);
  }

  // 9. strict OOXML and a ../ target.
  {
    const SW = 'xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"';
    const strictRoot = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const strictRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId4" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/comments" Target="comments.xml"/></Relationships>';
    const sd = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${SW}><w:body><w:p><w:commentRangeStart w:id="3"/><w:r><w:t>Strict text here.</w:t></w:r><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r></w:p><w:sectPr/></w:body></w:document>`;
    const sc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments ${SW}><w:comment w:id="3" w:author="Em" w:date="2026-01-01T00:00:00Z" w:initials="E"><w:p><w:r><w:t>Old comment</w:t></w:r></w:p></w:comment></w:comments>`;
    const e = makeWith(sd, [['word/comments.xml', sc]], strictRels, strictRoot);
    const r = m.addComment(e, { quote: 'text here', occurrence: 0, text: 'New one', author: 'A', initials: 'A', date });
    const listed = m.listComments(e);
    ok(r.ok && r.id === '4' && listed.length === 2 && listed[0].text === 'Old comment' && listed[1].text === 'New one', 'strict OOXML: the existing comments part is kept and added to', listed);
    ok(((m.entryText(e, 'word/_rels/document.xml.rels') ?? '').match(/comments"/g) ?? []).length === 1, 'strict OOXML: no second comments relationship');
    const sd2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${SW}><w:body><w:p><w:r><w:t>Strict text here.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
    const e2 = makeWith(sd2, [], '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>', strictRoot);
    const r2 = m.addComment(e2, { quote: 'Strict', occurrence: 0, text: 'y', author: 'A', initials: 'A', date });
    ok(r2.ok && (m.entryText(e2, 'word/_rels/document.xml.rels') ?? '').includes('purl.oclc.org/ooxml/officeDocument/relationships/comments') && (m.entryText(e2, 'word/comments.xml') ?? '').includes('purl.oclc.org/ooxml/wordprocessingml/main'), 'strict OOXML: a new comments part uses the strict names', m.entryText(e2, 'word/comments.xml'));
    const upRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../word/comments.xml"/></Relationships>';
    const tc = sc.replace(SW, W);
    const e3 = makeWith(doc, [['word/comments.xml', tc]], upRels);
    const r3 = m.addComment(e3, { quote: 'Page two', occurrence: 0, text: 'z', author: 'A', initials: 'A', date });
    ok(r3.ok && !e3.some((x) => x.name.includes('..')) && m.listComments(e3).length === 2, 'a ../word/comments.xml target is followed: one part, both comments', e3.map((x) => x.name));
    ok(m.resolvePart('word/', '../x/../word/c.xml') === 'word/c.xml' && m.resolvePart('word/', '../../c.xml') === null && m.resolvePart('word/', 'https://evil/c.xml') === null && m.resolvePart('word/', '/word/my%20c.xml') === 'word/my c.xml', 'resolvePart: dots, escapes, absolute, external');
    const extRels = upRels.replace('Target="../word/comments.xml"', 'Target="https://example.com/c.xml" TargetMode="External"');
    const e4 = makeWith(doc, [], extRels);
    const r4 = m.addComment(e4, { quote: 'Page two', occurrence: 0, text: 'z', author: 'A', initials: 'A', date });
    ok(!r4.ok && r4.reason === 'odd-comments' && !m.entryText(e4, 'word/comments.xml'), 'an external comments target is refused, nothing written', r4);
  }

  // 10. across a tracked deletion.
  {
    const d = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body><w:p>`
      + '<w:r><w:t xml:space="preserve">The fee is </w:t></w:r><w:del w:id="7" w:author="Em" w:date="2026-01-01T00:00:00Z"><w:r><w:rPr><w:b/></w:rPr><w:delText>forty</w:delText></w:r></w:del><w:ins w:id="8" w:author="Em" w:date="2026-01-01T00:00:00Z"><w:r><w:t>fifty</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> pounds.</w:t></w:r>'
      + '</w:p><w:sectPr/></w:body></w:document>';
    const e = makeWith(d);
    const r = m.addComment(e, { quote: 'fee is forty', occurrence: 0, text: 'Which?', author: 'A', initials: 'A', date });
    const out = m.entryText(e, 'word/document.xml') ?? '';
    ok(r.ok && xmllintOk(out), 'a selection ending inside a tracked deletion is matched, well-formed', r);
    const delEnd = out.indexOf('</w:del>');
    ok(out.indexOf('<w:commentRangeEnd w:id="0"/>') < delEnd && out.indexOf('<w:commentReference w:id="0"/>') > delEnd && /<w:delText xml:space="preserve">forty<\/w:delText>/.test(out), 'the range ends inside the deletion, its reference run after it', out);
    const listed = m.listComments(e);
    ok(listed[0]?.quote === 'fee is forty', 'listComments quotes the deleted text too', listed);
    const e2 = makeWith(d);
    const r2 = m.addComment(e2, { quote: 'fortyfifty pounds', occurrence: 0, text: 'x', author: 'A', initials: 'A', date });
    ok(r2.ok && xmllintOk(m.entryText(e2, 'word/document.xml') ?? ''), 'a selection starting inside a deletion and running past it', r2);
  }

  // 11. checkWellFormed against xmllint.
  {
    const cases = [
      `<?xml version="1.0"?>\n<a ${W}><w:b x="1" y='2'>t &amp; &#x41; <![CDATA[<x>]]></w:b><!-- c --><?pi x?></a>`,
      '<a><b></a></b>', '<a><b/>', '<a x="1" x="2"/>', '<a x=1/>', '<a>&nbsp;</a>', '<a>&#0;</a>', '<a x="<"/>', '<a/><b/>',
      'text<a/>', '<a><!-- a -- b --></a>', '<a>]]></a>', '<a>\u0001</a>', '<a\n  x="1"\n/>', '<a></a >', '<a></ a>', '<a>< b/></a>',
      ' <?xml version="1.0"?><a/>', '<a>&#xD800;</a>', '<1a/>', '<a b="1"c="2"/>',
    ];
    const disagree = cases.filter((x) => m.checkWellFormed(x).ok !== xmllintOk(x));
    ok(disagree.length === 0, `checkWellFormed agrees with xmllint on ${cases.length} parts`, disagree);
    ok(!m.checkWellFormed('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>').ok, 'a DOCTYPE is refused (xmllint takes it; Office never writes one)');
    ok(m.checkWellFormed(doc).ok && m.checkWellFormed(types).ok && m.checkWellFormed(rootRels).ok, 'checkWellFormed accepts the fixture parts');
  }

  // 7
  const soffice = ['/opt/homebrew/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'].find((p) => existsSync(p));
  if (!soffice) {
    console.log('skip LibreOffice round trip: soffice not found');
  } else {
    const file = join(work, 'commented.docx');
    writeFileSync(file, m.writeZip(after2));
    const profile = pathToFileURL(join(work, 'Application Support', 'lo-profile')).href;
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
