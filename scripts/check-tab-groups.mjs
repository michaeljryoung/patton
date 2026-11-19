// Behaviour check of tab groups, TabManager side (19 Nov 2026; Michael: "something
// like Google Chrome's tab groups, so you can then group some of the tabs and
// minimize the group"). Drives the REAL TabManager (and the REAL TabBar it builds,
// where a click or a drop is the natural route) in jsdom, with the REAL Tab and
// Pane and a stub window.patton whose session store is main's REAL setSession /
// getSession (electron stubbed, electron-store writing under a temp folder), so a
// save goes through main's group sanitiser (main/session-groups.ts) and back.
// Covers: a group's tabs are one unbroken run after every operation (and normalise
// never had to repair one); add to a new / existing / folded group; remove; an
// emptied group deleted; fold moving the selection right, else left, else to a
// new tab; jumps unfolding; ⌘1–9 and next/prev counting only visible tabs; closing
// the selected tab; Close Group (one in-app ask, the Claude count, a new tab first
// when the group held every tab, Cancel); Ungroup; New Tab in Group; reorder's
// join/leave rule and a drop on a chip; wake moving the whole group; discardTab's
// inheritance; the folded chip's strongest-state rank; session save/restore
// (names, folds, order, broken run repaired, the active tab's group unfolded, an
// old session without groups); main's sanitising; the [GROUP] log lines;
// Move Left / Move Right taking exactly one step (into, out of, past a group).
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-tab-groups.mjs
//   jsdom is not a project dependency: install it in a scratch folder.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'tab-groups-check-'));

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
process.on('unhandledRejection', (err) => { failed++; console.log('FAIL unhandled rejection', String(err?.stack ?? err)); });
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) process.exitCode = 1;
  if (!finished) console.log('FAIL script ended before all checks ran');
});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await tick(10);
  }
  return fn();
}

// ── Main: the real store (setSession / getSession) with electron stubbed ──
globalThis.__stubs = { userData: join(work, 'userData') };
const electronStub = `
const s = globalThis.__stubs;
const quiet = new Proxy(function () {}, { get: () => quiet, apply: () => quiet, construct: () => quiet });
module.exports = new Proxy({
  app: { getPath: () => s.userData, getName: () => 'patton', getVersion: () => '0', isPackaged: false, on() {}, whenReady: () => new Promise(() => {}) },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle() {}, on() {}, once() {}, removeHandler() {} },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null, getFocusedWindow: () => null },
  nativeTheme: { shouldUseDarkColors: false, on() {} },
}, { get: (t, k) => (k in t ? t[k] : (k === '__esModule' ? false : quiet)) });
`;
await build({
  stdin: {
    contents: `export { setSession, getSession } from './src/main/store';
export { sanitiseSessionGroups } from './src/main/session-groups';`,
    resolveDir: repo, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'main.mjs'), logLevel: 'error',
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^(electron|node-pty)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
        contents: a.path === 'node-pty' ? 'module.exports = { spawn() { throw new Error("no pty in checks"); } };' : electronStub,
        loader: 'js',
      }));
    },
  }],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const M = await import(pathToFileURL(join(work, 'main.mjs')).href);

// ── Renderer: the real TabManager, TabBar, Tab, Pane and tab-groups rules ──
await build({
  stdin: {
    contents: `export { TabManager } from './services/tab-manager';
export { strongestState, stateOf, repairRuns, runsAreSound, cleanGroupName } from './services/tab-groups';`,
    resolveDir: join(repo, 'src', 'renderer'), loader: 'ts',
  },
  bundle: true, format: 'cjs', platform: 'browser', outfile: join(work, 'renderer.cjs'),
  loader: { '.css': 'empty' }, logLevel: 'error',
});

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
const doc = w.document;
for (const key of Object.getOwnPropertyNames(w)) {
  if (!(key in globalThis)) {
    try { globalThis[key] = w[key]; } catch { /* read-only */ }
  }
}
for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
  if (!(key in globalThis)) globalThis[key] = w[key].bind(w);
}
globalThis.window = w;
globalThis.document = doc;
w.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = w.matchMedia;
class RO { observe() {} unobserve() {} disconnect() {} }
w.ResizeObserver = globalThis.ResizeObserver = RO;
w.HTMLCanvasElement.prototype.getContext = () => null;
w.Element.prototype.scrollIntoView ||= () => {};

// window.patton: fake PTYs; the session goes to main's real store.
const state = { dataListeners: [], creates: [], sessionSets: [], closedWindow: [] };
const emit = (ptyId, data) => { for (const cb of state.dataListeners) cb(ptyId, data); };
const loose = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : loose), apply: () => loose });
let nextPty = 1;
const api = {
  pty: {
    create: async (opts) => { const id = nextPty++; state.creates.push({ id, opts }); return id; },
    write: () => {}, resize: () => {}, destroy: () => {},
    getCwd: async () => '', getShell: async () => '/bin/zsh',
    onData: (cb) => { state.dataListeners.push(cb); return () => {}; },
    onExit: () => () => {},
  },
  settings: { get: async () => ({ startupCommand: '' }), set: async () => {} },
  session: {
    get: async () => M.getSession(),
    set: async (s) => { state.sessionSets.push(s === null ? null : JSON.parse(JSON.stringify(s))); M.setSession(s === null ? null : JSON.parse(JSON.stringify(s))); },
  },
  projects: { getNames: async () => ({}), onNamesChanged: () => () => {}, resolve: async () => null, setName: async () => {} },
  history: { get: async () => [], add: () => {}, clear: () => {} },
  log: { send: () => {} },
};
w.patton = new Proxy(api, { get: (t, p) => (p in t ? t[p] : loose) });

// Every [GROUP] line (rlog's console side), and any normalise repair.
const logs = [];
for (const level of ['info', 'warn']) {
  const orig = console[level];
  console[level] = (...args) => {
    if (typeof args[0] === 'string' && /^\[(GROUP|CLOSE|WAKE)\]/.test(args[0])) logs.push({ level, msg: args[0], data: args[1] });
    else if (level === 'warn' && !String(args[0]).startsWith('[RENDER]')) orig(...args);
  };
}
const logsSince = (n, msg) => logs.slice(n).filter((l) => l.msg === msg);

const R = await import(pathToFileURL(join(work, 'renderer.cjs')).href);
const { TabManager } = R.default ?? R;
const G = R.default ?? R;

