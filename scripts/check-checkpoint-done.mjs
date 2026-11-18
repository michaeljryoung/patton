// Headless check of the red circle on a tab whose /checkpoint just finished
// (12 Nov 2026). Michael: "when something has finished checkpointing, it goes
// red, but with the circle red, not the square, because it hasn't been tagged
// manually … It should disappear when I click on the tab."
// Drives the REAL TabManager, Tab, TabBar and Pane in jsdom (terminal, editor
// and overlays stubbed). Readings arrive as the Stop hook's OSC 777 text
// through the real parsePattonOsc, Claude's state as OSC 7501 bodies, so the
// dot is asserted from the tab strip's DOM.
// Since 18 Nov 2026 the mark follows `cpd` (the hook's "this checkpoint has
// finished": sent only at a Stop with no background task of its own, never for
// an interrupted checkpoint), not `cpt` (its start); `reading` below sends
// `cpd` exactly when the hook would (tasks = 0) unless told otherwise.
// Covers: a new `cpd` after the session start marks the pane, logs once and
// shows the red circle above green; the same `cpt` again does nothing; a first
// reading with an old `cpt` (resume/relaunch) does nothing and a first reading
// after the start fires; selecting the tab clears it; a new turn clears it; a
// new Claude session clears it and resets the baseline; a split tab shows red
// for either pane and one selection clears both; the circle sits beside a
// manual Red flag's square; an active tab never shows it; a checkpoint whose turn spans
// several Stop readings rises only at the Stop with no task left, and stays up
// until the tab is seen (then only a newer cpd raises it); the 13 Nov sequence
// (red at a parked Stop, tab selected, green at the real finish) now ends red;
// an interrupted checkpoint (cpt, never cpd) never rises; a finish held back by
// background work is logged once per cpt; a second-boundary slack at the session start; the CSS variable
// is defined in :root.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-checkpoint-done.mjs
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
const bundle = await build({
  stdin: {
    contents: `
      export { TabManager } from './src/renderer/services/tab-manager';
      export { parseProgramStatus } from './src/renderer/services/program-status';
      export { parsePattonOsc } from './src/renderer/services/patton-osc';
      export { hoverBlock } from './src/renderer/services/tab-hover';
    `,
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true, format: 'iife', globalName: 'PA', platform: 'browser', write: false,
  loader: { '.css': 'empty' }, plugins: [stubs], logLevel: 'silent',
});

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

const deep = () => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : deep()),
  apply: () => Promise.resolve(undefined),
});
const stubWith = (overrides) => new Proxy(function () {}, {
  get: (_t, k) => (k in overrides ? overrides[k] : k === 'then' ? undefined : deep()),
  apply: () => Promise.resolve(undefined),
});

const logs = [];
let ptySeq = 0;
const dom = new JSDOM('<!doctype html><body><div id="bar"></div><div id="content"></div></body>', {
  runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
});
const w = dom.window;
w.HTMLElement.prototype.scrollIntoView = () => {};
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
w.patton = stubWith({
  pty: stubWith({
    create: () => Promise.resolve(++ptySeq),
    respawn: () => Promise.resolve(++ptySeq),
    getShell: () => Promise.resolve('/bin/zsh'),
    getCwd: () => Promise.resolve(''),
    inputState: (ids) => Promise.resolve(ids.map(() => null)),
    onData: () => () => {},
    onExit: () => () => {},
  }),
  history: stubWith({ get: () => Promise.resolve([]), add: () => Promise.resolve(), clear: () => Promise.resolve() }),
  log: { send: (_lvl, args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) },
});
w.eval(bundle.outputFiles[0].text);
const PA = w.PA;
const tm = new PA.TabManager(w.document.getElementById('bar'), w.document.getElementById('content'));

const view = (p) => p.terminalView;
const report = (p, body) => view(p).__emit('onProgramStatus', PA.parseProgramStatus(body));
const ROOT = (state) => `state=${state}:app=claude-code`;
const NOW = () => Math.floor(Date.now() / 1000);
// Fixed readings, so "the same cpt again" really is the same number.
const T0 = NOW() + 1000; // after any session start in this run
const reading = (p, cpt, tasks = 0, cpd = tasks === 0 ? cpt : null) => view(p).__emit('onPattonState', PA.parsePattonOsc(
  `patton;stop;tasks=${tasks};crons=0;ctx=50000;since=20000${cpt === null ? '' : `;cpt=${cpt}`}${cpd === null ? '' : `;cpd=${cpd}`}`));
