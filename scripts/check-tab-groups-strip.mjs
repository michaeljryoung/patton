// Check of the tab-group chip on the tab strip (S55, 19 Nov 2026, the approved
// sketch's look A, "ink"). Drives the REAL TabBar in jsdom, fed tabs and groups
// through update(tabs, groups), with recording callbacks: the chip's place and
// look, the folded chip (members gone, count, ONE indicator by rank), click /
// drag / double-click, the keyboard (Enter, Space, menu key, Shift+F10, arrows),
// aria, the tab menu's group entries and the chip menu, the name box, the list
// under a folded chip (kept inside the window), a tab dropped on a chip, the
// drop slots and their cue (24 Nov 2026: a line at the slot, in the joining
// group's colour, its chip marked; Michael's "drag a tab to the edge of the tab
// group, and it will include it"), and
// focus: a chip press keeps the terminal's, a folded tab's goes to its chip.
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
  stdin: { contents: `export { TabBar } from './src/renderer/components/tab-bar';
export { dropPlacement } from './src/renderer/services/tab-groups';`, resolveDir: repo, loader: 'ts' },
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
let windowDx = 0;
w.patton = { titleBarDoubleClick: () => { zooms++; }, moveWindowBy: (dx) => { windowMoves++; windowDx += dx; }, onUiTextScale: () => () => {} };
w.Element.prototype.scrollIntoView = () => {};
w.eval(bundle.outputFiles[0].text);

