// Hidden-Electron check of the review tab end to end (docs/review-tab.md, map
// nodes rt_open, rt_layout, rt_print, rt_comments, rt_claude, rt_drive,
// rt_check). The REAL main half (review-docs.ts with its IPC handlers,
// review-layout.ts running LibreOffice, docx-comments.ts writing the file) in
// this Electron's main process, and the REAL TabManager, Tab, Pane,
// ReviewTabs, ReviewView and pdf.js (with its worker) in a window that is
// never shown, with the app's own CSS. Only the pty and settings are stubbed;
// Send to Drive's upload is a fake in the page (nothing is ever sent), while
// main's own Lindus gate is asked for real. On a two-page .docx made here:
//  1. main's review:open makes a review tab titled with the file's name, laid
//     out with the same page count as `soffice --convert-to pdf` of the file,
//     each page drawn on a canvas with pdf.js's text layer; pdf.js runs in its
//     Web Worker, not the main-thread fallback;
//  2. text selected on page 2 and "Add comment" puts a real Word comment in
//     word/comments.xml, anchored in page 2's paragraph, listed in the panel;
//     LibreOffice still lays it out on two pages;
//  3. Print builds one print-only page per laid-out page and calls
//     window.print(); printToPDF of the window then has exactly that many
//     pages; afterprint removes them;
//  4. "Send comments to Claude" pastes one bracketed message holding the
//     comment into the origin pane's pty, then Enter, and shows the origin
//     tab; while that Claude is blocked (7501) it is refused with a visible
//     note and nothing is written;
//  5. a Lindus file asks in Patton's own confirm before Send to Drive: Don't
//     send sends nothing, Send to my Drive sends with confirmLindus; the link
//     lands in the origin pane's session bar Links; main refuses a Lindus
//     file without confirmLindus;
//  6. every toolbar and panel control has an accessible name;
//  7. light and dark screenshots of the real tab (REVIEW_SHOTS_DIR, if set);
//  8. with REVIEW_ASAR=<packaged app.asar>: pdf.js's worker asset inside the
//     packaged asar starts as a real Web Worker, under the packaged main
//     bundle's own CSP (the whole check runs under the app's CSP, read from
//     the packaged bundle with REVIEW_ASAR, else from window-manager.ts).
// Run: node scripts/check-review-tab.cjs   (needs LibreOffice and poppler's pdfinfo; skips with a line without)
//   REVIEW_SHOTS_DIR=<folder>   save review-light.png and review-dark.png there
//   REVIEW_ASAR=<app.asar>      also check the packaged build's worker asset
//   REVIEW_CHECK_DIR=<folder>   keep the bundle, files and logs there
// Prints `ok <what>` or `not ok <what>: <detail>`; exit 1 on any failure.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HARD_TIMEOUT_MS = 240000;
const SOFFICE = '/opt/homebrew/bin/soffice';
const PDFINFO = ['/opt/homebrew/bin/pdfinfo', '/usr/local/bin/pdfinfo'].find((p) => fs.existsSync(p));

if (process.versions.electron) {
  electronMain();
} else {
  nodeRunner().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}

function pdfPages(file) {
  const out = require('node:child_process').execFileSync(PDFINFO, [file], { encoding: 'utf8' });
  const m = /^Pages:\s+(\d+)/m.exec(out);
  return m ? Number(m[1]) : -1;
}

