// Headless check of the close-tab confirmation (S45): the tab-close dialog opens
// with "Close Tab" focused, Enter confirms, a second ⌘W confirms, Esc cancels,
// and other ConfirmDialog users (bookmarks, project board) keep Cancel focused.
// The last tab (S45, v1.16.1) gets the same dialog worded "Quit Patton?" (one
// window) or "Close this window?" (several), and on confirm pre-confirms the
// close with main (window.patton.closeGuard) before asking main to close the window, never
// tearing the tab down first. Main's side: scripts/check-close-guard.mjs.
// v1.19 (S46): main also asks for the ⌘Q / red-button confirmations ("Quit
// Patton?" / "Close this window?") through window.patton.closeGuard.onConfirmRequest;
// section 7 drives that: the dialog opens with Quit focused, acks main, Enter or
// ⌘W confirms, Esc cancels, main's dismiss takes it down, a refused or slow ack
// withdraws it, and a new request replaces an open dialog.
// Drives the REAL ConfirmDialog and the REAL TabManager.closeActivePane — the
// method app.ts's onCloseTab (the ⌘W menu accelerator's IPC) calls — in jsdom.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-close-confirm.mjs
//   jsdom is not a project dependency: install it in a scratch folder.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const bundle = await build({
  stdin: {
    contents: `
      export { TabManager } from './src/renderer/services/tab-manager';
      export { ConfirmDialog } from './src/renderer/components/confirm-dialog';
    `,
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: 'CC',
  platform: 'browser',
  write: false,
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const code = bundle.outputFiles[0].text;

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
process.on('unhandledRejection', (err) => { failed++; console.log('FAIL unhandled rejection', String(err)); });
// A hung await (a dialog that never resolves) must fail, not exit quietly.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) process.exitCode = 1;
  if (!finished) console.log('FAIL script ended before all checks ran (a dialog never resolved)');
});
const tick = () => new Promise((r) => setTimeout(r, 5));

// ── Window with a deep-stub window.patton that records rlog lines ──
const logs = [];
const vc = new VirtualConsole();
const dom = new JSDOM('<!doctype html><body><div id="bar"></div><div id="content"></div><textarea id="term"></textarea></body>', {
  runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
});
const w = dom.window;
const stub = () => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : k === 'send' ? (lvl, args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))) : stub()),
  apply: () => Promise.resolve(undefined),
});
w.patton = stub();
w.close = () => { w.__windowClosed = (w.__windowClosed || 0) + 1; };
// jsdom does no layout, so offsetParent is always null and trapFocus would skip
// every button; report the parent so the real focus trap behaves as in Chromium.
Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return this.parentNode; } });
w.eval(code);
const { TabManager, ConfirmDialog } = w.CC;

const fakeTab = (id) => ({ id, title: id, panes: [{}], dispose() {} });
function manager(tabCount) {
  const tm = new TabManager(w.document.getElementById('bar'), w.document.getElementById('content'));
  const tabs = Array.from({ length: tabCount }, (_, i) => fakeTab('tab' + i));
  tm.tabs = tabs;
  tm.activeTab = tabs[0];
  tm.closed = [];
  tm.closeById = async (id) => { tm.closed.push(id); };
  return tm;
}
const key = (el, k, init = {}) =>
  el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const visible = () => !!w.document.querySelector('.confirm-dialog-overlay.visible');
const focusedClass = () => w.document.activeElement?.className;
const lastLogs = () => logs.map((a) => a.join(' ')).filter((l) => l.includes('[CLOSE]'));

