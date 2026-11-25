// Check of the tab menu's "Close and Reload" (25 Nov 2026, Michael: "In any
// project tab, when you right-click the dropdown menu, can we add 'Close and
// Reload'? ... close that tab and reload the same project with a fresh Claude
// thing"). Drives the REAL TabManager, TabBar, Tab, Pane and ConfirmDialog in
// jsdom (shared set-up scripts/tab-manager-harness.mjs) with a fake main: PTYs
// that record create / respawn / write / destroy, main's unsent-input tracker,
// the project lookup and the settings.
// Proves: the item shows on a project tab only, last in the menu, never in the
// multi-select menu; the reload is in place (same tab id, strip index, group),
// in the project's folder (a worktree tab's own path) with projectDir, with the
// startup command typed into the NEW pty; no question when nothing would be
// lost, a question for work running / Claude waiting / unsent input / the
// tracker failing, and Cancel leaves the old pty alone; a split tab respawns
// only the pane Claude runs in; a second press while one runs is ignored; the
// tab or pane closing during the question; no startup command; a failed
// respawn; the log lines; stash and plain-shell questions; the tab's own name
// and flag kept (the board's cleared); the stale green dot cleared; the startup
// command bound to the replaced pane; no failure announced for a closed tab or
// pane; the old shell ending mid-respawn.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-close-reload.mjs
import { checker, setUpTabManager, until, tick } from './tab-manager-harness.mjs';

const { check, section, finish } = checker();
const { w, doc, emit, logs, makeWindow } = await setUpTabManager({ tags: ['TAB', 'GROUP', 'STARTUP', 'DOT'] });

// ── A fake main on top of the harness's window.patton ──
const state = {
  creates: [], respawns: [], writes: [], destroyed: [],
  startupCommand: 'cc',
  inputState: 'clean', // 'clean' | 'dirty' | 'fail' | 'null'
  failRespawn: false,
  respawnDelayMs: 0,
  nextPty: 1000,
  settingsCalls: 0,
  inputOverride: null, // extra fields on main's unsent-input state (a stash)
};
const exitListeners = [];
const exitPty = (id) => { for (const cb of exitListeners) cb(id); };
const PROJECTS = {
  '/proj/alpha': { root: '/proj/alpha', defaultName: 'alpha' },
  '/proj/main': { root: '/proj/main', defaultName: 'main', worktree: { name: 'feature', path: '/proj/main-wt' } },
  '/proj/main-wt': { root: '/proj/main', defaultName: 'main', worktree: { name: 'feature', path: '/proj/main-wt' } },
};
const base = w.patton;
const basePty = base.pty;
const ptyStub = new Proxy(basePty, {
  get: (t, p) => {
    if (p === 'create') return async (opts) => { const id = state.nextPty++; state.creates.push({ id, opts }); return id; };
    if (p === 'respawn') return async (oldId, opts) => {
      if (state.respawnDelayMs) await tick(state.respawnDelayMs);
      if (state.failRespawn) throw new Error('respawn refused');
      const id = state.nextPty++;
      state.respawns.push({ oldId, id, opts });
      return id;
    };
    if (p === 'write') return (id, data) => { state.writes.push({ id, data }); };
    if (p === 'onExit') return (cb) => { exitListeners.push(cb); return () => { const i = exitListeners.indexOf(cb); if (i >= 0) exitListeners.splice(i, 1); }; };
    if (p === 'destroy') return (id) => { state.destroyed.push(id); };
    if (p === 'getCwd') return async (id) => state.creates.find((c) => c.id === id)?.opts?.cwd ?? '';
    if (p === 'inputState') return async (ids) => {
      if (state.inputState === 'fail') throw new Error('no tracker');
      if (state.inputState === 'null') return ids.map(() => null);
      const dirty = state.inputState === 'dirty';
      return ids.map(() => ({ dirty, length: dirty ? 4 : 0, lastInputAt: 0, slashSubmitAt: 0, userStashAt: 0, pattonStashAt: 0, ...(state.inputOverride ?? {}) }));
    };
    return t[p];
  },
});
w.patton = new Proxy(base, {
  get: (t, p) => {
    if (p === 'pty') return ptyStub;
    if (p === 'settings') return { get: async () => { state.settingsCalls++; return { startupCommand: state.startupCommand }; }, set: async () => {} };
    if (p === 'projects') return { getNames: async () => ({}), onNamesChanged: () => () => {}, resolve: async (cwd) => PROJECTS[cwd] ?? null, setName: async () => {} };
    return t[p];
  },
});

