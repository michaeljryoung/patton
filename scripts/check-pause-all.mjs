// Headless check of the tab strip's "Pause all" button (10 Nov 2026). Michael
// types `pause` into each Claude session before shutting the laptop (a Claude
// Code hook then suspends the jobs it started) and resumes each tab by hand;
// the button types `pause` into every Claude pane in every window that has
// something running (23 Nov: "only do stuff where claude is working not
// pointlessly post to quiet chats"), and every press pauses again (no Resume
// all, no "Pause remaining", no mode broadcast).
// Drives the REAL TabManager + TabBar in two jsdom windows, the REAL
// PauseAllCoordinator (main/pause-all.ts) standing in for main's IPC between
// them, main's REAL UnsentInputTracker (main/unsent-input.ts) behind
// pty.write / pty.inputState, the REAL stash-key verdict (main/stash-key.ts)
// on keybindings.json text, and REAL Panes (constructed and init()ed, with the
// terminal, editor and overlays stubbed). Pane state comes only through the
// Pane's own listeners: OSC 7501 bodies through the real parseProgramStatus,
// Stop-hook messages through the real parsePattonOsc, window titles, and
// keystrokes as terminal data, so the bytes checked are the bytes the app writes.
// Covers: the button is the strip's last child, with no checkpoint clock in the
// strip (it lives in the session bar, docs/session-bar.md D7), and its label never
// changes; a second press pauses the same panes again; pause sends `pause\r` to working panes and
// to panes parked (stopped with a background task, agent or timer going: 7501 child
// records, or the title path's Stop-hook verdict once the ✳ has settled) and skips
// quiet panes (done, idle or error with nothing running: counted in the summary,
// never named, never given a Ctrl+S), blocked (permission, question, a blocked child),
// a parked session that has only ever reported idle, a `/model` menu, a title path
// typed into since the stop, plain shells and exited shells; a draft gets `\x13pause\r` (one Ctrl+S); a
// draft erased by Backspace gets a plain send; a user Ctrl+S skips the pane;
// a rebound stash key skips draft panes; a draft Patton stashed is skipped
// until the user submits; the session bar's checkpoint button stashes a
// draft the same way; the summary names skipped tabs and splits at-the-prompt
// from queued, counts quiet sessions without naming them, and counts a word the gate
// held (Claude started asking) as held. "Running" means work, not the dot's word: a root error
// over a working child is named unclear, the turn's last Stop verdict keeps counting past the
// children draining and the 40 s TTL until the next turn, a title ✳ with no Stop hook is named
// unclear, and the summary opens "Nothing running to pause" only when quiet is the only skip.
// Main side: a window closed mid-press, a send that throws, a
// late report, a second press, and an untrusted report.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-pause-all.mjs
//   jsdom is not a project dependency: install it in a scratch folder.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
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
const runRequests = []; // every PAUSE_ALL_RUN payload main sent, to any window
const coordinator = new M.PauseAllCoordinator(() => windows.map((win) => ({
  id: win.id,
  alive: () => !win.gone,
  send: (channel, payload) => {
    if (channel === IPC_RUN) for (const cb of win.onRun) cb(payload);
    runRequests.push(payload);
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
  const win = { id, gone: false, onRun: [], writes: [], logs: [], exitCbs: [] };
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
        win.onWrite?.(ptyId, data);
      },
      inputState: (ids) => Promise.resolve(ids.map((i) => tracker.state(i))),
      onData: () => () => {},
      onExit: (cb) => { win.exitCbs.push(cb); return () => {}; },
    }),
    history: stubWith({ get: () => Promise.resolve([]), add: () => Promise.resolve(), clear: () => Promise.resolve() }),
    log: { send: (_lvl, args) => win.logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) },
    pauseAll: {
      press: () => coordinator.press(),
      onRun: (cb) => { win.onRun.push(cb); return () => {}; },
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
const stopHook = (win, p, tasks = 0, crons = 0) => view(p).__emit('onPattonState', win.PA.parsePattonOsc(`patton;stop;tasks=${tasks};crons=${crons}`));
const type = (p, data) => view(p).__emit('onTerminalData', data);
const exitShell = (win, p) => { for (const cb of win.exitCbs) cb(p.ptyId); };
const ROOT = (state, extra = '') => `state=${state}:app=claude-code${extra}`;
// A Claude session that has had a turn and is back at its prompt.
// Nothing running: Pause all leaves it alone ('quiet').
const doneAfterTurn = (win, p) => { report(win, p, ROOT('working')); report(win, p, ROOT('done')); };
// A turn that ended with a background task still working: 7501 ranks it `parked`.
const BG_CHILD = 'state=working:id=bg1:app=claude-code';
const parkedAfterTurn = (win, p) => { doneAfterTurn(win, p); report(win, p, BG_CHILD); };
// Title path (no 7501): a turn, then the Stop hook's verdict, then ✳. The verdict is
// applied once the ✳ has held CLAUDE_STOP_SETTLE_MS (1.5 s): tasks + crons > 0 parks the
// pane, 0 / 0 leaves it quiet. Callers wait TITLE_SETTLE_MS before the press.
const titleStop = (win, p, tasks, crons = 0) => { title(p, '◐ Working'); stopHook(win, p, tasks, crons); title(p, '✳ Claude Code'); };
const TITLE_SETTLE_MS = 1700;

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
// A press's result shows in a popover under the icon, not in the button (13 Nov: the words
// made the button 360 px wide and pushed tabs off the strip).
const resultOf = (win) => win.w.document.querySelector('.tab-bar-pause-result');
const resultText = (win) => (resultOf(win).hidden ? null : resultOf(win).textContent);
// A press and the stash path's 150 ms settle.
const press = async (win) => { await win.tm.pressPauseAll(); await wait(250); };

const A = makeWindow(1);
const B = makeWindow(2);
await wait(5);

// ── 1. Position, look and label ──
{
  const bar = A.w.document.getElementById('bar');
  const kids = Array.from(bar.children);
  const btn = btnOf(A);
  check('pause button exists', !!btn);
  check('pause button is the strip\'s last child (far right)', kids[kids.length - 1] === btn, kids.map((k) => k.className));
  check('no checkpoint clock in the tab strip (D7: the session bar has it)', bar.querySelector('.tab-bar-checkpoint') === null && !kids.some((k) => /checkpoint/.test(k.className)), kids.map((k) => k.className));
  check('idle label is the pause icon (full words in aria-label)', btn.textContent === '⏸', btn.textContent);
  check('is a real button', btn.tagName === 'BUTTON' && btn.type === 'button');
  check('aria-label says what it does', /type pause into every Claude session/.test(btn.getAttribute('aria-label') ?? ''), btn.getAttribute('aria-label'));
  check('tooltip matches the aria-label', btn.title === btn.getAttribute('aria-label'));
  check('shown even with no Claude pane', btn.hidden === false);
  check('no "Pause remaining" button in the tab bar', bar.querySelector('.tab-bar-pause-remaining') === null && !/remaining/i.test(bar.textContent));
  check('no Resume class on the pause button', !btn.classList.contains('resume'));
  const constantsSrc = readFileSync(join(repo, 'src/shared/constants.ts'), 'utf8');
  check('no PAUSE_ALL_MODE / GET_MODE channel in constants.ts', !/PAUSE_ALL_MODE|PAUSE_ALL_GET_MODE|pause-all:mode/.test(constantsSrc));
}

// ── 2. Pause: who gets the word ──
const a = {};
const KEYS2 = ['done', 'work', 'perm', 'quest', 'err', 'fresh', 'menu', 'child', 'draft', 'bs', 'userStash', 'shell', 'dead', 'titleDone', 'titleStale', 'close',
  'qDone', 'qIdle', 'qFresh', 'qTitle', 'qDraft'];
for (const k of KEYS2) {
  a[k] = await makePane(A);
}
const b = { done: await makePane(B) };

// Every pane below that should get the word, or a skip reason other than 'quiet', has something running.
parkedAfterTurn(A, a.done);
report(A, a.work, ROOT('working'));
report(A, a.perm, ROOT('working')); report(A, a.perm, BG_CHILD); report(A, a.perm, ROOT('blocked', ':kind=permission'));
report(A, a.quest, ROOT('working')); report(A, a.quest, BG_CHILD); report(A, a.quest, ROOT('blocked', ':kind=question'));
report(A, a.err, ROOT('working')); report(A, a.err, ROOT('error'));
report(A, a.fresh, ROOT('idle')); report(A, a.fresh, BG_CHILD); // idle, never a turn, but a task going
parkedAfterTurn(A, a.menu);
report(A, a.child, ROOT('working')); report(A, a.child, 'state=blocked:id=t1:kind=permission:app=claude-code');
parkedAfterTurn(A, a.draft);
parkedAfterTurn(A, a.bs);
parkedAfterTurn(A, a.userStash);
title(a.shell, 'zsh');
parkedAfterTurn(A, a.dead);
titleStop(A, a.titleDone, 1);
titleStop(A, a.titleStale, 1);
parkedAfterTurn(A, a.close);
parkedAfterTurn(B, b.done);
// Quiet: nothing running.
doneAfterTurn(A, a.qDone);
report(A, a.qIdle, ROOT('working')); report(A, a.qIdle, ROOT('idle')); // interrupted: idle after a turn
report(A, a.qFresh, ROOT('idle')); // never had a turn
titleStop(A, a.qTitle, 0); // title path, Stop hook says tasks=0 crons=0
doneAfterTurn(A, a.qDraft);
await wait(TITLE_SETTLE_MS); // the ✳ settles and the verdicts apply; keystrokes come after the reports and the Stop hook
type(a.menu, '/model'); type(a.menu, '\r');
type(a.draft, 'hello');
type(a.bs, 'ab'); type(a.bs, '\x7f'); type(a.bs, '\x7f');
type(a.userStash, 'abc'); type(a.userStash, '\x13'); type(a.userStash, 'def');
type(a.qDraft, 'unsent words');
exitShell(A, a.dead);
type(a.titleStale, 'x'); type(a.titleStale, '\x7f');
const order = KEYS2;
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
  for (const k of ['perm', 'quest', 'err', 'fresh', 'menu', 'child', 'userStash', 'shell', 'dead', 'titleStale', 'qDone', 'qIdle', 'qFresh', 'qTitle', 'qDraft']) {
    check(`pause: ${k} pane gets nothing`, !wa.has(a[k].ptyId), wa.get(a[k].ptyId));
  }
  check('pause: no Ctrl+S anywhere but the draft pane', A.writes.filter(([id, d]) => d.includes('\x13') && id !== a.draft.ptyId).length === 0);
  check('pause: other window\'s pane gets "pause\\r"', bytesByPty(B).get(b.done.ptyId) === 'pause\r', bytesByPty(B).get(b.done.ptyId));
  check('pause: nothing else written anywhere', wa.size === 6 && B.writes.length === 2, [[...wa.keys()], B.writes]);
  const text = resultText(A);
  check('pause: summary splits at-the-prompt from queued, counts quiet sessions and names the other skipped tabs',
    text === 'Paused 7 Claude sessions (6 at the prompt, 1 queued behind a running turn); 6 quiet Claude sessions left alone; skipped 7: perm (waiting on you), quest (waiting on you), fresh (new session), 4 more', text);
  check('pause: quiet sessions are counted in the summary and never named',
    /; 6 quiet Claude sessions left alone;/.test(text) && !/\b(err|qDone|qIdle|qFresh|qTitle|qDraft)\b/.test(text) && !/nothing running\)/.test(text), text);
  check('pause: after a press that sent, neither window\'s button turns to Resume all',
    btnOf(B).textContent === '⏸' && resultText(B) === null && !btnOf(B).classList.contains('resume') && !btnOf(A).classList.contains('resume'), [btnOf(A).textContent, btnOf(B).textContent, resultText(B)]);
  check('pause: main\'s run requests carry nothing but the request id (no action to flip)',
    runRequests.length === 2 && runRequests.every((q) => Object.keys(q).join() === 'requestId'), runRequests);
  const log = A.logs.find((l) => l.includes('[PAUSE-ALL] run'));
  const reasonOf = (k) => `"pane":"${a[k].id}","reason":"`;
  const why = (k) => { const i = log?.indexOf(reasonOf(k)) ?? -1; return i < 0 ? null : log.slice(i + reasonOf(k).length).split('"')[0]; };
  const expected = {
    perm: 'waiting', quest: 'waiting', child: 'waiting', fresh: 'fresh', menu: 'menu', userStash: 'stashed', shell: 'not-claude', dead: 'no-shell', titleStale: 'unclear',
    err: 'quiet', qDone: 'quiet', qIdle: 'quiet', qFresh: 'quiet', qTitle: 'quiet', qDraft: 'quiet',
  };
  for (const [k, r] of Object.entries(expected)) check(`pause: rlog gives ${k} the reason ${r}`, why(k) === r, why(k));
  check('pause: rlog carries no typed text', !A.logs.some((l) => l.includes('PAUSE-ALL') && /hello|abcdef|\/model/.test(l)));
  check('pause: press summary logged by main', mainLogs.some(([m, d]) => m === '[PAUSE-ALL] press' && d.answered === 2 && d.sent === 7), mainLogs.map(([m]) => m));
}

