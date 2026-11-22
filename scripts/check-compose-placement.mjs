// Headless check of where the compose box sits (docs/compose-box.md D9, D10's
// freeze, D12's setting): a REAL Pane in jsdom whose terminal view is a stub
// holding a REAL @xterm/xterm Terminal (never opened, so no layout: geometry
// is the hidden-Electron check's job), fed Claude Code v2.1.321's recorded
// screens (scripts/fixtures/claude-bar-screens.json). Asserts the placement
// (`data-compose-placement`, the placement-* classes, `[COMPOSE] place`
// lines with their reasons), that the terminal is refitted only between
// `under` and the overlays, the 400 ms wait before `under` (lost or holding
// text) and that readings within 1.5 s of the pane's own typing (a send from
// the box) never count toward it (D9 as amended), the freeze
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
  // D14 (section 7): an image on the clipboard; Pane sends Ctrl+V to Claude.
  clipboard: stubWith({ readImage: () => Promise.resolve({ dataUrl: 'data:image/png;base64,AAAA', width: 800, height: 600 }) }),
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

/** A second passes (the once-a-second rule, D9) and a harmless write makes a
 *  reading, so the last empty-bar match is fresh when the next step starts. */
const settleSwitch = async (p) => {
  advance(1000);
  await write(term(p), '\x1b[0m');
  await frames();
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
  await settleSwitch(p); // D9: a reading changes under <-> over at most once a second
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
  advance(1000); // D9: a reading changes under <-> over at most once a second
  await f.to('cleared');
  pl = places();
  check('1.3 cleared: over again, reason found', placement(p) === 'over' && pl.length === 1 && pl[0].reason === 'found', pl);

  logs.length = 0;
  await settleSwitch(p); // D9: a reading changes under <-> over at most once a second
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
  advance(1000); // D9: a reading changes under <-> over at most once a second
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
  advance(1000); // D9: a reading changes under <-> over at most once a second
  await f.to('question-cancelled');
  pl = places();
  check('1.9 question cancelled, bar back: over, reason found', placement(p) === 'over' && pl.length === 1 && pl[0].reason === 'found', pl);

  logs.length = 0;
  advance(1000); // D9: a reading changes under <-> over at most once a second
  await f.to('history');
  advance(500);
  pl = places();
  check('1.12 history recall (labelled rule): under, reason lost', placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'lost', pl);
  await f.to('slash');
  check('1.13 `/` in Claude\'s bar: under', placement(p) === 'under', places());
  logs.length = 0;
  advance(1000); // D9: a reading changes under <-> over at most once a second
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
  check('5.1 ...no Okay? button or row anywhere in the pane (removed 2026-11-20, S58)', p.element.querySelector('.okay-button, .okay-row') === null, null);
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

// ── 7. D14: a pasted image's [Image #N] in Claude's bar keeps the box over it ──
{
  const p = await newPane();
  const f = feeder(p, 'steps');
  await f.to('idle');
  check('7 (setup) over', placement(p) === 'over', placement(p));
  logs.length = 0; resizes.length = 0; writes.length = 0;
  await p.pasteImage('compose'); // from the box: Ctrl+V to Claude, a thumbnail in the box
  check('7 (setup) Ctrl+V written to Claude', writes.includes('\x16'), writes);
  // Claude echoes the placeholder into its bar, the caret after it, and parks
  // the cursor on the bar's row as it does.
  const b = term(p).buffer.active;
  const y = b.cursorY + 1; // 1-based screen row of the bar
  await write(term(p), `${'\x1b['}${y};3H[Image #1] ${'\x1b[7m'} ${'\x1b[0m\x1b[K'}${'\x1b['}${y};14H`);
  await frames();
  const line = b.getLine(b.baseY + b.cursorY).translateToString(true).replace(/\u00a0/g, ' ');
  check('7 (setup) Claude\'s bar reads `❯ [Image #1]`, the cursor on it', line.trimEnd() === '❯ [Image #1]', line);
  advance(450);
  await frames();
  advance(450);
  check('7.1 an image paste with `[Image #1]` echoed in Claude\'s bar: still over 900 ms on, no `[COMPOSE] place`, no refit',
    placement(p) === 'over' && places().length === 0 && resizes.length === 0, { pl: places(), resizes });
  // A second image, then text typed after them: that is text, so under after the wait.
  await write(term(p), `${'\x1b['}${y};3H[Image #1] [Image #2] ${'\x1b[7m'} ${'\x1b[0m\x1b[K'}${'\x1b['}${y};25H`);
  await frames();
  advance(900);
  check('7.2 two placeholders: still over', placement(p) === 'over' && places().length === 0, places());
  await write(term(p), `${'\x1b['}${y};3H[Image #1] [Image #2] see these${'\x1b[7m'} ${'\x1b[0m\x1b[K'}${'\x1b['}${y};34H`);
  await frames();
  advance(450);
  const pl = places();
  check('7.3 ...then text typed after them: under after the 400 ms wait, reason holds-text',
    placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'holds-text', pl);
  p.dispose();
}

// ── 8. fixes after review: no loop (D9), a draft refits once, the overlay's colour ──
{
  const RULE = '─'.repeat(fixture.cols);
  const FOUND = `\x1b[2J\x1b[1;1H\r\n${RULE}\r\n❯ \r\n${RULE}\x1b[3;3H`; // an empty bar, the cursor on it
  const LOST = '\x1b[2J\x1b[1;1Hsome output, no bar'; // the cursor on a plain row
  const feed = async (p, data) => { await write(term(p), data); await frames(); };

  // 8.1 A bar missing right after the placement's own refit: Claude's redraw
  // after the resize. Readings in the 500 ms after it don't count toward the 400 ms wait.
  {
    const p = await newPane();
    await feed(p, FOUND);
    check('8.1 (setup) bar found: over, refitted once', placement(p) === 'over' && resizes.length === 1, { pl: places(), resizes });
    logs.length = 0;
    await feed(p, LOST);
    advance(450);
    check('8.1 under->over, then the bar missing for 450 ms right after the refit: no flip back',
      placement(p) === 'over' && places().length === 0, places());
    advance(500); // 950 ms after the refit: the wait (from 500 ms on) is up, but a change waits for its second
    check('8.1 ...and at 950 ms still over: a change due sooner waits for the second to pass',
      placement(p) === 'over' && places().length === 0, places());
    advance(100);
    const pl = places();
    check('8.1 ...decided again at 1 s: the bar is still missing, so under, reason lost',
      placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'lost', pl);
    p.dispose();
  }

  // 8.2 Under -> over also waits: found again 100 ms after going under.
  {
    const p = await newPane();
    await feed(p, FOUND);
    await settleSwitch(p); // a second on, the last match fresh
    await feed(p, LOST);
    advance(410);
    check('8.2 (setup) over -> under after the refit window and the second', placement(p) === 'under', places());
    logs.length = 0;
    await feed(p, FOUND);
    check('8.2 the bar found again 0 ms after going under: still under (a change waits for the second)',
      placement(p) === 'under' && places().length === 0, places());
    advance(960); // 970 ms after going under
    check('8.2 ...still under at 970 ms', placement(p) === 'under', places());
    advance(40);
    const pl = places();
    check('8.2 ...over at 1 s from a fresh reading, no further write needed, reason found',
      placement(p) === 'over' && pl.length === 1 && pl[0].reason === 'found', pl);
    p.dispose();
  }

  // 8.3 Five lost/found cycles in 2 s: at most two changes.
  {
    const p = await newPane();
    await feed(p, FOUND);
    logs.length = 0;
    for (let i = 0; i < 5; i++) {
      await feed(p, LOST);
      advance(410);
      await feed(p, FOUND);
    }
    check('8.3 five forced lost/found cycles in 2 s: at most two changes', places().length <= 2, places());
    p.dispose();
  }

  // 8.4 Going under with a long draft: the box's height cap is applied before
  // the refit, so the terminal refits once (the resize observer would refit
  // again for a box that changed height after it).
  {
    const p = await newPane();
    await feed(p, FOUND);
    const order = [];
    const refresh = p.editorInput.refreshSize.bind(p.editorInput);
    p.editorInput.refreshSize = () => { order.push('refresh'); refresh(); };
    const fit = view(p).fit;
    view(p).fit = () => { order.push('fit'); fit(); };
    p.editorInput.setValue(Array.from({ length: 12 }, (_, i) => `draft line ${i + 1}`).join('\n'));
    order.length = 0;
    p.setComposeOverBar(false);
    check('8.4 over -> under with a long draft: refreshSize before the one refit',
      placement(p) === 'under' && order.filter((x) => x === 'fit').length === 1 && order.indexOf('refresh') !== -1
      && order.indexOf('refresh') < order.indexOf('fit'), order);
    p.dispose();
  }

  // 8.5 The overlay's colour follows a theme or OS light/dark change at once.
  {
    const p = await newPane();
    await feed(p, FOUND);
    const bg = () => p.editorContainer.style.getPropertyValue('--term-bg');
    p.terminalContainer.style.setProperty('--term-bg', '#123456');
    view(p).__emit('onFrameColor');
    check('8.5 the terminal frame colour changes while over: the box has the new colour at once', bg() === '#123456', bg());
    p.terminalContainer.style.setProperty('--term-bg', '#fafafa');
    view(p).__emit('onFrameColor');
    check('8.5 ...and again', bg() === '#fafafa', bg());
    p.setComposeOverBar(false);
    p.terminalContainer.style.setProperty('--term-bg', '#000000');
    view(p).__emit('onFrameColor');
    check('8.5 under: the box takes no overlay colour', bg() === '', bg());
    p.dispose();
  }

  // 8.6 D8: the 400 ms count from the FIRST miss of a run, not from the last
  // match. A still screen takes no readings, so the last match can be old.
  const MID1 = `\x1b[2J\x1b[1;1H\r\n${RULE}\r\n`; // a redraw chunk that ends mid-redraw
  const MID2 = `❯ \r\n${RULE}\x1b[3;3H`; // the rest of it
  for (const gapMs of [410, 5000]) {
    const p = await newPane();
    await feed(p, FOUND);
    await settleSwitch(p);
    logs.length = 0; resizes.length = 0;
    advance(gapMs); // a still screen: no writes
    await feed(p, MID1); // the first miss
    check(`8.6 still ${gapMs} ms, then a mid-redraw miss: not lost at the first miss`,
      placement(p) === 'over' && places().length === 0, places());
    advance(30);
    await feed(p, MID2); // the redraw completes: found and empty again
    advance(1200);
    check(`8.6 ...the redraw done 30 ms later: still over, no change, no refit`,
      placement(p) === 'over' && places().length === 0 && resizes.length === 0, { pl: places(), resizes });
    p.dispose();
  }

  // 8.7 A pane resized after 5 s idle: xterm reflows before Claude redraws.
  {
    const p = await newPane();
    await feed(p, FOUND);
    await settleSwitch(p);
    logs.length = 0; resizes.length = 0;
    advance(5000);
    term(p).resize(90, 30);
    await frames();
    check('8.7 resized after 5 s idle (the bar not yet redrawn): not lost at once',
      placement(p) === 'over' && places().length === 0, places());
    p.dispose();
  }

  // 8.8 A genuine loss after a still screen still goes under, once the miss
  // has lasted 400 ms.
  {
    const p = await newPane();
    await feed(p, FOUND);
    await settleSwitch(p);
    advance(5000);
    logs.length = 0;
    await feed(p, LOST);
    advance(390);
    check('8.8 5 s still, then the bar gone: still over at 390 ms of misses', placement(p) === 'over' && places().length === 0, places());
    advance(20);
    const pl = places();
    check('8.8 ...under at 410 ms of misses, reason lost',
      placement(p) === 'under' && pl.length === 1 && pl[0].reason === 'lost', pl);
    p.dispose();
  }

  // 8.9 His own moves never wait for the once-a-second rule: the box closed
  // and reopened (or the setting off and on) 0.2 s after a reading put it under.
  for (const how of ['reopen', 'setting']) {
    const p = await newPane();
    await feed(p, FOUND);
    await settleSwitch(p);
    await feed(p, LOST);
    advance(410);
    check(`8.9 (${how} setup) a reading put the box under`, placement(p) === 'under', places());
    advance(200);
    logs.length = 0;
    if (how === 'reopen') {
      p.setComposeFirst(false, null);
      p.setComposeFirst(true, null);
    } else {
      p.setComposeOverBar(false);
      p.setComposeOverBar(true);
    }
    await feed(p, FOUND);
    const last = places().filter((d) => d.placement === 'over');
    check(`8.9 ${how} 0.2 s after: over at once, reason found`,
      placement(p) === 'over' && last.length === 1 && last[0].reason === 'found', places());
    p.dispose();
  }
}

// ── 9. D18: Esc soon after a send. Claude Code puts the message back in its
//       own bar; the box takes it back and empties Claude's bar, so the next
//       Enter sends only what the box shows. Real Claude Code v2.1.321 screens
//       (scripts/fixtures/esc-restore.json) at the timing of the five cases in
//       main.log (20-22 Nov 2026). ──
{
  const er = JSON.parse(readFileSync(join(here, 'scripts/fixtures/esc-restore.json'), 'utf8'));
  const T = er.texts;
  const erFeeder = (p) => {
    let i = 0;
    return {
      async to(mark) {
        while (i < er.recording.length) {
          const e = er.recording[i++];
          if (e.mark === mark) break;
          if (e.b) await write(term(p), Buffer.from(e.b, 'base64'));
        }
        await frames();
      },
    };
  };
  const ofTag = (tag) => logs.filter((l) => l.tag === `[COMPOSE] ${tag}`).map((l) => l.data);
  const escInBox = async (p) => {
    const box = boxOf(p);
    box.focus();
    box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await frames();
  };
  const barRow = (p) => {
    const b = term(p).buffer.active;
    return b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '';
  };
  const strings = () => writes.filter((d) => typeof d === 'string');
  const noteShown = (p) => {
    const n = p.editorContainer.querySelector('.compose-bar-text-note');
    return n !== null && !n.hidden;
  };

  /** One scene: send `text` from the box at the `<scene>-send` mark, Claude
   *  reports working at `at.working`, Esc in the box at `at.esc`, Claude's
   *  restore screen, then `idle` (or `endState`) at `at.idle`. */
  const scene = async (name, text, at, { endState = 'idle', before } = {}) => {
    const p = await newPane();
    const f = erFeeder(p);
    await f.to(`${name}-send`);
    if (before) await before(p);
    await sendFromBox(p, text);
    advance(text.includes('\n') ? 60 : 10); // the Enter
    advance(at.working - (text.includes('\n') ? 60 : 10));
    state(p, 'working');
    await f.to(`${name}-esc`);
    advance(at.esc - at.working);
    writes.length = 0; logs.length = 0;
    await escInBox(p);
    const afterEsc = strings().slice();
    await f.to(`${name}-restored`);
    const beforeIdle = strings().slice();
    advance(at.idle - at.esc);
    if (endState === 'blocked') state(p, 'blocked', 'permission');
    else state(p, endState);
    await frames();
    return { p, f, afterEsc, beforeIdle };
  };

  // 9.1 The five cases, each with the single-line recording.
  for (const [n, c] of er.cases.entries()) {
    const tag = `9.1.${n + 1} (${c.at.slice(0, 16)}, ${c.pane})`;
    const { p, f, afterEsc, beforeIdle } = await scene('single', T.single, c);
    check(`${tag} the Esc goes to Claude, alone`, afterEsc.length === 1 && afterEsc[0] === '\x1b', afterEsc);
    check(`${tag} ...nothing typed while Claude still works (the message already back)`,
      beforeIdle.length === 1, beforeIdle);
    check(`${tag} after idle the box holds the sent message, caret at its end`,
      p.editorInput.getValue() === T.single && boxOf(p).selectionStart === T.single.length, p.editorInput.getValue());
    check(`${tag} ...Claude's bar emptied with Ctrl+C, once`,
      strings().slice(1).join('|') === '\x03', strings());
    const r = ofTag('restored'); const cl = ofTag('bar cleared');
    check(`${tag} ...logged restored {chars, source sent} and bar cleared {keys ctrl-c}, no text`,
      r.length === 1 && r[0].source === 'sent' && r[0].chars === T.single.length && r[0].pane === p.id
      && cl.length === 1 && cl[0].keys === 'ctrl-c' && !JSON.stringify(logs).includes('Count from'), { r, cl });
    // Claude's answer to the Ctrl+C, only if Patton sent one: else its bar
    // keeps the message (the recording's own Ctrl+C was not Patton's).
    if (strings().includes('\x03')) await f.to('single-cleared');
    const bar = barRow(p).replace(/^❯/, '').trim();
    check(`${tag} ...Claude's bar reads empty`, bar === '', barRow(p));
    advance(c.nextSend - c.idle);
    writes.length = 0;
    const edited = `${p.editorInput.getValue()} And one more thing.`;
    await sendFromBox(p, edited);
    advance(10);
    // What Claude receives: whatever its bar held, then what the box typed.
    const typed = strings().filter((d) => d !== '\r');
    check(`${tag} the next send: Claude receives exactly the box's text, the sent message and his edit`,
      typed.length === 1 && bar + typed[0] === edited && edited.startsWith(T.single), { bar, typed, edited });
    p.dispose();
  }

  // 9.2 A multi-line draft (sent as a bracketed paste) comes back whole.
  {
    const at = { working: 300, esc: 1500, idle: 1600 };
    // The terminal is never opened, so xterm's own paste can't run: the
    // bracketed paste is recorded as written instead.
    const { p } = await scene('multi', T.multi, at, { before: (q) => { term(q).paste = (d) => writes.push(`paste:${d}`); } });
    check('9.2 multi-line: the box holds the sent draft, line breaks and all', p.editorInput.getValue() === T.multi, p.editorInput.getValue());
    check('9.2 ...Claude\'s three rows emptied with one Ctrl+C', strings().slice(1).join('|') === '\x03', strings());
    p.dispose();
  }

  // 9.3 Text he typed in Claude's own bar, then a send from the box: the bar
  //     holds both on one row, read whole from the screen, not lost.
  {
    const at = { working: 300, esc: 1500, idle: 1600 };
    // The recording typed his part into Claude's bar before `foreign-send`.
    const { p } = await scene('foreign', T.foreign, at);
    check('9.3 foreign one row: the box holds all of Claude\'s bar, his typed part first',
      p.editorInput.getValue() === T.foreignTyped + T.foreign, p.editorInput.getValue());
    const r = ofTag('restored');
    check('9.3 ...source screen, bar emptied with Ctrl+C',
      r.length === 1 && r[0].source === 'screen' && strings().slice(1).join('|') === '\x03', { r, w: strings() });
    p.dispose();
  }

  // 9.4 Two lines typed in Claude's bar: not readable whole, so nothing typed,
  //     the bar keeps them and the box says they go first.
  {
    const at = { working: 300, esc: 1500, idle: 1600 };
    const { p, f } = await scene('foreign2', T.foreign2, at);
    check('9.4 foreign two rows: nothing typed after the Esc, the box empty', strings().length === 1 && p.editorInput.getValue() === '', strings());
    const sk = ofTag('restore skipped');
    check('9.4 ...restore skipped {reason not-readable}', sk.length === 1 && sk[0].reason === 'not-readable', sk);
    check('9.4 ...the note "Claude\'s bar has text: it goes first" shows in the box', noteShown(p)
      && p.editorContainer.querySelector('.compose-bar-text-note').textContent === "Claude's bar has text: it goes first");
    await f.to('foreign2-cleared'); // the bar emptied (here by the recording's own Ctrl+C)
    check('9.4 ...the note goes once Claude\'s bar reads empty', !noteShown(p));
    p.dispose();
  }

  // 9.5 Claude asks (7501 blocked) when the Esc's turn ends: nothing typed.
  {
    const c = er.cases[4];
    const { p } = await scene('single', T.single, c, { endState: 'blocked' });
    check('9.5 blocked: nothing typed after the Esc, the box empty', strings().length === 1 && p.editorInput.getValue() === '', strings());
    const sk = ofTag('restore skipped');
    check('9.5 ...restore skipped {reason blocked}', sk.length === 1 && sk[0].reason === 'blocked', sk);
    advance(5000);
    check('9.5 ...and nothing later either', strings().length === 1, strings());
    p.dispose();
  }

  // ── Synthesized bars (the same frame Claude draws: a rule, `❯ ` and
  //    two-space rows, a rule, the footer, the cursor at the text's end) for
  //    the cases the recording has no screen for. ──
  const drawBar = async (p, rowsIn) => {
    const t = term(p);
    const rule = '─'.repeat(t.cols);
    const body = rowsIn.map((r, i) => (i === 0 ? `❯ ${r}` : `  ${r}`)).join('\r\n');
    const col = 3 + [...rowsIn[rowsIn.length - 1]].length;
    await write(t, `\x1b[2J\x1b[H${rule}\r\n${body}\r\n${rule}\r\n  ? for shortcuts\x1b[${1 + rowsIn.length};${col}H`);
    await frames();
  };
  const escInTerminal = async (p) => { view(p).__emit('onTerminalData', '\x1b'); await frames(); };
  const typeInTerminal = async (p, d) => { view(p).__emit('onTerminalData', d); await frames(); };
  /** A pane over an empty bar, `text` sent from the box, Claude `working`
   *  `workingAt` ms later (null: never reported), then `wait` ms. */
  const sent = async (text, { workingAt = 100, wait = 1400, before } = {}) => {
    const p = await newPane();
    await drawBar(p, ['']);
    if (before) await before(p);
    await sendFromBox(p, text);
    advance(10);
    if (workingAt !== null) { advance(workingAt - 10); state(p, 'working'); advance(wait); } else advance(wait);
    writes.length = 0; logs.length = 0;
    return p;
  };
  const S1 = 'Stop and say hi.';

  // 9.6 An Esc after the send's turn has ended (Claude went idle, another
  //     turn runs): not the send's turn, no watch.
  {
    const p = await sent(S1);
    state(p, 'idle');
    advance(1000);
    state(p, 'working'); // a turn Patton didn't start (a task's notification)
    advance(500);
    writes.length = 0; logs.length = 0;
    await escInBox(p);
    await drawBar(p, [S1]);
    state(p, 'idle');
    await frames();
    check('9.6 Esc after the send\'s turn ended: nothing taken back, nothing typed but the Esc',
      p.editorInput.getValue() === '' && strings().join('|') === '\x1b' && ofTag('restored').length === 0, strings());
    p.dispose();
  }
  // 9.6b A send that never started a turn (no `working`), Esc 5 s later: no watch.
  {
    const p = await sent(S1, { workingAt: null, wait: 5000 });
    await escInBox(p);
    await drawBar(p, [S1]);
    state(p, 'idle');
    await frames();
    check('9.6b a send that started no turn, Esc 5 s on: nothing typed but the Esc',
      p.editorInput.getValue() === '' && strings().join('|') === '\x1b', strings());
    p.dispose();
  }

  // 9.7 Long thinking (review finding 2): Esc 15 s after the send while the
  //     turn still works; Claude goes idle before it redraws the bar.
  {
    const p = await sent(S1, { wait: 15_000 });
    await escInBox(p);
    state(p, 'idle');
    await frames();
    check('9.7 Esc 15 s into the turn: nothing typed before the bar is back', strings().join('|') === '\x1b', strings());
    await drawBar(p, [S1]);
    check('9.7 ...idle before the redraw, then the bar: the box holds the message, Ctrl+C once',
      p.editorInput.getValue() === S1 && strings().join('|') === '\x1b|\x03', strings());
    const wl = ofTag('restore watch');
    check('9.7 ...logged restore watch {from box, started}, no text', wl.length === 1 && wl[0].from === 'box' && wl[0].started === true
      && !JSON.stringify(logs).includes(S1), wl);
    p.dispose();
  }
  // 9.7b Esc before Claude's first `working` report (within 2 s of the send).
  {
    const p = await sent(S1, { workingAt: null, wait: 500 });
    await escInBox(p);
    await drawBar(p, [S1]);
    state(p, 'idle');
    await frames();
    check('9.7b Esc 0.5 s after the send, before any report: taken back, Ctrl+C', p.editorInput.getValue() === S1
      && strings().join('|') === '\x1b|\x03', strings());
    p.dispose();
  }

  // 9.8 Esc typed in the terminal (review finding 2), with a draft already
  //     in the box: the message goes first, a line break, then the draft.
  {
    const p = await sent(S1, { wait: 3000 });
    p.editorInput.setValue('my draft');
    await escInTerminal(p);
    await drawBar(p, [S1]);
    state(p, 'idle');
    await frames();
    check('9.8 terminal Esc, draft in the box: the box holds message, break, draft', p.editorInput.getValue() === `${S1}\nmy draft`,
      p.editorInput.getValue());
    check('9.8 ...Claude\'s bar emptied with Ctrl+C once', strings().join('|') === '\x1b|\x03', strings());
    check('9.8 ...restore watch {from terminal}', ofTag('restore watch')[0]?.from === 'terminal', ofTag('restore watch'));
    p.dispose();
  }
  // 9.8b A key he types in the terminal during the watch is his own edit:
  //      the watch ends, nothing typed; a focus report doesn't end it.
  {
    let p = await sent(S1);
    await escInTerminal(p);
    await typeInTerminal(p, 'x');
    await drawBar(p, [`${S1}x`]);
    state(p, 'idle');
    await frames();
    check('9.8b a key typed in the terminal after the Esc: nothing typed by Patton, the box empty',
      strings().join('|') === '\x1b|x' && p.editorInput.getValue() === '', strings());
    check('9.8b ...restore skipped {reason typed}', ofTag('restore skipped')[0]?.reason === 'typed', ofTag('restore skipped'));
    p.dispose();
    p = await sent(S1);
    await escInTerminal(p);
    await typeInTerminal(p, '\x1b[I');
    await typeInTerminal(p, '\x1b[12;40R');
    await drawBar(p, [S1]);
    state(p, 'idle');
    await frames();
    check('9.8b ...a focus report and a cursor report don\'t end it: taken back', p.editorInput.getValue() === S1
      && strings().slice(-1)[0] === '\x03', strings());
    p.dispose();
  }

  // 9.9 Images in the sent message: Backspace per character, the images stay
  //     in Claude's bar and their thumbnails come back to the box.
  {
    const text = 'look at this';
    const p = await sent(text, { before: async (q) => { await q.pasteImage('compose'); } });
    check('9.9 (setup) the send cleared the thumbnail', p.pasteChips.length === 0, p.pasteChips.length);
    await escInBox(p);
    await drawBar(p, [`[Image #1] ${text}`]);
    state(p, 'idle');
    await frames();
    check('9.9 images: the box holds the text, its thumbnail back', p.editorInput.getValue() === text && p.pasteChips.length === 1
      && p.pasteChips[0].label === '800×600', { v: p.editorInput.getValue(), chips: p.pasteChips.length });
    check('9.9 ...Claude\'s bar: one Backspace per character, no Ctrl+C', strings().join('|') === `\x1b|${'\x7f'.repeat(text.length)}`,
      strings().map((d) => d.length));
    check('9.9 ...bar cleared {keys backspace×12}', ofTag('bar cleared')[0]?.keys === `backspace×${text.length}`, ofTag('bar cleared'));
    p.dispose();
  }

  // 9.10 A second send between the Esc and Claude's restore ends the watch.
  {
    const p = await sent(S1);
    await escInBox(p);
    await sendFromBox(p, 'second message');
    advance(10);
    writes.length = 0;
    await drawBar(p, [S1]);
    state(p, 'idle');
    await frames();
    check('9.10 a second send after the Esc: no Ctrl+C or Backspace, nothing restored',
      !strings().some((d) => d.includes('\x03') || d.includes('\x7f')) && ofTag('restored').length === 0 && p.editorInput.getValue() === '',
      { w: strings(), v: p.editorInput.getValue() });
    p.dispose();
  }

  // 9.11 The 3 s watch: Claude still working when it ends, or no text back.
  {
    let p = await sent(S1);
    await escInBox(p);
    await drawBar(p, [S1]);
    advance(3000);
    check('9.11 still working 3 s after the Esc: restore skipped {reason still-working}',
      ofTag('restore skipped')[0]?.reason === 'still-working', ofTag('restore skipped'));
    state(p, 'idle');
    await frames();
    check('9.11 ...idle after that: nothing typed, the box empty', strings().join('|') === '\x1b' && p.editorInput.getValue() === '', strings());
    p.dispose();
    p = await sent(S1);
    await escInBox(p);
    state(p, 'idle');
    await frames();
    advance(3000);
    check('9.11 idle, the bar empty for 3 s: restore skipped {reason no-text}', ofTag('restore skipped')[0]?.reason === 'no-text',
      ofTag('restore skipped'));
    await drawBar(p, [S1]);
    check('9.11 ...the bar holding it later: nothing typed', strings().join('|') === '\x1b' && p.editorInput.getValue() === '', strings());
    p.dispose();
  }

  // 9.12 Review finding 1: he pasted 40 lines into Claude's own bar (Claude
  //      shows `[Pasted text #1 +39 lines]`), sent "hello" from the box after
  //      it, Esc. Ctrl+C would wipe his paste: nothing typed, the note shows.
  {
    const p = await sent('hello');
    await escInBox(p);
    await drawBar(p, ['[Pasted text #1 +39 lines] hello']);
    state(p, 'idle');
    await frames();
    check('9.12 his own paste before the sent text: no Ctrl+C, nothing typed but the Esc', strings().join('|') === '\x1b', strings());
    check('9.12 ...the box empty, restore skipped {reason not-readable}, the note shows',
      p.editorInput.getValue() === '' && ofTag('restore skipped')[0]?.reason === 'not-readable' && noteShown(p),
      { v: p.editorInput.getValue(), sk: ofTag('restore skipped') });
    p.dispose();
  }

  // 9.13 A background subagent keeps Claude's 7501 root `working` (probed in
  //      2.1.321, scratch recordings 22 Nov: an Esc on a turn sent while the
  //      subagent ran put the message back in the bar 75 ms later, the root
  //      never left working, the subagent ran on, and Ctrl+C only emptied the
  //      bar). Until this, the watch waited for a non-working root and ended
  //      `still-working`, leaving the message in Claude's bar.
  {
    const agentRuns = (p) => report(p, 'state=working:id=agent1');
    // a. No feed (no ring): the send's turn over the working subagent.
    let p = await sent(S1, { before: (q) => { state(q, 'working'); agentRuns(q); } });
    await escInBox(p);
    await drawBar(p, [S1]);
    check('9.13a subagent running, root stays working: the box takes the message back, Claude\'s bar emptied with Ctrl+C',
      p.editorInput.getValue() === S1 && strings().join('|') === '\x1b|\x03', { v: p.editorInput.getValue(), s: strings() });
    check('9.13a ...logged restored {source sent, rootWorking true}',
      ofTag('restored')[0]?.source === 'sent' && ofTag('restored')[0]?.rootWorking === true, ofTag('restored'));
    p.dispose();
    // b. The turn-end ring showed (a Stop over the working root), then the send.
    p = await newPane();
    await drawBar(p, ['']);
    state(p, 'working'); agentRuns(p);
    p.applyFeedEvent(p.ptyId, { type: 'attached', sessionId: 's1', how: 'hook' });
    p.handleHookStop(1, 0);
    check('9.13b setup: the ring showed over the working root', logs.some((l) => l.tag === '[DOT] Turn ended over a working root' && l.data.feed === true),
      logs.filter((l) => l.tag.startsWith('[DOT]')).map((l) => l.tag));
    // c. Esc while only the subagent runs (the turn ended): Claude restores
    //    nothing (probed); no watch, nothing typed.
    writes.length = 0; logs.length = 0;
    await escInBox(p);
    await drawBar(p, ['']);
    advance(3000);
    check('9.13c Esc while only the subagent runs: no watch, nothing typed but the Esc',
      ofTag('restore watch').length === 0 && strings().join('|') === '\x1b', { w: ofTag('restore watch'), s: strings() });
    // b, continued: a send after the ring, Esc 1.5 s later, the message back.
    await sendFromBox(p, S1);
    advance(1500);
    writes.length = 0; logs.length = 0;
    await escInBox(p);
    check('9.13b a send after the ring arms the watch', ofTag('restore watch')[0]?.started === true, ofTag('restore watch'));
    await drawBar(p, [S1]);
    check('9.13b ...the message back: taken into the box, Ctrl+C', p.editorInput.getValue() === S1 && strings().join('|') === '\x1b|\x03',
      { v: p.editorInput.getValue(), s: strings() });
    p.dispose();
    // d. His own text before the send: the row ends with what Patton sent.
    p = await sent(S1, { before: async (q) => { state(q, 'working'); agentRuns(q); await drawBar(q, ['Note: ']); } });
    await escInBox(p);
    await drawBar(p, [`Note: ${S1}`]);
    check('9.13d his text then the send, over the subagent: the whole row into the box, Ctrl+C',
      p.editorInput.getValue() === `Note: ${S1}` && strings().join('|') === '\x1b|\x03', { v: p.editorInput.getValue(), s: strings() });
    p.dispose();
    // e. Text that isn't the sent message: never Ctrl+C while the root works;
    //    at 3 s the watch ends still-working and the note shows.
    p = await sent(S1, { before: (q) => { state(q, 'working'); agentRuns(q); } });
    await escInBox(p);
    await drawBar(p, ['something else']);
    advance(3000);
    check('9.13e other text over the subagent: nothing typed but the Esc, the box empty',
      strings().join('|') === '\x1b' && p.editorInput.getValue() === '', strings());
    check('9.13e ...restore skipped {reason still-working}, the note shows',
      ofTag('restore skipped')[0]?.reason === 'still-working' && noteShown(p), { sk: ofTag('restore skipped'), note: noteShown(p) });
    p.dispose();
    // f. The subagent asks (its 7501 record blocked): nothing typed.
    p = await sent(S1, { before: (q) => { state(q, 'working'); agentRuns(q); } });
    await escInBox(p);
    report(p, 'state=blocked:id=agent1:kind=permission');
    await drawBar(p, [S1]);
    check('9.13f the subagent asks: nothing typed but the Esc, restore skipped {reason blocked}',
      strings().join('|') === '\x1b' && p.editorInput.getValue() === '' && ofTag('restore skipped')[0]?.reason === 'blocked',
      { s: strings(), sk: ofTag('restore skipped') });
    p.dispose();
  }
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
