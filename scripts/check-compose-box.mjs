// Headless check of the compose box (design D2-D4 and D1's setting, D7 in
// docs/compose-box.md): the box under a Claude Code pane steps aside while
// Claude asks (a 7501 `blocked` held 250 ms, root or background task), after a
// `/` line the user sends from it, and comes back when that ends; a click in
// the terminal keeps the box's keyboard on a pane with 7501 reports; the
// setting `composeBox` (the old `composeFirst` is no longer read).
//
// Drives a REAL Pane (constructed and init()ed) in jsdom with the REAL
// EditorInput (the box, its textarea, Enter and the copy keys), the terminal
// view, search, history and paste dialog stubbed. The fake terminal's
// focus() moves focus to a real element, so "the keyboard goes to the
// terminal" is proven by document.activeElement. Time is a fake clock
// (setTimeout, setInterval and Date.now), so a 7.7 million ms episode takes no
// time. The replay half feeds scripts/fixtures/question-episodes.json: the 25
// real question episodes from Patton's main.log (10-20 Nov 2026), as 7501
// state reports at their real offsets.
//
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-compose-box.mjs
// Against another source tree (e.g. a worktree of main, to prove the checks
// fail there): COMPOSE_SRC_ROOT=<that worktree> node scripts/check-compose-box.mjs
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
const fixture = JSON.parse(readFileSync(join(here, 'scripts/fixtures/question-episodes.json'), 'utf8'));

// The terminal view is a stub whose focus() moves focus to a real element in
// the pane's terminal container; EditorInput is NOT stubbed.
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
        __focusCalls: 0,
        focus: () => { own.__focusCalls++; termEl.focus(); },
        terminal: new Proxy({
          modes: { bracketedPasteMode: false }, options: {},
          getSelection: () => globalThis.__selection ?? '',
        }, { get: (t, k) => (k in t ? t[k] : mk()) }),
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
      export { DEFAULTS } from './src/shared/constants';
      export { isMenuLine } from './src/renderer/services/compose-aside';
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

const logs = []; // [{ tag, data }] from rlog
const writes = [];
const resizes = [];
const dom = new JSDOM('<!doctype html><body><div id="content"></div></body>', {
  runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
});
const w = dom.window;
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

// ── The fake clock: setTimeout, setInterval (never fires) and Date.now ──
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
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

const clipboard = [];
Object.defineProperty(w.navigator, 'clipboard', {
  value: { writeText: (t) => { clipboard.push(t); return Promise.resolve(); } }, configurable: true,
});

let ptySeq = 0;
w.patton = stubWith({
  pty: stubWith({
    create: () => Promise.resolve(++ptySeq),
    respawn: () => Promise.resolve(++ptySeq),
    getShell: () => Promise.resolve('/bin/zsh'),
    getCwd: () => Promise.resolve(''),
    write: (ptyId, data, origin) => writes.push([ptyId, data, origin]),
    resize: (...a) => { resizes.push(a); return Promise.resolve(); },
    onData: () => () => {},
    onExit: () => () => {},
  }),
  history: stubWith({ get: () => Promise.resolve([]), add: () => Promise.resolve(), clear: () => Promise.resolve() }),
  getPathForFile: (f) => f.__path,
  log: { send: (lvl, args) => logs.push({ lvl, tag: String(args[0]), data: args[1] }) },
});
w.eval(bundle.outputFiles[0].text);
const PA = w.PA;
const doc = w.document;

// ── Helpers ──
const ASIDE_BLOCKED = 'Claude is asking you something above · your draft is kept';
const ASIDE_MENU = 'Claude may be showing a menu above · click the box to type here';
const content = doc.getElementById('content');
const panes = [];
const newPane = async () => {
  timers = []; // an earlier pane's timers have no meaning here
  const p = new PA.Pane({ onFocus() {}, onTitleChange() {} });
  await p.init();
  content.appendChild(p.element);
  p.setFocused(true);
  await realWait(40); // init()'s own requestAnimationFrame focus has run
  logs.length = 0;
  writes.length = 0;
  panes.push(p);
  return p;
};
const drop = (p) => { p.element.remove(); doc.body.focus?.(); };
const view = (p) => p.terminalView;
const termEl = (p) => view(p).__termEl;
const boxEl = (p) => p.editorContainer.querySelector('textarea');
const active = () => doc.activeElement;
const boxHasKeyboard = (p) => active() === boxEl(p);
const termHasKeyboard = (p) => active() === termEl(p);
const isAside = (p) => p.editorContainer.classList.contains('aside');
// Aside, a label takes Send's place: its title carries the full words.
const slotEl = (p) => p.editorContainer.querySelector('.editor-send-slot');
const labelEl = (p) => p.editorContainer.querySelector('.editor-aside-label');
const liveEl = (p) => p.editorContainer.querySelector('.editor-aside-live');
const sendBtn = (p) => p.editorContainer.querySelector('.editor-send');
const hintText = (p) => (slotEl(p)?.classList.contains('aside') ? labelEl(p).title : null);
const labelText = (p) => (slotEl(p)?.classList.contains('aside') ? labelEl(p).textContent : null);
const isEngaged = (p) => p.editorContainer.classList.contains('compose-first');
const report = (p, body) => view(p).__emit('onProgramStatus', PA.parseProgramStatus(`${body}:app=claude-code`));
const state = (p, s, kind) => report(p, `state=${s}${kind ? `:kind=${kind}` : ''}`);
const childBlocked = (p, id, kind) => report(p, `state=blocked:id=${id}${kind ? `:kind=${kind}` : ''}`);
const stopHook = (p) => view(p).__emit('onPattonState', { kind: 'stop', tasks: 0, crons: 0, context: null });
const ofTag = (tag) => logs.filter((l) => l.tag === `[COMPOSE] ${tag}`).map((l) => l.data);
// An engaged pane on 7501 reports, the box holding the keyboard.
const engagedPane = async () => {
  const p = await newPane();
  p.setComposeFirst(true, null);
  state(p, 'idle');
  logs.length = 0;
  return p;
};
const sendFromBox = async (p, text) => {
  boxEl(p).focus();
  p.editorInput.setValue(text);
  boxEl(p).dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  advance(10); // the Enter follows the line by 10 ms
  await flush();
};
const mouseDown = (el, init = {}) => {
  const e = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(e);
  return e;
};