// ---------------------------------------------------------------- Node side
async function nodeRunner() {
  if (!fs.existsSync(SOFFICE) || !PDFINFO) {
    console.log('ok skipped: needs LibreOffice (soffice) and pdfinfo');
    return;
  }
  const { build } = require('esbuild');
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const repo = path.join(__dirname, '..');
  const ownDir = !process.env.REVIEW_CHECK_DIR;
  const outDir = process.env.REVIEW_CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'patton-check-review-'));
  fs.mkdirSync(outDir, { recursive: true });
  const resultFile = path.join(outDir, 'result.json');
  fs.rmSync(resultFile, { force: true });

  // `?url` imports (the pdf.js worker): the file copied beside page.html.
  const urlAssets = {
    name: 'url-assets',
    setup(b) {
      b.onResolve({ filter: /\?url$/ }, (args) => ({ path: require.resolve(args.path.replace(/\?url$/, ''), { paths: [repo] }), namespace: 'url-asset' }));
      b.onLoad({ filter: /.*/, namespace: 'url-asset' }, (args) => {
        const name = path.basename(args.path);
        fs.copyFileSync(args.path, path.join(outDir, name));
        return { contents: `export default ${JSON.stringify('./' + name)};`, loader: 'js' };
      });
    },
  };
  await build({
    stdin: {
      resolveDir: repo, loader: 'ts',
      contents: `
        import { TabManager } from './src/renderer/services/tab-manager';
        import { loadPdfjs, startPdfWorker, setPdfWorkerUrl } from './src/renderer/services/review-pdf';
        import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
        setPdfWorkerUrl(pdfWorkerUrl);
        (window as any).__rt = { TabManager, loadPdfjs, startPdfWorker };
      `,
    },
    bundle: true, platform: 'browser', format: 'iife', outfile: path.join(outDir, 'page.js'),
    loader: { '.css': 'empty' }, logLevel: 'silent', plugins: [urlAssets],
  });
  // The main half for this Electron's main process. Settings are a stub (the
  // real store pulls in node-pty and the keychain).
  const storeStub = {
    name: 'store-stub',
    setup(b) {
      b.onResolve({ filter: /^\.\/store$/ }, () => ({ path: 'store', namespace: 'store-stub' }));
      b.onLoad({ filter: /.*/, namespace: 'store-stub' }, () => ({ contents: 'export function getSettings() { return { driveFolder: "Patton", driveAccount: "" }; }', loader: 'js' }));
    },
  };
  await build({
    stdin: {
      resolveDir: repo, loader: 'ts',
      contents: `
        export { openReview, registerReviewHandlers } from './src/main/review-docs';
        export { readZip, entryText, setEntryText, writeZip } from './src/main/docx-zip';
      `,
    },
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(outDir, 'main-half.cjs'),
    external: ['electron'], logLevel: 'silent', plugins: [storeStub],
  });
  const styles = ['main', 'tabs', 'terminal', 'editor', 'settings', 'board', 'session-bar', 'review']
    .map((n) => fs.readFileSync(path.join(repo, 'src/renderer/styles', n + '.css'), 'utf8'));
  fs.writeFileSync(path.join(outDir, 'page.css'),
    fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css', { paths: [repo] }), 'utf8') + '\n' + styles.join('\n'));
  fs.writeFileSync(path.join(outDir, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head><body>' +
    '<div id="app"><div id="tab-bar"></div><div id="main"><div id="content"></div></div></div>' +
    '<script src="page.js"></script></body></html>');
  fs.writeFileSync(path.join(outDir, 'preload.cjs'), "window.__ipc = require('electron').ipcRenderer;\n");

  const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if (!fs.existsSync(electronBin)) {
    console.error('missing Electron binary (run `npx install-electron --no` once)', { electronBin });
    process.exit(2);
  }
  const log = fs.openSync(path.join(outDir, 'electron.log'), 'w');
  const env = { ...process.env, REVIEW_CHECK_DIR: outDir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PATTON_DRIVE_DRY_RUN;
  const child = spawn(electronBin, [__filename], { env, stdio: ['ignore', log, log] });
  const killer = setTimeout(() => child.kill('SIGKILL'), HARD_TIMEOUT_MS + 5000);
  await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(killer);
  fs.closeSync(log);

  if (!fs.existsSync(resultFile)) {
    console.error(`no result; see ${path.join(outDir, 'electron.log')}`);
    process.exit(2);
  }
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  let failed = 0;
  for (const c of result.checks || []) {
    if (!c.ok) failed++;
    console.log(c.ok ? `ok ${c.name}` : `not ok ${c.name}: ${JSON.stringify(c.detail)}`);
  }
  if (result.error) {
    failed++;
    console.log(`not ok the check ran to the end: ${result.error}`);
  }
  for (const m of result.measures || []) console.log('  ' + m);
  console.log(`\n${(result.checks || []).length - (failed - (result.error ? 1 : 0))} ok, ${failed} not ok`);
  if (ownDir && !failed) fs.rmSync(outDir, { recursive: true, force: true });
  else if (failed) console.log(`(files kept in ${outDir})`);
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------ Electron side
function electronMain() {
  const { app, BrowserWindow, nativeTheme } = require('electron');
  const { execFileSync } = require('node:child_process');
  const outDir = process.env.REVIEW_CHECK_DIR;
  const resultFile = path.join(outDir, 'result.json');
  const checks = [];
  const measures = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: ok ? null : detail });
  const write = (extra = {}) => fs.writeFileSync(resultFile, JSON.stringify({ checks, measures, ...extra }, null, 1));
  app.setPath('userData', path.join(outDir, 'ud'));
  if (app.dock) app.dock.hide();
  setTimeout(() => {
    try { write({ error: 'timeout' }); } catch { /* the parent reports "no result" */ }
    app.exit(1);
  }, HARD_TIMEOUT_MS);

  const M = require(path.join(outDir, 'main-half.cjs'));

  // A small striped PNG (the document's picture), made here.
  function stripedPng(w, h) {
    const zlib = require('node:zlib');
    const rows = [];
    for (let y = 0; y < h; y++) {
      const row = Buffer.alloc(1 + w * 3);
      for (let x = 0; x < w; x++) {
        const on = Math.floor(x / 6) % 2 === 0;
        row[1 + x * 3] = on ? 30 : 240; row[2 + x * 3] = on ? 90 : 240; row[3 + x * 3] = on ? 200 : 240;
      }
      rows.push(row);
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  }

  // A two-page .docx: a heading, a paragraph, a table, a picture, a page
  // break, then page two. `pages` > 2 adds that many more pages of text (the
  // long file the memory check scrolls through).
  function makeDocx(file, pages = 2) {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
    const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/stripes.png"/></Relationships>';
    const p = (t, bold) => `<w:p><w:r>${bold ? '<w:rPr><w:b/><w:sz w:val="36"/></w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const cell = (t) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${p(t)}</w:tc>`;
    const border = (side) => `<w:${side} w:val="single" w:sz="8" w:space="0" w:color="000000"/>`;
    const table = '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('') + '</w:tblBorders></w:tblPr>'
      + '<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>'
      + `<w:tr>${cell('Team')}${cell('Budget')}${cell('Headcount')}</w:tr><w:tr>${cell('Platform')}${cell('1,200,000')}${cell('14')}</w:tr></w:tbl>`;
    const emu = 914400; // one inch
    const picture = `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${2 * emu}" cy="${emu / 2}"/><wp:docPr id="1" name="Stripes"/>`
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
      + '<pic:nvPicPr><pic:cNvPr id="1" name="stripes.png"/><pic:cNvPicPr/></pic:nvPicPr>'
      + '<pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${2 * emu}" cy="${emu / 2}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    let more = '';
    for (let i = 3; i <= pages; i++) more += pageBreak + p(`Section ${i}`, true) + p(`Notes for section ${i}: each team reports monthly against the plan, and the budget is reviewed in the quarter after.`);
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>`
      + p('Quarterly plan', true)
      + p('The budget is fixed for the year. Costs &amp; hiring follow the plan agreed in October.')
      + table
      + picture
      + p('Each team reports monthly against the plan.')
      + pageBreak
      + p('Page two', true)
      + p('Risks: the budget is fixed, so new work waits for the next quarter.')
      + more
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
    const entries = [];
    for (const [name, text] of [['[Content_Types].xml', types], ['_rels/.rels', rootRels], ['word/_rels/document.xml.rels', docRels], ['word/document.xml', doc]]) M.setEntryText(entries, name, text);
    const png = stripedPng(120, 30);
    entries.push({ name: 'word/media/stripes.png', method: 8, crc: 0, compressedSize: 0, size: png.length, raw: Buffer.alloc(0), replaced: png });
    fs.writeFileSync(file, M.writeZip(entries));
  }

  function sofficePages(docx) {
    const dir = fs.mkdtempSync(path.join(outDir, 'so-'));
    execFileSync(SOFFICE, [`-env:UserInstallation=file://${path.join(outDir, 'so-profile')}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, docx], { stdio: 'ignore', timeout: 120000 });
    return pdfPages(path.join(dir, path.basename(docx).replace(/\.docx$/, '.pdf')));
  }

  app.whenReady().then(async () => {
    try {
      nativeTheme.themeSource = 'light';
      const docsDir = path.join(outDir, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      const docx = path.join(docsDir, 'Quarterly plan.docx');
      const lindusDocx = path.join(docsDir, 'Lindus trial notes.docx');
      makeDocx(docx);
      makeDocx(lindusDocx);
      const want = sofficePages(docx);
      measures.push(`soffice --convert-to pdf: ${want} pages`);
      check('the test document lays out on two pages in LibreOffice', want === 2, { pages: want });

      M.registerReviewHandlers();
      // The window runs under the app's own CSP, set as window-manager.ts sets
      // it, on a file:// page as the packaged renderer is: from the packaged
      // main bundle with REVIEW_ASAR, else from window-manager.ts without the
      // dev server's part.
      const asar = process.env.REVIEW_ASAR ? path.resolve(process.env.REVIEW_ASAR) : '';
      const cspSource = asar
        ? fs.readFileSync(path.join(asar, '.vite/build/main.cjs'), 'utf8')
        : fs.readFileSync(path.join(__dirname, '../src/main/window-manager.ts'), 'utf8');
      const csp = ((/`(default-src 'self';[^`]*)`/.exec(cspSource) || [])[1] || '').replace(/\$\{[^}]*\}/g, '');
      check(`the window has the ${asar ? 'packaged' : 'source'} app's CSP (script-src 'self', no blob:)`, /script-src 'self'/.test(csp) && !/blob:/.test(csp), csp);
      const win = new BrowserWindow({
        show: false, width: 1400, height: 1000,
        webPreferences: { backgroundThrottling: false, contextIsolation: false, nodeIntegration: false, sandbox: false, preload: path.join(outDir, 'preload.cjs') },
      });
      win.webContents.session.webRequest.onHeadersReceived((details, cb) => cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } }));
      await win.loadFile(path.join(outDir, 'page.html'));
      const evalBlocked = await win.webContents.executeJavaScript('(() => { try { (0, eval)("1"); return false; } catch { return true; } })()');
      check('the CSP is in force on the page (eval refused)', evalBlocked, { evalBlocked });
      // Why review-pdf.ts starts its own worker: on this opaque-origin page
      // pdf.js would wrap the worker in a blob: URL, which this CSP refuses.
      const blobWorker = await win.webContents.executeJavaScript(`new Promise((resolve) => {
        let w;
        try { w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))); } catch (err) { resolve('refused: ' + err.name); return; }
        const t = setTimeout(() => resolve('silent'), 3000);
        w.onmessage = () => { clearTimeout(t); resolve('ran'); };
        w.onerror = () => { clearTimeout(t); resolve('refused: error event'); };
      })`);
      check('under that CSP a blob: worker (pdf.js\'s own wrapper) is refused', blobWorker !== 'ran', { blobWorker });
      measures.push(`blob: worker under the CSP: ${blobWorker}`);
      win.webContents.focus();
      const js = (fn, arg) => win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`);

      await js(pageSetup);
      M.openReview(win.webContents, docx);
      const shown = await js(pageShown);
      check('main\'s review:open makes a review tab titled with the file\'s name', shown.title === 'Quarterly plan.docx', shown);
      check(`the tab shows the same page count as soffice (${want})`, shown.pages === want, shown);
      check('every page is drawn on a canvas with a text layer', shown.canvases === want && shown.layersWithText === want, shown);
      check('pdf.js runs in its Web Worker (not the main-thread fallback)', shown.workerMode === 'worker', shown.logs);
      check('every control in the tab has an accessible name', shown.unnamed.length === 0, shown.unnamed);
      check('the toolbar has the four buttons, each visible', JSON.stringify(shown.buttons) === JSON.stringify(['Print', 'Send to Drive', 'Open in Word', 'Send comments to Claude']), shown.buttons);
      check('each toolbar button\'s accessible name holds its visible text', shown.namesHoldText.length === 0, shown.namesHoldText);
      check('the table\'s text is on page 1', shown.tableText, shown);
      check('the picture is drawn on page 1 (its blue stripes on the canvas)', shown.pictureInk > 500, { pictureInk: shown.pictureInk });
      measures.push(`tab: ${shown.pages} pages, ${shown.spans} text spans`);

      const added = await js(pageAddComment);
      check('a selection holding no text shows a short note', /Select words/.test(added.noTextNote), added);
      check('a selection that ends outside the pages (mouse let go over the panel) still becomes the quote, cut to the page\'s text', added.outsideSelected.includes('budget is fixed, so new work') && !/Comments/.test(added.outsideSelected), added);
      check('text selected on page 2 becomes the pending quote', added.selected.includes('budget is fixed, so'), added);
      check('the comment shows in the panel', added.listed.includes('Say which quarter.') && added.count === '1', added);
      const entries = M.readZip(fs.readFileSync(docx));
      const commentsXml = M.entryText(entries, 'word/comments.xml') || '';
      const docXml = M.entryText(entries, 'word/document.xml') || '';
      check('the comment is in word/comments.xml', /<w:comment [^>]*w:id="\d+"[^>]*>[\s\S]*Say which quarter\.[\s\S]*<\/w:comment>/.test(commentsXml), commentsXml.slice(0, 400));
      const para = docXml.split('</w:p>').find((p) => p.includes('commentRangeStart')) || '';
      check('the comment is anchored in page 2\'s paragraph', para.includes('Risks:') && docXml.indexOf('commentRangeStart') > docXml.indexOf('Page two'), para.slice(0, 300));
      const after = sofficePages(docx);
      check('LibreOffice still lays the commented file out on two pages', after === 2, { pages: after });
      measures.push(`comments.xml: ${commentsXml.length} bytes, quote occurrence ${added.occurrence}`);

      // 2b. the comment's highlight, after the re-layout its write set off
      const marks = await js(pageMarks);
      check('the status "The file changed: laying it out again…" goes when the new layout shows', marks.relaidOut && !/changed/.test(marks.status) && /^2 pages/.test(marks.status), marks);
      check('the pages carry no margin notes: the comment\'s text is not on them (it is in the panel)', !marks.layerHasComment, marks);
      check('a comment leaves the page at 100%: the heading sits where it did before the comment', !!marks.headingBox && !!shown.headingBox && Math.abs(marks.headingBox.left - shown.headingBox.left) <= 1 && Math.abs(marks.headingBox.height - shown.headingBox.height) <= 1, { before: shown.headingBox, after: marks.headingBox });
      check('the comment\'s text is highlighted on page 2 (and only there)', marks.marksOnPage2 > 0 && marks.marksElsewhere === 0 && marks.markInside, marks);
      check('the highlight covers the quoted words (by the text layer\'s characters, whose centres in a stretched fallback font can sit a few px off the ink: the next check pins the edges)', marks.coveredText.includes('budget is fixed,') && !/the|new/.test(marks.coveredText) && marks.coveredText.length < 40, marks);
      check('the highlight starts on its first letter and ends on its last (the canvas ink at each edge, a gap just outside)', !!marks.inkEdges && marks.inkEdges.inkAtLeft && marks.inkEdges.gapBeforeLeft && marks.inkEdges.inkAtRight && marks.inkEdges.gapAfterRight, marks.inkEdges);
      check('the highlight has a colour from its token, under the text layer', marks.markBg !== 'rgba(0, 0, 0, 0)' && marks.marksBelowText, marks);
      check('clicking the comment in the panel scrolls its page into view', marks.scrolledFrom !== marks.scrolledTo && marks.markInView, marks);
      check('the clicked comment is marked current in the panel and on the page', marks.listCurrent && marks.markActive, marks);
      check('clicking elsewhere on a page clears it; clicking the highlight selects its comment', marks.clearedByOther && marks.selectedByMark, marks);
      measures.push(`highlight: ${marks.marksOnPage2} box(es) on page 2, scrolled ${marks.scrolledFrom} → ${marks.scrolledTo}`);

      // 3. Print
      const printed = await js(pagePrint);
      check('Print calls window.print() once', printed.printCalls === 1, printed);
      check('Print builds one print-only page per laid-out page', printed.printPages === want, printed);
      const pdf = await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true });
      const printFile = path.join(outDir, 'printed.pdf');
      fs.writeFileSync(printFile, pdf);
      const printedPages = pdfPages(printFile);
      measures.push(`printToPDF: ${printedPages} pages`);
      check(`printToPDF of the window has exactly the laid-out pages (${want})`, printedPages === want, { printedPages });
      const cleaned = await js(pageAfterPrint);
      check('the status line still reads the page count after Print', /^2 pages/.test(printed.status), printed);
      check('afterprint removes the print-only pages', cleaned.left === 0 && !cleaned.printing, cleaned);

      // 7. screenshots of the real tab (light, dark)
      const shotsDir = process.env.REVIEW_SHOTS_DIR;
      if (shotsDir) {
        fs.mkdirSync(shotsDir, { recursive: true });
        for (const scheme of ['light', 'dark']) {
          nativeTheme.themeSource = scheme;
          await js(() => new Promise((r) => setTimeout(r, 600)));
          const img = await win.webContents.capturePage();
          const size = img.getSize();
          const file = path.join(shotsDir, `review-${scheme}.png`);
          fs.writeFileSync(file, img.toPNG());
          check(`${scheme} screenshot saved`, size.width > 0 && size.height > 0, size);
          measures.push(`${file} ${size.width}x${size.height}`);
        }
        nativeTheme.themeSource = 'light';
      }

      // 4. Send comments to Claude
      const sent = await js(pageSendToClaude);
      check('the button counts the comments not yet sent ("Send 1 comment to Claude")', sent.labelBefore === 'Send 1 comment to Claude', sent.labelBefore);
      check('while Claude is blocked (7501) the send is refused with a visible note', sent.blocked.text.includes('asking you something') && sent.blocked.visible, sent.blocked);
      check('while Claude is blocked nothing is written to its pty', sent.blocked.writes === 0, sent.blocked);
      check('Claude starting to ask between the paste and its Enter: no Enter is sent', sent.between.pastedFirst && !sent.between.enter, sent.between);
      check('… and the note says the comments are in Claude\'s input, not sent; they stay unsent', /not sent/.test(sent.between.text) && sent.between.visible && sent.between.labelAfter === 'Send 1 comment to Claude', sent.between);
      check('Send comments to Claude pastes one bracketed message into the origin pane', sent.pasted === 1 && sent.message.includes('Say which quarter.') && sent.message.startsWith('Comments on '), sent);
      check('the message names each comment\'s author and the text it is on', /On "budget is fixed, so": Say which quarter\. \([^)]+\)/.test(sent.message), sent.message);
      check('the message ends with Enter after the paste', sent.enterAfter, sent);
      check('nothing went to any other pane', sent.otherWrites === 0, sent);
      check('the origin tab is shown after sending', sent.activeIsOrigin, sent);
      check('sent comments are marked sent, and the button has nothing left to send', sent.markedSent && sent.labelAfter === 'Send comments to Claude' && sent.disabledAfter, sent);

      // 5. Lindus confirm before Send to Drive (fake upload in the page)
      M.openReview(win.webContents, lindusDocx);
      const drive = await js(pageDrive);
      check('a Lindus file asks in Patton\'s own confirm before Send to Drive', drive.asked && /Lindus/.test(drive.dialogText), drive);
      check('Don\'t send sends nothing', drive.callsAfterCancel === 0 && /Not sent/.test(drive.statusAfterCancel), drive);
      check('Send to my Drive sends with confirmLindus', drive.calls.length === 1 && drive.calls[0].confirmLindus === true, drive.calls);
      check('the Google Doc\'s link shows in the tab', drive.linkShown, drive);
      check('the link lands in the origin pane\'s session bar Links', drive.barLinks.some((l) => l.url === 'https://docs.google.com/document/d/fake-doc-id/edit' && /Google Doc/.test(l.label)), drive.barLinks);
      check('main refuses a Lindus file without confirmLindus', drive.mainGate === 'confirm-lindus', drive.mainGate);

      // 6. a long file: canvases only near the view; tab switch keeps the view
      const longDocx = path.join(docsDir, 'Long report.docx');
      makeDocx(longDocx, 40);
      const longWant = sofficePages(longDocx);
      M.openReview(win.webContents, longDocx);
      const long = await js(pageLong, { pages: longWant });
      measures.push(`long file: ${long.pages} pages, at most ${long.maxDrawn} drawn at once (${long.maxMB} MB of canvas at DPR ${long.dpr})`);
      check(`the long file shows soffice's ${longWant} pages, each drawn when scrolled to`, long.pages === longWant && long.allDrew, long);
      check('only pages near the view keep a canvas (memory stays bounded)', long.maxDrawn <= 8 && long.drawnAtEnd <= 8, long);
      check('switching to another tab and back keeps the page in view drawn', long.backShows && long.drawnWhileHidden > 0, long);

      // 6b. the file goes away and comes back; the session; closing the tab
      const open = await js(pageReviewState);
      check('a review tab is not saved in the session (it would come back as a bare shell)', open.reviews > 0 && open.savedTabs === open.tabs - open.reviews && open.savedActive === 0, open);
      const away = longDocx.replace(/\.docx$/, ' (moved).docx');
      fs.renameSync(longDocx, away);
      await new Promise((r) => setTimeout(r, 2500));
      const gone = await js(pageReviewState);
      check('a file renamed away while open: a visible note, the last pages still shown', /no longer there/.test(gone.note) && gone.canvases > 0 && /^40 pages/.test(gone.status), gone);
      fs.renameSync(away, longDocx);
      await new Promise((r) => setTimeout(r, 3500));
      const back = await js(pageReviewState);
      check('… renamed back (the same mtime and size): the note goes and the pages show', back.note === '' && back.canvases > 0, back);
      const closed = await js(pageCloseReview);
      check('closing a review tab ends it in main and the view', closed.afterClose === closed.before - 1 && closed.disposed && !closed.inDom && closed.mainWhy === 'unknown', closed);
      check('Reopen Closed Tab does not bring it back as an empty terminal', closed.afterReopen === closed.afterClose, closed);

      // 8. the packaged build's worker asset
      if (asar) {
        const assets = path.join(asar, '.vite/renderer/main_window/assets');
        const worker = (fs.existsSync(assets) ? fs.readdirSync(assets) : []).find((f) => /^pdf\.worker.*\.mjs$/.test(f));
        check('the packaged asar holds the pdf.js worker asset', !!worker, { assets });
        if (worker) {
          const workerUrl = `file://${path.join(assets, worker)}`;
          const mode = await js(pagePackagedWorker, workerUrl);
          check('the packaged worker asset starts as a real Web Worker and opens the PDF', mode.mode === 'worker' && mode.pages === want, mode);
          measures.push(`packaged worker: ${worker} → ${mode.mode}, ${mode.pages} pages`);
        }
      }
      write();
      app.exit(0);
    } catch (err) {
      write({ error: String((err && err.stack) || err) });
      app.exit(1);
    }
  });
}