// ── 1. Tab close: Close focused, Enter confirms ──
{
  const tm = manager(2);
  w.document.getElementById('term').focus();
  const p = tm.closeActivePane();
  await tick();
  check('tab close dialog opens', visible());
  check('Close Tab is focused', focusedClass() === 'confirm-dialog-confirm', focusedClass());
  check('confirm button reads Close Tab', w.document.activeElement.textContent === 'Close Tab');
  key(w.document.activeElement, 'Enter');
  await p;
  check('Enter closes the tab', tm.closed.join() === 'tab0', tm.closed);
  check('dialog hidden after Enter', !visible());
  check('answer logged as enter', tm.confirmDialog.lastAnswer === 'enter', tm.confirmDialog.lastAnswer);
  // Chromium also fires a click for Enter on a button: it must not re-answer.
  tm.confirmDialog.overlay.querySelector('.confirm-dialog-confirm').click();
  check('a trailing click does not overwrite the answer', tm.confirmDialog.lastAnswer === 'enter');
  check('focus returns to the terminal', w.document.activeElement.id === 'term', w.document.activeElement.id);
}

// ── 2. A second ⌘W (same entry point) confirms, no second dialog ──
{
  const tm = manager(2);
  const p = tm.closeActivePane();
  await tick();
  const second = tm.closeActivePane(); // what onCloseTab calls for the second ⌘W
  await Promise.all([p, second]);
  check('second ⌘W closes the tab', tm.closed.join() === 'tab0', tm.closed);
  check('second ⌘W leaves no dialog open', !visible());
  check('answer logged as cmd-w', tm.confirmDialog.lastAnswer === 'cmd-w', tm.confirmDialog.lastAnswer);
  const l = lastLogs();
  check('[CLOSE] confirm shown logged with kind and defaultFocus',
    l.some((x) => x.includes('confirm shown') && x.includes('"kind":"tab"') && x.includes('"defaultFocus":"confirm"')), l);
  check('[CLOSE] answered logged with by cmd-w', l.some((x) => x.includes('answered') && x.includes('cmd-w')), l);
}

// ── 3. Esc and Cancel cancel; a later ⌘W still works ──
{
  const tm = manager(2);
  let p = tm.closeActivePane();
  await tick();
  key(w.document.activeElement, 'Escape');
  await p;
  check('Esc cancels (tab kept)', tm.closed.length === 0 && !visible());
  check('answer logged as escape', tm.confirmDialog.lastAnswer === 'escape');

  p = tm.closeActivePane();
  await tick();
  w.document.querySelector('.confirm-dialog-overlay.visible .confirm-dialog-cancel').click();
  await p;
  check('Cancel button cancels', tm.closed.length === 0 && !visible());
  check('answer logged as button', tm.confirmDialog.lastAnswer === 'button');

  p = tm.closeActivePane();
  await tick();
  w.document.querySelector('.confirm-dialog-overlay.visible .confirm-dialog-confirm').click();
  await p;
  check('Close Tab button closes', tm.closed.join() === 'tab0');
}

// ── 4. ⌘W with no dialog open opens one (not an instant close) ──
{
  const tm = manager(2);
  const p = tm.closeActivePane();
  await tick();
  check('first ⌘W only opens the dialog', visible() && tm.closed.length === 0);
  tm.confirmDialog.confirmByShortcut();
  await p;
}

