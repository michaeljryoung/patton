// Headless check of where the compose box sits (docs/compose-box.md D9, D10's
// freeze, D12's setting): a REAL Pane in jsdom whose terminal view is a stub
// holding a REAL @xterm/xterm Terminal (never opened, so no layout: geometry
// is the hidden-Electron check's job), fed Claude Code v2.1.321's recorded
// screens (scripts/fixtures/claude-bar-screens.json). Asserts the placement
// (`data-compose-placement`, the placement-* classes, `[COMPOSE] place`
// lines with their reasons), that the terminal is refitted only between
// `under` and the overlays, the 400 ms lost rule, the freeze from Claude's
// first `blocked` report, the hand-off and the setting.
// Time: Pane's timers run on a fake clock (setTimeout, Date.now); xterm's
// parsing and the animation frame are real.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-compose-placement.mjs
// Against another source tree (to prove the checks fail there):
// COMPOSE_SRC_ROOT=<that worktree> node scripts/check-compose-placement.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.COMPOSE_SRC_ROOT ? resolve(process.env.COMPOSE_SRC_ROOT) : here;
const fixture = JSON.parse(readFileSync(join(here, 'scripts/fixtures/claude-bar-screens.json'), 'utf8'));

const stubSource = `
  const mk = () => new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()),
    apply: () => mk(), construct: () => mk(),
  });
  export class TerminalView {
    constructor(container) {
      const listeners = {};
      const termEl = document.createElement('textarea');
      termEl.className = 'fake-xterm-input';
      container.appendChild(termEl);
      const own = {
        __emit: (k, ...a) => { for (const cb of listeners[k] ?? []) cb(...a); },
        __termEl: termEl,
        __fits: 0,
        fit: () => { own.__fits++; },
        focus: () => { termEl.focus(); },
        getDimensions: () => ({ cols: own.terminal.cols, rows: own.terminal.rows }),
        terminal: globalThis.__makeTerminal(),
      };
      return new Proxy(own, {
        get: (t, k) => {
          if (k in t) return t[k];
          if (typeof k === 'string' && /^on[A-Z]/.test(k)) {
            return (cb) => { (listeners[k] ??= []).push(cb); return () => {}; };
          }
          return k === 'then' ? undefined : mk();
        },
        set: (t, k, v) => { t[k] = v; return true; },
      });
    }
  }
  export const SearchOverlay = mk(), HistorySearch = mk(), PasteDialog = mk();`;
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /\/(terminal-view|search-overlay|history-search|paste-dialog)$/ },
      (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stubSource, loader: 'js' }));
  },
};
const bundle = await build({
  stdin: {
    contents: `
      export { Pane } from './src/renderer/components/pane';
      export { parseProgramStatus } from './src/renderer/services/program-status';
    `,
    resolveDir: repo, loader: 'ts',
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
const realWait = (ms) => new Promise((r) => setTimeout(r, ms));

const deep = () => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : deep()),
  apply: () => Promise.resolve(undefined),
});
const stubWith = (overrides) => new Proxy(function () {}, {
  get: (_t, k) => (k in overrides ? overrides[k] : k === 'then' ? undefined : deep()),
  apply: () => Promise.resolve(undefined),
});

const logs = [];
const resizes = [];
const dom = new JSDOM('<!doctype html><body><div id="content"></div></body>', {
  runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
});
const w = dom.window;
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

// xterm runs in Node with the jsdom globals (as check-claude-bar.mjs does).
globalThis.window = w;
globalThis.document = w.document;
globalThis.self = w;
Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
const origError = console.error;
console.error = (...a) => { if (!String(a[0]).includes('getContext')) origError(...a); };
const { Terminal } = createRequire(join(here, 'noop.js'))('@xterm/xterm');
w.__makeTerminal = () => new Terminal({
  cols: fixture.cols, rows: fixture.rows, allowProposedApi: true, scrollback: 1000,
});

// ── Pane's fake clock: setTimeout and Date.now on the window ──
let now = 1_000_000;
let timerSeq = 0;
let timers = [];
w.setTimeout = (fn, ms = 0, ...args) => {
  const id = ++timerSeq;
  timers.push({ id, at: now + Math.max(0, Number(ms) || 0), fn, args });
  return id;
};
w.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
w.setInterval = () => ++timerSeq;
w.clearInterval = () => {};
w.Date.now = () => now;
const advance = (ms) => {
  const target = now + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    now = Math.max(now, due.at);
    due.fn(...due.args);
  }
  now = target;
};

let ptySeq = 0;
w.patton = stubWith({
  pty: stubWith({
    create: () => Promise.resolve(++ptySeq),
    respawn: () => Promise.resolve(++ptySeq),
    getShell: () => Promise.resolve('/bin/zsh'),
    getCwd: () => Promise.resolve(''),
    write: () => {},
    resize: (...a) => { resizes.push(a); return Promise.resolve(); },
    onData: () => () => {},
    onExit: () => () => {},
  }),
  history: stubWith({ get: () => Promise.resolve([]), add: () => Promise.resolve(), clear: () => Promise.resolve() }),
  log: { send: (lvl, args) => logs.push({ lvl, tag: String(args[0]), data: args[1] }) },
});
w.eval(bundle.outputFiles[0].text);
const PA = w.PA;
const doc = w.document;
const content = doc.getElementById('content');

