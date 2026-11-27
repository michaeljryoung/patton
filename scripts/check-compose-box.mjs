// Headless check of the compose box (design D2-D4 and D1's setting, D7 in
// docs/compose-box.md): the box under a Claude Code pane steps aside while
// Claude asks (a 7501 `blocked` held 250 ms, root or background task), after a
// `/` line the user sends from it, and comes back when that ends; a click in
// the terminal keeps the box's keyboard on a pane with 7501 reports; the
// setting `composeBox` (the old `composeFirst` is no longer read); Ctrl-U in
// the box deletes the caret's line, undoably, and never reaches the pty (D16).
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
          // The screen rows: __screen, else a reply's ⏺ row with the selection under it.
          getSelectionPosition: () => {
            const sel = globalThis.__selection ?? '';
            if (!sel) return undefined;
            if (globalThis.__selPos) return globalThis.__selPos;
            const n = sel.split('\\n').length;
            return { start: { x: 0, y: 1 }, end: { x: sel.split('\\n')[n - 1].length, y: n } };
          },
          buffer: { active: { getLine: (y) => {
            const rows = globalThis.__screen ?? ['⏺ A reply', ...(globalThis.__selection ?? '').split('\\n')];
            return rows[y] === undefined ? undefined : { translateToString: () => rows[y], isWrapped: false };
          } } },
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
      export { Tab } from './src/renderer/components/tab';
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
const copyCalls = [];
let copyAnswer = 'refused';
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
  // Copying Claude's original text (main/copy-original.ts): calls recorded,
  // the answer set per test ('refused' means main wrote nothing).
  clipboard: stubWith({
    copySelection: (...a) => { copyCalls.push(a); return Promise.resolve(copyAnswer); },
    readImage: () => Promise.resolve(null),
  }),
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