// ── 0. The harness itself: the real box, a terminal that really takes focus ──
{
  const p = await newPane();
  check('(harness) the real EditorInput is in the pane: a textarea in .editor-container',
    boxEl(p) instanceof w.HTMLTextAreaElement && typeof p.editorInput.focus === 'function' && !('__emit' in p.editorInput));
  boxEl(p).focus();
  view(p).focus();
  check('(harness) the fake terminal focus() moves focus to a real element inside the terminal container',
    termHasKeyboard(p) && p.terminalContainer.contains(termEl(p)) && !boxHasKeyboard(p));
  p.setComposeFirst(true, null);
  check('(harness) Claude not yet seen: the box is shut', !isEngaged(p));
  state(p, 'idle');
  check('(harness) a 7501 report from Claude engages the box and gives it the keyboard',
    isEngaged(p) && boxHasKeyboard(p), { engaged: isEngaged(p), active: active()?.className });
  drop(p);
}

// ── 1. Replay of the 25 real question episodes (D2) ──
{
  const episodes = fixture.episodes;
  const longOnes = episodes.filter((e) => e.endAtMs - e.blockedReports[0].atMs >= 250);
  check('(fixture) 25 episodes: 22 held 250 ms or longer, 3 shorter',
    episodes.length === 25 && longOnes.length === 22, { total: episodes.length, long: longOnes.length });
  let idx = 0;
  for (const ep of episodes) {
    idx++;
    const p = await engagedPane();
    const first = ep.blockedReports[0].atMs;
    const held = ep.endAtMs - first >= 250;
    const label = `episode ${idx} (${ep.kind ?? 'no kind'}, ${ep.blockedReports.length} report${ep.blockedReports.length > 1 ? 's' : ''}, ${ep.endAtMs} ms, ends ${ep.endRoot})`;
    const t0 = now;
    const focusBase = view(p).__focusCalls;
    const times = new Set([...ep.blockedReports.map((r) => r.atMs), ep.endAtMs]);
    for (const t of [first + 249, first + 251, ep.endAtMs - 1]) if (t < ep.endAtMs) times.add(t);
    const timeline = [];
    const keyboard = [];
    for (const t of [...times].sort((a, b) => a - b)) {
      advance(t0 + t - now);
      for (const r of ep.blockedReports) if (r.atMs === t) state(p, r.root, r.kind);
      if (t === ep.endAtMs) state(p, ep.endRoot);
      // aside expected from first + 250 up to (not including) the end
      const expectAside = t < ep.endAtMs && t - first >= 250;
      timeline.push({ t, aside: isAside(p), expectAside, hint: hintText(p) });
      keyboard.push({ t, term: termHasKeyboard(p), box: boxHasKeyboard(p) });
    }
    const timelineOk = timeline.every((s) => s.aside === s.expectAside
      && (s.expectAside ? s.hint === ASIDE_BLOCKED : s.hint === null));
    check(`${label}: ${held ? 'aside after 250 ms, held until the end' : 'never steps aside'}`, timelineOk, timeline.filter((s) => s.aside !== s.expectAside));
    const endState = { aside: isAside(p), hint: hintText(p), box: boxHasKeyboard(p) };
    check(`${label}: ends with the box back (class and hint gone, keyboard in the box)`,
      !endState.aside && endState.hint === null && endState.box, endState);
    const kbOk = held
      ? keyboard.every((k) => (timeline.find((s) => s.t === k.t).expectAside ? k.term && !k.box : k.box && !k.term))
      : keyboard.every((k) => k.box && !k.term && view(p).__focusCalls === focusBase);
    check(`${label}: ${held ? 'the keyboard goes to the terminal on aside and returns on the end' : 'the keyboard never leaves the box'}`,
      kbOk, keyboard);
    const asides = ofTag('aside');
    const backs = ofTag('back');
    if (held) {
      check(`${label}: one "[COMPOSE] aside" (blocked, kind) and one "[COMPOSE] back" (afterMs ${ep.endAtMs - first - 250})`,
        asides.length === 1 && asides[0].reason === 'blocked' && (asides[0].kind ?? null) === (ep.kind ?? null)
          && backs.length === 1 && backs[0].reason === 'unblocked' && backs[0].afterMs === ep.endAtMs - first - 250,
        { asides, backs });
    } else {
      check(`${label}: no aside and no back line`, asides.length === 0 && backs.length === 0, { asides, backs });
    }
    drop(p);
  }
}