// ---------------------------------------------------------- page functions
// Each runs inside the page, sent as source text.

async function pageSetup() {
  const ipc = window.__ipc;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = { writes: [], logs: [], driveCalls: [], printCalls: 0 };
  window.__S = S;
  let nextPty = 1;
  const answers = {
    'pty.create': () => nextPty++, 'pty.respawn': () => nextPty++, 'pty.getShell': () => '/bin/zsh', 'pty.getCwd': () => '',
    'pty.inputState': () => [{ dirty: false, length: 0, lastInputAt: 0, slashSubmitAt: 0, userStashAt: 0, pattonStashAt: 0 }],
    'history.get': () => [], 'pauseAll.stashKey': () => ({ ok: true }), 'session.get': () => null,
    'sessionFeed.watch': () => ({ ok: true }), 'sessionFeed.unwatch': () => undefined,
  };
  const stub = (name) => new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : stub(name ? name + '.' + String(k) : String(k))),
    apply: (_t, _this, args) => {
      const last = name.split('.').pop();
      if (/^on[A-Z]/.test(last)) return () => {};
      if (name === 'pty.write') { S.writes.push({ id: args[0], data: String(args[1]) }); return undefined; }
      if (name === 'log.send') { S.logs.push(JSON.stringify(args).slice(0, 300)); return undefined; }
      if (name === 'pty.resize') return undefined;
      return Promise.resolve(answers[name] ? answers[name]() : undefined);
    },
  });
  const patton = stub('');
  const review = {
    onOpen: (cb) => { const l = (_e, info) => cb(info); ipc.on('review:open', l); return () => ipc.removeListener('review:open', l); },
    onChanged: (cb) => { const l = (_e, id) => cb(id); ipc.on('review:changed', l); return () => ipc.removeListener('review:changed', l); },
    layout: (id) => ipc.invoke('review:layout', id),
    comments: (id) => ipc.invoke('review:comments', id),
    addComment: (id, c) => ipc.invoke('review:add-comment', id, c),
    openInWord: async () => true,
    // Fake: nothing is ever sent. A link like the Drive API's webViewLink.
    sendToDrive: async (id, opts) => {
      S.driveCalls.push({ id, confirmLindus: opts.confirmLindus });
      return { ok: true, dryRun: false, link: 'https://docs.google.com/document/d/fake-doc-id/edit', name: 'Lindus trial notes', account: 'someone@gmail.com' };
    },
    close: (id) => ipc.invoke('review:close', id),
  };
  window.patton = new Proxy(patton, { get: (t, k) => (k === 'review' ? review : k === 'openExternal' ? (async () => true) : t[k]) });
  window.print = () => { S.printCalls++; };

  const tm = new window.__rt.TabManager(document.getElementById('tab-bar'), document.getElementById('content'));
  window.__tm = tm;
  const origin = await tm.createTab();
  await sleep(300);
  const pane = origin.focusedPane;
  S.originTab = origin;
  S.originPane = pane;
  const term = pane.terminalView.terminal;
  // Claude Code at its prompt: bracketed paste on, 7501 idle.
  await new Promise((r) => term.write('\x1b[?2004h\x1b]7501;state=idle:app=claude-code\x07', r));
  await sleep(300);
  return true;
}