// A Claude session that has run a turn and is at its prompt.
const turnDone = (p) => { report(p, ROOT('working')); report(p, ROOT('done')); };
const countFor = (needle, pane) => logs.filter((l) => l.includes(needle) && l.includes(`"pane":"${pane.id}"`)).length;
const tabEl = (t) => w.document.querySelectorAll('.tab-bar-tab')[tm.tabs.indexOf(t)];
const dotsOf = (t) => Array.from(tabEl(t).querySelectorAll('.tab-bar-tab-indicator')).map((d) => d.className.replace('tab-bar-tab-indicator', '').trim());
// The set line only: '[CKPT] finished mark cleared' also starts with '[CKPT] finished'.
const countFinished = (pane) => countFor('[CKPT] finished {', pane);
const labelOf = (t) => tabEl(t).getAttribute('aria-label');

const t1 = await tm.createTab();
const t2 = await tm.createTab();
const t3 = await tm.createTab();
await wait(5);
const p1 = t1.panes[0];
const p2 = t2.panes[0];
const p3 = t3.panes[0];
tm.switchToId(t3.id); // t3 is the one he is looking at

// ── 1. A checkpoint finishes in a background tab ──
turnDone(p1);
await wait(1100); // the settle that raises the green dot is longer; the mark is immediate
reading(p1, T0 + 1);
check('flag set on the pane', p1.checkpointDone === true);
check('tab reports it', t1.checkpointDone === true);
check('logged once: [CKPT] finished', countFinished(p1) === 1 && logs.some((l) => l.includes('[CKPT] finished {') && l.includes('"cpd"')), logs.filter((l) => l.includes('finished')));
check('dot is the red circle (class checkpoint-done, not a flag-* square)', JSON.stringify(dotsOf(t1)) === '["checkpoint-done"]', dotsOf(t1));
check('dot has an aria-label', tabEl(t1).querySelector('.checkpoint-done')?.getAttribute('aria-label') === 'Checkpoint finished');
check('tab label says checkpoint finished', /checkpoint finished/.test(labelOf(t1)), labelOf(t1));
check('hover card input says Checkpoint finished', PA.hoverBlock({
  title: 'x', cwd: '', project: null, claude: { activity: 'waiting', since: Date.now(), title: null, blockedKind: null, msg: null, blockedTask: null, parked: null },
  checkpoint: p1.checkpointSource, checkpointDone: p1.checkpointDone,
}, Date.now()).done === 'Checkpoint finished');

// ── 2. It outranks green (Claude's turn end also raised "needs you") ──
await wait(500);
check('green dot also raised for the same turn end (tab awaiting input)', t1.awaitingInput === true);
check('red outranks green: only the red circle is drawn', JSON.stringify(dotsOf(t1)) === '["checkpoint-done"]', dotsOf(t1));
check('label names both states, checkpoint first', /checkpoint finished, waiting for you/.test(labelOf(t1)), labelOf(t1));

// ── 3. The same cpt again: no second log ──
reading(p1, T0 + 1);
reading(p1, T0 + 1);
check('same cpt again: still one [CKPT] finished', countFinished(p1) === 1, countFinished(p1));

// ── 4. Selecting the tab clears it ──
tm.switchToId(t1.id);
check('selected: flag cleared', p1.checkpointDone === false);
check('selected: log reason selected', countFor('[CKPT] finished mark cleared', p1) === 1 && logs.some((l) => l.includes('finished mark cleared') && l.includes('"reason":"selected"')));
check('selected: no dot on the active tab', dotsOf(t1).length === 0, dotsOf(t1));
tm.switchToId(t3.id);
check('after switching away: no stale red, green gone too', dotsOf(t1).length === 0, dotsOf(t1));
reading(p1, T0 + 1);
check('same cpt after clearing does not mark it again', p1.checkpointDone === false && countFinished(p1) === 1);

// ── 5. A newer checkpoint marks again ──
reading(p1, T0 + 2);
check('a newer cpt marks again (second [CKPT] finished)', p1.checkpointDone === true && countFinished(p1) === 2, countFinished(p1));