// ── Helpers ──
/** A window: its own strip and content, a TabManager, n tabs named by letter. */
async function makeWindow(names) {
  const bar = doc.createElement('div');
  const content = doc.createElement('div');
  doc.body.append(bar, content);
  const tm = new TabManager(bar, content);
  tm.userNewCalls = 0;
  tm.setUserNewTabHandler(async () => { tm.userNewCalls++; const t = await tm.createTab(); tm.renameTab(t.id, `new${tm.userNewCalls}`); return t; });
  // A closed window is recorded, never really closed.
  tm.closeWindow = async (why) => { state.closedWindow.push(why); };
  for (const name of names) {
    const tab = await tm.createTab();
    tm.renameTab(tab.id, name);
  }
  tm.bar = bar;
  return tm;
}
const nameOf = (tm, id) => tm.getTabs().find((t) => t.id === id)?.title ?? `?${id}`;
const byName = (tm, name) => tm.getTabs().find((t) => t.title === name);
const idOf = (tm, name) => byName(tm, name)?.id;
/** The window's tabs in order, grouped tabs as "group:name". */
const order = (tm) => tm.getTabs().map((t) => t.title).join(' ');
const active = (tm) => tm.getActiveTab()?.title ?? null;
/** The tabs on the strip, from the real TabBar's DOM. */
const strip = (tm) => Array.from(tm.bar.querySelectorAll('.tab-bar-tab')).map((el) => nameOf(tm, el.dataset.tabId)).join(' ');
const groups = (tm) => tm.getTabGroups().map((g) => ({ name: g.name, folded: g.folded, tabs: g.tabIds.map((id) => nameOf(tm, id)).join(' ') }));
const groupNamed = (tm, name) => tm.getTabGroups().find((g) => g.name === name);
const chip = (tm, groupId) => tm.bar.querySelector(`.tab-bar-group-chip[data-group-id="${groupId}"]`);

/** The run rule: each group's tabs adjacent in the tab order, no empty group,
 *  and normalise never had to repair a run since the last call. */
let repairMark = 0;
function invariant(tm, label) {
  const ids = tm.getTabs().map((t) => t.id);
  const bad = [];
  for (const g of tm.getTabGroups()) {
    if (g.tabIds.length === 0) bad.push(`${g.id} empty`);
    const at = g.tabIds.map((id) => ids.indexOf(id));
    for (let i = 1; i < at.length; i++) if (at[i] !== at[i - 1] + 1) bad.push(`${g.name || g.id} broken at ${i}`);
  }
  const repairs = logsSince(repairMark, '[GROUP] broken run repaired');
  repairMark = logs.length;
  if (repairs.length > 0) bad.push(`normalise repaired ${repairs.length} run(s)`);
  check(`invariant after ${label}`, bad.length === 0, { bad, order: order(tm), groups: groups(tm) });
}
/** Click a TabBar element as a press that doesn't drag (the chip's route). */
function press(el) {
  el.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
  doc.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
}
const dialogVisible = () => !!doc.querySelector('.confirm-dialog-overlay.visible');
const dialogText = (sel) => doc.querySelector(`.confirm-dialog-overlay.visible ${sel}`)?.textContent ?? '';
const dialogsShown = () => logs.filter((l) => l.msg === '[CLOSE] confirm shown').length;
/** One section: a throw fails it (with the error) and the next still runs. */
async function section(fn) {
  try {
    await fn();
  } catch (err) {
    failed++;
    console.log('FAIL section threw:', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | '));
  }
}

// ── Sections (added one at a time) ──
// ── 1. The folded chip's strongest state: each adjacent pair, in both orders ──
await section(async () => {
  const pairs = [
    ['checkpoint', { checkpointDone: true }, 'needs-you', { awaitingInput: true }],
    ['needs-you', { awaitingInput: true }, 'flag', { flag: 'red' }],
    ['flag', { autoFlag: 'yellow' }, 'parked', { parked: { tasks: 1 } }],
  ];
  for (const [strong, a, weak, b] of pairs) {
    check(`rank: ${strong} beats ${weak} (strong first)`, G.strongestState([a, b])?.kind === strong, G.strongestState([a, b]));
    check(`rank: ${strong} beats ${weak} (weak first)`, G.strongestState([b, a])?.kind === strong, G.strongestState([b, a]));
  }
  check('rank: checkpoint beats parked across a gap', G.strongestState([{ parked: {} }, { checkpointDone: true }])?.kind === 'checkpoint');
  check('rank: a manual flag shows over the automatic one', G.strongestState([{ flag: 'blue', autoFlag: 'yellow' }])?.flag === 'blue');
  check('rank: the automatic flag shows when there is no manual one', G.strongestState([{ autoFlag: 'yellow' }])?.flag === 'yellow');
  check('rank: a tab with nothing shows nothing', G.strongestState([{}, {}]) === null);
});

// ── 2. Make, add, remove; an emptied group goes ──
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C', 'D', 'E']);
  repairMark = logs.length;
  check('setup: five named tabs, E selected', order(tm) === 'A B C D E' && active(tm) === 'E', { order: order(tm), active: active(tm) });
  let n = logs.length;
  const g1 = tm.addTabToNewGroup(idOf(tm, 'B'));
  check('new group: holds B, order unchanged', groups(tm).length === 1 && groups(tm)[0].tabs === 'B' && order(tm) === 'A B C D E', groups(tm));
  check('new group: unnamed and open', groups(tm)[0].name === '' && groups(tm)[0].folded === false);
  check('new group: [GROUP] created logged', logsSince(n, '[GROUP] created').some((l) => l.data?.groupId === g1));
  check('new group: a chip sits right before B on the strip', chip(tm, g1)?.nextElementSibling?.dataset.tabId === idOf(tm, 'B'));
  invariant(tm, 'new group');
  tm.renameGroup(g1, '  Games  ');
  check('rename: trimmed', groupNamed(tm, 'Games')?.id === g1, groups(tm));
  tm.renameGroup(g1, 'x'.repeat(70));
  check('rename: cut to 60 characters', tm.getTabGroups()[0].name.length === 60);
  tm.renameGroup(g1, 'Games');

  tm.addTabToGroup(idOf(tm, 'D'), g1);
  check('add to existing (right of it): after its last tab', order(tm) === 'A B D C E' && groups(tm)[0].tabs === 'B D', { order: order(tm), groups: groups(tm) });
  invariant(tm, 'add from the right');
  tm.addTabToGroup(idOf(tm, 'A'), g1);
  check('add to existing (left of it): after its last tab', order(tm) === 'B D A C E' && groups(tm)[0].tabs === 'B D A', { order: order(tm), groups: groups(tm) });
  invariant(tm, 'add from the left');

  tm.removeTabFromGroup(idOf(tm, 'D'));
  check('remove: lands just after the group\'s last tab, ungrouped', order(tm) === 'B A D C E' && groups(tm)[0].tabs === 'B A', { order: order(tm), groups: groups(tm) });
  invariant(tm, 'remove');

  // A folded group: another tab disappears into it; the selected one unfolds it.
  tm.foldGroup(g1);
  check('fold (selection outside): selection stays on E', active(tm) === 'E' && groups(tm)[0].folded === true);
  check('fold: its tabs leave the strip', strip(tm) === 'D C E', strip(tm));
  tm.addTabToGroup(idOf(tm, 'C'), g1);
  check('add to a folded group: the tab disappears into it, still folded', strip(tm) === 'D E' && groups(tm)[0].folded === true && groups(tm)[0].tabs === 'B A C', { strip: strip(tm), groups: groups(tm) });
  invariant(tm, 'add to a folded group');
  n = logs.length;
  tm.addTabToGroup(idOf(tm, 'E'), g1);
  check('add the selected tab to a folded group: the group unfolds, E stays selected', groups(tm)[0].folded === false && active(tm) === 'E' && strip(tm) === 'B A C E D', { strip: strip(tm), groups: groups(tm), active: active(tm) });
  check('...[GROUP] unfolded logged with reason add', logsSince(n, '[GROUP] unfolded').some((l) => l.data?.reason === 'add'), logsSince(n, '[GROUP] unfolded'));
  invariant(tm, 'add the selected tab to a folded group');

  // An emptied group is deleted.
  const g2 = tm.addTabToNewGroup(idOf(tm, 'D'));
  check('second group made for D', tm.getTabGroups().length === 2);
  n = logs.length;
  tm.removeTabFromGroup(idOf(tm, 'D'));
  check('emptied by remove: the group is deleted, its chip gone', tm.getTabGroups().length === 1 && !chip(tm, g2), groups(tm));
  check('...[GROUP] emptied logged', logsSince(n, '[GROUP] emptied').some((l) => l.data?.groupId === g2));
  const g3 = tm.addTabToNewGroup(idOf(tm, 'D'));
  await tm.closeById(idOf(tm, 'D'));
  check('emptied by closing its only tab: the group is deleted', tm.getTabGroups().length === 1 && !tm.getTabGroups().some((g) => g.id === g3), groups(tm));
  invariant(tm, 'emptied groups');

  // Accepted deviation: Add Tab to New Group on a grouped tab takes it out first.
  const g4 = tm.addTabToNewGroup(idOf(tm, 'A'));
  check('new group from a grouped tab: it leaves its old group (lands after it) for the new one', order(tm) === 'B C E A' && groups(tm).map((g) => g.tabs).join('|') === 'B C E|A', { order: order(tm), groups: groups(tm) });
  check('...the new group is its own', tm.getTabGroups()[1]?.id === g4);
  invariant(tm, 'new group from a grouped tab');
});