async function pageShown() {
  const headingBox = () => {
    const page = document.querySelector('.review-page[data-page="0"]');
    const span = page && [...page.querySelectorAll('.review-text-layer span')].find((x) => x.textContent.includes('Quarterly plan'));
    if (!span) return null;
    const p = page.getBoundingClientRect(); const r = span.getBoundingClientRect();
    return { left: Math.round(r.left - p.left), top: Math.round(r.top - p.top), height: Math.round(r.height) };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = window.__S;
  const tm = window.__tm;
  let view = null;
  for (let i = 0; i < 400; i++) {
    const tab = tm.getActiveTab();
    view = tab && tm.reviewTabs.viewOf(tab);
    if (view && view.pageCount > 0 && document.querySelectorAll('.review-page canvas').length >= view.pageCount
      && [...document.querySelectorAll('.review-text-layer')].filter((l) => l.textContent.trim()).length >= view.pageCount) break;
    await sleep(100);
  }
  const root = document.querySelector('.review');
  S.view = view;
  S.reviewTab = tm.getActiveTab();
  const controls = root ? [...root.querySelectorAll('button, textarea, input, select, [role="toolbar"], [role="region"], aside')] : [];
  const unnamed = controls.filter((c) => !(c.getAttribute('aria-label') || (c.textContent || '').trim() || c.getAttribute('aria-labelledby'))).map((c) => c.outerHTML.slice(0, 80));
  const workerLog = S.logs.find((l) => l.includes('[REVIEW] pdf worker')) || '';
  return {
    title: tm.getActiveTab()?.title,
    pages: view ? view.pageCount : 0,
    canvases: document.querySelectorAll('.review-page canvas').length,
    layersWithText: [...document.querySelectorAll('.review-text-layer')].filter((l) => l.textContent.trim()).length,
    spans: document.querySelectorAll('.review-text-layer span').length,
    workerMode: /"mode":"worker"/.test(workerLog) ? 'worker' : /"mode":"main-thread"/.test(workerLog) ? 'main-thread' : 'unknown',
    logs: S.logs.filter((l) => l.includes('REVIEW')).slice(0, 8),
    unnamed,
    buttons: root ? [...root.querySelectorAll('.review-actions button')].filter((b) => b.offsetParent !== null).map((b) => b.textContent) : [],
    status: root?.querySelector('.review-status')?.textContent,
    // Each toolbar button's accessible name holds its visible text (voice control).
    namesHoldText: root ? [...root.querySelectorAll('.review-actions button')].map((b) => ({ text: b.textContent, name: b.getAttribute('aria-label') || b.textContent }))
      .filter((x) => !x.name.includes(x.text)) : ['no root'],
    tableText: /Headcount/.test(document.querySelector('.review-text-layer[data-page="0"]')?.textContent || ''),
    // The picture's blue stripes on page 1's canvas.
    pictureInk: (() => {
      const cv = document.querySelector('.review-page[data-page="0"] canvas.review-canvas');
      if (!cv) return 0;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 150 && d[i] < 90 && d[i + 1] < 140) n++;
      return n;
    })(),
    // Where the heading sits on page 1 (a layout with margin notes shrinks the page and moves it).
    headingBox: headingBox(),
  };
}