// ── 2. Focus safety: aside and back never take the keyboard from elsewhere ──
{
  const outside = (tag, attrs = {}) => {
    const wrap = doc.createElement('div');
    for (const [k, v] of Object.entries(attrs)) wrap.setAttribute(k, v);
    const input = doc.createElement(tag);
    wrap.appendChild(input);
    doc.body.appendChild(wrap);
    return { wrap, input };
  };
  const cases = [
    { name: 'a panel (the notes panel) has the keyboard', make: () => outside('textarea', { id: 'notes-panel' }) },
    { name: 'a dialog has the keyboard', make: () => outside('input', { role: 'dialog' }) },
    { name: 'the search bar has the keyboard', make: () => outside('input', { class: 'search-overlay' }) },
  ];
  for (const c of cases) {
    const p = await engagedPane();
    const o = c.make();
    o.input.focus();
    const before = view(p).__focusCalls;
    state(p, 'blocked', 'permission');
    advance(251);
    check(`${c.name}: the box still steps aside (class, hint)`, isAside(p) && hintText(p) === ASIDE_BLOCKED);
    check(`${c.name}: aside does not take the keyboard (terminal focus() not called)`,
      active() === o.input && view(p).__focusCalls === before, { calls: view(p).__focusCalls - before });
    state(p, 'working');
    check(`${c.name}: back comes, and does not take the keyboard`,
      !isAside(p) && active() === o.input && !boxHasKeyboard(p));
    o.wrap.remove();
    drop(p);
  }
  {
    // The pane is not its tab's focused pane, nothing has the keyboard.
    const p = await engagedPane();
    p.setFocused(false);
    active().blur();
    const before = view(p).__focusCalls;
    state(p, 'blocked', 'question');
    advance(251);
    check('pane not focused: the box steps aside but the terminal is not given the keyboard',
      isAside(p) && view(p).__focusCalls === before && !termHasKeyboard(p), { calls: view(p).__focusCalls - before });
    state(p, 'working');
    check('pane not focused: back does not take the keyboard either', !isAside(p) && !boxHasKeyboard(p) && active() === doc.body);
    drop(p);
  }
  {
    // Another pane's terminal has the keyboard.
    const p = await engagedPane();
    const other = await newPane();
    view(other).focus();
    state(p, 'blocked', 'permission');
    advance(251);
    check('another pane has the keyboard: aside leaves it there', isAside(p) && active() === termEl(other));
    state(p, 'working');
    check('another pane has the keyboard: back leaves it there', !isAside(p) && active() === termEl(other));
    drop(other);
    drop(p);
  }
  {
    // Nothing has the keyboard in a focused pane: back takes it (D2 "or nothing in the window does").
    const p = await engagedPane();
    state(p, 'blocked', 'permission');
    advance(251);
    check('(setup) aside, the terminal has the keyboard', isAside(p) && termHasKeyboard(p));
    active().blur();
    state(p, 'working');
    check('nothing has the keyboard in the focused pane: back gives it to the box', !isAside(p) && boxHasKeyboard(p));
    drop(p);
  }
  {
    // The box had the keyboard in a pane that can no longer take it: aside still moves it off the box.
    const p = await engagedPane();
    p.setFocused(false);
    check('(setup) the box has the keyboard', boxHasKeyboard(p));
    state(p, 'blocked', 'permission');
    advance(251);
    check('the box held the keyboard: aside moves it to the terminal even if the pane is not focused', isAside(p) && termHasKeyboard(p));
    drop(p);
  }
}