// ── 3. Fold moves the selection; jumps unfold; navigation sees only the strip ──
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C', 'D', 'E', 'F']);
  repairMark = logs.length;
  const g = tm.addTabToNewGroup(idOf(tm, 'C'));
  tm.addTabToGroup(idOf(tm, 'D'), g);
  tm.renameGroup(g, 'Mid');
  tm.switchToId(idOf(tm, 'C'));
  let n = logs.length;
  tm.foldGroup(g);
  check('fold the selected group: selection moves right of it (E)', active(tm) === 'E' && groupNamed(tm, 'Mid').folded, { active: active(tm) });
  check('...[GROUP] folded logged with movedSelection right', logsSince(n, '[GROUP] folded').some((l) => l.data?.groupId === g && l.data?.movedSelection === 'right'), logsSince(n, '[GROUP] folded'));
  invariant(tm, 'fold (right)');

  // The chip click (a press that doesn't drag) unfolds and folds.
  n = logs.length;
  press(chip(tm, g));
  check('chip click unfolds', groupNamed(tm, 'Mid').folded === false && strip(tm) === 'A B C D E F', strip(tm));
  check('...[GROUP] unfolded logged with reason click', logsSince(n, '[GROUP] unfolded').some((l) => l.data?.reason === 'click'));
  press(chip(tm, g));
  check('chip click folds again (selection E untouched)', groupNamed(tm, 'Mid').folded === true && active(tm) === 'E');
  tm.toggleGroupFolded(g, 'menu');
  check('menu toggle unfolds, logged with reason menu', groupNamed(tm, 'Mid').folded === false && logs.at(-1)?.data?.reason === 'menu', logs.at(-1));

  // A group at the right end: nothing right of it, so left.
  const g2 = tm.addTabToNewGroup(idOf(tm, 'E'));
  tm.addTabToGroup(idOf(tm, 'F'), g2);
  tm.switchToId(idOf(tm, 'F'));
  n = logs.length;
  tm.foldGroup(g2);
  check('fold the selected group at the right end: selection moves left (D)', active(tm) === 'D', active(tm));
  check('...logged with movedSelection left', logsSince(n, '[GROUP] folded').some((l) => l.data?.movedSelection === 'left'));
  invariant(tm, 'fold (left)');
  tm.toggleGroupFolded(g2, 'menu');

  // Jumps into a folded group unfold it.
  tm.switchToId(idOf(tm, 'A'));
  tm.foldGroup(g);
  n = logs.length;
  tm.switchToId(idOf(tm, 'D'));
  check('switchToId into a folded group: unfolds it and selects the tab', active(tm) === 'D' && groupNamed(tm, 'Mid').folded === false, { active: active(tm), groups: groups(tm) });
  check('...[GROUP] unfolded logged with reason jump', logsSince(n, '[GROUP] unfolded').some((l) => l.data?.reason === 'jump'));

  // The hover list of a folded chip: a row opens its tab (and unfolds).
  tm.switchToId(idOf(tm, 'A'));
  tm.foldGroup(g);
  chip(tm, g).dispatchEvent(new w.MouseEvent('mouseenter'));
  const rows = Array.from(doc.querySelectorAll('.tab-bar-group-list-row'));
  check('hover list lists the folded group\'s two tabs', rows.length === 2, rows.length);
  rows[1]?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  rows[1]?.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  check('hover list row click opens its tab, unfolding the group', active(tm) === 'D' && groupNamed(tm, 'Mid').folded === false, { active: active(tm), groups: groups(tm) });

  // ⌘1–9 and next/prev count only the strip.
  tm.switchToId(idOf(tm, 'A'));
  tm.foldGroup(g);
  check('strip with Mid folded: A B E F', strip(tm) === 'A B E F', strip(tm));
  tm.switchToIndex(2);
  check('⌘3 selects the third visible tab (E), not C', active(tm) === 'E', active(tm));
  tm.switchToIndex(4);
  check('⌘5 past the visible tabs does nothing', active(tm) === 'E' && groupNamed(tm, 'Mid').folded === true);
  tm.switchToId(idOf(tm, 'B'));
  tm.nextTab();
  check('next tab from B skips the folded C D (E)', active(tm) === 'E', active(tm));
  tm.prevTab();
  check('previous tab from E skips them back (B)', active(tm) === 'B', active(tm));
  tm.switchToId(idOf(tm, 'A'));
  tm.prevTab();
  check('previous from the first wraps to the last visible (F)', active(tm) === 'F', active(tm));
  check('...the folded group stayed folded through it all', groupNamed(tm, 'Mid').folded === true);

  // Closing the selected tab picks a visible one.
  tm.switchToId(idOf(tm, 'B'));
  await tm.closeById(idOf(tm, 'B'));
  check('close the selected B (right of it a folded group): selects E, the next visible', active(tm) === 'E' && groupNamed(tm, 'Mid').folded === true, { active: active(tm) });
  invariant(tm, 'close the selected tab');
});
await section(async () => {
  // Every tab in one group: folding the selected group opens a new tab first.
  const tm = await makeWindow(['A', 'B']);
  const g = tm.addTabToNewGroup(idOf(tm, 'A'));
  tm.addTabToGroup(idOf(tm, 'B'), g);
  const n = logs.length;
  tm.foldGroup(g);
  await until(() => tm.getTabGroups()[0]?.folded === true);
  check('fold the group holding every tab: a new tab via userNewTab, selected, then folded', tm.userNewCalls === 1 && active(tm) === 'new1' && tm.getTabGroups()[0].folded === true, { calls: tm.userNewCalls, active: active(tm), groups: groups(tm) });
  check('...logged with movedSelection new-tab', logsSince(n, '[GROUP] folded').some((l) => l.data?.movedSelection === 'new-tab'), logsSince(n, '[GROUP] folded'));
  check('...the new tab is outside the group', strip(tm) === 'new1' && groups(tm)[0].tabs === 'A B', { strip: strip(tm), groups: groups(tm) });
  invariant(tm, 'fold with nothing else visible');
  // Closing the only visible tab: a new tab, never an unfold.
  await tm.closeById(idOf(tm, 'new1'));
  await until(() => tm.userNewCalls === 2 && active(tm) === 'new2');
  check('close the only visible tab: a new tab via userNewTab, group stays folded', tm.userNewCalls === 2 && active(tm) === 'new2' && tm.getTabGroups()[0].folded === true, { calls: tm.userNewCalls, active: active(tm) });
});