// ── 3. The label returns to Pause all once the result has shown ──
{
  const btn = btnOf(A);
  check('result shows in the popover, the button keeps its icon', resultText(A) !== null && btn.textContent === '⏸', [resultText(A), btn.textContent]);
  A.tm.tabBar.showPauseResult('x'); // re-arm with a short wait for the check
  await wait(4100);
  check('after the result: the popover is gone and the button is still Pause all', resultText(A) === null && btn.textContent === '⏸' && !btn.classList.contains('resume'), [resultText(A), btn.textContent]);
  check('after the result: aria-label is still Pause all\'s', /^Pause all: type pause into every Claude session/.test(btn.getAttribute('aria-label') ?? ''), btn.getAttribute('aria-label'));
}

// ── 4. A second press pauses again, from either window; panes now able are added ──
report(A, a.perm, ROOT('done')); // the permission was answered and the turn ended
await wait(5);
report(A, a.menu, ROOT('done')); // Claude reported after the /model: no menu now
clearWrites();
runRequests.length = 0;
btnOf(B).click();
await wait(300);
{
  const wa = bytesByPty(A);
  for (const k of ['done', 'work', 'bs', 'titleDone', 'close']) {
    check(`second press: ${k} pane (paused by the first) gets "pause\\r" again`, wa.get(a[k].ptyId) === 'pause\r', wa.get(a[k].ptyId));
  }
  check('second press: other window\'s pane gets "pause\\r" again', bytesByPty(B).get(b.done.ptyId) === 'pause\r', bytesByPty(B).get(b.done.ptyId));
  check('second press: answered-permission pane now gets "pause\\r"', wa.get(a.perm.ptyId) === 'pause\r', wa.get(a.perm.ptyId));
  check('second press: menu pane with a report since gets "pause\\r"', wa.get(a.menu.ptyId) === 'pause\r', wa.get(a.menu.ptyId));
  check('second press: the draft Patton stashed is skipped until a user submit, no second Ctrl+S',
    !wa.has(a.draft.ptyId) && !A.writes.some(([, d]) => d.includes('\x13')), wa.get(a.draft.ptyId));
  check('second press: only those seven panes are written to', wa.size === 7 && B.writes.length === 2, [[...wa.keys()], B.writes]);
  check('second press: the clicked window\'s button still reads Pause all',
    resultText(B) !== null && resultText(B).startsWith('Paused 8 Claude sessions') && !btnOf(B).classList.contains('resume'), resultText(B));
  check('second press: main again asked every window to pause (request has only an id)',
    runRequests.length === 2 && runRequests.every((q) => Object.keys(q).join() === 'requestId'), runRequests);
}

