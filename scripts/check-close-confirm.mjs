// Headless check of the close-tab confirmation (S45): the tab-close dialog opens
// with "Close Tab" focused, Enter confirms, a second ⌘W confirms, Esc cancels,
// and other ConfirmDialog users (bookmarks, project board) keep Cancel focused.
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

// ── 5. Last tab keeps the window.close() path, no dialog ──
{
  const tm = manager(1);
  await tm.closeActivePane();
  check('last tab: no Patton dialog', !visible());
  check('last tab: window.close() reached (main close guard)', w.__windowClosed === 1, w.__windowClosed);
  check('last tab: tab not torn down first', tm.closed.length === 0);
  await tm.closeActivePane();
  check('last tab, ⌘W again: still only window.close()', w.__windowClosed === 2 && !visible());
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
