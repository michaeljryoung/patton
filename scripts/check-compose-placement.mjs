// Headless check of where the compose box sits (docs/compose-box.md D9, D10's
// freeze, D12's setting): a REAL Pane in jsdom whose terminal view is a stub
// holding a REAL @xterm/xterm Terminal (never opened, so no layout: geometry
// is the hidden-Electron check's job), fed Claude Code v2.1.321's recorded
// screens (scripts/fixtures/claude-bar-screens.json). Asserts the placement
// (`data-compose-placement`, the placement-* classes, `[COMPOSE] place`
// lines with their reasons), that the terminal is refitted only between
// `under` and the overlays, the 400 ms wait before `under` (lost or holding
// text) and that readings within 1.5 s of the pane's own typing (a send from
// the box, an Okay? ask) never count toward it (D9 as amended), the freeze
// from Claude's first `blocked` report, D10's hidden box and "Draft kept"
// during an aside in the overlays, the hand-off and the setting.
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
const writes = [];
const CLEAN_INPUT = { dirty: false, length: 0, lastInputAt: 0, slashSubmitAt: 0, userStashAt: 0, pattonStashAt: 0 };
w.patton = stubWith({
  pauseAll: stubWith({ stashKey: () => Promise.resolve({ ok: true }) }),
  pty: stubWith({
    inputState: () => Promise.resolve([CLEAN_INPUT]),
    create: () => Promise.resolve(++ptySeq),
    respawn: () => Promise.resolve(++ptySeq),
    getShell: () => Promise.resolve('/bin/zsh'),
    getCwd: () => Promise.resolve(''),
    write: (_id, d) => { writes.push(d); },
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
const boxOf = (p) => p.editorContainer.querySelector('textarea');
/** Send `text` from the box with Enter, as he does: the text is written now,
 *  its Enter 10 ms later on the fake clock (advance to send it). */
const sendFromBox = async (p, text) => {
  const box = boxOf(p);
  box.focus();
  p.editorInput.setValue(text);
  box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await realWait(0); // the submit queue's microtask has written the text
};
/** The polite announcer region (services/announcer.ts) on <body>. */
const announced = () => [...doc.body.children].filter((el) => el.getAttribute('aria-live') === 'polite')
  .map((el) => el.textContent).join('|');
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

  // D9 as amended: text in Claude's bar (typed there, not sent from the box)
  // moves the box under only once 400 ms pass with no empty-bar reading.
  logs.length = 0; resizes.length = 0;
  await f.to('typed');
  check('1.2 typed text in Claude\'s bar: still over at first', placement(p) === 'over' && places().length === 0, places());
  advance(390);
  check('1.2 ...still over 390 ms on', placement(p) === 'over' && places().length === 0, places());
  advance(20);
  pl = places();
  check('1.2 ...under once it has stayed past 400 ms, reason holds-text',
    placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'holds-text' && classesOk(p, 'under'), pl);
  check('1.2 ...refitted once (over -> under)', resizes.length === 1, resizes);
  check('1.2 ...and no `bar not found` (the bar was found, holding text)',
    !logs.some((l) => l.tag === '[COMPOSE] bar not found'), logs.map((l) => l.tag));

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

// ── 3. A real turn sent from the box: Claude echoes the prompt into its bar
//       before the Enter clears it, and 4 bursts end mid-redraw; nothing moves ──
{
  const p = await newPane();
  const events = fixture.recordings.turn;
  let sent = false;
  let lastT = 0;
  let movedAt = null;
  for (const e of events) {
    if (e.mark === 'turn-sent') {
      check('3 (setup) over before the send', placement(p) === 'over', placement(p));
      logs.length = 0; resizes.length = 0; writes.length = 0;
      await sendFromBox(p, 'Count from 1 to 45, one number per line, nothing else.');
      check('3 (setup) the box wrote the prompt to the pty', writes.includes('Count from 1 to 45, one number per line, nothing else.'), writes);
      sent = true;
      lastT = e.t;
      continue;
    }
    if (!e.b) continue;
    if (sent) { advance(Math.round((e.t - lastT) * 1000)); lastT = e.t; } // the recording's own gaps
    await write(term(p), Buffer.from(e.b, 'base64'));
    await frames();
    if (sent && movedAt === null && placement(p) !== 'over') movedAt = e.t;
  }
  advance(2000);
  const pl = places();
  check('3 turn sent from the box: over throughout, no `[COMPOSE] place`, no refit',
    movedAt === null && placement(p) === 'over' && pl.length === 0 && resizes.length === 0, { movedAt, pl, resizes });
  p.dispose();
}

// ── 4. The pane's own typing (D9 as amended): an echo that outlasts 400 ms ──
{
  const p = await newPane();
  const f = feeder(p, 'steps');
  await f.to('idle');
  check('4 (setup) over', placement(p) === 'over', placement(p));
  logs.length = 0; resizes.length = 0; writes.length = 0;
  await sendFromBox(p, 'hello there');
  await f.to('typed'); // Claude shows the sent text in its bar
  advance(10); // the Enter
  check('4 (setup) text then Enter written', writes[0] === 'hello there' && writes[1] === '\r', writes);
  advance(790); // Claude slow to clear it: 800 ms in all
  check('4.1 a send from the box whose echo stays in Claude\'s bar for 800 ms: still over, no `[COMPOSE] place`, no refit',
    placement(p) === 'over' && places().length === 0 && resizes.length === 0, { pl: places(), resizes });
  await f.to('cleared');
  check('4.1 ...cleared: over, still nothing logged', placement(p) === 'over' && places().length === 0, places());

  // An echo that never clears: the 400 ms wait starts only once 1.5 s have
  // passed since the pane's last write (its Enter).
  await sendFromBox(p, 'a long line');
  await f.to('wrapped'); // a screen the reader can't match
  advance(10); // the Enter: the window runs to 1510 ms, the wait to 1910 ms
  advance(1790);
  check('4.2 a reading that misses the bar after the box\'s own send: still over 1.8 s on',
    placement(p) === 'over' && places().length === 0, places());
  advance(160);
  let pl = places();
  check('4.2 ...under by 1.96 s (1.5 s window, then the 400 ms wait), reason lost',
    placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'lost', pl);
  p.dispose();
}
{
  // An Okay? ask is the pane's own typing too: the `typed` screen (text in
  // Claude's bar) for 800 ms after it moves nothing.
  const p = await newPane();
  const f = feeder(p, 'steps');
  await f.to('idle');
  state(p, 'working');
  state(p, 'idle');
  check('4.3 (setup) over', placement(p) === 'over', placement(p));
  logs.length = 0; writes.length = 0; resizes.length = 0;
  const okay = p.editorContainer.querySelector('.okay-button');
  check('4.3 (setup) the Okay? button is in the box', Boolean(okay), null);
  okay?.click();
  await realWait(20); // the probes have answered and the line is written
  check('4.3 (setup) the Okay? ask wrote its line', writes.includes('Is everything going okay?'), writes);
  await f.to('typed');
  advance(10);
  advance(790);
  check('4.3 an Okay? ask, then text in Claude\'s bar for 800 ms: still over, no `[COMPOSE] place`, no refit',
    placement(p) === 'over' && places().length === 0 && resizes.length === 0, places());
  advance(1200);
  check('4.3 ...but text still there 2 s on (past the 1.5 s window and the wait): under, reason holds-text',
    placement(p) === 'under' && places().length === 1 && places()[0].reason === 'holds-text', places());
  p.dispose();
}

// ── 5. D10: an aside in the overlays hides the box; "Draft kept" ──
{
  const p = await newPane();
  const f = feeder(p, 'steps');
  await f.to('cleared2');
  await f.to('q-sent');
  state(p, 'working');
  check('5 (setup) over', placement(p) === 'over', placement(p));
  const ec = p.editorContainer;
  const box = boxOf(p);
  // (A stand-in on a tree without the note, so every check below still reports.)
  const note = p.element.querySelector('.compose-draft-note') ?? Object.assign(doc.createElement('div'), { hidden: true });
  check('5.0 "Draft kept" exists, hidden, not in the box', note.isConnected && note.hidden === true && !ec.contains(note), note.outerHTML);
  check('5.0 ...the box not hidden', !ec.classList.contains('aside-hidden') && !ec.classList.contains('aside-gone'), ec.className);

  // He is typing a draft when Claude asks.
  box.focus();
  p.editorInput.setValue('my draft');
  box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
  state(p, 'blocked', 'question');
  await f.to('question');
  advance(260); // past the 250 ms hold: aside, the keyboard kept through the grace
  check('5.1 aside in `over`: the box and its paste strip transparent and not taking the pointer at once (aside-hidden)',
    ec.classList.contains('aside') && ec.classList.contains('aside-hidden') && p.pasteStrip.classList.contains('aside-hidden'), ec.className);
  check('5.1 ...through D2\'s typing grace still focusable: not visibility-hidden, the keyboard still in the box',
    !ec.classList.contains('aside-gone') && doc.activeElement === box, { cls: ec.className, active: doc.activeElement?.className });
  check('5.1 ...the Okay? button hides with it (inside the hidden box)', Boolean(ec.querySelector('.okay-button')), null);
  check('5.2 "Draft kept" shown while the hidden box holds a draft', note.hidden === false && note.textContent === 'Draft kept', note.outerHTML);
  await frames();
  check('5.2 ...announced through the aria-live region', announced().includes('Draft kept'), announced());
  for (const el of doc.body.children) if (el.getAttribute('aria-live') === 'polite') el.textContent = '';
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
  await frames();
  check('5.2 ...once per aside (more typing doesn\'t announce it again)', !announced().includes('Draft kept'), announced());
  advance(1100); // the grace ends: the keyboard goes to the terminal
  check('5.3 after the grace: the keyboard on the terminal and the box visibility-hidden (aside-gone)',
    doc.activeElement === view(p).__termEl && ec.classList.contains('aside-gone') && p.pasteStrip.classList.contains('aside-gone'),
    { cls: ec.className, active: doc.activeElement?.className });
  check('5.3 ..."Draft kept" still shown, placement still over', note.hidden === false && placement(p) === 'over', placement(p));
  state(p, 'working'); // answered
  check('5.4 the aside ends: the box back where it was, shown, the note gone',
    placement(p) === 'over' && !ec.classList.contains('aside') && !ec.classList.contains('aside-hidden')
    && !ec.classList.contains('aside-gone') && !p.pasteStrip.classList.contains('aside-hidden') && note.hidden === true,
    { pl: placement(p), cls: ec.className });
  check('5.4 ...with the keyboard and the draft', doc.activeElement === box && p.editorInput.getValue() === 'my draft', doc.activeElement?.className);

  // No draft: hidden, no note.
  state(p, 'idle');
  await f.to('question-cancelled');
  check('5.5 (setup) over again', placement(p) === 'over', placement(p));
  p.editorInput.setValue('');
  state(p, 'working');
  state(p, 'blocked', 'permission');
  advance(260);
  check('5.5 aside with an empty box: hidden at once (no typing grace) and no "Draft kept"',
    ec.classList.contains('aside-hidden') && ec.classList.contains('aside-gone') && note.hidden === true,
    { cls: ec.className, note: note.hidden });
  state(p, 'working');
  check('5.5 ...back after', !ec.classList.contains('aside-hidden') && placement(p) === 'over', ec.className);

  // `under`: the v1.31 aside, dimmed in place; no hiding, no note.
  p.setComposeOverBar(false);
  p.editorInput.setValue('another draft');
  state(p, 'blocked', 'question');
  advance(260);
  check('5.6 aside in `under`: dimmed in place (aside), not hidden, no "Draft kept"',
    placement(p) === 'under' && ec.classList.contains('aside') && !ec.classList.contains('aside-hidden')
    && !ec.classList.contains('aside-gone') && note.hidden === true, { pl: placement(p), cls: ec.className });
  state(p, 'working');
  p.dispose();
}

// ── 6. aside_fixes (D10 as amended) ──
{
  const hereOf = (p) => p.element.querySelector('.compose-type-here');
  const shown = (el) => Boolean(el) && el.hidden === false;
  // 6a. A menu aside in `over`: "Type here" in the note's place, never "Draft kept".
  {
    const p = await newPane();
    const f = feeder(p, 'steps');
    await f.to('cleared2');
    await f.to('q-sent');
    state(p, 'working');
    check('6a (setup) over', placement(p) === 'over', placement(p));
    const ec = p.editorContainer;
    const note = p.element.querySelector('.compose-draft-note');
    // (A detached stand-in on a tree without the button, so every check below still reports.)
    const here = hereOf(p) ?? Object.assign(doc.createElement('button'), { hidden: true });
    check('6a.0 "Type here" exists in the pane, hidden, a button outside the box',
      Boolean(here) && here.hidden === true && here.tagName === 'BUTTON' && !ec.contains(here), here?.outerHTML);
    p.editorInput.setValue('/model');
    await sendFromBox(p, '/model');
    advance(20);
    check('6a.1 a menu aside in `over`: box hidden at once', ec.classList.contains('aside') && ec.classList.contains('aside-hidden'), ec.className);
    check('6a.1 ..."Type here" shown (with the sent line gone, no draft)', shown(here) && here.textContent === 'Type here', here?.outerHTML);
    check('6a.1 ...title and accessible name', here?.title === 'Claude may be showing a menu above · click to type in the box'
      && /Type here/.test(here?.getAttribute('aria-label') ?? ''), { t: here?.title, a: here?.getAttribute('aria-label') });
    check('6a.1 ..."Draft kept" not shown', note.hidden === true, note.outerHTML);
    p.editorInput.setValue('a draft');
    boxOf(p).dispatchEvent(new w.Event('input', { bubbles: true }));
    check('6a.2 with a draft too: "Type here" shown, "Draft kept" still not', shown(here) && note.hidden === true, { here: here?.hidden, note: note.hidden });
    check('6a.2 ...the keyboard on the terminal', doc.activeElement === view(p).__termEl, doc.activeElement?.className);
    // mousedown must not move the keyboard; the click runs D3's path.
    const down = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    here.dispatchEvent(down);
    check('6a.3 mousedown on it is prevented (no focus move before the click)', down.defaultPrevented === true && doc.activeElement === view(p).__termEl, doc.activeElement?.className);
    logs.length = 0;
    here.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await frames();
    check('6a.4 a click on it ends the aside: box shown again, in `over`, the draft kept',
      !ec.classList.contains('aside') && !ec.classList.contains('aside-hidden') && !ec.classList.contains('aside-gone')
      && placement(p) === 'over' && p.editorInput.getValue() === 'a draft', { cls: ec.className, pl: placement(p) });
    check('6a.4 ...the box has the keyboard', doc.activeElement === boxOf(p), doc.activeElement?.className);
    check('6a.4 ...logged as back with reason click, and the button gone',
      logs.some((l) => l.tag === '[COMPOSE] back' && l.data.reason === 'click') && here.hidden === true, logs.map((l) => l.tag));
    p.dispose();
  }
  // 6b. `under`: nothing changes (the dimmed box is clickable there).
  {
    const p = await newPane();
    p.setComposeOverBar(false);
    await sendFromBox(p, '/model');
    advance(20);
    check('6b menu aside in `under`: dimmed in place, no "Type here"',
      p.editorContainer.classList.contains('aside') && !p.editorContainer.classList.contains('aside-hidden') && !shown(hereOf(p)),
      { cls: p.editorContainer.className, here: hereOf(p)?.hidden });
    p.dispose();
  }
  // 6c. A `blocked` aside never shows "Type here"; a menu aside turned blocked loses it.
  {
    const p = await newPane();
    const f = feeder(p, 'steps');
    await f.to('cleared2');
    await f.to('q-sent');
    state(p, 'working');
    p.editorInput.setValue('draft');
    state(p, 'blocked', 'question');
    await f.to('question');
    advance(260);
    check('6c a blocked aside: "Draft kept" shown, "Type here" never',
      p.element.querySelector('.compose-draft-note').hidden === false && !shown(hereOf(p)), { note: p.element.querySelector('.compose-draft-note').hidden, here: hereOf(p)?.hidden });
    state(p, 'working');
    p.dispose();
  }
  {
    const p = await newPane();
    const f = feeder(p, 'steps');
    await f.to('cleared2');
    await f.to('q-sent');
    state(p, 'working');
    await sendFromBox(p, '/model');
    advance(20);
    check('6c (setup) menu aside shows "Type here"', shown(hereOf(p)), hereOf(p)?.hidden);
    p.editorInput.setValue('draft');
    state(p, 'blocked', 'permission');
    advance(260);
    check('6c the menu aside turned blocked: "Type here" gone, "Draft kept" shown',
      !shown(hereOf(p)) && p.element.querySelector('.compose-draft-note').hidden === false, { here: hereOf(p)?.hidden });
    state(p, 'working');
    p.dispose();
  }
  // 6d. Esc in the box during D2's grace hands off, but placement is frozen.
  for (const stillHandedOff of [true, false]) {
    const tag = stillHandedOff ? '6d' : '6e';
    const p = await newPane();
    const f = feeder(p, 'steps');
    await f.to('cleared2');
    await f.to('q-sent');
    state(p, 'working');
    const ec = p.editorContainer;
    const box = boxOf(p);
    box.focus();
    p.editorInput.setValue('my draft');
    box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    state(p, 'blocked', 'question');
    await f.to('question');
    advance(260); // aside; the keyboard still in the box (D2's grace)
    check(`${tag} (setup) over, hidden, in the grace`, placement(p) === 'over' && ec.classList.contains('aside-hidden') && doc.activeElement === box, ec.className);
    logs.length = 0; resizes.length = 0;
    box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await frames();
    check(`${tag}.1 Esc in the grace: the keyboard goes to the terminal (D2)`, doc.activeElement === view(p).__termEl, doc.activeElement?.className);
    check(`${tag}.1 ...placement unchanged: still over, no [COMPOSE] place, no refit`,
      placement(p) === 'over' && places().length === 0 && resizes.length === 0 && classesOk(p, 'over'), { pl: placement(p), places: places(), resizes });
    check(`${tag}.1 ...the box stays hidden, "Draft kept" shown`,
      ec.classList.contains('aside-hidden') && p.element.querySelector('.compose-draft-note').hidden === false, ec.className);
    advance(3000);
    await frames();
    check(`${tag}.2 through the rest of the aside: still over, still nothing logged`, placement(p) === 'over' && places().length === 0, places());
    let ext = null;
    if (stillHandedOff) {
      // The keyboard is somewhere else when the aside ends, so the hand-off stands.
      ext = doc.createElement('input');
      doc.body.appendChild(ext);
      ext.focus();
    }
    state(p, 'working'); // answered: the aside ends
    await frames();
    const pl = places();
    if (stillHandedOff) {
      check(`${tag}.3 the aside ends still handed off: under, reason handoff`, placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'handoff', pl);
      check(`${tag}.3 ...and no other place line before it`, pl.every((d) => d.reason === 'handoff'), pl);
      ext.remove();
    } else {
      check(`${tag}.3 the aside ends with the keyboard back in the box (no longer handed off): no handoff placement`,
        !pl.some((d) => d.reason === 'handoff') && doc.activeElement === box, { pl, active: doc.activeElement?.className });
    }
    p.dispose();
  }
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