// ── 4. Close Group, Ungroup, New Tab in Group ──
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C', 'D']);
  repairMark = logs.length;
  const g = tm.addTabToNewGroup(idOf(tm, 'B'));
  tm.addTabToGroup(idOf(tm, 'C'), g);
  tm.renameGroup(g, 'Games');
  // B runs Claude Code (its own OSC 7501 report through the real terminal).
  emit(byName(tm, 'B').ptyId, '\x1b]7501;state=idle:app=claude-code\x07');
  check('setup: B is a Claude pane', await until(() => byName(tm, 'B').panes[0].claudeState.active === true));
  tm.switchToId(idOf(tm, 'B'));
  const shown0 = dialogsShown();
  const cancelled = tm.closeGroup(g);
  await until(dialogVisible);
  check('Close Group asks in the app', dialogVisible() && dialogsShown() === shown0 + 1);
  check('..."Close 2 tabs in “Games”?"', dialogText('.confirm-dialog-title') === 'Close 2 tabs in “Games”?', dialogText('.confirm-dialog-title'));
  check('...says one Claude session ends', /1 Claude session ends/.test(dialogText('.confirm-dialog-message')), dialogText('.confirm-dialog-message'));
  doc.querySelector('.confirm-dialog-overlay.visible .confirm-dialog-cancel').click();
  await cancelled;
  check('Cancel: nothing closed, the group stays', order(tm) === 'A B C D' && groups(tm)[0]?.tabs === 'B C' && active(tm) === 'B', { order: order(tm), groups: groups(tm) });

  let n = logs.length;
  const closing = tm.closeGroup(g);
  await until(dialogVisible);
  await tick(350); // the confirm button's dwell
  doc.querySelector('.confirm-dialog-overlay.visible .confirm-dialog-confirm').click();
  await closing;
  check('confirm: every tab in the group closed, the rest kept', order(tm) === 'A D' && tm.getTabGroups().length === 0, { order: order(tm), groups: groups(tm) });
  check('...one ask in all (no per-tab confirm)', dialogsShown() === shown0 + 2 && !dialogVisible(), dialogsShown() - shown0);
  check('...the selection moved off the closed group (D)', active(tm) === 'D', active(tm));
  check('...[GROUP] closed logged', logsSince(n, '[GROUP] closed').some((l) => l.data?.groupId === g && l.data?.tabs === 2));
  check('...the window was not closed', state.closedWindow.length === 0);
  invariant(tm, 'Close Group');

  // A group holding every tab: a new tab opens first so the window stays.
  const g2 = tm.addTabToNewGroup(idOf(tm, 'A'));
  tm.addTabToGroup(idOf(tm, 'D'), g2);
  const calls = tm.userNewCalls;
  const closeAll = tm.closeGroup(g2);
  await until(dialogVisible);
  check('every-tab group: the ask says no Claude session (none in it)', !/Claude/.test(dialogText('.confirm-dialog-message')) && dialogText('.confirm-dialog-title') === 'Close 2 tabs in this group?', [dialogText('.confirm-dialog-title'), dialogText('.confirm-dialog-message')]);
  await tick(350);
  doc.querySelector('.confirm-dialog-overlay.visible .confirm-dialog-confirm').click();
  await closeAll;
  check('every-tab group: a new tab via userNewTab first, then the group\'s tabs closed', tm.userNewCalls === calls + 1 && order(tm) === `new${calls + 1}` && active(tm) === `new${calls + 1}`, { order: order(tm), calls: tm.userNewCalls });
  check('...the window was not closed', state.closedWindow.length === 0, state.closedWindow);
});
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C']);
  repairMark = logs.length;
  const g = tm.addTabToNewGroup(idOf(tm, 'A'));
  tm.addTabToGroup(idOf(tm, 'B'), g);
  tm.foldGroup(g);
  let n = logs.length;
  tm.ungroup(g);
  check('Ungroup: chip gone, tabs stay in place and on the strip', tm.getTabGroups().length === 0 && !chip(tm, g) && order(tm) === 'A B C' && strip(tm) === 'A B C', { order: order(tm), strip: strip(tm) });
  check('...[GROUP] ungrouped logged', logsSince(n, '[GROUP] ungrouped').some((l) => l.data?.groupId === g));

  const g2 = tm.addTabToNewGroup(idOf(tm, 'A'));
  tm.addTabToGroup(idOf(tm, 'B'), g2);
  tm.foldGroup(g2);
  n = logs.length;
  await tm.newTabInGroup(g2);
  const made = `new${tm.userNewCalls}`;
  check('New Tab in Group: opened through userNewTab, after the group\'s last tab, in it', tm.userNewCalls === 1 && order(tm) === `A B ${made} C` && groups(tm)[0].tabs === `A B ${made}`, { order: order(tm), groups: groups(tm) });
  check('...the group unfolded, the new tab selected', groups(tm)[0].folded === false && active(tm) === made);
  check('...[GROUP] unfolded logged with reason new-tab', logsSince(n, '[GROUP] unfolded').some((l) => l.data?.reason === 'new-tab'));
  invariant(tm, 'New Tab in Group');
});