// ── 5b. Copy in a Claude tab: main gets the selection (main/copy-original.ts) ──
{
  const p = await engagedPane();
  // The real xterm's textarea sits inside .xterm; the capture listener keys on it.
  const wrap = doc.createElement('div');
  wrap.className = 'xterm';
  termEl(p).parentNode.insertBefore(wrap, termEl(p));
  wrap.appendChild(termEl(p));
  const copyEvent = () => {
    const stored = {};
    const ce = new w.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(ce, 'clipboardData', { value: { setData: (t, v) => { stored[t] = v; } } });
    let reachedXterm = false;
    const own = () => { reachedXterm = true; };
    termEl(p).addEventListener('copy', own);
    termEl(p).dispatchEvent(ce);
    termEl(p).removeEventListener('copy', own);
    return { ce, stored, reachedXterm };
  };
  w.__selection = '  ▎ Hi Sarah, thanks for the call';
  copyCalls.length = 0;
  clipboard.length = 0;
  copyAnswer = 'original';
  const a = copyEvent();
  await flush();
  check('Claude tab: ⌘C in the terminal goes to main with the pty and the selection, mode copy',
    copyCalls.length === 1 && copyCalls[0][0] === p.ptyId && copyCalls[0][1] === '  ▎ Hi Sarah, thanks for the call' && copyCalls[0][2] === 'copy', copyCalls);
  check('...xterm\'s own copy never runs, and main\'s write stands (nothing written here)',
    a.ce.defaultPrevented && !a.reachedXterm && clipboard.length === 0, { prevented: a.ce.defaultPrevented, reached: a.reachedXterm, clipboard });
  copyCalls.length = 0;
  copyAnswer = 'refused';
  copyEvent();
  await flush();
  check('Claude tab: main refusing, the drawn selection is copied here', copyCalls.length === 1 && clipboard.length === 1 && clipboard[0] === '  ▎ Hi Sarah, thanks for the call', { copyCalls, clipboard });
  // The compose box's ⌘C copies the drawn text itself, then asks main to upgrade.
  copyCalls.length = 0;
  clipboard.length = 0;
  boxEl(p).focus();
  p.editorInput.setValue('');
  boxEl(p).dispatchEvent(new w.KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true }));
  await flush();
  check('Claude tab, compose box ⌘C: the drawn selection at once, then an upgrade request to main',
    clipboard[0] === '  ▎ Hi Sarah, thanks for the call' && copyCalls.length === 1 && copyCalls[0][2] === 'upgrade', { clipboard, copyCalls });
  // Tool output and his own prompt: copied as drawn by xterm, main never asked,
  // even where Claude quoted the same words.
  for (const [what, screen, y] of [
    ['a tool output row (⎿)', ['⏺ Bash(npm test)', '  ⎿  all tests pass now', '     and the build is green'], 1],
    ['a tool output continuation row', ['⏺ Bash(npm test)', '  ⎿  all tests pass now', '     and the build is green'], 2],
    ['his prompt row (❯)', ['⏺ Done.', '', '❯ all tests pass now please'], 2],
    ['his prompt row (>)', ['> all tests pass now please', '  and ship it'], 1],
  ]) {
    w.__screen = screen;
    w.__selection = screen[y];
    w.__selPos = { start: { x: 0, y }, end: { x: screen[y].length, y } };
    copyCalls.length = 0;
    const t = copyEvent();
    await flush();
    check(`Claude tab, ${what}: today's copy (xterm's), main never asked`, !t.ce.defaultPrevented && t.reachedXterm && copyCalls.length === 0, copyCalls);
  }
  // A reply row under a tool's output: main is asked.
  {
    const screen = ['⏺ Bash(npm test)', '  ⎿  all tests pass now', '', '⏺ All tests pass now, and', '  the build is green.'];
    w.__screen = screen;
    w.__selection = `${screen[3]}\n${screen[4]}`;
    w.__selPos = { start: { x: 0, y: 3 }, end: { x: screen[4].length, y: 4 } };
    copyCalls.length = 0;
    const t = copyEvent();
    await flush();
    check('Claude tab, a reply below a tool\'s output: main is asked', t.ce.defaultPrevented && copyCalls.length === 1, copyCalls);
    // From the tool's output into the reply: as drawn.
    w.__selection = screen.slice(1).join('\n');
    w.__selPos = { start: { x: 0, y: 1 }, end: { x: screen[4].length, y: 4 } };
    copyCalls.length = 0;
    const t2 = copyEvent();
    await flush();
    check('Claude tab, a selection from tool output into a reply: today\'s copy', !t2.ce.defaultPrevented && copyCalls.length === 0, copyCalls);
  }
  w.__screen = undefined;
  w.__selPos = undefined;
  w.__selection = '';
  copyCalls.length = 0;
  const none = copyEvent();
  check('Claude tab, nothing selected: the copy is left alone', !none.ce.defaultPrevented && none.reachedXterm && copyCalls.length === 0);
  drop(p);
}
{
  const p = await newPane(); // a plain shell: no Claude
  const wrap = doc.createElement('div');
  wrap.className = 'xterm';
  termEl(p).parentNode.insertBefore(wrap, termEl(p));
  wrap.appendChild(termEl(p));
  w.__selection = 'ls output';
  copyCalls.length = 0;
  const ce = new w.Event('copy', { bubbles: true, cancelable: true });
  termEl(p).dispatchEvent(ce);
  await flush();
  check('plain shell tab: ⌘C is today\'s copy (xterm\'s), main never asked', !ce.defaultPrevented && copyCalls.length === 0, copyCalls);
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
  check('Send and ⌘Enter are held too: nothing written, draft kept, one more held line (one a second at most)',
    writes.length === 0 && p.editorInput.getValue() === 'my reply' && ofTag('send held').length === 2, { writes, held: ofTag('send held') });
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

// ── 8. Second review fixes (S56) ──
const ptyWrites = () => writes.filter(([, d]) => typeof d === 'string');
{
  // 8.1 Enter 100 ms after a permission prompt appears, before the 250 ms
  // hold: nothing is sent (it would approve the default option).
  const p = await engagedPane();
  boxEl(p).focus();
  p.editorInput.setValue('please run the tests');
  state(p, 'blocked', 'permission');
  advance(100);
  writes.length = 0;
  keyIn(p, 'Enter');
  await flush(); advance(20); await flush();
  check('Enter 100 ms into a permission prompt (not yet aside) writes nothing', writes.length === 0, writes);
  check('...keeps the draft', p.editorInput.getValue() === 'please run the tests', p.editorInput.getValue());
  check('...and flashes "Answer above first" in Send\'s slot before the box is dimmed',
    !isAside(p) && labelText(p) === 'Answer above first' && liveEl(p).textContent === 'Answer above first',
    { aside: isAside(p), label: labelText(p), live: liveEl(p).textContent });
  check('...logged as [COMPOSE] send held', ofTag('send held').length === 1, ofTag('send held'));
  drop(p);
}
{
  const p = await engagedPane();
  boxEl(p).focus();
  p.editorInput.setValue('a draft');
  state(p, 'blocked', 'question');
  advance(50);
  writes.length = 0;
  sendBtn(p).click();
  keyIn(p, 'Enter', { metaKey: true });
  await flush(); advance(20); await flush();
  check('Send and ⌘Enter 50 ms into a question write nothing, the draft kept',
    writes.length === 0 && p.editorInput.getValue() === 'a draft', writes);
  state(p, 'working');
  advance(1600);
  check('the question ends inside the hold: after the flash the slot shows Send again, the live region empty',
    labelText(p) === null && liveEl(p).textContent === '', { label: labelText(p), live: liveEl(p).textContent });
  keyIn(p, 'Enter');
  await flush(); advance(20); await flush();
  check('...and Enter sends the draft', writes.some(([, d]) => String(d).includes('a draft')), writes);
  drop(p);
}
{
  // A background task's question holds sends the same way.
  const p = await engagedPane();
  boxEl(p).focus();
  p.editorInput.setValue('to the task');
  childBlocked(p, 't1', 'permission');
  advance(100);
  writes.length = 0;
  keyIn(p, 'Enter');
  await flush(); advance(20); await flush();
  check('Enter 100 ms into a background task\'s permission prompt writes nothing', writes.length === 0, writes);
  drop(p);
}
{
  // 8.2 The typing grace is capped at 3000 ms from the aside's start.
  const p = await engagedPane();
  boxEl(p).focus();
  p.editorInput.setValue('draft');
  keyIn(p, 'x');
  state(p, 'blocked', 'permission');
  advance(250); // the hold completes: aside, keyboard move deferred
  const t0 = now;
  let movedAt = null;
  for (let t = 0; t < 10000 && movedAt === null; t += 100) {
    if (boxHasKeyboard(p)) keyIn(p, '1');
    advance(100);
    if (!boxHasKeyboard(p)) movedAt = now - t0;
  }
  check('a key every 100 ms into the dimmed box: the keyboard still moves, 3000 ms after the aside began',
    movedAt === 3000 && termHasKeyboard(p) && isAside(p), { movedAt });
  const k = ofTag('aside keyboard');
  check('...logged once as [COMPOSE] aside keyboard {afterMs: 3000}', k.length === 1 && k[0].afterMs === 3000, k);
  drop(p);
}
{
  // 8.3 A click into the box during the grace keeps the keyboard there.
  const p = await engagedPane();
  boxEl(p).focus();
  p.editorInput.setValue('draft');
  keyIn(p, 'x');
  state(p, 'blocked', 'permission');
  advance(300); // aside, the move pending
  view(p).focus(); // he clicked the terminal
  advance(100);
  mouseDown(boxEl(p));
  boxEl(p).focus(); // then clicked the dimmed box again, no typing
  advance(3000);
  check('a click into the box while the keyboard move is pending: the box keeps the keyboard, still dimmed',
    boxHasKeyboard(p) && isAside(p), { box: boxHasKeyboard(p), aside: isAside(p) });
  check('...logged as [COMPOSE] aside keyboard kept {reason: click}, no move logged',
    ofTag('aside keyboard kept').length === 1 && ofTag('aside keyboard kept')[0].reason === 'click'
      && ofTag('aside keyboard').length === 0, logs.map((l) => l.tag));
  writes.length = 0;
  keyIn(p, 'Enter');
  await flush(); advance(20); await flush();
  check('...and Enter there is still held', writes.length === 0 && p.editorInput.getValue() === 'draft', writes);
  drop(p);
}
{
  // 8.4 While Claude asks, the empty box forwards nothing to Claude.
  const forwarded = async (p, keys) => {
    writes.length = 0;
    for (const [key, init] of keys) keyIn(p, key, init);
    await flush(); advance(20); await flush();
    return ptyWrites().map(([, d]) => d);
  };
  const keys = [['Enter'], ['ArrowDown'], ['ArrowUp'], ['Tab'], ['Tab', { shiftKey: true }], ['PageDown'], ['Home']];
  const p = await engagedPane();
  boxEl(p).focus();
  state(p, 'blocked', 'permission');
  advance(100);
  const early = await forwarded(p, keys);
  check('empty box, 100 ms into a permission prompt: Enter, arrows, Tab, Shift+Tab, PageDown, Home write nothing',
    early.length === 0, early);
  advance(300);
  boxEl(p).focus(); // aside; he clicked back into the box
  const late = await forwarded(p, keys);
  check('...nor once the box is aside', late.length === 0, late);
  keyIn(p, 'Escape');
  await flush(); advance(20); await flush();
  check('...Esc in the empty box sends no ESC to Claude (it hands the keyboard to the terminal)',
    ptyWrites().length === 0 && termHasKeyboard(p), ptyWrites());
  check('...the keys stayed in the box: nothing logged as a pty hand-off',
    !ofTag('handoff').some((d) => d.route === 'pty'), ofTag('handoff'));
  state(p, 'working');
  boxEl(p).focus();
  const after = await forwarded(p, [['ArrowDown']]);
  check('once answered, an empty box forwards ArrowDown again', after.length === 1 && after[0] === '\x1b[B', after);
  drop(p);
}
{
  // A menu aside keeps forwarding (D3).
  const p = await engagedPane();
  await sendFromBox(p, '/model');
  check('(setup) a `/model` from the box: aside for a menu', isAside(p) && labelText(p) === 'Menu above');
  boxEl(p).focus();
  writes.length = 0;
  keyIn(p, 'ArrowDown');
  keyIn(p, 'Enter');
  await flush();
  const d = ptyWrites().map(([, x]) => x);
  check('a menu aside still forwards ArrowDown and Enter from the empty box', d.includes('\x1b[B') && d.includes('\r'), d);
  drop(p);
}
{
  // 8.5 The deferred move checks, when it fires, that the pane may take the keyboard.
  const p = await engagedPane();
  boxEl(p).focus();
  p.editorInput.setValue('typing');
  keyIn(p);
  state(p, 'blocked', 'question');
  advance(300);
  p.element.style.display = 'none';
  const before = view(p).__focusCalls;
  advance(3000);
  check('pane hidden during the deferral: the terminal is not focused when it fires',
    view(p).__focusCalls === before && ofTag('aside keyboard').length === 0, { calls: view(p).__focusCalls - before });
  check('...logged as [COMPOSE] aside keyboard dropped {onScreen: false}',
    ofTag('aside keyboard dropped').some((d) => d.onScreen === false), ofTag('aside keyboard dropped'));
  p.element.style.display = '';
  drop(p);
}
{
  const p = await engagedPane();
  boxEl(p).focus();
  p.editorInput.setValue('typing');
  keyIn(p);
  state(p, 'blocked', 'question');
  advance(300);
  p.setFocused(false); // another pane of the tab became the focused one
  boxEl(p).focus();
  const before = view(p).__focusCalls;
  advance(3000);
  check('pane no longer its tab\'s focused pane: the deferred move does nothing',
    view(p).__focusCalls === before && ofTag('aside keyboard').length === 0, { calls: view(p).__focusCalls - before });
  drop(p);
}
{
  // 8.6 A held Enter's key repeat logs once a second, with a count.
  const p = await engagedPane();
  state(p, 'blocked', 'question');
  advance(300);
  boxEl(p).focus();
  p.editorInput.setValue('x');
  for (let i = 0; i < 30; i++) { keyIn(p, 'Enter', { repeat: true }); advance(33); }
  await flush();
  const h1 = ofTag('send held');
  check('30 repeated Enters in 1 s: one [COMPOSE] send held line', h1.length === 1 && h1[0].held === 1, h1);
  advance(100);
  keyIn(p, 'Enter');
  const h2 = ofTag('send held');
  check('...the next line, a second on, counts the 30 held since', h2.length === 2 && h2[1].held === 30, h2);
  drop(p);
}
{
  // 8.7 After the flash, the live region reads the aside words again.
  const p = await engagedPane();
  state(p, 'blocked', 'question');
  advance(300);
  boxEl(p).focus();
  p.editorInput.setValue('x');
  keyIn(p, 'Enter');
  check('(setup) the flash: label and live region read "Answer above first"',
    labelText(p) === 'Answer above first' && liveEl(p).textContent === 'Answer above first');
  advance(1600);
  check('after the flash the live region reads the question words again, the label "Answer above"',
    liveEl(p).textContent === ASIDE_BLOCKED && labelText(p) === 'Answer above',
    { label: labelText(p), live: liveEl(p).textContent });
  drop(p);
}
{
  // 8.8 Broadcast input skips a sibling pane whose Claude is asking.
  timers = [];
  const tab = new PA.Tab();
  await tab.init();
  content.appendChild(tab.element);
  await tab.splitVertical();
  await tab.splitVertical();
  await realWait(40);
  const [a, b, c] = tab.panes;
  for (const p of [a, b, c]) { p.setComposeFirst(true, null); state(p, 'idle'); }
  state(b, 'blocked', 'permission');
  childBlocked(c, 't9', 'question');
  state(c, 'working'); // c's root works, its background task asks
  const d = tab.panes[0];
  check('(setup) three panes with distinct ptys', new Set(tab.panes.map((p) => p.ptyId)).size === 3, tab.panes.map((p) => p.ptyId));
  tab.toggleBroadcastInput();
  logs.length = 0;
  writes.length = 0;
  await sendFromBox(a, 'hello all');
  advance(50); await flush();
  const to = (p) => writes.filter(([id]) => id === p.ptyId).map(([, x]) => x);
  check('broadcast: the sending pane gets its line and Enter', to(a).some((x) => String(x).includes('hello all')) && to(a).includes('\r'), to(a));
  check('...a pane whose Claude asks (root blocked) gets nothing', to(b).length === 0, to(b));
  check('...nor one whose background task asks', to(c).length === 0, to(c));
  const sk = logs.filter((l) => l.tag === '[BROADCAST] skipped').map((l) => l.data);
  check('...logged as [BROADCAST] skipped {pane, reason: blocked} for each',
    sk.some((x) => x.pane === b.id && x.reason === 'blocked') && sk.some((x) => x.pane === c.id && x.reason === 'blocked'), sk);
  state(b, 'idle');
  writes.length = 0;
  await sendFromBox(a, 'again');
  advance(50); await flush();
  check('once b\'s question ends, b gets the broadcast again', to(b).some((x) => String(x).includes('again')) && to(b).includes('\r'), to(b));
  const pasted = [];
  b.pasteBroadcast = (t) => pasted.push(['b', t]);
  c.pasteBroadcast = (t) => pasted.push(['c', t]);
  a.callbacks.onBroadcastPaste('line one\nline two');
  check('a broadcast paste skips the asking pane too (c), not the free one (b)',
    pasted.length === 1 && pasted[0][0] === 'b', pasted);
  void d;
  tab.element.remove();
}

// ── 9. Ctrl-U deletes the caret's line (D16) ──
// jsdom has no editing commands: this stand-in keeps an undo stack for the
// edits made through execCommand ('insertText', 'delete'), as Chromium's
// text field does, so 'undo' (⌘Z) restores only an edit that went through
// the editing command. An edit made by assigning the value is not undoable.
{
  const undoStack = [];
  doc.execCommand = (cmd, _ui, val) => {
    const t = doc.activeElement;
    if (!(t instanceof w.HTMLTextAreaElement)) return false;
    if (cmd === 'undo') {
      const prev = undoStack.pop();
      if (!prev) return false;
      t.value = prev.value;
      t.setSelectionRange(prev.start, prev.end);
      return true;
    }
    if (cmd !== 'insertText' && cmd !== 'delete') return false;
    const { selectionStart: a, selectionEnd: b } = t;
    if (cmd === 'delete' && a === b) return false;
    undoStack.push({ value: t.value, start: a, end: b });
    t.setRangeText(cmd === 'insertText' ? val : '', a, b, 'end');
    return true;
  };
  const ctrlU = (p, init = {}) => keyIn(p, 'u', { ctrlKey: true, ...init });
  const caret = (p) => [boxEl(p).selectionStart, boxEl(p).selectionEnd];
  const put = (p, text, start, end = start) => {
    boxEl(p).focus();
    p.editorInput.setValue(text);
    boxEl(p).setSelectionRange(start, end);
  };
  const killLogs = () => ofTag('kill line');
  const p = await engagedPane();
  boxEl(p).focus();
  writes.length = 0;

  put(p, 'fix the build', 4);
  logs.length = 0;
  const e1 = ctrlU(p);
  check('Ctrl-U in a one-line draft clears it, the key taken (default prevented)',
    boxEl(p).value === '' && e1.defaultPrevented, { value: boxEl(p).value, prevented: e1.defaultPrevented });
  check('...logged [COMPOSE] kill line {pane, lines: 1}',
    killLogs().length === 1 && killLogs()[0].pane === p.id && killLogs()[0].lines === 1, killLogs());
  const cleared = boxEl(p).value;
  doc.execCommand('undo');
  check('...⌘Z (the text field\'s undo) brings the line back', cleared === '' && boxEl(p).value === 'fix the build', { cleared, now: boxEl(p).value });

  put(p, 'one\ntwo\nthree', 5); // in "two"
  ctrlU(p);
  const middle = boxEl(p).value;
  check('the middle line of three goes with its line break; the caret starts the line that takes its place',
    middle === 'one\nthree' && caret(p)[0] === 4 && caret(p)[1] === 4, { value: middle, caret: caret(p) });
  doc.execCommand('undo');
  check('...⌘Z restores it', middle === 'one\nthree' && boxEl(p).value === 'one\ntwo\nthree', boxEl(p).value);

  put(p, 'one\ntwo\nthree', 13); // end of "three"
  ctrlU(p);
  check('the last line goes with the line break before it; the caret ends the line above',
    boxEl(p).value === 'one\ntwo' && caret(p)[0] === 7 && caret(p)[1] === 7, { value: boxEl(p).value, caret: caret(p) });

  put(p, 'one\ntwo\nthree\nfour', 1, 10); // from "one" into "three"
  logs.length = 0;
  ctrlU(p);
  const across = boxEl(p).value;
  check('a selection across lines removes every line it touches',
    across === 'four' && caret(p)[0] === 0, { value: across, caret: caret(p) });
  check('...logged with lines: 3', killLogs().length === 1 && killLogs()[0].lines === 3, killLogs());
  doc.execCommand('undo');
  check('...⌘Z restores all three', across === 'four' && boxEl(p).value === 'one\ntwo\nthree\nfour', boxEl(p).value);

  put(p, '', 0);
  logs.length = 0;
  const eEmpty = ctrlU(p);
  await flush(); advance(20); await flush();
  check('Ctrl-U in an empty box: nothing happens, the key is still taken, no log line',
    boxEl(p).value === '' && eEmpty.defaultPrevented && killLogs().length === 0, { prevented: eEmpty.defaultPrevented, logs: killLogs() });

  put(p, 'keep me', 3);
  ctrlU(p, { shiftKey: true });
  ctrlU(p, { metaKey: true });
  ctrlU(p, { altKey: true });
  const withMods = boxEl(p).value;
  ctrlU(p);
  check('Ctrl-U with another modifier deletes nothing; plain Ctrl-U then deletes the line',
    withMods === 'keep me' && boxEl(p).value === '', { withMods, after: boxEl(p).value });

  // An empty box with Claude idle forwards keys (D3); Ctrl-U must not be one.
  put(p, '', 0);
  const eFwd = ctrlU(p);
  await flush(); advance(20); await flush();
  check('Ctrl-U (one-line, several lines, a selection, the empty box) never reached the pty, each taken by the box',
    ptyWrites().length === 0 && eFwd.defaultPrevented, { writes: ptyWrites(), prevented: eFwd.defaultPrevented });

  drop(p);
  delete doc.execCommand;
}

// ── 10. A long paste goes in as one edit (D19) ──
// The stand-in editing command keeps an undo stack and raises one `input` event per line, as Chromium does.
{
  const undoStack = [];
  let commandCalls = 0;
  doc.execCommand = (cmd, _ui, val) => {
    const t = doc.activeElement;
    if (!(t instanceof w.HTMLTextAreaElement)) return false;
    if (cmd === 'undo') {
      const prev = undoStack.pop();
      if (!prev) return false;
      t.value = prev.value;
      t.setSelectionRange(prev.start, prev.end);
      return true;
    }
    if (cmd !== 'insertText') return false;
    commandCalls++;
    undoStack.push({ value: t.value, start: t.selectionStart, end: t.selectionEnd });
    t.setRangeText(val, t.selectionStart, t.selectionEnd, 'end');
    for (let i = 0; i < val.split('\n').length; i++) t.dispatchEvent(new w.Event('input', { bubbles: true }));
    return true;
  };
  const p = await engagedPane();
  const ta = boxEl(p);
  ta.focus();
  let resizes = 0;
  ta.getClientRects = () => { resizes++; return []; }; // autoResize starts with this
  const pasteText = (text) => {
    const e = new w.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: () => text } });
    ta.dispatchEvent(e);
    return e;
  };
  const insertLogs = () => ofTag('insert');
  const reset = () => { ta.value = ''; undoStack.length = 0; commandCalls = 0; resizes = 0; logs.length = 0; ta.focus(); };
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

  reset();
  const small = lines(5);
  const e1 = pasteText(small);
  check('a 5-line paste: taken, in the box whole, through the editing command',
    e1.defaultPrevented && ta.value === small && commandCalls === 1, { value: ta.value, commandCalls });
  check('...its input events (one per line) cost one resize, not five', resizes === 1, resizes);
  check('...logged [COMPOSE] insert {source: paste, chars: 29, lines: 5, route: edit}',
    insertLogs().length === 1 && insertLogs()[0].source === 'paste' && insertLogs()[0].chars === small.length
    && insertLogs()[0].lines === 5 && insertLogs()[0].route === 'edit' && typeof insertLogs()[0].ms === 'number', insertLogs());
  doc.execCommand('undo');
  check('...⌘Z removes it', ta.value === '', ta.value);

  reset();
  const edge = lines(201); // 200 line breaks: the last that still goes through the command
  pasteText(edge);
  check('200 line breaks still go through the editing command', commandCalls === 1 && insertLogs()[0].route === 'edit', { commandCalls, logs: insertLogs() });
  reset();
  const big = lines(202); // 201 line breaks
  pasteText(big);
  check('201 line breaks go in as one edit: no editing command, the text whole, the caret at its end',
    commandCalls === 0 && ta.value === big && ta.selectionStart === big.length && ta.selectionEnd === big.length, { commandCalls, caret: ta.selectionStart });
  check('...one resize, logged route: replace', resizes === 1 && insertLogs().length === 1 && insertLogs()[0].route === 'replace' && insertLogs()[0].lines === 202, { resizes, logs: insertLogs() });
  doc.execCommand('undo');
  check('...no ⌘Z step (the undo stack is empty; the text stays)', ta.value === big, ta.value.length);

  // A lone \r is a line break too (stripPasteControls keeps it); \r\n counts once.
  reset();
  pasteText(lines(201).replaceAll('\n', '\r')); // 200 lone CRs
  check('200 lone \\r still go through the editing command', commandCalls === 1 && insertLogs()[0].route === 'edit', { commandCalls, logs: insertLogs() });
  reset();
  pasteText(lines(202).replaceAll('\n', '\r')); // 201 lone CRs
  check('201 lone \\r go in as one edit', commandCalls === 0 && insertLogs()[0].route === 'replace' && insertLogs()[0].lines === 202, { commandCalls, logs: insertLogs() });
  reset();
  pasteText(lines(121).replaceAll('\n', '\r\n')); // 120 CRLF pairs: 120 breaks, not 240
  check('120 \\r\\n pairs count 120 line breaks, not 240: the editing command', commandCalls === 1 && insertLogs()[0].route === 'edit' && insertLogs()[0].lines === 121, { commandCalls, logs: insertLogs() });
  reset();
  pasteText(lines(202).replaceAll('\n', '\r\n')); // 201 CRLF pairs
  check('201 \\r\\n pairs: one edit', commandCalls === 0 && insertLogs()[0].route === 'replace' && insertLogs()[0].lines === 202, { commandCalls, logs: insertLogs() });

  // Other listeners on the box see the one-edit insertion as one `input` event; this class's own handler does not (one resize).
  reset();
  let seen = 0;
  const onInput = () => { seen++; };
  ta.addEventListener('input', onInput);
  pasteText(lines(250));
  check('a one-edit paste raises exactly one input event for other listeners, and one resize', seen === 1 && resizes === 1 && commandCalls === 0, { seen, resizes });
  reset();
  seen = 0;
  p.editorInput.insertText(lines(250));
  check('...the same for insertText()', seen === 1 && resizes === 1, { seen, resizes });
  ta.removeEventListener('input', onInput);

  reset();
  ta.value = 'AB';
  ta.setSelectionRange(1, 1);
  const wide = 'w'.repeat(50001);
  pasteText(wide);
  check('50,001 characters in one line: one edit, placed at the caret',
    commandCalls === 0 && ta.value === 'A' + wide + 'B' && ta.selectionStart === 1 + wide.length, { commandCalls, caret: ta.selectionStart });
  reset();
  pasteText('w'.repeat(50000));
  check('50,000 characters still go through the editing command', commandCalls === 1, commandCalls);

  reset();
  ta.value = 'keep SEL keep';
  ta.setSelectionRange(5, 8);
  pasteText(lines(250));
  check('a long paste over a selection replaces just the selection',
    ta.value === 'keep ' + lines(250) + ' keep', ta.value.slice(0, 40));

  reset();
  ta.dispatchEvent(new w.Event('compositionstart', { bubbles: true }));
  pasteText(lines(250));
  check('while an IME composition is open a long paste goes through the editing command', commandCalls === 1 && insertLogs()[0].route === 'edit', { commandCalls, logs: insertLogs() });
  ta.dispatchEvent(new w.Event('compositionend', { bubbles: true }));
  reset();
  pasteText(lines(250));
  check('...after compositionend it is one edit again', commandCalls === 0 && insertLogs()[0].route === 'replace', { commandCalls, logs: insertLogs() });

  reset();
  pasteText('a\x1b[201~b\n' + lines(250));
  check('a paste carrying ESC[201~ is stripped on the one-edit route too', !ta.value.includes('\x1b') && ta.value.startsWith('a[201~b\nline 0'), JSON.stringify(ta.value.slice(0, 20)));

  reset();
  p.editorInput.insertText(lines(250));
  check('insertText() of a long text is one edit, logged source: call', commandCalls === 0 && insertLogs()[0].source === 'call' && insertLogs()[0].route === 'replace', insertLogs());
  reset();
  p.editorInput.insertText('hi');
  check('insertText() of a short text goes through the command', commandCalls === 1 && ta.value === 'hi' && insertLogs()[0].route === 'edit', { commandCalls, logs: insertLogs() });
  reset();
  ta.blur();
  p.editorInput.insertText('quiet', { focus: false });
  check('insertText(…, {focus: false}) with the box unfocused: one edit without the command, the keyboard stays away',
    commandCalls === 0 && ta.value === 'quiet' && doc.activeElement !== ta && insertLogs()[0].route === 'replace', { commandCalls, value: ta.value });

  drop(p);
  delete doc.execCommand;
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
