// Check of the tab right-click menu's "Rename Tab…" entry (12 Nov, Michael: "should
// be a rename option on tabs that arent projects when right click"). Drives the REAL
// TabBar in jsdom: the entry exists on a tab outside any project and not on a
// project's tab; choosing it opens the rename box on THAT tab's title, holding its
// full current name; Enter calls onRename(tabId, newName); an emptied box commits
// "" (back to the automatic name); Escape commits nothing; the bar rebuilt while the
// menu is open still finds the tab, and a tab closed meanwhile is a quiet no-op;
// double-click renames exactly as before; and the project tab's own entry stays.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-tab-rename-menu.mjs
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
const doc = w.document;
w.patton = { titleBarDoubleClick: () => {}, moveWindowBy: () => {}, onUiTextScale: () => () => {} };
w.Element.prototype.scrollIntoView = () => {};
w.eval(bundle.outputFiles[0].text);

const noop = () => {};
const renames = [];
const projectRenames = [];
const bar = new w.TB.TabBar(doc.getElementById('bar'), {
  onSelect: noop, onClose: noop, onNew: noop, onReorder: noop, onSettings: noop, onCheckpoint: noop, onSetFlag: noop,
  onRename: (id, name) => renames.push([id, name]),
  onRenameProject: (id, name) => projectRenames.push([id, name]),
});
const tabs = [
  { id: 'plain', title: 'Repeated permission prompts', displayTitle: 'Repeated permi…', autoTitle: 'Repeated permission prompts', active: true },
  { id: 'proj', title: 'patton', autoTitle: 'patton', project: { name: 'patton', defaultName: 'patton' }, active: false },
  { id: 'third', title: 'third', active: false },
];
bar.update(tabs);

const tabEl = (id) => doc.querySelector(`.tab-bar-tab[data-tab-id="${id}"]`);
const fire = (el, type, init = {}) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const openMenu = (id) => { fire(tabEl(id), 'contextmenu', { clientX: 20, clientY: 20 }); return [...doc.querySelectorAll('.context-menu-item')]; };
const labels = (items) => items.map((i) => i.textContent.trim());
const closeMenu = () => { for (const o of doc.querySelectorAll('.context-menu-overlay')) key(o, 'Escape'); };
const choose = (items, label) => items.find((i) => i.textContent.trim().startsWith(label));
const boxes = () => [...doc.querySelectorAll('.tab-bar-tab-rename')];
const reset = () => { for (const b of boxes()) key(b, 'Escape'); closeMenu(); renames.length = 0; };

let items = openMenu('plain');
check('a tab outside any project has "Rename Tab…" in its menu', labels(items).includes('Rename Tab…'), labels(items));
closeMenu();
items = openMenu('proj');
check('a project\'s tab has no "Rename Tab…"', !labels(items).some((l) => l.startsWith('Rename Tab')), labels(items));
check('...and keeps "Set Default Tab Name for Project…"', labels(items).includes('Set Default Tab Name for Project…'), labels(items));
closeMenu();

// choosing it opens the box on THAT tab, with the full current name (not the short one on show)
items = openMenu('plain');
choose(items, 'Rename Tab').click();
let box = boxes()[0];
check('choosing it opens one rename box, in the tab that was clicked', boxes().length === 1 && !!box && tabEl('plain').contains(box), boxes().length);
check('the box holds the tab\'s full name, not the 15-character one on show', box && box.value === 'Repeated permission prompts', box && box.value);
check('the box is labelled "Rename tab", has the automatic name as its placeholder and the focus', box && box.getAttribute('aria-label') === 'Rename tab' && box.placeholder === 'Repeated permission prompts' && doc.activeElement === box, box && { aria: box.getAttribute('aria-label'), ph: box.placeholder });
box.value = 'my tab';
key(box, 'Enter');
check('Enter commits: onRename(tabId, newName)', renames.length === 1 && renames[0][0] === 'plain' && renames[0][1] === 'my tab', renames);
check('...and nothing else was renamed', projectRenames.length === 0);
reset();

// an emptied box commits "" (the automatic name comes back)
items = openMenu('third');
choose(items, 'Rename Tab').click();
box = boxes()[0];
check('a second tab: the box is in that tab and holds its name', box && tabEl('third').contains(box) && box.value === 'third');
box.value = '';
key(box, 'Enter');
check('an emptied box commits an empty name', renames.length === 1 && renames[0][0] === 'third' && renames[0][1] === '', renames);
reset();

// Escape, and an unchanged name, commit nothing
items = openMenu('plain');
choose(items, 'Rename Tab').click();
box = boxes()[0];
box.value = 'typed then abandoned';
key(box, 'Escape');
check('Escape cancels: nothing renamed, the box gone', renames.length === 0 && boxes().length === 0, renames);
items = openMenu('plain');
choose(items, 'Rename Tab').click();
key(boxes()[0], 'Enter');
check('Enter on an unchanged name renames nothing', renames.length === 0, renames);
reset();