// rlog('error') reaches the console as console.error: keep those lines too.
const errorLogs = [];
const origError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && /^\[TAB\]/.test(args[0])) errorLogs.push({ msg: args[0], data: args[1] });
  else origError(...args);
};

// Every announcement (the announcer's live regions; their text clears itself).
const announced = [];
new w.MutationObserver((records) => {
  for (const r of records) {
    const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    if (el?.getAttribute?.('role') === 'status' && el.hasAttribute('aria-live') && el.textContent) announced.push({ text: el.textContent, live: el.getAttribute('aria-live') });
  }
}).observe(doc.body, { childList: true, characterData: true, subtree: true });

const root = (st, extra = '') => `\x1b]7501;state=${st}:app=claude-code${extra}\x07`;
const tabEl = (tm, id) => tm.bar.querySelector(`.tab-bar-tab[data-tab-id="${id}"]`);
const fire = (el, type, init = {}) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, screenX: 50, screenY: 50, ...init }));
const menuLabels = () => [...doc.querySelectorAll('.context-menu-overlay.visible .context-menu-item')].map((i) => (i.querySelector('span')?.textContent ?? i.textContent).trim());
const closeMenus = () => { for (const o of doc.querySelectorAll('.context-menu-overlay.visible')) o.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); };
const openMenu = (tm, id) => { fire(tabEl(tm, id), 'contextmenu', { clientX: 20, clientY: 20 }); return menuLabels(); };
const chooseItem = (label) => {
  const item = [...doc.querySelectorAll('.context-menu-overlay.visible .context-menu-item')].find((i) => (i.querySelector('span')?.textContent ?? i.textContent).trim() === label);
  item?.click();
  return !!item;
};
const dialog = () => doc.querySelector('.confirm-dialog-overlay.visible');
const dialogText = (sel) => dialog()?.querySelector(sel)?.textContent ?? '';
const reset = () => {
  state.creates.length = 0; state.respawns.length = 0; state.writes.length = 0; state.destroyed.length = 0;
  state.startupCommand = 'cc'; state.inputState = 'clean'; state.failRespawn = false; state.respawnDelayMs = 0; state.inputOverride = null;
};
const logsSince = (mark, msg) => logs.slice(mark).filter((l) => l.msg === msg);
/** Open a project tab and let its project lookup land. */
async function projectTab(tm, cwd) {
  const tab = await tm.createTab(cwd, { forProject: true });
  await until(() => tab.menuProject !== null);
  return tab;
}
/** Make the pane a Claude pane at rest (turn done, nothing running). */
async function claudeAtRest(pane) {
  emit(pane.ptyId, root('done'));
  await until(() => pane.isClaudePane);
}
const answer = async (which) => {
  await until(() => !!dialog());
  await tick(330); // the confirm's dwell (CONFIRM_SHORTCUT_DWELL_MS, 300 ms)
  dialog().querySelector(which === 'confirm' ? '.confirm-dialog-confirm' : '.confirm-dialog-cancel').click();
  await tick(10);
};