// ── 5. Reorder joins or leaves; a drop on a chip adds; wake moves the group; discardTab ──
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C', 'D', 'E']);
  repairMark = logs.length;
  const g = tm.addTabToNewGroup(idOf(tm, 'B'));
  tm.addTabToGroup(idOf(tm, 'C'), g);
  tm.reorder(idOf(tm, 'A'), idOf(tm, 'B'));
  check('reorder onto a grouped tab: joins its group', order(tm) === 'B A C D E' && groups(tm)[0].tabs === 'B A C', { order: order(tm), groups: groups(tm) });
  invariant(tm, 'reorder join');
  tm.reorder(idOf(tm, 'C'), idOf(tm, 'D'));
  check('reorder onto an ungrouped tab: leaves its group', order(tm) === 'B A D C E' && groups(tm)[0].tabs === 'B A', { order: order(tm), groups: groups(tm) });
  invariant(tm, 'reorder leave');
  tm.reorder(idOf(tm, 'D'), idOf(tm, 'A'));
  check('reorder from the right onto a grouped tab: joins', order(tm) === 'B D A C E' && groups(tm)[0].tabs === 'B D A', { order: order(tm), groups: groups(tm) });
  tm.reorder(idOf(tm, 'B'), idOf(tm, 'A'));
  check('reorder inside the group: stays in it', order(tm) === 'D A B C E' && groups(tm)[0].tabs === 'D A B', { order: order(tm), groups: groups(tm) });
  invariant(tm, 'reorder inside');
  // A second group: dragging its tab onto the first group's tab moves it across.
  const g2 = tm.addTabToNewGroup(idOf(tm, 'E'));
  tm.addTabToGroup(idOf(tm, 'C'), g2);
  tm.reorder(idOf(tm, 'E'), idOf(tm, 'B'));
  check('reorder between groups: joins the target\'s group', groups(tm).map((x) => x.tabs).join('|') === 'D A E B|C' && order(tm) === 'D A E B C', { order: order(tm), groups: groups(tm) });
  invariant(tm, 'reorder between groups');

  // A tab dropped on a chip joins that group (the real TabBar's drop handler).
  const drop = new w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => idOf(tm, 'C'), dropEffect: '' } });
  chip(tm, g).dispatchEvent(drop);
  check('drop on a chip: the tab joins that group after its last tab', order(tm) === 'D A E B C' && groups(tm).length === 1 && groups(tm)[0].tabs === 'D A E B C', { order: order(tm), groups: groups(tm) });
  invariant(tm, 'drop on a chip');
});
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C', 'D']);
  repairMark = logs.length;
  const g = tm.addTabToNewGroup(idOf(tm, 'C'));
  tm.addTabToGroup(idOf(tm, 'D'), g);
  tm.switchToId(idOf(tm, 'A'));
  tm.foldGroup(g);
  const n = logs.length;
  emit(byName(tm, 'D').ptyId, '\x1b]2;WAKE\x07');
  await until(() => logsSince(n, '[GROUP] wake moved').length > 0);
  check('wake in a group: the whole group moves to the far left, order inside kept', order(tm).startsWith('C ') && tm.getTabs().map((t) => t.title).slice(2).join(' ') === 'A B' && groups(tm)[0].tabs.split(' ').length === 2, { order: order(tm), groups: groups(tm) });
  check('...fold state unchanged (still folded)', groups(tm)[0].folded === true);
  check('...[GROUP] wake moved logged', logsSince(n, '[GROUP] wake moved').some((l) => l.data?.groupId === g && l.data?.from === 2));
  invariant(tm, 'wake');
  const n2 = logs.length;
  emit(byName(tm, 'B').ptyId, '\x1b]2;WAKE\x07');
  await until(() => logsSince(n2, '[WAKE] tab moved first').length > 0);
  check('wake outside a group: just that tab moves first, before the group', tm.getTabs()[0].title === 'B' && tm.getTabs().length === 4, order(tm));
  invariant(tm, 'wake outside a group');
});
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C', 'D']);
  repairMark = logs.length;
  const g = tm.addTabToNewGroup(idOf(tm, 'B'));
  tm.addTabToGroup(idOf(tm, 'C'), g);
  const placed = await tm.createTab();
  tm.renameTab(placed.id, 'P');
  check('discard setup: P opened at the end, ungrouped', order(tm) === 'A B C D P' && groups(tm)[0].tabs === 'B C');
  tm.discardTab(idOf(tm, 'C'), placed.id);
  check('discardTab: the placed tab takes the board\'s place and its group', order(tm) === 'A B P D' && groups(tm)[0].tabs === 'B P', { order: order(tm), groups: groups(tm) });
  invariant(tm, 'discardTab inherit');
  const g2 = tm.addTabToNewGroup(idOf(tm, 'D'));
  const placed2 = await tm.createTab();
  tm.renameTab(placed2.id, 'Q');
  tm.addTabToGroup(placed2.id, g);
  tm.discardTab(idOf(tm, 'D'), placed2.id);
  check('discardTab of a group\'s only tab: the group lives on in the placed tab, which left its old group', order(tm) === 'A B P Q' && groups(tm).map((x) => x.tabs).join('|') === 'B P|Q' && tm.getTabGroups()[1]?.id === g2, { order: order(tm), groups: groups(tm) });
  invariant(tm, 'discardTab of a lone member');
  const placed3 = await tm.createTab();
  tm.renameTab(placed3.id, 'R');
  tm.addTabToGroup(placed3.id, g);
  tm.discardTab(idOf(tm, 'A'), placed3.id);
  check('discardTab of an ungrouped tab: the placed tab leaves its group', order(tm) === 'R B P Q' && groups(tm).map((x) => x.tabs).join('|') === 'B P|Q', { order: order(tm), groups: groups(tm) });
  invariant(tm, 'discardTab ungrouped');
});

