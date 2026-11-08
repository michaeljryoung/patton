// Headless check of main's window close guard and the last-tab pre-confirm
// (S45): ⌘W on the last tab asks in the app, the renderer records that through
// WINDOW_PRECONFIRM_CLOSE, asks main to close its window through WINDOW_CLOSE
// (BrowserWindow.close(): the only renderer path that emits the 'close' event;
// the page's own window.close() destroys the window without it, measured on
// Electron 44.9.3 by scripts/check-close-electron.cjs), and the guard then skips its native box ONCE for
// that window only, and only while the record is fresh. Everything else (the
// red button, Window → Close, an expired or another window's record) still
// meets the native "N terminals still running" box.
// Bundles the REAL createWindow (window-manager.ts) and registerIpcHandlers
// (ipc-handlers.ts) with esbuild, with Electron, the store and the PTY manager
// replaced by recording stubs, so the guard and the IPC share the real
// close-preconfirm singleton exactly as in the app.
// Run: node scripts/check-close-guard.mjs   (no extra dependencies)
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

// ── Stubs ──
// Anything the code touches that a test doesn't care about is a deep no-op.
const deep = () => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : deep()),
  apply: () => deep(),
});
const windows = [];
const dialogCalls = [];
let dialogAnswer = 0; // 0 = Cancel, 1 = Close Anyway
const handlers = new Map();
let nextId = 1;

class FakeWindow {
  constructor() {
    this.id = nextId++;
    this.listeners = new Map();
    this.destroyed = false;
    this.webContents = { owner: this, session: { webRequest: { onHeadersReceived() {} } }, on() {}, setWindowOpenHandler() {} };
    windows.push(this);
  }
  on(ev, fn) { (this.listeners.get(ev) ?? this.listeners.set(ev, []).get(ev)).push(fn); return this; }
  once(ev, fn) { return this.on(ev, fn); }
  emit(ev, ...args) { for (const fn of this.listeners.get(ev) ?? []) fn(...args); }
  /** BrowserWindow.close(): run the 'close' listeners; unless one
   *  prevented it, the window goes ('closed'). Returns true when it closed. */
  requestClose() {
    let prevented = false;
    this.emit('close', { preventDefault: () => { prevented = true; } });
    if (prevented) return false;
    this.destroyed = true;
    windows.splice(windows.indexOf(this), 1);
    this.emit('closed');
    return true;
  }
  /** The page's own window.close() (Electron 44.9.3): the window is destroyed
   *  and 'closed' fires, but NO 'close' event, so no 'close' listener runs. */
  pageClose() {
    this.destroyed = true;
    windows.splice(windows.indexOf(this), 1);
    this.emit('closed');
  }
  close() { this.requestClose(); }
  /** BrowserWindow.destroy(): like the page's close, no 'close' event. */
  destroy() { this.pageClose(); }
  get id() { if (this.destroyed && this.strict) throw new Error('Object has been destroyed'); return this._id; }
  set id(v) { this._id = v; }
  isDestroyed() { return this.destroyed; }
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
  isMaximized() { return false; }
  maximize() {}
  center() {}
  show() {}
  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  static getAllWindows() { return [...windows]; }
  static fromWebContents(wc) { return wc?.owner ?? null; }
}

const tmpDirs = []; // the app.getPath stub's directories, removed at the end
const electron = new Proxy({
  BrowserWindow: FakeWindow,
  dialog: { showMessageBoxSync: (_win, opts) => { dialogCalls.push(opts); return dialogAnswer; } },
  nativeTheme: { shouldUseDarkColors: false },
  screen: deep(),
  ipcMain: {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
  },
  app: { isPackaged: false, getPath: () => { const d = mkdtempSync(join(tmpdir(), 'close-guard-')); tmpDirs.push(d); return d; } },
}, { get: (t, k) => (k in t ? t[k] : deep()) });

const store = { getSettings: () => ({}), getWindowState: () => ({ width: 800, height: 600 }), setWindowState() {}, setSession() {} };
const live = new Map(); // window → live PTY count
const ptyManager = {
  liveCountForWindow: (w) => live.get(w) ?? 0,
  destroyByWindow: (w) => { ptyManager.destroyed.push(w.id); live.delete(w); },
  // By id, as the real one: the window is destroyed in the 'closed' handler.
  destroyByWindowId: (id) => {
    const w = [...live.keys()].find((x) => x._id === id);
    if (!w) return 0;
    const n = live.get(w);
    ptyManager.destroyed.push(id);
    live.delete(w);
    return n;
  },
  destroyed: [],
  get size() { let n = 0; for (const v of live.values()) n += v; return n; },
};