// ── 1. The menu ──
await section(async () => {
  const tm = await makeWindow([]);
  const plain = await tm.createTab();
  const proj = await projectTab(tm, '/proj/alpha');
  await tick(20);
  let labels = openMenu(tm, plain.id);
  check('menu: a tab outside any project has no Close and Reload', !labels.includes('Close and Reload'), labels);
  closeMenus();
  labels = openMenu(tm, proj.id);
  check('menu: a project tab has Close and Reload', labels.includes('Close and Reload'), labels);
  check('menu: it is the last entry', labels[labels.length - 1] === 'Close and Reload', labels);
  closeMenus();
  // Inactive tab: "Add Tab to Selection" shows and Close and Reload still comes after it.
  tm.switchToId(plain.id);
  await tick(10);
  labels = openMenu(tm, proj.id);
  check('menu: on an inactive tab it comes after Add Tab to Selection', labels.indexOf('Add Tab to Selection') >= 0 && labels.indexOf('Close and Reload') === labels.indexOf('Add Tab to Selection') + 1, labels);
  closeMenus();
  // Multi-select menu: ⌘-click the second tab to join the first.
  const a = await projectTab(tm, '/proj/alpha');
  tm.switchToId(a.id);
  await tick(10);
  fire(tabEl(tm, proj.id).querySelector('.tab-bar-tab-title'), 'mousedown', { metaKey: true });
  fire(doc, 'mouseup');
  await tick(10);
  labels = openMenu(tm, proj.id);
  check('menu: the multi-select menu has no Close and Reload', labels.length > 0 && !labels.includes('Close and Reload') && labels.some((l) => /Group|Flag/.test(l)), labels);
  closeMenus();
});

// ── 2. In place, folder, startup command, no question when nothing is lost ──
await section(async () => {
  reset();
  const tm = await makeWindow([]);
  const first = await tm.createTab();
  const tab = await projectTab(tm, '/proj/alpha');
  const last = await tm.createTab();
  tm.addTabToNewGroup(tab.id);
  const groupBefore = tm.getTabGroups().map((g) => g.tabIds.join());
  const indexBefore = tm.getTabs().indexOf(tab);
  tm.switchToId(tab.id);
  await claudeAtRest(tab.focusedPane);
  const oldPty = tab.focusedPane.ptyId;
  tab.setFlag('red');
  tab.setCustomTitle('My name');
  const pane0 = tab.focusedPane;
  let focusCalls = 0;
  const focusOrig = pane0.focus.bind(pane0);
  pane0.focus = (...a) => { focusCalls++; return focusOrig(...a); };
  const mark = logs.length;
  openMenu(tm, tab.id);
  check('in place: the menu item runs', chooseItem('Close and Reload'));
  const done = await until(() => state.respawns.length === 1, 3000);
  check('in place: main was asked to respawn the old pty', done && state.respawns[0].oldId === oldPty, state.respawns);
  check('in place: no question when idle', !dialog());
  const r = state.respawns[0];
  check('in place: cwd is the project folder and projectDir is set', r?.opts.cwd === '/proj/alpha' && r?.opts.projectDir === true, r?.opts);
  check('in place: hyperlinks asked for as a startup command runs', r?.opts.hyperlinks === true, r?.opts);
  await until(() => state.writes.some((x) => x.id === r?.id), 3000);
  const wr = state.writes.filter((x) => x.id === r?.id);
  check('startup command typed into the NEW pty', wr.length === 1 && wr[0].data === 'cc\r', wr);
  check('startup command not typed into the old pty', !state.writes.some((x) => x.id === oldPty));
  check('same tab object, same id', tm.getTabs().includes(tab) && tab.focusedPane.ptyId === r?.id);
  check('same strip index', tm.getTabs().indexOf(tab) === indexBefore, tm.getTabs().indexOf(tab));
  check('same group', JSON.stringify(tm.getTabGroups().map((g) => g.tabIds.join())) === JSON.stringify(groupBefore));
  check('other tabs untouched', first.ptyId !== null && last.ptyId !== null && state.respawns.length === 1);
  check('the tab keeps its own colour flag', tab.flag === 'red', tab.flag);
  check('the tab keeps its own name', tab.hasCustomTitle && tab.title === 'My name', tab.title);
  check('the new shell\'s pane is focused after the reload', focusCalls >= 1 && tm.activeTab === tab, focusCalls);
  const l = logsSince(mark, '[TAB] close and reload');
  check('log: [TAB] close and reload {tabId, pane, split:false, asked:null, answer:null, startup:true}',
    l.length === 1 && l[0].data.tabId === tab.id && l[0].data.split === false && l[0].data.asked === null && l[0].data.answer === null && l[0].data.startup === true && typeof l[0].data.pane === 'string', l.map((x) => x.data));
  check('log: no full path in the line', !JSON.stringify(l.map((x) => x.data)).includes('/proj'));
});

