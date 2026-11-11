// Headless check that a pasted-image thumbnail clears when the user sends the
// message (11 Nov 2026). Michael: "sometimes thumbnail screenshots are staying
// at bottom after message sent". Cause, from his log: 18 of 24 image pastes were
// made while Claude was already mid-turn; Claude Code takes the sent message into
// the running turn without going idle, so startWork() (which clears the chips)
// returned early and the chip sat there until its 10-minute timer.
// Drives a REAL Pane (constructed and init()ed, terminal/editor/overlays stubbed)
// in jsdom. Chips are added through the Pane's private addPasteChip (reachable on
// the bundled object) rather than the clipboard path; keystrokes arrive as
// terminal data, the compose box's submit through the private queueSubmit, and
// Claude's state through the real parseProgramStatus.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-paste-chips.mjs
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
let ptySeq = 0;
w.patton = stubWith({
  pty: stubWith({
    create: () => Promise.resolve(++ptySeq),
    respawn: () => Promise.resolve(++ptySeq),
    getShell: () => Promise.resolve('/bin/zsh'),
    getCwd: () => Promise.resolve(''),
    write: (ptyId, data, origin) => writes.push([ptyId, data, origin]),
    onData: () => () => {},
    onExit: () => () => {},
  }),
  history: stubWith({ get: () => Promise.resolve([]), add: () => Promise.resolve(), clear: () => Promise.resolve() }),
  log: { send: (_lvl, args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) },
});
w.eval(bundle.outputFiles[0].text);
const PA = w.PA;

const makePane = async () => {
  const p = new PA.Pane({ onFocus() {}, onTitleChange() {} });
  await p.init();
  return p;
};
const type = (p, data) => p.terminalView.__emit('onTerminalData', data);
const report = (p, state) => p.terminalView.__emit('onProgramStatus', PA.parseProgramStatus(`state=${state}:app=claude-code`));
const chip = (p) => p.addPasteChip('data:image/png;base64,AAAA', 800, 600);
const chips = (p) => p.pasteChips.length;
const strip = (p) => p.pasteStrip;
const clearedLogs = () => logs.filter((l) => l.includes('[PASTE] chips cleared'));
const submit = async (p, origin) => {
  p.queueSubmit('hello', false, origin ? { origin } : {});
  await wait(40);
};

// ── 1. The bug: a chip pasted mid-turn, then Enter ──
{
  const p = await makePane();
  report(p, 'working'); // Claude is already mid-turn, so startWork() will not run again
  chip(p);
  check('chip is shown', chips(p) === 1 && strip(p).hidden === false && strip(p).querySelectorAll('.paste-chip').length === 1);
  report(p, 'working');
  check('a second working report does not clear it (the bug\'s premise)', chips(p) === 1);
  logs.length = 0;
  type(p, 'next question');
  check('typing text does not clear it', chips(p) === 1);
  type(p, '\r');
  check('lone Enter clears the chip', chips(p) === 0);
  check('lone Enter hides the strip and removes the element', strip(p).hidden === true && strip(p).querySelectorAll('.paste-chip').length === 0);
  check('lone Enter still reaches the PTY', writes.some(([id, d]) => id === p.ptyId && d === '\r'));
  const l = clearedLogs();
  check('one "[PASTE] chips cleared" line', l.length === 1, l);
  check('log line says reason enter and count 1', l[0]?.includes('"reason":"enter"') && l[0]?.includes('"count":1'), l);
  logs.length = 0;
  type(p, '\r');
  check('Enter with no chips writes no "chips cleared" line', clearedLogs().length === 0, logs);
  chip(p); chip(p); chip(p);
  logs.length = 0;
  type(p, '\r');
  check('three chips all clear, logged with count 3', chips(p) === 0 && clearedLogs().length === 1 && clearedLogs()[0].includes('"count":3'), clearedLogs());
}

// ── 2. What must NOT clear ──
{
  const p = await makePane();
  chip(p);
  logs.length = 0;
  type(p, 'line one\rline two\r'); // a paste with newlines arrives as one string
  check('a multi-character chunk containing \\r (a paste) keeps the chip', chips(p) === 1);
  type(p, '\x1b[13;2u'); // Shift+Enter
  check('Shift+Enter keeps the chip', chips(p) === 1);
  type(p, '\n');
  check('a lone \\n keeps the chip', chips(p) === 1);
  type(p, '\x1b');
  check('Escape keeps the chip', chips(p) === 1);
  check('none of those logged a clear', clearedLogs().length === 0, clearedLogs());
}

// ── 3. The compose box ──
{
  const p = await makePane();
  report(p, 'working');
  chip(p);
  logs.length = 0; writes.length = 0;
  await submit(p, 'patton');
  check('a Patton-origin submit (Pause all, checkpoint) keeps the chip', chips(p) === 1 && clearedLogs().length === 0, clearedLogs());
  check('...and still typed the line and Enter', writes.some(([, d]) => d === 'hello') && writes.some(([, d]) => d === '\r'));
  await submit(p);
  check('the user\'s compose submit clears the chip', chips(p) === 0);
  const l = clearedLogs();
  check('compose clear logs reason compose, count 1', l.length === 1 && l[0].includes('"reason":"compose"') && l[0].includes('"count":1'), l);
  logs.length = 0;
  await submit(p);
  check('compose submit with no chips writes no "chips cleared" line', clearedLogs().length === 0);
  chip(p);
  p.queueSubmit('', false, {});
  await wait(40);
  check('an empty compose submit (a bare Enter) clears too', chips(p) === 0);
}

// ── 4. The existing clears still work ──
{
  const p = await makePane();
  report(p, 'idle');
  chip(p);
  report(p, 'working');
  check('startWork still clears the chip (idle -> working)', chips(p) === 0);
  chip(p);
  p.pasteStrip.querySelector('.paste-chip-remove').click();
  check('the × button still removes the chip', chips(p) === 0 && strip(p).hidden === true);
  chip(p);
  p.dispose();
  check('dispose still clears the chips', chips(p) === 0);
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
