// Hidden-Electron check of how a window closes from its renderer (S46).
// On Electron 44.9.3 the page's own window.close() destroys the window
// WITHOUT emitting BrowserWindow's 'close' event, so main's close guard
// (native box, pre-confirmation, saveState, PTY teardown) never runs. Patton's
// renderer therefore asks main to close it (IPC.WINDOW_CLOSE →
// closeSenderWindow in src/main/close-window.ts → BrowserWindow.close()).
// This check pins both halves on the Electron in node_modules:
//   1. the trap: DOM window.close() emits 'closed' but no 'close';
//   2. the fix: the REAL closeSenderWindow, called from an ipcMain.handle on
//      the REAL channel name, emits 'close' before 'closed', the reply returns
//      before the window is gone, and a 'close' listener that calls
//      preventDefault() keeps the window (the guard's Cancel);
//   3. a second window is not closed by the first one's request.
// Run: node scripts/check-close-electron.cjs
// Under Node it bundles the real sources with esbuild and starts Electron on
// itself; under Electron it opens windows that are never shown (show:false,
// dock hidden, its own userData folder, removed after) and exits.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HARD_TIMEOUT_MS = 30000;

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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patton-check-close-'));
  const resultFile = path.join(outDir, 'result.json');

  await build({
    stdin: {
      resolveDir: repo,
      loader: 'ts',
      contents: `
        export { closeSenderWindow } from './src/main/close-window';
      `,
    },
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
    outfile: path.join(outDir, 'close-main.cjs'), logLevel: 'silent',
  });
  await build({
    entryPoints: [path.join(repo, 'src/shared/constants.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(outDir, 'constants.cjs'), logLevel: 'silent',
  });
  // A sandboxed preload can only require electron: the real channel name is
  // read from the real constants and written into it.
  const { IPC } = require(path.join(outDir, 'constants.cjs'));
  fs.writeFileSync(path.join(outDir, 'preload.cjs'),
    "const { contextBridge, ipcRenderer } = require('electron');\n" +
    `contextBridge.exposeInMainWorld('probe', { closeViaMain: () => ipcRenderer.invoke(${JSON.stringify(IPC.WINDOW_CLOSE)}) });\n`);
  fs.writeFileSync(path.join(outDir, 'page.html'), '<!doctype html><html><body>probe</body></html>');

  const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  // Electron given a missing script opens its default window: refuse instead.
  if (!fs.existsSync(__filename) || !fs.existsSync(electronBin)) {
    console.error('missing script or Electron binary', { script: __filename, electronBin });
    process.exit(2);
  }
  const log = fs.openSync(path.join(outDir, 'electron.log'), 'w');
  const env = { ...process.env, CLOSE_CHECK_DIR: outDir };
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
  let failed = 0;
  for (const c of result.checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  ${JSON.stringify(c.detail)}`}`);
  }
  console.log(`\n${result.checks.length - failed} passed, ${failed} failed (Electron ${result.electron})`);
  process.exit(failed ? 1 : 0);
}

function electronMain() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const outDir = process.env.CLOSE_CHECK_DIR;
  const write = (obj) => fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(obj, null, 1));
  app.setPath('userData', path.join(outDir, 'ud'));
  if (app.dock) app.dock.hide();
  // Without a listener the default quits when the last window closes.
  app.on('window-all-closed', () => { /* the check ends itself */ });
  setTimeout(() => {
    try { write({ error: 'timeout' }); } catch { /* the parent reports "no result" */ }
    app.exit(1);
  }, HARD_TIMEOUT_MS);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  app.whenReady().then(async () => {
    try {
      const { closeSenderWindow } = require(path.join(outDir, 'close-main.cjs'));
      const { IPC } = require(path.join(outDir, 'constants.cjs'));
      const replies = [];
      ipcMain.handle(IPC.WINDOW_CLOSE, (event) => {
        const id = closeSenderWindow(event.sender);
        replies.push({ id, windowStillOpen: !BrowserWindow.fromWebContents(event.sender)?.isDestroyed() });
        return id !== null;
      });

      const open = async () => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(outDir, 'preload.cjs') },
        });
        const events = [];
        win.on('close', () => events.push('close'));
        win.on('closed', () => events.push('closed'));
        await win.loadFile(path.join(outDir, 'page.html'));
        const run = (code) => (win.isDestroyed() ? Promise.resolve() : win.webContents.executeJavaScript(code)).catch((err) => {
          checks.push({ name: `page script failed: ${code}`, ok: false, detail: String(err) });
        });
        return { win, events, run };
      };
      const untilClosed = async (events) => {
        for (let i = 0; i < 50 && !events.includes('closed'); i++) await sleep(50);
      };

      // 1. The trap: the page's own window.close()
      {
        const a = await open();
        a.run('setTimeout(() => window.close(), 20)');
        await untilClosed(a.events);
        await sleep(100);
        check("trap: DOM window.close() emits 'closed' but never 'close'", a.events.join() === 'closed', a.events);
      }

      // 2. The fix: the IPC through the real closeSenderWindow
      {
        replies.length = 0;
        const b = await open();
        b.run('window.probe.closeViaMain()');
        await untilClosed(b.events);
        check("fix: close via main emits 'close' before 'closed'", b.events.join() === 'close,closed', b.events);
        check('fix: the reply came back while the window was still open', replies.length === 1 && replies[0].id !== null && replies[0].windowStillOpen === true, replies);
      }

      // 2b. A 'close' listener that prevents it (the guard's Cancel) keeps the window
      {
        const c = await open();
        let prevent = true;
        c.win.on('close', (e) => { if (prevent) e.preventDefault(); });
        c.run('window.probe.closeViaMain()');
        await sleep(300);
        check("fix: preventDefault() in 'close' keeps the window", !c.win.isDestroyed() && c.events.join() === 'close', c.events);
        prevent = false;
        c.run('window.probe.closeViaMain()');
        await untilClosed(c.events);
        check('fix: asking again then closes it', c.events.join() === 'close,close,closed', c.events);
      }

      // 3. Only the sender's own window
      {
        const d = await open();
        const e = await open();
        d.run('window.probe.closeViaMain()');
        await untilClosed(d.events);
        await sleep(150);
        check("fix: another window's request leaves this one open", !e.win.isDestroyed() && e.events.length === 0, e.events);
        e.win.destroy();
      }

      write({ electron: process.versions.electron, checks });
      app.exit(0);
    } catch (err) {
      write({ error: String(err && err.stack || err) });
      app.exit(1);
    }
  });
}