// ── 3. A blocked background task (a child record) steps aside like the root ──
{
  const p = await engagedPane();
  state(p, 'working');
  childBlocked(p, 'bg1', 'permission');
  advance(249);
  check('child blocked for 249 ms: not aside yet', !isAside(p));
  advance(2);
  check('child blocked for 251 ms: aside, hint, keyboard on the terminal',
    isAside(p) && hintText(p) === ASIDE_BLOCKED && termHasKeyboard(p));
  let a = ofTag('aside');
  check('[COMPOSE] aside {reason blocked, kind permission} logged for the child', a.length === 1 && a[0].reason === 'blocked' && a[0].kind === 'permission', a);
  report(p, 'state=working:id=bg1');
  check('the child going back to working brings the box back, keyboard in the box', !isAside(p) && hintText(p) === null && boxHasKeyboard(p));
  check('[COMPOSE] back {reason unblocked} logged', ofTag('back').length === 1 && ofTag('back')[0].reason === 'unblocked', ofTag('back'));
  drop(p);
}
{
  const p = await engagedPane();
  state(p, 'working');
  childBlocked(p, 'bg1', 'question');
  advance(100);
  report(p, 'state=clear:id=bg1');
  advance(1000);
  check('a child blocked 100 ms then removed: no aside, no log, keyboard in the box',
    !isAside(p) && ofTag('aside').length === 0 && ofTag('back').length === 0 && boxHasKeyboard(p));
  drop(p);
}
{
  const p = await engagedPane();
  state(p, 'working');
  childBlocked(p, 'bg1', 'question');
  advance(300);
  check('(setup) child blocked 300 ms: aside', isAside(p));
  report(p, 'state=clear:id=bg1');
  check('the child record removed (state=clear:id): the box comes back', !isAside(p) && boxHasKeyboard(p));
  drop(p);
}
{
  const p = await engagedPane();
  state(p, 'working');
  childBlocked(p, 'bg1', 'permission');
  childBlocked(p, 'bg2', 'question');
  advance(300);
  report(p, 'state=working:id=bg1');
  check('two blocked children, one answered: the box stays aside', isAside(p));
  report(p, 'state=working:id=bg2');
  check('...both answered: the box comes back', !isAside(p) && boxHasKeyboard(p));
  drop(p);
}

// ── 4. A menu he opens: a `/` line sent from the box (D3) ──
{
  const p = await engagedPane();
  await sendFromBox(p, '/model');
  check('the Enter of "/model" reached the pty', writes.some(([, d]) => d === '\r'), writes);
  check('his /model line from the box: the box steps aside with the menu hint, keyboard on the terminal',
    isAside(p) && hintText(p) === ASIDE_MENU && termHasKeyboard(p), { aside: isAside(p), hint: hintText(p) });
  const a = ofTag('aside');
  check('[COMPOSE] aside {reason menu} logged, with no kind', a.length === 1 && a[0].reason === 'menu' && !('kind' in a[0]), a);
  p.editorInput.setValue('my draft');
  state(p, 'working');
  check('the next 7501 report ends the menu aside: box back, keyboard in the box, draft kept',
    !isAside(p) && hintText(p) === null && boxHasKeyboard(p) && p.editorInput.getValue() === 'my draft');
  check('[COMPOSE] back logged for the menu', ofTag('back').length === 1, ofTag('back'));
  drop(p);
}
{
  const p = await engagedPane();
  await sendFromBox(p, '/status');
  check('(setup) /status from the box: aside for the menu', isAside(p) && hintText(p) === ASIDE_MENU);
  stopHook(p);
  check('the Stop hook for the pane ends the menu aside', !isAside(p) && hintText(p) === null && boxHasKeyboard(p));
  drop(p);
}
{
  const p = await engagedPane();
  await sendFromBox(p, '/model');
  p.editorInput.setValue('typed while aside');
  const e = mouseDown(boxEl(p));
  check('a click in the box ends the menu aside: class, hint gone, keyboard in the box, draft kept',
    !isAside(p) && hintText(p) === null && boxHasKeyboard(p) && p.editorInput.getValue() === 'typed while aside',
    { aside: isAside(p), hint: hintText(p), box: boxHasKeyboard(p) });
  check('...logged as back with reason click', ofTag('back').some((d) => d.reason === 'click'), ofTag('back'));
  check('...and no report is needed afterwards: the next report changes nothing', (state(p, 'working'), !isAside(p) && boxHasKeyboard(p)));
  void e;
  drop(p);
}
{
  const p = await engagedPane();
  p.queueSubmit('/checkpoint', false, { origin: 'patton' });
  await flush();
  advance(10);
  await flush();
  check('(setup) Patton typed /checkpoint (origin patton) into the pty',
    writes.some(([, d, o]) => d === '/checkpoint' && o === 'patton') && writes.some(([, d, o]) => d === '\r' && o === 'patton'), writes);
  check('Patton\'s own /checkpoint typing does not step the box aside', !isAside(p) && hintText(p) === null && ofTag('aside').length === 0, ofTag('aside'));
  drop(p);
}
{
  const p = await engagedPane();
  await sendFromBox(p, 'hello');
  check('a line that does not begin with / does not step aside', !isAside(p) && ofTag('aside').length === 0 && boxHasKeyboard(p));
  drop(p);
}
{
  // Box off: a `/` line from the (hidden) box path is not a menu aside.
  const p = await engagedPane();
  p.setComposeFirst(false, null);
  check('(setup) the box is shut', !isEngaged(p));
  logs.length = 0;
  p.handleSubmit('/model');
  await flush();
  advance(10);
  await flush();
  check('a `/` line with the box shut: no aside', !isAside(p) && ofTag('aside').length === 0, ofTag('aside'));
  drop(p);
}
{
  // A menu aside, then Claude asks: the aside turns to blocked without the box coming back first.
  const p = await engagedPane();
  await sendFromBox(p, '/model');
  logs.length = 0;
  state(p, 'blocked', 'permission');
  check('menu aside then Claude blocks: the box stays aside and the hint reads the blocked words',
    isAside(p) && hintText(p) === ASIDE_BLOCKED, { aside: isAside(p), hint: hintText(p) });
  check('...with no "back" line in between', ofTag('back').length === 0, ofTag('back'));
  state(p, 'working');
  check('...and answering brings the box back', !isAside(p) && boxHasKeyboard(p));
  drop(p);
}