// ── 3. A linked worktree reloads in the worktree ──
await section(async () => {
  reset();
  const tm = await makeWindow([]);
  const tab = await projectTab(tm, '/proj/main-wt');
  await claudeAtRest(tab.focusedPane);
  await tm.closeAndReload(tab.id);
  check('worktree: respawned in the worktree path, not its main repo', state.respawns.length === 1 && state.respawns[0].opts.cwd === '/proj/main-wt' && state.respawns[0].opts.projectDir === true, state.respawns);
});

// ── 4. When something would be lost: ask first ──
const reasons = [
  ['work running', async (tab) => { emit(tab.focusedPane.ptyId, root('working')); await until(() => tab.focusedPane.pauseInput(null).running); }, 'Claude is still working in it.', 'running', 'clean'],
  ['Claude waiting on him', async (tab) => { emit(tab.focusedPane.ptyId, root('blocked', ':kind=permission')); await until(() => tab.focusedPane.pauseInput(null).blocked); }, 'Claude is waiting on you in it.', 'blocked', 'clean'],
  ['a working child over a finished turn', async (tab) => { emit(tab.focusedPane.ptyId, '\x1b]7501;state=working:id=bg1:app=claude-code\x07'); await until(() => tab.focusedPane.pauseInput(null).running); }, 'Claude is still working in it.', 'running', 'clean'],
  ['a kept Stop verdict with tasks', async (tab) => { emit(tab.focusedPane.ptyId, '\x1b]777;patton;stop;tasks=2;crons=0\x07'); await until(() => tab.focusedPane.pauseInput(null).running); }, 'Claude is still working in it.', 'running', 'clean'],
  ['a stash from his own Ctrl+S', async () => {}, 'It has text you stashed.', 'stashed', 'stashed'],
  ['unsent input', async () => {}, 'It has text you haven\'t sent.', 'draft', 'dirty'],
  ['the tracker failing', async () => {}, 'It has text you haven\'t sent.', 'unknown', 'fail'],
  ['the tracker answering null', async () => {}, 'It has text you haven\'t sent.', 'unknown', 'null'],
];
for (const [name, setUp, text, asked, tracker] of reasons) {
  await section(async () => {
    reset();
    const tm = await makeWindow([]);
    const tab = await projectTab(tm, '/proj/alpha');
    await claudeAtRest(tab.focusedPane);
    await setUp(tab);
    if (tracker === 'stashed') { state.inputState = 'clean'; state.inputOverride = { userStashAt: Date.now() + 60_000 }; } else state.inputState = tracker;
    const oldPty = tab.focusedPane.ptyId;
    const mark = logs.length;
    const p = tm.closeAndReload(tab.id);
    check(`ask (${name}): a dialog opens`, await until(() => !!dialog()));
    check(`ask (${name}): title names the tab`, /^Close and reload “.+”\?$/.test(dialogText('.confirm-dialog-title')), dialogText('.confirm-dialog-title'));
    const msg = dialogText('.confirm-dialog-message');
    check(`ask (${name}): message gives the reason and the consequence`, msg.includes(text) && msg.includes('Reloading ends this session and anything running in it, then starts a fresh one in alpha.'), msg);
    check(`ask (${name}): confirm label Close and Reload, nothing reloaded yet`, dialog().querySelector('.confirm-dialog-confirm').textContent === 'Close and Reload' && state.respawns.length === 0);
    await tick(330); // past the dwell: a ⌘W still must not confirm
    check(`ask (${name}): ⌘W with the dialog up is swallowed, not a confirm`, tm.confirmDialog.confirmByShortcut() === true && !!dialog() && state.respawns.length === 0);
    await answer('cancel');
    await p;
    check(`ask (${name}): Cancel leaves the old pty untouched`, state.respawns.length === 0 && state.destroyed.length === 0 && !state.writes.some((x) => x.id === oldPty) && tab.focusedPane.ptyId === oldPty, { respawns: state.respawns.length, destroyed: state.destroyed, writes: state.writes });
    const l = logsSince(mark, '[TAB] close and reload');
    check(`ask (${name}): cancel logged with the reason`, l.length === 1 && l[0].data.asked === asked && l[0].data.answer === false, l.map((x) => x.data));
    // Now the same, answered yes.
    const mark2 = logs.length;
    const p2 = tm.closeAndReload(tab.id);
    await answer('confirm');
    await p2;
    check(`ask (${name}): Close and Reload answered yes respawns`, state.respawns.length === 1 && state.respawns[0].oldId === oldPty, state.respawns);
    const l2 = logsSince(mark2, '[TAB] close and reload');
    check(`ask (${name}): yes logged with answer true`, l2.length === 1 && l2[0].data.asked === asked && l2[0].data.answer === true, l2.map((x) => x.data));
  });
}

