// Headless check of the Okay? button (Michael, 18 Nov 2026: "Quite often, I find
// myself wanting to ask a project, 'Is everything going okay?' ... Can we add a
// button in the bottom left?"): a slim row under a Claude pane's terminal whose
// button types "Is everything going okay?" and Enter into Claude, by Pause all's
// safety rules (services/okay-ask.ts, services/pause-all.ts).
// Drives a REAL Pane (constructed and init()ed, terminal/editor/overlays stubbed)
// in jsdom, as check-paste-chips.mjs does: Claude's state arrives through the
// real parseProgramStatus, main's unsent-input tracker and the stash-key probe
// are stubs whose answers the check sets, and every PTY write is recorded.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-okay-button.mjs
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
        terminal: new Proxy({ modes: { bracketedPasteMode: false }, options: {} }, {
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
const writes = [];
const dom = new JSDOM('<!doctype html><body><div id="content"></div></body>', {
  runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
});
const w = dom.window;
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// The button's 3 s result shows for 0.5 s here; everything else keeps its time.
const realSetTimeout = w.setTimeout.bind(w);
w.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 3000 ? 500 : ms, ...a);
const RESULT_WAIT = 700; // from the click: past the 0.5 s result and the stash gap
const SEEN_AT = 40; // the button's words are read this long after the click
const exitHandlers = [];
const resizes = [];
let inputState = null;
let stashKey = { ok: true };
let stashFails = false; // the stash-key probe rejects
let stashGate = null; // when set, the probe answers only once this promise resolves
const CLEAN = { dirty: false, length: 0, lastInputAt: 0, slashSubmitAt: 0, userStashAt: 0, pattonStashAt: 0 };
const setInput = (o) => { inputState = { ...CLEAN, ...o }; };
setInput({});
let ptySeq = 0;
w.patton = stubWith({
  pty: stubWith({
    create: () => Promise.resolve(++ptySeq),
    respawn: () => Promise.resolve(++ptySeq),
    getShell: () => Promise.resolve('/bin/zsh'),
    getCwd: () => Promise.resolve(''),
    write: (ptyId, data, origin) => writes.push([ptyId, data, origin]),
    onData: () => () => {},
    onExit: (cb) => { exitHandlers.push(cb); return () => {}; },
    inputState: () => Promise.resolve([inputState]),
    resize: (id, cols, rows) => resizes.push([id, cols, rows]),
  }),
  pauseAll: stubWith({
    stashKey: () => (stashFails ? Promise.reject(new Error('stash probe failed'))
      : stashGate ? stashGate.then(() => stashKey) : Promise.resolve(stashKey)),
  }),
  history: stubWith({ get: () => Promise.resolve([]), add: () => Promise.resolve(), clear: () => Promise.resolve() }),
  log: { send: (_lvl, args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) },
});
w.eval(bundle.outputFiles[0].text);
const PA = w.PA;


// A click must never reach the broadcast paths (typing into every pane of the tab).
const broadcasts = [];
const makePane = async () => {
  const p = new PA.Pane({
    onFocus() {}, onTitleChange() {},
    onBroadcastWrite: (d) => broadcasts.push(['write', d]),
    onBroadcastPaste: (t) => broadcasts.push(['paste', t]),
  });
  await p.init();
  w.document.getElementById('content').appendChild(p.element);
  return p;
};
const report = (p, state) => p.terminalView.__emit('onProgramStatus', PA.parseProgramStatus(`state=${state}:app=claude-code`));
const clearReport = (p) => p.terminalView.__emit('onProgramStatus', PA.parseProgramStatus('state=clear'));
const row = (p) => p.element.querySelector('.okay-row');
const btn = (p) => p.element.querySelector('.okay-button');
const click = (p) => btn(p).click();
const okayLogs = (kind) => logs.filter((l) => l.includes(`[OKAY] ${kind}`));
const sentLine = () => writes.map(([, d]) => d);
const fresh = () => { logs.length = 0; writes.length = 0; broadcasts.length = 0; stashFails = false; stashGate = null; stashKey = { ok: true }; setInput({}); };
const LINE = 'Is everything going okay?';
// Click, read what the button says once the probes have answered, then let the rest play out.
const clickSeeing = async (p) => { click(p); await wait(SEEN_AT); return btn(p).textContent; };

// ── 1. Where the row is, and when ──
{
  const p = await makePane();
  const r = row(p);
  check('the row exists in the pane, after the terminal and before the paste strip',
    r && r.previousElementSibling === p.terminalContainer && r.nextElementSibling === p.pasteStrip);
  check('a plain shell: the row is hidden', r.hidden === true);
  const b = btn(p);
  check('the button reads Okay? with type=button', b.textContent === 'Okay?' && b.type === 'button' && b.parentElement === r);
  check('aria-label and title are "Ask Claude: Is everything going okay?"',
    b.getAttribute('aria-label') === 'Ask Claude: ' + LINE && b.title === 'Ask Claude: ' + LINE);
  resizes.length = 0;
  report(p, 'idle');
  check('a 7501 report from Claude Code shows the row', r.hidden === false);
  await Promise.resolve();
  check('showing the row re-fits the terminal and tells the PTY at once', resizes.some(([id]) => id === p.ptyId), resizes);
  resizes.length = 0;
  clearReport(p);
  check('Claude going away (state=clear) hides the row', r.hidden === true);
  await Promise.resolve();
  check('hiding it re-fits and tells the PTY too', resizes.some(([id]) => id === p.ptyId), resizes);
  report(p, 'working');
  check('Claude back: shown again', r.hidden === false);
  for (const cb of exitHandlers) cb(p.ptyId);
  check('the shell exiting hides the row', r.hidden === true);
}
{
  // The shell's own prompt (OSC 133) is the other way Claude leaves.
  const p = await makePane();
  report(p, 'done');
  check('(setup) shown while Claude is done', row(p).hidden === false);
  p.terminalView.__emit('onPromptState', 'prompt');
  check('the shell prompt coming back (OSC 133) hides the row', row(p).hidden === true);
}

// ── 2. The click ──
{
  const p = await makePane();
  report(p, 'working'); report(p, 'done');
  fresh();
  const seen = await clickSeeing(p);
  await wait(300);
  check('a click after a finished turn writes exactly the line, then Enter',
    JSON.stringify(sentLine()) === JSON.stringify([LINE, '\r']), sentLine());
  check('...as Patton\'s own words (origin patton)', writes.every(([, , o]) => o === 'patton' || o === undefined) && writes[0][2] === 'patton', writes);
  const l = okayLogs('sent');
  check('one "[OKAY] sent" line, queued false, stash false', l.length === 1 && l[0].includes('"queued":false') && l[0].includes('"stash":false'), l);
  check('the button says Sent', seen === 'Sent', seen);
  check('a click never reaches the broadcast paths (write or paste)', broadcasts.length === 0, broadcasts);
  await wait(RESULT_WAIT);
  check('...then goes back to Okay?', btn(p).textContent === 'Okay?', btn(p).textContent);
}
{
  const p = await makePane();
  report(p, 'working'); report(p, 'done');
  fresh();
  const mouse = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  btn(p).dispatchEvent(mouse);
  check('mousedown on the button is default-prevented (the terminal keeps the keyboard)', mouse.defaultPrevented === true);
  const mouse2 = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  row(p).dispatchEvent(mouse2);
  check('...and so is mousedown on the row', mouse2.defaultPrevented === true);
}
{
  // A draft in Claude's input line: Ctrl+S first.
  const p = await makePane();
  report(p, 'working'); report(p, 'done');
  fresh();
  setInput({ dirty: true, length: 5 });
  click(p);
  await wait(500);
  check('with a draft: Ctrl+S, then the line, then Enter', JSON.stringify(sentLine()) === JSON.stringify(['\x13', LINE, '\r']), sentLine());
  check('...and none of it is broadcast', broadcasts.length === 0, broadcasts);
  const l = okayLogs('sent');
  check('...logged with stash true', l.length === 1 && l[0].includes('"stash":true'), l);
  await wait(RESULT_WAIT);
}
{
  // A draft and Ctrl+S not the stash key: refused, nothing written.
  const p = await makePane();
  report(p, 'working'); report(p, 'done');
  fresh();
  setInput({ dirty: true, length: 5 });
  stashKey = { ok: false, why: 'rebound' };
  const seen = await clickSeeing(p);
  await wait(300);
  check('a draft with Ctrl+S rebound: nothing written', writes.length === 0, writes);
  check('...the button says why', seen === 'draft: stash key rebound', seen);
  const l = okayLogs('skipped');
  check('...logged "[OKAY] skipped" with the reason and the stash-key why', l.length === 1 && l[0].includes('"reason":"draft"') && l[0].includes('rebound'), l);
  await wait(RESULT_WAIT);
}
{
  // Claude waiting on a permission prompt or question: Enter would answer it.
  const p = await makePane();
  report(p, 'working'); report(p, 'blocked');
  fresh();
  const seen = await clickSeeing(p);
  await wait(300);
  check('blocked on a permission prompt: nothing is written to the PTY', writes.length === 0, writes);
  check('...the button says "waiting on you"', seen === 'waiting on you', seen);
  const l = okayLogs('skipped');
  check('...logged skipped, reason waiting', l.length === 1 && l[0].includes('"reason":"waiting"') && okayLogs('sent').length === 0, l);
  await wait(RESULT_WAIT);
  check('...and returns to Okay?', btn(p).textContent === 'Okay?', btn(p).textContent);
}
{
  // A new session that never ran a turn, and a /command that may have opened a menu.
  const p = await makePane();
  report(p, 'idle');
  fresh();
  const seen = await clickSeeing(p);
  await wait(300);
  check('a fresh session (never had a turn): nothing written, says "new session"', writes.length === 0 && seen === 'new session', [writes, seen]);
  await wait(RESULT_WAIT);
  report(p, 'working'); report(p, 'done');
  fresh();
  setInput({ slashSubmitAt: Date.now() + 60000 });
  const seenMenu = await clickSeeing(p);
  await wait(300);
  check('a / line sent and no report since (a menu may be open): nothing written', writes.length === 0 && seenMenu === 'in a menu?', [writes, seenMenu]);
  await wait(RESULT_WAIT);
}
{
  // Mid-turn: Claude Code queues the line.
  const p = await makePane();
  report(p, 'working');
  fresh();
  const seen = await clickSeeing(p);
  await wait(300);
  check('mid-turn: the line and Enter are written', JSON.stringify(sentLine()) === JSON.stringify([LINE, '\r']), sentLine());
  check('...the button says Queued', seen === 'Queued', seen);
  const l = okayLogs('sent');
  check('...logged queued true', l.length === 1 && l[0].includes('"queued":true'), l);
  await wait(RESULT_WAIT);
}
{
  // Two quick clicks send once; clicks during the result do nothing.
  const p = await makePane();
  report(p, 'working'); report(p, 'done');
  fresh();
  click(p); click(p);
  await wait(SEEN_AT);
  const seenBoth = btn(p).textContent;
  await wait(300);
  check('two quick clicks send the line once', sentLine().filter((d) => d === LINE).length === 1 && okayLogs('sent').length === 1 && seenBoth === 'Sent', [sentLine(), seenBoth]);
  click(p);
  await wait(100);
  check('a click while the result shows does nothing', sentLine().filter((d) => d === LINE).length === 1, sentLine());
  await wait(RESULT_WAIT);
  check('after the result time the button is back to Okay?', btn(p).textContent === 'Okay?', btn(p).textContent);
  fresh();
  click(p);
  await wait(400);
  check('...and works again', sentLine().filter((d) => d === LINE).length === 1, sentLine());
  await wait(RESULT_WAIT);
}
{
  // Nothing written when the session changed during the await.
  const p = await makePane();
  report(p, 'working'); report(p, 'done');
  fresh();
  click(p);
  p.ptyId = p.ptyId + 100; // the shell was replaced while the probes were in flight
  await wait(300);
  check('the pty changing across the await: nothing written', writes.length === 0, writes);
  check('...and the button is free again', btn(p).textContent === 'Okay?', btn(p).textContent);
}
{
  // The announcer says it in a sentence.
  const p = await makePane();
  report(p, 'working'); report(p, 'blocked');
  fresh();
  click(p);
  await wait(300);
  const live = [...w.document.querySelectorAll('[aria-live]')].map((e) => e.textContent).join('|');
  check('the announcer reads "Not sent: waiting on you"', live.includes('Not sent: waiting on you'), live);
  await wait(RESULT_WAIT);
  report(p, 'done');
  fresh();
  click(p);
  await wait(400);
  const live2 = [...w.document.querySelectorAll('[aria-live]')].map((e) => e.textContent).join('|');
  check('...and "Asked Claude: Is everything going okay?" when sent', live2.includes('Asked Claude: ' + LINE), live2);
  await wait(RESULT_WAIT);
}
{
  // Disposed pane: the timer is cleared (no throw later), the row goes with the pane.
  const p = await makePane();
  report(p, 'working'); report(p, 'done');
  fresh();
  click(p);
  await wait(300);
  p.dispose();
  await wait(RESULT_WAIT);
  check('disposing mid-result is quiet and removes the row', !p.element.isConnected);
}

// ── 3. The row follows Claude by every route ──
{
  // Claude detected by the title glyph alone (no 7501 report).
  const p = await makePane();
  const r = row(p);
  p.terminalView.__emit('onTitleChange', 'zsh');
  check('a title without the glyph: the row stays hidden', r.hidden === true);
  p.terminalView.__emit('onTitleChange', '\u2733 Claude Code');
  check('a ✳ title (Claude stopped) shows the row', r.hidden === false);
  p.terminalView.__emit('onTitleChange', '\u25D0 working');
  check('a ◐ title (Claude working) keeps it shown', r.hidden === false);
  p.terminalView.__emit('onTitleChange', 'zsh');
  check('a title without the glyph hides the row again', r.hidden === true);
}

// ── 4. A respawned shell has never run Claude ──
{
  const p = await makePane();
  report(p, 'working'); report(p, 'done');
  const r = row(p);
  check('(setup) shown while Claude is done', r.hidden === false);
  fresh();
  const out = await p.respawn({});
  check('(setup) the real respawn() ran and gave a new shell', out.newId === p.ptyId && out.newId !== out.oldId, out);
  check('after a respawn the row is hidden (the new shell never ran Claude)', r.hidden === true);
  btn(p).click();
  await wait(300);
  check('...and a click on it writes nothing to the new shell', writes.length === 0 && okayLogs('sent').length === 0, writes);
  report(p, 'working'); report(p, 'done');
  check('Claude running again in the new shell shows the row', r.hidden === false);
}

// ── 5. A failing probe ──
{
  const p = await makePane();
  report(p, 'working'); report(p, 'done');
  fresh();
  stashFails = true;
  const seen = await clickSeeing(p);
  await wait(300);
  check('a stash-key probe that rejects: nothing is written', writes.length === 0, writes);
  check('...the button says it could not check', seen === "couldn't check, try again", seen);
  const l = okayLogs('skipped');
  check('...logged "[OKAY] skipped" with reason error and the error text', l.length === 1 && l[0].includes('"reason":"error"') && l[0].includes('stash probe failed'), l);
  await wait(RESULT_WAIT);
  check('...and the button recovers to Okay?', btn(p).textContent === 'Okay?', btn(p).textContent);
  fresh();
  click(p);
  await wait(400);
  check('...and works again afterwards', sentLine().filter((d) => d === LINE).length === 1, sentLine());
  await wait(RESULT_WAIT);
}

// ── 6. The row hides while the ask is in flight ──
{
  const p = await makePane();
  report(p, 'working'); report(p, 'done');
  fresh();
  let release;
  stashGate = new Promise((res) => { release = res; });
  click(p);
  await wait(SEEN_AT);
  clearReport(p); // Claude leaves while the probes are out: the row hides
  release();
  await wait(300);
  check('an ask whose row hid mid-flight shows no late result', btn(p).textContent === 'Okay?', btn(p).textContent);
  report(p, 'working'); report(p, 'done');
  fresh();
  click(p);
  await wait(400);
  check('...and the row is free for a new ask when Claude is back', sentLine().filter((d) => d === LINE).length === 1, sentLine());
  await wait(RESULT_WAIT);
}

// ── 7. One resize, not two, when compose-first starts or ends with Claude ──
{
  const p = await makePane();
  p.setComposeFirst(true, null);
  resizes.length = 0;
  report(p, 'idle');
  await wait(20);
  check('(setup) compose-first engaged with Claude', p.composeFirstEngaged === true && row(p).hidden === false);
  check('Claude starting under compose-first: the row adds no PTY resize of its own (the resize observer sends the one final size)',
    resizes.length === 0, resizes);
  clearReport(p);
  await wait(20);
  check('(setup) compose-first released', p.composeFirstEngaged === false && row(p).hidden === true);
  check('Claude leaving under compose-first: no resize of the row\'s own either', resizes.length === 0, resizes);
  p.setComposeFirst(false, null);
  report(p, 'idle');
  await wait(20);
  check('without compose-first the row still re-fits the PTY once', resizes.length === 1, resizes);
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