// the bar rebuilt while the menu is open: the entry still finds the tab's current title span
items = openMenu('plain');
bar.update(tabs.map((t) => ({ ...t })));
choose(items, 'Rename Tab').click();
box = boxes()[0];
check('after a rebuild of the bar the box still opens, in the rebuilt tab', !!box && tabEl('plain').contains(box) && boxes().length === 1);
reset();

// the tab closed while the menu was open: quiet no-op
items = openMenu('third');
bar.update(tabs.filter((t) => t.id !== 'third'));
let threw = null;
try { choose(items, 'Rename Tab').click(); } catch (e) { threw = String(e); }
check('a tab closed while the menu was open: no box, no error', boxes().length === 0 && threw === null, threw);
reset();
bar.update(tabs);

// the keyboard route goes through the same menu (Enter on the focused item clicks it)
items = openMenu('plain');
const overlay = doc.querySelector('.context-menu-overlay');
for (let i = 0; i < items.length; i++) {
  if (doc.querySelector('.context-menu-item.focused')?.textContent.trim().startsWith('Rename Tab')) break;
  key(overlay, 'ArrowDown');
}
key(overlay, 'Enter');
check('keyboard: arrowing to "Rename Tab…" and pressing Enter opens the box', boxes().length === 1 && tabEl('plain').contains(boxes()[0]), boxes().length);
reset();

// double-click is unchanged: the same box, the same commit
fire(tabEl('plain').querySelector('.tab-bar-tab-title'), 'dblclick');
box = boxes()[0];
check('double-click still opens the same box with the full name', !!box && box.value === 'Repeated permission prompts' && box.getAttribute('aria-label') === 'Rename tab' && box.placeholder === 'Repeated permission prompts', box && box.value);
box.value = 'by double-click';
key(box, 'Enter');
check('...and commits through onRename', renames.length === 1 && renames[0][0] === 'plain' && renames[0][1] === 'by double-click', renames);
reset();

// keyboard focus: closing the box with Enter or Escape lands on that tab, not <body>
items = openMenu('plain');
choose(items, 'Rename Tab').click();
box = boxes()[0];
box.value = 'focus after enter';
key(box, 'Enter');
check('menu route, Enter: focus is on that tab afterwards', doc.activeElement === tabEl('plain'), doc.activeElement && doc.activeElement.tagName);
reset();
items = openMenu('plain');
choose(items, 'Rename Tab').click();
key(boxes()[0], 'Escape');
check('menu route, Escape: focus is on that tab afterwards', doc.activeElement === tabEl('plain'), doc.activeElement && doc.activeElement.tagName);
reset();
fire(tabEl('plain').querySelector('.tab-bar-tab-title'), 'dblclick');
key(boxes()[0], 'Enter');
check('double-click route, Enter: focus is on that tab afterwards', doc.activeElement === tabEl('plain'), doc.activeElement && doc.activeElement.tagName);
reset();
fire(tabEl('third').querySelector('.tab-bar-tab-title'), 'dblclick');
key(boxes()[0], 'Escape');
check('double-click route, Escape: focus is on that tab afterwards', doc.activeElement === tabEl('third'), doc.activeElement && doc.activeElement.tagName);
reset();
// an update held while the box was open rebuilds the tab: focus goes to the NEW element
fire(tabEl('plain').querySelector('.tab-bar-tab-title'), 'dblclick');
bar.update(tabs.map((t) => ({ ...t })));
key(boxes()[0], 'Enter');
check('with an update held meanwhile, focus is on the rebuilt tab', doc.activeElement === tabEl('plain') && doc.activeElement.isConnected, doc.activeElement && doc.activeElement.tagName);
reset();
// clicking away (blur) must not pull focus back
fire(tabEl('plain').querySelector('.tab-bar-tab-title'), 'dblclick');
boxes()[0].blur();
check('blur commits without stealing the focus back', boxes().length === 0 && doc.activeElement !== tabEl('plain'), doc.activeElement && doc.activeElement.tagName);
reset();

// the prefill is the tab's title now, not the one the menu captured
items = openMenu('plain');
bar.update(tabs.map((t) => (t.id === 'plain' ? { ...t, title: 'renamed elsewhere', autoTitle: 'renamed elsewhere', displayTitle: 'renamed elsewhe…' } : { ...t })));
choose(items, 'Rename Tab').click();
box = boxes()[0];
check('the box prefills from the title as it is now', !!box && box.value === 'renamed elsewhere' && box.placeholder === 'renamed elsewhere', box && [box.value, box.placeholder]);
reset();
bar.update(tabs);

// the project's own entry still works
items = openMenu('proj');
choose(items, 'Set Default Tab Name for Project').click();
box = boxes()[0];
box.value = 'renamed';
key(box, 'Enter');
check('a project\'s "Set Default Tab Name" still calls onRenameProject', projectRenames.length === 1 && projectRenames[0][0] === 'proj' && projectRenames[0][1] === 'renamed' && renames.length === 0, { projectRenames, renames });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