// ── 5. A split tab: only the pane Claude runs in ──
await section(async () => {
  reset();
  const tm = await makeWindow([]);
  const tab = await projectTab(tm, '/proj/alpha');
  tm.switchToId(tab.id);
  const claudePane = tab.focusedPane;
  await claudeAtRest(claudePane);
  await tab.splitVertical('/proj/alpha');
  await tick(30);
  const shellPane = tab.focusedPane;
  check('split: two panes, the new shell is focused', tab.panes.length === 2 && shellPane !== claudePane);
  const claudePty = claudePane.ptyId;
  const shellPty = shellPane.ptyId;
  const mark = logs.length;
  await tm.closeAndReload(tab.id);
  check('split: only the Claude pane was respawned', state.respawns.length === 1 && state.respawns[0].oldId === claudePty, state.respawns);
  check('split: the shell pane keeps its pty and nothing was typed there', shellPane.ptyId === shellPty && !state.writes.some((x) => x.id === shellPty));
  check('split: still two panes, Claude\'s has the new pty', tab.panes.length === 2 && claudePane.ptyId === state.respawns[0]?.id);
  check('split: the Claude pane is focused, so the startup command went there', tab.focusedPane === claudePane);
  await until(() => state.writes.some((x) => x.id === claudePane.ptyId), 3000);
  check('split: startup command typed into the Claude pane\'s new pty', state.writes.some((x) => x.id === claudePane.ptyId && x.data === 'cc\r'), state.writes);
  const l = logsSince(mark, '[TAB] close and reload');
  check('split: logged split:true', l.length === 1 && l[0].data.split === true, l.map((x) => x.data));
  // The default refusal of Tab.respawnShell stays for the board.
  let refused = false;
  try { await tab.respawnShell({ cwd: '/proj/alpha' }); } catch { refused = true; }
  check('Tab.respawnShell still refuses a split tab without allowSplit', refused);

  // Claude in the focused pane when two panes run it: that one.
  reset();
  await claudeAtRest(shellPane);
  tab.focusPaneById(shellPane.id);
  const shellPty2 = shellPane.ptyId;
  await tm.closeAndReload(tab.id);
  check('split: Claude in both panes, the focused one is reloaded', state.respawns.length === 1 && state.respawns[0].oldId === shellPty2, state.respawns);
});

