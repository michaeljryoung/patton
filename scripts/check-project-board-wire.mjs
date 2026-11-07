// Check of how the project board is wired into tabs (renderer side):
// the Tab cover, TabManager's new-tab hook and discardTab, and the
// ProjectBoards manager (src/renderer/services/project-boards.ts).
//
// Run: JSDOM_DIR=<folder whose node_modules holds jsdom> node scripts/check-project-board-wire.mjs
//   (or pass that folder as the first argument). jsdom is not a project
//   dependency: install it in a scratch folder (`npm i jsdom` there).
//
// Bundles the REAL Tab, TabManager and ProjectBoards with esbuild; the board
// component itself is replaced by a recording stub, and window.patton by a
// stub with fake PTYs. jsdom does no layout, so only behaviour is checked.
// The launch cases wait out the startup command's 1.5 s prompt fallback, so
// the run takes about ten seconds.
import { build } from 'esbuild';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const jsdomDir = process.argv[2] || process.env.JSDOM_DIR;
if (!jsdomDir) {
  console.error('Give the folder holding node_modules/jsdom: JSDOM_DIR=<dir> or the first argument.');
  process.exit(2);
}
const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    passed++;
    console.log('ok  ', name);
  } else {
    failed++;
    console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail));
  }
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await tick(10);
  }
  return fn();
}

const STUB_BOARD = `
export class ProjectBoard {
  constructor(host, payload) {
    this.host = host;
    this.payload = payload;
    this.layouts = [];
    this.refreshes = 0;
    this.disposed = false;
    this.element = document.createElement('div');
    this.element.className = 'stub-board';
    this.button = document.createElement('button');
    this.button.textContent = 'tile';
    this.element.appendChild(this.button);
    (globalThis.__boards ||= []).push(this);
  }
  focus() { this.button.focus(); }
  setPayload(p) { this.payload = p; }
  setLayout(l) { this.layouts.push(l); }
  refreshLiveState() { this.refreshes++; }
  dispose() { this.disposed = true; this.element.remove(); }
}
`;

const ENTRY = `
export { TabManager } from './services/tab-manager';
export { ProjectBoards, decideBoard } from './services/project-boards';
export { COVERED_TAB_TITLE } from './components/tab';
`;

async function bundle(root) {
  const work = mkdtempSync(join(tmpdir(), 'board-wire-check-'));
  const out = join(work, 'wire.cjs');
  await build({
    stdin: { contents: ENTRY, resolveDir: join(root, 'src', 'renderer'), loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    outfile: out,
    loader: { '.css': 'empty' },
    logLevel: 'error',
    plugins: [{
      name: 'stub-board',
      setup(b) {
        b.onResolve({ filter: /components\/project-board$/ }, () => ({ path: 'project-board', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB_BOARD, loader: 'js' }));
      },
    }],
  });
  return out;
}

/** A window.patton good enough for tabs: fake PTYs, recorded settings and board. */
function makePatton(state) {
  // Anything not modelled below: a callable that returns itself, so
  // `x.y()`, `.catch()` and unsubscribe calls all work.
  const loose = new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : loose),
    apply: () => loose,
  });
  let nextPty = 1;
  const exitListeners = [];
  const api = {
    pty: {
      create: async () => nextPty++,
      write: (id, data) => { state.writes.push({ id, data }); },
      resize: () => {},
      destroy: () => {},
      getCwd: async () => '',
      onData: () => () => {},
      onExit: (cb) => { exitListeners.push(cb); return () => {}; },
    },
    settings: {
      get: async () => {
        if (state.failSettings) throw new Error('settings unavailable');
        return { ...state.settings };
      },
      set: async (partial) => { state.saved.push(partial); },
    },
    board: {
      get: async () => {
        state.boardGets++;
        if (state.boardDelayMs) await new Promise((r) => setTimeout(r, state.boardDelayMs));
        return state.payload;
      },
      onChanged: (cb) => { state.changedListeners.push(cb); return () => {}; },
      onListChanged: (cb) => { state.listListeners.push(cb); return () => {}; },
    },
    session: { get: async () => state.session, set: async () => {} },
    projects: { getNames: async () => ({}), onNamesChanged: () => () => {}, resolve: async () => null, setName: async () => {} },
    history: { get: async () => [], add: () => {}, clear: () => {} },
    log: { send: () => {} },
  };
  return new Proxy(api, { get: (t, prop) => (prop in t ? t[prop] : loose) });
}