// ── 6. A new turn clears it ──
report(p1, ROOT('working'));
check('new turn: flag cleared', p1.checkpointDone === false);
check('new turn: log reason', logs.some((l) => l.includes('finished mark cleared') && l.includes('"reason":"new turn"')));
check('new turn: red circle gone from the strip', !dotsOf(t1).includes('checkpoint-done'), dotsOf(t1));
report(p1, ROOT('done'));

// ── 7. Old cpt on the first reading (resume / relaunch) does nothing; a new one after the start fires ──
turnDone(p2);
reading(p2, NOW() - 3600);
check('first reading with an old cpt: nothing', p2.checkpointDone === false && countFinished(p2) === 0);
reading(p2, NOW() - 3600);
check('old cpt repeated: still nothing', p2.checkpointDone === false);
reading(p2, T0 + 3);
check('a later reading with a cpt after the start fires', p2.checkpointDone === true && countFinished(p2) === 1);
p2.clearCheckpointDone('selected');

const pFresh = (await tm.createTab()).panes[0];
tm.switchToId(t3.id);
turnDone(pFresh);
reading(pFresh, T0 + 1);
check('first reading of a session whose first command was /checkpoint fires', pFresh.checkpointDone === true && countFinished(pFresh) === 1);

// ── 8. A new Claude session clears it and resets the baseline ──
tm.switchToId(t3.id);
reading(p2, T0 + 5);
check('p2 marked again before the session ends', p2.checkpointDone === true);
const before = countFinished(p2);
report(p2, 'state=clear');
check('session ended: flag cleared', p2.checkpointDone === false);
check('session ended: log reason new session', logs.some((l) => l.includes('finished mark cleared') && l.includes('"reason":"new session"')));
const sessionStart = NOW();
turnDone(p2);
reading(p2, sessionStart - 600); // the resumed transcript's OLD checkpoint, a value the previous session never saw
check('after a new session an old cpt is a baseline only', p2.checkpointDone === false && countFinished(p2) === before);
reading(p2, T0 + 5); // the value that fired in the previous session, now fresh in this one
check('baseline was reset: the same value as the old session fires in the new one', p2.checkpointDone === true && countFinished(p2) === before + 1, countFinished(p2));
p2.clearCheckpointDone('selected');

// ── 9. A split tab: either pane shows red, one selection clears both ──
await t2.splitVertical();
await wait(5);
const [q1, q2] = t2.panes;
turnDone(q1); turnDone(q2);
tm.switchToId(t3.id);
reading(q1, T0 + 30);
check('split: red with only the first pane marked', t2.checkpointDone === true && dotsOf(t2).includes('checkpoint-done'), dotsOf(t2));
reading(q2, T0 + 31);
check('split: both panes marked', q1.checkpointDone && q2.checkpointDone);
check('split: one red circle, not two', dotsOf(t2).filter((d) => d === 'checkpoint-done').length === 1, dotsOf(t2));
tm.switchToId(t2.id);
check('split: selecting the tab clears both panes', !q1.checkpointDone && !q2.checkpointDone && !t2.checkpointDone && dotsOf(t2).length === 0, dotsOf(t2));
tm.switchToId(t3.id);

// ── 10. A manual Red flag (square) and the red circle both render ──
tm.setTabFlag?.(t1.id, 'red');
reading(p1, T0 + 20);
await wait(5);
check('flag + checkpoint: square then circle', JSON.stringify(dotsOf(t1)) === '["flag-red","checkpoint-done"]', dotsOf(t1));
check('flag + checkpoint: circle has no flag-* class', tabEl(t1).querySelector('.checkpoint-done')?.className.includes('flag-') === false);
tm.switchToId(t1.id);
check('flag + checkpoint: selecting clears only the circle; the flag stays', JSON.stringify(dotsOf(t1)) === '["flag-red"]', dotsOf(t1));
tm.switchToId(t3.id);

// ── 11. The active tab never shows it (like the green dot) ──
const beforeActive = countFor('[CKPT] finished mark cleared', p3);
turnDone(p3);
reading(p3, T0 + 30);
check('active tab: no mark kept', p3.checkpointDone === false && !t3.checkpointDone && !dotsOf(t3).includes('checkpoint-done'), dotsOf(t3));
check('active tab: cleared with reason active tab', countFor('[CKPT] finished mark cleared', p3) === beforeActive + 1 && logs.some((l) => l.includes('"reason":"active tab"')));
tm.switchToId(t1.id);
tm.switchToId(t3.id);
check('active tab: nothing shows up later on switching away', !t3.checkpointDone);

