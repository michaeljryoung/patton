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
// The launch cases wait out the startup command's 1.5 s prompt fallback and
// the Claude button's 10 s slow-shell fallback, so the run takes about
// fifteen seconds.
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
  refreshLiveState() { this.refreshes++; this.wakeSeen = this.host.wakeState(); }
  dispose() { this.disposed = true; this.element.remove(); }
}
`;

const ENTRY = `
export { TabManager } from './services/tab-manager';
export { ProjectBoards, decideBoard, claudeCommandFor } from './services/project-boards';
export { isUserInput } from './services/startup-command';
export { wakeCommandOf } from './services/board-wake';
export { COVERED_TAB_TITLE } from './components/tab';
export { sessionName } from './services/sessions';
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
      create: async (opts) => { if (state.failCreate) throw new Error('no pty'); const id = nextPty++; state.creates.push({ id, opts }); state.afterCreate?.(id); return id; },
      // Main's swap: a new PTY for the sender's own old one (ownership and cwd checks: check-pty-respawn.mjs).
      respawn: async (oldId, opts) => {
        if (state.failRespawn) throw new Error('respawn refused');
        // Main flushes the old shell's buffered bytes ahead of its reply.
        state.beforeRespawnReply?.(oldId);
        const id = nextPty++;
        state.respawns.push({ oldId, id, opts });
        state.creates.push({ id, opts, respawned: true });
        state.destroyed.push(oldId);
        return id;
      },
      write: (id, data) => { state.writes.push({ id, data }); },
      resize: () => {},
      destroy: (id) => { state.destroyed.push(id); },
      // state.cwdAnswers[id] = { cwd, ms }: an lsof that answers late.
      getCwd: async (id) => {
        const a = state.cwdAnswers?.[id];
        if (!a) return '';
        await new Promise((r) => setTimeout(r, a.ms));
        return a.cwd;
      },
      // Main's answer: the shell asked for, else $SHELL (state.envShell).
      getShell: async (id) => state.creates.find((c) => c.id === id)?.opts?.shell || state.envShell || '/bin/zsh',
      // Output for a PTY reaches its pane's terminal (see emit in main()).
      onData: (cb) => { state.dataListeners.push(cb); return () => {}; },
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
    history: { get: async () => { if (state.historyDelayMs) await new Promise((r) => setTimeout(r, state.historyDelayMs)); return []; }, add: () => {}, clear: () => {} },
    log: { send: () => {} },
    // A Claude pane asks main to follow its transcript (session-feed-watch.ts).
    sessionFeed: { watch: async () => true, unwatch: async () => {}, onEvent: () => () => {} },
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
    creates: [],
    respawns: [],
    destroyed: [],
    dataListeners: [],
    boardDelayMs: 0,
  };
  /** Shell output for one PTY: an OSC title or prompt mark, parsed by its real xterm. */
  const emit = (ptyId, data) => { for (const cb of state.dataListeners) cb(ptyId, data); };
  w.patton = makePatton(state);

  const logs = [];
  const info = console.info;
  console.info = (...args) => {
    if (typeof args[0] === 'string' && /^\[(BOARD|WAKE)\]/.test(args[0])) logs.push(args);
    else info(...args);
  };

  const { TabManager, ProjectBoards, decideBoard, claudeCommandFor, isUserInput, COVERED_TAB_TITLE, wakeCommandOf, sessionName } = (await import(out)).default ?? (await import(out));

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

  // --- tab names (12 Nov: "it should always default to 10 to 15 characters max") ---
  // An automatic name (the title a program sets) shows at most 15 characters, the
  // full one stays the tab's tooltip; a typed name and a project's name stay whole.
  {
    const rt = tm2.getTabs()[0];
    const spanOf = () => tm2Bar.querySelector('.tab-bar-tab[data-tab-id="' + rt.id + '"]');
    const LONG = 'Repeated permission prompts';
    rt.focusedPane.title = LONG;
    rt.refreshTitle();
    const el = spanOf();
    const span = el.querySelector('.tab-bar-tab-title');
    check('tab names: a long program title keeps the full name on the tab', rt.title === LONG, rt.title);
    check('tab names: ...but the tab strip writes 15 characters at most', rt.displayTitle === 'Repeated permi…' && span.textContent === 'Repeated permi…' && span.dataset.title === 'Repeated permi…', { display: rt.displayTitle, span: span.textContent, data: span.dataset.title });
    check('tab names: the tooltip and the accessible name carry the full title', el.getAttribute('aria-label') === LONG && (el.title === LONG || el.title === ''), { aria: el.getAttribute('aria-label'), title: el.title });
    rt.focusedPane.title = 'bash';
    rt.refreshTitle();
    check('tab names: a short title is shown as it is', rt.displayTitle === 'bash' && spanOf().querySelector('.tab-bar-tab-title').textContent === 'bash');
    rt.setCustomTitle('A name I typed myself');
    check('tab names: a name the user typed is shown whole', rt.displayTitle === 'A name I typed myself' && spanOf().querySelector('.tab-bar-tab-title').textContent === 'A name I typed myself');
    rt.clearCustomTitle();
    // A project's name names the tab only while Claude Code runs in it (23 Nov:
    // a shell in a project folder reads "Terminal", below). Claude starts as the
    // title path sees it: a title carrying its ✳ glyph.
    const CLAUDE_LONG = '✳ ' + LONG;
    rt.focusedPane.title = CLAUDE_LONG;
    rt.focusedPane['trackClaudeState'](CLAUDE_LONG);
    rt.refreshTitle();
    check('tab names: Claude running in the pane (the title path)', rt.focusedPane.isClaudePane && rt.runsClaude, { pane: rt.focusedPane.isClaudePane });
    // The project arrives through the tab's own lookup (window.patton.projects.resolve ->
    // setProject), not by setting its state. The lookup has no public trigger (a pane's
    // folder change or a focus change fires it from inside), so the private method is called.
    const resolveWas = w.patton.projects.resolve;
    w.patton.projects.resolve = async () => ({ root: '/tmp/a-project-with-a-long-folder-name', defaultName: 'a-project-with-a-long-folder-name' });
    rt['lookUpProject']();
    await new Promise((r) => setTimeout(r, 0));
    check('tab names: a project\'s name is shown whole, however long', rt.title === 'a-project-with-a-long-folder-name' && rt.displayTitle === rt.title && spanOf().querySelector('.tab-bar-tab-title').textContent === rt.title, { title: rt.title, display: rt.displayTitle });
    // 13 Nov: an unnamed linked worktree's tab shows only its short folder name; the title stays long.
    w.patton.projects.resolve = async () => ({ root: '/tmp/next-venture', defaultName: 'next-venture', worktree: { name: 'next-venture-lifesci', path: '/tmp/next-venture-lifesci' } });
    rt['lookUpProject']();
    await new Promise((r) => setTimeout(r, 0));
    {
      const wel = spanOf();
      check('tab names: an unnamed worktree tab writes only its short folder name on the strip', rt.displayTitle === 'lifesci' && wel.querySelector('.tab-bar-tab-title').textContent === 'lifesci', { display: rt.displayTitle, span: wel.querySelector('.tab-bar-tab-title').textContent });
      check('tab names: ...its title, tooltip and accessible name stay "next-venture \u2387 next-venture-lifesci"', rt.title === 'next-venture \u2387 next-venture-lifesci' && wel.getAttribute('aria-label') === rt.title, { title: rt.title, aria: wel.getAttribute('aria-label') });
    }
    w.patton.projects.resolve = async () => null;
    rt['lookUpProject']();
    await new Promise((r) => setTimeout(r, 0));
    check('tab names: leaving the project goes back to the short title', rt.displayTitle === 'Repeated permi…', rt.displayTitle);

    // 23 Nov (his screenshot of a shell tab reading "AI-Brain"): "when a tab is
    // terminal ... it should name terminal not the thing prompt is about". A tab
    // with no Claude in it is named by its program's title, else "Terminal".
    const shown = () => {
      const el = spanOf();
      return { display: rt.displayTitle, title: rt.title, span: el.querySelector('.tab-bar-tab-title').textContent, aria: el.getAttribute('aria-label') };
    };
    const reads = (name) => { const s = shown(); return s.display === name && s.title === name && s.span === name && s.aria === name; };
    w.patton.projects.resolve = async () => ({ root: '/tmp/ai-brain', defaultName: 'AI-Brain' });
    rt['lookUpProject']();
    await new Promise((r) => setTimeout(r, 0));
    check('shell tabs: Claude running in a project folder: the project names the tab', reads('AI-Brain'), shown());
    // Claude quits: its last title stays on the pane; the shell's prompt clears Claude.
    rt.focusedPane['claudeGone']('shell-prompt');
    check('shell tabs: Claude quits: the tab reads "Terminal" at once (no manual refresh), not the project or Claude\'s last topic', !rt.runsClaude && reads('Terminal'), shown());
    const session = tm2.listSessions().find((s) => s.paneId === rt.focusedPane.id);
    check('shell tabs: ...the palette lists the shell with no pane title (its tab reads "Terminal"), not Claude\'s last topic', session?.paneTitle === '' && session?.state === 'shell', session && { paneTitle: session.paneTitle, state: session.state });
    const card = tm2['describeTab'](rt.id);
    check('shell tabs: ...the hover card heads it "Terminal" and still names the project and folder', card?.[0]?.title === 'Terminal' && /AI-Brain/.test(card?.[0]?.place ?? ''), card?.[0]);
    rt.focusedPane.title = 'Terminal'; // a fresh shell's own title
    rt.refreshTitle();
    check('shell tabs: a fresh shell in a project folder reads "Terminal"', reads('Terminal'), shown());
    rt.focusedPane.title = 'WAKE'; // `wake` titles its pane WAKE
    rt.refreshTitle();
    check('shell tabs: a program\'s own title (wake\'s WAKE) still names the tab in a project folder', reads('WAKE'), shown());
    rt.focusedPane.title = '';
    rt.refreshTitle();
    check('shell tabs: an empty title reads "Terminal"', reads('Terminal'), shown());
    rt.setCustomTitle('Scripts');
    check('shell tabs: a name he typed still wins', shown().display === 'Scripts' && shown().span === 'Scripts', shown());
    rt.clearCustomTitle();
    check('shell tabs: ...and clearing it goes back to "Terminal"', reads('Terminal'), shown());
    // Claude starts again: the title arrives first (the tab hears it before Claude
    // is known), then the title path marks Claude; the project's name comes back
    // without a manual refresh.
    rt.focusedPane.title = '✳ Claude Code';
    rt.refreshTitle();
    check('shell tabs: Claude\'s first title, before Claude is known, reads "Terminal", not "Claude Code"', reads('Terminal'), shown());
    rt.focusedPane['trackClaudeState']('✳ Claude Code');
    check('shell tabs: Claude starting renames the tab to the project by itself', reads('AI-Brain'), shown());
    rt.focusedPane['claudeGone']('shell-prompt');
    check('shell tabs: (title path) Claude quits: its ✳ title reads "Terminal" (the pane\'s own title is not rewritten)', rt.focusedPane.shownTitle === 'Terminal' && rt.focusedPane.title === '✳ Claude Code' && reads('Terminal'), { pane: rt.focusedPane.title, shown: rt.focusedPane.shownTitle, ...shown() });

    // The 7501 path, as Claude Code 2.1 runs in Patton: its reports through the
    // real terminal, and titles with no glyph to mark them as Claude's.
    const pty = rt.focusedPane.ptyId;
    const pane = rt.focusedPane;
    emit(pty, '\x1b]0;my shell\x07'); // the shell's own title, before Claude starts
    await until(() => pane.title === 'my shell');
    emit(pty, '\x1b]133;D;0\x07\x1b]133;A\x07'); // the prompt that follows the shell's title
    await tick(20);
    emit(pty, '\x1b]7501;state=idle:app=claude-code\x07');
    await until(() => pane.isClaudePane);
    check('shell tabs: (7501) Claude reporting in a project folder: the project names the tab', pane.isClaudePane && reads('AI-Brain'), shown());
    emit(pty, '\x1b]7501;state=clear\x07');
    await until(() => !pane.isClaudePane);
    check('shell tabs: (7501) Claude quits: a title the shell set before its prompt is retired, the tab reads "Terminal"', pane.shownTitle === 'Terminal' && reads('Terminal'), { pane: pane.shownTitle, ...shown() });
    emit(pty, '\x1b]133;D;0\x07\x1b]133;A\x07\x1b]0;my shell\x07'); // a title set after the next prompt shows
    await until(() => pane.shownTitle === 'my shell');
    check('shell tabs: (7501) ...and one the shell sets after its prompt names the tab', reads('my shell'), shown());
    emit(pty, '\x1b]7501;state=idle:app=claude-code\x07');
    emit(pty, '\x1b]0;Fix the tab names\x07'); // Claude's topic, no glyph
    await until(() => pane.isClaudePane && pane.title === 'Fix the tab names');
    check('shell tabs: (7501) Claude\'s glyph-less topic doesn\'t name a project tab while Claude runs', reads('AI-Brain'), shown());
    const sessionsWhile = tm2.listSessions().find((s) => s.paneId === pane.id);
    check('shell tabs: (7501) ...the palette still shows Claude\'s topic while it runs', sessionsWhile?.paneTitle === 'Fix the tab names', sessionsWhile?.paneTitle);
    emit(pty, '\x1b]7501;state=clear\x07');
    await until(() => !pane.isClaudePane);
    check('shell tabs: (7501) Claude quits: its glyph-less topic reads "Terminal" (the pane\'s own title is not rewritten)', pane.shownTitle === 'Terminal' && pane.title === 'Fix the tab names' && reads('Terminal'), { pane: pane.shownTitle, title: pane.title, ...shown() });
    emit(pty, '\x1b]0;htop\x07');
    await until(() => pane.title === 'htop');
    check('shell tabs: (7501) a program run after Claude names the tab with its own title', reads('htop'), shown());
    // Reopen Closed brings a closed Claude pane back as a shell: not under Claude's topic.
    emit(pty, '\x1b]7501;state=idle:app=claude-code\x07');
    emit(pty, '\x1b]0;Fix the tab names\x07');
    await until(() => pane.isClaudePane && pane.title === 'Fix the tab names');
    tm2['saveClosedPane'](pane);
    check('shell tabs: a closed Claude pane is kept for Reopen Closed as "Terminal", not Claude\'s topic', tm2['closedPanes'].at(-1)?.title === 'Terminal', tm2['closedPanes'].at(-1)?.title);
    tm2['closedPanes'].pop();
    w.patton.projects.resolve = resolveWas;
  }

  // --- shell tabs, review of f9dc19d: split tabs, closing panes, what Claude leaves behind ---
  // Claude's title is remembered (Pane.claudeTitle) and `shownTitle` hides it
  // once Claude has left; the pane's own `title` is never rewritten.
  {
    const projResolve = async () => ({ root: '/tmp/ai-brain', defaultName: 'AI-Brain' });
    const resolveWas2 = w.patton.projects.resolve;
    w.patton.projects.resolve = projResolve;
    const PROMPT = '\x1b]133;D;0\x07\x1b]133;A\x07';
    const stripText = (tab) => tm2Bar.querySelector('.tab-bar-tab[data-tab-id="' + tab.id + '"] .tab-bar-tab-title')?.textContent;
    const newTab = async () => {
      const tab = await tm2.createTab('/tmp/ai-brain');
      tm2.switchToId(tab.id);
      tab['lookUpProject']();
      await tick(5);
      return tab;
    };
    const claude7501 = async (pane, topic) => {
      emit(pane.ptyId, '\x1b]7501;state=idle:app=claude-code\x07');
      if (topic) emit(pane.ptyId, '\x1b]0;' + topic + '\x07');
      await until(() => pane.isClaudePane && (!topic || pane.title === topic));
    };
    const split = async (tab) => {
      tm2.splitVertical();
      await until(() => tab.panes.length === 2);
      await tick(20);
      return tab.focusedPane;
    };

    // P1: closing a pane that is not focused and runs Claude renames the tab.
    {
      const tab = await newTab();
      const A = tab.focusedPane;
      A.title = '✳ Fix x'; A['trackClaudeState']('✳ Fix x');
      const B = await split(tab);
      check('review P1: Claude in the unfocused pane A names the split tab after the project', B !== A && tab.title === 'AI-Brain' && stripText(tab) === 'AI-Brain', { t: tab.title });
      tab.closePane(A);
      await tick(20);
      check('review P1: closing that Claude pane (not the focused one) puts "Terminal" on the tab', tab.title === 'Terminal' && stripText(tab) === 'Terminal' && !tab.runsClaude, { t: tab.title, s: stripText(tab) });
      await tm2.closeById(tab.id);
    }

    // P13: Claude quits in the unfocused pane A.
    {
      const tab = await newTab();
      const A = tab.focusedPane;
      await claude7501(A, 'Fix the tab names');
      await split(tab);
      emit(A.ptyId, '\x1b]7501;state=clear\x07');
      await until(() => !A.isClaudePane);
      await tick(20);
      check('review P13: Claude quits in the unfocused pane: the tab reads "Terminal"', tab.title === 'Terminal' && stripText(tab) === 'Terminal', { t: tab.title, s: stripText(tab) });
      await tm2.closeById(tab.id);
    }

    // P6: a split tab is named for the project of the pane Claude runs in.
    {
      const tab = await newTab();
      const A = tab.focusedPane;
      A.title = '✳ Fix x'; A['trackClaudeState']('✳ Fix x');
      const B = await split(tab);
      w.patton.projects.resolve = async () => ({ root: '/tmp/other', defaultName: 'Other' });
      tab['lookUpProject'](B);
      await tick(5);
      check('review P6: focused shell B in project Other, Claude in A: the tab reads the Claude pane\'s project', tab.title === 'AI-Brain' && stripText(tab) === 'AI-Brain', { t: tab.title, s: stripText(tab) });
      // The Claude pane's own folder moves to another project while it is not focused.
      w.patton.projects.resolve = async () => ({ root: '/tmp/third', defaultName: 'Third' });
      tab['lookUpProject'](A);
      await tick(5);
      check('review P6: an unfocused Claude pane\'s project changing renames the tab', tab.title === 'Third' && stripText(tab) === 'Third', { t: tab.title, s: stripText(tab) });
      w.patton.projects.resolve = projResolve;
      await tm2.closeById(tab.id);
    }

    // P2: RIS while Claude runs (7501): never Claude's topic.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      await claude7501(pane, 'Fix the tab names');
      check('review P2 pre: Claude reporting, the tab reads the project', tab.title === 'AI-Brain', tab.title);
      emit(pane.ptyId, '\x1bc');
      await tick(60);
      check('review P2: after RIS (Claude not known to run) the tab does not read Claude\'s topic', tab.title === 'Terminal' && pane.shownTitle === 'Terminal', { t: tab.title, shown: pane.shownTitle });
      emit(pane.ptyId, '\x1b]7501;state=idle:app=claude-code\x07');
      await tick(60);
      check('review P2: the next report names the tab for the project again', tab.title === 'AI-Brain', tab.title);
      await tm2.closeById(tab.id);
    }

    // P3: Claude killed with no clear; the shell sets its own title, then its prompt shows.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      await claude7501(pane, 'Fix the tab names');
      emit(pane.ptyId, '\x1b]0;mike@host: ~/code\x07');
      await until(() => pane.title === 'mike@host: ~/code');
      emit(pane.ptyId, PROMPT);
      await tick(60);
      check('review P3: Claude\'s topic is not shown after a kill', pane.shownTitle !== 'Fix the tab names' && tab.title !== 'AI-Brain', { shown: pane.shownTitle, t: tab.title });
      emit(pane.ptyId, '\x1b]0;mike@host: ~/code\x07'); // the shell's next title (every prompt)
      await tick(40);
      check('review P3: ...and the shell\'s own title shows as soon as it sets it after its prompt', pane.shownTitle === 'mike@host: ~/code' && tab.title === 'mike@host: ~/code', { shown: pane.shownTitle, t: tab.title });
      await tm2.closeById(tab.id);
    }

    // P4: a late Claude title after its clear.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      await claude7501(pane, 'Fix the tab names');
      emit(pane.ptyId, '\x1b]7501;state=clear\x07');
      await until(() => !pane.isClaudePane);
      emit(pane.ptyId, '\x1b]0;Fix the tab names\x07'); // repeated after the clear
      await tick(40);
      emit(pane.ptyId, PROMPT);
      await tick(60);
      check('review P4: a Claude title arriving after the clear still reads "Terminal"', pane.shownTitle === 'Terminal' && tab.title === 'Terminal' && pane.title === 'Fix the tab names', { shown: pane.shownTitle, t: tab.title });
      await tm2.closeById(tab.id);
    }

    // P5: Claude's start-up title, a slow first report (more than the old 2 s lead).
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, '\x1b]0;mike@host: ~\x07' + PROMPT);
      await tick(20);
      emit(pane.ptyId, '\x1b]0;Claude Code\x07');
      await until(() => pane.title === 'Claude Code');
      await tick(2500);
      await claude7501(pane);
      emit(pane.ptyId, '\x1b]7501;state=clear\x07');
      await until(() => !pane.isClaudePane);
      check('review P5: a start-up title set 2.5 s before the first report reads "Terminal" on exit', pane.shownTitle === 'Terminal' && tab.title === 'Terminal', { shown: pane.shownTitle, t: tab.title });
      await tm2.closeById(tab.id);
    }

    // The shell's own title, set after its prompt (the command running now), shows after Claude left.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, '\x1b]0;mike@host: ~\x07' + PROMPT);
      await tick(20);
      await claude7501(pane, 'Fix the tab names');
      emit(pane.ptyId, '\x1b]7501;state=clear\x07');
      await until(() => !pane.isClaudePane);
      emit(pane.ptyId, PROMPT + '\x1b]0;mike@host: ~\x07');
      await tick(40);
      check('review: the shell\'s own title set after Claude left (after its prompt) is shown', pane.shownTitle === 'mike@host: ~' && tab.title === 'mike@host: ~', { shown: pane.shownTitle, t: tab.title });
      await tm2.closeById(tab.id);
    }

    // --- review of 219eea8: the rule is "the command running now, else Terminal" ---
    const IDLE = '\x1b]7501;state=idle:app=claude-code\x07';
    const CLEAR = '\x1b]7501;state=clear\x07';
    const T = (t) => '\x1b]0;' + t + '\x07';
    const quit = async (pane) => { emit(pane.ptyId, CLEAR); await until(() => !pane.isClaudePane); await tick(20); };

    // B2a/B2b: a second session that sets no title (or the same one) leaves "Terminal" after it quits.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, IDLE); emit(pane.ptyId, T('Fix x'));
      await until(() => pane.isClaudePane && pane.title === 'Fix x');
      await quit(pane);
      emit(pane.ptyId, PROMPT);
      await tick(30);
      emit(pane.ptyId, IDLE);
      await until(() => pane.isClaudePane);
      await quit(pane);
      check('review B2: a second session that sets no title: "Terminal" after it quits', pane.shownTitle === 'Terminal' && tab.title === 'Terminal', { shown: pane.shownTitle, t: tab.title });
      await tm2.closeById(tab.id);
    }
    // B3/B4: a second session that sets the same title before its first report.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, IDLE); emit(pane.ptyId, T('Fix x'));
      await until(() => pane.isClaudePane && pane.title === 'Fix x');
      await quit(pane);
      emit(pane.ptyId, PROMPT);
      await tick(30);
      emit(pane.ptyId, T('Fix x'));
      await tick(20);
      emit(pane.ptyId, IDLE);
      await until(() => pane.isClaudePane);
      check('review B3: the second session reads as Claude\'s: the project names the tab', tab.title === 'AI-Brain', tab.title);
      await quit(pane);
      check('review B4: the second session sets the same title: "Terminal" after it quits', pane.shownTitle === 'Terminal' && tab.title === 'Terminal', { shown: pane.shownTitle, t: tab.title });
      await tm2.closeById(tab.id);
    }
    // B2 with no OSC 133 at all: a title Claude set stays hidden after the second session.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, IDLE); emit(pane.ptyId, T('Fix x'));
      await until(() => pane.isClaudePane && pane.title === 'Fix x');
      await quit(pane);
      emit(pane.ptyId, IDLE);
      await until(() => pane.isClaudePane);
      await quit(pane);
      check('review B2 (no OSC 133): Claude\'s title stays hidden after a second session that sets none', pane.shownTitle === 'Terminal' && tab.title === 'Terminal', { shown: pane.shownTitle, t: tab.title });
      await tm2.closeById(tab.id);
    }

    // C1/C2: Claude quits before its first report (a cancelled --resume picker), leaving its start-up title.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, T('mike@host: ~') + PROMPT);
      await tick(20);
      emit(pane.ptyId, T('Claude Code'));
      await until(() => pane.title === 'Claude Code');
      check('review C1: the command running now sets "Claude Code": it shows while it runs', pane.shownTitle === 'Claude Code', pane.shownTitle);
      emit(pane.ptyId, PROMPT);
      await tick(40);
      check('review C2: the prompt returns with no report ever: "Terminal" on the pane and the tab', pane.shownTitle === 'Terminal' && tab.title === 'Terminal' && stripText(tab) === 'Terminal', { shown: pane.shownTitle, t: tab.title, s: stripText(tab) });
      await tm2.closeById(tab.id);
    }

    // A2/A3: title path (no 7501): Claude's glyph title, then a shell's or program's own title.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, T('✳ Fix x'));
      await until(() => pane.isClaudePane);
      emit(pane.ptyId, T('fish ~/code'));
      await until(() => pane.title === 'fish ~/code');
      check('review A2: after Claude (title path) the next title is shown, not hidden as Claude\'s', pane.shownTitle === 'fish ~/code' && tab.title === 'fish ~/code' && !pane.isClaudePane, { shown: pane.shownTitle, t: tab.title });
      emit(pane.ptyId, T('fish ~/code'));
      await tick(40);
      check('review A3: ...and the same title arriving again', pane.shownTitle === 'fish ~/code' && tab.title === 'fish ~/code', { shown: pane.shownTitle, t: tab.title });
      await tm2.closeById(tab.id);
    }

    // H1/H2: bash order, the prompt mark first and the shell's title after it.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, IDLE); emit(pane.ptyId, T('Fix x'));
      await until(() => pane.isClaudePane && pane.title === 'Fix x');
      await quit(pane);
      emit(pane.ptyId, PROMPT + T('user@host: ~/proj'));
      await until(() => pane.title === 'user@host: ~/proj');
      check('review H1: a title set after the prompt mark is shown', pane.shownTitle === 'user@host: ~/proj' && tab.title === 'user@host: ~/proj', { shown: pane.shownTitle, t: tab.title });
      emit(pane.ptyId, IDLE);
      await until(() => pane.isClaudePane);
      await quit(pane);
      emit(pane.ptyId, PROMPT + T('user@host: ~/proj'));
      await tick(40);
      check('review H2: a second session, then the shell\'s next title after its prompt shows again', pane.shownTitle === 'user@host: ~/proj' && tab.title === 'user@host: ~/proj', { shown: pane.shownTitle, t: tab.title });
      await tm2.closeById(tab.id);
    }

    // I2: no OSC 133 at all (fish): the shell's title, set before Claude and again after it.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, T('fish ~/code'));
      await tick(20);
      emit(pane.ptyId, IDLE);
      await until(() => pane.isClaudePane);
      await quit(pane);
      emit(pane.ptyId, T('fish ~/code'));
      await tick(30);
      check('review I2: with no OSC 133 the title the shell sets again after Claude shows', pane.shownTitle === 'fish ~/code' && tab.title === 'fish ~/code', { shown: pane.shownTitle, t: tab.title });
      emit(pane.ptyId, T('vim notes.md'));
      await tick(30);
      check('review I2: ...and a program\'s after it', tab.title === 'vim notes.md', tab.title);
      await tm2.closeById(tab.id);
    }

    // L: respawn resets what was known about the title.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, IDLE); emit(pane.ptyId, T('Fix x'));
      await until(() => pane.isClaudePane && pane.title === 'Fix x');
      const respawnsBefore = state.respawns.length;
      await tab.respawnShell({ cwd: '/tmp/ai-brain' });
      state.respawns.length = respawnsBefore; // later cases count the respawns of the board's tile open
      await tick(30);
      check('review L: after a respawn the pane reads "Terminal"', pane.shownTitle === 'Terminal' && tab.title === 'Terminal', { shown: pane.shownTitle, t: tab.title });
      emit(pane.ptyId, T('htop'));
      await until(() => pane.title === 'htop');
      check('review L: a title the new shell\'s command sets shows (nothing of the old Claude carries over)', pane.shownTitle === 'htop', pane.shownTitle);
      await tm2.closeById(tab.id);
    }

    // The pane-drag overlay names the pane as the tab does.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, IDLE); emit(pane.ptyId, T('Fix x'));
      await until(() => pane.isClaudePane && pane.title === 'Fix x');
      await quit(pane);
      const handle = pane.element.querySelector('.pane-drag-handle');
      handle.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      const shownInOverlay = doc.querySelector('.pane-drag-overlay')?.textContent;
      doc.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      doc.querySelectorAll('.pane-drag-overlay').forEach((o) => o.remove());
      check('review overlay: dragging a pane Claude left shows "Terminal", not Claude\'s topic', shownInOverlay === 'Terminal', shownInOverlay);
      await tm2.closeById(tab.id);
    }

    // Palette rows of a split of idle shells (23 Nov): paneTitle is '' for a shell showing the
    // default "Terminal", so sessionName names each pane after its folder, not "Terminal" twice.
    {
      const resolveBeforeSplit = w.patton.projects.resolve;
      w.patton.projects.resolve = async () => null;
      const tab = await tm2.createTab('/tmp/alpha');
      tm2.switchToId(tab.id);
      const first = tab.focusedPane;
      const second = await split(tab);
      first['currentCwd'] = '/tmp/alpha';
      second['currentCwd'] = '/tmp/beta';
      const rows = tm2.listSessions().filter((s) => s.tabId === tab.id);
      const byCwd = (cwd) => rows.find((s) => s.cwd === cwd);
      check('palette split: two plain shells give two rows', rows.length === 2 && !!byCwd('/tmp/alpha') && !!byCwd('/tmp/beta'), rows.map((s) => [s.cwd, s.paneTitle]));
      check('palette split: the shells\' pane titles are empty, not "Terminal"', rows.every((s) => s.paneTitle === ''), rows.map((s) => s.paneTitle));
      check('palette split: sessionName reads alpha and beta, not "Terminal" twice', !!byCwd('/tmp/alpha') && !!byCwd('/tmp/beta') && sessionName(byCwd('/tmp/alpha')) === 'alpha' && sessionName(byCwd('/tmp/beta')) === 'beta', rows.map(sessionName));
      // A Claude pane keeps its topic.
      emit(second.ptyId, '\x1b]7501;state=idle:app=claude-code\x07');
      emit(second.ptyId, '\x1b]0;Fix the palette\x07');
      await until(() => second.isClaudePane && second.title === 'Fix the palette');
      const rows2 = tm2.listSessions().filter((s) => s.tabId === tab.id);
      check('palette split: a Claude pane\'s paneTitle is still its topic', rows2.find((s) => s.paneId === second.id)?.paneTitle === 'Fix the palette' && rows2.find((s) => s.paneId === first.id)?.paneTitle === '', rows2.map((s) => s.paneTitle));
      await tm2.closeById(tab.id);
      w.patton.projects.resolve = resolveBeforeSplit;
    }

    // Tab.namedForProject and the split-tab menu (D1, D2): the menu acts on the project that names the tab.
    {
      const setNameCalls = [];
      const setNameWas = w.patton.projects.setName;
      w.patton.projects.setName = async (key, name) => { setNameCalls.push([key, name]); };
      const openMenu = (tab) => {
        tm2['updateTabBar']();
        tm2Bar.querySelector('.tab-bar-tab[data-tab-id="' + tab.id + '"]').dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
        return [...doc.querySelectorAll('.context-menu-item')];
      };
      const closeMenu = () => doc.querySelectorAll('.context-menu-overlay').forEach((o) => o.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      const labelsOf = (items) => items.map((n) => n.textContent.replace(/\s+/g, ' ').trim());

      const tab = await newTab();
      const A = tab.focusedPane;
      check('Tab.namedForProject: a plain shell in a project folder is not named for it', tab.namedForProject === false && tab.title === 'Terminal', { named: tab.namedForProject, t: tab.title });
      emit(A.ptyId, '\x1b]7501;state=idle:app=claude-code\x07');
      await until(() => A.isClaudePane);
      check('Tab.namedForProject: true while Claude runs in it', tab.namedForProject === true, tab.namedForProject);
      tab.setCustomTitle('mine');
      check('Tab.namedForProject: false once the user named it', tab.namedForProject === false, tab.namedForProject);
      tab.clearCustomTitle();
      check('Tab.namedForProject: true again when the name is cleared', tab.namedForProject === true, tab.namedForProject);

      // D1: Claude in the unfocused A (project AI-Brain); the focused B sits in no project.
      tm2.splitVertical();
      await until(() => tab.panes.length === 2);
      await tick(20);
      const B = tab.focusedPane;
      w.patton.projects.resolve = async () => null;
      tab['lookUpProject'](B);
      await tick(10);
      let items = openMenu(tab);
      let labels = labelsOf(items);
      check('review D1: focused shell in no project, Claude in A: the menu offers the project\'s default name and its bookmark', tab.namedForProject && labels.includes('Set Default Tab Name for Project…') && labels.includes('Bookmark Project'), labels);
      closeMenu();

      // D2: the focused shell sits in project Other; the rename must reach AI-Brain, the project naming the tab.
      w.patton.projects.resolve = async () => ({ root: '/tmp/other', defaultName: 'Other' });
      tab['lookUpProject'](B);
      await tick(10);
      items = openMenu(tab);
      items.find((n) => n.textContent.trim().startsWith('Set Default Tab Name')).click();
      const box = [...doc.querySelectorAll('.tab-bar-tab-rename')][0];
      check('review D2: the box offers AI-Brain (the project naming the tab), not Other', !!box && box.placeholder === 'AI-Brain', box && box.placeholder);
      if (box) {
        box.value = 'Renamed';
        box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      }
      check('review D2: the rename reaches AI-Brain\'s folder', setNameCalls.length === 1 && setNameCalls[0][0] === '/tmp/ai-brain' && setNameCalls[0][1] === 'Renamed', setNameCalls);
      closeMenu();
      check('review D2: the bookmark is of the same project', tab.menuProject?.root === '/tmp/ai-brain', tab.menuProject?.root);

      // Claude quits: the tab is no longer named for a project, so it gets "Rename Tab…", and the focused pane's project.
      emit(A.ptyId, '\x1b]7501;state=clear\x07');
      await until(() => !A.isClaudePane);
      await tick(20);
      labels = labelsOf(openMenu(tab));
      check('review D: with no Claude the tab offers "Rename Tab…" and the focused pane\'s project', !tab.namedForProject && labels.includes('Rename Tab…') && labels.includes('Set Default Tab Name for Project…') && tab.menuProject?.root === '/tmp/other', { labels, p: tab.menuProject?.root });
      closeMenu();
      w.patton.projects.resolve = projResolve;
      w.patton.projects.setName = setNameWas;
      await tm2.closeById(tab.id);
    }

    // WAKE: the title stays on the pane, and the flag follows it.
    {
      const tab = await newTab();
      const pane = tab.focusedPane;
      emit(pane.ptyId, '\x1b]0;WAKE\x07');
      await until(() => pane.title === 'WAKE');
      check('review WAKE: shown whole, found by findWakePane, tab flagged yellow', pane.shownTitle === 'WAKE' && tab.autoFlag === 'yellow' && tm2.getTabs().some((t) => t.panes.some((p) => p.title === 'WAKE')), { shown: pane.shownTitle, flag: tab.autoFlag });
      emit(pane.ptyId, '\x1b]0;htop\x07');
      await until(() => pane.title === 'htop');
      check('review WAKE: another title drops the flag', tab.autoFlag === null, tab.autoFlag);
      await tm2.closeById(tab.id);
    }

    // P8: the right-click menu on a plain shell in a project folder.
    {
      const tab = await newTab();
      const menuLabels = () => {
        const el = tm2Bar.querySelector('.tab-bar-tab[data-tab-id="' + tab.id + '"]');
        el.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
        const labels = [...doc.querySelectorAll('.context-menu-item')].map((n) => n.textContent.replace(/\s+/g, ' ').trim());
        doc.querySelectorAll('.context-menu-overlay').forEach((o) => o.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
        return labels;
      };
      let labels = menuLabels();
      check('review P8: a plain shell tab in a project folder offers "Rename Tab…" and the project\'s default name', tab.title === 'Terminal' && !tab.namedForProject && labels.includes('Rename Tab…') && labels.includes('Set Default Tab Name for Project…'), labels);
      tab.focusedPane.title = '✳ Fix x'; tab.focusedPane['trackClaudeState']('✳ Fix x');
      await tick(5);
      labels = menuLabels();
      check('review P8: while Claude runs and the project names the tab, both the one-off Rename Tab… and the project\'s default name are offered, in that order', tab.namedForProject && labels.indexOf('Rename Tab…') >= 0 && labels.indexOf('Set Default Tab Name for Project…') === labels.indexOf('Rename Tab…') + 1, labels);
      await tm2.closeById(tab.id);
    }
    w.patton.projects.resolve = resolveWas2;
  }

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

  // --- open from a tile: the project opens IN the board's own tab, no confirm ---
  tm.switchToId(t1.id);
  const boardIdx = tm.getTabs().indexOf(t1);
  const closedBefore = tm.hasClosedPanes();
  const reopenCount = tm['closedPanes'].length;
  const countBefore = tm.getTabs().length;
  const createsBefore = state.creates.filter((c) => !c.respawned).length;
  const oldPty = t1.ptyId;
  board1.host.openProject('/tmp/proj-a');
  check('tile open: the board is lifted off its tab', await until(() => board1.disposed && !t1.hasCover));
  const opened = tm.getActiveTab();
  check('tile open: the board\'s own tab is the project tab (same tab, active)', opened === t1 && tm.getTabs().includes(t1), opened?.id);
  check('tile open: the project tab is in the project folder', opened.panes[0].getCwd() === '/tmp/proj-a', opened.panes[0].getCwd());
  check('tile open: it keeps the board tab\'s place in the strip', tm.getTabs().indexOf(opened) === boardIdx, { at: tm.getTabs().indexOf(opened), boardIdx });
  check('tile open: tab count unchanged', tm.getTabs().length === countBefore);
  check('tile open: no new tab was created', state.creates.filter((c) => !c.respawned).length === createsBefore);
  const rsp = state.respawns.at(-1);
  check('tile open: its shell was replaced, asked for like a new project tab (cwd, projectDir)', rsp && rsp.oldId === oldPty && rsp.id === t1.ptyId && rsp.opts.cwd === '/tmp/proj-a' && rsp.opts.projectDir === true && !rsp.opts.hyperlinks, rsp);
  check('tile open: the old shell is ended (once)', state.destroyed.filter((id) => id === oldPty).length === 1, state.destroyed);
  check('tile open: no confirm dialog', ![...doc.querySelectorAll('.confirm-dialog-overlay')].some((o) => o.classList.contains('visible')));
  check('tile open: not on the reopen list', tm.hasClosedPanes() === closedBefore && tm['closedPanes'].length === reopenCount);
  check('tile open logged as in place', logs.some((l) => l[0] === '[BOARD] opened' && l[1]?.label === 'Alpha' && l[1]?.action === 'in place' && l[1]?.toTabId === t1.id));
  check('tile open: nothing discarded', !logs.some((l) => l[0] === '[BOARD] discard'));
  // The new shell's exit closes the tab (registered under the new id); the old id does nothing.
  check('tile open: the pane is registered under its new PTY id only', tm['panesByPtyId'].get(t1.ptyId) === t1.panes[0] && !tm['panesByPtyId'].has(oldPty));
  // A shell exit for the project tab's new PTY still goes through tm; checked for the old id below.
  await tick(1);

  // --- open from a tile, project already open: board tab just goes ---
  const t3 = await tm.userNewTab();
  const board3 = globalThis.__boards.at(-1);
  check('board 3 shown', t3.hasCover && board3.host.liveState('/tmp/proj-a').isOpen === true);
  const n3 = tm.getTabs().length;
  board3.host.openProject('/tmp/proj-a');
  check('open existing: board tab discarded', await until(() => !tm.getTabs().includes(t3)));
  check('open existing: the existing tab is active', tm.getActiveTab() === opened && tm.getTabs().length === n3 - 1);
  check('open existing: no second session (no shell replaced), the board tab discarded', state.respawns.length === 1 && logs.some((l) => l[0] === '[BOARD] discard' && l[1]?.discarded === true));

  // --- a failed open reaches the board, which announces it (m5) ---
  const t5 = await tm.userNewTab();
  const board5 = globalThis.__boards.at(-1);
  state.failSettings = true;
  const outcome = await Promise.resolve(board5.host.openProject('/tmp/proj-new')).then(() => 'resolved', () => 'rejected');
  state.failSettings = false;
  check('m5: a failed open rejects back to the board', outcome === 'rejected', outcome);
  // A refused respawn leaves the board, the old shell and the registration alone.
  const oldPty5 = t5.ptyId;
  const respawnsBefore5 = state.respawns.length;
  state.failRespawn = true;
  const outcome5 = await Promise.resolve(board5.host.openProject('/tmp/proj-new')).then(() => 'resolved', () => 'rejected');
  state.failRespawn = false;
  check('respawn refused: the click rejects back to the board', outcome5 === 'rejected', outcome5);
  check('respawn refused: board kept, same shell, still registered', t5.hasCover && !board5.disposed && t5.ptyId === oldPty5 && tm['panesByPtyId'].get(oldPty5) === t5.panes[0] && state.respawns.length === respawnsBefore5);
  // And after the failure the same click works again (the tab is not left "busy").
  check('respawn refused: the tab is not left busy', !logs.some((l) => l[0] === '[BOARD] open ignored'));
  check('m5: the board stays after a failed open', t5.hasCover && !board5.disposed);
  await tm.closeById(t5.id);

  // --- review fixes: bytes of the old shell, a late lsof, stale name/colour/title ---
  state.settings = { startupCommand: 'cc' };
  const screenOf = (pane) => {
    const buf = pane.terminalView.terminal.buffer.active;
    let text = '';
    for (let i = 0; i < buf.length; i++) text += (buf.getLine(i)?.translateToString(true) ?? '') + '\n';
    return text;
  };
  const sentOf = (id, data, from) => state.writes.slice(from).filter((wr) => wr.id === id && wr.data === data).length;
  const FIRST_PROMPT = '\x1b]133;D;0\x07\x1b]133;A\x07';
  const t6 = await tm.userNewTab();
  const board6 = globalThis.__boards.at(-1);
  const pane6 = t6.panes[0];
  const old6 = t6.ptyId;
  t6.setCustomTitle('Restored name');
  t6.setFlag('red');
  emit(old6, '\x1b]2;OLDTITLE\x07');
  await tick(50);
  check('stale: the old shell\'s window title is set before the click', pane6.title === 'OLDTITLE', pane6.title);
  // Bytes already handed to xterm (still queued) and bytes flushed ahead of main's reply,
  // the second with a "first prompt" that must not fire the startup command early.
  emit(old6, 'QUEUEDBYTES');
  state.beforeRespawnReply = (oldId) => emit(oldId, 'FLUSHEDBYTES' + FIRST_PROMPT);
  state.cwdAnswers = { [old6]: { cwd: '/old/stale/dir', ms: 40 } };
  const lateCwd = pane6.refreshCwdNow();
  const writes6 = state.writes.length;
  board6.host.openProject('/tmp/proj-new');
  check('stale: the click completed (board lifted)', await until(() => board6.disposed && !t6.hasCover));
  state.beforeRespawnReply = null;
  const new6 = t6.ptyId;
  await lateCwd;
  await tick(150);
  const screen6 = screenOf(pane6);
  check('stale: bytes queued in xterm before the click do not reach the new shell\'s screen', !screen6.includes('QUEUEDBYTES'), screen6);
  check('stale: bytes flushed ahead of main\'s reply are dropped', !screen6.includes('FLUSHEDBYTES'), screen6);
  check('stale: the old shell\'s prompt marks do not fire the startup command early', sentOf(new6, 'cc\r', writes6) === 0, state.writes.slice(writes6));
  emit(new6, FIRST_PROMPT);
  check('stale: the new shell\'s own first prompt still types it, once', await until(() => sentOf(new6, 'cc\r', writes6) === 1, 1000), state.writes.slice(writes6));
  check('stale: a late lsof for the old shell does not set the pane\'s folder', pane6.getCwd() === '/tmp/proj-new', pane6.getCwd());
  check('stale: the old shell\'s window title is cleared', pane6.title === 'Terminal', pane6.title);
  check('stale: a restored custom name and colour flag are dropped', !t6.hasCustomTitle && t6.flag === null && t6.title !== 'Restored name', { custom: t6.hasCustomTitle, flag: t6.flag, title: t6.title });
  state.cwdAnswers = null;
  await tm.closeById(t6.id);

  // --- a split board tab (restored at launch) cannot be respawned: the old path, a new tab ---
  const cs1 = await tm.createTab();
  tm.switchToId(cs1.id);
  tm.splitVertical();
  await until(() => cs1.panes.length === 2);
  boards.mount(cs1, state.payload);
  const boardS1 = globalThis.__boards.at(-1);
  const idxS1 = tm.getTabs().indexOf(cs1);
  const respawnsS1 = state.respawns.length;
  const newTabsS1 = state.creates.filter((c) => !c.respawned).length;
  const splitOutcome = await Promise.resolve(boardS1.host.openProject('/tmp/proj-split')).then(() => 'resolved', (e) => String(e));
  check('split tab, tile: the board\'s tab is dropped', await until(() => !tm.getTabs().includes(cs1)), splitOutcome);
  const placedS1 = tm.getActiveTab();
  check('split tab, tile: no shell was replaced; a new tab holds the project, in the board tab\'s place',
    state.respawns.length === respawnsS1 && state.creates.filter((c) => !c.respawned).length > newTabsS1 && placedS1 !== cs1 && placedS1.panes[0].getCwd() === '/tmp/proj-split' && tm.getTabs().indexOf(placedS1) === idxS1,
    { respawns: state.respawns.length - respawnsS1, at: tm.getTabs().indexOf(placedS1), idxS1 });
  check('split tab, tile: logged as a new tab', logs.some((l) => l[0] === '[BOARD] opened' && l[1]?.action === 'new tab' && l[1]?.toTabId === placedS1.id));
  await tm.closeById(placedS1.id);

  state.settings = { startupCommand: '' };
  const cs2 = await tm.createTab();
  tm.switchToId(cs2.id);
  tm.splitVertical();
  await until(() => cs2.panes.length === 2);
  boards.mount(cs2, state.payload);
  const boardS2 = globalThis.__boards.at(-1);
  const respawnsS2 = state.respawns.length;
  const tabsS2 = tm.getTabs().length;
  const wakeSplit = await Promise.resolve(boardS2.host.wake()).then(() => 'resolved', (e) => String(e));
  check('split tab, Wake: no shell replaced; a new tab runs it; the board stays', state.respawns.length === respawnsS2 && tm.getTabs().length === tabsS2 + 1 && !boardS2.disposed && cs2.hasCover && tm.getActiveTab() === cs2, { wakeSplit, respawns: state.respawns.length - respawnsS2, tabs: tm.getTabs().length - tabsS2 });
  await tm.closeById(tm.getTabs().at(-1).id);
  await tm.closeById(cs2.id);

  // --- a refused respawn on Wake: rejects back to the board, which stays ---
  const t7 = await tm.userNewTab();
  const board7 = globalThis.__boards.at(-1);
  const old7 = t7.ptyId;
  state.failRespawn = true;
  const wakeOutcome = await Promise.resolve(board7.host.wake()).then(() => 'resolved', () => 'rejected');
  state.failRespawn = false;
  check('wake refused: the click rejects back to the board', wakeOutcome === 'rejected', wakeOutcome);
  check('wake refused: board kept, same shell', t7.hasCover && !board7.disposed && t7.ptyId === old7);
  const again = await Promise.resolve(board7.host.wake()).then(() => 'resolved', () => 'rejected');
  check('wake refused: the tab is not left busy (a retry works)', again === 'resolved' && !t7.hasCover);
  await tm.closeById(t7.id);
  state.settings = { startupCommand: '' };

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

  // --- the Wake button (host side; the button itself: check-project-board-ui.mjs) ---
  check('wake rule: missing setting means "wake"', wakeCommandOf({}) === 'wake' && wakeCommandOf(null) === 'wake');
  check('wake rule: empty setting hides the button', wakeCommandOf({ boardWakeCommand: '' }) === '' && wakeCommandOf({ boardWakeCommand: '  ' }) === '');
  check('wake rule: a set command is used', wakeCommandOf({ boardWakeCommand: 'keepup' }) === 'keepup');
  check('app.ts: the settings callback passes the wake command on', /settings\.boardWakeCommand !== undefined\) \{\s*this\.projectBoards\?\.setWakeCommand\(settings\.boardWakeCommand\)/.test(appSrc));
  check('settings: wake command saved debounced', /saveAndNotify\(\{ boardWakeCommand: [^}]+\}, true\)/.test(settingsSrc));
  check('settings: wake command field labelled, placeholder wake', settingsSrc.includes('>Wake button command</label>')
    && /id="setting-board-wake-command"[^>]*placeholder="wake"/.test(settingsSrc));
  check('settings: wake command filled through wakeCommandOf (absent → wake)', /#setting-board-wake-command'\) as HTMLInputElement\)\.value = wakeCommandOf\(settings\)/.test(settingsSrc));

  state.settings = { startupCommand: '' }; // no boardWakeCommand: an older settings file
  const wt = await tm.userNewTab();
  const boardW = globalThis.__boards.at(-1);
  check('wake: shown by default (setting absent)', JSON.stringify(boardW.host.wakeState()) === JSON.stringify({ command: 'wake', awake: false }), boardW.host.wakeState());
  const nW = tm.getTabs().length;
  const madeW = made();
  const createsW = state.creates.length;
  const writesW = state.writes.length;
  const logW = logs.length;
  const idxW = tm.getTabs().indexOf(wt);
  const oldPtyW = wt.ptyId;
  const respawnsW = state.respawns.length;
  boardW.host.wake();
  // Done once it logs: the board's tab has a new shell and the board is lifted.
  const started = await until(() => logs.slice(logW).some((l) => l[0] === '[BOARD] wake started'), 1000);
  const wakeTab = wt;
  check('wake click: no new tab opens', started && tm.getTabs().length === nW && state.creates.slice(createsW).every((c) => c.respawned), tm.getTabs().length);
  check('wake click: the board\'s own tab is the wake tab, in the same place and active', tm.getTabs().indexOf(wt) === idxW && tm.getActiveTab() === wt);
  check('wake click: the board is lifted off the tab', !wt.hasCover && boardW.disposed && made() === madeW);
  const wakeRsp = state.respawns.slice(respawnsW);
  check('wake click: one respawn, at home (no cwd, no projectDir), with hyperlinks', wakeRsp.length === 1 && wakeRsp[0].oldId === oldPtyW && wakeRsp[0].id === wt.ptyId && !wakeRsp[0].opts.cwd && !wakeRsp[0].opts.projectDir && wakeRsp[0].opts.hyperlinks === true, wakeRsp);
  check('wake click: the old shell is ended once', state.destroyed.filter((id) => id === oldPtyW).length === 1);
  check('wake click: logged in place', logs.slice(logW).some((l) => l[0] === '[BOARD] wake started' && l[1]?.inPlace === true && l[1]?.tabId === wt.id));
  const wakeSent = () => state.writes.slice(writesW).filter((wr) => wr.id === wakeTab.ptyId && wr.data === 'wake\r').length;
  await tick(50);
  check('wake: nothing typed before the prompt', wakeSent() === 0, wakeSent());
  emit(wakeTab.ptyId, '\x1b]133;A\x07');
  check('wake: "wake" + Enter typed once the prompt shows', await until(() => wakeSent() === 1, 1000), wakeSent());
  check('wake: typed into no other shell', state.writes.slice(writesW).every((wr) => wr.id === wakeTab.ptyId));

  // The command titles its pane WAKE: another board's button turns to "Awake".
  const wb = await tm.userNewTab();
  const boardB = globalThis.__boards.at(-1);
  emit(wakeTab.ptyId, '\x1b]2;WAKE\x07');
  check('wake: a WAKE title reaches the board (Awake)', await until(() => boardB.wakeSeen?.awake === true, 1000), boardB.wakeSeen);
  check('wake: the WAKE tab carries the yellow flag', wakeTab.autoFlag === 'yellow');
  // 10 Nov: "when one types our wake command … always shift it to first tab on left".
  check('wake first: the WAKE tab moved to the far left', idxW > 0 && tm.getTabs()[0] === wakeTab && tm.getTabs().length === nW + 1, { idxW, at: tm.getTabs().indexOf(wakeTab) });
  check('wake first: the strip shows it first', tabBarEl.querySelector('.tab-bar-tab')?.dataset.tabId === wakeTab.id);
  check('wake first: logged with where it came from', logs.slice(logW).some((l) => l[0] === '[WAKE] tab moved first' && l[1]?.tabId === wakeTab.id && l[1]?.from === idxW), logs.slice(logW).filter((l) => l[0].startsWith('[WAKE]')));
  // Dragged elsewhere while wake runs, a later title report leaves it there.
  tm.dropTabs([wakeTab.id], { kind: 'tab', id: tm.getTabs()[2].id, half: 'right' });
  const dragIdx = tm.getTabs().indexOf(wakeTab);
  const movesBefore = logs.filter((l) => l[0] === '[WAKE] tab moved first').length;
  emit(wakeTab.ptyId, '\x1b]2;WAKE\x07');
  await tick(30);
  check('wake first: a drag while wake runs sticks', dragIdx === 2 && tm.getTabs().indexOf(wakeTab) === 2 && logs.filter((l) => l[0] === '[WAKE] tab moved first').length === movesBefore, { dragIdx, at: tm.getTabs().indexOf(wakeTab) });
  const nJ = tm.getTabs().length;
  const logJ = logs.length;
  const respawnsJ = state.respawns.length;
  boardB.host.wake();
  await tick(30);
  check('awake click: no new tab and no second wake', tm.getTabs().length === nJ && state.respawns.length === respawnsJ && state.writes.slice(writesW).filter((wr) => wr.data === 'wake\r').length === 1);
  check('awake click: the WAKE tab is active', tm.getActiveTab() === wakeTab);
  check('awake click: logged as a jump', logs.slice(logJ).some((l) => l[0] === '[BOARD] wake jumped' && l[1]?.toTabId === wakeTab.id));
  tm.switchToId(wb.id);
  emit(wakeTab.ptyId, '\x1b]2;~\x07');
  check('wake: the title changing back turns the board to Wake', await until(() => boardB.wakeSeen?.awake === false, 1000), boardB.wakeSeen);
  // A pane that isn't its tab's focused one (a split) reaches the board too:
  // only the tab's automatic flag reports its title.
  tm.switchToId(wakeTab.id);
  tm.splitVertical();
  await until(() => wakeTab.panes.length === 2 && wakeTab.focusedPane !== wakeTab.panes[0], 500);
  tm.switchToId(wb.id);
  await tick(150); // let the tab switch's own refresh pass first
  const firstPane = wakeTab.panes[0];
  check('split: the first pane is not the focused one', wakeTab.panes.length === 2 && wakeTab.focusedPane !== firstPane);
  emit(firstPane.ptyId, '\x1b]2;WAKE\x07');
  check('wake: WAKE in an unfocused split pane reaches the board', await until(() => boardB.wakeSeen?.awake === true, 1000), boardB.wakeSeen);
  emit(firstPane.ptyId, '\x1b]2;~\x07');
  check('wake: and its title changing back too', await until(() => boardB.wakeSeen?.awake === false, 1000), boardB.wakeSeen);
  check('wake first: wake started again (in the unfocused split pane) moves the tab left again', tm.getTabs()[0] === wakeTab && logs.filter((l) => l[0] === '[WAKE] tab moved first').length === movesBefore + 1, { at: tm.getTabs().indexOf(wakeTab) });
  check('wake first: the title changing back leaves the tab where it is', tm.getTabs()[0] === wakeTab);

  // '' hides the button: live from Settings, and from the saved setting.
  boards.setWakeCommand('');
  check('setting "": every board repaints without the command', boardB.wakeSeen?.command === '', boardB.wakeSeen);
  const respawnsE = state.respawns.length;
  boardB.host.wake();
  await tick(30);
  check('setting "": a click starts nothing', state.respawns.length === respawnsE && boardB.disposed === false);
  boards.setWakeCommand('wake');
  state.settings = { startupCommand: '', boardWakeCommand: '' };
  const wt2 = await tm.userNewTab();
  check('setting "" saved: a new board has no command', globalThis.__boards.at(-1).host.wakeState().command === '');
  state.settings = { startupCommand: '' };
  await tm.closeById(wt2.id);
  await tm.closeById(wb.id);
  await tm.closeById(wakeTab.id);

  // --- the Claude button (host side; the button itself: check-project-board-ui.mjs) ---
  // The startup command is a project picker here ('cc'): it must never be typed.
  // The typed line sets FORCE_HYPERLINK=1 for Claude alone (M2: a board tab is created without it).
  state.settings = { startupCommand: 'cc' };
  const CLAUDE = 'FORCE_HYPERLINK=1 claude\r';
  // A real zsh marks the early prompt (A) at .zshenv time, then D and A at its first real prompt.
  const earlyMark = (id) => emit(id, '\x1b]133;A\x07');
  const firstPrompt = (id) => emit(id, '\x1b]133;D;0\x07\x1b]133;A\x07');
  const sentTo = (id, data, from) => state.writes.slice(from).filter((wr) => wr.id === id && wr.data === data).length;
  const live = (cls) => [...doc.querySelectorAll(`[aria-live="${cls}"]`)].map((el) => el.textContent).join('|');

  // A slow shell (marks sent, first prompt never): the bounded fallback types it after SLOW_SHELL_MS
  // from the PTY's creation. Started now, checked at the end so the wait overlaps the other cases.
  const cs = await tm.userNewTab();
  const boardS = globalThis.__boards.at(-1);
  const tSlow = Date.now();
  const writesS = state.writes.length;
  earlyMark(cs.ptyId);
  boardS.host.startClaude();

  const ct = await tm.userNewTab();
  const boardC = globalThis.__boards.at(-1);
  const writesC = state.writes.length;
  const logC = logs.length;
  const sentC = (data) => state.writes.slice(writesC).filter((wr) => wr.data === data).length;
  check('claude: the board is up before the click', ct.hasCover && !boardC.disposed);
  boardC.host.startClaude();
  boardC.host.startClaude(); // a double click: the second finds no board
  check('claude click: the board is removed like Terminal', boardC.disposed && !ct.hasCover && !boards.hasBoard(ct));
  check('claude click: nothing typed before the shell is ready', sentC(CLAUDE) === 0, sentC(CLAUDE));
  check('claude click: announced as starting (m3)', await until(() => live('polite').includes('Starting Claude'), 500), live('polite'));
  earlyMark(ct.ptyId);
  await tick(100);
  check('claude click: zsh\'s early prompt mark (.zshenv) is not "ready"', sentC(CLAUDE) === 0, sentC(CLAUDE));
  firstPrompt(ct.ptyId);
  check('claude click: typed at the shell\'s first prompt, once', await until(() => sentC(CLAUDE) === 1, 1000), sentC(CLAUDE));
  await tick(1700); // past the 1.5 s no-integration fallback
  check('claude click: a double click typed it once, not twice', sentC(CLAUDE) === 1, sentC(CLAUDE));
  check('claude click: typed into this tab only', state.writes.slice(writesC).every((wr) => wr.id === ct.ptyId));
  check('claude click: the startup command (cc) is never typed', sentC('cc\r') === 0 && !state.writes.slice(writesC).some((wr) => wr.data.includes('cc')));
  check('claude click: the line sets FORCE_HYPERLINK=1 for claude only (M2)', /^FORCE_HYPERLINK=1 claude\r$/.test(state.writes.slice(writesC)[0]?.data ?? ''));
  const claudeCreate = state.creates.find((c) => c.id === ct.ptyId);
  check('claude: the tab\'s shell has no FORCE_HYPERLINK of its own (other tabs unchanged)', claudeCreate && !claudeCreate.opts?.hyperlinks, claudeCreate?.opts);
  const claudeLogs = logs.slice(logC).filter((l) => l[0].startsWith('[BOARD] claude'));
  check('claude click: logged with the tab id', claudeLogs.some((l) => l[0] === '[BOARD] claude clicked' && l[1]?.tabId === ct.id));
  check('claude click: the second click is logged as ignored', claudeLogs.some((l) => l[0] === '[BOARD] claude ignored'));
  check('claude click: the start is logged', claudeLogs.some((l) => l[0] === '[BOARD] claude started' && l[1]?.tabId === ct.id));
  check('claude click: no new tab, the tab stays', tm.getTabs().includes(ct));
  check('claude: the tab is at home (no folder, not a project tab)', claudeCreate && !claudeCreate.opts?.cwd && !claudeCreate.opts?.projectDir, claudeCreate?.opts);

  // M1-A: a shell that showed its prompt long ago gets the line at once, not after a clock.
  const ca = await tm.userNewTab();
  const boardA = globalThis.__boards.at(-1);
  const writesA = state.writes.length;
  firstPrompt(ca.ptyId);
  await tick(700);
  const tA = Date.now();
  boardA.host.startClaude();
  const aSent = await until(() => sentTo(ca.ptyId, CLAUDE, writesA) === 1, 1000);
  check('claude early click on a ready shell: typed at once', aSent && Date.now() - tA < 100, Date.now() - tA);

  // M1-A2: keys typed between the click and the send must not be glued onto the command.
  const ck = await tm.userNewTab();
  const boardK = globalThis.__boards.at(-1);
  const writesK = state.writes.length;
  boardK.host.startClaude();
  const kInput = ck.focusedPane.element.querySelector('textarea');
  kInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'f', code: 'KeyF', keyCode: 70, bubbles: true }));
  firstPrompt(ck.ptyId);
  await tick(100);
  check('claude: a key typed while the shell loads cancels the send (nothing glued)', sentTo(ck.ptyId, CLAUDE, writesK) === 0 && !state.writes.slice(writesK).some((wr) => wr.data.includes('claude')), state.writes.slice(writesK));
  check('claude: the cancel is announced', live('assertive').includes('Claude not started'), live('assertive'));

  // A shell with no shell integration at all (fish, say): typed PROMPT_FALLBACK_MS after the PTY was created.
  const cl = await tm.userNewTab();
  const boardL = globalThis.__boards.at(-1);
  const writesL = state.writes.length;
  await tick(1600);
  const tL = Date.now();
  boardL.host.startClaude();
  const lateSent = await until(() => sentTo(cl.ptyId, CLAUDE, writesL) === 1, 1000);
  check('claude late click, no shell integration: sent at once by the fallback', lateSent && Date.now() - tL < 400, Date.now() - tL);

  // The launch tab: its shell is up before the board decision; the click still types at once.
  state.settings = { startupCommand: 'cc' };
  const lt = await tm.createTab(undefined, { startupCommand: true });
  const writesT = state.writes.length;
  firstPrompt(lt.ptyId);
  await tick(50);
  const shown = await boards.startLaunchTab(lt, 'cc');
  const boardT = globalThis.__boards.at(-1);
  check('claude launch tab: the board covers it', shown && lt.hasCover);
  boardT.host.startClaude();
  check('claude launch tab: typed at once, cc never typed', await until(() => sentTo(lt.ptyId, CLAUDE, writesT) === 1, 500) && sentTo(lt.ptyId, 'cc\r', writesT) === 0, state.writes.slice(writesT));

  // m2: a tab closed while the send waits gets nothing written to its dead PTY.
  const cx = await tm.userNewTab();
  const boardX = globalThis.__boards.at(-1);
  const writesX = state.writes.length;
  boardX.host.startClaude();
  await tm.closeById(cx.id);
  firstPrompt(cx.ptyId);
  await tick(1700);
  check('claude: a tab closed during the wait gets no write (m2)', state.writes.slice(writesX).every((wr) => wr.id !== cx.ptyId), state.writes.slice(writesX));

  // m1: a tab whose PTY could not be created is not "started".
  state.failCreate = true;
  const cf = await tm.userNewTab();
  state.failCreate = false;
  const boardF = globalThis.__boards.at(-1);
  const logF = logs.length;
  boardF.host.startClaude();
  check('claude: no PTY, no "started" log (m1)', cf.ptyId === null && logs.slice(logF).every((l) => l[0] !== '[BOARD] claude started'), [cf.ptyId, logs.slice(logF)]);
  check('claude: no PTY, the user is told', await until(() => live('assertive').includes('could not start'), 500), live('assertive'));

  // Final review 1: a tab's first pane loads history before its prompt listener used to exist,
  // so a first prompt parsed during that await was missed (the click then waited for the 10 s fallback).
  state.historyDelayMs = 80;
  state.afterCreate = (id) => setTimeout(() => firstPrompt(id), 10);
  const ch = await tm.userNewTab();
  state.historyDelayMs = 0;
  state.afterCreate = null;
  check('claude: a first prompt parsed during the history load is recorded', ch.focusedPane.shellProgress.sawFirstPrompt === true, ch.focusedPane.shellProgress);
  const boardH = globalThis.__boards.at(-1);
  const writesH = state.writes.length;
  const tH = Date.now();
  boardH.host.startClaude();
  check('claude: ...so the click types at once, not after the fallback', await until(() => sentTo(ch.ptyId, CLAUDE, writesH) === 1, 800) && Date.now() - tH < 300, Date.now() - tH);

  // Final review 2: csh and tcsh cannot take VAR=1 cmd; env would skip the claude alias.
  check('claude command: sh-family shells keep FORCE_HYPERLINK=1', ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish', '/bin/sh', ''].every((sh) => claudeCommandFor(sh).command === 'FORCE_HYPERLINK=1 claude'));
  check('claude command: csh and tcsh get plain claude', claudeCommandFor('/bin/csh').command === 'claude' && claudeCommandFor('/bin/tcsh').command === 'claude');
  // The app names no shell for a tab's first pane (Tab builds it before setShell), so main falls back to $SHELL.
  state.envShell = '/bin/tcsh';
  const cc = await tm.userNewTab();
  state.envShell = undefined;
  check('claude in tcsh: the first pane learns its real shell from main', cc.focusedPane.shellPath === '/bin/tcsh', cc.focusedPane.shellPath);
  const boardCsh = globalThis.__boards.at(-1);
  const writesCsh = state.writes.length;
  const logCsh = logs.length;
  boardCsh.host.startClaude();
  firstPrompt(cc.ptyId);
  check('claude in tcsh: typed as plain claude', await until(() => sentTo(cc.ptyId, 'claude\r', writesCsh) === 1, 800), state.writes.slice(writesCsh));
  check('claude in tcsh: no FORCE_HYPERLINK in anything typed', !state.writes.slice(writesCsh).some((wr) => wr.data.includes('FORCE_HYPERLINK')));
  check('claude in tcsh: the missing prefix is logged', logs.slice(logCsh).some((l) => l[0] === '[BOARD] claude typed without FORCE_HYPERLINK=1' && l[1]?.tabId === cc.id));

  // Final review 3: paste, dictation and IME text reach the PTY as terminal data, not keys.
  check('input filter: typed, dictated and bracketed-paste data count; terminal replies do not',
    isUserInput('x') && isUserInput('hello world') && isUserInput('\r') && isUserInput('\x1b[200~pasted\x1b[201~')
    && !isUserInput('\x1b[1;1R') && !isUserInput('\x1b[?1;2c') && !isUserInput('\x1b]11;rgb:0000/0000/0000\x1b\\'));
  const cp1 = await tm.userNewTab();
  const boardP1 = globalThis.__boards.at(-1);
  const writesP1 = state.writes.length;
  boardP1.host.startClaude();
  cp1.focusedPane.terminalView.terminal.paste('hello');
  firstPrompt(cp1.ptyId);
  await tick(100);
  check('claude: a paste while the shell loads cancels the send', sentTo(cp1.ptyId, CLAUDE, writesP1) === 0 && !state.writes.slice(writesP1).some((wr) => wr.data.includes('claude')), state.writes.slice(writesP1));
  check('claude: ...and is announced', live('assertive').includes('Claude not started'));
  const cp2 = await tm.userNewTab();
  const boardP2 = globalThis.__boards.at(-1);
  const writesP2 = state.writes.length;
  boardP2.host.startClaude();
  cp2.focusedPane.terminalView.terminal.input('dictated words', true);
  firstPrompt(cp2.ptyId);
  await tick(100);
  check('claude: dictated or IME text while the shell loads cancels the send', sentTo(cp2.ptyId, CLAUDE, writesP2) === 0, state.writes.slice(writesP2));
  const cp3 = await tm.userNewTab();
  const boardP3 = globalThis.__boards.at(-1);
  const writesP3 = state.writes.length;
  boardP3.host.startClaude();
  emit(cp3.ptyId, '\x1b[6n'); // the shell asks for the cursor position; the terminal answers through the same data event
  await tick(50);
  check('claude: the terminal\'s own reply to the shell does not cancel', state.writes.slice(writesP3).some((wr) => wr.id === cp3.ptyId && /^\[\d+;\d+R$/.test(wr.data.slice(1)) && wr.data[0] === '\x1b'), state.writes.slice(writesP3));
  firstPrompt(cp3.ptyId);
  check('claude: ...so it is still typed at the first prompt', await until(() => sentTo(cp3.ptyId, CLAUDE, writesP3) === 1, 800), state.writes.slice(writesP3));

  // Final review 4: timers use performance.now(); the pending entry goes when the send ends or its pane closes.
  check('claude: the shell clock is performance.now(), not Date.now()', cp3.focusedPane.shellProgress.startedAt < 1e11, cp3.focusedPane.shellProgress.startedAt);
  check('pending: cleared once the send finished', !boards.claudePending.has(cp3) && !boards.claudePending.has(ct) && !boards.claudePending.has(ch));
  check('pending: cleared when the user typed over it', !boards.claudePending.has(cp1) && !boards.claudePending.has(cp2));
  // A covered tab cannot split, so split a plain tab and put a board over it.
  const cq = await tm.createTab();
  tm.switchToId(cq.id);
  tm.splitVertical();
  await until(() => cq.panes.length === 2);
  boards.mount(cq, state.payload);
  const boardQ = globalThis.__boards.at(-1);
  boardQ.host.startClaude();
  const paneQ = cq.focusedPane;
  const pidQ = cq.ptyId;
  const writesQ = state.writes.length;
  check('pending: held while its pane waits', boards.claudePending.has(cq));
  cq.closePane(paneQ);
  check('pending: cleared when its pane closes', !boards.claudePending.has(cq) && cq.panes.length === 1);
  firstPrompt(pidQ);
  await tick(1700);
  check('claude: a pane closed during the wait gets no write', state.writes.slice(writesQ).every((wr) => wr.id !== pidQ), state.writes.slice(writesQ));

  // A tab closed before the click: nothing to type into, nothing thrown.
  const cg = await tm.userNewTab();
  const boardG = globalThis.__boards.at(-1);
  await tm.closeById(cg.id);
  const logG = logs.length;
  boardG.host.startClaude();
  check('claude: a click on a closed tab\'s board does nothing', logs.slice(logG).every((l) => l[0] !== '[BOARD] claude started'));
  const hostSrc = readFileSync(join(root, 'src', 'renderer', 'services', 'project-boards.ts'), 'utf8');
  check('claude: the host types FORCE_HYPERLINK=1 claude', /PLAIN_CLAUDE_COMMAND = 'FORCE_HYPERLINK=1 claude'/.test(hostSrc));

  // The slow shell from the top: marks but no first prompt, typed at SLOW_SHELL_MS after its PTY was created.
  check('claude slow shell: not typed while marks came but no first prompt', sentTo(cs.ptyId, CLAUDE, writesS) === 0 || Date.now() - tSlow >= 10000);
  check('claude slow shell: typed by the bounded fallback, ~10 s after creation', await until(() => sentTo(cs.ptyId, CLAUDE, writesS) === 1, 12000) && Date.now() - tSlow >= 9500, Date.now() - tSlow);
  await tm.closeById(ct.id);
  await tm.closeById(cl.id);
  state.settings = { startupCommand: '' };

  boards.dispose();
  console.info = info;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