// ── 5. Last tab: the in-app dialog says what closing really does ──
// window.patton.closeGuard answers as main would; every step is recorded in
// order, so "pre-confirm before the close request, tab never disposed" is checked.
const events = [];
let closeInfo = { isLastWindow: true, liveShells: 2 };
let infoDelayMs = 0;
let preconfirmReply = true;
let preconfirmDelayMs = 0;
let preconfirmSettled = true; // false while the pre-confirm invoke is unanswered
let closedBeforeReply = false; // the close ran while the pre-confirm was still unanswered
// What main's WINDOW_CLOSE answers: true (taken), false (refused) or an Error (invoke fails).
let closeWindowReply = true;
let closeWindowDelayMs = 0;
// Main → renderer confirmations (v1.19): the callbacks TabManager registered.
let mainRequest = null;
let mainDismiss = null;
let ackReply = true;
let ackDelayMs = 0;
{
  const base = w.patton;
  const closeGuard = {
    info: async () => {
      events.push('info');
      if (infoDelayMs) await new Promise((r) => setTimeout(r, infoDelayMs));
      if (closeInfo instanceof Error) throw closeInfo;
      return closeInfo;
    },
    preconfirm: async () => {
      events.push('preconfirm');
      preconfirmSettled = false;
      if (preconfirmDelayMs) await new Promise((r) => setTimeout(r, preconfirmDelayMs));
      preconfirmSettled = true;
      return preconfirmReply;
    },
    // Main closes the window with BrowserWindow.close(), which emits 'close'.
    closeWindow: async () => {
      events.push('closeWindow');
      if (!preconfirmSettled) closedBeforeReply = true;
      if (closeWindowDelayMs) await new Promise((r) => setTimeout(r, closeWindowDelayMs));
      if (closeWindowReply instanceof Error) throw closeWindowReply;
      return closeWindowReply;
    },
    onConfirmRequest: (cb) => { mainRequest = cb; return () => { mainRequest = null; }; },
    onConfirmDismiss: (cb) => { mainDismiss = cb; return () => { mainDismiss = null; }; },
    ackConfirm: async (id) => {
      events.push('ack:' + id);
      if (ackDelayMs) await new Promise((r) => setTimeout(r, ackDelayMs));
      return ackReply;
    },
    answerConfirm: async (id, ok) => { events.push(`answer:${id}:${ok}`); return true; },
  };
  w.patton = new Proxy({}, { get: (_t, k) => (k === 'closeGuard' ? closeGuard : base[k]) });
  // The page's own window.close(): it destroys the window WITHOUT a 'close'
  // event (Electron 44.9.3), skipping main's guard. Only the fallback may call it.
  w.close = () => { events.push('window.close'); if (!preconfirmSettled) closedBeforeReply = true; };
}
function lastTab() {
  events.length = 0;
  logs.length = 0;
  const tm = manager(1);
  tm.tabs[0].dispose = () => events.push('dispose');
  tm.closeById = async (id) => { events.push('closeById:' + id); };
  return tm;
}
const dialogText = (sel) => w.document.querySelector(`.confirm-dialog-overlay.visible ${sel}`)?.textContent ?? '';
const torn = () => events.some((e) => e === 'dispose' || e.startsWith('closeById'));

// 5a. Only window: "Quit Patton?", Quit focused, ⌘W twice quits
{
  closeInfo = { isLastWindow: true, liveShells: 2 };
  const tm = lastTab();
  const p = tm.closeActivePane();
  await tick();
  check('last tab: in-app dialog opens', visible());
  check('last tab, one window: title Quit Patton?', dialogText('.confirm-dialog-title') === 'Quit Patton?', dialogText('.confirm-dialog-title'));
  check('last tab, one window: Quit is focused', focusedClass() === 'confirm-dialog-confirm' && w.document.activeElement.textContent === 'Quit', w.document.activeElement.textContent);
  const msg = dialogText('.confirm-dialog-message');
  check('last tab, one window: message names the tab and says it quits and ends every shell',
    msg.includes('“tab0”') && msg.includes('quits Patton') && msg.includes('every shell in this window'), msg);
  check('last tab: nothing sent and nothing closed while the dialog is up', events.join() === 'info', events);
  const l = lastLogs();
  check('[CLOSE] confirm shown logged with kind last-tab, isLastWindow true',
    l.some((x) => x.includes('confirm shown') && x.includes('"kind":"last-tab"') && x.includes('"isLastWindow":true')), l);
  const second = tm.closeActivePane(); // the second ⌘W
  await Promise.all([p, second]);
  check('last tab, ⌘W twice: pre-confirm sent, then close via main', events.join() === 'info,preconfirm,closeWindow', events);
  check('last tab, ⌘W twice: tab never torn down before the window closes', !torn(), events);
  check('last tab, ⌘W twice: answer cmd-w', tm.confirmDialog.lastAnswer === 'cmd-w');
  check('last tab: answer and hand-off logged',
    lastLogs().some((x) => x.includes('answered') && x.includes('"kind":"last-tab"') && x.includes('cmd-w'))
    && lastLogs().some((x) => x.includes('window close handed to main') && x.includes('"preconfirmed":true')), lastLogs());
}

