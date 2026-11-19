// Check of the tab-group chip on the tab strip (S55, 19 Nov 2026, the approved
// sketch's look A, "ink"). Drives the REAL TabBar in jsdom, fed tabs and groups
// through update(tabs, groups), with recording callbacks: the chip's place and
// look, the folded chip (members gone, count, ONE indicator by rank), click /
// drag / double-click, the keyboard (Enter, Space, menu key, Shift+F10, arrows),
// aria, the tab menu's group entries and the chip menu, the name box, the list
// under a folded chip, and a tab dropped on a chip.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-tab-groups-strip.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dom = new JSDOM('<!doctype html><div id="bar"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const doc = w.document;
let zooms = 0;
let windowMoves = 0;
w.patton = { titleBarDoubleClick: () => { zooms++; }, moveWindowBy: () => { windowMoves++; }, onUiTextScale: () => () => {} };
w.Element.prototype.scrollIntoView = () => {};
w.eval(bundle.outputFiles[0].text);

// --- recording callbacks ---
const calls = [];
const rec = (name) => (...args) => { calls.push([name, ...args]); };
const callsOf = (name) => calls.filter((c) => c[0] === name);
const clear = () => { calls.length = 0; };
const noop = () => {};
const bar = new w.TB.TabBar(doc.getElementById('bar'), {
  onSelect: rec('select'), onClose: noop, onNew: noop, onReorder: rec('reorder'), onSettings: noop,
  onCheckpoint: noop, onSetFlag: noop, onRename: noop, onRenameProject: noop,
  onNewGroup: (tabId) => {
    calls.push(['newGroup', tabId]);
    // As TabManager does: make the group, redraw the strip, return its id.
    const groups = [...state.groups, { id: 'gnew', name: '', folded: false }];
    const tabs = state.tabs.map((t) => (t.id === tabId ? { ...t, groupId: 'gnew' } : t));
    bar.update(tabs, groups);
    return 'gnew';
  },
  onAddToGroup: rec('addToGroup'),
  onRemoveFromGroup: rec('removeFromGroup'),
  onRenameGroup: rec('renameGroup'),
  onToggleGroup: rec('toggleGroup'),
  onNewTabInGroup: rec('newTabInGroup'),
  onUngroup: rec('ungroup'),
  onCloseGroup: rec('closeGroup'),
});

// --- the strip: a | [Games] g1a g1b | b | [unnamed] g2a g2b g2c ---
const baseTabs = () => [
  { id: 'a', title: 'alpha', active: true },
  { id: 'g1a', title: 'chess', active: false, groupId: 'g1' },
  { id: 'g1b', title: 'go', active: false, groupId: 'g1' },
  { id: 'b', title: 'bravo', active: false },
  { id: 'g2a', title: 'one', active: false, groupId: 'g2' },
  { id: 'g2b', title: 'two', active: false, groupId: 'g2' },
  { id: 'g2c', title: 'three', active: false, groupId: 'g2' },
];
const baseGroups = () => [
  { id: 'g1', name: 'Games', folded: false },
  { id: 'g2', name: '', folded: false },
];
const state = { tabs: baseTabs(), groups: baseGroups() };
const draw = (tabs = baseTabs(), groups = baseGroups()) => {
  state.tabs = tabs;
  state.groups = groups;
  bar.update(tabs, groups);
};
const fold = (groupId, tabs = baseTabs()) => draw(tabs, baseGroups().map((g) => (g.id === groupId ? { ...g, folded: true } : g)));