// ── 11b. A checkpoint whose turn spans several Stop readings: red only when its own work is done ──
const tM = await tm.createTab();
const pM = tM.panes[0];
tm.switchToId(t3.id);
turnDone(pM);
reading(pM, T0 + 60, 5); // Stop with its background tasks still running: cpt, no cpd
check('multi-Stop: a Stop with tasks running does not raise the mark', pM.checkpointDone === false && countFinished(pM) === 0);
check('multi-Stop: but the clock already has the checkpoint', pM.checkpointSource.checkpointAt === T0 + 60);
report(pM, ROOT('working')); // a background task wakes Claude
report(pM, ROOT('done'));
reading(pM, T0 + 60, 0); // the final Stop: cpd
check('multi-Stop: the final Stop (tasks=0, cpd) raises the mark', pM.checkpointDone === true && countFinished(pM) === 1, countFinished(pM));
reading(pM, T0 + 60, 0);
check('multi-Stop: a repeat while up logs nothing more', countFinished(pM) === 1);
tm.switchToId(tM.id);
check('multi-Stop: selecting the tab clears it', pM.checkpointDone === false);
tm.switchToId(t3.id);
reading(pM, T0 + 60, 0);
check('seen: a later Stop with the same cpd does not raise it', pM.checkpointDone === false && countFinished(pM) === 1);
reading(pM, T0 + 61, 0);
check('seen: a later NEW cpd does', pM.checkpointDone === true && countFinished(pM) === 2);
tm.switchToId(tM.id);
tm.switchToId(t3.id);
reading(pM, T0 + 59, 0); // a /resume-like reading older than what he has seen
check('seen: an in-session cpd older than the acked one does not', pM.checkpointDone === false && countFinished(pM) === 2);
// The active-tab guard consumes a mark as "seen" too.
tm.switchToId(tM.id);
reading(pM, T0 + 62, 0);
check('active tab: consumed mark is acked', pM.checkpointDone === false);
tm.switchToId(t3.id);
reading(pM, T0 + 62, 0);
check('active tab: the same cpd later does not raise it', pM.checkpointDone === false && countFinished(pM) === 3, countFinished(pM));
// A new turn that clears the mark is not "seen": the next Stop raises it again.
reading(pM, T0 + 63, 0);
report(pM, ROOT('working'));
report(pM, ROOT('done'));
reading(pM, T0 + 63, 0);
check('unseen: a mark cleared by a new turn comes back on the next Stop', pM.checkpointDone === true);
tm.switchToId(tM.id);
tm.switchToId(t3.id);

// ── 11b2. The 13 Nov sequence: parked Stop, tab selected, then the real finish ──
// main.log: red at a Stop with tasks=1, the tab selected 50 s later, the
// commit and the final Stop (tasks=0, same checkpoint) two minutes after,
// which showed green. Now the parked Stop carries no cpd, so the selection
// acks nothing and the final Stop raises red.
{
  const tN = await tm.createTab();
  const pN = tN.panes[0];
  tm.switchToId(t3.id);
  turnDone(pN);
  reading(pN, T0 + 70, 1);
  check('13 Nov: the parked Stop (tasks=1) shows no red', pN.checkpointDone === false && !dotsOf(tN).includes('checkpoint-done'), dotsOf(tN));
  tm.switchToId(tN.id); // he looks at the tab while it is parked
  tm.switchToId(t3.id);
  report(pN, ROOT('working')); // the task's result wakes Claude; it commits
  report(pN, ROOT('done'));
  reading(pN, T0 + 70, 0);
  check('13 Nov: the real finish (tasks=0, cpd) raises red', pN.checkpointDone === true && countFinished(pN) === 1, countFinished(pN));
  await wait(1100);
  check('13 Nov: red, not green, on the strip', JSON.stringify(dotsOf(tN)) === '["checkpoint-done"]', dotsOf(tN));
}