async function pageAddComment() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = document.querySelector('.review');
  const layer = document.querySelector('.review-text-layer[data-page="1"]');
  const spans = [...layer.querySelectorAll('span')];
  const span = spans.find((s) => s.textContent.includes('budget is fixed, so'));
  if (!span) return { selected: '', listed: '', count: '', error: 'no span', spans: spans.map((s) => s.textContent) };
  const node = span.firstChild;
  const at = node.textContent.indexOf('budget is fixed, so');
  const sel0 = document.getSelection();
  const note = () => { const n = root.querySelector('.review-note'); return n.hidden ? '' : n.textContent; };
  // A selection holding no text (only page 2's canvas) says so.
  const page2 = root.querySelector('.review-page[data-page="1"]');
  const blank = document.createRange();
  blank.setStart(page2, 0); blank.setEnd(page2, 1);
  sel0.removeAllRanges(); sel0.addRange(blank);
  document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  const noTextNote = note();
  // A drag that starts in page 2's text and ends over the comments panel,
  // the mouse let go outside the pages: the words up to the page's end.
  const outside = document.createRange();
  outside.setStart(node, at);
  outside.setEnd(root.querySelector('.review-side-title'), 0);
  sel0.removeAllRanges(); sel0.addRange(outside);
  root.querySelector('.review-side').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  const outsideSelected = root.querySelector('.review-selected').textContent;
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + 'budget is fixed, so'.length);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  root.querySelector('.review-pages').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  const selected = root.querySelector('.review-selected').textContent;
  const input = root.querySelector('.review-input');
  input.value = 'Say which quarter.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const addDisabled = root.querySelector('.review-add-btn').disabled;
  root.querySelector('.review-add-btn').click();
  for (let i = 0; i < 100; i++) {
    if (root.querySelector('.review-count').textContent === '1') break;
    await sleep(100);
  }
  const view = window.__S.view;
  return {
    selected, addDisabled, noTextNote, outsideSelected,
    occurrence: view && view.selected ? view.selected.occurrence : '(cleared)',
    listed: root.querySelector('.review-comments').textContent,
    count: root.querySelector('.review-count').textContent,
    status: root.querySelector('.review-status').textContent,
    note: root.querySelector('.review-note').textContent,
  };
}

