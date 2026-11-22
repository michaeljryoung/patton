// Hidden-Electron check of copying Claude's original text through the REAL
// IPC handler (src/main/copy-original-ipc.ts) and the REAL clipboard: the
// handler's validation, ownership check and clipboard.write of a ClipboardItem
// with text/plain and text/html, read back with clipboard.readText() and
// clipboard.read(). Only the PTY manager and the session feed are stand-ins (a pty
// that owns a fake transcript file).
//
// The system clipboard is shared with everything on this Mac, so the check
// saves every kind it holds first (clipboard.read()) and puts them back after,
// unless something else replaced the check's own text meanwhile, and says
// whether the kinds after match the kinds before. Copied files can't be put
// back that way: the check then skips, saying so, rather than lose them.
//
// Run: PATTON_CLIPBOARD_CHECK=1 node scripts/check-copy-clipboard-electron.cjs
// Under Node it bundles the real sources with esbuild and starts Electron on
// itself; under Electron it opens a window that is never shown (show:false,
// dock hidden, its own userData folder, removed after) and exits.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HARD_TIMEOUT_MS = 30000;

// Opt-in: the Mac's clipboard is his, live, while checks run in a session
// beside him; a copy he makes in the check's half second could be overwritten
// on restore. Run it on purpose with PATTON_CLIPBOARD_CHECK=1 (S61).
if (!process.versions.electron && process.env.PATTON_CLIPBOARD_CHECK !== '1') {
  console.log('SKIP  touches the real system clipboard; run with PATTON_CLIPBOARD_CHECK=1');
  process.exit(0);
}

if (process.versions.electron) {
  electronMain();
} else {
  nodeRunner().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}