// ── 6. Session: save → main's real store → restore; main's sanitising ──
let leafTab = null; // one saved tab state, a template for sessions made by hand
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C', 'D', 'E']);
  repairMark = logs.length;
  const g1 = tm.addTabToNewGroup(idOf(tm, 'B'));
  tm.addTabToGroup(idOf(tm, 'C'), g1);
  tm.renameGroup(g1, 'Games');
  const g2 = tm.addTabToNewGroup(idOf(tm, 'E'));
  tm.switchToId(idOf(tm, 'D'));
  tm.foldGroup(g1);
  await tm.saveSession();
  const saved = M.getSession();
  leafTab = saved?.tabs?.[0] ? JSON.parse(JSON.stringify(saved.tabs[0])) : null;
  delete leafTab?.groupId;
  check('save: main stored the groups (names and folds)', JSON.stringify(saved?.groups) === JSON.stringify([{ id: g1, name: 'Games', folded: true }, { id: g2, name: '', folded: false }]), saved?.groups);
  check('save: each grouped tab carries its group id', saved?.tabs?.map((t) => t.groupId ?? '-').join(' ') === `- ${g1} ${g1} - ${g2}`, saved?.tabs?.map((t) => t.groupId));

  const tm2 = await makeWindow([]);
  const n = logs.length;
  const ok = await tm2.restoreSession();
  check('restore: succeeded, order kept', ok && order(tm2) === 'A B C D E', order(tm2));
  check('restore: groups, names and folds kept', JSON.stringify(groups(tm2)) === JSON.stringify([{ name: 'Games', folded: true, tabs: 'B C' }, { name: '', folded: false, tabs: 'E' }]), groups(tm2));
  check('restore: the selected tab kept (D), the folded group\'s tabs off the strip', active(tm2) === 'D' && strip(tm2) === 'A D E', { active: active(tm2), strip: strip(tm2) });
  check('restore: [GROUP] restored logged', logsSince(n, '[GROUP] restored').some((l) => l.data?.groups === 2 && l.data?.repaired === 0), logsSince(n, '[GROUP] restored'));
  invariant(tm2, 'restore');
});
const tabState = (title, groupId) => {
  const t = { ...JSON.parse(JSON.stringify(leafTab)), title, customTitle: true };
  if (groupId !== undefined) t.groupId = groupId;
  return t;
};
async function restoreInto(session) {
  M.setSession(session);
  const tm = await makeWindow([]);
  const n = logs.length;
  repairMark = n; // restore repairs runs itself: normalise must find nothing left to do
  const ok = await tm.restoreSession();
  return { tm, ok, n };
}
check('template tab state taken from a real save', leafTab !== null && typeof leafTab.tree === 'object');
if (leafTab) await section(async () => {
  {
    // The restored active tab sits in a folded group: that group unfolds.
    const { tm, ok, n } = await restoreInto({
      tabs: [tabState('A'), tabState('B', 'gF'), tabState('C', 'gF')], activeTabIndex: 2,
      groups: [{ id: 'gF', name: 'Fold', folded: true }],
    });
    check('restore: a folded group holding the active tab is unfolded', ok && active(tm) === 'C' && groups(tm)[0]?.folded === false, { active: active(tm), groups: groups(tm) });
    check('...[GROUP] unfolded logged with reason restore', logsSince(n, '[GROUP] unfolded').some((l) => l.data?.reason === 'restore'));
  }
  {
    // A broken run (another tab between a group's tabs) is repaired.
    const { tm, n } = await restoreInto({
      tabs: [tabState('A', 'gB'), tabState('X'), tabState('B', 'gB'), tabState('Y')], activeTabIndex: 1,
      groups: [{ id: 'gB', name: 'Broken', folded: false }],
    });
    check('restore: a broken run repaired (the straggler joins the first run)', order(tm) === 'A B X Y' && groups(tm)[0]?.tabs === 'A B', { order: order(tm), groups: groups(tm) });
    check('...[GROUP] restored logs repaired 1', logsSince(n, '[GROUP] restored').some((l) => l.data?.repaired === 1), logsSince(n, '[GROUP] restored'));
    invariant(tm, 'restore of a broken run');
  }
  {
    // A session saved before groups existed.
    const { tm, ok } = await restoreInto({ tabs: [tabState('A'), tabState('B')], activeTabIndex: 1 });
    check('restore: an old session without groups restores as before', ok && order(tm) === 'A B' && tm.getTabGroups().length === 0 && active(tm) === 'B', { order: order(tm), active: active(tm) });
  }
  {
    // Main's sanitising: bad group entries and dangling ids dropped, the session kept.
    const warns = logs.length;
    M.setSession({
      tabs: [tabState('A', 'good'), tabState('B', 'nowhere'), tabState('C', 'bad id!'), tabState('D', 'long'), tabState('E', 'fold'), tabState('F', 'dup'), tabState('H', 42)],
      activeTabIndex: 0,
      groups: [
        { id: 'good', name: 'Good', folded: false },
        { id: 'bad id!', name: 'Bad', folded: false },
        { id: 'long', name: 'n'.repeat(61), folded: false },
        { id: 'fold', name: 'Fold', folded: 'yes' },
        { id: 'dup', name: 'One', folded: false },
        { id: 'dup', name: 'Two', folded: true },
        null,
        'text',
        { id: 'x'.repeat(41), name: '', folded: false },
        { id: 'unused', name: 'Unused', folded: false },
      ],
    });
    const s = M.getSession();
    check('main: the session itself was still saved', s?.tabs?.length === 7, s?.tabs?.length);
    check('main: only the sound groups kept (good, the first dup), unused dropped', JSON.stringify(s?.groups) === JSON.stringify([{ id: 'good', name: 'Good', folded: false }, { id: 'dup', name: 'One', folded: false }]), s?.groups);
    check('main: a groupId pointing nowhere (or at a dropped group, or not a string) is dropped', s?.tabs?.map((t) => t.groupId ?? '-').join(' ') === 'good - - - - dup -', s?.tabs?.map((t) => t.groupId));
    check('main: the drop is logged', logs.slice(warns).some((l) => l.msg === '[GROUP] session group data dropped'));
    M.setSession({ tabs: [tabState('A', 'g')], activeTabIndex: 0, groups: 'not a list' });
    const s2 = M.getSession();
    check('main: groups that are not a list are dropped, the session kept', s2?.tabs?.length === 1 && s2.groups === undefined && s2.tabs[0].groupId === undefined, s2);
    const many = Array.from({ length: 55 }, (_, i) => ({ id: `g${i}`, name: '', folded: false }));
    M.setSession({ tabs: many.map((g, i) => tabState(`T${i}`, g.id)), activeTabIndex: 0, groups: many });
    const s3 = M.getSession();
    check('main: at most 50 groups kept', s3?.groups?.length === 50 && s3.tabs.length === 55 && s3.tabs.filter((t) => t.groupId).length === 50, { groups: s3?.groups?.length });
    const extra = M.sanitiseSessionGroups({ tabs: [tabState('A', 'g')], activeTabIndex: 0, groups: [{ id: 'g', name: 'G', folded: false, evil: 1 }] }).session;
    check('main: a kept group carries no extra keys', JSON.stringify(extra.groups) === JSON.stringify([{ id: 'g', name: 'G', folded: false }]), extra.groups);
    // The sanitised session restores.
    M.setSession({ tabs: [tabState('A', 'good'), tabState('B', 'nowhere')], activeTabIndex: 0, groups: [{ id: 'good', name: 'Good', folded: true }, { id: 'bad id!', name: '', folded: false }] });
    const tm = await makeWindow([]);
    await tm.restoreSession();
    check('restore after sanitising: A in Good (unfolded: it is the active tab), B ungrouped', order(tm) === 'A B' && JSON.stringify(groups(tm)) === JSON.stringify([{ name: 'Good', folded: false, tabs: 'A' }]), groups(tm));
  }
});