// ── 6. A second press while one runs, and the tab closing meanwhile ──
await section(async () => {
  reset();
  const tm = await makeWindow([]);
  const tab = await projectTab(tm, '/proj/alpha');
  await claudeAtRest(tab.focusedPane);
  state.respawnDelayMs = 150;
  const mark = logs.length;
  const p1 = tm.closeAndReload(tab.id);
  const p2 = tm.closeAndReload(tab.id);
  await Promise.all([p1, p2]);
  check('second call while one runs: one respawn only', state.respawns.length === 1, state.respawns);
  const ign = logsSince(mark, '[TAB] close and reload ignored');
  check('second call: logged as ignored', ign.length === 1 && ign[0].data.tabId === tab.id && /under way/.test(ign[0].data.reason), ign.map((x) => x.data));
  state.respawnDelayMs = 0;
  await claudeAtRest(tab.focusedPane); // the fresh shell is no Claude pane: Claude runs again
  await tm.closeAndReload(tab.id);
  check('after it finished a new call works again', state.respawns.length === 2);

  // The tab closes while the question is up.
  reset();
  const tm2 = await makeWindow([]);
  await tm2.createTab();
  const t2 = await projectTab(tm2, '/proj/alpha');
  await claudeAtRest(t2.focusedPane);
  emit(t2.focusedPane.ptyId, root('working'));
  await until(() => t2.focusedPane.pauseInput(null).running);
  const mark2 = logs.length;
  const q = tm2.closeAndReload(t2.id);
  await until(() => !!dialog());
  await tm2.closeById(t2.id);
  await until(() => !tm2.getTabs().includes(t2));
  await answer('confirm').catch(() => {});
  await q;
  check('tab closed during the question: nothing respawned', state.respawns.length === 0, state.respawns);
  const ign2 = logsSince(mark2, '[TAB] close and reload ignored');
  check('tab closed during the question: logged as ignored', ign2.length === 1 && ign2[0].data.reason === 'tab or pane changed', ign2.map((x) => x.data));
});

// ── 7. No startup command, a failed respawn, a tab with no project ──
await section(async () => {
  reset();
  state.startupCommand = '';
  const tm = await makeWindow([]);
  const tab = await projectTab(tm, '/proj/alpha');
  await claudeAtRest(tab.focusedPane);
  const mark = logs.length;
  await tm.closeAndReload(tab.id);
  await tick(1700); // past the 1.5 s prompt fallback
  check('no startup command: still a fresh shell in the folder', state.respawns.length === 1 && state.respawns[0].opts.cwd === '/proj/alpha' && !state.respawns[0].opts.hyperlinks, state.respawns);
  const newId = state.respawns[0]?.id;
  check('no startup command: nothing typed into the new pty', newId !== undefined && !state.writes.some((x) => x.id === newId), state.writes);
  const l = logsSince(mark, '[TAB] close and reload');
  check('no startup command: logged startup:false', l.length === 1 && l[0].data.startup === false, l.map((x) => x.data));

  reset();
  state.failRespawn = true;
  await claudeAtRest(tab.focusedPane);
  const oldPty = tab.focusedPane.ptyId;
  const mark2 = logs.length;
  await tm.closeAndReload(tab.id);
  check('failed respawn: the old shell is still the tab\'s', state.respawns.length === 0 && tab.focusedPane.ptyId === oldPty && state.destroyed.length === 0);
  check('failed respawn: logged with the tab id and error', errorLogs.some((x) => x.msg === '[TAB] close and reload failed' && x.data.tabId === tab.id && /respawn refused/.test(x.data.error)), errorLogs);
  check('failed respawn: no success line logged', logsSince(mark2, '[TAB] close and reload').length === 0);
  state.failRespawn = false;

  reset();
  const plain = await tm.createTab();
  await tm.closeAndReload(plain.id);
  check('a tab with no project: nothing happens', state.respawns.length === 0);
});

