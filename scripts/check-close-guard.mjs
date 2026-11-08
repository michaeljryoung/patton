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
// v1.19 (S46): ⌘Q / Dock Quit and the red close button ask IN THE APP too
// (quit-guard.ts, close-confirm.ts, and the close handler): main sends
// WINDOW_CONFIRM_REQUEST to the window's renderer, which acks and answers over
// IPC. Sections 11+ play the renderer through the real IPC handlers; the older
// sections use windows that are not visible, which cannot show a dialog, so
// they still meet the native box (the fallback path).
// Run: node scripts/check-close-guard.mjs   (no extra dependencies)
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

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

/** Minimal EventEmitter (on / once / removeListener / emit). */
class Emitter {
  constructor() { this.listeners = new Map(); }
  on(ev, fn) { (this.listeners.get(ev) ?? this.listeners.set(ev, []).get(ev)).push(fn); return this; }
  once(ev, fn) { const w = (...a) => { this.removeListener(ev, w); fn(...a); }; w.orig = fn; return this.on(ev, w); }
  removeListener(ev, fn) { this.listeners.set(ev, (this.listeners.get(ev) ?? []).filter((l) => l !== fn && l.orig !== fn)); return this; }
  emit(ev, ...args) { for (const fn of [...(this.listeners.get(ev) ?? [])]) fn(...args); }
}
let focusedWindow = null;
class FakeWindow extends Emitter {
  constructor() {
    super();
    this.id = nextId++;
    this.destroyed = false;
    // A window that is not showing cannot show the in-app dialog: the older
    // sections rely on that to keep meeting the native box. Sections 11+ show it.
    this.visible = false;
    this.minimized = false;
    this.sent = []; // what main sent this window's renderer: { ch, payload }
    const wc = new Emitter();
    Object.assign(wc, {
      owner: this,
      session: { webRequest: { onHeadersReceived() {} } },
      setWindowOpenHandler() {},
      isDestroyed: () => this.destroyed,
      send: (ch, payload) => { if (this.destroyed) throw new Error('Object has been destroyed'); this.sent.push({ ch, payload }); },
    });
    this.webContents = wc;
    windows.push(this);
  }
  isVisible() { return this.visible && !this.destroyed; }
  isMinimized() { return this.minimized; }
  reload() { this.reloaded = (this.reloaded ?? 0) + 1; }
  static getFocusedWindow() { return focusedWindow && !focusedWindow.destroyed ? focusedWindow : null; }
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

let appQuitCalls = 0;
const tmpDirs = []; // the app.getPath stub's directories, removed at the end
const electron = new Proxy({
  BrowserWindow: FakeWindow,
  // Main passes no window when none is left; the options are then the first argument.
  dialog: { showMessageBoxSync: (a, b) => { dialogCalls.push(b ?? a); return dialogAnswer; } },
  nativeTheme: { shouldUseDarkColors: false },
  screen: deep(),
  ipcMain: {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
  },
  app: { quit: () => { appQuitCalls++; beforeQuit(); }, isPackaged: false, getPath: () => { const d = mkdtempSync(join(tmpdir(), 'close-guard-')); tmpDirs.push(d); return d; } },
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
  destroyAll: () => { for (const [w, n] of live) { ptyManager.destroyed.push(w.id); void n; } live.clear(); },
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
      export { guardBeforeQuit, isQuitConfirmed } from './src/main/quit-guard';
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
// A fresh copy of the bundle: quit-guard's "quit confirmed" flag is module state
// that a real quit never resets, so every section that confirms a quit gets its own.
const bundleText = bundle.outputFiles[0].text;
const instantiate = () => {
  const m = { exports: {} };
  new Function('module', 'exports', '__dirname', 'require', bundleText)(m, m.exports, join(repo, '.vite', 'build'), (createRequire)(join(repo, 'noop.js')));
  return m.exports;
};
let { createWindow, registerIpcHandlers, closePreconfirmations, CLOSE_PRECONFIRM_TTL_MS, IPC, guardBeforeQuit, isQuitConfirmed } = instantiate();

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


// ── v1.19 helpers: main's quit/close guard with the renderer played by the test ──
let quitCompleted = 0;
/** What main.ts's 'before-quit' does: ask the guard; if it lets the quit go on,
 *  end every shell and close every window (their close handlers run). */
function beforeQuit() {
  let prevented = false;
  const proceed = guardBeforeQuit({ preventDefault: () => { prevented = true; } }, ptyManager);
  if (proceed && !prevented) {
    quitCompleted++;
    ptyManager.destroyAll();
    for (const w of [...windows]) w.requestClose();
    return 'quit';
  }
  return 'prevented';
}
/** ⌘Q, Dock Quit or the app menu: all of them are app.quit() → before-quit. */
const cmdQ = () => beforeQuit();
/** A fresh copy of the guard modules, no windows, no shells (see instantiate). */
async function fresh() {
  for (const w of [...windows]) w.pageClose();
  live.clear();
  focusedWindow = null;
  await later(); // dialogs left open by the last section settle (native fallback) before the next starts
  ({ createWindow, registerIpcHandlers, closePreconfirmations, CLOSE_PRECONFIRM_TTL_MS, IPC, guardBeforeQuit, isQuitConfirmed } = instantiate());
  registerIpcHandlers(ptyManager);
  quitCompleted = 0;
  appQuitCalls = 0;
  reset();
}
const showing = (n, shells) => {
  const w = createWindow(ptyManager);
  w.visible = true;
  live.set(w, shells);
  return w;
};
const requests = (w) => w.sent.filter((m) => m.ch === IPC.WINDOW_CONFIRM_REQUEST).map((m) => m.payload);
const dismissals = (w) => w.sent.filter((m) => m.ch === IPC.WINDOW_CONFIRM_DISMISS).map((m) => m.payload.requestId);
const lastRequest = (w) => requests(w).at(-1);
const ack = (w, id) => handlers.get(IPC.WINDOW_CONFIRM_ACK)({ sender: w.webContents }, id);
const answer = (w, id, ok) => handlers.get(IPC.WINDOW_CONFIRM_ANSWER)({ sender: w.webContents }, id, ok);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logged = (t) => logs.some((l) => l.includes(t));

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


// ═══ v1.19: ⌘Q and the red button ask in the app ═══

// ── 11. ⌘Q → in-app dialog → confirm: no native box, quits once ──
await fresh();
{
  const a = showing(0, 3);
  const b = showing(0, 2);
  focusedWindow = b;
  check('⌘Q with shells: quit is held back', cmdQ() === 'prevented' && quitCompleted === 0);
  check('⌘Q: no native box', dialogCalls.length === 0, dialogCalls.length);
  check('⌘Q: asked once, in the focused window only', requests(b).length === 1 && requests(a).length === 0, [requests(a), requests(b)]);
  const req = lastRequest(b);
  check('⌘Q: kind quit and the total number of terminals (5), not the window\'s', req.kind === 'quit' && req.terminals === 5, req);
  check('⌘Q: asking is logged', logged('[CLOSE] quit: asking in the app') && logged('in-app confirmation requested'), logs);
  check('⌘Q: nothing confirmed before the user answers', quitCompleted === 0 && appQuitCalls === 0 && ptyManager.size === 5);
  check('ack from the asked window accepted', ack(b, req.requestId) === true);
  check('ack for an unknown request refused', ack(b, 'nope') === false);
  check('another window cannot answer for it', answer(a, req.requestId, true) === false && quitCompleted === 0);
  check('answer: confirmed', answer(b, req.requestId, true) === true);
  await later();
  check('confirm: app.quit() called once, quit completed once', appQuitCalls === 1 && quitCompleted === 1, { appQuitCalls, quitCompleted });
  check('confirm: every window closed and all shells ended, with no native box anywhere',
    windows.length === 0 && ptyManager.size === 0 && dialogCalls.length === 0, { windows: windows.length, shells: ptyManager.size, dialogs: dialogCalls.length });
  check('confirm: no window asked again during the quit', requests(a).length === 0 && requests(b).length === 1);
  check('confirm: quit-confirmed state set and logged', isQuitConfirmed() === true && logged('[CLOSE] quit confirmed'), logs);
}

// ── 12. ⌘Q twice: the second confirms; before the ack it is ignored ──
await fresh();
{
  const a = showing(0, 2);
  focusedWindow = a;
  cmdQ();
  const req = lastRequest(a);
  check('⌘Q again before the dialog is shown: ignored, no second request, no quit',
    cmdQ() === 'prevented' && requests(a).length === 1 && quitCompleted === 0 && dialogCalls.length === 0, requests(a));
  check('ignored second ⌘Q logged', logged('dialog not shown yet, ignored'), logs);
  ack(a, req.requestId);
  check('⌘Q again with the dialog up: held back here (the confirm lands a tick later)', cmdQ() === 'prevented');
  await later();
  check('second ⌘Q confirms: quit completed once, no native box', quitCompleted === 1 && appQuitCalls === 1 && dialogCalls.length === 0, { quitCompleted, appQuitCalls });
  check('second ⌘Q: still only one dialog ever requested', requests(a).length === 1, requests(a));
  check('second ⌘Q: the renderer was told to take its dialog down', dismissals(a).includes(req.requestId), a.sent);
  check('second ⌘Q logged', logged('quit requested again: confirming the open dialog'), logs);
  check('a late answer from the taken-down dialog changes nothing', answer(a, req.requestId, false) === false);
}

// ── 13. Esc / Cancel cancels: nothing quits, shells live, a later ⌘Q asks again ──
await fresh();
{
  const a = showing(0, 4);
  focusedWindow = a;
  cmdQ();
  const r1 = lastRequest(a);
  ack(a, r1.requestId);
  answer(a, r1.requestId, false);
  await later();
  check('Esc: no quit, shells alive, window open, no native box',
    quitCompleted === 0 && appQuitCalls === 0 && ptyManager.size === 4 && !a.isDestroyed() && dialogCalls.length === 0);
  check('Esc: quit-confirmed state not set', isQuitConfirmed() === false);
  check('Esc: cancellation logged', logged('quit not confirmed'), logs);
  cmdQ();
  check('⌘Q after a cancel asks again', requests(a).length === 2 && lastRequest(a).requestId !== r1.requestId, requests(a));
  const r2 = lastRequest(a);
  ack(a, r2.requestId);
  answer(a, r2.requestId, true);
  await later();
  check('and confirming that one quits', quitCompleted === 1);
}

// ── 14. Red button → in-app dialog → confirm ──
await fresh();
{
  const w = showing(0, 2);
  const closed = w.requestClose();
  check('red button (only window): close held back, no native box', !closed && dialogCalls.length === 0 && !w.isDestroyed(), dialogCalls.length);
  const req = lastRequest(w);
  check('red button, only window: asks "quit" with its terminals', req?.kind === 'quit' && req.terminals === 2, req);
  check('red button: asking logged', logged('[CLOSE] window close: asking in the app'), logs);
  const again = w.requestClose();
  check('red button clicked again with the dialog open: still held, no second dialog, no native box',
    !again && requests(w).length === 1 && dialogCalls.length === 0, requests(w));
  check('the repeated click is logged as ignored', logged('a confirmation is already open'), logs);
  ack(w, req.requestId);
  check('still held after the ack', !w.isDestroyed() && ptyManager.destroyed.length === 0);
  answer(w, req.requestId, true);
  await later();
  check('confirm: window closed through the normal path, shells ended once, no native box',
    w.isDestroyed() && ptyManager.destroyed.length === 1 && dialogCalls.length === 0 && warns.length === 0, { destroyed: ptyManager.destroyed, warns });
  check('confirm: logged', logged('[CLOSE] window close confirmed') && logged('window close pre-confirmed'), logs);
}
reset();
{
  const w = showing(0, 3);
  w.requestClose();
  const req = lastRequest(w);
  ack(w, req.requestId);
  answer(w, req.requestId, false);
  await later();
  check('red button, Esc: window and shells stay, nothing native', !w.isDestroyed() && ptyManager.size === 3 && dialogCalls.length === 0);
  w.requestClose();
  check('red button after a cancel asks again', requests(w).length === 2);
  // ⌘Q while the last window\'s red-button "quit" dialog is open confirms it
  const r2 = lastRequest(w);
  ack(w, r2.requestId);
  cmdQ();
  await later();
  check('⌘Q while the red button\'s quit dialog is open confirms that one (no second dialog)',
    requests(w).length === 2 && w.isDestroyed() && ptyManager.size === 0 && dialogCalls.length === 0, { requests: requests(w).length, destroyed: w.isDestroyed() });
}

// ── 15. Renderer does not answer in time → native box; never silent ──
await fresh();
{
  const a = showing(0, 2);
  focusedWindow = a;
  dialogAnswer = 0;
  cmdQ();
  const req = lastRequest(a);
  await sleep(1700);
  check('⌘Q, renderer silent: native "Quit Patton" box after the timeout', dialogCalls.length === 1 && dialogCalls[0].title === 'Quit Patton', dialogCalls);
  check('⌘Q, silent renderer: Cancel keeps everything', quitCompleted === 0 && ptyManager.size === 2 && !a.isDestroyed());
  check('⌘Q, silent renderer: the renderer was told to drop the dialog', dismissals(a).includes(req.requestId), a.sent);
  check('a late ack is refused so the renderer closes its dialog', ack(a, req.requestId) === false);
  check('timeout logged', warns.some((l) => l.includes('did not show the in-app confirmation in time')), warns);
  reset();
  dialogAnswer = 1;
  cmdQ();
  await sleep(1700);
  check('⌘Q, silent renderer, Quit Anyway: the quit goes on once', dialogCalls.length === 1 && quitCompleted === 1 && appQuitCalls === 1, { dialogs: dialogCalls.length, quitCompleted, appQuitCalls });
}
await fresh();
{
  const w = showing(0, 2);
  dialogAnswer = 0;
  w.requestClose();
  await sleep(1700);
  check('red button, renderer silent: native "Close Patton" box, Cancel keeps the window',
    dialogCalls.length === 1 && dialogCalls[0].title === 'Close Patton' && !w.isDestroyed() && ptyManager.size === 2, dialogCalls);
  reset();
  dialogAnswer = 1;
  w.requestClose();
  await sleep(1700);
  check('red button, silent renderer, Close Anyway: closes with the shells ended, one box only',
    w.isDestroyed() && ptyManager.destroyed.length === 1 && dialogCalls.length === 1, { dialogs: dialogCalls.length });
}

// ── 16. A window that cannot show it, or whose renderer dies: native box ──
await fresh();
{
  const a = showing(0, 1);
  a.minimized = true;
  focusedWindow = a;
  dialogAnswer = 0;
  check('⌘Q, only window minimized: native box at once, nothing sent', cmdQ() === 'prevented' && dialogCalls.length === 1 && a.sent.length === 0, { dialogs: dialogCalls.length, sent: a.sent.length });
  reset();
  a.minimized = false;
  a.visible = false;
  cmdQ();
  check('⌘Q, only window hidden: native box at once', dialogCalls.length === 1 && a.sent.length === 0);
  reset();
  dialogAnswer = 1;
  check('⌘Q, hidden window, Quit Anyway: quit goes on in the same event', cmdQ() === 'quit' && quitCompleted === 1 && ptyManager.size === 0);
}
await fresh();
{
  // The window that was asked crashes: its own crash handler ends its shells and
  // reloads it; the quit then asks natively about the shells that are left.
  const a = showing(0, 2);
  const b = showing(0, 1);
  focusedWindow = a;
  dialogAnswer = 0;
  cmdQ();
  check('quit dialog asked in A', requests(a).length === 1 && requests(b).length === 0);
  a.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await later();
  check('renderer crashes with the quit dialog up: native box, counting what is left (1, not the stale 3)',
    dialogCalls.length === 1 && /^1 terminal still/.test(dialogCalls[0].message) && quitCompleted === 0, dialogCalls);
  reset();
  // The only window crashes: its shells are already ended, so there is nothing left to confirm.
  await fresh();
  const c = showing(0, 2);
  focusedWindow = c;
  cmdQ();
  c.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await later();
  check('only window crashes with the dialog up: its shells are already gone, quit goes on without a box', dialogCalls.length === 0 && quitCompleted === 1, { dialogs: dialogCalls.length, quitCompleted });
  await fresh();
  const d = showing(0, 1);
  showing(0, 1);
  d.requestClose();
  d.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await later();
  check('red button, renderer crashes with the dialog up: shells already ended, so it closes with no box', dialogCalls.length === 0 && d.isDestroyed(), { dialogs: dialogCalls.length });
}

// ── 17. No shells: no dialog, as before ──
await fresh();
{
  const a = showing(0, 0);
  focusedWindow = a;
  check('⌘Q with no shells quits at once', cmdQ() === 'quit' && quitCompleted === 1);
  check('⌘Q with no shells: no request, no native box', a.sent.length === 0 && dialogCalls.length === 0, a.sent);
}
await fresh();
{
  const a = showing(0, 0);
  check('red button with no shells closes at once, no dialog', a.requestClose() && a.sent.length === 0 && dialogCalls.length === 0);
}

// ── 18. Two windows ──
await fresh();
{
  const a = showing(0, 2);
  const b = showing(0, 3);
  focusedWindow = a;
  // Red button on a non-last window: "close this window", for that window only.
  const closedA = a.requestClose();
  const ra = lastRequest(a);
  check('red button, two windows: "close-window" with that window\'s own terminals',
    !closedA && ra.kind === 'close-window' && ra.terminals === 2 && requests(b).length === 0, [ra, requests(b)]);
  ack(a, ra.requestId);
  // ⌘Q while it is open: the close dialog is taken down and ONE quit dialog asked for everything.
  cmdQ();
  check('⌘Q while a close-window dialog is open: that dialog is dismissed', dismissals(a).includes(ra.requestId), a.sent);
  const rq = requests(a).at(-1);
  check('⌘Q: one quit dialog (total 5) in the focused window, none in the other',
    rq.kind === 'quit' && rq.terminals === 5 && requests(a).length === 2 && requests(b).length === 0, [requests(a), requests(b)]);
  check('the dismissed close-window request cannot be answered any more', answer(a, ra.requestId, true) === false && !a.isDestroyed());
  ack(a, rq.requestId);
  answer(a, rq.requestId, true);
  await later();
  check('confirm: both windows closed, all shells ended, one dialog in total, no native box',
    windows.length === 0 && ptyManager.size === 0 && requests(a).length === 2 && requests(b).length === 0 && dialogCalls.length === 0 && quitCompleted === 1,
    { windows: windows.length, shells: ptyManager.size, dialogs: dialogCalls.length, quitCompleted });
}
await fresh();
{
  const a = showing(0, 2);
  const b = showing(0, 3);
  a.requestClose();
  const ra = lastRequest(a);
  ack(a, ra.requestId);
  b.requestClose();
  const rb = lastRequest(b);
  check('each window\'s red button has its own dialog (two windows, two requests)', rb && rb.requestId !== ra.requestId && requests(a).length === 1 && requests(b).length === 1);
  ack(b, rb.requestId);
  answer(b, rb.requestId, true);
  await later();
  check('confirming window B closes B only; A and its shells remain', b.isDestroyed() && !a.isDestroyed() && live.get(a) === 2 && !live.has(b));
  answer(a, ra.requestId, false);
  await later();
  check('cancelling A keeps A', !a.isDestroyed() && live.get(a) === 2 && dialogCalls.length === 0);
}
await fresh();
{
  // A quit dialog is open: the red button of ANOTHER window must not stack a second dialog.
  const a = showing(0, 2);
  const b = showing(0, 1);
  focusedWindow = a;
  cmdQ();
  const rq = lastRequest(a);
  ack(a, rq.requestId);
  const closedB = b.requestClose();
  check('red button of another window while the quit dialog is open: held, no second dialog, no native box',
    !closedB && requests(b).length === 0 && requests(a).length === 1 && dialogCalls.length === 0, { b: requests(b).length });
}

// ── 19. The window close handler stands down once a quit is confirmed ──
await fresh();
{
  const a = showing(0, 2);
  focusedWindow = a;
  cmdQ();
  const rq = lastRequest(a);
  ack(a, rq.requestId);
  answer(a, rq.requestId, true);
  await later();
  const late = showing(0, 1); // a window that appears (and gets closed) mid-quit
  late.requestClose();
  check('during a confirmed quit a window closes without any ask', late.isDestroyed() && dialogCalls.length === 0 && requests(late).length === 0, { destroyed: late.isDestroyed(), dialogs: dialogCalls.map((d) => d.title), requests: requests(late).length, confirmed: isQuitConfirmed(), logs: logs.filter((l) => l.includes('quit')) });
}

console.info = realInfo;
console.warn = realWarn;
Date.now = realDateNow;
performance.now = realNow;
for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