// ── 11b3. An interrupted checkpoint: cpt keeps coming, cpd never does ──
{
  const tI = await tm.createTab();
  const pI = tI.panes[0];
  tm.switchToId(t3.id);
  turnDone(pI);
  reading(pI, T0 + 80, 0, null); // interrupted, he talks about something else
  reading(pI, T0 + 80, 1, null);
  report(pI, ROOT('working'));
  report(pI, ROOT('done'));
  reading(pI, T0 + 80, 0, null);
  check('interrupted: never raises the mark', pI.checkpointDone === false && countFinished(pI) === 0, countFinished(pI));
  reading(pI, T0 + 80, 0); // resumed later and finished: cpd arrives
  check('interrupted, then finished: rises then', pI.checkpointDone === true && countFinished(pI) === 1, countFinished(pI));
}

// ── 11b4. A finish held back by background work is logged once per cpt ──
{
  const tH = await tm.createTab();
  const pH = tH.panes[0];
  tm.switchToId(t3.id);
  turnDone(pH);
  const held = () => countFor('[CKPT] finish held', pH);
  reading(pH, T0 + 90, 2); // tasks running: cpt, no cpd
  check('held: logged at a Stop with tasks and no cpd', held() === 1 && logs.some((l) => l.includes('[CKPT] finish held') && l.includes(`"cpt":${T0 + 90}`) && l.includes('"tasks":2')), logs.filter((l) => l.includes('finish held')));
  reading(pH, T0 + 90, 1);
  check('held: the same cpt again is not logged again', held() === 1, held());
  reading(pH, T0 + 90, 0); // the finish: cpd, tasks = 0
  check('held: not logged at the tasks = 0 Stop', held() === 1 && pH.checkpointDone === true, held());
  reading(pH, T0 + 91, 3, T0 + 91); // tasks running but cpd present (tasks unknown to the hook)
  check('held: not logged when cpd is present', held() === 1, held());
  reading(pH, T0 + 92, 0, null); // tasks = 0, no cpd (cut off): not a hold
  check('held: not logged when tasks = 0', held() === 1, held());
  reading(pH, T0 + 89, 2); // older than the one marked
  check('held: not logged for a cpt older than the marked one', held() === 1, held());
  reading(pH, T0 + 93, 2);
  check('held: a newer cpt is logged once more', held() === 2, held());
  tm.switchToId(tH.id);
  tm.switchToId(t3.id);
}

// ── 11c. A second boundary between the transcript stamp and the session start ──
{
  const realNow = w.Date.now;
  const X = T0 + 500; // whole second
  const pB = (await tm.createTab()).panes[0];
  const pB2 = (await tm.createTab()).panes[0];
  tm.switchToId(t3.id);
  w.Date.now = () => X * 1000 + 50; // the session is stamped 50 ms into second X
  turnDone(pB); turnDone(pB2);
  w.Date.now = realNow;
  reading(pB, X - 1); // the /checkpoint began 10 ms earlier: whole seconds say X-1
  check('boundary: cpt one second before the session start still fires', pB.checkpointDone === true, pB.checkpointDone);
  reading(pB2, X - 2);
  check('boundary: two seconds before is old', pB2.checkpointDone === false);
}

// ── 12. The CSS variable is defined once in :root (dark inherits), and the circle uses it ──
{
  const main = readFileSync(join(repo, 'src/renderer/styles/main.css'), 'utf8');
  const darkAt = main.indexOf('prefers-color-scheme: dark');
  const rootAt = main.indexOf(':root');
  const hasVar = (s) => /--status-ckpt:\s*var\(--red\)/.test(s);
  check('--status-ckpt defined in the light :root block', rootAt >= 0 && darkAt > rootAt && hasVar(main.slice(rootAt, darkAt)));
  check('--status-ckpt not redefined in the dark block (same --red in both modes)', darkAt > 0 && !/--status-ckpt/.test(main.slice(darkAt, darkAt + 2500)) && /--red:/.test(main.slice(rootAt, darkAt)) && !/--red:/.test(main.slice(darkAt)));
  const tabs = readFileSync(join(repo, 'src/renderer/styles/tabs.css'), 'utf8');
  check('the circle\'s CSS uses --status-ckpt and is not a square', /\.tab-bar-tab-indicator\.checkpoint-done\s*{[^}]*var\(--status-ckpt\)/.test(tabs) && !/\.checkpoint-done\s*{[^}]*border-radius:\s*0/.test(tabs));
}

finished = true;
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
