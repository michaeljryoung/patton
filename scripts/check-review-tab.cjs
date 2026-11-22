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
//     packaged asar starts as a real Web Worker.
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
        import { loadPdfjs } from './src/renderer/services/review-pdf';
        (window as any).__rt = { TabManager, loadPdfjs };
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

  // A two-page .docx: two paragraphs, a page break, a third.
  function makeDocx(file) {
    const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const p = (t, bold) => `<w:p><w:r>${bold ? '<w:rPr><w:b/><w:sz w:val="36"/></w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + p('Quarterly plan', true)
      + p('The budget is fixed for the year. Costs &amp; hiring follow the plan agreed in October.')
      + p('Each team reports monthly against the plan.')
      + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
      + p('Page two', true)
      + p('Risks: the budget is fixed, so new work waits for the next quarter.')
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
    const entries = [];
    for (const [name, text] of [['[Content_Types].xml', types], ['_rels/.rels', rootRels], ['word/_rels/document.xml.rels', docRels], ['word/document.xml', doc]]) M.setEntryText(entries, name, text);
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
      const win = new BrowserWindow({
        show: false, width: 1400, height: 1000,
        webPreferences: { backgroundThrottling: false, contextIsolation: false, nodeIntegration: false, sandbox: false, preload: path.join(outDir, 'preload.cjs') },
      });
      await win.loadFile(path.join(outDir, 'page.html'));
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
      measures.push(`tab: ${shown.pages} pages, ${shown.spans} text spans`);

      const added = await js(pageAddComment);
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
      check('Send comments to Claude pastes one bracketed message into the origin pane', sent.pasted === 1 && sent.message.includes('Say which quarter.') && sent.message.startsWith('Comments on '), sent);
      check('the message ends with Enter after the paste', sent.enterAfter, sent);
      check('nothing went to any other pane', sent.otherWrites === 0, sent);
      check('the origin tab is shown after sending', sent.activeIsOrigin, sent);
      check('while Claude is blocked (7501) the send is refused with a visible note', sent.blocked.note.includes('asking you something') && sent.blocked.visible, sent.blocked);
      check('while Claude is blocked nothing is written to its pty', sent.blocked.writes === 0, sent.blocked);

      // 5. Lindus confirm before Send to Drive (fake upload in the page)
      M.openReview(win.webContents, lindusDocx);
      const drive = await js(pageDrive);
      check('a Lindus file asks in Patton\'s own confirm before Send to Drive', drive.asked && /Lindus/.test(drive.dialogText), drive);
      check('Don\'t send sends nothing', drive.callsAfterCancel === 0 && /Not sent/.test(drive.statusAfterCancel), drive);
      check('Send to my Drive sends with confirmLindus', drive.calls.length === 1 && drive.calls[0].confirmLindus === true, drive.calls);
      check('the Google Doc\'s link shows in the tab', drive.linkShown, drive);
      check('the link lands in the origin pane\'s session bar Links', drive.barLinks.some((l) => l.url === 'https://docs.google.com/document/d/fake-doc-id/edit' && /Google Doc/.test(l.label)), drive.barLinks);
      check('main refuses a Lindus file without confirmLindus', drive.mainGate === 'confirm-lindus', drive.mainGate);

      // 8. the packaged build's worker asset
      const asar = process.env.REVIEW_ASAR;
      if (asar) {
        const assets = path.join(asar, '.vite/renderer/main_window/assets');
        const worker = (fs.existsSync(assets) ? fs.readdirSync(assets) : []).find((f) => /^pdf\.worker.*\.mjs$/.test(f));
        check('the packaged asar holds the pdf.js worker asset', !!worker, { assets });
        if (worker) {
          const mode = await js(pagePackagedWorker, `file://${path.join(assets, worker)}`);
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
    selected, addDisabled,
    occurrence: view && view.selected ? view.selected.occurrence : '(cleared)',
    listed: root.querySelector('.review-comments').textContent,
    count: root.querySelector('.review-count').textContent,
    status: root.querySelector('.review-status').textContent,
    note: root.querySelector('.review-note').textContent,
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
  const root = () => [...document.querySelectorAll('.review')].find((r) => r.getAttribute('aria-label') === 'Review of Quarterly plan.docx');
  S.writes.length = 0;
  root().querySelector('.review-claude-btn').click();
  for (let i = 0; i < 100; i++) {
    if (S.writes.some((w) => w.data === '\r')) break;
    await sleep(50);
  }
  const mine = S.writes.filter((w) => w.id === pane.ptyId);
  const pastes = mine.filter((w) => w.data.includes('\x1b[200~'));
  const message = pastes[0] ? pastes[0].data.replace('\x1b[200~', '').replace('\x1b[201~', '') : '';
  const pasteAt = mine.findIndex((w) => w.data.includes('\x1b[200~'));
  const enterAfter = pasteAt >= 0 && mine.slice(pasteAt + 1).some((w) => w.data === '\r');
  const otherWrites = S.writes.filter((w) => w.id !== pane.ptyId).length;
  const activeIsOrigin = tm.getActiveTab() === S.originTab;
  const status = root().querySelector('.review-status').textContent;

  // Claude asks something (7501 blocked): refused, nothing written.
  const term = pane.terminalView.terminal;
  await new Promise((r) => term.write('\x1b]7501;state=blocked:kind=permission:app=claude-code\x07', r));
  await sleep(100);
  tm.switchToId(S.reviewTab.id);
  await sleep(200);
  S.writes.length = 0;
  root().querySelector('.review-claude-btn').click();
  await sleep(600);
  const note = root().querySelector('.review-note');
  const blocked = { note: note.textContent, visible: !note.hidden && note.offsetParent !== null, writes: S.writes.filter((w) => w.id === pane.ptyId).length };
  await new Promise((r) => term.write('\x1b]7501;state=idle:app=claude-code\x07', r));
  // The next document opens from the Claude pane, as a link in it would.
  tm.switchToId(S.originTab.id);
  await sleep(200);
  return { pasted: pastes.length, message, enterAfter, otherWrites, activeIsOrigin, status, blocked };
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
  const pdfjs = await window.__rt.loadPdfjs();
  const S = window.__S;
  const bytes = await window.__ipc.invoke('review:layout', S.view.deps.info.docId);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: bytes.pdf.slice(), worker: new pdfjs.PDFWorker({ name: 'packaged' }), isOffscreenCanvasSupported: false, disableWorkerRendering: true });
  try {
    const doc = await task.promise;
    const port = task._worker && task._worker.port;
    return { mode: port instanceof Worker ? 'worker' : 'main-thread', pages: doc.numPages };
  } catch (err) {
    return { mode: 'failed', error: String(err) };
  }
}
