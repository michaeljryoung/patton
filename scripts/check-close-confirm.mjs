// Headless check of the close-tab confirmation (S45): the tab-close dialog opens
// with "Close Tab" focused, Enter confirms, a second ⌘W confirms, Esc cancels,
// and other ConfirmDialog users (bookmarks, project board) keep Cancel focused.
// The last tab (S45, v1.16.1) gets the same dialog worded "Quit Patton?" (one
// window) or "Close this window?" (several), and on confirm pre-confirms the
// close with main (window.patton.closeGuard) before window.close(), never
// tearing the tab down first. Main's side: scripts/check-close-guard.mjs.
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
// order, so "pre-confirm before window.close(), tab never disposed" is checked.
const events = [];
let closeInfo = { isLastWindow: true, liveShells: 2 };
let infoDelayMs = 0;
let preconfirmReply = true;
{
  const base = w.patton;
  const closeGuard = {
    info: async () => {
      events.push('info');
      if (infoDelayMs) await new Promise((r) => setTimeout(r, infoDelayMs));
      if (closeInfo instanceof Error) throw closeInfo;
      return closeInfo;
    },
    preconfirm: async () => { events.push('preconfirm'); return preconfirmReply; },
  };
  w.patton = new Proxy({}, { get: (_t, k) => (k === 'closeGuard' ? closeGuard : base[k]) });
  w.close = () => { events.push('window.close'); };
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
  check('last tab, ⌘W twice: pre-confirm sent, then window.close()', events.join() === 'info,preconfirm,window.close', events);
  check('last tab, ⌘W twice: tab never torn down before window.close()', !torn(), events);
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
  check('last tab, Enter: pre-confirm then window.close(), no teardown', events.join() === 'info,preconfirm,window.close', events);
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
  check('✕ on the last tab: pre-confirm then window.close(), no teardown', events.join() === 'info,preconfirm,window.close', events);
}

// 5f. No live shells: no dialog, straight to window.close() (as before)
{
  closeInfo = { isLastWindow: true, liveShells: 0 };
  const tm = lastTab();
  await tm.closeActivePane();
  check('last tab, no live shells: no dialog, window.close() straight away', !visible() && events.join() === 'info,window.close', events);
}

// 5g. Main can't answer: window.close() and the native guard decides
{
  closeInfo = new Error('rate limited');
  let tm = lastTab();
  await tm.closeActivePane();
  check('close info fails: no dialog, window.close() (native guard asks)', !visible() && events.join() === 'info,window.close', events);
  closeInfo = null;
  tm = lastTab();
  await tm.closeActivePane();
  check('close info null: no dialog, window.close()', !visible() && events.join() === 'info,window.close', events);
}

// 5h. Pre-confirm refused: still window.close(), logged as not pre-confirmed
{
  closeInfo = { isLastWindow: true, liveShells: 1 };
  preconfirmReply = false;
  const tm = lastTab();
  const p = tm.closeActivePane();
  await tick();
  tm.closeActivePane();
  await p;
  check('pre-confirm refused: window.close() still called', events.join() === 'info,preconfirm,window.close', events);
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