// ── Helpers ──
const view = (p) => p.terminalView;
const term = (p) => view(p).terminal;
const report = (p, body) => view(p).__emit('onProgramStatus', PA.parseProgramStatus(`${body}:app=claude-code`));
const state = (p, s, kind) => report(p, `state=${s}${kind ? `:kind=${kind}` : ''}`);
const places = () => logs.filter((l) => l.tag === '[COMPOSE] place').map((l) => l.data);
const placement = (p) => p.element.dataset.composePlacement;
const classesOk = (p, want) => ['placement-over', 'placement-dock'].every((c) => {
  const on = want === c.slice('placement-'.length);
  return p.editorContainer.classList.contains(c) === on && p.pasteStrip.classList.contains(c) === on;
});
const frames = () => realWait(50); // the animation frame and xterm's parse have run
const write = (t, data) => new Promise((r) => t.write(data, r));

/** A feeder over one recording: `to(mark)` writes every chunk up to it. */
const feeder = (p, name) => {
  const events = fixture.recordings[name];
  let i = 0;
  return {
    async to(mark) {
      while (i < events.length) {
        const e = events[i++];
        if (e.mark === mark) break;
        if (e.b) await write(term(p), Buffer.from(e.b, 'base64'));
      }
      await frames();
    },
  };
};

const newPane = async () => {
  timers = [];
  const p = new PA.Pane({ onFocus() {}, onTitleChange() {} });
  await p.init();
  content.appendChild(p.element);
  p.setFocused(true);
  await realWait(40);
  p.setComposeFirst(true, null);
  state(p, 'idle');
  await frames();
  logs.length = 0;
  resizes.length = 0;
  return p;
};

// ── 1. The `steps` recording through one pane ──
{
  const p = await newPane();
  const f = feeder(p, 'steps');
  check('1.0 engaged, no reading matched yet: under', placement(p) === 'under' && classesOk(p, 'under'), placement(p));

  await f.to('idle');
  let pl = places();
  check('1.1 idle (bar found, empty, in view): over, reason found',
    placement(p) === 'over' && pl.length === 1 && pl[0].from === 'under' && pl[0].reason === 'found'
    && pl[0].pane === p.id && classesOk(p, 'over'), pl);
  check('1.1 ...the terminal refitted and the pty told once (under -> over)', resizes.length === 1, resizes);

  logs.length = 0; resizes.length = 0;
  await f.to('typed');
  pl = places();
  check('1.2 typed text in Claude\'s bar: under at once, reason holds-text',
    placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'holds-text' && classesOk(p, 'under'), pl);
  check('1.2 ...refitted once (over -> under)', resizes.length === 1, resizes);

  logs.length = 0;
  await f.to('cleared');
  pl = places();
  check('1.3 cleared: over again, reason found', placement(p) === 'over' && pl.length === 1 && pl[0].reason === 'found', pl);

  logs.length = 0;
  await f.to('wrapped');
  check('1.4 wrapped input (no match): the last good position is kept at first', placement(p) === 'over', places());
  advance(390);
  check('1.4 ...still over 390 ms after the last match', placement(p) === 'over', places());
  advance(20);
  pl = places();
  const nf = logs.filter((l) => l.tag === '[COMPOSE] bar not found').map((l) => l.data);
  check('1.4 ...under once 400 ms pass with no match, reason lost',
    placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'lost', pl);
  check('1.4 ...and `[COMPOSE] bar not found` with why', nf.length === 1 && nf[0].pane === p.id
    && ['no-glyph', 'no-rule-above', 'no-rule-below'].includes(nf[0].why), nf);

  await f.to('multiline');
  advance(500);
  check('1.5 multi-line input: under', placement(p) === 'under', places());
  logs.length = 0;
  await f.to('cleared2');
  pl = places();
  check('1.6 cleared again: over, reason found', placement(p) === 'over' && pl.length === 1 && pl[0].reason === 'found', pl);
  const nf2 = logs.filter((l) => l.tag === '[COMPOSE] bar not found');
  check('1.6 ...no second `bar not found` within a minute', nf2.length === 0, nf2);

  // D10: Claude's first `blocked` report freezes placement, before the 250 ms hold.
  logs.length = 0; resizes.length = 0;
  await f.to('q-sent');
  state(p, 'working');
  state(p, 'blocked', 'question');
  await f.to('question');
  advance(100);
  check('1.7 question dialog inside the hold (100 ms): placement frozen at over', placement(p) === 'over' && places().length === 0, places());
  advance(2000);
  check('1.7 ...and through the aside (2.1 s): still over, nothing logged, no refit',
    placement(p) === 'over' && places().length === 0 && resizes.length === 0, { pl: places(), resizes });

  // The aside ends while the question's screen is still up: back at its last
  // placement, then under 400 ms later as the bar isn't found.
  state(p, 'working');
  await frames();
  check('1.8 aside ends: the box back at its last placement', placement(p) === 'over', places());
  advance(410);
  pl = places();
  check('1.8 ...under once the bar isn\'t found within 400 ms, reason aside-end',
    placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'aside-end', pl);
  logs.length = 0;
  state(p, 'idle');
  await f.to('question-cancelled');
  pl = places();
  check('1.9 question cancelled, bar back: over, reason found', placement(p) === 'over' && pl.length === 1 && pl[0].reason === 'found', pl);

  logs.length = 0;
  await f.to('history');
  advance(500);
  pl = places();
  check('1.12 history recall (labelled rule): under, reason lost', placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'lost', pl);
  await f.to('slash');
  check('1.13 `/` in Claude\'s bar: under', placement(p) === 'under', places());
  logs.length = 0;
  await f.to('end');
  check('1.14 end (cleared): over', placement(p) === 'over' && places().length === 1, places());

  // Hand-off (Esc with a draft): under; the box taking the keyboard back reads again.
  logs.length = 0;
  const box = p.editorContainer.querySelector('textarea');
  box.focus();
  p.editorInput.setValue('a draft');
  box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await frames();
  pl = places();
  check('1.16 Esc with a draft hands off: under, reason handoff', placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'handoff', pl);
  box.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
  box.focus();
  await frames();
  pl = places();
  check('1.17 the box takes the keyboard back: over, reason found', placement(p) === 'over' && pl.length === 2 && pl[1].reason === 'found', pl);

  // D12: the setting.
  logs.length = 0; resizes.length = 0;
  p.setComposeOverBar(false);
  pl = places();
  check('1.18 composeOverBar off: under, reason setting', placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'setting', pl);
  await write(term(p), ' ');
  await write(term(p), '\b');
  await frames();
  check('1.18 ...readings no longer move it', placement(p) === 'under' && places().length === 1, places());
  p.setComposeOverBar(true);
  await frames();
  check('1.19 back on: over', placement(p) === 'over' && places().length === 2, places());

  // The box closed (⌘E from inside it): under, and a fresh start on reopening.
  logs.length = 0;
  p.setComposeFirst(false, null);
  pl = places();
  check('1.20 box disengaged: under, reason disengage', placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'disengage', pl);
  p.setComposeFirst(true, null);
  await frames();
  check('1.21 engaged again: over from the next reading', placement(p) === 'over', places());
  p.dispose();
}