// ── 6. A user submit clears Patton's stash; a new Claude session in the same shell is paused ──
{
  const p = await makePane(A);
  const q = await makePane(A);
  parkedAfterTurn(A, p); parkedAfterTurn(A, q);
  await wait(3);
  type(p, 'note');
  setTabs(A, [tab('p', [p]), tab('q', [q])]);
  setTabs(B, []);
  clearWrites();
  await press(A);
  check('stash cycle: draft pane paused with Ctrl+S', bytesByPty(A).get(p.ptyId) === '\x13pause\r', bytesByPty(A).get(p.ptyId));
  // Claude quits and a new one starts in q (same shell).
  report(A, q, 'state=clear'); report(A, q, ROOT('working')); report(A, q, ROOT('done')); report(A, q, BG_CHILD);
  // The user sends the restored draft, then starts another.
  type(p, '\r'); type(p, 'next');
  clearWrites();
  await press(A);
  check('stash cycle: after a user submit, the next press stashes the new draft and pauses', bytesByPty(A).get(p.ptyId) === '\x13pause\r', bytesByPty(A).get(p.ptyId));
  check('session change: a new Claude session in the same shell is paused like any other', bytesByPty(A).get(q.ptyId) === 'pause\r', bytesByPty(A).get(q.ptyId));
}