const strip = () => doc.querySelector('.tab-bar-tabs');
const tabEl = (id) => doc.querySelector(`.tab-bar-tab[data-tab-id="${id}"]`);
const chip = (id) => doc.querySelector(`.tab-bar-group-chip[data-group-id="${id}"]`);
const fire = (el, type, init = {}) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
const key = (el, k, init = {}) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const menuItems = () => [...doc.querySelectorAll('.context-menu-item')];
const labels = (items) => items.map((i) => i.textContent.trim());
const closeMenu = () => { for (const o of doc.querySelectorAll('.context-menu-overlay')) key(o, 'Escape'); };
const openTabMenu = (id) => { closeMenu(); fire(tabEl(id), 'contextmenu', { clientX: 20, clientY: 20 }); return menuItems(); };
const openChipMenu = (id) => { closeMenu(); fire(chip(id), 'contextmenu', { clientX: 20, clientY: 20 }); return menuItems(); };
const choose = (items, label) => items.find((i) => i.textContent.trim() === label);
const nameBox = () => doc.querySelector('.tab-bar-group-chip .tab-bar-tab-rename');
const list = () => doc.querySelector('.tab-bar-group-list');
const click = (el) => { fire(el, 'mousedown', { screenX: 50, screenY: 50 }); fire(doc, 'mouseup', { screenX: 50, screenY: 50 }); fire(el, 'click'); };

// Each section runs on its own: one that throws (on code without groups, say)
// counts its checks not yet run as failed, from the count it should reach.
const section = async (title, expected, fn) => {
  const before = passed + failed;
  try { await fn(); } catch (e) {
    const missing = Math.max(1, expected - (passed + failed - before));
    failed += missing;
    console.log('FAIL', `${title}: threw (${String(e).split('\n')[0]}); ${missing} checks not run counted as failed`);
  }
  closeMenu();
};
let items;
let ls;
let box;
let l;
const after = (arr, label) => arr.slice(arr.indexOf(label) + 1);
const withStates = (s1, s2) => baseTabs().map((t) => (t.id === 'g1a' ? { ...t, ...s1 } : t.id === 'g1b' ? { ...t, ...s2 } : t));
const indicators = () => [...chip('g1').querySelectorAll('.tab-bar-tab-indicator')];
const S = {
  checkpoint: { checkpointDone: true },
  needs: { awaitingInput: true },
  flagRed: { flag: 'red' },
  autoYellow: { autoFlag: 'yellow' },
  parked: { parked: { tasks: 1, crons: 0 } },
};
const isCheckpoint = (el) => el.classList.contains('checkpoint-done');
const isNeeds = (el) => el.className === 'tab-bar-tab-indicator';
const isParked = (el) => el.classList.contains('parked');
const pairs = [
  ['checkpoint beats needs-you', S.checkpoint, S.needs, isCheckpoint],
  ['needs-you beats a flag', S.needs, S.flagRed, isNeeds],
  ['a flag beats parked (in its colour)', S.flagRed, S.parked, (el) => el.classList.contains('flag-red')],
  ['an auto flag beats parked (in its colour)', S.autoYellow, S.parked, (el) => el.classList.contains('flag-yellow')],
  ['checkpoint beats parked', S.checkpoint, S.parked, isCheckpoint],
];