// ── 8. A plain shell tab: ask unless the shell is known to be at its prompt ──
const OSC133 = (c) => `\x1b]133;${c}\x07`;
for (const [name, marks, asks, text, asked] of [
  ['a command running (OSC 133 C)', [OSC133('A'), OSC133('C')], true, 'A command is still running in it.', 'command'],
  ['no shell integration (no marks)', [], true, 'A command may still be running in it.', 'unknown-shell'],
  ['at its prompt (A)', [OSC133('A')], false, '', null],
  ['a command finished (C then D)', [OSC133('C'), OSC133('D')], false, '', null],
]) {
  await section(async () => {
    reset();
    const tm = await makeWindow([]);
    const tab = await projectTab(tm, '/proj/alpha');
    const pane = tab.focusedPane;
    for (const m of marks) emit(pane.ptyId, m);
    await tick(30);
    const oldPty = pane.ptyId;
    const mark = logs.length;
    const p = tm.closeAndReload(tab.id);
    if (asks) {
      check(`shell (${name}): a dialog opens`, await until(() => !!dialog()));
      const msg = dialogText('.confirm-dialog-message');
      check(`shell (${name}): says why`, msg.includes(text), msg);
      await answer('cancel');
      await p;
      check(`shell (${name}): Cancel leaves the shell alone`, state.respawns.length === 0 && pane.ptyId === oldPty);
      const l = logsSince(mark, '[TAB] close and reload');
      check(`shell (${name}): cancel logged as asked:${asked}`, l.length === 1 && l[0].data.asked === asked && l[0].data.answer === false, l.map((x) => x.data));
    } else {
      await p;
      check(`shell (${name}): no question, reloaded at once`, !dialog() && state.respawns.length === 1 && state.respawns[0].oldId === oldPty, state.respawns);
      check(`shell (${name}): the fresh shell's prompt state starts unknown`, pane.shellAtPrompt === null, pane.shellAtPrompt);
    }
  });
}

// ── 9. The board's fresh tab still loses its own name and flag; Close and Reload keeps them ──
await section(async () => {
  reset();
  const tm = await makeWindow([]);
  const tab = await projectTab(tm, '/proj/alpha');
  tab.setFlag('blue');
  tab.setCustomTitle('Mine');
  await tm.respawnTab(tab, { cwd: '/proj/alpha', projectDir: true });
  check('board respawn (no keepName): the flag and the own name are cleared', tab.flag === null && !tab.hasCustomTitle, { flag: tab.flag, own: tab.hasCustomTitle });
});

// ── 10. A stale green dot goes with the old shell ──
await section(async () => {
  reset();
  state.startupCommand = '';
  const tm = await makeWindow([]);
  const other = await tm.createTab();
  const tab = await projectTab(tm, '/proj/alpha');
  tm.switchToId(other.id);
  await tick(10);
  emit(tab.focusedPane.ptyId, root('working'));
  await until(() => tab.focusedPane.pauseInput(null).running);
  emit(tab.focusedPane.ptyId, root('done'));
  check('dot: the finished turn on an inactive tab raises the green dot', await until(() => tab.awaitingInput === true, 3000));
  const mark = logs.length;
  await tm.closeAndReload(tab.id);
  check('dot: Close and Reload clears it', tab.awaitingInput === false);
  check('dot: logged green cleared with why respawn', logsSince(mark, '[DOT] green cleared').some((l) => l.data.why === 'respawn' && l.data.tabId === tab.id), logs.slice(mark).map((l) => l.msg));
  // The board's respawn too.
  emit(tab.focusedPane.ptyId, root('working'));
  await until(() => tab.focusedPane.pauseInput(null).running);
  emit(tab.focusedPane.ptyId, root('done'));
  await until(() => tab.awaitingInput === true, 3000);
  await tm.respawnTab(tab, { cwd: '/proj/alpha', projectDir: true });
  check('dot: the board\'s respawn clears it too', tab.awaitingInput === false);
});

// ── 11. The startup command goes to the replaced pane's new pty only ──
await section(async () => {
  reset();
  const tm = await makeWindow([]);
  const tab = await projectTab(tm, '/proj/alpha');
  tm.switchToId(tab.id);
  const claudePane = tab.focusedPane;
  await claudeAtRest(claudePane);
  await tab.splitVertical('/proj/alpha');
  await tick(30);
  const shellPane = tab.focusedPane;
  const shellPty = shellPane.ptyId;
  state.respawnDelayMs = 200;
  const p = tm.closeAndReload(tab.id);
  await tick(60);
  tab.focusPaneById(shellPane.id); // he clicks the other pane while main starts the shell
  await p;
  await tick(1700);
  const newId = claudePane.ptyId;
  check('race: the command went to the replaced pane\'s new pty', state.writes.some((x) => x.id === newId && x.data === 'cc\r'), state.writes);
  check('race: nothing was typed into the pane he clicked', !state.writes.some((x) => x.id === shellPty), state.writes);
  check('race: his focus stays where he put it', tab.focusedPane === shellPane);
});