// ── 7. Odds and ends: the group cap, the named log, a folded chip's flag, a board discarded last ──
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C']);
  repairMark = logs.length;
  const g = tm.addTabToNewGroup(idOf(tm, 'A'));
  let n = logs.length;
  tm.renameGroup(g, 'Work');
  check('[GROUP] named logged (length only, not the name)', logsSince(n, '[GROUP] named').some((l) => l.data?.groupId === g && l.data?.length === 4 && !JSON.stringify(l.data).includes('Work')));
  // The folded chip shows its tabs' strongest state, through TabManager → TabBar.
  tm.addTabToGroup(idOf(tm, 'B'), g);
  tm.setTabFlag(idOf(tm, 'B'), 'red');
  tm.switchToId(idOf(tm, 'C'));
  tm.foldGroup(g);
  const ind = chip(tm, g)?.querySelectorAll('.tab-bar-tab-indicator');
  check('folded chip: one indicator, the member\'s red flag', ind?.length === 1 && ind[0].classList.contains('flag-red'), Array.from(ind ?? []).map((e) => e.className));
  // A board tab discarded when only folded tabs remain: selection falls back
  // to a folded group's tab, which unfolds (accepted deviation).
  tm.discardTab(idOf(tm, 'C'));
  check('discard the last visible tab: a folded tab is selected and its group unfolds', active(tm) === 'B' && groups(tm)[0].folded === false, { active: active(tm), groups: groups(tm) });
  invariant(tm, 'discard into a folded group');
});
await section(async () => {
  const names = Array.from({ length: 51 }, (_, i) => `T${i}`);
  const tm = await makeWindow(names);
  repairMark = logs.length;
  const made = names.slice(0, 50).map((name) => tm.addTabToNewGroup(idOf(tm, name)));
  check('cap: 50 groups made', made.every((id) => typeof id === 'string') && tm.getTabGroups().length === 50);
  const over = tm.addTabToNewGroup(idOf(tm, 'T50'));
  check('cap: a 51st group is refused, the tab stays ungrouped', over === null && tm.getTabGroups().length === 50, over);
  invariant(tm, 'the group cap');
});

// ── 8. Move Left / Move Right from the tab menu: exactly one step ──
// (a) a group's edge tab steps out of it, in place; (b) an ungrouped tab steps
// into an open group beside it, in place; (c) a folded group beside it is
// jumped whole; (d) otherwise a swap (inside a group, staying in it). Disabled
// only where nothing would change.
const menuItemsNow = () => [...doc.querySelectorAll('.context-menu-overlay.visible .context-menu-item')];
const closeMenus = () => {
  for (const o of doc.querySelectorAll('.context-menu-overlay.visible')) o.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};