// ============ 1. Placement and look ============
await section('1. Placement and look', 12, async () => {
  draw();
  const kids = [...strip().children];
  const order = kids.map((el) => (el.classList.contains('tab-bar-group-chip') ? `[${el.dataset.groupId}]` : el.dataset.tabId));
  check('each chip sits immediately left of its group\'s first tab, one chip per group',
    JSON.stringify(order) === JSON.stringify(['a', '[g1]', 'g1a', 'g1b', 'b', '[g2]', 'g2a', 'g2b', 'g2c']), order);
  check('the named chip reads its name, in the ink name span (not "unnamed")',
    chip('g1').querySelector('.tab-bar-group-name')?.textContent === 'Games'
    && !chip('g1').querySelector('.tab-bar-group-name').classList.contains('unnamed'), chip('g1').textContent);
  check('an unnamed chip reads "3 tabs", its name span marked unnamed (muted)',
    chip('g2').querySelector('.tab-bar-group-name')?.textContent === '3 tabs'
    && chip('g2').querySelector('.tab-bar-group-name').classList.contains('unnamed'), chip('g2').textContent);
  check('an open chip\'s chevron is ▾ and it has no count and no indicator',
    chip('g1').querySelector('.tab-bar-group-chevron')?.textContent === '▾'
    && !chip('g1').querySelector('.tab-bar-group-count') && !chip('g1').querySelector('.tab-bar-tab-indicator'));
  check('member tabs carry the in-group class (the top line); others don\'t',
    ['g1a', 'g1b', 'g2a', 'g2b', 'g2c'].every((id) => tabEl(id).classList.contains('in-group'))
    && !tabEl('a').classList.contains('in-group') && !tabEl('b').classList.contains('in-group'));
  check('a chip is role=button, out of the Tab order (tabindex -1), never aria-selected',
    chip('g1').getAttribute('role') === 'button' && chip('g1').getAttribute('tabindex') === '-1' && !chip('g1').hasAttribute('aria-selected'));
  check('an open chip: aria-expanded true, label "Games group, 2 tabs, open"',
    chip('g1').getAttribute('aria-expanded') === 'true' && chip('g1').getAttribute('aria-label') === 'Games group, 2 tabs, open', chip('g1').getAttribute('aria-label'));
  check('member tabs add ", in Games group" / ", in unnamed group" to their aria-label',
    /, in Games group$/.test(tabEl('g1a').getAttribute('aria-label')) && /, in unnamed group$/.test(tabEl('g2b').getAttribute('aria-label'))
    && !/ group$/.test(tabEl('a').getAttribute('aria-label')), [tabEl('g1a').getAttribute('aria-label'), tabEl('g2b').getAttribute('aria-label')]);

  // The ink look, from the stylesheet (jsdom draws nothing, so the rules are read as text).
  const css = readFileSync(join(repo, 'src/renderer/styles/tabs.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => {
    const re = new RegExp(`(^|[},])\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
    return (css.match(re) || [])[2] || '';
  };
  const chipRule = rule('.tab-bar-group-chip');
  check('chip CSS: --grey ground, --ink text, bold, 10.5px x scale, uppercase, 0.06em, 2px ink top line',
    /background:\s*var\(--grey\)/.test(chipRule) && /(^|;)\s*color:\s*var\(--ink\)/.test(chipRule) && /font-weight:\s*(700|bold)/.test(chipRule)
    && /font-size:\s*calc\(10\.5px \* var\(--ui-scale\)\)/.test(chipRule) && /text-transform:\s*uppercase/.test(chipRule)
    && /letter-spacing:\s*0\.06em/.test(chipRule) && /inset 0 2px 0 var\(--ink\)/.test(chipRule) && /flex:\s*0 0 auto/.test(chipRule), chipRule);
  check('chip CSS: hover a darker grey; the name caps at 140px x scale with an ellipsis; unnamed in --muted',
    /background:\s*var\(--grey-hover\)/.test(rule('.tab-bar-group-chip:hover'))
    && /max-width:\s*calc\(140px \* var\(--ui-scale\)\)/.test(rule('.tab-bar-group-name')) && /text-overflow:\s*ellipsis/.test(rule('.tab-bar-group-name'))
    && /color:\s*var\(--muted\)/.test(rule('.tab-bar-group-name.unnamed')));
  check('member tab CSS: a 2px ink top line; the selected one keeps its 3px bottom bar too',
    /inset 0 2px 0 var\(--ink\)/.test(rule('.tab-bar-tab.in-group'))
    && /inset 0 2px 0 var\(--ink\)/.test(rule('.tab-bar-tab.in-group.active')) && /inset 0 -3px 0 var\(--ink\)/.test(rule('.tab-bar-tab.in-group.active')));
  const mainCss = readFileSync(join(repo, 'src/renderer/styles/main.css'), 'utf8');
  check('main.css defines --grey-hover in both light and dark', (mainCss.match(/--grey-hover:/g) || []).length >= 2);
});

// ============ 2. Folded ============
await section('2. Folded', 20, async () => {
  fold('g1');
  check('folded: the group\'s tabs leave the strip, the others stay',
    !tabEl('g1a') && !tabEl('g1b') && !!tabEl('a') && !!tabEl('b') && !!tabEl('g2a'));
  check('folded: the chip is still there, between a and b', chip('g1')?.previousElementSibling === tabEl('a') && chip('g1')?.nextElementSibling === tabEl('b'));
  check('folded: chevron ▸, class folded, aria-expanded false',
    chip('g1').querySelector('.tab-bar-group-chevron')?.textContent === '▸' && chip('g1').classList.contains('folded')
    && chip('g1').getAttribute('aria-expanded') === 'false');
  check('folded: the name and the tab count (2) are shown', chip('g1').querySelector('.tab-bar-group-name')?.textContent === 'Games'
    && chip('g1').querySelector('.tab-bar-group-count')?.textContent === '2', chip('g1').textContent);
  check('folded, no states: no indicator', chip('g1').querySelectorAll('.tab-bar-tab-indicator').length === 0);
  fold('g2');
  check('folded unnamed chip still reads "3 tabs"', chip('g2').querySelector('.tab-bar-group-name')?.textContent === '3 tabs', chip('g2').textContent);

  // One indicator, the strongest, for each adjacent rank pair (both orders).
  for (const [name, s1, s2, want] of pairs) {
    for (const [x, y, dir] of [[s1, s2, 'first'], [s2, s1, 'second']]) {
      fold('g1', withStates(x, y));
      const ind = indicators();
      check(`folded indicator: ${name} (stronger tab ${dir})`, ind.length === 1 && want(ind[0]), ind.map((i) => i.className));
    }
  }
  fold('g1', withStates({ flag: 'green', autoFlag: 'yellow' }, {}));
  check('folded indicator: a manual flag beats the same tab\'s auto flag', indicators().length === 1 && indicators()[0].classList.contains('flag-green'), indicators().map((i) => i.className));
  fold('g1', withStates({ parked: { tasks: 2, crons: 0 } }, {}));
  check('folded indicator: parked alone shows the parked ring', indicators().length === 1 && isParked(indicators()[0]));
  // The aria-label counts each state.
  fold('g1', withStates(S.checkpoint, S.needs));
  check('folded chip aria-label counts each state: "Games group, 2 tabs, folded, 1 checkpoint finished, 1 waiting for you"',
    chip('g1').getAttribute('aria-label') === 'Games group, 2 tabs, folded, 1 checkpoint finished, 1 waiting for you', chip('g1').getAttribute('aria-label'));
  fold('g1', withStates(S.flagRed, S.flagRed));
  check('...and two flagged tabs read "2 flagged red"', chip('g1').getAttribute('aria-label') === 'Games group, 2 tabs, folded, 2 flagged red', chip('g1').getAttribute('aria-label'));
});

// ============ 3. Click, drag, double-click ============
await section('3. Click, drag, double-click', 5, async () => {
  draw();
  clear();
  click(chip('g1'));
  check('a click (press without drag) on the chip fires the fold callback once, for that group, as a click',
    callsOf('toggleGroup').length === 1 && callsOf('toggleGroup')[0][1] === 'g1' && callsOf('toggleGroup')[0][2] === 'click', calls);
  check('...and selects no tab', callsOf('select').length === 0, calls);
  clear();
  windowMoves = 0;
  fire(chip('g1'), 'mousedown', { screenX: 100, screenY: 100 });
  fire(doc, 'mousemove', { screenX: 120, screenY: 104 });
  fire(doc, 'mousemove', { screenX: 140, screenY: 110 });
  fire(doc, 'mouseup', { screenX: 140, screenY: 110 });
  check('a press-and-drag on the chip moves the window and does not fold', callsOf('toggleGroup').length === 0 && windowMoves > 0, { calls, windowMoves });
  clear();
  zooms = 0;
  click(chip('g1'));
  click(chip('g1'));
  fire(chip('g1'), 'dblclick');
  fire(chip('g1').querySelector('.tab-bar-group-name'), 'dblclick');
  check('a double-click on the chip (or its name) does not zoom the window', zooms === 0, zooms);
  fire(chip('g1'), 'contextmenu', { button: 2, clientX: 5, clientY: 5 });
  fire(chip('g1'), 'mousedown', { button: 2, screenX: 5, screenY: 5 });
  fire(doc, 'mouseup', { button: 2, screenX: 5, screenY: 5 });
  check('a right press does not fold', callsOf('toggleGroup').length === 2, callsOf('toggleGroup').length);
  closeMenu();
});

// ============ 4. Keyboard on the chip ============
await section('4. Keyboard on the chip', 5, async () => {
  draw();
  clear();
  chip('g1').focus();
  key(chip('g1'), 'Enter');
  check('Enter on the chip folds/unfolds it', callsOf('toggleGroup').length === 1 && callsOf('toggleGroup')[0][1] === 'g1', calls);
  key(chip('g1'), ' ');
  check('Space on the chip folds/unfolds it', callsOf('toggleGroup').length === 2, calls);
  check('...and neither selects a tab', callsOf('select').length === 0, calls);
  closeMenu();
  key(chip('g1'), 'ContextMenu');
  check('the menu key opens the chip menu', labels(menuItems()).includes('Rename Group…'), labels(menuItems()));
  closeMenu();
  key(chip('g1'), 'F10', { shiftKey: true });
  check('Shift+F10 opens the chip menu', labels(menuItems()).includes('Rename Group…'), labels(menuItems()));
  closeMenu();
});

// ============ 5. Arrow keys across tabs and chips ============
await section('5. Arrow keys across tabs and chips', 6, async () => {
  draw();
  clear();
  tabEl('a').focus();
  key(tabEl('a'), 'ArrowRight');
  check('ArrowRight from a tab lands focus on the chip next to it, selecting nothing', doc.activeElement === chip('g1') && callsOf('select').length === 0, { active: doc.activeElement?.className, calls });
  key(chip('g1'), 'ArrowRight');
  check('ArrowRight from the chip selects its first tab', callsOf('select').length === 1 && callsOf('select')[0][1] === 'g1a', calls);
  clear();
  chip('g1').focus();
  key(chip('g1'), 'ArrowLeft');
  check('ArrowLeft from the chip selects the tab before it', callsOf('select').length === 1 && callsOf('select')[0][1] === 'a', calls);
  clear();
  tabEl('b').focus();
  key(tabEl('b'), 'ArrowRight');
  check('ArrowRight from b reaches the unnamed chip', doc.activeElement === chip('g2'), doc.activeElement?.className);
  fold('g1');
  clear();
  tabEl('a').focus();
  key(tabEl('a'), 'ArrowRight');
  key(chip('g1'), 'ArrowRight');
  check('folded: arrows go a → chip → b (the folded tabs are skipped)', callsOf('select').length === 1 && callsOf('select')[0][1] === 'b', calls);
  clear();
  // A rebuild while the chip has focus gives it focus back.
  draw();
  chip('g1').focus();
  draw();
  check('a rebuild while the chip has focus gives the new chip the focus', doc.activeElement === chip('g1'), doc.activeElement?.className);
});

// ============ 6. Tab menu: group entries ============
await section('6. Tab menu: group entries', 13, async () => {
  draw();
  items = openTabMenu('a');
  ls = labels(items);
  check('ungrouped tab: after Move Left/Right come Add Tab to New Group, Add to Games, Add to Unnamed Group; no Remove',
    ls.indexOf('Add Tab to New Group') > ls.indexOf('Move Right') && ls.indexOf('Move Right') > ls.indexOf('Move Left')
    && JSON.stringify(after(ls, 'Move Right').slice(0, 3)) === JSON.stringify(['Add Tab to New Group', 'Add to Games', 'Add to Unnamed Group'])
    && !ls.includes('Remove from Group'), ls);
  items = openTabMenu('g1a');
  ls = labels(items);
  check('a Games tab: Add Tab to New Group, Add to Unnamed Group (not its own group), Remove from Group',
    JSON.stringify(after(ls, 'Move Right').slice(0, 3)) === JSON.stringify(['Add Tab to New Group', 'Add to Unnamed Group', 'Remove from Group'])
    && !ls.includes('Add to Games'), ls);
  items = openTabMenu('g2a');
  ls = labels(items);
  check('an unnamed-group tab: Add to Games, Remove from Group; no Add to Unnamed Group',
    ls.includes('Add to Games') && ls.includes('Remove from Group') && !ls.includes('Add to Unnamed Group'), ls);
  clear();
  choose(openTabMenu('a'), 'Add to Games').click();
  check('"Add to Games" calls onAddToGroup(tab, g1)', JSON.stringify(calls) === JSON.stringify([['addToGroup', 'a', 'g1']]), calls);
  clear();
  choose(openTabMenu('b'), 'Add to Unnamed Group').click();
  check('"Add to Unnamed Group" calls onAddToGroup(tab, g2)', JSON.stringify(calls) === JSON.stringify([['addToGroup', 'b', 'g2']]), calls);
  clear();
  choose(openTabMenu('g1b'), 'Remove from Group').click();
  check('"Remove from Group" calls onRemoveFromGroup(tab)', JSON.stringify(calls) === JSON.stringify([['removeFromGroup', 'g1b']]), calls);
  clear();
  choose(openTabMenu('b'), 'Add Tab to New Group').click();
  box = nameBox();
  check('"Add Tab to New Group" calls onNewGroup(tab) and opens the name box on the new chip at once',
    callsOf('newGroup').length === 1 && callsOf('newGroup')[0][1] === 'b' && !!box && chip('gnew')?.contains(box) && doc.activeElement === box,
    { calls, box: !!box });
  check('...the box is empty, maxlength 60, labelled "Group name"', box && box.value === '' && box.maxLength === 60 && box.getAttribute('aria-label') === 'Group name', box && [box.value, box.maxLength]);
  box.value = '  Work stuff  ';
  key(box, 'Enter');
  check('...Enter commits the trimmed name: onRenameGroup(gnew, "Work stuff")', JSON.stringify(callsOf('renameGroup')) === JSON.stringify([['renameGroup', 'gnew', 'Work stuff']]), calls);
  check('...and the box is gone', !nameBox());
  clear();
  draw();
  choose(openTabMenu('b'), 'Add Tab to New Group').click();
  key(nameBox(), 'Escape');
  check('new group, Escape: no rename (it stays unnamed), the box gone', callsOf('renameGroup').length === 0 && !nameBox(), calls);
  clear();
  draw();
  choose(openTabMenu('b'), 'Add Tab to New Group').click();
  nameBox().value = 'Blurred';
  nameBox().blur();
  check('new group, blur commits the name', JSON.stringify(callsOf('renameGroup')) === JSON.stringify([['renameGroup', 'gnew', 'Blurred']]), calls);
  clear();
  draw();
  choose(openTabMenu('b'), 'Add Tab to New Group').click();
  nameBox().value = '   ';
  key(nameBox(), 'Enter');
  check('new group, a blank name commits nothing (stays unnamed)', callsOf('renameGroup').length === 0, calls);
  clear();
});

// ============ 7. Chip menu ============
await section('7. Chip menu', 9, async () => {
  draw();
  items = openChipMenu('g1');
  check('open chip menu: Rename Group…, Fold Group, New Tab in Group, Ungroup, Close Group…',
    JSON.stringify(labels(items)) === JSON.stringify(['Rename Group…', 'Fold Group', 'New Tab in Group', 'Ungroup', 'Close Group…']), labels(items));
  check('...with a separator between New Tab in Group and Ungroup', !!doc.querySelector('.context-menu-separator, [role="separator"]'));
  closeMenu();
  fold('g1');
  items = openChipMenu('g1');
  check('folded chip menu reads "Unfold Group"', labels(items)[1] === 'Unfold Group', labels(items));
  clear();
  choose(items, 'Unfold Group').click();
  check('"Unfold Group" calls onToggleGroup(g1, "menu")', JSON.stringify(calls) === JSON.stringify([['toggleGroup', 'g1', 'menu']]), calls);
  draw();
  for (const [label, name] of [['Fold Group', 'toggleGroup'], ['New Tab in Group', 'newTabInGroup'], ['Ungroup', 'ungroup'], ['Close Group…', 'closeGroup']]) {
    clear();
    choose(openChipMenu('g2'), label).click();
    check(`"${label}" calls ${name}(g2)`, calls.length === 1 && calls[0][0] === name && calls[0][1] === 'g2', calls);
  }
  // A rebuild while the chip menu is open: the Fold/Unfold entry acts on the group as it is.
  clear();
  items = openChipMenu('g1');
  fold('g1');
  choose(items, 'Fold Group').click();
  check('a chip menu opened before a rebuild still calls back for its group', callsOf('toggleGroup').length === 1 && callsOf('toggleGroup')[0][1] === 'g1', calls);
  closeMenu();
});

// ============ 8. Rename Group… ============
await section('8. Rename Group…', 10, async () => {
  draw();
  clear();
  choose(openChipMenu('g1'), 'Rename Group…').click();
  box = nameBox();
  check('Rename Group… opens the box on the chip, holding the name, maxlength 60, focused',
    !!box && chip('g1').contains(box) && box.value === 'Games' && box.maxLength === 60 && doc.activeElement === box, box && box.value);
  box.value = '  Board games ';
  key(box, 'Enter');
  check('Enter commits the trimmed name', JSON.stringify(calls) === JSON.stringify([['renameGroup', 'g1', 'Board games']]), calls);
  check('...and focus goes back to the chip', doc.activeElement === chip('g1'), doc.activeElement?.className);
  clear();
  draw();
  choose(openChipMenu('g1'), 'Rename Group…').click();
  nameBox().value = 'abandoned';
  key(nameBox(), 'Escape');
  check('Escape leaves the name unchanged (no call), the box gone, the name back', calls.length === 0 && !nameBox()
    && chip('g1').querySelector('.tab-bar-group-name')?.textContent === 'Games', calls);
  clear();
  draw();
  choose(openChipMenu('g1'), 'Rename Group…').click();
  nameBox().value = 'Via blur';
  nameBox().blur();
  check('blur commits', JSON.stringify(calls) === JSON.stringify([['renameGroup', 'g1', 'Via blur']]), calls);
  clear();
  draw();
  choose(openChipMenu('g1'), 'Rename Group…').click();
  nameBox().value = '';
  key(nameBox(), 'Enter');
  check('an emptied box commits "" (unnamed)', JSON.stringify(calls) === JSON.stringify([['renameGroup', 'g1', '']]), calls);
  clear();
  draw();
  choose(openChipMenu('g1'), 'Rename Group…').click();
  box = nameBox();
  box.value = 'typing';
  bar.update(withStates(S.needs, {}), baseGroups());
  check('an update arriving while the box is open does not destroy it', nameBox() === box && box.isConnected && box.value === 'typing' && doc.activeElement === box);
  key(box, 'Enter');
  check('...and Enter after it still commits, then the held update is drawn', JSON.stringify(calls) === JSON.stringify([['renameGroup', 'g1', 'typing']])
    && !!chip('g1'), calls);
  clear();
  draw();
  choose(openChipMenu('g1'), 'Rename Group…').click();
  nameBox().value = 'Clicked away';
  fire(chip('g1'), 'mousedown', { screenX: 50, screenY: 50 });
  nameBox()?.blur(); // the press moves focus off the box, as a browser does
  fire(doc, 'mouseup', { screenX: 50, screenY: 50 });
  check('a press on the chip beside an open box commits the name and does not fold', JSON.stringify(calls) === JSON.stringify([['renameGroup', 'g1', 'Clicked away']]), calls);
  clear();
  draw();
  // Double-click on the chip does not open a name box (it folds by clicks instead).
  fire(chip('g1').querySelector('.tab-bar-group-name'), 'dblclick');
  check('a double-click on the chip name opens no name box', !nameBox());
});

// ============ 9. The list under a folded chip ============
await section('9. The list under a folded chip', 12, async () => {
  fold('g1', withStates(S.checkpoint, {}));
  clear();
  fire(chip('g1'), 'mouseenter', { bubbles: false });
  l = list();
  check('hover on a folded chip shows the list', !!l);
  const rows = l ? [...l.querySelectorAll('.tab-bar-group-list-row')] : [];
  check('...a row per tab, in order, each with its title', rows.map((r) => r.querySelector('.tab-bar-group-list-title')?.textContent).join(',') === 'chess,go',
    rows.map((r) => r.textContent));
  check('...each with its own indicator (checkpoint on chess, none on go)', rows.length === 2
    && rows[0].querySelector('.tab-bar-tab-indicator.checkpoint-done') && !rows[1].querySelector('.tab-bar-tab-indicator'));
  fire(chip('g1'), 'mouseleave', { bubbles: false });
  await sleep(260);
  check('the list closes when the pointer leaves', !list());
  fire(chip('g1'), 'mouseenter', { bubbles: false });
  fire(chip('g1'), 'mouseleave', { bubbles: false });
  fire(list(), 'mouseenter', { bubbles: false });
  await sleep(260);
  check('...but stays while the pointer moves onto the list', !!list());
  fire(list(), 'mouseleave', { bubbles: false });
  await sleep(260);
  check('...and closes when it leaves the list', !list());
  fire(chip('g1'), 'mouseenter', { bubbles: false });
  clear();
  list().querySelectorAll('.tab-bar-group-list-row')[1].click();
  check('a row click calls select for that tab', JSON.stringify(calls) === JSON.stringify([['select', 'g1b']]), calls);
  check('...and the list closes', !list());
  draw();
  fire(chip('g1'), 'mouseenter', { bubbles: false });
  check('hover on an OPEN chip shows no list', !list());
  fire(chip('g1'), 'mouseleave', { bubbles: false });

  // Keyboard: arrowing onto a folded chip shows the list; leaving it hides it.
  fold('g1');
  tabEl('a').focus();
  key(tabEl('a'), 'ArrowRight');
  check('keyboard focus arriving on a folded chip shows the list', doc.activeElement === chip('g1') && !!list());
  tabEl('a').focus();
  await sleep(260);
  check('...and focus moving away hides it', !list());

  // A mouse click that folds a chip must not leave the list stuck open once the pointer has gone.
  draw();
  fire(chip('g1'), 'mouseenter', { bubbles: false });
  fire(chip('g1'), 'mousedown', { screenX: 50, screenY: 50 });
  chip('g1').focus(); // the press focuses it, as a browser does
  fire(doc, 'mouseup', { screenX: 50, screenY: 50 });
  fold('g1'); // TabManager folds the group and redraws
  fire(chip('g1'), 'mouseleave', { bubbles: false });
  await sleep(260);
  check('folded by a mouse click, the pointer then leaving: the list is not left open', !list(), { focused: doc.activeElement === chip('g1') });
});

// ============ 10. Drop on a chip ============
await section('10. Drop on a chip', 4, async () => {
  draw();
  clear();
  const grip = tabEl('a').querySelector('.tab-bar-tab-grip');
  const dt = { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k] ?? ''; }, effectAllowed: '', dropEffect: '', setDragImage() {} };
  const dragEv = (type) => { const e = new w.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'dataTransfer', { value: dt }); Object.defineProperty(e, 'clientX', { value: 10 }); Object.defineProperty(e, 'clientY', { value: 10 }); return e; };
  grip.dispatchEvent(dragEv('dragstart'));
  chip('g2').dispatchEvent(dragEv('dragover'));
  check('dragging a tab over a chip marks it as a drop target', chip('g2').classList.contains('drag-over'));
  chip('g2').dispatchEvent(dragEv('drop'));
  check('a tab dropped on a chip calls onAddToGroup(tab, group)', JSON.stringify(callsOf('addToGroup')) === JSON.stringify([['addToGroup', 'a', 'g2']]), calls);
  check('...and not onReorder', callsOf('reorder').length === 0, calls);
  grip.dispatchEvent(dragEv('dragend'));
  clear();
  const grip2 = tabEl('g2a').querySelector('.tab-bar-tab-grip');
  dt.data = {};
  grip2.dispatchEvent(dragEv('dragstart'));
  chip('g2').dispatchEvent(dragEv('dragover'));
  chip('g2').dispatchEvent(dragEv('drop'));
  grip2.dispatchEvent(dragEv('dragend'));
  check('a tab dropped on its own group\'s chip calls nothing', callsOf('addToGroup').length === 0, calls);
});

bar.dispose();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