// --- recording callbacks ---
const calls = [];
let applyDrops = false;
const rec = (name) => (...args) => { calls.push([name, ...args]); };
const callsOf = (name) => calls.filter((c) => c[0] === name);
const clear = () => { calls.length = 0; };
const noop = () => {};
const bar = new w.TB.TabBar(doc.getElementById('bar'), {
  onSelect: rec('select'), onClose: noop, onNew: noop, onSettings: noop,
  onSetFlag: noop, onRename: noop, onRenameProject: noop,
  onNewGroup: (tabId) => {
    calls.push(['newGroup', tabId]);
    // As TabManager does: make the group, redraw the strip, return its id.
    const groups = [...state.groups, { id: 'gnew', name: '', folded: false }];
    const tabs = state.tabs.map((t) => (t.id === tabId ? { ...t, groupId: 'gnew' } : t));
    bar.update(tabs, groups);
    return 'gnew';
  },
  onAddToGroup: rec('addToGroup'),
  // As TabManager.dropTabs does, when a section turns it on: the same rule, then a redraw.
  onDropTabs: (ids, over) => {
    calls.push(['dropTabs', ids, over]);
    if (!applyDrops) return;
    const folded = new Set(state.groups.filter((g) => g.folded).map((g) => g.id));
    const moving = state.tabs.filter((t) => ids.includes(t.id));
    const o = over.kind === 'tab' ? { kind: 'tab', item: state.tabs.find((t) => t.id === over.id), half: over.half } : over;
    const p = w.TB.dropPlacement(state.tabs, moving, o, (t) => t.groupId ?? null, (g) => folded.has(g));
    if (!p || p.kind !== 'slot') return;
    draw(p.list.map((t) => (moving.includes(t) ? { ...t, groupId: p.group ?? undefined } : t)), state.groups);
  },
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
  check('chip CSS: its shade (--g-chip, --grey without one) as ground, --ink text, bold, 10.5px x scale, uppercase, 0.06em, a --group-line-w (6px) top line in its shade (--g-line, ink without one)',
    /background:\s*var\(--g-chip, var\(--grey\)\)/.test(chipRule) && /(^|;)\s*color:\s*var\(--ink\)/.test(chipRule) && /font-weight:\s*(700|bold)/.test(chipRule)
    && /font-size:\s*calc\(10\.5px \* var\(--ui-scale\)\)/.test(chipRule) && /text-transform:\s*uppercase/.test(chipRule)
    && /letter-spacing:\s*0\.06em/.test(chipRule) && /inset 0 var\(--group-line-w\) 0 var\(--g-line, var\(--ink\)\)/.test(chipRule) && /flex:\s*0 0 auto/.test(chipRule), chipRule);
  check('chip CSS: hover moves the shade toward its line (grey-hover without a shade); the name caps at 140px x scale with an ellipsis; unnamed in --muted',
    /color-mix\(in srgb, var\(--g-line\) 25%, var\(--g-chip/.test(rule('.tab-bar-group-chip:hover'))
    && /background:\s*var\(--grey-hover\)/.test(rule('.tab-bar-group-chip:not([class*="group-shade-"]):hover'))
    && /max-width:\s*calc\(140px \* var\(--ui-scale\)\)/.test(rule('.tab-bar-group-name')) && /text-overflow:\s*ellipsis/.test(rule('.tab-bar-group-name'))
    && /color:\s*var\(--chip-muted\)/.test(rule('.tab-bar-group-name.unnamed')) && /--chip-muted:\s*color-mix\(in srgb, var\(--ink\) 50%, var\(--muted\)\)/.test(chipRule));
  check('member tab CSS: its shade as ground and a --group-line-w line in its shade on top; the selected one keeps --bg, its group\'s line and its 3px ink bottom bar',
    /background:\s*var\(--g-tab\)/.test(rule('.tab-bar-tab.in-group')) && /inset 0 var\(--group-line-w\) 0 var\(--g-line\)/.test(rule('.tab-bar-tab.in-group'))
    && /background:\s*var\(--bg\)/.test(rule('.tab-bar-tab.in-group.active'))
    && /inset 0 var\(--group-line-w\) 0 var\(--g-line\)/.test(rule('.tab-bar-tab.in-group.active')) && /inset 0 -3px 0 var\(--ink\)/.test(rule('.tab-bar-tab.in-group.active')));
  // 27 Nov 2026 (his pick B): the group line is 6 px, defined once, in main.css's :root block beside the group tokens (where the
  // project keeps its tokens), never in tabs.css; every rule that draws a group's top line reads it, none hard-codes a px.
  {
    const tcss = readFileSync(join(repo, 'src/renderer/styles/tabs.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const lineRules = tcss.match(/inset 0 [^,;]*? 0 var\(--g-line[^)]*\)?\)?/g) || [];
    const mcss = readFileSync(join(repo, 'src/renderer/styles/main.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rootStart = mcss.indexOf(':root');
    const rootBlock = mcss.slice(rootStart, mcss.indexOf('\n}\n', rootStart)); // the light :root block, up to the dark media query
    const defs = mcss.match(/--group-line-w:\s*[^;]+;/g) || [];
    check('group line CSS: --group-line-w is defined once, as 6px, in main.css\'s first :root block beside --group3-line, and not in tabs.css',
      defs.length === 1 && /--group-line-w:\s*6px;/.test(rootBlock) && rootBlock.indexOf('--group3-line') >= 0 && rootBlock.indexOf('--group3-line') < rootBlock.indexOf('--group-line-w')
        && rootBlock.indexOf('--group-line-w') - rootBlock.indexOf('--group3-line') < 200 && !/--group-line-w\s*:/.test(tcss) && mcss.indexOf('--group-line-w') < mcss.indexOf('prefers-color-scheme: dark'), { defs, inRoot: /--group-line-w:/.test(rootBlock) });
    check('group line CSS: all 8 group-line shadows (chip, drop target, tab, selected, closes, multi) use --group-line-w, none a fixed px',
      lineRules.length === 8 && lineRules.every((r) => r.startsWith('inset 0 var(--group-line-w) 0 ')) && !/inset 0 \d+px 0 var\(--g-line/.test(tcss), lineRules);
    // A multi-selected group tab: the 1 px outline is listed before the line (the first shadow paints on top), so it shows all round.
    const shadowOf = (sel) => (tcss.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*box-shadow:\\s*([^;]+);`)) || [])[1] || '';
    const multiTab = shadowOf('.tab-bar-tab.multi.in-group');
    const multiClose = shadowOf('.tab-bar-tab.multi.in-group .tab-bar-tab-close');
    check('group line CSS: on a multi-selected group tab and its close button the --tab-sel outline is listed before the line, so it paints over it',
      multiTab.indexOf('--tab-sel') >= 0 && multiTab.indexOf('--tab-sel') < multiTab.indexOf('--group-line-w') && multiClose.indexOf('inset 0 1px 0 var(--tab-sel)') === 0 && multiClose.indexOf('--group-line-w') > multiClose.lastIndexOf('--tab-sel'), { multiTab, multiClose });
    check('group line CSS: an open name box (chip, grouped tab) is pushed below the line by padding-top of --group-line-w, and the selected tab keeps room for its 3px bar',
      /\.tab-bar-group-chip:has\(\.tab-bar-tab-rename\),\s*\.tab-bar-tab\.in-group:has\(\.tab-bar-tab-rename\)\s*\{\s*padding-top:\s*var\(--group-line-w\);/.test(tcss)
        && /\.tab-bar-tab\.in-group\.active:has\(\.tab-bar-tab-rename\)\s*\{\s*padding-bottom:\s*3px;/.test(tcss));
  }
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
  check('open chip menu: Rename Group…, Fold Group, New Tab in Group, Select Group\'s Tabs (D2), Ungroup, Close Group…',
    JSON.stringify(labels(items)) === JSON.stringify(['Rename Group…', 'Fold Group', 'New Tab in Group', 'Select Group\'s Tabs', 'Ungroup', 'Close Group…']), labels(items));
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
await section('10. Drop on a chip', 9, async () => {
  draw();
  clear();
  const grip = tabEl('a').querySelector('.tab-bar-tab-grip');
  const dt = { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k] ?? ''; }, effectAllowed: '', dropEffect: '', setDragImage() {} };
  const dragEv = (type) => { const e = new w.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'dataTransfer', { value: dt }); Object.defineProperty(e, 'clientX', { value: 10 }); Object.defineProperty(e, 'clientY', { value: 10 }); return e; };
  grip.dispatchEvent(dragEv('dragstart'));
  chip('g2').dispatchEvent(dragEv('dragover'));
  check('dragging a tab over a chip marks it as a drop target', chip('g2').classList.contains('drag-over'));
  chip('g2').dispatchEvent(dragEv('drop'));
  check('a tab dropped on a chip calls onDropTabs([tab], that chip)', JSON.stringify(callsOf('dropTabs')) === JSON.stringify([['dropTabs', ['a'], { kind: 'chip', groupId: 'g2', half: 'right' }]]), calls);
  check('...and no cue is left', !doc.querySelector('.drag-over, .drop-before, .drop-after'), calls);
  grip.dispatchEvent(dragEv('dragend'));
  clear();
  const grip2 = tabEl('g2a').querySelector('.tab-bar-tab-grip');
  dt.data = {};
  grip2.dispatchEvent(dragEv('dragstart'));
  chip('g2').dispatchEvent(dragEv('dragover'));
  const ownCue = chip('g2').classList.contains('drag-over');
  chip('g2').dispatchEvent(dragEv('drop'));
  grip2.dispatchEvent(dragEv('dragend'));
  check('a tab over its own group\'s chip shows no cue (the drop changes nothing; TabManager does nothing with it)', !ownCue && callsOf('addToGroup').length === 0, calls);

  // A drag that began elsewhere (another window's tab-3, or plain text) carries text/plain too: it must do nothing here.
  clear();
  const foreign = (type, text) => { const e = new w.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'dataTransfer', { value: { getData: () => text, setData() {}, dropEffect: '' } }); return e; };
  let threw = null;
  try {
    chip('g2').dispatchEvent(foreign('drop', 'a'));
    tabEl('b').dispatchEvent(foreign('drop', 'a'));
    tabEl('b').dispatchEvent(foreign('drop', 'g2a'));
  } catch (e) { threw = e; }
  check('a foreign drop on a chip calls no callback and throws nothing', callsOf('addToGroup').length === 0 && !threw, { calls, threw: String(threw) });
  check('a foreign drop on a tab calls no callback (no move, no regroup)', callsOf('dropTabs').length === 0 && callsOf('addToGroup').length === 0, calls);
  // A foreign drop that arrives while a local drag is in flight but names another tab is foreign too.
  const gripB = tabEl('g2a').querySelector('.tab-bar-tab-grip');
  dt.data = {};
  gripB.dispatchEvent(dragEv('dragstart'));
  chip('g1').dispatchEvent(foreign('drop', 'b'));
  check('...even mid-drag, data that is not the dragged tab is refused', callsOf('addToGroup').length === 0 && callsOf('dropTabs').length === 0, calls);
  clear();
  tabEl('b').dispatchEvent(dragEv('drop'));
  check('a drop on a tab after a grip dragstart calls onDropTabs(dragged, the tab and the half under the pointer)', JSON.stringify(callsOf('dropTabs')) === JSON.stringify([['dropTabs', ['g2a'], { kind: 'tab', id: 'b', half: 'right' }]]), calls);
  gripB.dispatchEvent(dragEv('dragend'));
  clear();
  tabEl('b').dispatchEvent(foreign('drop', 'g2a'));
  check('after dragend, a drop reading like a tab id does nothing', callsOf('dropTabs').length === 0, calls);
});

// ============ 10b. Drop slots and their cue (24 Nov 2026) ============
// Michael: "in Google Chrome, you can drag a tab to the edge of the tab group, and it will include it,
// whereas in this, that doesn't work. You have to drag it into the middle of it." Every strip item is
// 100 px wide here (stubbed rects), so x = 20 is a tab's left half and 80 its right.
await section('10b. Drop slots and their cue', 50, async () => {
  const realRect = w.Element.prototype.getBoundingClientRect;
  w.Element.prototype.getBoundingClientRect = function () {
    // As a browser does: an element no longer in the document has no box.
    if (!this.isConnected) return { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0, x: 0, y: 0 };
    if (this.classList?.contains('tab-bar-tab') || this.classList?.contains('tab-bar-group-chip')) {
      const at = [...this.parentElement.children].indexOf(this) * 100;
      return { left: at, right: at + 100, width: 100, top: 0, bottom: 30, height: 30, x: at, y: 0 };
    }
    return realRect.call(this);
  };
  applyDrops = true;
  try {
    const dt = { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k] ?? ''; }, effectAllowed: '', dropEffect: '', setDragImage() {} };
    const ev = (type, x, related) => {
      const e = new w.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: dt });
      if (x !== undefined) Object.defineProperty(e, 'clientX', { value: x });
      if (related !== undefined) Object.defineProperty(e, 'relatedTarget', { value: related });
      return e;
    };
    const leftOf = (el) => el.getBoundingClientRect().left;
    const over = (id, half) => { const el = tabEl(id); el.dispatchEvent(ev('dragover', leftOf(el) + (half === 'left' ? 20 : 80))); };
    const dropOn = (id, half) => { const el = tabEl(id); el.dispatchEvent(ev('drop', leftOf(el) + (half === 'left' ? 20 : 80))); };
    const startDrag = (id) => { dt.data = {}; tabEl(id).querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragstart')); };
    /** The cue now: which tab carries the line and on which side, its colour, the chips marked. */
    const cue = () => {
      const lines = [...doc.querySelectorAll('.drop-before, .drop-after')].map((el) => `${el.dataset.tabId ?? `[${el.dataset.groupId}]`}:${el.classList.contains('drop-before') ? 'before' : 'after'}:${el.style.getPropertyValue('--drop-line')}`);
      const chips = [...doc.querySelectorAll('.tab-bar-group-chip.drag-over')].map((el) => el.dataset.groupId);
      return `${lines.join(',') || '-'} | ${chips.join(',') || '-'}`;
    };
    const order = () => state.tabs.map((t) => (t.groupId ? `${t.id}@${t.groupId}` : t.id)).join(' ');

    // a | [Games g1] g1a g1b | b | [g2] g2a g2b g2c
    draw();
    clear();
    startDrag('a');
    over('b', 'left');
    check('his case, the cue: over b\'s near half (Games\' right edge) a line before b in --focus, Games\' chip marked', cue() === 'b:before:var(--focus) | g1', cue());
    over('b', 'right');
    check('b\'s far half: a line after b in ink, no chip (the slot before g2\'s chip is outside g2)', cue() === 'b:after:var(--ink) | -', cue());
    over('g1b', 'right');
    check('Games\' last tab, right half: a line after it in Games\' colour, its chip marked', cue() === 'g1b:after:var(--focus) | g1', cue());
    over('g1a', 'left');
    check('Games\' first tab, left half: inside Games, before it', cue() === 'g1a:before:var(--focus) | g1', cue());
    over('g2a', 'left');
    check('the second group\'s first tab, left half: its own shade (group2), its chip; the earlier cue gone', cue() === 'g2a:before:var(--focus) | g2', cue());
    over('a', 'right');
    check('over the dragged tab itself: no cue', cue() === '- | -', cue());
    chip('g2').dispatchEvent(ev('dragover', 580));
    check('over a chip: that chip marked, no slot line', cue() === '- | g2', cue());
    over('b', 'left');
    tabEl('b').dispatchEvent(ev('dragleave', 220, tabEl('g2a')));
    check('leaving one tab for another keeps the cue (the next dragover redraws it)', cue() === 'b:before:var(--focus) | g1', cue());
    tabEl('b').dispatchEvent(ev('dragleave', 220, doc.body));
    check('leaving the strip clears every cue', cue() === '- | -', cue());
    over('b', 'left');
    dropOn('b', 'left');
    check('his case, the drop: onDropTabs([a], b left half)', JSON.stringify(callsOf('dropTabs').at(-1)) === JSON.stringify(['dropTabs', ['a'], { kind: 'tab', id: 'b', half: 'left' }]), calls);
    check('...a joins Games at its end', order() === 'g1a@g1 g1b@g1 a@g1 b g2a@g2 g2b@g2 g2c@g2', order());
    check('...and no cue is left after the drop', cue() === '- | -' && !doc.querySelector('.dragging'), cue());

    // A drop on a chip after a held rebuild still delivers (the chip's id is read before the strip is rebuilt).
    draw();
    clear();
    startDrag('a');
    bar.update(baseTabs().map((t) => (t.id === 'b' ? { ...t, title: 'bravo, busy' } : t)), baseGroups());
    chip('g2').dispatchEvent(ev('drop', 580));
    check('a rebuild held mid-drag: a drop on a chip still delivers that chip and its half', JSON.stringify(callsOf('dropTabs').at(-1)) === JSON.stringify(['dropTabs', ['a'], { kind: 'chip', groupId: 'g2', half: 'right' }]), calls);
    // The same at the chip's LEFT half (chip g2 starts at 500 here, so 520 is its left half): the half is read before the drag ends
    // and the held rebuild detaches the chip, else a detached chip reads "right" and the tab joins instead of leaving (25 Nov review).
    draw();
    clear();
    startDrag('g1a');
    bar.update(baseTabs().map((t) => (t.id === 'b' ? { ...t, title: 'bravo, busy' } : t)), baseGroups());
    const g2ChipBefore = chip('g2');
    chip('g2').dispatchEvent(ev('drop', 520));
    check('a rebuild held mid-drag: a drop on a chip\'s left half still reports the left half (the chip was detached by the rebuild)',
      JSON.stringify(callsOf('dropTabs').at(-1)) === JSON.stringify(['dropTabs', ['g1a'], { kind: 'chip', groupId: 'g2', half: 'left' }]) && !g2ChipBefore.isConnected, calls);
    check('...and the tab left Games, ungrouped just before the second group (not joined to it)', order() === 'a g1b@g1 b g1a g2a@g2 g2b@g2 g2c@g2', order());

    // A rebuild held during the drag (a title or dot update while Claude works) is applied when the
    // drop ends the drag, which detaches every tab element: the half must be read before that.
    draw();
    clear();
    startDrag('a');
    over('b', 'left');
    bar.update(baseTabs().map((t) => (t.id === 'b' ? { ...t, title: 'bravo, busy' } : t)), baseGroups());
    const bBefore = tabEl('b');
    dropOn('b', 'left');
    check('a rebuild held mid-drag: the left-half drop at Games\' right edge still reports the left half', JSON.stringify(callsOf('dropTabs').at(-1)) === JSON.stringify(['dropTabs', ['a'], { kind: 'tab', id: 'b', half: 'left' }]) && !bBefore.isConnected, calls);
    check('...and a joins Games', order() === 'g1a@g1 g1b@g1 a@g1 b g2a@g2 g2b@g2 g2c@g2', order());
    // Out past the edge again: g1's last tab (a) onto b's far half leaves the group; its near half is its own edge.
    startDrag('a');
    over('b', 'left');
    check('the group\'s last tab over the next tab\'s near half (its own edge): no cue (nothing would change)', cue() === '- | -', cue());
    over('b', 'right');
    check('...over its far half: an ink line after b (it will leave the group)', cue() === 'b:after:var(--ink) | -', cue());
    dropOn('b', 'right');
    check('...dropped there, a leaves Games', order() === 'g1a@g1 g1b@g1 b a g2a@g2 g2b@g2 g2c@g2', order());

    // A reorder inside the tab's own group joins nothing: the ink line, no chip mark; into another group is blue with that chip.
    startDrag('g1a');
    over('g1b', 'right');
    check('a tab moved inside its own group: an ink line after the neighbour, no chip mark', cue() === 'g1b:after:var(--ink) | -', cue());
    over('g2a', 'left');
    check('...into another group: --focus and that group\'s chip', cue() === 'g2a:before:var(--focus) | g2', cue());
    tabEl('g1a').querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragend'));

    // dragend clears the cue.
    startDrag('a');
    over('g1b', 'right');
    tabEl('a').querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragend'));
    check('dragend clears every cue', cue() === '- | -', cue());

    // A folded group: only its chip joins it.
    fold('g1');
    clear();
    startDrag('a');
    over('b', 'left');
    check('folded Games: the slot after its chip is not a join (ink, no chip)', cue() === 'b:before:var(--ink) | -', cue());
    chip('g1').dispatchEvent(ev('dragover', 180));
    check('...its chip still takes the drop', cue() === '- | g1', cue());
    over('b', 'left');
    dropOn('b', 'left');
    check('...dropped before b, a stays ungrouped', order() === 'g1a@g1 g1b@g1 a b g2a@g2 g2b@g2 g2c@g2', order());

    // Two adjacent groups: a | [g1] g1a g1b | [g2] g2a g2b g2c
    draw(baseTabs().filter((t) => t.id !== 'b'));
    startDrag('a');
    over('g1b', 'right');
    check('two adjacent groups: the first\'s last tab, right half (before the second\'s chip): joins the first', cue() === 'g1b:after:var(--focus) | g1', cue());
    over('g2a', 'left');
    check('...the second\'s first tab, left half: joins the second', cue() === 'g2a:before:var(--focus) | g2', cue());
    tabEl('a').querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragend'));

    // A selection: a (the tab you're on) and g2b, ⌘-clicked, dropped together at Games' right edge.
    draw();
    const meta = (id) => { fire(tabEl(id).querySelector('.tab-bar-tab-title'), 'mousedown', { screenX: 50, screenY: 50, metaKey: true }); fire(doc, 'mouseup', { screenX: 50, screenY: 50 }); };
    meta('g2b');
    check('set-up: g2b ⌘-clicked into the selection with a', JSON.stringify(bar.selectedIds()) === JSON.stringify(['a', 'g2b']), bar.selectedIds());
    clear();
    startDrag('g2b');
    over('b', 'left');
    check('a selection over b\'s near half: Games\' colour and chip', cue() === 'b:before:var(--focus) | g1', cue());
    dropOn('b', 'left');
    check('...dropped: onDropTabs([a, g2b], b left)', JSON.stringify(callsOf('dropTabs').at(-1)) === JSON.stringify(['dropTabs', ['a', 'g2b'], { kind: 'tab', id: 'b', half: 'left' }]), calls);
    check('...both join Games at its end, in strip order, g2 still one run', order() === 'g1a@g1 g1b@g1 a@g1 g2b@g1 b g2a@g2 g2c@g2', order());
    check('...no cue left', cue() === '- | -', cue());
    tabEl('a').querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragend'));

    // The chip's two halves (25 Nov; "Wake is currently inside the low group ... drag it to the left of the low group
    // so that it's outside it but on the far left"): [g1] g1a g1b | a | b ... Every item 100 px wide: chip at 0, x = 20 left, 80 right.
    const chipOver = (id, x) => chip(id).dispatchEvent(ev('dragover', x));
    const chipDrop = (id, x) => chip(id).dispatchEvent(ev('drop', x));
    draw([{ id: 'g1a', title: 'chess', active: true, groupId: 'g1' }, { id: 'g1b', title: 'go', active: false, groupId: 'g1' }, { id: 'a', title: 'alpha', active: false }, { id: 'b', title: 'bravo', active: false }]);
    clear();
    startDrag('g1a');
    chipOver('g1', 20);
    check('chip-left, a group at the strip\'s start: an ink line on the chip\'s left edge, the chip not marked', cue() === '[g1]:before:var(--ink) | -', cue());
    check('...the line is on the chip itself (first child), and the chip is not .drag-over', chip('g1').classList.contains('drop-before') && !chip('g1').classList.contains('drag-over') && chip('g1') === strip().firstElementChild);
    chipOver('g1', 80);
    check('chip-right with every dragged tab already in the group: no cue', cue() === '- | -', cue());
    tabEl('g1a').querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragend'));
    // At the strip's start the two chip cues sit side by side: chip-left is a line in the chip's left column, chip-right is the
    // chip itself marked (.drag-over) with no line there, so they differ by more than colour (25 Nov review).
    startDrag('a');
    chipOver('g1', 80);
    check('chip-right at the strip\'s start (an ungrouped tab over the first chip): the chip marked, no line drawn on it', cue() === '- | g1' && !chip('g1').classList.contains('drop-before') && !chip('g1').classList.contains('drop-after'), cue());
    chipOver('g1', 20);
    check('...and chip-left on the same chip: the line, the chip not marked (the two cues never share a look)', cue() === '[g1]:before:var(--ink) | -', cue());
    tabEl('a').querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragend'));
    startDrag('g1a');
    chipOver('g1', 20);
    chipDrop('g1', 20);
    check('...dropped on the left half: onDropTabs([g1a], chip g1, left)', JSON.stringify(callsOf('dropTabs').at(-1)) === JSON.stringify(['dropTabs', ['g1a'], { kind: 'chip', groupId: 'g1', half: 'left' }]), calls);
    check('...his case: g1a is out of Games, still first, the group whole after it', order() === 'g1a g1b@g1 a b' && cue() === '- | -', { order: order(), cue: cue() });
    tabEl('g1a').querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragend'));
    // The same line over a tab elsewhere: a (ungrouped, right) onto g1's chip.
    startDrag('a');
    chipOver('g1', 120);
    check('an ungrouped tab from the right over the chip\'s left half (the chip is the second item): ink line, no mark', cue() === '[g1]:before:var(--ink) | -', cue());
    chipOver('g1', 180);
    check('...over its right half: the chip marked, no line (it joins)', cue() === '- | g1', cue());
    chipDrop('g1', 180);
    check('...dropped there: onDropTabs([a], chip g1, right), delivered with its half', JSON.stringify(callsOf('dropTabs').at(-1)) === JSON.stringify(['dropTabs', ['a'], { kind: 'chip', groupId: 'g1', half: 'right' }]), calls);
    tabEl('a').querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragend'));

    // No-op: an ungrouped tab already just before the chip.
    draw(baseTabs());
    clear();
    startDrag('a');
    chipOver('g1', 120);
    check('chip-left where the tab already is (a, just before Games): no cue', cue() === '- | -', cue());
    chipDrop('g1', 120);
    check('...and the drop changes nothing', order() === 'a g1a@g1 g1b@g1 b g2a@g2 g2b@g2 g2c@g2', order());
    tabEl('a').querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragend'));

    // Two adjacent groups: a | [g1] g1a g1b | [g2] g2a g2b g2c; chip g2 sits at 400.
    draw(baseTabs().filter((t) => t.id !== 'b'));
    startDrag('a');
    chipOver('g2', 420);
    check('two adjacent groups: over the second chip\'s left half, an ink line on that chip', cue() === '[g2]:before:var(--ink) | -', cue());
    chipDrop('g2', 420);
    check('...a lands ungrouped between the groups', order() === 'g1a@g1 g1b@g1 a g2a@g2 g2b@g2 g2c@g2', order());
    tabEl('a').querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragend'));

    // A folded group: left half out in front of it, right half joins.
    fold('g1');
    startDrag('b');
    chipOver('g1', 120);
    check('folded Games: the chip\'s left half is an ink line, the chip not marked', cue() === '[g1]:before:var(--ink) | -', cue());
    chipOver('g1', 180);
    check('...its right half marks the chip', cue() === '- | g1', cue());
    chipOver('g1', 120);
    chipDrop('g1', 120);
    check('...dropped left: b sits ungrouped just before the folded group', order() === 'a b g1a@g1 g1b@g1 g2a@g2 g2b@g2 g2c@g2', order());
    tabEl('b').querySelector('.tab-bar-tab-grip').dispatchEvent(ev('dragend'));

    // A selection dropped on a chip's left half.
    draw();
    meta('g2b');
    clear();
    startDrag('g2b');
    chipOver('g1', 120);
    check('a selection over the chip\'s left half: an ink line (g2b leaves its group)', cue() === '[g1]:before:var(--ink) | -', cue());
    chipDrop('g1', 120);
    check('...dropped: onDropTabs([a, g2b], chip g1, left), both ungrouped before Games, g2 whole', JSON.stringify(callsOf('dropTabs').at(-1)) === JSON.stringify(['dropTabs', ['a', 'g2b'], { kind: 'chip', groupId: 'g1', half: 'left' }]) && order() === 'a g2b g1a@g1 g1b@g1 b g2a@g2 g2c@g2', { calls, order: order() });
    check('...no cue left', cue() === '- | -', cue());
    // The CSS draws the chip's line like a tab's, at its left edge.
    const css = readFileSync(join(repo, 'src/renderer/styles/tabs.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    check('CSS: the chip\'s drop-before line is the tab\'s (--drop-line, ink), at its left edge, flush at the strip\'s start', /\.tab-bar-group-chip\.drop-before::after\s*\{\s*left:\s*-2px/.test(css) && /\.tab-bar-group-chip:first-child\.drop-before::after\s*\{\s*left:\s*0/.test(css), css.match(/[^}]*group-chip\.drop-before[^}]*}/g));
    const markRule = css.match(/\.tab-bar-group-chip\.drag-over\s*\{[^}]*\}/)?.[0] ?? '';
    check('CSS: the chip\'s drop mark (.drag-over) paints nothing in its left column (no inset left bar), so chip-right cannot be read as the chip-left line', /box-shadow:/.test(markRule) && !/inset\s+-?\d+px\s+0\s+0\s+var/.test(markRule) && !/border-left|outline/.test(markRule), markRule);
    check('...and the chip is positioned (so the line anchors to it)', /\.tab-bar-group-chip\s*\{[^}]*position:\s*relative/.test(css));
  } finally {
    applyDrops = false;
    w.Element.prototype.getBoundingClientRect = realRect;
    draw();
  }
});

await section('11. Focus: a chip click keeps the terminal\'s focus; a folded tab\'s focus goes to its chip', 6, async () => {
  draw();
  clear();
  // One drag, not two: the strip's own blank-space handler must not start a
  // second window drag under the chip's.
  windowDx = 0;
  fire(chip('g1'), 'mousedown', { screenX: 100, screenY: 100 });
  fire(doc, 'mousemove', { screenX: 120, screenY: 100 });
  fire(doc, 'mousemove', { screenX: 140, screenY: 100 });
  fire(doc, 'mouseup', { screenX: 140, screenY: 100 });
  check('a 40 px drag on a chip moves the window 40 px (one drag, not two)', windowDx === 40, windowDx);
  clear();
  // A press that is default-prevented never takes focus (the blank strip's rule).
  const pressed = !fire(chip('g1'), 'mousedown', { screenX: 50, screenY: 50 });
  fire(doc, 'mouseup', { screenX: 50, screenY: 50 });
  check('a press on a chip is default-prevented, so focus stays in the terminal', pressed);
  check('...and still folds the group', callsOf('toggleGroup').length === 1, calls);
  // The name box still takes a press (a caret click).
  choose(openChipMenu('g1'), 'Rename Group…').click();
  box = nameBox();
  check('a press inside the open name box is not prevented', !!box && fire(box, 'mousedown', { screenX: 50, screenY: 50 }) === true);
  fire(doc, 'mouseup', { screenX: 50, screenY: 50 });
  key(box, 'Escape');
  draw();
  // A focused tab whose group folds: focus goes to the group's chip.
  tabEl('g1b').focus();
  fold('g1');
  check('a focused tab hidden by a fold hands focus to its chip', doc.activeElement === chip('g1'), doc.activeElement?.className);
  draw();
  tabEl('g2a').querySelector('.tab-bar-tab-close')?.focus();
  const onClose = doc.activeElement?.classList.contains('tab-bar-tab-close');
  fold('g2');
  check('a focused close button of a tab hidden by a fold hands focus to the chip', onClose && doc.activeElement === chip('g2'), { onClose, active: doc.activeElement?.className });
  draw();
});

await section('12. The folded chip\'s list stays inside the window\'s right edge', 4, async () => {
  fold('g1');
  const realRect = w.Element.prototype.getBoundingClientRect;
  const realWidth = w.innerWidth;
  let chipLeft = 900;
  const rect = (left, width, top, height) => ({ left, right: left + width, width, top, bottom: top + height, height, x: left, y: top, toJSON() {} });
  w.Element.prototype.getBoundingClientRect = function () {
    if (this.classList?.contains('tab-bar-group-chip')) return rect(chipLeft, 90, 0, 30);
    // jsdom does no layout: squeeze like a browser, where an absolutely placed box is as wide as the room right of its left (up to its natural 300 px).
    if (this.classList?.contains('tab-bar-group-list')) {
      const at = parseFloat(this.style.left) || 0;
      return rect(at, Math.min(300, w.innerWidth - at), 0, 80);
    }
    return realRect.call(this);
  };
  Object.defineProperty(w, 'innerWidth', { value: 1000, configurable: true });
  try {
    fire(chip('g1'), 'mouseenter', { bubbles: false });
    l = list();
    const left = parseFloat(l?.style.left ?? 'NaN');
    check('a list under a chip near the right edge is pulled in (300 px list, 1000 px window: left <= 696)', left <= 696 && left >= 4, l?.style.left);
    check('...to exactly the window\'s edge less 4 px (measured at its natural width, not squeezed to the room left of the chip)', left === 696, l?.style.left);
    fire(chip('g1'), 'mouseleave', { bubbles: false });
    await sleep(260);
    chipLeft = 50;
    fire(chip('g1'), 'mouseenter', { bubbles: false });
    check('...one with room still sits at its chip\'s left', list()?.style.left === '50px', list()?.style.left);
    fire(chip('g1'), 'mouseleave', { bubbles: false });
    await sleep(260);
    chipLeft = -20;
    fire(chip('g1'), 'mouseenter', { bubbles: false });
    check('...and never left of 4 px', list()?.style.left === '4px', list()?.style.left);
    fire(chip('g1'), 'mouseleave', { bubbles: false });
    await sleep(260);
  } finally {
    w.Element.prototype.getBoundingClientRect = realRect;
    Object.defineProperty(w, 'innerWidth', { value: realWidth, configurable: true });
    draw();
  }
});

// --- group shades (22 Nov 2026, look B of the shades sketch): each group takes a shade in turn by
// its place on the strip (class group-shade-1..3 on its chip and its tabs), a fourth repeats the
// first, ungrouped tabs have none; the colours are tokens in main.css, light in :root and dark in
// the prefers-color-scheme block, ink on every fill 4.5:1 or better. (The painted fills, hover
// and the selected tab's ground are measured on the real CSS in check-ui-text-scale.cjs.)
{
  const shadeOf = (el) => (el && [...el.classList].find((c) => /^group-shade-\d$/.test(c))) ?? null;
  const four = [
    { id: 'p', title: 'p', active: false },
    { id: 'a1', title: 'a1', active: false, groupId: 'A' },
    { id: 'u', title: 'u', active: false },
    { id: 'b1', title: 'b1', active: true, groupId: 'B' },
    { id: 'b2', title: 'b2', active: false, groupId: 'B' },
    { id: 'c1', title: 'c1', active: false, groupId: 'C' },
    { id: 'd1', title: 'd1', active: false, groupId: 'D' },
  ];
  const fourGroups = ['A', 'B', 'C', 'D'].map((id) => ({ id, name: id, folded: id === 'C' }));
  draw(four, fourGroups);
  check('shades: groups A, B, C get shades 1, 2, 3 on their chips (the folded one too) and D repeats 1',
    ['A', 'B', 'C', 'D'].map((g) => shadeOf(chip(g))).join() === 'group-shade-1,group-shade-2,group-shade-3,group-shade-1', ['A', 'B', 'C', 'D'].map((g) => shadeOf(chip(g))));
  check('shades: a tab wears its group\'s shade (b1, b2 = 2; a1 = 1; d1 = 1); ungrouped p and u wear none',
    shadeOf(tabEl('b1')) === 'group-shade-2' && shadeOf(tabEl('b2')) === 'group-shade-2' && shadeOf(tabEl('a1')) === 'group-shade-1' && shadeOf(tabEl('d1')) === 'group-shade-1'
      && shadeOf(tabEl('p')) === null && shadeOf(tabEl('u')) === null && !tabEl('u').classList.contains('in-group'), ['p', 'a1', 'u', 'b1', 'b2', 'd1'].map((id) => [id, shadeOf(tabEl(id))]));
  check('shades: the selected grouped tab is still .active .in-group (CSS gives it --bg and the bar)', tabEl('b1').classList.contains('active') && tabEl('b1').classList.contains('in-group'));
  // The shade is the group's place on the strip, so removing the first group moves the others up.
  draw(four.filter((t) => t.groupId !== 'A'), fourGroups.filter((g) => g.id !== 'A'));
  check('shades: with group A gone, B takes shade 1 (by place on the strip)', shadeOf(chip('B')) === 'group-shade-1' && shadeOf(tabEl('b2')) === 'group-shade-1', shadeOf(chip('B')));
  draw();

  // The tokens, read from main.css: exactly the approved colours, light in :root, dark in the dark block.
  const css = readFileSync(join(repo, 'src/renderer/styles/main.css'), 'utf8');
  const darkAt = css.indexOf('@media (prefers-color-scheme: dark)');
  const lightCss = css.slice(0, darkAt);
  const darkCss = css.slice(darkAt, css.indexOf('\n}\n', css.indexOf(':root', darkAt)));
  const want = {
    light: [['edf3fc', 'd9e6f8', '8fb0e3'], ['ecf6f0', 'd4ecdf', '86c3a2'], ['fcf5e6', 'f4e3bf', 'e0bd6e']],
    dark: [['18202b', '22304a', '3f5c8f'], ['17231d', '213a2d', '3f7558'], ['261f12', '3b2f17', '7a6127']],
  };
  const tokenOf = (block, n, part) => block.match(new RegExp(`--group${n}-${part}:\\s*#([0-9a-fA-F]{6})`))?.[1]?.toLowerCase();
  for (const [mode, block] of [['light', lightCss], ['dark', darkCss]]) {
    const got = [1, 2, 3].map((n) => ['tab', 'chip', 'line'].map((part) => tokenOf(block, n, part)));
    check(`shades: the ${mode} tokens are exactly the approved colours`, JSON.stringify(got) === JSON.stringify(want[mode]), got);
  }
  // Contrast, from the REAL tokens (main.css: light in :root, dark in the dark block, dark falling back to light) and the
  // real rules (tabs.css), on every group fill: the tab, the tab hovered (18% toward the line), the chip, the chip
  // hovered (25%) and the selected tab's --bg. Ink 4.5:1; secondary text (--muted on an inactive tab at rest,
  // the chip's --chip-muted mix on a chip) 4.5:1; status dots, flags and the parked ring 3:1; the drop line 3:1.
  const tabsCss = readFileSync(join(repo, 'src/renderer/styles/tabs.css'), 'utf8');
  const tokensIn = (block) => Object.fromEntries([...block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const tokenMaps = { light: tokensIn(lightCss), dark: { ...tokensIn(lightCss), ...tokensIn(darkCss) } };
  const hex = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const mix = (a, b, p) => a.map((v, i) => Math.round(v * p + b[i] * (1 - p)));
  const colourIn = (mode, name, depth = 0) => { // an rgb triple, or null for transparent
    const v = tokenMaps[mode][name];
    if (v === undefined || depth > 8) throw new Error(`token --${name} unreadable in ${mode}`);
    const ref = v.match(/^var\(--([a-z0-9-]+)\)$/);
    if (ref) return colourIn(mode, ref[1], depth + 1);
    if (v === 'transparent') return null;
    const h = v.match(/^#([0-9a-fA-F]{6})$/);
    if (!h) throw new Error(`token --${name} in ${mode} is not a plain colour: ${v}`);
    return hex(h[1]);
  };
  const chipMutedPct = Number(tabsCss.match(/--chip-muted:\s*color-mix\(in srgb, var\(--ink\) (\d+)%, var\(--muted\)\)/)?.[1]);
  check('shades: the chip\'s secondary lettering is a --muted mix read from tabs.css (a percentage of ink)', chipMutedPct > 0 && chipMutedPct < 100, chipMutedPct);
  // The colour var the drop line takes in each rule that draws it.
  const dropVar = (sel) => tabsCss.replace(/\/\*[\s\S]*?\*\//g, '').match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*inset 0 -2px 0 var\\(--([a-z-]+)\\)`))?.[1];
  // The chip's drop mark (a bar along its bottom: a drop on its right half, or a slot that joins its group) and the slot line between
  // tabs (24 Nov 2026): --drop-line, which tab-bar.ts sets to --focus when the slot joins a group, else ink.
  const drops = { chip: dropVar('.tab-bar-group-chip.drag-over') };
  const slotLine = /\.tab-bar-tab\.drop-before::after,\s*\.tab-bar-tab\.drop-after::after,\s*\.tab-bar-group-chip\.drop-before::after\s*\{[^}]*background:\s*var\(--drop-line, var\(--ink\)\)/.test(tabsCss.replace(/\/\*[\s\S]*?\*\//g, ''));
  check('shades: the chip\'s drop line names a colour token, and the slot line is --drop-line falling back to ink', !!drops.chip && slotLine, { drops, slotLine });
  // The slot line crosses a group's 6px line (27 Nov 2026). Its own colours (--focus joining, --ink not) are under 3:1 against some line
  // colours, so it carries a 1px edge in a token (--bg) that each cue reaches 3:1 against; read from the rule, both schemes.
  const slotEdge = tabsCss.replace(/\/\*[\s\S]*?\*\//g, '').match(/\.tab-bar-group-chip\.drop-before::after\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--([a-z-]+)\);/)?.[1];
  check('shades: the slot line (tab and chip) has a 1px edge in a colour token, read from the rule', !!slotEdge, slotEdge);
  for (const mode of ['light', 'dark']) {
    const T = (n) => colourIn(mode, n);
    const ink = T('ink');
    const sec = mix(ink, T('muted'), chipMutedPct / 100);
    const edge = T('dot-edge');
    const rows = { ink: [], secondary: [], status: [], drop: [], join: [] };
    want[mode].forEach(([tab, chipC, line], i) => {
      const L = hex(line);
      const fills = [['tab', hex(tab)], ['tab hover', mix(L, hex(tab), 0.18)], ['chip', hex(chipC)], ['chip hover', mix(L, hex(chipC), 0.25)], ['selected', T('bg')]];
      for (const [what, fill] of fills) {
        const tag = `g${i + 1} ${what}`;
        rows.ink.push([tag, +ratio(ink, fill).toFixed(2)]);
        // A dot's edge (light mode only: transparent in dark) counts as its outline, as --dot-edge's comment says.
        for (const dot of ['prompt-ready', 'status-ckpt', 'flag-green', 'flag-yellow', 'flag-red']) {
          const d = T(dot);
          rows.status.push([`${tag} ${dot}`, +Math.max(ratio(d, fill), edge ? ratio(edge, fill) : 0).toFixed(2)]);
        }
        rows.status.push([`${tag} parked ring`, +ratio(T('parked'), fill).toFixed(2)]);
        if (what.startsWith('chip')) rows.secondary.push([`${tag} chip lettering`, +ratio(sec, fill).toFixed(2)]);
        if (what === 'tab') rows.secondary.push([`${tag} --muted title`, +ratio(T('muted'), fill).toFixed(2)]);
        if (what.startsWith('chip')) rows.drop.push([`${tag} drop line --${drops.chip}`, +ratio(T(drops.chip), fill).toFixed(2)]);
        else {
          rows.drop.push([`${tag} slot line --ink`, +ratio(ink, fill).toFixed(2)]);
          rows.join.push([`${tag} joining slot line --focus`, +ratio(T('focus'), fill).toFixed(2)]);
        }
      }
    });
    const low = (list) => Math.min(...list.map((r) => r[1]));
    const under = (list, min) => list.filter((r) => r[1] < min);
    check(`shades: ${mode}, ink reaches 4.5:1 on every group fill and its hover (lowest ${low(rows.ink)})`, under(rows.ink, 4.5).length === 0, under(rows.ink, 4.5));
    check(`shades: ${mode}, secondary text (the chips' --muted mix, an inactive tab's --muted title) reaches 4.5:1 (lowest ${low(rows.secondary)})`, under(rows.secondary, 4.5).length === 0, under(rows.secondary, 4.5));
    check(`shades: ${mode}, status dots, flags and the parked ring reach 3:1 on every fill, counting a dot's edge as its outline (lowest ${low(rows.status)})`, under(rows.status, 3).length === 0, under(rows.status, 3).slice(0, 6));
    check(`shades: ${mode}, the chip's drop line and the ink slot line reach 3:1 on every fill (lowest ${low(rows.drop)})`, rows.drop.length > 0 && under(rows.drop, 3).length === 0, under(rows.drop, 3));
    check(`shades: ${mode}, the joining slot line (--focus) reaches 3:1 on every group's tab fills (lowest ${low(rows.join)})`, rows.join.length > 0 && under(rows.join, 3).length === 0, under(rows.join, 3));
    // Where the slot line crosses a group's top line: bare, --focus and --ink are measured against each line colour; the edge is measured
    // against both cues. The cue needs 3:1 against what touches it, so an edge is required wherever a bare cue falls short.
    const crossing = { bare: [], edge: [] };
    for (const [, , line] of want[mode]) for (const cue of ['focus', 'ink']) {
      crossing.bare.push([`${cue} on line ${line}`, +ratio(T(cue), hex(line)).toFixed(2)]);
    }
    for (const cue of ['focus', 'ink']) if (slotEdge) crossing.edge.push([`${cue} against its --${slotEdge} edge`, +ratio(T(cue), T(slotEdge)).toFixed(2)]);
    check(`shades: ${mode}, where the slot line crosses a group's top line it has an edge it reaches 3:1 against (bare cue on a line colour: lowest ${low(crossing.bare)}; against the edge: lowest ${crossing.edge.length ? low(crossing.edge) : 'none'})`,
      under(crossing.bare, 3).length === 0 || (crossing.edge.length === 2 && under(crossing.edge, 3).length === 0), { bare: under(crossing.bare, 3), edge: crossing.edge });
  }
}

bar.dispose();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
