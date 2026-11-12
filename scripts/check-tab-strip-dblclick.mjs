// Check that a double-click on the tab strip's blank space asks main for the
// Mac's title-bar action (window.patton.titleBarDoubleClick), and that one on a
// tab does not. Drives the REAL TabBar in jsdom, with and without tabs.
// Also: dragging from the spacer or the empty tabs area moves the window
// (moveWindowBy) once past the 5 px threshold, and a left press only. Also: a press on
// the blank areas keeps keyboard focus (mousedown defaultPrevented) except while a
// rename box is open, a drag never ends in a zoom, and a tab press still selects.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-tab-strip-dblclick.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const bundle = await build({
  stdin: { contents: `export { TabBar } from './src/renderer/components/tab-bar';`, resolveDir: repo, loader: 'ts' },
  bundle: true, format: 'iife', globalName: 'TB', platform: 'browser', write: false,
  loader: { '.css': 'empty' }, logLevel: 'silent',
});

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

const dom = new JSDOM('<!doctype html><div id="bar"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const noopFn = () => {};
const calls = { dbl: 0, moves: [], selects: [] };
w.patton = {
  titleBarDoubleClick: () => { calls.dbl++; },
  moveWindowBy: (dx, dy) => { calls.moves.push([dx, dy]); },
  onUiTextScale: () => () => {},
};
w.Element.prototype.scrollIntoView = noopFn;
w.eval(bundle.outputFiles[0].text);
const noop = () => {};
const bar = new w.TB.TabBar(w.document.getElementById('bar'), {
  onSelect: (id) => { calls.selects.push(id); }, onClose: noop, onNew: noop, onReorder: noop, onSettings: noop, onRename: noop,
  onRenameProject: noop, onSetFlag: noop, onCheckpoint: noop,
});
bar.update([{ id: 't1', title: 'one', active: true }, { id: 't2', title: 'two', active: false }]);

const doc = w.document;
const space = doc.querySelector('.tab-bar-drag-space');
const strip = doc.querySelector('.tab-bar-tabs');
const tab = doc.querySelector('.tab-bar-tab');
const newBtn = doc.querySelector('.tab-bar-new');
const clock = doc.querySelector('.tab-bar-checkpoint');
const fire = (el, type, init = {}) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));

check('the spacer exists, is aria-hidden and has no text', !!space && space.getAttribute('aria-hidden') === 'true' && space.textContent === '', space && space.outerHTML);
const kids = [...doc.getElementById('bar').children];
check('the spacer sits right after + and before the checkpoint clock', kids.indexOf(space) === kids.indexOf(newBtn) + 1 && kids.indexOf(clock) === kids.indexOf(space) + 1, kids.map((k) => k.className));

fire(space, 'dblclick');
check('a double-click on the spacer calls titleBarDoubleClick once', calls.dbl === 1, calls.dbl);
fire(strip, 'dblclick');
check('a double-click on the empty tabs area calls it once more', calls.dbl === 2, calls.dbl);
fire(tab, 'dblclick');
check('a double-click on a tab does not', calls.dbl === 2, calls.dbl);
fire(tab.querySelector('.tab-bar-tab-title') || tab.firstElementChild || tab, 'dblclick');
check('nor one on a tab\'s title', calls.dbl === 2, calls.dbl);

function drag(el, button = 0) {
  calls.moves.length = 0;
  fire(el, 'mousedown', { screenX: 100, screenY: 100, button });
  fire(doc, 'mousemove', { screenX: 102, screenY: 100 });
  const small = calls.moves.length;
  fire(doc, 'mousemove', { screenX: 110, screenY: 105 });
  fire(doc, 'mousemove', { screenX: 120, screenY: 105 });
  fire(doc, 'mouseup', { screenX: 120, screenY: 105 });
  fire(doc, 'mousemove', { screenX: 150, screenY: 150 });
  return { small, moves: calls.moves.map((m) => m.join(',')).join(' ') };
}
let r = drag(space);
check('dragging the spacer moves the window past 5 px, then follows the mouse', r.small === 0 && r.moves === '10,5 10,0', r);
r = drag(strip);
check('dragging the empty tabs area does the same', r.small === 0 && r.moves === '10,5 10,0', r);
r = drag(space, 2);
check('a right-button press on the spacer drags nothing', r.moves === '', r);

// --- no zoom from controls inside the strip
const input0 = () => doc.querySelector('.tab-bar-tab-rename');
// The earlier title double-click left a rename box open: close it (Escape) so only one is ever open.
for (const open of doc.querySelectorAll('.tab-bar-tab-rename')) open.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
check('(no rename box open before the next checks)', !input0());
const before = calls.dbl;
fire(doc.querySelector('.tab-bar-tab-title'), 'dblclick'); // opens the rename box
const box = input0();
check('a double-click on a tab title opens the rename box', !!box);
fire(box, 'dblclick');
check('a double-click on the rename box does not call titleBarDoubleClick', calls.dbl === before, calls.dbl);