async function pageMarks() {
  const headingBox = () => {
    const page = document.querySelector('.review-page[data-page="0"]');
    const span = page && [...page.querySelectorAll('.review-text-layer span')].find((x) => x.textContent.includes('Quarterly plan'));
    if (!span) return null;
    const p = page.getBoundingClientRect(); const r = span.getBoundingClientRect();
    return { left: Math.round(r.left - p.left), top: Math.round(r.top - p.top), height: Math.round(r.height) };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = [...document.querySelectorAll('.review')].find((r) => r.getAttribute('aria-label') === 'Review of Quarterly plan.docx');
  const status = () => root.querySelector('.review-status').textContent;
  // The comment's write changes the file: main sees it (1 s poll + 400 ms),
  // and the view lays it out again.
  let sawChanged = false;
  for (let i = 0; i < 40 && !sawChanged; i++) { sawChanged = /changed/.test(status()); if (!sawChanged) await sleep(100); }
  let relaidOut = false;
  for (let i = 0; i < 200; i++) {
    if (!/Laying out|changed|Saving/.test(status()) && root.querySelector('.review-text-layer[data-page="1"]') && root.querySelector('.review-page[data-page="1"] .review-mark')) { relaidOut = true; break; }
    await sleep(100);
  }
  const pages = root.querySelector('.review-pages');
  const page2 = root.querySelector('.review-page[data-page="1"]');
  const marks2 = page2 ? [...page2.querySelectorAll('.review-mark')] : [];
  const marksElsewhere = [...root.querySelectorAll('.review-mark')].length - marks2.length;
  const pr = page2 ? page2.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0 };
  const mr = marks2[0] ? marks2[0].getBoundingClientRect() : null;
  const markInside = !!mr && mr.left >= pr.left && mr.right <= pr.right && mr.top >= pr.top && mr.bottom <= pr.bottom;
  // Which text-layer characters fall inside the first box (by their centres).
  let coveredText = '';
  if (mr) {
    for (const span of page2.querySelectorAll('.review-text-layer span')) {
      const node = span.firstChild;
      if (!node || node.nodeType !== 3) continue;
      for (let i = 0; i < node.data.length; i++) {
        const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
        const b = r.getBoundingClientRect();
        const cx = b.left + b.width / 2; const cy = b.top + b.height / 2;
        if (b.width > 0 && cx >= mr.left && cx <= mr.right && cy >= mr.top && cy <= mr.bottom) coveredText += node.data[i];
      }
    }
  }
  const markBg = marks2[0] ? getComputedStyle(marks2[0]).backgroundColor : '';
  // The highlight's edges against the ink on the page's canvas (read here, not
  // with the app's own snapping code): ink right inside each edge, none just outside.
  let inkEdges = null;
  const cv = page2 && page2.querySelector('canvas.review-canvas');
  if (cv && marks2[0]) {
    const pw = parseFloat(cv.style.width);
    const k = cv.width / pw;
    const ctx = cv.getContext('2d');
    const m = marks2[0];
    const L = parseFloat(m.style.left); const R = L + parseFloat(m.style.width);
    const mt = parseFloat(m.style.top); const mh = parseFloat(m.style.height);
    const y0 = Math.floor((mt + mh * 0.2) * k); const y1 = Math.ceil((mt + mh * 0.8) * k);
    const inkIn = (a, b) => {
      const x0 = Math.max(0, Math.round(a * k)); const x1 = Math.round(b * k);
      if (x1 <= x0) return false;
      const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      for (let i = 0; i < d.length; i += 4) if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 185) return true;
      return false;
    };
    inkEdges = { L, R, k, inkAtLeft: inkIn(L, L + 1.5), gapBeforeLeft: !inkIn(L - 1.2, L - 0.1), inkAtRight: inkIn(R - 1.5, R), gapAfterRight: !inkIn(R + 0.1, R + 1.5) };
  }
  const layerEl = page2 && page2.querySelector('.review-text-layer');
  const marksEl = page2 && page2.querySelector('.review-marks');
  const marksBelowText = !!layerEl && !!marksEl && (marksEl.compareDocumentPosition(layerEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && getComputedStyle(marksEl).pointerEvents === 'none';

  // Panel click → page scrolls to it.
  pages.scrollTop = 0;
  await sleep(100);
  const scrolledFrom = pages.scrollTop;
  root.querySelector('.review-comment-btn').click();
  await sleep(500);
  const scrolledTo = pages.scrollTop;
  const vr = pages.getBoundingClientRect();
  const m = root.querySelector('.review-page[data-page="1"] .review-mark');
  const r2 = m ? m.getBoundingClientRect() : null;
  const markInView = !!r2 && r2.top >= vr.top && r2.bottom <= vr.bottom;
  const listCurrent = root.querySelector('.review-comment-btn').getAttribute('aria-current') === 'true';
  const markActive = !!m && m.classList.contains('review-mark-active');

  // A click elsewhere on the page clears it; a click on the highlight selects it.
  document.getSelection().removeAllRanges();
  const clickAt = (x, y) => {
    const target = document.elementFromPoint(x, y) || pages;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
  };
  const p2 = page2.getBoundingClientRect();
  clickAt(p2.left + 10, Math.min(p2.bottom, vr.bottom) - 10);
  await sleep(100);
  const clearedByOther = root.querySelector('.review-comment-btn').getAttribute('aria-current') !== 'true';
  const r3 = root.querySelector('.review-page[data-page="1"] .review-mark').getBoundingClientRect();
  clickAt(r3.left + r3.width / 2, r3.top + r3.height / 2);
  await sleep(100);
  const selectedByMark = root.querySelector('.review-comment-btn').getAttribute('aria-current') === 'true'
    && root.querySelector('.review-page[data-page="1"] .review-mark').classList.contains('review-mark-active');
  return {
    layerHasComment: [...root.querySelectorAll('.review-text-layer')].some((l) => l.textContent.includes('Say which quarter')),
    headingBox: headingBox(),
    sawChanged, relaidOut, status: status(), marksOnPage2: marks2.length, marksElsewhere, markInside, coveredText, markBg, inkEdges, marksBelowText,
    scrolledFrom, scrolledTo, markInView, listCurrent, markActive, clearedByOther, selectedByMark,
  };
}

async function pagePrint() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = window.__S;
  const before = S.printCalls;
  document.querySelector('.review-print-btn').click();
  for (let i = 0; i < 200 && S.printCalls === before; i++) await sleep(50);
  return {
    printCalls: S.printCalls - before,
    printPages: document.querySelectorAll('.review-print .review-print-page').length,
    printing: document.documentElement.classList.contains('review-printing'),
    status: document.querySelector('.review-status').textContent,
  };
}