// 5b. Enter confirms too
{
  const tm = lastTab();
  const p = tm.closeActivePane();
  await tick();
  key(w.document.activeElement, 'Enter');
  await p;
  check('last tab, Enter: pre-confirm then close via main, no teardown', events.join() === 'info,preconfirm,closeWindow', events);
}

// 5c. Several windows: "Close this window?", and Esc cancels sending nothing
{
  closeInfo = { isLastWindow: false, liveShells: 1 };
  const tm = lastTab();
  const p = tm.closeActivePane();
  await tick();
  check('last tab, several windows: title Close this window?', dialogText('.confirm-dialog-title') === 'Close this window?', dialogText('.confirm-dialog-title'));
  check('last tab, several windows: Close Window focused', w.document.activeElement.textContent === 'Close Window', w.document.activeElement.textContent);
  check('last tab, several windows: says other windows stay open', dialogText('.confirm-dialog-message').includes('other windows stay open'), dialogText('.confirm-dialog-message'));
  check('[CLOSE] confirm shown logged with isLastWindow false', lastLogs().some((x) => x.includes('confirm shown') && x.includes('"isLastWindow":false')), lastLogs());
  key(w.document.activeElement, 'Escape');
  await p;
  check('last tab, Esc: nothing sent, window kept, tab kept', events.join() === 'info' && !visible() && !torn(), events);
}

// 5d. Cancel button cancels, sends nothing
{
  closeInfo = { isLastWindow: true, liveShells: 1 };
  const tm = lastTab();
  const p = tm.closeActivePane();
  await tick();
  w.document.querySelector('.confirm-dialog-overlay.visible .confirm-dialog-cancel').click();
  await p;
  check('last tab, Cancel: nothing sent, nothing closed', events.join() === 'info' && !visible(), events);
}

// 5e. ✕ on the only tab takes the same path (not "Close this tab?")
{
  const tm = lastTab();
  const p = tm.confirmAndCloseTab('tab0');
  await tick();
  check('✕ on the last tab: Quit Patton? dialog', dialogText('.confirm-dialog-title') === 'Quit Patton?', dialogText('.confirm-dialog-title'));
  tm.confirmDialog.confirmByShortcut();
  await p;
  check('✕ on the last tab: pre-confirm then close via main, no teardown', events.join() === 'info,preconfirm,closeWindow', events);
}

// 5f. No live shells: no dialog, straight to the close request (as before)
{
  closeInfo = { isLastWindow: true, liveShells: 0 };
  const tm = lastTab();
  await tm.closeActivePane();
  check('last tab, no live shells: no dialog, the close goes to main straight away', !visible() && events.join() === 'info,closeWindow', events);
}

// 5g. Main can't answer the query: fail closed (no dialog could be shown, so nothing closes)
{
  closeInfo = new Error('rate limited');
  let tm = lastTab();
  await tm.closeActivePane();
  check('close info fails: no dialog, nothing closed (fail closed)', !visible() && events.join() === 'info', events);
  check('close info fails: logged as not answered', lastLogs().some((x) => x.includes('last tab not closed: main did not answer') && x.includes('no-close-info')), lastLogs());
  closeInfo = null;
  tm = lastTab();
  await tm.closeActivePane();
  check('close info null: no dialog, nothing closed (fail closed)', !visible() && events.join() === 'info' && !events.includes('window.close'), events);
}