async function nodeRunner() {
  const { build } = require('esbuild');
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const repo = path.join(__dirname, '..');
  const srcRoot = process.env.CO_SRC_ROOT || repo;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patton-check-clip-'));
  const resultFile = path.join(outDir, 'result.json');

  await build({
    stdin: { resolveDir: srcRoot, loader: 'ts', contents: "export { registerCopyOriginalHandlers } from './src/main/copy-original-ipc';" },
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
    outfile: path.join(outDir, 'ipc.cjs'), logLevel: 'silent',
  });
  await build({
    entryPoints: [path.join(srcRoot, 'src/shared/constants.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(outDir, 'constants.cjs'), logLevel: 'silent',
  });
  const { IPC } = require(path.join(outDir, 'constants.cjs'));
  fs.writeFileSync(path.join(outDir, 'preload.cjs'),
    "const { contextBridge, ipcRenderer } = require('electron');\n" +
    `contextBridge.exposeInMainWorld('probe', {
      copy: (ptyId, text, mode) => ipcRenderer.invoke(${JSON.stringify(IPC.CLIPBOARD_COPY_SELECTION)}, ptyId, text, mode),
    });\n`);
  fs.writeFileSync(path.join(outDir, 'page.html'), '<!doctype html><html><body>probe</body></html>');

  const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if (!fs.existsSync(__filename) || !fs.existsSync(electronBin)) {
    console.error('missing script or Electron binary', { script: __filename, electronBin });
    process.exit(2);
  }
  const log = fs.openSync(path.join(outDir, 'electron.log'), 'w');
  const env = { ...process.env, CLIP_CHECK_DIR: outDir };
  delete env.ELECTRON_RUN_AS_NODE;
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
  fs.rmSync(outDir, { recursive: true, force: true });
  if (result.error) {
    console.error('check errored:', result.error);
    process.exit(2);
  }
  if (result.skipped) {
    console.log(`SKIP  the clipboard holds kinds this check can't put back (${result.skipped.join(', ')}); left untouched`);
    process.exit(0);
  }
  let failed = 0;
  for (const c of result.checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok ? '' : `  ${JSON.stringify(c.detail)}`}`);
  }
  console.log(`clipboard restored: ${result.restored}`);
  console.log(`\n${result.checks.length - failed} ok, ${failed} failed (Electron ${result.electron})`);
  process.exit(failed ? 1 : 0);
}

function electronMain() {
  const { app, BrowserWindow, clipboard, ClipboardItem } = require('electron');
  const outDir = process.env.CLIP_CHECK_DIR;
  const write = (obj) => fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(obj, null, 1));
  app.setPath('userData', path.join(outDir, 'ud'));
  if (app.dock) app.dock.hide();
  app.on('window-all-closed', () => { /* the check ends itself */ });

  // Electron 44's clipboard is the async W3C-style one: read() gives items by MIME type.
  const KNOWN = new Set(['text/plain', 'text/html', 'text/rtf', 'image/png']);
  const FILE_KINDS = ['public.file-url', 'NSFilenamesPboardType'];
  let saved = null;
  let savedTypes = '';
  let lastWritten = null;
  const readType = async (type) => {
    const items = await clipboard.read();
    for (const it of items) if (it.types.includes(type)) return (await it.getType(type)).text();
    return null;
  };
  const restore = async () => {
    if (!saved) return 'nothing saved';
    // Someone copied something else meanwhile: theirs stands.
    if (lastWritten !== null && (await clipboard.readText()) !== lastWritten) return 'no (the clipboard changed meanwhile; left as it is)';
    if (saved.length === 0) { clipboard.clear(); return 'yes (it was empty)'; }
    try {
      await clipboard.write(saved.map((entries) => new ClipboardItem(entries)));
    } catch {
      // A raw kind Electron won't write back: the standard kinds alone.
      await clipboard.write(saved.map((entries) => new ClipboardItem(Object.fromEntries(Object.entries(entries).filter(([t]) => KNOWN.has(t))))));
      return 'yes (standard kinds only)';
    }
    const now = (await clipboard.read()).flatMap((it) => it.types).sort().join();
    return now === savedTypes ? 'yes' : `partly (kinds before: ${savedTypes}; after: ${now})`;
  };

  setTimeout(async () => {
    let restored = 'no';
    try { restored = await restore(); } catch { /* reported below */ }
    try { write({ error: `timeout (clipboard restored: ${restored})` }); } catch { /* the parent reports "no result" */ }
    app.exit(1);
  }, HARD_TIMEOUT_MS);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  app.whenReady().then(async () => {
    try {
      const items = await clipboard.read();
      const types = items.flatMap((it) => it.types);
      // Copied files can't be put back through read() and write(): skip.
      const unknown = [];
      for (const f of FILE_KINDS) {
        if (await clipboard.has(`electron application/osclipboard;format="${f}"`)) unknown.push(f);
      }
      if (unknown.length) {
        write({ skipped: [...new Set(unknown)], electron: process.versions.electron });
        app.exit(0);
        return;
      }
      savedTypes = [...types].sort().join();
      saved = [];
      for (const it of items) {
        const entries = {};
        for (const t of it.types) entries[t] = await it.getType(t);
        saved.push(entries);
      }

      const transcript = path.join(outDir, 't.jsonl');
      const reply = 'Use **this** first:\n\n```bash\n# install deps\nnpm install\n```\n\nThen it runs.';
      fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: reply }] } })}\n`);
      const { registerCopyOriginalHandlers } = require(path.join(outDir, 'ipc.cjs'));
      const ptyManager = { validateOwnership: (id) => id === 7 };
      const feed = { transcriptFor: (id) => (id === 7 ? transcript : null) };
      registerCopyOriginalHandlers(ptyManager, feed);

      const warns = [];
      const infos = [];
      const origWarn = console.warn;
      const origInfo = console.info;
      console.warn = (...a) => { warns.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
      console.info = (...a) => { infos.push(JSON.stringify(a)); };

      const win = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(outDir, 'preload.cjs') },
      });
      await win.loadFile(path.join(outDir, 'page.html'));
      const copy = (ptyId, text, mode) => win.webContents.executeJavaScript(`window.probe.copy(${JSON.stringify(ptyId)}, ${JSON.stringify(text)}, ${JSON.stringify(mode)})`);

      // 1. Prose with bold: the original as plain text and HTML.
      {
        const r = await copy(7, '  Use this first:', 'copy');
        const text = await clipboard.readText();
        lastWritten = text;
        const html = await readType('text/html');
        check('prose: main answers original', r === 'original', r);
        check('prose: text/plain is Claude\'s text, no **', text === 'Use this first:', text);
        check('prose: text/html carries <strong>this</strong>', typeof html === 'string' && html.includes('<strong>this</strong>'), html);
      }
      // 2. Code: the # comment and both lines, verbatim; HTML a <pre> block.
      {
        const r = await copy(7, '  # install deps\n  npm install', 'copy');
        const text = await clipboard.readText();
        lastWritten = text;
        const html = await readType('text/html');
        check('code: main answers original', r === 'original', r);
        check('code: text/plain keeps the # comment line', text === '# install deps\nnpm install', text);
        check('code: text/html is <pre><code> with the #', typeof html === 'string' && html.includes('<pre><code># install deps\nnpm install</code></pre>'), html);
      }
      // 3. Not found: the drawn text, as plain text only.
      {
        const sel = '  words that are in no reply at all';
        const r = await copy(7, sel, 'copy');
        const text = await clipboard.readText();
        lastWritten = text;
        const html = await readType('text/html');
        check('not found: main writes the drawn text, no HTML', r === 'fallback' && text === sel && html === null, { r, text, html });
      }
      // 4. Over 1,000,000 characters (select-all): refused for the renderer to copy, no security line.
      {
        warns.length = 0;
        infos.length = 0;
        const r = await copy(7, 'x'.repeat(1_000_001), 'copy');
        check('over 1M characters: refused (the renderer copies the drawn text)', r === 'refused', r);
        check('over 1M characters: no [SECURITY] line', !warns.some((w) => w.includes('[SECURITY]')), warns);
        check('over 1M characters: logged [COPY] fallback "too long"', infos.some((l) => l.includes('[COPY] fallback') && l.includes('too long')), infos);
      }
      // 5. Another window's pty: refused, with the ownership warning.
      {
        warns.length = 0;
        const r = await copy(8, '  Use this first:', 'copy');
        check('a pty this window does not own: refused, [SECURITY] ownership line', r === 'refused' && warns.some((w) => w.includes('ownership')), { r, warns });
      }

      console.warn = origWarn;
      console.info = origInfo;
      win.destroy();
      const restored = await restore();
      write({ checks, restored, electron: process.versions.electron });
      app.exit(0);
    } catch (err) {
      let restored = 'no';
      try { restored = await restore(); } catch { /* reported */ }
      write({ error: `${String(err && err.stack || err)} (clipboard restored: ${restored})` });
      app.exit(1);
    }
  });
}