// ── 2. A queued message (the queue renders above the bar, Claude's dim hint in it) ──
{
  const p = await newPane();
  const f = feeder(p, 'queue');
  for (const mark of ['idle', 'working', 'queued', 'queued+1s', 'after']) {
    await f.to(mark);
    advance(1);
    check(`2 queue/${mark}: over`, placement(p) === 'over', places());
  }
  let pl;
  // Scrolled up: dock; scrolled back: over. Neither refits the terminal.
  logs.length = 0; resizes.length = 0;
  term(p).scrollLines(-5);
  await frames();
  pl = places();
  check('2.1 scrolled up 5 lines: dock, reason scrolled', placement(p) === 'dock' && pl.length === 1
    && pl[0].from === 'over' && pl[0].reason === 'scrolled' && classesOk(p, 'dock'), { pl, vy: term(p).buffer.active.viewportY });
  term(p).scrollToBottom();
  await frames();
  pl = places();
  check('2.2 scrolled back down: over, reason in-view', placement(p) === 'over' && pl.length === 2 && pl[1].reason === 'in-view', pl);
  check('2.2 ...no refit between over and dock', resizes.length === 0, resizes);

  // A frozen placement ignores a scroll, from the live blocked fact on.
  logs.length = 0;
  state(p, 'blocked', 'permission');
  term(p).scrollLines(-5);
  await frames();
  check('2.3 blocked (live fact) then a scroll: no move', placement(p) === 'over' && places().length === 0, places());
  state(p, 'idle'); // inside the 250 ms hold: no aside was ever shown
  await frames();
  pl = places();
  check('2.3 ...unblocked: readings resume (dock, scrolled)', placement(p) === 'dock' && pl.length === 1 && pl[0].reason === 'scrolled', pl);
  term(p).scrollToBottom();
  await frames();

  p.dispose();
}

// ── 3. A real turn: the 4 bursts that end mid-redraw never move the box ──
{
  const p = await newPane();
  const events = fixture.recordings.turn;
  let sent = false;
  for (const e of events) {
    if (e.mark === 'turn-sent') { sent = true; logs.length = 0; continue; }
    if (!e.b) continue;
    await write(term(p), Buffer.from(e.b, 'base64'));
    await frames();
    if (sent) advance(50); // bursts arrive tens of ms apart
  }
  // The recording typed the prompt into Claude's own bar: it holds text (under)
  // until Enter clears it (over). After that, the 4 bursts that end mid-redraw
  // move nothing.
  const pl = places();
  check('3 turn: under while the prompt sits in Claude\'s bar, over once it clears, then no move',
    placement(p) === 'over' && pl.length === 2 && pl[0].reason === 'holds-text' && pl[1].reason === 'found', pl);
  p.dispose();
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