// ── 5. Clicks and copy (D4) ──
{
  const p = await engagedPane();
  const seen = [];
  p.terminalContainer.addEventListener('mousedown', (e) => seen.push(e.defaultPrevented), false);
  const e = mouseDown(termEl(p));
  termEl(p).focus(); // xterm focuses itself on the click
  advance(1);
  check('7501 pane: a click in the terminal keeps the box\'s keyboard', boxHasKeyboard(p), { active: active()?.className });
  check('...the click still reaches xterm (bubbles to the terminal container, not default-prevented)', seen.length === 1 && seen[0] === false && !e.defaultPrevented);
  check('...no hand-off logged', ofTag('handoff').length === 0, ofTag('handoff'));
  check('...the box is still engaged and not aside', isEngaged(p) && !isAside(p));
  drop(p);
}
{
  // Aside: the terminal takes the click as usual.
  const p = await engagedPane();
  state(p, 'blocked', 'permission');
  advance(300);
  mouseDown(termEl(p));
  termEl(p).focus();
  advance(1);
  check('7501 pane, aside: a click in the terminal leaves the keyboard on the terminal', isAside(p) && termHasKeyboard(p));
  drop(p);
}
{
  // A pane without 7501 reports: the title glyph says Claude runs, nothing says when it asks.
  const p = await newPane();
  p.setComposeFirst(true, null);
  view(p).__emit('onTitleChange', '✳ Claude Code');
  check('(setup) title-only pane: the box is engaged and has the keyboard', isEngaged(p) && boxHasKeyboard(p));
  mouseDown(termEl(p));
  termEl(p).focus();
  advance(1);
  check('a pane without 7501 reports: a click in the terminal hands the keyboard over', termHasKeyboard(p) && !boxHasKeyboard(p), { active: active()?.className });
  const h = ofTag('handoff');
  check('...logged as a click hand-off', h.length === 1 && h[0].key === 'click', h);
  drop(p);
}
{
  const p = await engagedPane();
  w.__selection = 'selected in terminal';
  const box = boxEl(p);
  box.focus();
  const key = (init) => new w.KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true, ...init });
  clipboard.length = 0;
  const e1 = key();
  box.dispatchEvent(e1);
  await flush();
  check('⌘C with nothing selected in the box copies the terminal selection',
    e1.defaultPrevented && clipboard.length === 1 && clipboard[0] === 'selected in terminal', { prevented: e1.defaultPrevented, clipboard });
  check('...and logs it (chars only)', ofTag('copy terminal selection').some((d) => d.chars === 'selected in terminal'.length), ofTag('copy terminal selection'));
  clipboard.length = 0;
  p.editorInput.setValue('abc');
  box.setSelectionRange(0, 3);
  const e2 = key();
  box.dispatchEvent(e2);
  await flush();
  check('⌘C with text selected in the box leaves the copy to the box', !e2.defaultPrevented && clipboard.length === 0, { prevented: e2.defaultPrevented, clipboard });
  w.__selection = '';
  p.editorInput.setValue('');
  const e3 = key();
  box.dispatchEvent(e3);
  await flush();
  check('⌘C with nothing selected anywhere copies nothing', !e3.defaultPrevented && clipboard.length === 0, { clipboard });
  // The Edit menu's Copy raises a copy event instead of the key.
  w.__selection = 'from the menu';
  const stored = {};
  const ce = new w.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(ce, 'clipboardData', { value: { setData: (t, v) => { stored[t] = v; } } });
  box.dispatchEvent(ce);
  check('the copy event (Edit > Copy) with nothing selected in the box carries the terminal selection',
    ce.defaultPrevented && stored['text/plain'] === 'from the menu', { prevented: ce.defaultPrevented, stored });
  w.__selection = '';
  drop(p);
}