// 5h. Pre-confirm refused: still asks main to close, logged as not pre-confirmed
{
  closeInfo = { isLastWindow: true, liveShells: 1 };
  preconfirmReply = false;
  const tm = lastTab();
  const p = tm.closeActivePane();
  await tick();
  tm.closeActivePane();
  await p;
  check('pre-confirm refused: close via main still requested', events.join() === 'info,preconfirm,closeWindow', events);
  check('pre-confirm refused: logged preconfirmed false', lastLogs().some((x) => x.includes('"preconfirmed":false')), lastLogs());
  preconfirmReply = true;
}

// 5i. A second ⌘W while main is still answering doesn't open a second query
{
  infoDelayMs = 20;
  const tm = lastTab();
  const p = tm.closeActivePane();
  const early = tm.closeActivePane();
  await early;
  await new Promise((r) => setTimeout(r, 40));
  check('fast double ⌘W: one query, one dialog', events.filter((e) => e === 'info').length === 1 && visible(), events);
  tm.confirmDialog.confirmByShortcut();
  await p;
  infoDelayMs = 0;
}

// 5j. The close request waits for main's pre-confirm reply (a close request and an
// invoke travel on different pipes: closing first lets main's native box ask a
// second time).
{
  closeInfo = { isLastWindow: true, liveShells: 1 };
  preconfirmDelayMs = 40;
  closedBeforeReply = false;
  const tm = lastTab();
  const p = tm.closeActivePane();
  await tick();
  tm.confirmDialog.confirmByShortcut();
  await new Promise((r) => setTimeout(r, 15));
  check('pre-confirm unanswered: close not requested yet', events.join() === 'info,preconfirm', events);
  await p;
  check('pre-confirm answered: then close via main', events.join() === 'info,preconfirm,closeWindow' && !closedBeforeReply, { events, closedBeforeReply });
  preconfirmDelayMs = 0;
}

// 5k. The tabs changed while the dialog was open: the confirm acts on nothing
{
  closeInfo = { isLastWindow: true, liveShells: 1 };
  // the dialog's tab is gone and another tab is the only one left
  let tm = lastTab();
  let p = tm.closeActivePane();
  await tick();
  const other = fakeTab('other');
  tm.tabs = [other];
  tm.confirmDialog.confirmByShortcut();
  await p;
  check('dialog tab gone, another tab left: nothing sent, window kept', events.join() === 'info' && !torn(), events);
  check('dialog tab gone: ignore logged', lastLogs().some((x) => x.includes('confirm ignored')), lastLogs());
  // a second tab was opened while the dialog was up
  tm = lastTab();
  p = tm.closeActivePane();
  await tick();
  tm.tabs = [tm.tabs[0], fakeTab('opened')];
  tm.confirmDialog.confirmByShortcut();
  await p;
  check('second tab opened during the dialog: nothing sent, window kept', events.join() === 'info' && !torn(), events);
}

// 5l. "Close this tab?" confirmed after the other tabs went: it is the last tab,
// so it takes the last-tab path (asks again, never disposes first)
for (const via of ['⌘W', '✕']) {
  closeInfo = { isLastWindow: true, liveShells: 1 };
  const tm = lastTab();
  const second = fakeTab('tab1');
  tm.tabs = [tm.tabs[0], second];
  const t0 = tm.tabs[0];
  tm.activeTab = t0;
  const p = via === '⌘W' ? tm.closeActivePane() : tm.confirmAndCloseTab('tab0');
  await tick();
  check(`${via} with two tabs: "Close this tab?" first`, dialogText('.confirm-dialog-title') === 'Close this tab?', dialogText('.confirm-dialog-title'));
  tm.tabs = [t0]; // the other tab's shell exited meanwhile
  key(w.document.activeElement, 'Enter');
  await tick();
  await tick();
  check(`${via}: now the last tab, so Quit Patton? is asked`, dialogText('.confirm-dialog-title') === 'Quit Patton?', dialogText('.confirm-dialog-title'));
  check(`${via}: the tab is not torn down before the second answer`, !torn(), events);
  tm.confirmDialog.confirmByShortcut();
  await p;
  check(`${via}: last-tab path: pre-confirm, then close via main, no teardown`, events.join() === 'info,preconfirm,closeWindow', events);
}