// ── 7. A rebound stash key: drafts skipped, clean panes still paused ──
{
  keybindings = KEYS_REBOUND;
  const d = await makePane(A);
  const c = await makePane(A);
  parkedAfterTurn(A, d); parkedAfterTurn(A, c);
  type(d, 'half a thought');
  setTabs(A, [tab('rb-draft', [d]), tab('rb-clean', [c])]);
  clearWrites();
  await press(A);
  check('rebound key: draft pane gets nothing', !bytesByPty(A).has(d.ptyId), bytesByPty(A).get(d.ptyId));
  check('rebound key: clean pane gets "pause\\r"', bytesByPty(A).get(c.ptyId) === 'pause\r');
  check('rebound key: summary says why', resultText(A)?.includes('rb-draft (draft: stash key rebound)'), resultText(A));
  check('rebound key: rlog names the binding', A.logs.some((l) => l.includes('[PAUSE-ALL] run') && l.includes('ctrl+s is bound to chat:submit')));
  keybindings = KEYS_DEFAULT;
}

// ── 8. Nothing ready: the button still reads Pause all and says so ──
{
  const s = await makePane(A);
  const f = await makePane(A);
  title(s, 'zsh');
  report(A, f, ROOT('idle'));
  setTabs(A, [tab('sh', [s])]);
  clearWrites();
  await press(A);
  check('nothing ready: a plain shell alone, no writes and no Claude session found', A.writes.length === 0 && B.writes.length === 0 && resultText(A) === 'Nothing paused; no Claude session found', resultText(A));
  // An idle session that never had a turn and has nothing running is quiet.
  setTabs(A, [tab('sh', [s]), tab('new', [f])]);
  clearWrites();
  await press(A);
  check('nothing running: no writes', A.writes.length === 0 && B.writes.length === 0);
  check('nothing running: says so, counting the quiet session without naming it', resultText(A) === 'Nothing running to pause; 1 quiet Claude session left alone', resultText(A));
  const g = await makePane(A);
  doneAfterTurn(A, g);
  setTabs(A, [tab('sh', [s]), tab('new', [f]), tab('quiet2', [g])]);
  clearWrites();
  await press(A);
  check('nothing running: several quiet sessions are counted, plural', resultText(A) === 'Nothing running to pause; 2 quiet Claude sessions left alone', resultText(A));
  // The same idle session with a background task going is the 'fresh' skip, named.
  report(A, f, BG_CHILD);
  setTabs(A, [tab('sh', [s]), tab('new', [f])]);
  clearWrites();
  await press(A);
  check('nothing ready: no writes', A.writes.length === 0 && B.writes.length === 0);
  check('nothing ready: says so', resultText(A) === 'Nothing paused; skipped 1: new (new session)', resultText(A));
}