async function pageAfterPrint() {
  window.dispatchEvent(new Event('afterprint'));
  await new Promise((r) => setTimeout(r, 50));
  return { left: document.querySelectorAll('.review-print').length, printing: document.documentElement.classList.contains('review-printing') };
}

async function pageSendToClaude() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = window.__S;
  const tm = window.__tm;
  const pane = S.originPane;
  const term = pane.terminalView.terminal;
  const root = () => [...document.querySelectorAll('.review')].find((r) => r.getAttribute('aria-label') === 'Review of Quarterly plan.docx');
  const btn = () => root().querySelector('.review-claude-btn');
  const noteOf = () => { const n = root().querySelector('.review-note'); return { text: n.textContent, visible: !n.hidden && n.offsetParent !== null }; };
  const setState = (st) => new Promise((r) => term.write(`\x1b]7501;state=${st}:app=claude-code\x07`, r));
  const mine = () => S.writes.filter((w) => w.id === pane.ptyId);
  const labelBefore = btn().textContent;

  // 1. Claude asks something (7501 blocked): refused, nothing written.
  await setState('blocked:kind=permission');
  await sleep(100);
  S.writes.length = 0;
  btn().click();
  await sleep(600);
  const blocked = { ...noteOf(), writes: mine().length };
  await setState('idle');
  await sleep(100);

  // 2. Claude starts asking between the paste and its Enter: no Enter.
  tm.switchToId(S.reviewTab.id);
  await sleep(200);
  S.writes.length = 0;
  btn().click();
  for (let i = 0; i < 400 && !mine().some((w) => w.data.includes('\x1b[200~')); i++) await sleep(2);
  const pastedFirst = mine().some((w) => w.data.includes('\x1b[200~'));
  await setState('blocked:kind=permission');
  await sleep(400);
  const between = { pastedFirst, enter: mine().some((w) => w.data === '\r'), ...noteOf(), labelAfter: btn().textContent };
  await setState('idle');
  await sleep(100);

  // 3. Sent: one bracketed paste, then Enter; the button counts what is left.
  tm.switchToId(S.reviewTab.id);
  await sleep(200);
  S.writes.length = 0;
  btn().click();
  for (let i = 0; i < 100; i++) {
    if (S.writes.some((w) => w.data === '\r')) break;
    await sleep(50);
  }
  await sleep(100);
  const pastes = mine().filter((w) => w.data.includes('\x1b[200~'));
  const message = pastes[0] ? pastes[0].data.replace('\x1b[200~', '').replace('\x1b[201~', '') : '';
  const pasteAt = mine().findIndex((w) => w.data.includes('\x1b[200~'));
  const enterAfter = pasteAt >= 0 && mine().slice(pasteAt + 1).some((w) => w.data === '\r');
  const otherWrites = S.writes.filter((w) => w.id !== pane.ptyId).length;
  const activeIsOrigin = tm.getActiveTab() === S.originTab;
  const status = root().querySelector('.review-status').textContent;
  const labelAfter = btn().textContent;
  const disabledAfter = btn().disabled;
  const markedSent = /sent to Claude/.test(root().querySelector('.review-comment-meta')?.textContent || '');
  // The next document opens from the Claude pane, as a link in it would.
  tm.switchToId(S.originTab.id);
  await sleep(200);
  return { labelBefore, pasted: pastes.length, message, enterAfter, otherWrites, activeIsOrigin, status, labelAfter, disabledAfter, markedSent, blocked, between };
}