// 5m. A stalled main (no reply): bounded wait, then the close request
{
  closeInfo = { isLastWindow: true, liveShells: 1 };
  infoDelayMs = 300;
  let tm = lastTab();
  tm.closeIpcTimeoutMs = 30;
  await tm.closeActivePane();
  check('close info stalled: no dialog, nothing closed after the timeout (fail closed)', !visible() && events.join() === 'info', events);
  check('close info stalled: timeout logged', lastLogs().some((x) => x.includes('timed out') && x.includes('"what":"info"')), lastLogs());
  check('close info stalled: not-closed logged', lastLogs().some((x) => x.includes('last tab not closed: main did not answer') && x.includes('close-info-timeout')), lastLogs());
  // the query flag was released: the next ⌘W is not dropped
  infoDelayMs = 0;
  events.length = 0;
  const p = tm.closeActivePane();
  await tick();
  check('after a timeout the next ⌘W opens the dialog', visible(), events);
  tm.confirmDialog.confirmByShortcut();
  await p;

  preconfirmDelayMs = 300;
  tm = lastTab();
  tm.closeIpcTimeoutMs = 30;
  const q = tm.closeActivePane();
  await tick();
  tm.confirmDialog.confirmByShortcut();
  await q;
  check('pre-confirm stalled: close via main after the timeout', events.join() === 'info,preconfirm,closeWindow', events);
  check('pre-confirm stalled: logged not pre-confirmed, timed out',
    lastLogs().some((x) => x.includes('"preconfirmed":false') && x.includes('"timedOut":true')), lastLogs());
  preconfirmDelayMs = 0;
  await new Promise((r) => setTimeout(r, 320)); // let the stalled replies settle
}

// 5n. The close request itself fails: fall back to the page's window.close()
// (no 'close' event; main's 'closed' safety net ends the shells), logged
for (const [label, reply, delay] of [
  ['refused (false)', false, 0],
  ['invoke throws', new Error('no handler'), 0],
  ['stalled', true, 300],
]) {
  closeInfo = { isLastWindow: true, liveShells: 1 };
  closeWindowReply = reply;
  closeWindowDelayMs = delay;
  const tm = lastTab();
  tm.closeIpcTimeoutMs = 30;
  const p = tm.closeActivePane();
  await tick();
  tm.confirmDialog.confirmByShortcut();
  await p;
  check(`close request ${label}: falls back to window.close() after pre-confirm`, events.join() === 'info,preconfirm,closeWindow,window.close', events);
  check(`close request ${label}: fallback logged`, lastLogs().some((x) => x.includes('did not take the window close')), lastLogs());
  check(`close request ${label}: tab still not torn down first`, !torn(), events);
}
closeWindowReply = true;
closeWindowDelayMs = 0;
await new Promise((r) => setTimeout(r, 320));

// 5o. The ordinary path never touches the page's window.close()
{
  closeInfo = { isLastWindow: true, liveShells: 1 };
  const tm = lastTab();
  const p = tm.closeActivePane();
  await tick();
  tm.confirmDialog.confirmByShortcut();
  await p;
  check('normal last-tab close: window.close() never called', !events.includes('window.close'), events);
}

// 5p. Closing the final tab by closeById (shell exit, closeTab) closes via main too
{
  events.length = 0;
  const tm = new TabManager(w.document.getElementById('bar'), w.document.getElementById('content'));
  const t = fakeTab('solo');
  tm.tabs = [t];
  tm.activeTab = t;
  tm.removeTab = (tab) => { tm.tabs = tm.tabs.filter((x) => x !== tab); };
  tm.saveClosedPane = () => {};
  await tm.closeById('solo');
  check('closeById of the last tab: close goes through main, not window.close()', events.join() === 'closeWindow', events);
}

