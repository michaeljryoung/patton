// Check of the tab right-click menu's "Rename Tab…" entry (12 Nov, Michael: "should
// be a rename option on tabs that arent projects when right click"; 25 Nov: "if
// something is a live project with a default name, you can't rename it as a one-off.
// There should be a set default rename and an adjust rename"). Drives the REAL
// TabBar in jsdom: the entry exists on every tab, a project's included, where it sits
// directly above "Set Default Tab Name for Project…"; choosing it opens the rename box on THAT tab's title, holding its
// full current name; Enter calls onRename(tabId, newName); an emptied box commits
// "" (back to the automatic name); Escape commits nothing; the bar rebuilt while the
// menu is open still finds the tab, and a tab closed meanwhile is a quiet no-op;
// double-click renames exactly as before; and the project tab's own entry stays.
// Second half, the REAL TabManager (scripts/tab-manager-harness.mjs): a one-off name
// wins on the strip and in the palette's name while set, a later project-default rename
// leaves it alone (and changes the other tabs of the project), and an emptied or
// whitespace box clears it, so the project's name (its default, once set) is back.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-tab-rename-menu.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setUpTabManager, until, tick } from './tab-manager-harness.mjs';

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
  onSelect: noop, onClose: noop, onNew: noop, onSettings: noop, onSetFlag: noop,
  onRename: (id, name) => renames.push([id, name]),
  onRenameProject: (id, name) => projectRenames.push([id, name]),
});
const tabs = [
  { id: 'plain', title: 'Repeated permission prompts', displayTitle: 'Repeated permi…', autoTitle: 'Repeated permission prompts', active: true },
  { id: 'proj', title: 'patton', autoTitle: 'patton', project: { name: 'patton', defaultName: 'patton' }, active: false },
  { id: 'shellproj', title: 'Terminal', autoTitle: 'Terminal', project: { name: 'patton', defaultName: 'patton' }, active: false },
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
const at = (l) => labels(items).indexOf(l);
check('a project\'s tab has "Rename Tab…" too (a one-off name)', labels(items).includes('Rename Tab…'), labels(items));
check('...and keeps "Set Default Tab Name for Project…"', labels(items).includes('Set Default Tab Name for Project…'), labels(items));
// the next DOM sibling, so a separator between the two (a div that is no .context-menu-item) is seen
check('...Rename Tab… sits directly above Set Default Tab Name for Project…, no separator between', at('Rename Tab…') >= 0 && choose(items, 'Rename Tab').nextElementSibling === choose(items, 'Set Default Tab Name'), labels(items));
closeMenu();
// a plain shell in a project folder reads "Terminal": the tab's name isn't the project's
items = openMenu('shellproj');
check('a shell tab in a project folder (not named for it) has "Rename Tab…"', labels(items).includes('Rename Tab…'), labels(items));
check('...and keeps "Set Default Tab Name for Project…", right below it', labels(items).includes('Set Default Tab Name for Project…') && choose(items, 'Rename Tab').nextElementSibling === choose(items, 'Set Default Tab Name'), labels(items));
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

// 14 Nov: tabs grow to share the strip with the label centred, so the title span no longer
// reaches the tab's ends; a double-click anywhere on the tab renames it, except on its own controls.
fire(tabEl('third'), 'dblclick');
check('a double-click on the tab itself (its blank part) opens the box in that tab', boxes().length === 1 && tabEl('third').contains(boxes()[0]) && boxes()[0].value === 'third', boxes().length);
fire(tabEl('third'), 'dblclick');
check('...a second double-click on that tab opens no second box', boxes().length === 1, boxes().length);
fire(boxes()[0], 'dblclick');
check('...nor does one in the box itself', boxes().length === 1, boxes().length);
reset();
fire(tabEl('third').querySelector('.tab-bar-tab-close'), 'dblclick');
fire(tabEl('third').querySelector('.tab-bar-tab-grip'), 'dblclick');
check('a double-click on the close button or the grip opens no box', !!tabEl('third').querySelector('.tab-bar-tab-close') && !!tabEl('third').querySelector('.tab-bar-tab-grip') && boxes().length === 0, boxes().length);
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

// a project's tab renames as a one-off through the same box: its full name, the automatic one as placeholder
items = openMenu('proj');
choose(items, 'Rename Tab').click();
box = boxes()[0];
check('a project tab: Rename Tab… opens the box on it, holding its name, the automatic name as placeholder', !!box && tabEl('proj').contains(box) && box.value === 'patton' && box.placeholder === 'patton' && box.getAttribute('aria-label') === 'Rename tab', box && [box.value, box.placeholder]);
box.value = 'fixing the login bug';
key(box, 'Enter');
check('...Enter calls onRename (a one-off), not onRenameProject', renames.length === 1 && renames[0][0] === 'proj' && renames[0][1] === 'fixing the login bug' && projectRenames.length === 0, { renames, projectRenames });
reset();
bar.update(tabs);

// the project's own entry still works
items = openMenu('proj');
choose(items, 'Set Default Tab Name for Project').click();
box = boxes()[0];
box.value = 'renamed';
key(box, 'Enter');
check('a project\'s "Set Default Tab Name" still calls onRenameProject', projectRenames.length === 1 && projectRenames[0][0] === 'proj' && projectRenames[0][1] === 'renamed' && renames.length === 0, { projectRenames, renames });


// ── The real TabManager: what a one-off name does to a project tab ──
// A project tab (Claude runs in /proj/alpha) and a second tab in the same project.
const root = (st) => `\x1b]7501;state=${st}:app=claude-code\x07`;
const tm0 = await setUpTabManager({ tags: ['TAB'] });
const { doc: mdoc, w: mw, emit } = tm0;
const PROJ = {
  '/proj/alpha': { root: '/proj/alpha', defaultName: 'alpha' },
  '/proj/alpha-feat-x': { root: '/proj/alpha', defaultName: 'alpha', worktree: { name: 'alpha-feat-x', path: '/proj/alpha-feat-x' } },
};
const projectsNow = {}; // root -> name, as main's store
let namesCb = null;
const baseApi = mw.patton;
mw.patton = new Proxy(baseApi, {
  get: (t, p) => {
    if (p === 'projects') {
      return {
        getNames: async () => ({ ...projectsNow }),
        onNamesChanged: (cb) => { namesCb = cb; return () => {}; },
        resolve: async (cwd) => PROJ[cwd] ?? null,
        // Main's store: an empty name deletes, then it broadcasts to every window.
        setName: async (key, name) => { if (name) projectsNow[key] = name; else delete projectsNow[key]; namesCb?.({ ...projectsNow }); },
      };
    }
    return t[p];
  },
});
const tm = await tm0.makeWindow([]);
const mk = async (cwd = '/proj/alpha') => {
  const tab = await tm.createTab(cwd, { forProject: true });
  await until(() => tab.menuProject !== null);
  emit(tab.focusedPane.ptyId, root('done'));
  await until(() => tab.focusedPane.isClaudePane);
  return tab;
};
const tA = await mk();
const tB = await mk();
const mEl = (tab) => tm.bar.querySelector(`.tab-bar-tab[data-tab-id="${tab.id}"]`);
const shown = (tab) => mEl(tab)?.querySelector('.tab-bar-tab-title')?.textContent;
const mfire = (el, type, init = {}) => el.dispatchEvent(new mw.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
const mkey = (el, k) => el.dispatchEvent(new mw.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const mItems = () => [...mdoc.querySelectorAll('.context-menu-overlay.visible .context-menu-item')];
const mLabel = (i) => (i.querySelector('span')?.textContent ?? i.textContent).trim();
const mClose = () => { for (const o of mdoc.querySelectorAll('.context-menu-overlay.visible')) mkey(o, 'Escape'); };
const mPick = (tab, label) => {
  mfire(mEl(tab), 'contextmenu', { clientX: 20, clientY: 20 });
  const item = mItems().find((i) => mLabel(i) === label);
  item?.click();
  return !!item;
};
const mBox = () => tm.bar.querySelector('.tab-bar-tab-rename');
const typeIn = async (value) => { const b = mBox(); b.value = value; mkey(b, 'Enter'); await tick(5); };
const sessionOf = (tab) => {
  const s = tm.listSessions().find((x) => x.tabId === tab.id);
  return s;
};
check('set-up: two Claude tabs named for the project, both reading "alpha"', tA.namedForProject && tB.namedForProject && tA.title === 'alpha' && tB.title === 'alpha' && shown(tA) === 'alpha', { a: tA.title, b: tB.title, shown: shown(tA) });

mfire(mEl(tA), 'contextmenu', { clientX: 20, clientY: 20 });
const projLabels = mItems().map(mLabel);
const renameItem = mItems().find((i) => mLabel(i) === 'Rename Tab…');
const defaultItem = mItems().find((i) => mLabel(i) === 'Set Default Tab Name for Project…');
mClose();
check('real manager, a project tab\'s menu: Rename Tab… directly above Set Default Tab Name for Project…, no separator between', !!renameItem && renameItem.nextElementSibling === defaultItem, projLabels);

// one-off name: wins everywhere while set
mPick(tA, 'Rename Tab…');
check('the one-off box opens on the project tab with the project name in it', mBox()?.value === 'alpha' && mBox()?.placeholder === 'alpha', mBox() && [mBox().value, mBox().placeholder]);
await typeIn('fixing the login bug');
check('a one-off name wins on the strip', shown(tA) === 'fixing the login bug' && tA.title === 'fixing the login bug' && tA.hasCustomTitle && !tA.namedForProject, { shown: shown(tA), title: tA.title });
{
  const sa = sessionOf(tA);
  const sb = sessionOf(tB);
  const { sessionName } = tm0.sessions;
  check('...and in the palette\'s name for the session', sa && sessionName(sa) === 'fixing the login bug' && sb && sessionName(sb) === 'alpha', { a: sa && sessionName(sa), b: sb && sessionName(sb) });
}
check('...and only on that tab: the other tab of the project still reads "alpha"', shown(tB) === 'alpha' && tB.title === 'alpha' && tB.namedForProject, shown(tB));
mfire(mEl(tA), 'contextmenu', { clientX: 20, clientY: 20 });
const afterLabels = mItems().map(mLabel);
mClose();
check('a tab with a one-off name still offers both Rename Tab… and Set Default Tab Name for Project…, in order', afterLabels.indexOf('Rename Tab…') >= 0 && afterLabels.indexOf('Set Default Tab Name for Project…') === afterLabels.indexOf('Rename Tab…') + 1, afterLabels);

// a later project-default rename leaves the one-off alone and changes the others
mPick(tA, 'Set Default Tab Name for Project…');
check('Set Default opens the project box (the project\'s name, not the one-off)', mBox()?.value === 'alpha' && mBox()?.getAttribute('aria-label') === 'Default tab name for this project', mBox() && [mBox().value, mBox().getAttribute('aria-label')]);
await typeIn('Atlas');
await until(() => tB.title === 'Atlas');
check('a project-default rename changes the project\'s other tab...', tB.title === 'Atlas' && shown(tB) === 'Atlas', { title: tB.title, shown: shown(tB) });
check('...and does not overwrite the tab\'s one-off name', tA.title === 'fixing the login bug' && shown(tA) === 'fixing the login bug' && tA.hasCustomTitle, { title: tA.title, shown: shown(tA) });

// clearing the one-off name brings the automatic name back: the project's name (its default, once set)
mPick(tA, 'Rename Tab…');
check('reopening the box on the one-off tab: it holds the one-off name, the project\'s name is the placeholder', mBox()?.value === 'fixing the login bug' && mBox()?.placeholder === 'Atlas', mBox() && [mBox().value, mBox().placeholder]);
await typeIn('');
check('an emptied box clears the one-off: the tab reads the project\'s name again', tA.title === 'Atlas' && shown(tA) === 'Atlas' && !tA.hasCustomTitle && tA.namedForProject, { title: tA.title, shown: shown(tA), custom: tA.hasCustomTitle });
check('...and the palette\'s name is the project\'s', sessionOf(tA) && tm0.sessions.sessionName(sessionOf(tA)) === 'Atlas', sessionOf(tA) && tm0.sessions.sessionName(sessionOf(tA)));
mPick(tA, 'Rename Tab…');
await typeIn('second one-off');
check('a new one-off after clearing works', tA.title === 'second one-off' && tA.hasCustomTitle, tA.title);
mPick(tA, 'Rename Tab…');
await typeIn('   ');
check('a whitespace-only box clears it as well', tA.title === 'Atlas' && !tA.hasCustomTitle && tA.namedForProject && shown(tA) === 'Atlas', { title: tA.title, custom: tA.hasCustomTitle });
// an unchanged Enter on an unnamed project tab must not turn the project's name into a one-off
mPick(tA, 'Rename Tab…');
await typeIn('Atlas');
check('Enter with the project\'s name untouched makes no one-off name', !tA.hasCustomTitle && tA.namedForProject, tA.hasCustomTitle);
// clear the default too: back to the automatic project name
mPick(tB, 'Set Default Tab Name for Project…');
await typeIn('');
await until(() => tA.title === 'alpha');
check('clearing the project default puts "alpha" back on every tab without a one-off', tA.title === 'alpha' && tB.title === 'alpha', { a: tA.title, b: tB.title });

// ── A linked-worktree tab: the strip says "feat-x", the box the long form ──
const tW = await mk('/proj/alpha-feat-x');
check('worktree set-up: the strip reads the short name, the full title carries the project', shown(tW) === 'feat-x' && tW.title === 'alpha ⎇ alpha-feat-x' && !tW.hasCustomTitle, { shown: shown(tW), title: tW.title });
mPick(tW, 'Rename Tab…');
check('worktree: the box holds the full "alpha ⎇ alpha-feat-x", not the short strip name', mBox()?.value === 'alpha ⎇ alpha-feat-x' && mBox()?.placeholder === 'alpha ⎇ alpha-feat-x', mBox() && [mBox().value, mBox().placeholder]);
await typeIn(mBox().value);
check('worktree: Enter with the box unchanged freezes no one-off name', !tW.hasCustomTitle && shown(tW) === 'feat-x', { custom: tW.hasCustomTitle, shown: shown(tW) });
mPick(tW, 'Rename Tab…');
await typeIn('login spike');
check('worktree: a typed name wins on the strip and as the title', tW.hasCustomTitle && tW.title === 'login spike' && shown(tW) === 'login spike', { title: tW.title, shown: shown(tW) });
mPick(tW, 'Rename Tab…');
await typeIn('');
check('worktree: clearing returns the strip to "feat-x"', !tW.hasCustomTitle && tW.title === 'alpha ⎇ alpha-feat-x' && shown(tW) === 'feat-x', { title: tW.title, shown: shown(tW), custom: tW.hasCustomTitle });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