globalThis.__closeGuardStubs = { electron, store };

const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onResolve({ filter: /^\.\/store$/ }, () => ({ path: 'store', namespace: 'stub' }));
    b.onResolve({ filter: /^\.\/pty-manager$/ }, () => ({ path: 'pty-manager', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'pty-manager'
        ? 'module.exports = { isAllowedCwdPath: () => false };'
        : `module.exports = globalThis.__closeGuardStubs.${args.path};`,
      loader: 'js',
    }));
  },
};

const bundle = await build({
  stdin: {
    contents: `
      export { createWindow } from './src/main/window-manager';
      export { registerIpcHandlers } from './src/main/ipc-handlers';
      export { closePreconfirmations, CLOSE_PRECONFIRM_TTL_MS } from './src/main/close-preconfirm';
      export { IPC } from './src/shared/constants';
    `,
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  packages: 'external',
  plugins: [stubPlugin],
  define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined', MAIN_WINDOW_VITE_NAME: '"main_window"' },
  write: false,
  logLevel: 'silent',
});
const mod = { exports: {} };
new Function('module', 'exports', '__dirname', 'require', bundle.outputFiles[0].text)(mod, mod.exports, join(repo, '.vite', 'build'), (await import('node:module')).createRequire(join(repo, 'noop.js')));
const { createWindow, registerIpcHandlers, closePreconfirmations, CLOSE_PRECONFIRM_TTL_MS, IPC } = mod.exports;

// Main-process console lines (the guard logs through console.info).
const logs = [];
const realInfo = console.info;
console.info = (...a) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
// The pre-confirm TTL reads the monotonic clock (performance.now), not Date.now.
const realNow = performance.now.bind(performance);
// Whole milliseconds: a fractional start makes (start + TTL) - start round to a
// hair over TTL about one run in six, failing the exact-boundary check.
let clock = Math.floor(realNow());
performance.now = () => clock;

const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
registerIpcHandlers(ptyManager);
// The IPC rate limiter reads Date.now: a stepped clock keeps sections apart.
const realDateNow = Date.now;
let wall = realDateNow();
Date.now = () => wall;
const closeIpc = (win) => handlers.get(IPC.WINDOW_CLOSE)({ sender: win.webContents });
const later = () => new Promise((r) => setImmediate(r));
const info = (win) => handlers.get(IPC.WINDOW_CLOSE_INFO)({ sender: win.webContents });
const preconfirm = (win) => handlers.get(IPC.WINDOW_PRECONFIRM_CLOSE)({ sender: win.webContents });
const reset = () => { wall += 1100; dialogCalls.length = 0; logs.length = 0; warns.length = 0; ptyManager.destroyed.length = 0; dialogAnswer = 0; };

// ── 1. The IPC answers for the sender's own window ──
{
  const a = createWindow(ptyManager);
  live.set(a, 3);
  check('close info: only window, its live shells', JSON.stringify(info(a)) === JSON.stringify({ isLastWindow: true, liveShells: 3 }), info(a));
  const b = createWindow(ptyManager);
  live.set(b, 1);
  check('close info: two windows → not the last', info(a).isLastWindow === false && info(b).liveShells === 1, [info(a), info(b)]);
  dialogAnswer = 1; // clean up: Close Anyway
  for (const w of [...windows]) w.requestClose();
  reset();
}

// ── 2. Ordinary close with live shells still shows the native box ──
{
  const w = createWindow(ptyManager);
  live.set(w, 2);
  dialogAnswer = 0;
  const closed = w.requestClose();
  check('red button: native box shown', dialogCalls.length === 1, dialogCalls.length);
  check('red button: Cancel keeps the window and its shells', !closed && ptyManager.destroyed.length === 0);
  check('red button: box says it quits Patton', /quit Patton/.test(dialogCalls[0]?.detail ?? ''), dialogCalls[0]?.detail);
  dialogAnswer = 1;
  check('red button: Close Anyway closes and ends the shells', w.requestClose() && ptyManager.destroyed.includes(w.id));
  reset();
}

// ── 3. A fresh pre-confirm skips the native box once ──
{
  const w = createWindow(ptyManager);
  live.set(w, 2);
  check('pre-confirm IPC accepted', preconfirm(w) === true);
  check('pre-confirm logged in main', logs.some((l) => l.includes('[CLOSE] window close confirmed in the app')), logs);
  clock += 50; // the renderer's close request a moment later
  const closed = w.requestClose();
  check('pre-confirmed close: no native box', dialogCalls.length === 0, dialogCalls.length);
  check('pre-confirmed close: window closes', closed);
  check('pre-confirmed close: shells still ended by the guard', ptyManager.destroyed.includes(w.id));
  check('[CLOSE] window close pre-confirmed logged', logs.some((l) => l.includes('[CLOSE] window close pre-confirmed')), logs);
  check('last window gone: no PTYs left, so before-quit has nothing to ask', ptyManager.size === 0);
  reset();
}

// ── 4. One-shot: a cancelled-then-later close asks again ──
{
  const w = createWindow(ptyManager);
  live.set(w, 1);
  preconfirm(w);
  // A close event takes the record (the guard ends the shells it had); if
  // the window then lives on with shells again, its next close asks.
  w.emit('close', { preventDefault() {} });
  live.set(w, 1);
  dialogCalls.length = 0;
  dialogAnswer = 0;
  w.requestClose();
  check('pre-confirm is one-shot: next close asks natively', dialogCalls.length === 1, dialogCalls.length);
  dialogAnswer = 1;
  w.requestClose();
  reset();
}

// ── 5. An expired pre-confirm counts for nothing ──
{
  const w = createWindow(ptyManager);
  live.set(w, 1);
  preconfirm(w);
  clock += CLOSE_PRECONFIRM_TTL_MS + 1;
  dialogAnswer = 0;
  const closed = w.requestClose();
  check('expired pre-confirm: native box shown', dialogCalls.length === 1, dialogCalls.length);
  check('expired pre-confirm: Cancel still keeps the window', !closed);
  check('[CLOSE] expired logged', logs.some((l) => l.includes('[CLOSE] window close pre-confirmation expired')), logs);
  dialogAnswer = 1;
  w.requestClose();
  reset();
}

// ── 6. Another window's pre-confirm doesn't skip this window's box ──
// The SECOND window pre-confirms, so a handler that marked the first window
// (not the sender's) or a record not keyed by window both fail here.
{
  const a = createWindow(ptyManager);
  const b = createWindow(ptyManager);
  live.set(a, 1);
  live.set(b, 1);
  preconfirm(b);
  dialogAnswer = 0;
  const closedA = a.requestClose();
  check('other window pre-confirmed: this window still asks', dialogCalls.length === 1 && !closedA, dialogCalls.length);
  check('other window: box says only this window closes', /other windows stay open/.test(dialogCalls[0]?.detail ?? ''), dialogCalls[0]?.detail);
  dialogCalls.length = 0;
  const closedB = b.requestClose();
  check('the pre-confirmed (sender) window itself skips its box', closedB && dialogCalls.length === 0, dialogCalls.length);
  dialogAnswer = 1;
  a.requestClose();
  reset();
}

// ── 7. A window with no live shells closes without asking (unchanged) ──
{
  const w = createWindow(ptyManager);
  const closed = w.requestClose();
  check('no live shells: closes with no box', closed && dialogCalls.length === 0);
  reset();
}

// ── 8. Pure record: TTL boundary and forget ──
{
  closePreconfirmations.mark(999);
  clock += CLOSE_PRECONFIRM_TTL_MS;
  check('record at exactly the TTL still counts', closePreconfirmations.take(999) === 'confirmed');
  check('taken record is gone', closePreconfirmations.take(999) === 'none');
  closePreconfirmations.mark(998);
  closePreconfirmations.forget(998);
  check('forget drops a record', closePreconfirmations.take(998) === 'none');
}

// ── 9. WINDOW_CLOSE: the renderer's close goes through BrowserWindow.close() ──
// Last window, confirmed in the app: the guard's close handler really runs
// (it takes the record), no native box, the shells are ended there, and so
// before-quit finds none alive (it asks only while ptyManager.size > 0).
{
  const w = createWindow(ptyManager);
  live.set(w, 3);
  preconfirm(w);
  clock += 50;
  const reply = closeIpc(w);
  check('close IPC accepted at once (reply does not wait for the close)', reply === true && windows.includes(w), reply);
  await later();
  check('close IPC: window closed', w.isDestroyed() && !windows.includes(w));
  check('close IPC: the close handler ran and took the pre-confirmation', logs.some((l) => l.includes('[CLOSE] window close pre-confirmed')), logs);
  check('close IPC: no native box', dialogCalls.length === 0, dialogCalls.length);
  check('close IPC: shells ended by the close handler, not the safety net', ptyManager.destroyed.length === 1 && warns.length === 0, { destroyed: ptyManager.destroyed, warns });
  check('close IPC: before-quit would find no PTYs and not ask', ptyManager.size === 0, ptyManager.size);
  check('close IPC logged', logs.some((l) => l.includes('[CLOSE] window close requested by its renderer')), logs);
  reset();
}

// Not confirmed in the app: the native box asks; Cancel keeps window and shells.
{
  const w = createWindow(ptyManager);
  live.set(w, 2);
  closeIpc(w);
  await later();
  check('close IPC, not confirmed: native box asks', dialogCalls.length === 1 && !w.isDestroyed(), dialogCalls.length);
  check('close IPC, not confirmed: Cancel keeps the shells', ptyManager.destroyed.length === 0 && ptyManager.size === 2);
  dialogAnswer = 1;
  closeIpc(w);
  await later();
  check('close IPC, Close Anyway: window closes and shells end', w.isDestroyed() && ptyManager.size === 0);
  reset();
}

// A non-last window closed this way ends ITS shells and leaves the other's.
{
  const a = createWindow(ptyManager);
  const b = createWindow(ptyManager);
  live.set(a, 2);
  live.set(b, 4);
  preconfirm(b);
  closeIpc(b);
  await later();
  check('non-last window: closed, its shells ended', b.isDestroyed() && !live.has(b) && ptyManager.destroyed.includes(b.id));
  check('non-last window: the other window and its shells untouched', !a.isDestroyed() && live.get(a) === 2);
  // the sender's own window only: a's renderer cannot close b (already gone) and closes a
  closeIpc(b);
  await later();
  check('close IPC from a destroyed window is refused', closeIpc(b) === false);
  dialogAnswer = 1;
  closeIpc(a);
  await later();
  reset();
}

// ── 10. The page's own window.close() skips the handler: the safety net ──
{
  const a = createWindow(ptyManager);
  const b = createWindow(ptyManager);
  live.set(a, 2);
  live.set(b, 1);
  a.strict = true; // reading a destroyed window throws, as in Electron
  preconfirm(a);
  a.pageClose();
  check('page window.close(): no close handler ran (no native box, no pre-confirm taken)',
    dialogCalls.length === 0 && !logs.some((l) => l.includes('window close pre-confirmed')), { dialogCalls: dialogCalls.length, logs });
  check('page window.close(): safety net ended that window\'s shells', ptyManager.destroyed.length === 1 && !live.has(a), ptyManager.destroyed);
  check('page window.close(): safety net logged how many it found', warns.some((l) => l.includes('closed without its close guard') && l.includes('"leftover":2')), warns);
  check('page window.close(): the other window\'s shells untouched', live.get(b) === 1);
  check('page window.close(): its stale pre-confirmation was forgotten', closePreconfirmations.take(a._id) === 'none');
  dialogAnswer = 1;
  b.requestClose();
  reset();
}

// WINDOW_CLOSE shares the close-guard rate limit (10/s) and refuses past it.
{
  const w = createWindow(ptyManager);
  const replies = Array.from({ length: 11 }, () => closeIpc(w));
  check('close IPC rate-limited like the other close-guard channels', replies.slice(0, 10).every((r) => r === true) && replies[10] === false, replies);
  check('close IPC rate limit logged', warns.some((l) => l.includes('Rate limit exceeded') && l.includes('window:close')), warns);
  await later();
  reset();
}

// The normal close path leaves the safety net nothing to warn about.
{
  const w = createWindow(ptyManager);
  live.set(w, 1);
  dialogAnswer = 1;
  w.requestClose();
  check('guarded close: safety net finds nothing', warns.length === 0, warns);
  reset();
}

console.info = realInfo;
console.warn = realWarn;
Date.now = realDateNow;
performance.now = realNow;
for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