// ── 7. Main asks for the ⌘Q / red-button confirmations (v1.19) ──
{
  const ask = async (tm, request) => { events.length = 0; mainRequest(request); await tick(); };
  const dlg = (sel) => w.document.querySelector(`.confirm-dialog-overlay.visible ${sel}`)?.textContent ?? '';
  const tmQuit = () => { const tm = manager(1); w.document.getElementById('term').focus(); return tm; };

  // 7a. Quit: wording, focus, ack, Enter confirms
  {
    const tm = tmQuit();
    await ask(tm, { requestId: 'q1', kind: 'quit', terminals: 3 });
    check('main quit request: the in-app dialog opens', visible());
    check('main quit request: title Quit Patton?', dlg('.confirm-dialog-title') === 'Quit Patton?', dlg('.confirm-dialog-title'));
    check('main quit request: message names the 3 terminals and says it ends them', /3 terminals still running/.test(dlg('.confirm-dialog-message')) && /ends every terminal session/.test(dlg('.confirm-dialog-message')), dlg('.confirm-dialog-message'));
    check('main quit request: Quit is focused', focusedClass() === 'confirm-dialog-confirm' && w.document.activeElement.textContent === 'Quit', w.document.activeElement.textContent);
    check('main quit request: main is told the dialog is up, and nothing else yet', events.join() === 'ack:q1', events);
    key(w.document.activeElement, 'Enter');
    await tick();
    check('Enter confirms: answer true sent to main', events.join() === 'ack:q1,answer:q1:true', events);
    check('dialog hidden after the answer', !visible());
    check('answer and dialog logged',
      lastLogs().some((x) => x.includes('confirm shown') && x.includes('main-quit') && x.includes('q1'))
      && lastLogs().some((x) => x.includes('confirm answered') && x.includes('main-quit') && x.includes('"ok":true')), lastLogs());
  }

  // 7b. ⌘W (the same entry point as the menu accelerator) confirms; no second dialog, no last-tab path
  {
    const tm = tmQuit();
    await ask(tm, { requestId: 'q2', kind: 'quit', terminals: 1 });
    check('1 terminal is singular', /1 terminal still running/.test(dlg('.confirm-dialog-message')), dlg('.confirm-dialog-message'));
    await tm.closeActivePane();
    await tick();
    check('⌘W confirms the quit dialog: answer true, no last-tab info/pre-confirm/close', events.join() === 'ack:q2,answer:q2:true', events);
    check('⌘W: answer logged as cmd-w', tm.confirmDialog.lastAnswer === 'cmd-w');
  }

  // 7c. Esc and Cancel cancel
  {
    const tm = tmQuit();
    await ask(tm, { requestId: 'q3', kind: 'quit', terminals: 2 });
    key(w.document.activeElement, 'Escape');
    await tick();
    check('Esc cancels: answer false', events.join() === 'ack:q3,answer:q3:false' && !visible(), events);
    await ask(tm, { requestId: 'q3b', kind: 'quit', terminals: 2 });
    w.document.querySelector('.confirm-dialog-overlay.visible .confirm-dialog-cancel').click();
    await tick();
    check('Cancel button: answer false', events.join() === 'ack:q3b,answer:q3b:false', events);
  }

  // 7d. Close this window?
  {
    const tm = tmQuit();
    await ask(tm, { requestId: 'c1', kind: 'close-window', terminals: 2 });
    check('close-window request: title and button', dlg('.confirm-dialog-title') === 'Close this window?' && w.document.activeElement.textContent === 'Close Window', [dlg('.confirm-dialog-title'), w.document.activeElement.textContent]);
    check('close-window request: says other windows stay', /other windows stay open/.test(dlg('.confirm-dialog-message')) && /2 terminals/.test(dlg('.confirm-dialog-message')), dlg('.confirm-dialog-message'));
    key(w.document.activeElement, 'Enter');
    await tick();
    check('close-window: Enter confirms', events.join() === 'ack:c1,answer:c1:true', events);
  }

  // 7e. Main takes it down (a second ⌘Q): dialog gone, no answer sent; a wrong id changes nothing
  {
    const tm = tmQuit();
    await ask(tm, { requestId: 'd1', kind: 'quit', terminals: 2 });
    mainDismiss('someone-else');
    await tick();
    check('dismiss for another request id: dialog stays', visible());
    mainDismiss('d1');
    await tick();
    check('dismiss from main: dialog down, no answer sent', !visible() && events.join() === 'ack:d1', events);
    check('dismiss logged', lastLogs().some((x) => x.includes('main took its confirmation down')), lastLogs());
    check('focus returns to the terminal', w.document.activeElement.id === 'term', w.document.activeElement.id);
  }

  // 7f. Main refuses the ack (it already gave up): the dialog is withdrawn, nothing answered
  {
    const tm = tmQuit();
    ackReply = false;
    await ask(tm, { requestId: 'a1', kind: 'quit', terminals: 2 });
    await tick();
    check('refused ack: dialog withdrawn, no answer', !visible() && events.join() === 'ack:a1', events);
    ackReply = true;
  }

  // 7g. Ack slower than the close-IPC timeout: withdrawn too (main has gone native by then)
  {
    const tm = tmQuit();
    tm.closeIpcTimeoutMs = 30;
    ackDelayMs = 120;
    await ask(tm, { requestId: 'a2', kind: 'quit', terminals: 2 });
    await new Promise((r) => setTimeout(r, 200));
    check('slow ack: dialog withdrawn, no answer', !visible() && events.join() === 'ack:a2', events);
    ackDelayMs = 0;
  }

  // 7h. A new request replaces a dialog that is already open
  {
    const tm = manager(2);
    w.document.getElementById('term').focus();
    const closing = tm.closeActivePane(); // "Close this tab?"
    await tick();
    check('precondition: the tab-close dialog is up', dlg('.confirm-dialog-title') === 'Close this tab?', dlg('.confirm-dialog-title'));
    await ask(tm, { requestId: 'r1', kind: 'quit', terminals: 2 });
    await closing;
    check('main request replaces the tab-close dialog (the tab stays)', dlg('.confirm-dialog-title') === 'Quit Patton?' && tm.closed.length === 0, [dlg('.confirm-dialog-title'), tm.closed]);
    mainRequest({ requestId: 'r2', kind: 'quit', terminals: 2 });
    await tick();
    check('a newer main request replaces an older one, and the older is answered false', events.includes('answer:r1:false') && visible(), events);
    key(w.document.activeElement, 'Enter');
    await tick();
    check('and the newer one is answered by the user', events.includes('answer:r2:true'), events);
  }
}

// ── 6. Bookmarks / board style: default options, Cancel focused, Enter cancels ──
{
  const d = new ConfirmDialog(w.document.body);
  w.document.getElementById('term').focus();
  let p = d.confirm({ title: 'Remove?', message: 'x', confirmLabel: 'Remove' });
  await tick();
  check('default confirm: Cancel focused', focusedClass() === 'confirm-dialog-cancel', focusedClass());
  key(w.document.activeElement, 'Enter');
  await tick();
  check('default confirm: bare Enter does not confirm', d.isOpen);
  check('default confirm: shortcut does not confirm', d.confirmByShortcut() === false && d.isOpen);
  key(w.document.activeElement, 'ArrowRight');
  check('default confirm: → moves to the confirm button', focusedClass() === 'confirm-dialog-confirm');
  key(w.document.activeElement, 'Enter');
  check('default confirm: → then Enter confirms', (await p) === true);

  p = d.confirm({ title: 'Remove?', message: 'x', defaultFocus: 'cancel' });
  await tick();
  w.document.querySelector('.confirm-dialog-overlay.visible .confirm-dialog-cancel').click();
  check('explicit cancel focus: Cancel resolves false', (await p) === false);
  d.dispose();
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
