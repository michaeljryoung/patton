// Headless check of the tab strip's "Pause all" button (10 Nov 2026). Michael
// types `pause` into each Claude session before shutting the laptop (a Claude
// Code hook then suspends the jobs it started) and `resume` later; the button
// does that for every Claude pane in every window.
// Drives the REAL TabManager + TabBar in two jsdom windows, the REAL
// PauseAllCoordinator (main/pause-all.ts) standing in for main's IPC between
// them, main's REAL UnsentInputTracker (main/unsent-input.ts) behind
// pty.write / pty.inputState, the REAL stash-key verdict (main/stash-key.ts)
// on keybindings.json text, and REAL Panes (constructed and init()ed, with the
// terminal, editor and overlays stubbed). Pane state comes only through the
// Pane's own listeners: OSC 7501 bodies through the real parseProgramStatus,
// Stop-hook messages through the real parsePattonOsc, window titles, and
// keystrokes as terminal data, so the bytes checked are the bytes the app writes.
// Covers: the button sits right of the checkpoint clock and its label
// toggles; pause sends `pause\r` to done-after-a-turn, working and title-path
// stopped panes and skips blocked (permission, question, a blocked child),
// error, fresh idle, a `/model` menu, a title path typed into since the stop,
// plain shells and exited shells; a draft gets `\x13pause\r` (one Ctrl+S); a
// draft erased by Backspace gets a plain send; a user Ctrl+S skips the pane;
// a rebound stash key skips draft panes; resume goes to exactly the paused
// set and skips a respawned shell, a closed pane and a draft Patton stashed;
// "Pause remaining" retries only the skipped; the checkpoint button stashes a
// draft the same way; the summary names skipped tabs and splits at-the-prompt
// from queued. Main side: a window closed mid-press, a send that throws, a
// late report, a second press, and an untrusted report.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-pause-all.mjs
//   jsdom is not a project dependency: install it in a scratch folder.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

// The terminal view records every `onX(cb)` listener so the check can fire
// them as xterm would; anything else on it, and the editor and overlays, is a
// deep no-op stub.
const stubSource = `
  const mk = () => new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()),
    apply: () => mk(), construct: () => mk(),
  });
  export class TerminalView {
    constructor() {
      const listeners = {};
      const own = {
        __emit: (k, ...a) => { for (const cb of listeners[k] ?? []) cb(...a); },
        terminal: new Proxy({ modes: { bracketedPasteMode: true }, options: {} }, {
          get: (t, k) => (k in t ? t[k] : mk()),
        }),
      };
      return new Proxy(own, {
        get: (t, k) => {
          if (k in t) return t[k];
          if (typeof k === 'string' && /^on[A-Z]/.test(k)) {
            return (cb) => { (listeners[k] ??= []).push(cb); return () => {}; };
          }
          return k === 'then' ? undefined : mk();
        },
      });
    }
  }
  export const EditorInput = mk(), SearchOverlay = mk(), HistorySearch = mk(), PasteDialog = mk(),
    DEFAULT_COMPOSE_PLACEHOLDER = '';`;
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /\/(terminal-view|editor-input|search-overlay|history-search|paste-dialog)$/ },
      (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stubSource, loader: 'js' }));
  },
};