// ── 9. The session bar's checkpoint button: same stash path ──
{
  const p = await makePane(A);
  doneAfterTurn(A, p);
  report(A, p, ROOT('done')); // and the clock shows
  type(p, 'draft line');
  setTabs(A, [tab('ck', [p])]);
  A.tm.updateCheckpoint();
  clearWrites();
  const sbBtn = A.w.document.querySelector('.session-bar .sb-ckpt-btn');
  check('checkpoint: the session bar\'s Checkpoint button is there', !!sbBtn && !A.w.document.querySelector('.session-bar').hidden, sbBtn && sbBtn.outerHTML);
  sbBtn?.click();
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

// ── 9b. The checkpoint's and Pause all's Enters gate on the live 7501 `blocked` fact ──
// (Gotcha S56.) Claude starts asking during the stash's 150 ms wait, or between
// the word and its Enter: nothing more is written, and no Enter answers it.
{
  const askOn = (win, p, when) => {
    win.onWrite = (id, data) => {
      if (id === p.ptyId && data === when) { win.onWrite = null; report(win, p, ROOT('blocked', ':kind=permission')); }
    };
  };
  const mine = (win, p) => win.writes.filter(([id]) => id === p.ptyId).map(([, d]) => d);

  // Checkpoint, with a draft: asked during the stash's wait.
  const c1 = await makePane(A);
  doneAfterTurn(A, c1);
  type(c1, 'draft words');
  setTabs(A, [tab('gate1', [c1])]);
  clearWrites();
  askOn(A, c1, '\x13');
  const why1 = await c1.runCheckpoint();
  await wait(50);
  check('checkpoint gate: Claude asks during the stash wait, so only the Ctrl+S went (no /checkpoint, no Enter)', JSON.stringify(mine(A, c1)) === JSON.stringify(['\x13']), mine(A, c1));
  check('checkpoint gate: … and it says why, not "sent"', typeof why1 === 'string' && /asking you something/.test(why1) && /not sent/.test(why1), why1);
  check('checkpoint gate: … logged as held at the write', A.logs.some((l) => l.includes('[CKPT] run held') && l.includes('"at":"write"')));

  // Checkpoint, no draft: asked between /checkpoint and its Enter.
  const c2 = await makePane(A);
  doneAfterTurn(A, c2);
  setTabs(A, [tab('gate2', [c2])]);
  clearWrites();
  askOn(A, c2, '/checkpoint');
  const why2 = await c2.runCheckpoint();
  await wait(50);
  check('checkpoint gate: Claude asks between /checkpoint and its Enter, so no Enter', JSON.stringify(mine(A, c2)) === JSON.stringify(['/checkpoint']), mine(A, c2));
  check('checkpoint gate: … and it says the word sits in Claude\'s input, not sent', typeof why2 === 'string' && /in its input, not sent/.test(why2), why2);

  // Pause all, with a draft: asked during the stash's wait.
  const p1 = await makePane(A);
  parkedAfterTurn(A, p1);
  type(p1, 'another draft');
  setTabs(A, [tab('gate3', [p1])]);
  setTabs(B, []);
  clearWrites();
  askOn(A, p1, '\x13');
  await press(A);
  check('pause gate: Claude asks during the stash wait, so only the Ctrl+S went (no pause, no Enter)', JSON.stringify(mine(A, p1)) === JSON.stringify(['\x13']), mine(A, p1));
  check('pause gate: … logged as held at the write', A.logs.some((l) => l.includes('[PAUSE-ALL] pause held') && l.includes('"at":"write"')));
  check('pause gate: … the summary counts it as held, not paused', /^Nothing paused/.test(resultText(A) ?? '') && (resultText(A) ?? '').includes('gate3 (not sent: its draft is set aside (Ctrl+S there brings it back))'), resultText(A));

  // Pause all, no draft: asked between `pause` and its Enter.
  const p2 = await makePane(A);
  parkedAfterTurn(A, p2);
  setTabs(A, [tab('gate4', [p2])]);
  clearWrites();
  askOn(A, p2, 'pause');
  await press(A);
  check('pause gate: Claude asks between pause and its Enter, so no Enter', JSON.stringify(mine(A, p2)) === JSON.stringify(['pause']), mine(A, p2));
  check('pause gate: … logged as held at the Enter', A.logs.some((l) => l.includes('[PAUSE-ALL] pause held') && l.includes('"at":"enter"')));
  check('pause gate: … held at the Enter counts as held too', /^Nothing paused/.test(resultText(A) ?? '') && (resultText(A) ?? '').includes('gate4 (not sent: "pause" is left in its input)'), resultText(A));
  A.onWrite = null;
}

// ── 10. Title path: a stale stop flag is cleared by user input, restored by the next Stop hook ──
{
  const p = await makePane(A);
  titleStop(A, p, 1);
  await wait(TITLE_SETTLE_MS);
  type(p, 'y'); type(p, '\x7f');
  setTabs(A, [tab('tp', [p])]);
  clearWrites();
  await press(A);
  check('title path: typed since the stop is skipped as unclear', !bytesByPty(A).has(p.ptyId) && resultText(A)?.includes('tp (state unclear)'), resultText(A));
  await wait(3);
  titleStop(A, p, 1);
  await wait(TITLE_SETTLE_MS);
  clearWrites();
  await press(A);
  check('title path: after a new Stop hook it gets "pause\\r"', bytesByPty(A).get(p.ptyId) === 'pause\r', bytesByPty(A).get(p.ptyId));
  // Before the ✳ has settled the verdict is only stored, but it already says
  // work is running: Pause all counts it (the dot still waits out the settle).
  titleStop(A, p, 1);
  clearWrites();
  await press(A);
  check('title path: a Stop verdict with work, not yet settled (✳ held under 1.5 s), still gets "pause\\r"', bytesByPty(A).get(p.ptyId) === 'pause\r', [bytesByPty(A).get(p.ptyId), resultText(A)]);
  await wait(TITLE_SETTLE_MS);
  titleStop(A, p, 0, 0);
  clearWrites();
  await press(A);
  check('title path: a Stop verdict with nothing running, not yet settled, leaves the pane quiet', !bytesByPty(A).has(p.ptyId) && /^Nothing running to pause; 1 quiet Claude session left alone/.test(resultText(A) ?? ''), [bytesByPty(A).get(p.ptyId), resultText(A)]);
}

// ── 10b. What counts as running: a timer, a working root, a subagent ──
{
  const tTimer = await makePane(A); // title path, stopped with only a timer left (tasks=0 crons=1)
  titleStop(A, tTimer, 0, 1);
  const tWork = await makePane(A); // title path, mid-turn
  title(tWork, '◐ Working');
  const tQuiet = await makePane(A); // title path, stopped, tasks=0 crons=0
  titleStop(A, tQuiet, 0, 0);
  const rTimer = await makePane(A); // 7501, done, and the Stop hook says a timer is left
  doneAfterTurn(A, rTimer);
  stopHook(A, rTimer, 0, 1);
  const rSub = await makePane(A); // 7501, root still working after the turn ended because a subagent runs
  report(A, rSub, ROOT('working')); report(A, rSub, BG_CHILD);
  await wait(TITLE_SETTLE_MS);
  setTabs(A, [tab('t-timer', [tTimer]), tab('t-work', [tWork]), tab('t-quiet', [tQuiet]), tab('r-timer', [rTimer]), tab('r-sub', [rSub])]);
  clearWrites();
  await press(A);
  const wa = bytesByPty(A);
  check('running: title path stopped with only a timer left gets "pause\\r"', wa.get(tTimer.ptyId) === 'pause\r', wa.get(tTimer.ptyId));
  check('running: title path mid-turn gets "pause\\r"', wa.get(tWork.ptyId) === 'pause\r', wa.get(tWork.ptyId));
  check('running: title path stopped with tasks=0 crons=0 gets nothing', !wa.has(tQuiet.ptyId), wa.get(tQuiet.ptyId));
  check('running: 7501 done with only a timer left (Stop hook crons=1) gets "pause\\r"', wa.get(rTimer.ptyId) === 'pause\r', wa.get(rTimer.ptyId));
  check('running: 7501 root still working with a subagent running gets "pause\\r"', wa.get(rSub.ptyId) === 'pause\r', wa.get(rSub.ptyId));
  check('running: nothing else written', wa.size === 4 && B.writes.length === 0, [...wa.keys()]);
  check('running: summary counts the two at the prompt, the two queued and the quiet one', resultText(A) === 'Paused 4 Claude sessions (2 at the prompt, 2 queued behind a running turn); 1 quiet Claude session left alone', resultText(A));
  // `turnEnded` (a Stop over a working root, the ring) needs main's transcript feed attached; the
  // check has none, so that route is not driven here. Such a pane reads `parked` or `working`
  // either way, and both get the word.
}

// ── 10c. "Running" is what is running, not the dot's activity word (review of 6b272aa) ──
{
  // The Stop hook's verdict is kept for Pause until the next turn: not dropped when the 7501 children
  // drain, not by the 40 s TTL. Date.now is faked in window A for the long gap.
  const realNow = A.w.Date.now.bind(A.w.Date);
  let skew = 0;
  A.w.Date.now = () => realNow() + skew;
  const named = (id, p) => { setTabs(A, [tab(id, [p])]); clearWrites(); };
  const CHILD_DONE = 'state=done:id=bg1:app=claude-code';
  const sentTo = (p) => bytesByPty(A).get(p.ptyId) === 'pause\r';

  // P1: a root error over a working child is running, so named as unclear, not hidden as quiet.
  const p1 = await makePane(A);
  report(A, p1, ROOT('working')); report(A, p1, BG_CHILD); report(A, p1, ROOT('error'));
  named('p1', p1);
  await press(A);
  check('running: a root error over a working child is not sent', !bytesByPty(A).has(p1.ptyId), bytesByPty(A).get(p1.ptyId));
  check('running: … it is named "state unclear", not counted as quiet, and the line starts "Nothing paused"',
    resultText(A) === 'Nothing paused; skipped 1: p1 (state unclear)', resultText(A));

  // P4: the hook counted two tasks, 7501 shows one child, and it finishes: the verdict still stands.
  const p4 = await makePane(A);
  report(A, p4, ROOT('working')); report(A, p4, BG_CHILD); stopHook(A, p4, 2, 0); report(A, p4, ROOT('done'));
  report(A, p4, CHILD_DONE);
  named('p4', p4);
  await press(A);
  check('running: hook says tasks=2, 7501 showed one child and it finished: still gets "pause\\r"', sentTo(p4), bytesByPty(A).get(p4.ptyId));

  // P4b: the hook counted a timer, a child finishes: still sent.
  const p4b = await makePane(A);
  report(A, p4b, ROOT('working')); report(A, p4b, BG_CHILD); stopHook(A, p4b, 0, 1); report(A, p4b, ROOT('done'));
  report(A, p4b, CHILD_DONE);
  named('p4b', p4b);
  await press(A);
  check('running: hook says crons=1 and a child finished: still gets "pause\\r"', sentTo(p4b), bytesByPty(A).get(p4b.ptyId));

  // P5: the verdict came more than 40 s before the done (the dot's TTL): still sent.
  const p5 = await makePane(A);
  report(A, p5, ROOT('working')); stopHook(A, p5, 0, 1);
  skew += 60_000;
  report(A, p5, ROOT('done'));
  named('p5', p5);
  await press(A);
  check('running: a verdict 60 s before the done (past the 40 s TTL) still gets "pause\\r"', sentTo(p5), bytesByPty(A).get(p5.ptyId));
  skew = 0;

  // A new turn clears it: tasks > 0 verdict, then a turn that ends 0 / 0 is quiet.
  const pn = await makePane(A);
  report(A, pn, ROOT('working')); stopHook(A, pn, 2, 0); report(A, pn, ROOT('done'));
  named('pn', pn);
  await press(A);
  check('new turn: after a tasks=2 verdict the pane gets "pause\\r"', sentTo(pn), bytesByPty(A).get(pn.ptyId));
  report(A, pn, ROOT('working')); stopHook(A, pn, 0, 0); report(A, pn, ROOT('done'));
  named('pn', pn);
  await press(A);
  check('new turn: … then a turn that ends 0 / 0 leaves it quiet', !bytesByPty(A).has(pn.ptyId) && resultText(A) === 'Nothing running to pause; 1 quiet Claude session left alone', [bytesByPty(A).get(pn.ptyId), resultText(A)]);
  // Mid-turn the new turn works, so it is running whatever the old verdict said.
  report(A, pn, ROOT('working'));
  named('pn', pn);
  await press(A);
  check('new turn: a working root is running', sentTo(pn), bytesByPty(A).get(pn.ptyId));

  // The same on the title path.
  const tn = await makePane(A);
  titleStop(A, tn, 2); await wait(TITLE_SETTLE_MS);
  named('tn', tn);
  await press(A);
  check('new turn (title path): after a tasks=2 verdict the pane gets "pause\\r"', sentTo(tn), bytesByPty(A).get(tn.ptyId));
  await wait(3);
  titleStop(A, tn, 0, 0); await wait(TITLE_SETTLE_MS);
  named('tn', tn);
  await press(A);
  check('new turn (title path): … then a turn that ends 0 / 0 is quiet', !bytesByPty(A).has(tn.ptyId) && resultText(A) === 'Nothing running to pause; 1 quiet Claude session left alone', [bytesByPty(A).get(tn.ptyId), resultText(A)]);

  // P8: title path stopped with no Stop hook since: a dialog looks like that, so named, not quiet.
  const p8 = await makePane(A);
  title(p8, '◐ Working'); title(p8, '✳ Claude Code');
  await wait(TITLE_SETTLE_MS);
  named('p8', p8);
  await press(A);
  check('title path: ✳ with no Stop hook is not sent', !bytesByPty(A).has(p8.ptyId), bytesByPty(A).get(p8.ptyId));
  check('title path: … it is named unclear, not quiet', resultText(A) === 'Nothing paused; skipped 1: p8 (state unclear)', resultText(A));
  A.w.Date.now = realNow;
}

// ── 10d. The summary's first words and the quiet clause ──
{
  const REASONS = ['waiting', 'menu', 'quiet', 'fresh', 'draft', 'stashed', 'unclear', 'held', 'held-restoring', 'held-typed', 'held-stashed', 'held-typed-stashed', 'bar-text', 'not-claude', 'no-shell'];
  const out = (sent, queued, skipped, names, windows = 1, answered = 1) => ({
    sent, queued, skipped: Object.fromEntries(REASONS.map((r) => [r, skipped[r] ?? 0])), named: names, windows, answered, closed: 0,
  });
  const sum = (o) => A.PA.pauseSummary(o);
  const cases = [
    ['quiet only: "Nothing running to pause"', out(0, 0, { quiet: 1 }, []), 'Nothing running to pause; 1 quiet Claude session left alone'],
    ['quiet only, plural', out(0, 0, { quiet: 3 }, []), 'Nothing running to pause; 3 quiet Claude sessions left alone'],
    ['quiet and a plain shell: shells are not counted', out(0, 0, { quiet: 1, 'not-claude': 2 }, []), 'Nothing running to pause; 1 quiet Claude session left alone'],
    ['quiet and a named skip: "Nothing paused", no contradiction', out(0, 0, { quiet: 1, waiting: 1 }, [{ title: 'build', reason: 'waiting' }]), 'Nothing paused; 1 quiet Claude session left alone; skipped 1: build (waiting on you)'],
    ['quiet and a held word (work running)', out(0, 0, { quiet: 1, 'held-typed': 1 }, [{ title: 'jobs', reason: 'held-typed' }]), 'Nothing paused; 1 quiet Claude session left alone; skipped 1: jobs (not sent: "pause" is left in its input)'],
    ['quiet and an unclear one', out(0, 0, { quiet: 2, unclear: 1 }, [{ title: 'x', reason: 'unclear' }]), 'Nothing paused; 2 quiet Claude sessions left alone; skipped 1: x (state unclear)'],
    ['quiet only but a window did not answer', out(0, 0, { quiet: 2 }, [], 2, 1), 'Nothing paused; 2 quiet Claude sessions left alone; 1 window didn\'t answer'],
    ['sent and quiet', out(2, 1, { quiet: 2 }, []), 'Paused 2 Claude sessions (1 at the prompt, 1 queued behind a running turn); 2 quiet Claude sessions left alone'],
    ['nothing at all', out(0, 0, {}, []), 'Nothing paused; no Claude session found'],
    ['only a plain shell', out(0, 0, { 'not-claude': 2 }, []), 'Nothing paused; no Claude session found'],
    ['a named skip, no quiet', out(0, 0, { fresh: 1 }, [{ title: 'new', reason: 'fresh' }]), 'Nothing paused; skipped 1: new (new session)'],
    ['no quiet and a window silent', out(0, 0, {}, [], 2, 1), 'Nothing paused; no Claude session found; 1 window didn\'t answer'],
  ];
  for (const [name, o, want] of cases) check(`summary: ${name}`, sum(o) === want, sum(o));
  check('summary: "nothing running" never sits beside a skipped pane',
    !cases.some(([, o]) => /^Nothing running/.test(sum(o)) && /skipped/.test(sum(o))));
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
    const f = { id, closed: [], runs: [], ...opts };
    fakes.push(f);
    return f;
  };
  const co = new M.PauseAllCoordinator(() => fakes.map((f) => ({
    id: f.id,
    alive: () => !f.dead,
    send: (channel, payload) => {
      if (f.throws) throw new Error('webContents destroyed');
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
  check('main: totals', out.sent === 2 && out.skipped.waiting === 1, out);
  check('main: closed-window listeners removed after the press', fakes.every((f) => f.closed.length === 0));
  check('main: the outcome carries no next action or mode', !('next' in out) && !('left' in out) && !('action' in out), out);
  const out2 = await co.press();
  check('main: after a press that sent, the next press is again a plain pause request to the same window',
    out2 !== null && out2.sent === 2 && fakes[0].runs.length === 2 && fakes[0].runs.every((q) => Object.keys(q).join() === 'requestId'), fakes[0].runs);

  // A silent window that answers late.
  fakes.length = 0;
  fake(1, { onRun: (req) => queueMicrotask(() => co.report(1, req.requestId, rep(0, { skipped: {} }))) });
  let lateReq = null;
  fake(2, { onRun: (req) => { lateReq = req; } });
  const outR = await co.press();
  check('main: a silent window times out as not answered', outR.windows === 2 && outR.answered === 1, outR);
  // Again, with window 2 still silent.
  fakes[0].onRun = (req) => queueMicrotask(() => co.report(1, req.requestId, rep(0, { skipped: {} })));
  const outP = await co.press();
  check('main: a press that reached no pane in time reports sent 0', outP.sent === 0 && outP.answered === 1, outP);
  check('main: late report counted', co.report(2, lateReq.requestId, rep(3)) === true, lateReq);
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

  await co.press();
  check('main: after late reports, the next press is still the same plain request',
    fakes[1].runs.length > 0 && fakes[1].runs.every((q) => Object.keys(q).join() === 'requestId'), fakes[1].runs);

  // Untrusted reports.
  const c = M.cleanReport({ sent: -3, queued: 9, skipped: { waiting: 2.5, 'no-shell': 1e9, bogus: 4, menu: 2 }, named: [{ title: 'a\u001b[31mb\n', reason: 'menu' }, { title: 'z', reason: 'bogus' }] });
  check('main: report numbers are cleaned', c.sent === 0 && c.queued === 0 && c.skipped.waiting === 0 && c.skipped['no-shell'] === 0 && c.skipped.menu === 2 && !('bogus' in c.skipped), c);
  check('main: report titles stripped of control characters, unknown reasons dropped', c.named.length === 1 && c.named[0].title === 'a[31mb', c.named);
  check('main: a non-object report refused', M.cleanReport('x') === null && M.cleanReport(null) === null);
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