function tabMenu(tm, name) {
  closeMenus();
  const el = tm.bar.querySelector(`.tab-bar-tab[data-tab-id="${idOf(tm, name)}"]`);
  if (!el) throw new Error(`tab ${name} not on the strip`);
  el.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }));
  return menuItemsNow();
}
const menuItem = (items, label) => items.find((i) => i.querySelector('.context-menu-label')?.textContent.trim() === label || i.textContent.trim() === label);
const isDisabled = (item) => !!item && item.classList.contains('disabled');
// Every announcement (the announcer's live regions; their text clears itself).
const announced = [];
new w.MutationObserver((records) => {
  for (const r of records) {
    const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    if (el?.getAttribute?.('role') === 'status' && el.hasAttribute('aria-live') && el.textContent) announced.push(el.textContent);
  }
}).observe(doc.body, { childList: true, characterData: true, subtree: true });
/** Move a tab by its menu; returns what was announced. */
async function menuMove(tm, name, dir) {
  const item = menuItem(tabMenu(tm, name), dir < 0 ? 'Move Left' : 'Move Right');
  if (!item) throw new Error('no Move item');
  const n = announced.length;
  item.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(40);
  closeMenus();
  return announced.slice(n).join(' | ');
}
/** "A B C D E F" with C D in group Mid (folded when asked; A selected). */
async function midWindow(names, members, { folded = false } = {}) {
  const tm = await makeWindow(names);
  const g = tm.addTabToNewGroup(idOf(tm, members[0]));
  tm.renameGroup(g, 'Mid');
  for (const m of members.slice(1)) tm.addTabToGroup(idOf(tm, m), g);
  tm.switchToId(idOf(tm, names[0]));
  if (folded) tm.foldGroup(g);
  repairMark = logs.length;
  return tm;
}
const groupLine = (tm) => groups(tm).map((g) => `${g.name}${g.folded ? '(folded)' : ''}:${g.tabs}`).join(' | ');
await section(async () => {
  // (c) over a folded group, both ways: the group untouched.
  let tm = await midWindow(['A', 'B', 'C', 'D', 'E', 'F'], ['C', 'D'], { folded: true });
  let said = await menuMove(tm, 'B', 1);
  check('move: Move Right on B past folded Mid gives "A [Mid] B E F"', order(tm) === 'A C D B E F' && groupLine(tm) === 'Mid(folded):C D' && strip(tm) === 'A B E F', { order: order(tm), groups: groupLine(tm) });
  check('move: the jump over a folded group is announced with its name', /B moved right past Mid/.test(said), said);
  invariant(tm, 'Move Right over a folded group');
  said = await menuMove(tm, 'B', -1);
  check('move: Move Left on B jumps back before folded Mid', order(tm) === 'A B C D E F' && groupLine(tm) === 'Mid(folded):C D', { order: order(tm), groups: groupLine(tm) });
  tm = await midWindow(['A', 'B', 'C', 'D', 'E', 'F'], ['C', 'D'], { folded: true });
  await menuMove(tm, 'E', -1);
  check('move: Move Left on E past folded Mid gives "A B E [Mid] F"', order(tm) === 'A B E C D F' && groupLine(tm) === 'Mid(folded):C D', { order: order(tm), groups: groupLine(tm) });
  invariant(tm, 'Move Left over a folded group');
  // A folded group at the far right: jumped to the very end.
  tm = await midWindow(['A', 'B', 'C', 'D'], ['C', 'D'], { folded: true });
  check('move: Move Right is enabled before a folded group at the end', !isDisabled(menuItem(tabMenu(tm, 'B'), 'Move Right')));
  await menuMove(tm, 'B', 1);
  check('move: Move Right past a folded group at the end lands last', order(tm) === 'A C D B' && groupLine(tm) === 'Mid(folded):C D', order(tm));
  closeMenus();
});
await section(async () => {
  // (a) out of an open group at its edges, in place.
  let tm = await midWindow(['A', 'B', 'C', 'D', 'E', 'F'], ['C', 'D']);
  let said = await menuMove(tm, 'D', 1);
  check('move: Move Right on a group\'s last tab takes it out, in place', order(tm) === 'A B C D E F' && groupLine(tm) === 'Mid:C', { order: order(tm), groups: groupLine(tm) });
  check('move: stepping out is announced', /D moved out of Mid/.test(said), said);
  invariant(tm, 'Move Right out of a group');
  tm = await midWindow(['A', 'B', 'C', 'D', 'E', 'F'], ['C', 'D']);
  await menuMove(tm, 'C', -1);
  check('move: Move Left on a group\'s first tab takes it out, in place (before the chip)', order(tm) === 'A B C D E F' && groupLine(tm) === 'Mid:D', { order: order(tm), groups: groupLine(tm) });
  const stripEls = Array.from(tm.bar.querySelectorAll('.tab-bar-tab, .tab-bar-group-chip')).map((el) => (el.classList.contains('tab-bar-group-chip') ? '[Mid]' : nameOf(tm, el.dataset.tabId))).join(' ');
  check('move: the strip reads "A B C [Mid] D E F"', stripEls === 'A B C [Mid] D E F', stripEls);
  // A one-tab group: stepping out ends the group.
  tm = await midWindow(['A', 'B', 'C'], ['C']);
  check('move: Move Right on a one-tab group at the end is enabled', !isDisabled(menuItem(tabMenu(tm, 'C'), 'Move Right')));
  await menuMove(tm, 'C', 1);
  check('move: Move Right on a one-tab group\'s tab takes it out and the group goes', order(tm) === 'A B C' && groups(tm).length === 0, { order: order(tm), groups: groupLine(tm) });
  // (b) into an open group beside it, in place.
  tm = await midWindow(['A', 'B', 'C', 'D', 'E', 'F'], ['C', 'D']);
  said = await menuMove(tm, 'B', 1);
  check('move: Move Right on B into open Mid makes it the first tab, in place', order(tm) === 'A B C D E F' && groupLine(tm) === 'Mid:B C D', { order: order(tm), groups: groupLine(tm) });
  check('move: stepping in is announced', /B moved into Mid/.test(said), said);
  invariant(tm, 'Move Right into a group');
  tm = await midWindow(['A', 'B', 'C', 'D', 'E', 'F'], ['C', 'D']);
  await menuMove(tm, 'E', -1);
  check('move: Move Left on E into open Mid makes it the last tab, in place', order(tm) === 'A B C D E F' && groupLine(tm) === 'Mid:C D E', { order: order(tm), groups: groupLine(tm) });
  invariant(tm, 'Move Left into a group');
  // (d) swaps: inside a group it stays in; outside, plain.
  tm = await midWindow(['A', 'B', 'C', 'D', 'E', 'F'], ['C', 'D', 'E']);
  await menuMove(tm, 'C', 1);
  check('move: Move Right inside a group swaps and stays in', order(tm) === 'A B D C E F' && groupLine(tm) === 'Mid:D C E', { order: order(tm), groups: groupLine(tm) });
  await menuMove(tm, 'C', -1);
  check('move: Move Left inside a group swaps and stays in', order(tm) === 'A B C D E F' && groupLine(tm) === 'Mid:C D E', { order: order(tm), groups: groupLine(tm) });
  said = await menuMove(tm, 'A', 1);
  check('move: an ungrouped swap', order(tm) === 'B A C D E F' && groupLine(tm) === 'Mid:C D E', order(tm));
  check('move: a swap is announced as "moved right"', /A moved right$/.test(said), said);
  invariant(tm, 'swaps');
  // Disabled only when nothing would change.
  check('move: Move Left disabled on the first ungrouped tab', isDisabled(menuItem(tabMenu(tm, 'B'), 'Move Left')));
  check('move: Move Right disabled on the last ungrouped tab', isDisabled(menuItem(tabMenu(tm, 'F'), 'Move Right')));
  check('move: Move Left enabled on a group\'s first tab', !isDisabled(menuItem(tabMenu(tm, 'C'), 'Move Left')));
  closeMenus();
});

// SECTIONS

check('script reached its end', true);
finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