// a press on the blank strip while the box is open must not be defaultPrevented (it has to blur the box)
const pressOpen = fire(space, 'mousedown', { screenX: 5, screenY: 5 });
const pressOpenStrip = fire(strip, 'mousedown', { screenX: 5, screenY: 5 });
fire(doc, 'mouseup', { screenX: 5, screenY: 5 });
check('a press on the spacer / empty tabs area while a rename box is open is NOT defaultPrevented', pressOpen === true && pressOpenStrip === true, { pressOpen, pressOpenStrip });
box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
check('(rename box closed again)', !input0());

const grip = doc.querySelector('.tab-bar-tab-grip');
const closeBtn = doc.querySelector('.tab-bar-tab-close');
check('the grip and close button exist', !!grip && !!closeBtn);
fire(grip, 'dblclick');
fire(closeBtn, 'dblclick');
fire(newBtn, 'dblclick');
check('a double-click on the grip, the close button or + does not call it', calls.dbl === before, calls.dbl);

// --- focus: a press on the blank areas is defaultPrevented, so the terminal keeps focus
const pSpace = fire(space, 'mousedown', { screenX: 5, screenY: 5 });
fire(doc, 'mouseup');
const pStrip = fire(strip, 'mousedown', { screenX: 5, screenY: 5 });
fire(doc, 'mouseup');
check('a press on the spacer is defaultPrevented (focus stays in the terminal)', pSpace === false, pSpace);
check('a press on the empty tabs area is defaultPrevented', pStrip === false, pStrip);
const pTab = fire(tab, 'mousedown', { screenX: 5, screenY: 5 });
fire(doc, 'mouseup');
check('a press on a tab keeps its default (not prevented)', pTab === true, pTab);
calls.selects.length = 0;

// --- no listener leak: update() twice, one double-click, one call
bar.update([{ id: 't1', title: 'one', active: true }, { id: 't2', title: 'two', active: false }]);
bar.update([{ id: 't1', title: 'one', active: true }, { id: 't2', title: 'two', active: false }]);
const b2 = calls.dbl;
fire(space, 'mousedown', { screenX: 5, screenY: 5 }); fire(doc, 'mouseup');
fire(space, 'dblclick');
check('after update() twice, one double-click on the spacer calls it exactly once', calls.dbl === b2 + 1, calls.dbl - b2);

// --- drag then zoom: press, release, press again and drag, release, dblclick
const b3 = calls.dbl;
calls.moves.length = 0;
fire(space, 'mousedown', { screenX: 100, screenY: 100 });
fire(doc, 'mouseup', { screenX: 100, screenY: 100 });
fire(space, 'mousedown', { screenX: 100, screenY: 100 });
fire(doc, 'mousemove', { screenX: 120, screenY: 100 });
fire(doc, 'mouseup', { screenX: 120, screenY: 100 });
fire(space, 'dblclick');
check('press-release-press-drag on the spacer moves the window', calls.moves.length > 0, calls.moves);
check('... and its trailing dblclick does NOT call titleBarDoubleClick', calls.dbl === b3, calls.dbl - b3);
fire(strip, 'mousedown', { screenX: 100, screenY: 100 });
fire(doc, 'mouseup');
fire(strip, 'mousedown', { screenX: 100, screenY: 100 });
fire(doc, 'mousemove', { screenX: 120, screenY: 100 });
fire(doc, 'mouseup');
fire(strip, 'dblclick');
check('the same on the empty tabs area does not call it', calls.dbl === b3, calls.dbl - b3);
fire(space, 'mousedown', { screenX: 100, screenY: 100 });
fire(doc, 'mouseup');
fire(space, 'mousedown', { screenX: 100, screenY: 100 });
fire(doc, 'mouseup');
fire(space, 'dblclick');
check('a clean double-click right after a drag zooms again', calls.dbl === b3 + 1, calls.dbl - b3);

// --- tab body: click selects, press+move drags the window and does not select
const tabNow = doc.querySelectorAll('.tab-bar-tab')[1];
calls.selects.length = 0; calls.moves.length = 0;
fire(tabNow, 'mousedown', { screenX: 50, screenY: 50 });
fire(doc, 'mouseup', { screenX: 50, screenY: 50 });
check('a tab click without movement selects the tab', calls.selects.join() === 't2' && calls.moves.length === 0, { sel: calls.selects, moves: calls.moves });
calls.selects.length = 0;
fire(tabNow, 'mousedown', { screenX: 50, screenY: 50 });
fire(doc, 'mousemove', { screenX: 52, screenY: 50 });
fire(doc, 'mousemove', { screenX: 70, screenY: 50 });
fire(doc, 'mouseup', { screenX: 70, screenY: 50 });
check('a tab press + move moves the window and does not select', calls.selects.length === 0 && calls.moves.length > 0, { sel: calls.selects, moves: calls.moves });
calls.selects.length = 0;
fire(tabNow.querySelector('.tab-bar-tab-grip'), 'mousedown', { screenX: 50, screenY: 50 });
fire(doc, 'mouseup');
fire(tabNow.querySelector('.tab-bar-tab-close'), 'mousedown', { screenX: 50, screenY: 50 });
fire(doc, 'mouseup');
check('a press on the grip or close button does not select (their own handlers)', calls.selects.length === 0, calls.selects);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