const payload = (listFound = true) => ({
  listFile: '~/list.md',
  listFound,
  listTable: listFound,
  projects: [
    { path: '/tmp/proj-a', name: 'Alpha', subProjects: [] },
    { path: '/tmp/proj-b', name: 'Beta', subProjects: [] },
  ],
  layout: { version: 1, themes: [{ id: 't1', name: 'Work', tint: 'blue', projects: ['/tmp/proj-a'] }], tiles: {} },
});

async function main() {
  const root = join(dirname(process.argv[1]), '..');
  const out = await bundle(root);

  const dom = new JSDOM('<!doctype html><body><div id="tab-bar"></div><div id="content"></div></body>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
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
  globalThis.document = w.document;
  w.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.matchMedia = w.matchMedia;
  class RO { observe() {} unobserve() {} disconnect() {} }
  w.ResizeObserver = globalThis.ResizeObserver = RO;
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.Element.prototype.scrollIntoView ||= () => {};

  const state = {
    settings: { startupCommand: '' },
    saved: [],
    payload: payload(true),
    boardGets: 0,
    changedListeners: [],
    listListeners: [],
    session: null,
    writes: [],
    boardDelayMs: 0,
  };
  w.patton = makePatton(state);

  const logs = [];
  const info = console.info;
  console.info = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[BOARD]')) logs.push(args);
    else info(...args);
  };

  const { TabManager, ProjectBoards, decideBoard, COVERED_TAB_TITLE } = (await import(out)).default ?? (await import(out));

  // --- decideBoard, the rule on its own ---
  check('rule: shows when the setting is absent (on by default)', decideBoard({}, payload(true)).show === true);
  check('rule: shows when the setting is true', decideBoard({ projectBoard: true }, payload(true)).show === true);
  check('rule: skipped when the setting is false', decideBoard({ projectBoard: false }, payload(true)).reason === 'setting off');
  check('rule: skipped when the list file is not found', decideBoard({}, payload(false)).reason === 'list file not found');

  const tabBarEl = doc.getElementById('tab-bar');
  const contentEl = doc.getElementById('content');
  let boards = null;
  const tm = new TabManager(tabBarEl, contentEl, { onTabsChanged: () => boards?.scheduleRefresh() });
  const projectHost = {
    getTabs: () => tm.getTabs(),
    getActiveTab: () => tm.getActiveTab(),
    switchToTab: (id) => tm.switchToId(id),
    createTab: (cwd, opts) => tm.createTab(cwd, opts),
    listSessions: () => tm.listSessions(),
    goToSession: (tabId, paneId) => tm.goToSession(tabId, paneId),
    focusTerminal: () => tm.getActiveTab()?.focusedPane.focus(),
  };

  // The launch tab comes before the manager exists, as in App.init().
  const launch = await tm.createTab(undefined, { startupCommand: false });
  boards = new ProjectBoards(tm, projectHost);
  const made = () => (globalThis.__boards || []).length;
  check('launch tab: no board', !launch.hasCover && made() === 0);

  // --- the three user new-tab actions ---
  // ⌘T (menu onNewTab) and the palette's New Tab both call tm.userNewTab() in app.ts.
  const appSrc = readFileSync(join(root, 'src', 'renderer', 'components', 'app.ts'), 'utf8');
  check('app.ts: menu New Tab goes through userNewTab', /onNewTab\(\(\) => \{\s*this\.tabManager\.userNewTab\(\)/.test(appSrc));
  check('app.ts: palette new-tab goes through userNewTab', /case 'new-tab':\s*this\.tabManager\.userNewTab\(\)/.test(appSrc));
  check('app.ts: no other plain createTab() for a user tab', !/this\.tabManager\.createTab\(\)/.test(appSrc));

  const t1 = await tm.userNewTab();
  check('⌘T/palette path: board shown', t1.hasCover && made() === 1);
  check('board tab is titled "Projects"', t1.title === COVERED_TAB_TITLE && t1.title === 'Projects');
  await tick(1);
  check('tab bar shows "Projects"', [...tabBarEl.querySelectorAll('*')].some((el) => el.textContent === 'Projects'));
  check('board read once with the settings', state.boardGets === 1);
  await until(() => t1.element.querySelector('.stub-board')?.contains(doc.activeElement));
  const board1 = globalThis.__boards[0];
  check('focus goes to the board when shown', board1.element.contains(doc.activeElement));
  t1.focusedPane.focus();
  await tick(20);
  check('focus guard: focusing the shell lands on the board', board1.element.contains(doc.activeElement), doc.activeElement?.className);
  const xtermInput = t1.focusedPane.element.querySelector('textarea');
  if (xtermInput) {
    xtermInput.focus();
    check('focus guard: the terminal textarea cannot keep focus', board1.element.contains(doc.activeElement));
  } else {
    check('focus guard: terminal textarea exists', false);
  }

  const plusBtn = tabBarEl.querySelector('.tab-bar-new');
  plusBtn.click();
  check('tab bar +: board shown', await until(() => made() === 2));
  await until(() => tm.getTabs().length === 3 && tm.getTabs()[2].hasCover);
  const t2 = tm.getTabs()[2];
  check('tab bar + tab is covered', t2.hasCover);

  // --- tabs that never get a board ---
  const before = made();
  const fp = await tm.createTab('/tmp/proj-z', { forProject: true });
  check('forProject (bookmark) tab: no board', !fp.hasCover && made() === before);
  tm.switchToId(fp.id);
  tm.splitVertical();
  await tick(30);
  check('split: no board', !fp.hasCover && fp.panes.length === 2 && made() === before);
  await tm.closeById(fp.id); // saves panes for Reopen Closed
  check('closed tab went on the reopen list', tm.hasClosedPanes());
  await tm.reopenClosed();
  const reopened = tm.getActiveTab();
  check('reopened tab: no board', !reopened.hasCover && made() === before);
  await tm.closeById(reopened.id);

  const tm2Bar = doc.createElement('div');
  const tm2Content = doc.createElement('div');
  doc.body.append(tm2Bar, tm2Content);
  state.session = { tabs: [{ tree: { cwd: '/tmp/proj-r' }, focusedPaneIndex: 0 }], activeTabIndex: 0 };
  const tm2 = new TabManager(tm2Bar, tm2Content);
  const boards2 = new ProjectBoards(tm2, { ...projectHost, getTabs: () => tm2.getTabs(), getActiveTab: () => tm2.getActiveTab(), createTab: (c, o) => tm2.createTab(c, o) });
  const restored = await tm2.restoreSession(false);
  check('restored tab: no board', restored && tm2.getTabs().length === 1 && !tm2.getTabs()[0].hasCover && made() === before);

  // --- last tab is never discarded ---
  check('discardTab refuses the last tab', tm2.discardTab(tm2.getTabs()[0].id) === false && tm2.getTabs().length === 1);
  boards2.dispose();
  tm2.dispose();

  // --- setting off / list missing ---
  state.settings.projectBoard = false;
  const gets = state.boardGets;
  const off = await tm.userNewTab();
  check('setting false: no board', !off.hasCover && made() === before);
  check('setting false: board not even read', state.boardGets === gets);
  check('setting false: skip logged with reason', logs.some((l) => l[0] === '[BOARD] skipped' && l[1]?.reason === 'setting off'));
  delete state.settings.projectBoard;
  state.payload = payload(false);
  const nolist = await tm.userNewTab();
  check('list not found: no board', !nolist.hasCover && made() === before);
  check('list not found: skip logged', logs.some((l) => l[0] === '[BOARD] skipped' && l[1]?.reason === 'list file not found'));
  state.payload = payload(true);
  await tm.closeById(off.id);
  await tm.closeById(nolist.id);

  // --- layouts from another board reach this one ---
  const layout2 = { version: 1, themes: [], tiles: {} };
  for (const cb of state.changedListeners) cb(layout2);
  check('onChanged layout reaches every board', board1.layouts.at(-1) === layout2 && globalThis.__boards[1].layouts.at(-1) === layout2);

  // --- a project added on any board reaches every board (m2) ---
  const listed = { ...payload(true), generation: 1 };
  listed.projects = [...listed.projects, { path: '/tmp/proj-c', name: 'Gamma', subProjects: [] }];
  for (const cb of state.listListeners) cb(listed);
  check('m2: list change reaches every board', board1.payload === listed && globalThis.__boards[1].payload === listed,
    { b1: board1.payload === listed, b2: globalThis.__boards[1].payload === listed });

  // --- ⌘D on a covered tab does nothing (m3) ---
  tm.switchToId(t1.id);
  const coverHost = t1.element.querySelector('.tab-cover');
  board1.button.focus();
  const panesBefore = t1.panes.length;
  tm.splitVertical();
  tm.splitHorizontal();
  await tick(30);
  check('m3: split on a covered tab starts no shell', t1.panes.length === panesBefore, t1.panes.length);
  check('m3: the cover stays in place and keeps focus', t1.element.querySelector('.tab-cover') === coverHost
    && coverHost.isConnected && board1.element.contains(doc.activeElement));
  // Any rebuild of the pane tree (a pane closing, a swap) leaves the cover
  // attached: detaching it would blur and commit an open rename or note.
  const removed = [];
  const watcher = new w.MutationObserver((records) => { for (const r of records) removed.push(...r.removedNodes); });
  watcher.observe(t1.element, { childList: true });
  t1['renderTree']();
  await tick(0);
  watcher.disconnect();
  check('m3: a pane-tree rebuild never detaches the cover', !removed.includes(coverHost)
    && t1.element.lastElementChild === coverHost && board1.element.contains(doc.activeElement), removed.map((n) => n.className));

  // --- live state ---
  const r0 = board1.refreshes;
  boards.scheduleRefresh();
  check('tab changes refresh the tiles', await until(() => board1.refreshes > r0, 500));
  check('live state: closed project', board1.host.liveState('/tmp/proj-a').isOpen === false);

  // --- dismiss ("Terminal") ---
  tm.switchToId(t2.id);
  await tick(20);
  const board2 = globalThis.__boards[1];
  board2.host.dismiss();
  check('dismiss: cover gone, board disposed', !t2.hasCover && board2.disposed);
  check('dismiss: title is no longer "Projects"', t2.title !== 'Projects', t2.title);
  check('dismiss: tab stays', tm.getTabs().includes(t2));
  await until(() => t2.focusedPane.element.contains(doc.activeElement), 300);
  check('dismiss: the terminal has focus', t2.focusedPane.element.contains(doc.activeElement));
  check('dismiss logged', logs.some((l) => l[0] === '[BOARD] removed' && l[1]?.reason === 'terminal'));

  // --- open from a tile: new tab takes the board's place, no confirm ---
  tm.switchToId(t1.id);
  const boardIdx = tm.getTabs().indexOf(t1);
  const closedBefore = tm.hasClosedPanes();
  const reopenCount = tm['closedPanes'].length;
  const countBefore = tm.getTabs().length;
  board1.host.openProject('/tmp/proj-a');
  check('tile open: board tab discarded', await until(() => !tm.getTabs().includes(t1)));
  const opened = tm.getActiveTab();
  check('tile open: project tab is active', opened && opened.panes[0].getCwd() === '/tmp/proj-a', opened?.panes[0].getCwd());
  check('tile open: project tab sits at the board tab index', tm.getTabs().indexOf(opened) === boardIdx, { at: tm.getTabs().indexOf(opened), boardIdx });
  check('tile open: tab count unchanged', tm.getTabs().length === countBefore);
  check('tile open: no confirm dialog', ![...doc.querySelectorAll('.confirm-dialog-overlay')].some((o) => o.classList.contains('visible')));
  check('tile open: not on the reopen list', tm.hasClosedPanes() === closedBefore && tm['closedPanes'].length === reopenCount);
  check('tile open: board disposed', board1.disposed);
  check('tile open logged', logs.some((l) => l[0] === '[BOARD] opened' && l[1]?.label === 'Alpha' && l[1]?.action === 'new tab'));
  check('discard logged', logs.some((l) => l[0] === '[BOARD] discard' && l[1]?.discarded === true));

  // --- open from a tile, project already open: board tab just goes ---
  const t3 = await tm.userNewTab();
  const board3 = globalThis.__boards.at(-1);
  check('board 3 shown', t3.hasCover && board3.host.liveState('/tmp/proj-a').isOpen === true);
  const n3 = tm.getTabs().length;
  board3.host.openProject('/tmp/proj-a');
  check('open existing: board tab discarded', await until(() => !tm.getTabs().includes(t3)));
  check('open existing: the existing tab is active', tm.getActiveTab() === opened && tm.getTabs().length === n3 - 1);

  // --- a failed open reaches the board, which announces it (m5) ---
  const t5 = await tm.userNewTab();
  const board5 = globalThis.__boards.at(-1);
  state.failSettings = true;
  const outcome = await Promise.resolve(board5.host.openProject('/tmp/proj-new')).then(() => 'resolved', () => 'rejected');
  state.failSettings = false;
  check('m5: a failed open rejects back to the board', outcome === 'rejected', outcome);
  check('m5: the board stays after a failed open', t5.hasCover && !board5.disposed);
  await tm.closeById(t5.id);

  // --- closing a board tab disposes its board ---
  const t4 = await tm.userNewTab();
  const board4 = globalThis.__boards.at(-1);
  await tm.closeById(t4.id);
  check('closing the tab disposes its board', board4.disposed);

  // --- the board tab is never the last one to go ---
  while (tm.getTabs().length > 1) await tm.closeById(tm.getTabs()[0].id);
  const only = tm.getTabs()[0];
  check('discardTab never closes the last tab', tm.discardTab(only.id) === false && tm.getTabs().length === 1);

  // --- Settings panel fields ---
  const settingsSrc = readFileSync(join(root, 'src', 'renderer', 'components', 'settings-panel.ts'), 'utf8');
  check('settings: board toggle read as !== false', /setting-project-board'\) as HTMLInputElement\)\.checked = settings\.projectBoard !== false/.test(settingsSrc));
  check('settings: list file saved debounced', /saveAndNotify\(\{ projectListFile: [^}]+\}, true\)/.test(settingsSrc));
  check('settings: list file placeholder', settingsSrc.includes('placeholder="~/.claude/projects.md"'));

  // --- the tab Patton opens at launch (App.init → startLaunchTab) ---
  check('app.ts: launch goes through startLaunchTab', /this\.projectBoards\.startLaunchTab\(firstTab, /.test(appSrc));
  check('app.ts: launch sends no startup command of its own', !/runStartupCommand\(/.test(appSrc));
  const STARTUP = 'startcmd';
  /** One launch: a fresh TabManager restores `session` (or opens a fresh tab),
   *  then hands its active tab to startLaunchTab and waits out the fallback. */
  async function launchCase({ session = null, settings = {}, list = true, delayMs = 0 }) {
    state.session = session;
    state.settings = { startupCommand: STARTUP, ...settings };
    state.payload = payload(list);
    state.boardDelayMs = delayMs;
    const bar = doc.createElement('div');
    const content = doc.createElement('div');
    doc.body.append(bar, content);
    const ltm = new TabManager(bar, content);
    const lboards = new ProjectBoards(ltm, { ...projectHost, getTabs: () => ltm.getTabs(), getActiveTab: () => ltm.getActiveTab(), createTab: (c, o) => ltm.createTab(c, o) });
    const restoredOk = session ? await ltm.restoreSession(true) : false;
    if (!restoredOk) await ltm.createTab(undefined, { startupCommand: true });
    const tab = ltm.getActiveTab();
    const logFrom = logs.length;
    let shown = null;
    if (typeof lboards.startLaunchTab === 'function') {
      shown = await lboards.startLaunchTab(tab, STARTUP);
    }
    await tick(Math.max(1700, delayMs + 300));
    const result = {
      shown,
      covered: tab.hasCover,
      sent: state.writes.filter((wr) => wr.id === tab.ptyId && wr.data === `${STARTUP}\r`).length,
      logs: logs.slice(logFrom),
      tab,
      boards: lboards,
    };
    lboards.dispose();
    ltm.dispose();
    state.boardDelayMs = 0;
    state.settings = { startupCommand: '' };
    state.payload = payload(true);
    state.session = null;
    return result;
  }
  const skippedFor = (r, reason) => r.logs.some((l) => l[0] === '[BOARD] skipped at launch' && l[1]?.reason === reason);

  const home = await launchCase({});
  check('launch, fresh tab: board shown', home.shown === true && home.covered, { shown: home.shown, covered: home.covered });
  check('launch, fresh tab: no startup command', home.sent === 0, home.sent);
  check('launch, fresh tab: shown-at-launch logged', home.logs.some((l) => l[0] === '[BOARD] shown at launch'));
  check('launch, fresh tab: titled "Projects"', home.tab.title === 'Projects', home.tab.title);

  const inProject = await launchCase({ session: { tabs: [{ tree: { cwd: '/tmp/proj-r' }, focusedPaneIndex: 0 }], activeTabIndex: 0 } });
  check('restored tab in a project folder: board shown, no startup command', inProject.covered && inProject.sent === 0,
    { covered: inProject.covered, sent: inProject.sent });
  check('restored tab in a project folder: shown-at-launch logged', inProject.logs.some((l) => l[0] === '[BOARD] shown at launch'));

  const split = await launchCase({ session: { tabs: [{ tree: { type: 'split', direction: 'vertical', ratio: 0.5,
    children: [{ cwd: '/tmp/proj-r' }, { cwd: '/tmp/proj-s' }] }, focusedPaneIndex: 1 }], activeTabIndex: 0 } });
  check('restored split tab: board shown, no startup command', split.covered && split.sent === 0,
    { covered: split.covered, sent: split.sent, panes: split.tab.panes.length });

  const settingOff = await launchCase({ settings: { projectBoard: false } });
  check('launch, setting false: startup command, no board', settingOff.sent === 1 && !settingOff.covered,
    { sent: settingOff.sent, covered: settingOff.covered });
  check('launch, setting false: skip logged', skippedFor(settingOff, 'setting off'));

  const noList = await launchCase({ list: false });
  check('launch, list not found: startup command, no board', noList.sent === 1 && !noList.covered,
    { sent: noList.sent, covered: noList.covered });
  check('launch, list not found: skip logged', skippedFor(noList, 'list file not found'));

  const slow = await launchCase({ delayMs: 2500 });
  check('launch, board too slow: startup command, no board', slow.sent === 1 && !slow.covered,
    { sent: slow.sent, covered: slow.covered });
  check('launch, board too slow: the late board is never put up', !slow.covered && slow.shown === false, slow.shown);
  check('launch, board too slow: skip logged', skippedFor(slow, 'board too slow'));

  const failing = await (async () => { state.failSettings = true; try { return await launchCase({}); } finally { state.failSettings = false; } })();
  check('launch, board load fails: startup command, no board', failing.sent === 1 && !failing.covered,
    { sent: failing.sent, covered: failing.covered });

  boards.dispose();
  console.info = info;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
