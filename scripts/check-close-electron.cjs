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
//   3. a second window is not closed by the first one's request;
//   4. (v1.19) the in-app quit / close confirmations of src/main/close-confirm.ts
//      over the REAL channels, real webContents.send and a real preload playing
//      the renderer: confirm, cancel, silent renderer (ack timeout, dismiss
//      delivered), crashed renderer, destroyed window, a window answering for
//      another's request, a second ask for a busy window, and that a window that
//      is not showing cannot be asked (the default usability test).
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
        export { CloseConfirmations } from './src/main/close-confirm';
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
    `contextBridge.exposeInMainWorld('probe', {
      closeViaMain: () => ipcRenderer.invoke(${JSON.stringify(IPC.WINDOW_CLOSE)}),
      onRequest: (cb) => { ipcRenderer.on(${JSON.stringify(IPC.WINDOW_CONFIRM_REQUEST)}, (_e, p) => cb(p)); },
      onDismiss: (cb) => { ipcRenderer.on(${JSON.stringify(IPC.WINDOW_CONFIRM_DISMISS)}, (_e, p) => cb(p)); },
      ack: (id) => ipcRenderer.invoke(${JSON.stringify(IPC.WINDOW_CONFIRM_ACK)}, id),
      answer: (id, ok) => ipcRenderer.invoke(${JSON.stringify(IPC.WINDOW_CONFIRM_ANSWER)}, id, ok),
    });\n`);
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
      const { closeSenderWindow, CloseConfirmations } = require(path.join(outDir, 'close-main.cjs'));
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

      // 4. In-app confirmations (v1.19): the real controller, real IPC, a scripted renderer.
      {
        const confirmations = new CloseConfirmations({ ackTimeoutMs: 400, isUsable: (w) => !w.isDestroyed() });
        ipcMain.handle(IPC.WINDOW_CONFIRM_ACK, (event, id) => {
          const w = BrowserWindow.fromWebContents(event.sender);
          return w ? confirmations.ack(w.id, id) : false;
        });
        ipcMain.handle(IPC.WINDOW_CONFIRM_ANSWER, (event, id, ok) => {
          const w = BrowserWindow.fromWebContents(event.sender);
          return w ? confirmations.answer(w.id, id, ok === true) : false;
        });
        // The page plays the renderer: mode 'confirm' / 'cancel' / 'silent'.
        const asRenderer = (page, mode) => page.run(`
          window.__reqs = []; window.__dismissed = []; window.__mode = ${JSON.stringify(mode)};
          probe.onRequest(async (r) => {
            window.__reqs.push(r);
            if (window.__mode === 'silent') return;
            window.__ackReply = await probe.ack(r.requestId);
            window.__answerReply = await probe.answer(r.requestId, window.__mode === 'confirm');
          });
          probe.onDismiss((p) => window.__dismissed.push(p.requestId));
        `);
        const read = (page, expr) => page.win.webContents.executeJavaScript(expr);

        // 4a. confirm
        {
          const p = await open();
          await asRenderer(p, 'confirm');
          const t0 = Date.now();
          const result = await confirmations.ask(p.win, 'quit', 3);
          const reqs = await read(p, 'window.__reqs');
          check('confirm: the page got the request with kind and terminal count', reqs.length === 1 && reqs[0].kind === 'quit' && reqs[0].terminals === 3 && typeof reqs[0].requestId === 'string', reqs);
          check("confirm: the user's yes comes back as 'confirmed' (ack accepted too)", result === 'confirmed' && (await read(p, 'window.__ackReply')) === true, result);
          check('confirm: nothing left pending, and it did not wait out the timeout', !confirmations.hasPendingFor(p.win.id) && Date.now() - t0 < 350, Date.now() - t0);
          check('confirm: no dismiss sent (the renderer already answered)', (await read(p, 'window.__dismissed')).length === 0);
          p.win.destroy();
        }
        // 4b. cancel
        {
          const p = await open();
          await asRenderer(p, 'cancel');
          const result = await confirmations.ask(p.win, 'close-window', 2);
          check("cancel: Esc / Cancel comes back as 'cancelled'", result === 'cancelled', result);
          p.win.destroy();
        }
        // 4c. silent renderer: timeout, dismiss delivered, late ack refused
        {
          const p = await open();
          await asRenderer(p, 'silent');
          const t0 = Date.now();
          const result = await confirmations.ask(p.win, 'quit', 1);
          const waited = Date.now() - t0;
          check("silent renderer: 'unavailable' after the ack timeout (not before, not forever)", result === 'unavailable' && waited >= 350 && waited < 2000, { result, waited });
          await sleep(100);
          const reqs = await read(p, 'window.__reqs');
          const dismissed = await read(p, 'window.__dismissed');
          check('silent renderer: the dismiss reached the page', reqs.length === 1 && dismissed[0] === reqs[0].requestId, { reqs, dismissed });
          check('silent renderer: a late ack and a late answer are refused',
            (await read(p, `probe.ack(${JSON.stringify(reqs[0].requestId)})`)) === false && (await read(p, `probe.answer(${JSON.stringify(reqs[0].requestId)}, true)`)) === false);
          p.win.destroy();
        }
        // 4d. a renderer that acks but never answers is NOT timed out (the user is deciding)
        {
          const p = await open();
          await p.run(`window.__reqs=[]; probe.onRequest((r) => { window.__reqs.push(r); probe.ack(r.requestId); });`);
          let settled = null;
          confirmations.ask(p.win, 'quit', 2).then((r) => { settled = r; });
          await sleep(900);
          check('acked dialog waits for the user past the ack timeout', settled === null && confirmations.hasPendingFor(p.win.id), settled);
          check('a second ask for the same window is busy: no second dialog', (await confirmations.ask(p.win, 'quit', 2)) === 'busy' && (await read(p, 'window.__reqs')).length === 1);
          check('quitShortcut after the ack confirms it', confirmations.quitShortcut() === 'confirmed');
          await sleep(60);
          check('quitShortcut: settled confirmed and the dismiss reached the page', settled === 'confirmed', settled);
          p.win.destroy();
        }
        // 4e. crashed renderer
        {
          const p = await open();
          await asRenderer(p, 'silent');
          const pending = confirmations.ask(p.win, 'quit', 2);
          await sleep(100);
          p.win.webContents.forcefullyCrashRenderer();
          const result = await Promise.race([pending, sleep(3000).then(() => 'hung')]);
          check("renderer crashes with the dialog up: 'unavailable' at once, not after the timeout", result === 'unavailable', result);
          p.win.destroy();
        }
        // 4f. window destroyed while asked
        {
          const p = await open();
          await asRenderer(p, 'silent');
          const pending = confirmations.ask(p.win, 'close-window', 2);
          await sleep(50);
          p.win.destroy();
          const result = await Promise.race([pending, sleep(3000).then(() => 'hung')]);
          check("window destroyed with the dialog up: 'unavailable'", result === 'unavailable', result);
        }
        // 4g. another window cannot answer for this one's request
        {
          const p = await open();
          const q = await open();
          await p.run(`window.__reqs=[]; probe.onRequest((r) => { window.__reqs.push(r); probe.ack(r.requestId); });`);
          let settled = null;
          confirmations.ask(p.win, 'quit', 2).then((r) => { settled = r; });
          await sleep(150);
          const id = (await read(p, 'window.__reqs'))[0].requestId;
          check("another window's answer is refused and does not settle it", (await read(q, `probe.answer(${JSON.stringify(id)}, true)`)) === false && settled === null);
          check("another window's ack is refused", (await read(q, `probe.ack(${JSON.stringify(id)})`)) === false);
          check('the right window answers it', (await read(p, `probe.answer(${JSON.stringify(id)}, true)`)) === true);
          await sleep(30);
          check('and then it is confirmed', settled === 'confirmed', settled);
          p.win.destroy();
          q.win.destroy();
        }
        // 4h. the default usability test: a window that is not showing cannot be asked
        {
          const real = new CloseConfirmations({ ackTimeoutMs: 400 });
          const p = await open();
          check('default: a hidden window cannot show the dialog (native fallback)', real.canAsk(p.win) === false && (await real.ask(p.win, 'quit', 1)) === 'unavailable');
          p.win.destroy();
          check('default: a destroyed window cannot', real.canAsk(p.win) === false);
        }
      }

      write({ electron: process.versions.electron, checks });
      app.exit(0);
    } catch (err) {
      write({ error: String(err && err.stack || err) });
      app.exit(1);
    }
  });
}
