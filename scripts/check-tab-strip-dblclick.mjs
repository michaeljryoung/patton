// Check that a double-click on the tab strip's blank space asks main for the
// Mac's title-bar action (window.patton.titleBarDoubleClick), and that one on a
// tab does not. Drives the REAL TabBar in jsdom, with and without tabs.
// Also: dragging from the spacer or the empty tabs area moves the window
// (moveWindowBy) once past the 5 px threshold, and a left press only.
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
const calls = { dbl: 0, moves: [] };
w.patton = {
  titleBarDoubleClick: () => { calls.dbl++; },
  moveWindowBy: (dx, dy) => { calls.moves.push([dx, dy]); },
  onUiTextScale: () => () => {},
};
w.Element.prototype.scrollIntoView = noopFn;
w.eval(bundle.outputFiles[0].text);
const noop = () => {};
const bar = new w.TB.TabBar(w.document.getElementById('bar'), {
  onSelect: noop, onClose: noop, onNew: noop, onReorder: noop, onSettings: noop, onRename: noop,
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