// ── 6. The setting (D1): composeBox, and the stored composeFirst is not read ──
{
  const p = await newPane();
  p.setComposeFirst(false, null);
  state(p, 'idle');
  check('composeBox false: Claude runs here and the box stays shut (collapsed, not engaged)',
    !isEngaged(p) && p.editorContainer.classList.contains('collapsed') && !boxHasKeyboard(p));
  state(p, 'blocked', 'permission');
  advance(300);
  state(p, 'working');
  check('composeBox false: a blocked spell changes nothing (no aside, no COMPOSE aside/back lines)',
    !isAside(p) && ofTag('aside').length === 0 && ofTag('back').length === 0, { aside: ofTag('aside'), back: ofTag('back') });
  p.setComposeFirst(true, null);
  check('turning it on engages the box under the running Claude', isEngaged(p) && boxHasKeyboard(p));
  p.setComposeFirst(false, null);
  check('turning it off shuts it again', !isEngaged(p));
  p.setComposeFirst(false, true);
  check('the per-tab override on with the setting off engages it', isEngaged(p));
  drop(p);
}
{
  // How the stored settings reach the panes: the expressions in app.ts, evaluated on a settings
  // object that carries only the OLD key, and the store's default and validation.
  const appSrc = readFileSync(join(repo, 'src/renderer/components/app.ts'), 'utf8');
  const calls = [...appSrc.matchAll(/this\.tabManager\.setComposeFirst\(([^;]*)\);/g)].map((m) => m[1]);
  check('app.ts hands the stored setting to TabManager.setComposeFirst on startup and on change', calls.length === 2, calls);
  const evalWith = (expr, settings) => new Function('settings', `return (${expr});`)(settings);
  const startup = calls.find((c) => c.includes('!==')) ?? '';
  check('a stored composeFirst: false alone does not shut the box at startup', startup !== '' && evalWith(startup, { composeFirst: false }) === true, { startup });
  check('a stored composeBox: false does', startup !== '' && evalWith(startup, { composeBox: false }) === false, { startup });
  check('a settings file with neither key leaves the box on (read as !== false)', startup !== '' && evalWith(startup, {}) === true, { startup });
  const change = calls.find((c) => !c.includes('!==')) ?? '';
  check('a settings change carrying only composeFirst does not touch the box (the change handler reads composeBox)',
    /composeBox/.test(appSrc.slice(appSrc.indexOf('settings.composeBox')).slice(0, 200)) && !/settings\.composeFirst/.test(appSrc) && change !== '', { change });
  check('DEFAULTS.COMPOSE_BOX is true (on by default) and the old DEFAULTS.COMPOSE_FIRST is gone',
    PA.DEFAULTS.COMPOSE_BOX === true && !('COMPOSE_FIRST' in PA.DEFAULTS), PA.DEFAULTS);
  const storeSrc = readFileSync(join(repo, 'src/main/store.ts'), 'utf8');
  check('the store defaults and validates composeBox, and no longer composeFirst',
    /composeBox: DEFAULTS\.COMPOSE_BOX/.test(storeSrc) && /partial\.composeBox/.test(storeSrc) && !/composeFirst/.test(storeSrc));
}