const rendererBundle = await build({
  stdin: {
    contents: `
      export { TabManager } from './src/renderer/services/tab-manager';
      export { Pane } from './src/renderer/components/pane';
      export { pauseSummary } from './src/renderer/services/pause-all';
      export { parseProgramStatus } from './src/renderer/services/program-status';
      export { parsePattonOsc } from './src/renderer/services/patton-osc';
    `,
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true, format: 'iife', globalName: 'PA', platform: 'browser', write: false,
  loader: { '.css': 'empty' }, plugins: [stubs], logLevel: 'silent',
});
const rendererCode = rendererBundle.outputFiles[0].text;

// Main's side: no Electron import in any of these, so they bundle for Node as is.
const mainBundle = await build({
  stdin: {
    contents: `
      export { PauseAllCoordinator, cleanReport } from './src/main/pause-all';
      export { UnsentInputTracker } from './src/main/unsent-input';
      export { stashKeyVerdict } from './src/main/stash-key';
    `,
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
const M = await import('data:text/javascript;base64,' + Buffer.from(mainBundle.outputFiles[0].text).toString('base64'));
const IPC_RUN = 'pause-all:run';
const IPC_MODE = 'pause-all:mode';

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main: one tracker (every PTY write passes it), the keybindings file, the coordinator ──
const tracker = new M.UnsentInputTracker();
const KEYS_DEFAULT = JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+s': 'chat:stash', 'ctrl+r': 'history:search' } }] });
const KEYS_REBOUND = JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+s': 'chat:submit', 'ctrl+t': 'chat:stash' } }] });
let keybindings = KEYS_DEFAULT;
const mainLogs = [];

const windows = [];
const coordinator = new M.PauseAllCoordinator(() => windows.map((win) => ({
  id: win.id,
  alive: () => !win.gone,
  send: (channel, payload) => {
    if (channel === IPC_RUN) for (const cb of win.onRun) cb(payload);
    if (channel === IPC_MODE) for (const cb of win.onMode) cb(payload);
  },
  onClosed: () => () => {},
})), 1000, (msg, data) => mainLogs.push([msg, data]));

// A deep no-op stub with some keys replaced: anything a check doesn't care about.
const deep = () => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : deep()),
  apply: () => Promise.resolve(undefined),
});
const stubWith = (overrides) => new Proxy(function () {}, {
  get: (_t, k) => (k in overrides ? overrides[k] : k === 'then' ? undefined : deep()),
  apply: () => Promise.resolve(undefined),
});

let ptySeq = 0;
function makeWindow(id) {
  const win = { id, gone: false, onRun: [], onMode: [], writes: [], logs: [], exitCbs: [] };
  const dom = new JSDOM('<!doctype html><body><div id="bar"></div><div id="content"></div></body>', {
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  win.w = w;
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.patton = stubWith({
    pty: stubWith({
      create: () => Promise.resolve(++ptySeq),
      respawn: () => Promise.resolve(++ptySeq),
      getShell: () => Promise.resolve('/bin/zsh'),
      getCwd: () => Promise.resolve(''),
      write: (ptyId, data, origin) => {
        tracker.note(ptyId, data, origin);
        win.writes.push([ptyId, data]);
      },
      inputState: (ids) => Promise.resolve(ids.map((i) => tracker.state(i))),
      onData: () => () => {},
      onExit: (cb) => { win.exitCbs.push(cb); return () => {}; },
    }),
    history: stubWith({ get: () => Promise.resolve([]), add: () => Promise.resolve(), clear: () => Promise.resolve() }),
    log: { send: (_lvl, args) => win.logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) },
    pauseAll: {
      press: (kind) => coordinator.press(kind ?? 'next'),
      mode: () => Promise.resolve(coordinator.mode),
      onRun: (cb) => { win.onRun.push(cb); return () => {}; },
      onMode: (cb) => { win.onMode.push(cb); return () => {}; },
      report: (requestId, report) => Promise.resolve(coordinator.report(id, requestId, report)),
      stashKey: () => Promise.resolve(M.stashKeyVerdict(keybindings)),
    },
  });
  w.eval(rendererCode);
  win.PA = w.PA;
  win.tm = new w.PA.TabManager(w.document.getElementById('bar'), w.document.getElementById('content'));
  windows.push(win);
  return win;
}

// A real Pane, init()ed (its shell is created through pty.create).
async function makePane(win) {
  const p = new win.PA.Pane({ onFocus() {}, onTitleChange() {} });
  await p.init();
  return p;
}
// What the pane's terminal would hand it.
const view = (p) => p.terminalView;
const report = (win, p, body) => view(p).__emit('onProgramStatus', win.PA.parseProgramStatus(body));
const title = (p, t) => view(p).__emit('onTitleChange', t);
const stopHook = (win, p) => view(p).__emit('onPattonState', win.PA.parsePattonOsc('patton;stop;tasks=0;crons=0'));
const type = (p, data) => view(p).__emit('onTerminalData', data);
const exitShell = (win, p) => { for (const cb of win.exitCbs) cb(p.ptyId); };
const ROOT = (state, extra = '') => `state=${state}:app=claude-code${extra}`;
// A Claude session that has had a turn and is back at its prompt.
const doneAfterTurn = (win, p) => { report(win, p, ROOT('working')); report(win, p, ROOT('done')); };

const setTabs = (win, tabs) => {
  win.tm.tabs = tabs;
  win.tm.activeTab = tabs[0] ?? null;
};
const tab = (id, panes) => ({ id, title: id, panes, focusedPane: panes[0], dispose() {} });
// What each pane's pty received, joined.
const bytesByPty = (win) => {
  const out = new Map();
  for (const [id, data] of win.writes) out.set(id, (out.get(id) ?? '') + data);
  return out;
};
const clearWrites = () => { for (const win of windows) win.writes.length = 0; };
const btnOf = (win) => win.w.document.querySelector('.tab-bar-pause-all');
// A press and the stash path's 150 ms settle.
const press = async (win, kind = 'next') => { await win.tm.pressPauseAll(kind); await wait(250); };

const A = makeWindow(1);
const B = makeWindow(2);
await wait(5);

// ── 1. Position, look and label ──
{
  const bar = A.w.document.getElementById('bar');
  const kids = Array.from(bar.children);
  const ck = bar.querySelector('.tab-bar-checkpoint');
  const btn = btnOf(A);
  check('pause button exists', !!btn);
  check('pause button is the strip\'s last child (far right)', kids[kids.length - 1] === btn, kids.map((k) => k.className));
  check('pause button is right of the checkpoint clock', kids.indexOf(ck) >= 0 && kids.indexOf(ck) < kids.indexOf(btn), kids.map((k) => k.className));
  check('label reads Pause all', btn.textContent === '⏸ Pause all', btn.textContent);
  check('is a real button', btn.tagName === 'BUTTON' && btn.type === 'button');
  check('aria-label says what it does', /type pause into every Claude session/.test(btn.getAttribute('aria-label') ?? ''), btn.getAttribute('aria-label'));
  check('tooltip matches the aria-label', btn.title === btn.getAttribute('aria-label'));
  check('shown even with no Claude pane (clock hidden)', btn.hidden === false && ck.hidden === true);
  check('Pause remaining hidden before any pause', bar.querySelector('.tab-bar-pause-remaining').hidden === true);
}

// ── 2. Pause: who gets the word ──
const a = {};
for (const k of ['done', 'work', 'perm', 'quest', 'err', 'fresh', 'menu', 'child', 'draft', 'bs', 'userStash', 'shell', 'dead', 'titleDone', 'titleStale', 'close']) {
  a[k] = await makePane(A);
}
const b = { done: await makePane(B) };

doneAfterTurn(A, a.done);
report(A, a.work, ROOT('working'));
report(A, a.perm, ROOT('working')); report(A, a.perm, ROOT('blocked', ':kind=permission'));
report(A, a.quest, ROOT('working')); report(A, a.quest, ROOT('blocked', ':kind=question'));
report(A, a.err, ROOT('working')); report(A, a.err, ROOT('error'));
report(A, a.fresh, ROOT('idle'));
doneAfterTurn(A, a.menu);
report(A, a.child, ROOT('working')); report(A, a.child, 'state=blocked:id=t1:kind=permission:app=claude-code');
doneAfterTurn(A, a.draft);
doneAfterTurn(A, a.bs);
doneAfterTurn(A, a.userStash);
title(a.shell, 'zsh');
doneAfterTurn(A, a.dead);
for (const k of ['titleDone', 'titleStale']) { title(a[k], '◐ Working'); stopHook(A, a[k]); title(a[k], '✳ Claude Code'); }
doneAfterTurn(A, a.close);
doneAfterTurn(B, b.done);
await wait(5); // keystrokes come after the reports and the Stop hook
type(a.menu, '/model'); type(a.menu, '\r');
type(a.draft, 'hello');
type(a.bs, 'ab'); type(a.bs, '\x7f'); type(a.bs, '\x7f');
type(a.userStash, 'abc'); type(a.userStash, '\x13'); type(a.userStash, 'def');
exitShell(A, a.dead);
type(a.titleStale, 'x'); type(a.titleStale, '\x7f');
const order = ['done', 'work', 'perm', 'quest', 'err', 'fresh', 'menu', 'child', 'draft', 'bs', 'userStash', 'shell', 'dead', 'titleDone', 'titleStale', 'close'];
setTabs(A, order.map((k) => tab(k, [a[k]])));
setTabs(B, [tab('b-done', [b.done])]);
clearWrites();

btnOf(A).click();
await wait(300);
{
  const wa = bytesByPty(A);
  const plain = ['done', 'work', 'bs', 'titleDone', 'close'];
  for (const k of plain) check(`pause: ${k} pane gets exactly "pause\\r"`, wa.get(a[k].ptyId) === 'pause\r', wa.get(a[k].ptyId));
  check('pause: draft pane gets Ctrl+S, pause, Enter', wa.get(a.draft.ptyId) === '\x13pause\r', wa.get(a.draft.ptyId));
  check('pause: draft pane gets exactly one Ctrl+S', (wa.get(a.draft.ptyId) ?? '').split('\x13').length === 2);
  const draftWrites = A.writes.filter(([id]) => id === a.draft.ptyId).map(([, d]) => d);
  check('pause: draft pane writes are Ctrl+S, then the word, then Enter', JSON.stringify(draftWrites) === JSON.stringify(['\x13', 'pause', '\r']), draftWrites);
  for (const k of ['perm', 'quest', 'err', 'fresh', 'menu', 'child', 'userStash', 'shell', 'dead', 'titleStale']) {
    check(`pause: ${k} pane gets nothing`, !wa.has(a[k].ptyId), wa.get(a[k].ptyId));
  }
  check('pause: no Ctrl+S anywhere but the draft pane', A.writes.filter(([id, d]) => d.includes('\x13') && id !== a.draft.ptyId).length === 0);
  check('pause: other window\'s pane gets "pause\\r"', bytesByPty(B).get(b.done.ptyId) === 'pause\r', bytesByPty(B).get(b.done.ptyId));
  check('pause: nothing else written anywhere', wa.size === 6 && B.writes.length === 2, [[...wa.keys()], B.writes]);
  const text = btnOf(A).textContent;
  check('pause: summary splits at-the-prompt from queued and names skipped tabs',
    text === 'Paused 7 Claude sessions (6 at the prompt, 1 queued behind a running turn); skipped 8: perm (waiting on you), quest (waiting on you), err (state unclear), 5 more', text);
  check('pause: clicked window now in resume mode, 8 left', A.tm.tabBar.pauseMode.next === 'resume' && A.tm.tabBar.pauseMode.left === 8, A.tm.tabBar.pauseMode);
  check('pause: other window\'s button turns to Resume all', btnOf(B).textContent === '▶ Resume all', btnOf(B).textContent);
  const rem = B.w.document.querySelector('.tab-bar-pause-remaining');
  check('pause: Pause remaining shown with the count', rem.hidden === false && rem.textContent === 'Pause 8 remaining', [rem.hidden, rem.textContent]);
  const log = A.logs.find((l) => l.includes('[PAUSE-ALL] run'));
  const reasonOf = (k) => `"pane":"${a[k].id}","reason":"`;
  const why = (k) => { const i = log?.indexOf(reasonOf(k)) ?? -1; return i < 0 ? null : log.slice(i + reasonOf(k).length).split('"')[0]; };
  const expected = { perm: 'waiting', quest: 'waiting', child: 'waiting', err: 'unclear', fresh: 'fresh', menu: 'menu', userStash: 'stashed', shell: 'not-claude', dead: 'no-shell', titleStale: 'unclear' };
  for (const [k, r] of Object.entries(expected)) check(`pause: rlog gives ${k} the reason ${r}`, why(k) === r, why(k));
  check('pause: rlog carries no typed text', !A.logs.some((l) => l.includes('PAUSE-ALL') && /hello|abcdef|\/model/.test(l)));
  check('pause: press summary logged by main', mainLogs.some(([m, d]) => m === '[PAUSE-ALL] press' && d.answered === 2 && d.sent === 7), mainLogs.map(([m]) => m));
}

// ── 3. The label returns to Resume all once the result has shown ──
{
  const btn = btnOf(A);
  check('result is styled as a transient message', btn.classList.contains('reason'));
  A.tm.tabBar.showPauseResult('x'); // re-arm with a short wait for the check
  await wait(4100);
  check('after the result: Resume all', btn.textContent === '▶ Resume all' && !btn.classList.contains('reason'), btn.textContent);
  check('Resume all aria-label offers the skipped', /type resume into every Claude session Pause all paused.*Option-click: pause the 8 skipped/.test(btn.getAttribute('aria-label') ?? ''), btn.getAttribute('aria-label'));
}

// ── 4. Pause remaining: only the skipped ones that can take it now ──
report(A, a.perm, ROOT('done')); // the permission was answered and the turn ended
await wait(5);
report(A, a.menu, ROOT('done')); // Claude reported after the /model: no menu now
clearWrites();
B.w.document.querySelector('.tab-bar-pause-remaining').click();
await wait(300);
{
  const wa = bytesByPty(A);
  check('remaining: answered-permission pane gets "pause\\r"', wa.get(a.perm.ptyId) === 'pause\r', wa.get(a.perm.ptyId));
  check('remaining: menu pane with a report since gets "pause\\r"', wa.get(a.menu.ptyId) === 'pause\r', wa.get(a.menu.ptyId));
  check('remaining: no pane paused before gets a second word', wa.size === 2 && B.writes.length === 0, [[...wa.keys()], B.writes]);
  check('remaining: still Resume all, 6 left', B.tm.tabBar.pauseMode.next === 'resume' && B.tm.tabBar.pauseMode.left === 6, B.tm.tabBar.pauseMode);
}

// ── 5. Resume: exactly the paused set, by the rules at this moment ──
await a.bs.respawn({}); // a new shell in a paused pane
setTabs(A, order.filter((k) => k !== 'close').map((k) => tab(k, [a[k]]))); // the close pane's tab closed
clearWrites();
btnOf(B).click(); // resume from the other window
await wait(300);
{
  const wa = bytesByPty(A);
  for (const k of ['done', 'work', 'titleDone', 'perm', 'menu']) {
    check(`resume: paused ${k} pane gets exactly "resume\\r"`, wa.get(a[k].ptyId) === 'resume\r', wa.get(a[k].ptyId));
  }
  check('resume: other window\'s paused pane gets "resume\\r"', bytesByPty(B).get(b.done.ptyId) === 'resume\r');
  check('resume: respawned shell gets nothing', !wa.has(a.bs.ptyId));
  check('resume: draft Patton stashed (no user submit since) gets nothing', !wa.has(a.draft.ptyId), wa.get(a.draft.ptyId));
  for (const k of ['quest', 'err', 'fresh', 'child', 'userStash', 'shell', 'titleStale']) {
    check(`resume: never-paused ${k} pane gets nothing`, !wa.has(a[k].ptyId));
  }
  check('resume: no Ctrl+S sent', !A.writes.some(([, d]) => d.includes('\x13')));
  const text = btnOf(B).textContent;
  check('resume: summary names the skipped',
    text === 'Resumed 6 Claude sessions (5 at the prompt, 1 queued behind a running turn); skipped 3: bs (a different session now), a closed pane (closed since), draft (draft: you have stashed text here)', text);
  check('resume: both windows back to Pause all', A.tm.tabBar.pauseMode.next === 'pause' && B.tm.tabBar.pauseMode.next === 'pause');
  check('resume: Pause all label back in the other window', btnOf(A).textContent === '⏸ Pause all', btnOf(A).textContent);
  check('resume: Pause remaining hidden again', A.w.document.querySelector('.tab-bar-pause-remaining').hidden === true);
  check('resume: paused sets emptied', A.tm.pauseAll.pausedIds.length === 0 && B.tm.pauseAll.pausedIds.length === 0);
}

// ── 6. A user submit clears Patton's stash; a Claude session change is "changed" ──
{
  const p = await makePane(A);
  const q = await makePane(A);
  doneAfterTurn(A, p); doneAfterTurn(A, q);
  await wait(3);
  type(p, 'note');
  setTabs(A, [tab('p', [p]), tab('q', [q])]);
  setTabs(B, []);
  clearWrites();
  await press(A);
  check('stash cycle: draft pane paused with Ctrl+S', bytesByPty(A).get(p.ptyId) === '\x13pause\r', bytesByPty(A).get(p.ptyId));
  // Claude quits and a new one starts in q (same shell).
  report(A, q, 'state=clear'); report(A, q, ROOT('working')); report(A, q, ROOT('done'));
  // The user sends the restored draft, then starts another.
  type(p, '\r'); type(p, 'next');
  clearWrites();
  await press(A);
  check('stash cycle: after a user submit, resume stashes the new draft', bytesByPty(A).get(p.ptyId) === '\x13resume\r', bytesByPty(A).get(p.ptyId));
  check('session change: new Claude session in the same shell gets nothing', !bytesByPty(A).has(q.ptyId));
  check('session change: named as a different session', btnOf(A).textContent.includes('q (a different session now)'), btnOf(A).textContent);
}

// ── 7. A rebound stash key: drafts skipped, clean panes still paused ──
{
  keybindings = KEYS_REBOUND;
  const d = await makePane(A);
  const c = await makePane(A);
  doneAfterTurn(A, d); doneAfterTurn(A, c);
  type(d, 'half a thought');
  setTabs(A, [tab('rb-draft', [d]), tab('rb-clean', [c])]);
  clearWrites();
  await press(A);
  check('rebound key: draft pane gets nothing', !bytesByPty(A).has(d.ptyId), bytesByPty(A).get(d.ptyId));
  check('rebound key: clean pane gets "pause\\r"', bytesByPty(A).get(c.ptyId) === 'pause\r');
  check('rebound key: summary says why', btnOf(A).textContent.includes('rb-draft (draft: stash key rebound)'), btnOf(A).textContent);
  check('rebound key: rlog names the binding', A.logs.some((l) => l.includes('[PAUSE-ALL] run') && l.includes('ctrl+s is bound to chat:submit')));
  await press(A); // resume, back to Pause all
  keybindings = KEYS_DEFAULT;
}

// ── 8. Nothing ready leaves the button at Pause all ──
{
  const s = await makePane(A);
  const f = await makePane(A);
  title(s, 'zsh');
  report(A, f, ROOT('idle'));
  setTabs(A, [tab('sh', [s]), tab('new', [f])]);
  clearWrites();
  await press(A);
  check('nothing ready: no writes', A.writes.length === 0 && B.writes.length === 0);
  check('nothing ready: still Pause all', A.tm.tabBar.pauseMode.next === 'pause');
  check('nothing ready: says so', btnOf(A).textContent === 'Nothing paused; skipped 1: new (new session)', btnOf(A).textContent);
}

// ── 9. The checkpoint button: same stash path ──
{
  const p = await makePane(A);
  doneAfterTurn(A, p);
  report(A, p, ROOT('done')); // and the clock shows
  type(p, 'draft line');
  setTabs(A, [tab('ck', [p])]);
  A.tm.updateCheckpoint();
  clearWrites();
  A.w.document.querySelector('.tab-bar-checkpoint').click();
  await wait(300);
  const writes = A.writes.filter(([id]) => id === p.ptyId).map(([, d]) => d);
  check('checkpoint: draft stashed, then /checkpoint, then Enter', JSON.stringify(writes) === JSON.stringify(['\x13', '/checkpoint', '\r']), writes);
  // Claude ran it and is back at its prompt; the draft is back, and Patton's
  // stash mark holds until a user submit.
  await wait(3);
  doneAfterTurn(A, p);
  clearWrites();
  await A.tm.runCheckpoint();
  await wait(250);
  check('checkpoint: second run while Patton\'s stash mark holds sends nothing', A.writes.length === 0, A.writes);
  check('checkpoint: logged as stashed', A.logs.some((l) => l.includes('[CKPT] run skipped') && l.includes('"reason":"stashed"')));
  const q = await makePane(A);
  doneAfterTurn(A, q);
  type(q, 'other draft');
  setTabs(A, [tab('ck2', [q])]);
  keybindings = KEYS_REBOUND;
  clearWrites();
  await A.tm.runCheckpoint();
  await wait(250);
  check('checkpoint: rebound key with a draft sends nothing', A.writes.length === 0, A.writes);
  check('checkpoint: logged as draft with the binding', A.logs.some((l) => l.includes('[CKPT] run skipped') && l.includes('"reason":"draft"') && l.includes('chat:submit')));
  keybindings = KEYS_DEFAULT;
  const r = await makePane(A);
  doneAfterTurn(A, r);
  setTabs(A, [tab('ck3', [r])]);
  clearWrites();
  await A.tm.runCheckpoint();
  await wait(100);
  check('checkpoint: no draft, plain /checkpoint', bytesByPty(A).get(r.ptyId) === '/checkpoint\r', bytesByPty(A).get(r.ptyId));
}

// ── 10. Title path: a stale stop flag is cleared by user input, restored by the next Stop hook ──
{
  const p = await makePane(A);
  title(p, '◐ Working'); stopHook(A, p); title(p, '✳ Claude Code');
  await wait(3);
  type(p, 'y'); type(p, '\x7f');
  setTabs(A, [tab('tp', [p])]);
  clearWrites();
  await press(A);
  check('title path: typed since the stop is skipped as unclear', !bytesByPty(A).has(p.ptyId) && btnOf(A).textContent.includes('tp (state unclear)'), btnOf(A).textContent);
  await wait(3);
  title(p, '◐ Working'); stopHook(A, p); title(p, '✳ Claude Code');
  clearWrites();
  await press(A);
  check('title path: after a new Stop hook it gets "pause\\r"', bytesByPty(A).get(p.ptyId) === 'pause\r', bytesByPty(A).get(p.ptyId));
  await press(A); // resume
}

// ── 11. Stash-key verdicts on keybindings.json text ──
{
  const v = M.stashKeyVerdict;
  check('stash key: no file is the default', v(null).ok === true);
  check('stash key: default bindings', v(KEYS_DEFAULT).ok === true);
  check('stash key: "Ctrl + S" spelled loosely still the stash', v(JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'Ctrl + S': 'chat:stash' } }] })).ok === true);
  check('stash key: ctrl+s unbound (null)', v(JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+s': null } }] })).ok === false);
  check('stash key: stash moved to another key', v(JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+x': 'chat:stash' } }] })).ok === false);
  check('stash key: a ctrl+s chord', v(JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+s ctrl+a': 'chat:other' } }] })).ok === false);
  check('stash key: unparseable file', v('{ nope').ok === false);
}

// ── 12. Main: windows closed mid-press, a send that throws, a late report, one press at a time ──
{
  const logs = [];
  const fakes = [];
  const fake = (id, opts = {}) => {
    const f = { id, closed: [], modes: [], runs: [], ...opts };
    fakes.push(f);
    return f;
  };
  const co = new M.PauseAllCoordinator(() => fakes.map((f) => ({
    id: f.id,
    alive: () => !f.dead,
    send: (channel, payload) => {
      if (f.throws) throw new Error('webContents destroyed');
      if (channel === IPC_MODE) { f.modes.push(payload); return; }
      f.runs.push(payload);
      f.onRun?.(payload);
    },
    onClosed: (cb) => { f.closed.push(cb); return () => { f.closed = f.closed.filter((c) => c !== cb); }; },
  })), 400, (msg, data) => logs.push([msg, data]));
  const rep = (sent, extra = {}) => ({ sent, queued: 0, skipped: { waiting: 1 }, named: [{ title: 'x', reason: 'waiting' }], ...extra });

  // w1 answers, w2 closes during the press, w3's send throws, w4 is already dead.
  fake(1, { onRun: (req) => queueMicrotask(() => co.report(1, req.requestId, rep(2))) });
  fake(2, { onRun: () => setTimeout(() => { for (const cb of fakes[1].closed) cb(); }, 20) });
  fake(3, { throws: true });
  fake(4, { dead: true });
  const t0 = Date.now();
  const out = await co.press();
  const took = Date.now() - t0;
  check('main: a window closed mid-press is counted as closed', out.closed === 1 && out.answered === 1 && out.windows === 3, out);
  check('main: the press ends without waiting for the timeout', took < 300, took);
  check('main: a send that throws is logged, not waited on', logs.some(([m, d]) => m === '[PAUSE-ALL] send failed' && d.window === 3), logs.map(([m]) => m));
  check('main: a dead window is not asked', fakes[3].runs.length === 0);
  check('main: totals and next action', out.sent === 2 && out.skipped.waiting === 1 && out.next === 'resume' && out.left === 1, out);
  check('main: mode sent to every live window it can reach', fakes[0].modes.at(-1)?.next === 'resume' && fakes[1].modes.at(-1)?.next === 'resume');
  check('main: closed-window listeners removed after the press', fakes.every((f) => f.closed.length === 0));

  // Resume, with a silent window that answers late.
  fakes.length = 0;
  fake(1, { onRun: (req) => queueMicrotask(() => co.report(1, req.requestId, rep(0, { skipped: {} }))) });
  let lateReq = null;
  fake(2, { onRun: (req) => { lateReq = req; } });
  const outR = await co.press();
  check('main: resume with a silent window times out as not answered', outR.action === 'resume' && outR.windows === 2 && outR.answered === 1 && outR.next === 'pause', outR);
  // Now a pause where window 2 answers late.
  fakes[0].onRun = (req) => queueMicrotask(() => co.report(1, req.requestId, rep(0, { skipped: {} })));
  const outP = await co.press();
  check('main: pause that reached no pane in time stays at Pause all', outP.action === 'pause' && outP.sent === 0 && outP.next === 'pause', outP);
  check('main: late report counted', co.report(2, lateReq.requestId, rep(3)) === true, lateReq);
  check('main: late pause report turns the button to Resume all', co.next === 'resume' && co.mode.left === 1, co.mode);
  check('main: late report broadcasts the mode', fakes[0].modes.at(-1)?.next === 'resume');
  check('main: late report logged', logs.some(([m, d]) => m === '[PAUSE-ALL] late report' && d.window === 2 && d.sent === 3));
  check('main: a second late report from the same window refused', co.report(2, lateReq.requestId, rep(3)) === false);
  check('main: a report with an unknown request id refused', co.report(1, 'nope', rep(1)) === false);
  check('main: a non-string request id refused', co.report(1, 42, rep(1)) === false);

  // One press at a time, and a new press drops older late answers.
  let held = null;
  fakes[0].onRun = (req) => { held = req; };
  fakes[1].onRun = () => {};
  const first = co.press();
  const second = await co.press();
  check('main: a second press while one runs is refused', second === null);
  check('main: a report from a window not asked refused', co.report(9, held.requestId, rep(1)) === false);
  co.report(1, held.requestId, rep(1));
  await first;
  check('main: an old request\'s late answer no longer counts after a new press', co.report(2, lateReq.requestId, rep(5)) === false);

  // Untrusted reports.
  const c = M.cleanReport({ sent: -3, queued: 9, skipped: { waiting: 2.5, closed: 1e9, bogus: 4, menu: 2 }, named: [{ title: 'a\u001b[31mb\n', reason: 'menu' }, { title: 'z', reason: 'bogus' }] });
  check('main: report numbers are cleaned', c.sent === 0 && c.queued === 0 && c.skipped.waiting === 0 && c.skipped.closed === 0 && c.skipped.menu === 2 && !('bogus' in c.skipped), c);
  check('main: report titles stripped of control characters, unknown reasons dropped', c.named.length === 1 && c.named[0].title === 'a[31mb', c.named);
  check('main: a non-object report refused', M.cleanReport('x') === null && M.cleanReport(null) === null);
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