// ── 12. The pane or tab closing while main starts the shell: no failure announced ──
await section(async () => {
  reset();
  const tm = await makeWindow([]);
  const tab = await projectTab(tm, '/proj/alpha');
  tm.switchToId(tab.id);
  const claudePane = tab.focusedPane;
  await claudeAtRest(claudePane);
  await tab.splitVertical('/proj/alpha');
  await tick(30);
  state.respawnDelayMs = 150;
  const mark = logs.length;
  const a = announced.length;
  const p = tm.closeAndReload(tab.id);
  await tick(50);
  tab.closePane(claudePane); // the pane closes while main starts the shell
  await p;
  const ign = logsSince(mark, '[TAB] close and reload ignored');
  check('pane closed meanwhile: logged as ignored', ign.some((l) => /closed during the reload/.test(l.data.reason)), ign.map((x) => x.data));
  check('pane closed meanwhile: no failure logged or announced', !errorLogs.some((x) => x.data?.tabId === tab.id && x.msg === '[TAB] close and reload failed') && !announced.slice(a).some((x) => /Could not reload/.test(x.text)), announced.slice(a));

  reset();
  const tm2 = await makeWindow([]);
  await tm2.createTab();
  const t2 = await projectTab(tm2, '/proj/alpha');
  await claudeAtRest(t2.focusedPane);
  state.respawnDelayMs = 150;
  const a2 = announced.length;
  const mark2 = logs.length;
  const q = tm2.closeAndReload(t2.id);
  await tick(50);
  await tm2.closeById(t2.id);
  await q;
  check('tab closed meanwhile: no failure announced', !announced.slice(a2).some((x) => /Could not reload/.test(x.text)), announced.slice(a2));
  check('tab closed meanwhile: logged as ignored', logsSince(mark2, '[TAB] close and reload ignored').length >= 1);
});

// ── 13. The old shell ending during the respawn does not close the tab ──
await section(async () => {
  reset();
  const tm = await makeWindow([]);
  await tm.createTab();
  const tab = await projectTab(tm, '/proj/alpha');
  tm.switchToId(tab.id);
  const pane = tab.focusedPane;
  await claudeAtRest(pane);
  const oldPty = pane.ptyId;
  state.respawnDelayMs = 150;
  const p = tm.closeAndReload(tab.id);
  await tick(60);
  exitPty(oldPty); // the old shell ends while main starts the new one
  await p;
  check('old shell exit mid-respawn: the tab survives', tm.getTabs().includes(tab));
  check('old shell exit mid-respawn: the pane runs the new shell', pane.ptyId === state.respawns[0]?.id && pane.ptyId !== oldPty, pane.ptyId);
  exitPty(pane.ptyId); // the NEW shell ending closes the tab as usual
  check('old shell exit mid-respawn: the new shell is registered (its exit closes the tab)', await until(() => !tm.getTabs().includes(tab), 3000));

  // ...and when that respawn then fails, the dead pane closes as its exit would have.
  reset();
  const tm3 = await makeWindow([]);
  await tm3.createTab();
  const t3 = await projectTab(tm3, '/proj/alpha');
  tm3.switchToId(t3.id);
  await claudeAtRest(t3.focusedPane);
  const old3 = t3.focusedPane.ptyId;
  state.respawnDelayMs = 150;
  state.failRespawn = true;
  const q = tm3.closeAndReload(t3.id);
  await tick(60);
  exitPty(old3);
  await q;
  check('old shell exit, then the respawn fails: the dead tab closes', !tm3.getTabs().includes(t3), tm3.getTabs().length);
});

finish();
