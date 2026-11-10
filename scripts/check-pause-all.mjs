// Headless check of the tab strip's "Pause all" button (10 Nov 2026). Michael
// types `pause` into each Claude session before shutting the laptop (a Claude
// Code hook then suspends the jobs it started) and `resume` later; the button
// does that for every Claude pane in every window.
// Drives the REAL TabManager + TabBar in two jsdom windows, the REAL
// PauseAllCoordinator (main/pause-all.ts) standing in for main's IPC between
// them, and panes built on the REAL Pane prototype (pauseInput,
// typePauseWord → queueSubmit → window.patton.pty.write), so the bytes checked
// are the bytes the app writes.
// Covers: the button sits right of the checkpoint clock; pause sends exactly
// `pause\r` to idle, done and busy Claude panes and nothing to waiting
// (permission / background task), unclear (title path), plain-shell or exited
// panes; resume sends `resume\r` only to the panes paused, skipping one now
// waiting and counting a closed one; the label toggles back; every window
// follows the mode; a report with a wrong request id is refused.
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

const rendererBundle = await build({
  stdin: {
    contents: `
      export { TabManager } from './src/renderer/services/tab-manager';
      export { Pane } from './src/renderer/components/pane';
      export { pauseSummary } from './src/renderer/services/pause-all';
    `,
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true, format: 'iife', globalName: 'PA', platform: 'browser', write: false,
  loader: { '.css': 'empty' }, logLevel: 'silent',
});
const rendererCode = rendererBundle.outputFiles[0].text;

// Main's coordinator: no Electron import, so it bundles for Node as is.
const mainBundle = await build({
  entryPoints: [join(repo, 'src/main/pause-all.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
const { PauseAllCoordinator } = await import('data:text/javascript;base64,' + Buffer.from(mainBundle.outputFiles[0].text).toString('base64'));
const IPC_RUN = 'pause-all:run';
const IPC_MODE = 'pause-all:mode';

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
process.on('unhandledRejection', (err) => { failed++; console.log('FAIL unhandled rejection', String(err)); });
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) process.exitCode = 1;
  if (!finished) console.log('FAIL script ended before all checks ran');
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main: the real coordinator over fake windows that call each jsdom window's handlers ──
const windows = [];
const coordinator = new PauseAllCoordinator(() => windows.map((win) => ({
  id: win.id,
  alive: () => !win.gone,
  send: (channel, payload) => {
    if (channel === IPC_RUN) for (const cb of win.onRun) cb(payload);
    if (channel === IPC_MODE) for (const cb of win.onMode) cb(payload);
  },
})), 300);

// A deep no-op stub with some keys replaced: anything a check doesn't care about.
const deep = () => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : deep()),
  apply: () => Promise.resolve(undefined),
});
const stubWith = (overrides) => new Proxy(function () {}, {
  get: (_t, k) => (k in overrides ? overrides[k] : k === 'then' ? undefined : deep()),
  apply: () => Promise.resolve(undefined),
});

function makeWindow(id) {
  const win = { id, gone: false, onRun: [], onMode: [], writes: [], logs: [] };
  const dom = new JSDOM('<!doctype html><body><div id="bar"></div><div id="content"></div></body>', {
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  win.w = w;
  w.patton = stubWith({
    pty: stubWith({ write: (ptyId, data) => { win.writes.push([ptyId, data]); } }),
    log: { send: (_lvl, args) => win.logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) },
    pauseAll: {
      press: () => coordinator.press(),
      mode: () => Promise.resolve(coordinator.next),
      onRun: (cb) => { win.onRun.push(cb); return () => {}; },
      onMode: (cb) => { win.onMode.push(cb); return () => {}; },
      report: (requestId, report) => Promise.resolve(coordinator.report(id, requestId, report)),
    },
  });
  w.eval(rendererCode);
  win.PA = w.PA;
  win.tm = new w.PA.TabManager(w.document.getElementById('bar'), w.document.getElementById('content'));
  windows.push(win);
  return win;
}

// A pane on the real Pane prototype, with only the fields its pause path reads.
let ptySeq = 0;
function pane(win, id, s) {
  const p = Object.create(win.PA.Pane.prototype);
  Object.defineProperty(p, 'id', { value: id });
  Object.assign(p, {
    ptyId: ++ptySeq,
    ptyExited: s.exited === true,
    claudeActive: s.claude === true,
    statusReporting: s.source !== 'title',
    claudeWorking: s.working === true,
    claudeBlocked: s.blocked === true,
    stopSeenSinceWork: s.stopSeen === true,
    programStatus: { children: () => (s.taskBlocked ? [{ id: 't1', record: { state: 'blocked' } }] : []) },
    composeFirstEngaged: false,
    callbacks: {},
    submitQueue: Promise.resolve(),
    terminalView: { terminal: { modes: { bracketedPasteMode: true }, scrollToBottom() {}, paste() {} } },
    focused: 0,
  });
  p.focus = () => { p.focused += 1; };
  return p;
}
const setTabs = (win, tabs) => {
  win.tm.tabs = tabs;
  win.tm.activeTab = tabs[0];
};
const tab = (id, panes) => ({ id, title: id, panes, focusedPane: panes[0], dispose() {} });
// What each pane's pty received, joined (text, then Enter 10 ms later).
const bytesByPty = (win) => {
  const out = new Map();
  for (const [id, data] of win.writes) out.set(id, (out.get(id) ?? '') + data);
  return out;
};

const A = makeWindow(1);
const B = makeWindow(2);
await wait(5);

// ── 1. Position, look and label ──
{
  const bar = A.w.document.getElementById('bar');
  const kids = Array.from(bar.children);
  const ck = bar.querySelector('.tab-bar-checkpoint');
  const btn = bar.querySelector('.tab-bar-pause-all');
  check('pause button exists', !!btn);
  check('pause button is the strip\'s last child (far right)', kids[kids.length - 1] === btn, kids.map((k) => k.className));
  check('checkpoint clock sits just left of it', kids[kids.length - 2] === ck, kids.map((k) => k.className));
  check('label reads Pause all', btn.textContent === '⏸ Pause all', btn.textContent);
  check('is a real button', btn.tagName === 'BUTTON' && btn.type === 'button');
  check('aria-label says what it does', /type pause into every Claude session/.test(btn.getAttribute('aria-label') ?? ''), btn.getAttribute('aria-label'));
  check('tooltip matches the aria-label', btn.title === btn.getAttribute('aria-label'));
  check('shown even with no Claude pane (clock hidden)', btn.hidden === false && ck.hidden === true);
}

// ── 2. Pause: who gets `pause\r` ──
const a = {
  idle: pane(A, 'a-idle', { claude: true }), // 7501 idle/done root
  busy: pane(A, 'a-busy', { claude: true, working: true }),
  ask: pane(A, 'a-ask', { claude: true, blocked: true }), // permission prompt
  task: pane(A, 'a-task', { claude: true, taskBlocked: true }), // background task asking
  shell: pane(A, 'a-shell', { claude: false }), // `wake` tab, caffeinate
  dead: pane(A, 'a-dead', { claude: true, exited: true }),
  titleDialog: pane(A, 'a-title-dialog', { claude: true, source: 'title', stopSeen: false }),
  titleDone: pane(A, 'a-title-done', { claude: true, source: 'title', stopSeen: true }),
  titleBusy: pane(A, 'a-title-busy', { claude: true, source: 'title', working: true }),
};
const b = {
  idle: pane(B, 'b-idle', { claude: true }),
  ask: pane(B, 'b-ask', { claude: true, blocked: true }),
};
setTabs(A, [
  tab('t1', [a.idle, a.busy]), // a split tab: both panes
  tab('t2', [a.ask]), tab('t3', [a.task]), tab('t4', [a.shell]), tab('t5', [a.dead]),
  tab('t6', [a.titleDialog, a.titleDone, a.titleBusy]),
]);
setTabs(B, [tab('u1', [b.idle]), tab('u2', [b.ask])]);

A.w.document.querySelector('.tab-bar-pause-all').click();
await wait(60);
{
  const wa = bytesByPty(A);
  const wb = bytesByPty(B);
  const sentA = ['idle', 'busy', 'titleDone', 'titleBusy'];
  for (const k of sentA) check(`pause: ${k} pane gets exactly "pause\\r"`, wa.get(a[k].ptyId) === 'pause\r', wa.get(a[k].ptyId));
  for (const k of ['ask', 'task', 'shell', 'dead', 'titleDialog']) check(`pause: ${k} pane gets nothing`, !wa.has(a[k].ptyId), wa.get(a[k].ptyId));
  check('pause: other window\'s idle pane gets "pause\\r"', wb.get(b.idle.ptyId) === 'pause\r', wb.get(b.idle.ptyId));
  check('pause: other window\'s waiting pane gets nothing', !wb.has(b.ask.ptyId));
  check('pause: nothing else written anywhere', A.writes.length === 8 && B.writes.length === 2, [A.writes, B.writes]);
  const btnA = A.w.document.querySelector('.tab-bar-pause-all');
  check('pause: result shown on the button', btnA.textContent === 'Paused 5 Claude sessions, skipped 3 waiting on you, skipped 1 whose state is unclear', btnA.textContent);
  check('pause: clicked window now in resume mode', A.tm.tabBar.pauseMode === 'resume');
  const btnB = B.w.document.querySelector('.tab-bar-pause-all');
  check('pause: other window\'s button turns to Resume all', btnB.textContent === '▶ Resume all', btnB.textContent);
  check('pause: focus handed back to the active pane', a.idle.focused === 1, a.idle.focused);
  const log = A.logs.find((l) => l.includes('[PAUSE-ALL] run'));
  check('pause: rlog line names panes sent and skipped with reasons',
    !!log && log.includes('a-idle') && log.includes('"pane":"a-ask","reason":"waiting"') && log.includes('"reason":"not-claude"') && log.includes('"reason":"no-shell"') && log.includes('"reason":"unclear"'), log);
  check('pause: rlog carries no text but the word', !A.logs.some((l) => l.includes('PAUSE-ALL') && /draft|prompt text/.test(l)));
  check('pause: press summary logged', A.logs.some((l) => l.includes('[PAUSE-ALL] press') && l.includes('"answered":2')), A.logs.filter((l) => l.includes('PAUSE')));
}

// ── 3. The label returns to Resume all once the result has shown ──
{
  const btn = A.w.document.querySelector('.tab-bar-pause-all');
  check('result is styled as a transient message', btn.classList.contains('reason'));
  A.tm.tabBar.showPauseResult('x'); // re-arm with a short wait for the check
  await wait(4100);
  check('after the result: Resume all', btn.textContent === '▶ Resume all' && !btn.classList.contains('reason'), btn.textContent);
  check('Resume all aria-label', /type resume into every Claude session Pause all paused/.test(btn.getAttribute('aria-label') ?? ''));
}

// ── 4. Resume: only the paused panes, by the rules at this moment ──
A.writes.length = 0; B.writes.length = 0;
a.busy.claudeBlocked = true; // now waiting on a permission prompt
a.ask.claudeBlocked = false; // was waiting at pause time: never paused, so no resume
setTabs(A, [tab('t1', [a.idle, a.busy]), tab('t2', [a.ask]), tab('t4', [a.shell]), tab('t6', [a.titleDialog, a.titleBusy])]); // titleDone's tab... pane closed
B.w.document.querySelector('.tab-bar-pause-all').click(); // resume from the other window
await wait(60);
{
  const wa = bytesByPty(A);
  const wb = bytesByPty(B);
  check('resume: paused idle pane gets exactly "resume\\r"', wa.get(a.idle.ptyId) === 'resume\r', wa.get(a.idle.ptyId));
  check('resume: paused title-path busy pane gets "resume\\r"', wa.get(a.titleBusy.ptyId) === 'resume\r');
  check('resume: paused pane now waiting on you gets nothing', !wa.has(a.busy.ptyId));
  check('resume: never-paused pane gets nothing', !wa.has(a.ask.ptyId) && !wa.has(a.shell.ptyId) && !wa.has(a.titleDialog.ptyId));
  check('resume: other window\'s paused pane gets "resume\\r"', wb.get(b.idle.ptyId) === 'resume\r');
  check('resume: other window\'s unpaused pane gets nothing', !wb.has(b.ask.ptyId));
  const btnB = B.w.document.querySelector('.tab-bar-pause-all');
  check('resume: result on the clicking window\'s button', btnB.textContent === 'Resumed 3 Claude sessions, 1 waiting on you: type resume there, 1 closed since', btnB.textContent);
  check('resume: both windows back to pause mode', A.tm.tabBar.pauseMode === 'pause' && B.tm.tabBar.pauseMode === 'pause');
  check('resume: Pause all label back in the other window', A.w.document.querySelector('.tab-bar-pause-all').textContent === '⏸ Pause all');
  check('resume: paused sets emptied', A.tm.pauseAll.pausedIds.length === 0 && B.tm.pauseAll.pausedIds.length === 0);
}

// ── 5. Pause with no Claude ready leaves the button at Pause all ──
A.writes.length = 0; B.writes.length = 0;
setTabs(A, [tab('t4', [a.shell]), tab('t2', [pane(A, 'a-ask2', { claude: true, blocked: true })])]);
setTabs(B, [tab('u2', [b.ask])]);
await A.tm.pressPauseAll();
{
  check('nothing ready: no writes', A.writes.length === 0 && B.writes.length === 0);
  check('nothing ready: still Pause all', A.tm.tabBar.pauseMode === 'pause');
  check('nothing ready: says so', A.w.document.querySelector('.tab-bar-pause-all').textContent === 'Nothing paused, skipped 2 waiting on you', A.w.document.querySelector('.tab-bar-pause-all').textContent);
}

// ── 6. Main: a stray report is refused; a silent window is counted; one press at a time ──
{
  check('report with an unknown request id refused', coordinator.report(1, 'nope', { sent: 1 }) === false);
  B.onRun.length = 0; // window B stops answering
  setTabs(A, [tab('t1', [pane(A, 'a-idle3', { claude: true })])]);
  const first = coordinator.press();
  const second = await coordinator.press();
  check('a second press while one runs is refused', second === null);
  const outcome = await first;
  check('silent window counted', outcome.windows === 2 && outcome.answered === 1 && outcome.sent === 1, outcome);
  check('summary names the silent window', A.PA.pauseSummary(outcome).endsWith("1 window didn't answer"), A.PA.pauseSummary(outcome));
  check('report numbers are cleaned', (await import('data:text/javascript;base64,' + Buffer.from(mainBundle.outputFiles[0].text).toString('base64')))
    .cleanReport({ sent: -3, skipped: { waiting: 2.5, closed: 1e9, bogus: 4 } }).sent === 0);
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