// ── 7. Review fixes (S56) ──
const keyIn = (p, key = 'a', init = {}) => {
  const e = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  boxEl(p).dispatchEvent(e);
  return e;
};
const editorCss = readFileSync(join(repo, 'src/renderer/styles/editor.css'), 'utf8');
// jsdom has no execCommand: insertText at the focused field, as Chromium does.
const insertTextCommand = (cmd, _ui, val) => {
  if (cmd !== 'insertText') return false;
  const t = doc.activeElement;
  t.setRangeText(val, t.selectionStart, t.selectionEnd, 'end');
  return true;
};
{
  // 7.1 A question lands while he types: dim at once, keyboard after a 1000 ms pause.
  const p = await engagedPane();
  boxEl(p).focus();
  p.editorInput.setValue('half a wo');
  keyIn(p);
  advance(100);
  state(p, 'blocked', 'question');
  advance(250);
  check('typing 350 ms before the hold completes: the box dims at once (aside, label "Answer above")',
    isAside(p) && labelText(p) === 'Answer above', { aside: isAside(p), label: labelText(p) });
  check('...but the keyboard stays in the box', boxHasKeyboard(p), { active: active()?.className });
  const a = ofTag('aside');
  check('...[COMPOSE] aside carries deferredMs 650 (what is left of 1000 ms)', a.length === 1 && a[0].deferredMs === 650, a);
  advance(600);
  keyIn(p);
  advance(900);
  check('a keydown during the wait re-arms it: 900 ms after it the keyboard is still in the box', boxHasKeyboard(p) && isAside(p));
  advance(100);
  check('1000 ms with no keydown: the keyboard goes to the terminal, still aside', termHasKeyboard(p) && isAside(p));
  const k = ofTag('aside keyboard');
  check('...logged once as [COMPOSE] aside keyboard', k.length === 1 && typeof k[0].afterMs === 'number', k);
  check('...and the draft is kept', p.editorInput.getValue() === 'half a wo');
  drop(p);
}
{
  const p = await engagedPane();
  boxEl(p).focus();
  p.editorInput.setValue('x');
  keyIn(p);
  state(p, 'blocked', 'permission');
  advance(300);
  check('(setup) typing, then a held question: aside, keyboard still in the box', isAside(p) && boxHasKeyboard(p));
  state(p, 'working');
  advance(2000);
  check('the question ends before he pauses: the move is cancelled, the keyboard stays in the box',
    !isAside(p) && boxHasKeyboard(p) && ofTag('aside keyboard').length === 0, ofTag('aside keyboard'));
  drop(p);
}
{
  const p = await engagedPane();
  boxEl(p).focus();
  p.editorInput.setValue('x');
  keyIn(p);
  advance(1200);
  state(p, 'blocked', 'permission');
  advance(250);
  check('the last keydown 1450 ms before the hold completes: the keyboard moves at once, no deferredMs',
    isAside(p) && termHasKeyboard(p) && ofTag('aside').length === 1 && !('deferredMs' in ofTag('aside')[0]), ofTag('aside'));
  drop(p);
}
{
  // 7.2 No hint row: the label takes Send's place, the container keeps its rows.
  const p = await engagedPane();
  const rows = () => Array.from(p.editorContainer.children).map((el) => `${el.tagName}.${el.className}|${el.hidden}`).join(',');
  const before = rows();
  const slotKids = Array.from(slotEl(p)?.children ?? []);
  resizes.length = 0;
  check('no separate hint row in the box: no .compose-hint anywhere in the pane', !p.element.querySelector('.compose-hint'));
  state(p, 'blocked', 'question');
  advance(300);
  check('aside: the container\'s rows (children and hidden flags) are the same as before', rows() === before, { before, now: rows() });
  check('aside: Send\'s slot swaps in place (same children, the slot marked aside, label "Answer above")',
    slotEl(p) !== null && Array.from(slotEl(p)?.children ?? []).every((el, i) => el === slotKids[i])
      && slotEl(p)?.children?.length === slotKids.length && slotEl(p)?.classList.contains('aside')
      && sendBtn(p).parentElement === slotEl(p) && labelEl(p).parentElement === slotEl(p) && labelEl(p)?.textContent === 'Answer above',
    { label: labelEl(p)?.textContent });
  check('aside: the label\'s title is the full words', labelEl(p)?.title === ASIDE_BLOCKED);
  check('aside: an aria-live region carries the full words', liveEl(p)?.getAttribute('aria-live') === 'polite' && liveEl(p)?.textContent === ASIDE_BLOCKED);
  const sizer = Array.from(p.editorContainer.querySelectorAll('.editor-send-sizer > span')).map((s) => s.textContent);
  check('the slot reserves the widest label: its sizer holds Send and every aside label',
    ['Send', 'Answer above', 'Menu above', 'Answer above first'].every((t) => sizer.includes(t)), sizer);
  check('editor.css: the slot stacks its children in one grid cell, the live region is absolute and clipped, no hint-row rule',
    /\.editor-send-slot > \*\s*\{\s*grid-area: 1 \/ 1;/.test(editorCss)
      && /\.editor-aside-live\s*\{[^}]*position: absolute;[^}]*clip:/.test(editorCss)
      && /\.editor-send-slot\.aside \.editor-send\s*\{\s*visibility: hidden;/.test(editorCss)
      && !/compose-hint/.test(editorCss));
  state(p, 'working');
  check('back: the same rows, Send shown, the label and live region empty',
    rows() === before && !slotEl(p)?.classList.contains('aside') && labelEl(p)?.textContent === '' && liveEl(p)?.textContent === '');
  check('no PTY resize request on aside or back', resizes.length === 0, resizes);
  drop(p);
}
{
  const p = await engagedPane();
  await sendFromBox(p, '/model');
  check('menu aside: the label reads "Menu above", title and live region the menu words',
    labelText(p) === 'Menu above' && hintText(p) === ASIDE_MENU && liveEl(p)?.textContent === ASIDE_MENU, { label: labelText(p) });
  drop(p);
}
{
  // 7.3 Enter or Send in a box aside for a question sends nothing.
  const p = await engagedPane();
  state(p, 'blocked', 'question');
  advance(300);
  boxEl(p).focus(); // he clicked back into the dimmed box
  p.editorInput.setValue('my reply');
  writes.length = 0;
  keyIn(p, 'Enter');
  await flush(); advance(20); await flush();
  check('Enter in a box aside for a question writes nothing to the PTY', writes.length === 0, writes);
  check('...keeps the draft', p.editorInput.getValue() === 'my reply', p.editorInput.getValue());
  check('...flashes "Answer above first" in the label', labelText(p) === 'Answer above first', labelText(p));
  const h = ofTag('send held');
  check('...logs [COMPOSE] send held {pane}', h.length === 1 && h[0].pane === p.id, h);
  advance(1500);
  check('1.5 s later the label reads "Answer above" again', labelText(p) === 'Answer above', labelText(p));
  sendBtn(p).click();
  keyIn(p, 'Enter', { metaKey: true });
  await flush(); advance(20); await flush();
  check('Send and ⌘Enter are held too: nothing written, draft kept, two more held lines',
    writes.length === 0 && p.editorInput.getValue() === 'my reply' && ofTag('send held').length === 3, { writes, held: ofTag('send held').length });
  state(p, 'working');
  keyIn(p, 'Enter');
  await flush(); advance(20); await flush();
  check('once answered, Enter sends the draft', writes.some(([, d]) => String(d).includes('my reply')) && p.editorInput.getValue() === '', writes);
  drop(p);
}
{
  // 7.4 Only a slash command on a 7501 pane steps aside, and a new turn ends it.
  const M = PA.isMenuLine;
  check('isMenuLine: /model, "/compact keep it short", "  /model", /plugin:x-y, "/model\\nmore"',
    M('/model') && M('/compact keep it short') && M('  /model') && M('/plugin:x-y') && M('/model\nmore'));
  check('isMenuLine: not /Users/me/x.png, "/", "/123", "a /model", "/tmp/a\\ b"',
    !M('/Users/me/x.png') && !M('/') && !M('/123') && !M('a /model') && !M('/tmp/a\\ b'));
  const p = await engagedPane();
  await sendFromBox(p, '/Users/me/Desktop/shot.png what is this?');
  check('a message beginning with a path does not step aside', !isAside(p) && ofTag('aside').length === 0, ofTag('aside'));
  drop(p);
}
{
  const p = await newPane();
  p.setComposeFirst(true, null);
  view(p).__emit('onTitleChange', '✳ Claude Code');
  check('(setup) title-only pane, box engaged', isEngaged(p));
  await sendFromBox(p, '/model');
  check('a pane without 7501 reports: a /model line does not step aside', !isAside(p) && ofTag('aside').length === 0, ofTag('aside'));
  drop(p);
}
{
  const p = await engagedPane();
  await sendFromBox(p, '/model');
  check('(setup) menu aside', isAside(p));
  p.startWork();
  check('Claude starting a turn (startWork) ends the menu aside', !isAside(p) && ofTag('back').length === 1, ofTag('back'));
  drop(p);
}
{
  // 7.5 A drop while aside goes into the box without taking the keyboard.
  const p = await engagedPane();
  doc.execCommand = insertTextCommand;
  state(p, 'blocked', 'permission');
  advance(300);
  check('(setup) aside, the terminal has the keyboard', isAside(p) && termHasKeyboard(p));
  p.editorInput.setValue('look at ');
  const dropEvent = () => {
    const e = new w.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files: [{ __path: '/Users/me/a b.png' }] } });
    return e;
  };
  termEl(p).dispatchEvent(dropEvent());
  check('a drop while aside adds the escaped path at the box\'s caret', p.editorInput.getValue() === 'look at /Users/me/a\\ b.png ', p.editorInput.getValue());
  check('...and the keyboard stays on the terminal', termHasKeyboard(p), { active: active()?.className });
  state(p, 'working');
  p.editorInput.setValue('');
  termEl(p).focus();
  termEl(p).dispatchEvent(dropEvent());
  check('a drop with the box in place still lands in the box and gives it the keyboard',
    p.editorInput.getValue() === '/Users/me/a\\ b.png ' && boxHasKeyboard(p), p.editorInput.getValue());
  delete doc.execCommand;
  drop(p);
}
{
  // 7.6 ⌘E reopening the box during a question.
  const p = await engagedPane();
  p.collapseCompose();
  check('(setup) ⌘E shut the box', !isEngaged(p) && termHasKeyboard(p));
  state(p, 'blocked', 'question');
  advance(300);
  p.expandCompose();
  check('⌘E reopening the box during a held question: engaged and aside at once', isEngaged(p) && isAside(p) && labelText(p) === 'Answer above', { aside: isAside(p) });
  check('...and the keyboard stays on the terminal', termHasKeyboard(p), { active: active()?.className });
  state(p, 'working');
  check('answering brings the box back with the keyboard', !isAside(p) && boxHasKeyboard(p));
  drop(p);
}
{
  const p = await engagedPane();
  p.collapseCompose();
  state(p, 'blocked', 'question');
  advance(100);
  p.toggleCompose();
  advance(200);
  check('⌘E reopening it in a question\'s first 250 ms: aside once the hold completes, keyboard on the terminal',
    isEngaged(p) && isAside(p) && termHasKeyboard(p), { aside: isAside(p), active: active()?.className });
  drop(p);
}
{
  // 7.7 ⌘C when the clipboard API refuses.
  const p = await engagedPane();
  w.__selection = 'sel text';
  const box = boxEl(p);
  box.focus();
  const clip = w.navigator.clipboard;
  const realWrite = clip.writeText;
  clip.writeText = () => Promise.reject(new Error('denied'));
  const stored = {};
  doc.execCommand = (cmd) => {
    if (cmd !== 'copy') return false;
    const ce = new w.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(ce, 'clipboardData', { value: { setData: (t, v) => { stored[t] = v; } } });
    doc.activeElement.dispatchEvent(ce);
    return true;
  };
  const e = keyIn(p, 'c', { metaKey: true });
  await flush();
  check('⌘C with the clipboard API refusing: still default-prevented, a warning logged',
    e.defaultPrevented && logs.some((l) => l.tag === '[COMPOSE] copy failed' && l.lvl === 'warn'), logs.filter((l) => l.tag.includes('copy')));
  check('...the copy falls back to the editing command, carrying the terminal selection', stored['text/plain'] === 'sel text', stored);
  check('...logged as [COMPOSE] copy fallback {ok: true}', ofTag('copy fallback').some((d) => d.ok === true), ofTag('copy fallback'));
  clip.writeText = realWrite;
  delete doc.execCommand;
  w.__selection = '';
  drop(p);
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