// The front review tab's state, and the session as it would be saved.
async function pageReviewState() {
  const tm = window.__tm;
  const view = tm.reviewTabs.viewOf(tm.getActiveTab());
  if (!view) return { error: 'no review tab in front' };
  const r = view.element;
  const n = r.querySelector('.review-note');
  const orig = window.patton;
  let saved = null;
  window.patton = new Proxy(orig, { get: (t, k) => (k === 'session' ? { set: async (x) => { saved = x; }, get: async () => null } : t[k]) });
  try { await tm.saveSession(); } finally { window.patton = orig; }
  return {
    note: n.hidden ? '' : n.textContent, status: r.querySelector('.review-status').textContent,
    canvases: r.querySelectorAll('.review-page canvas').length, tabs: tm.tabs.length,
    reviews: tm.tabs.filter((t) => tm.reviewTabs.viewOf(t)).length,
    savedTabs: saved ? saved.tabs.length : -1, savedActive: saved ? saved.activeTabIndex : -1,
  };
}

// Close the front review tab, then Reopen Closed Tab.
async function pageCloseReview() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tm = window.__tm;
  const tab = tm.getActiveTab();
  const view = tm.reviewTabs.viewOf(tab);
  const docId = view.deps.info.docId;
  const before = tm.tabs.length;
  await tm.closeById(tab.id);
  await sleep(300);
  const main = await window.__ipc.invoke('review:layout', docId);
  const afterClose = tm.tabs.length;
  await tm.reopenClosed();
  await sleep(300);
  return { before, afterClose, afterReopen: tm.tabs.length, disposed: view.disposed, mainWhy: main && main.why, inDom: document.body.contains(view.element) };
}

// The long file: only pages near the view keep a canvas while he scrolls
// through all of it; each page is drawn when it comes into view; switching
// tabs and back keeps what shows.
async function pageLong(arg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = window.__S;
  const tm = window.__tm;
  let view = null;
  for (let i = 0; i < 400; i++) {
    const tab = tm.getActiveTab();
    view = tab && tm.reviewTabs.viewOf(tab);
    if (view && view.pageCount === arg.pages && view.element.querySelectorAll('.review-page canvas').length > 0) break;
    await sleep(100);
  }
  if (!view) return { error: 'no view' };
  const root = view.element;
  const canvasBytes = () => [...root.querySelectorAll('.review-page canvas')].reduce((n, c) => n + c.width * c.height * 4, 0);
  let maxDrawn = 0; let maxBytes = 0; let allDrew = true;
  for (let i = 0; i < view.pageCount; i++) {
    const slot = root.querySelector(`.review-page[data-page="${i}"]`);
    slot.scrollIntoView({ block: 'start' });
    let drew = false;
    for (let k = 0; k < 60 && !drew; k++) { drew = !!slot.querySelector('canvas') && !!slot.querySelector('.review-text-layer span'); if (!drew) await sleep(50); }
    allDrew = allDrew && drew;
    maxDrawn = Math.max(maxDrawn, view.drawnPages ?? root.querySelectorAll('.review-page canvas').length);
    maxBytes = Math.max(maxBytes, canvasBytes());
  }
  await sleep(300);
  const drawnAtEnd = root.querySelectorAll('.review-page canvas').length;
  // Away to the Claude tab and back: the page in view still shows.
  const here = tm.getActiveTab();
  const statusBefore = root.querySelector('.review-status').textContent;
  tm.switchToId(S.originTab.id);
  await sleep(400);
  const drawnWhileHidden = root.querySelectorAll('.review-page canvas').length;
  tm.switchToId(here.id);
  await sleep(50);
  const last = root.querySelector(`.review-page[data-page="${view.pageCount - 1}"]`);
  const backShows = !!last.querySelector('canvas') && root.querySelector('.review-status').textContent === statusBefore;
  return { pages: view.pageCount, maxDrawn, maxMB: Math.round(maxBytes / 1048576), allDrew, drawnAtEnd, drawnWhileHidden, backShows, dpr: window.devicePixelRatio };
}

async function pageDrive() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = window.__S;
  let root = null;
  for (let i = 0; i < 300; i++) {
    root = [...document.querySelectorAll('.review')].find((r) => r.getAttribute('aria-label') === 'Review of Lindus trial notes.docx');
    if (root && root.querySelectorAll('.review-page canvas').length > 0) break;
    await sleep(100);
  }
  const dialog = () => document.querySelector('.confirm-dialog-overlay, .confirm-dialog');
  const visibleDialog = () => { const d = dialog(); return d && !d.hidden && getComputedStyle(d).display !== 'none' ? d : null; };
  root.querySelector('.review-drive-btn').click();
  await sleep(200);
  const d1 = visibleDialog();
  const dialogText = d1 ? d1.textContent : '';
  document.querySelector('.confirm-dialog-cancel')?.click();
  await sleep(200);
  const callsAfterCancel = S.driveCalls.length;
  const statusAfterCancel = root.querySelector('.review-status').textContent;
  root.querySelector('.review-drive-btn').click();
  await sleep(200);
  const confirmBtn = document.querySelector('.confirm-dialog-confirm');
  confirmBtn?.click();
  await sleep(400);
  const link = root.querySelector('.review-doc-link');
  const barLinks = S.originPane.sessionBarModel.view(Date.now()).links.map((l) => ({ url: l.url, label: l.label }));
  // main's own gate, for real: this window's docs are the ones main opened.
  const tab = window.__tm.getActiveTab();
  const view = window.__tm.reviewTabs.viewOf(tab);
  const docId = view ? view.deps.info.docId : '';
  const gate = await window.__ipc.invoke('review:drive', docId, { confirmLindus: false });
  return {
    asked: !!d1, dialogText, callsAfterCancel, statusAfterCancel, calls: S.driveCalls,
    linkShown: !!link && !link.hidden, barLinks, mainGate: gate && gate.why,
  };
}

async function pagePackagedWorker(workerUrl) {
  // As review-pdf.ts starts its worker, with the packaged asset's URL.
  const pdfjs = await window.__rt.loadPdfjs();
  const S = window.__S;
  const bytes = await window.__ipc.invoke('review:layout', S.view.deps.info.docId);
  const port = await window.__rt.startPdfWorker(workerUrl);
  if (!port) return { mode: 'failed', error: 'the worker did not start', logs: S.logs.filter((l) => l.includes('pdf worker')) };
  const worker = pdfjs.PDFWorker.create({ port });
  const task = pdfjs.getDocument({ data: bytes.pdf.slice(), worker, isOffscreenCanvasSupported: false, disableWorkerRendering: true });
  try {
    const doc = await task.promise;
    return { mode: worker.port instanceof Worker ? 'worker' : 'main-thread', pages: doc.numPages };
  } catch (err) {
    return { mode: 'failed', error: String(err) };
  }
}
