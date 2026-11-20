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
// Section 6 (D14, 20 Nov 2026): while the compose box is engaged the thumbnails
// sit inside it, between Okay? and the text (the real EditorInput, so the box's
// row is real DOM).
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-paste-chips.mjs
// COMPOSE_SRC_ROOT=<folder holding src/> bundles another tree (to prove a check bites on a base).
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
const repo = process.env.COMPOSE_SRC_ROOT ? resolve(process.env.COMPOSE_SRC_ROOT) : join(dirname(fileURLToPath(import.meta.url)), '..');

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
  nodePaths: [join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules')], // a COMPOSE_SRC_ROOT tree has none
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

// ── 5. Enter from the empty compose box, while Claude asks, with no PTY, Patton's own words ──
{
  const key = (k) => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
  const p = await makePane();
  report(p, 'working');
  p.composeFirstEngaged = true; // compose-first, empty box: Enter goes to the PTY through forwardEmptyBoxKey
  chip(p);
  logs.length = 0; writes.length = 0;
  check('an arrow from the empty box keeps the chip', p.forwardEmptyBoxKey(key('ArrowUp')) === true && chips(p) === 1);
  check('empty-box Enter is forwarded', p.forwardEmptyBoxKey(key('Enter')) === true && writes.some(([id, d]) => id === p.ptyId && d === '\r'));
  check('empty-box Enter (or Send) clears the chip mid-turn', chips(p) === 0);
  const l = clearedLogs();
  check('...logged with reason enter, count 1', l.length === 1 && l[0].includes('"reason":"enter"') && l[0].includes('"count":1'), l);

  // Claude waiting on a permission prompt or question: Enter answers it.
  report(p, 'blocked');
  p.composeFirstEngaged = true;
  chip(p);
  logs.length = 0;
  type(p, '\r');
  check('blocked: a terminal Enter keeps the chip', chips(p) === 1 && clearedLogs().length === 0, clearedLogs());
  p.forwardEmptyBoxKey(key('Enter'));
  check('blocked: an empty-box Enter keeps the chip', chips(p) === 1 && clearedLogs().length === 0, clearedLogs());
  p.noteEnterSent();
  check('blocked: a broadcast Enter (noteEnterSent) keeps the chip', chips(p) === 1);
  await submit(p);
  check('blocked: the user\'s own compose submit still clears', chips(p) === 0);

  // Back to a state where Enter sends a message: noteEnterSent clears (the broadcast receiver's path).
  report(p, 'working');
  chip(p);
  p.noteEnterSent();
  check('working: noteEnterSent (broadcast receiver) clears the chip', chips(p) === 0);
}
{
  // No PTY: nothing was sent, so nothing clears.
  const p = await makePane();
  report(p, 'working');
  chip(p);
  const id = p.ptyId;
  p.ptyId = null;
  logs.length = 0;
  type(p, '\r');
  check('no PTY: a lone Enter keeps the chip', chips(p) === 1 && clearedLogs().length === 0, clearedLogs());
  p.ptyId = id;
}
{
  // Patton's own words (Pause all, checkpoint) with the pane idle, so startWork's clear cannot be the cause.
  const p = await makePane();
  report(p, 'idle');
  chip(p);
  logs.length = 0; writes.length = 0;
  p.typePauseWord({ stash: false });
  await wait(80);
  check('typePauseWord reached the PTY', writes.some(([, d]) => d === 'pause') && writes.some(([, d]) => d === '\r'), writes);
  check('typePauseWord keeps the chip and logs no clear', chips(p) === 1 && clearedLogs().length === 0, clearedLogs());
  p.typePauseWord({ stash: true });
  await wait(300);
  check('typePauseWord with a stash first keeps the chip too', chips(p) === 1 && clearedLogs().length === 0, clearedLogs());
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

// ── 6. D14: while the box is engaged the thumbnails sit inside it ──
{
  const engaged = async () => {
    const p = await makePane();
    p.setComposeFirst(true, null);
    report(p, 'idle');
    return p;
  };
  const sized = (p, wd, ht) => p.addPasteChip('data:image/png;base64,AAAA', wd, ht);
  const field = (p) => p.editorContainer.querySelector('.editor-field');
  const textarea = (p) => field(p).querySelector('textarea');
  /** The box's row, left to right: what sits before the textarea. */
  const boxImgs = (p) => [...field(p).querySelectorAll('img')];
  const more = (p) => field(p).querySelector('.compose-images-more');
  const before = (a, b) => Boolean(a && b) && Boolean(a.compareDocumentPosition(b) & w.Node.DOCUMENT_POSITION_FOLLOWING);

  const p = await engaged();
  check('6 (setup) the box is engaged with Okay? in it',
    p.composeFirstEngaged === true && field(p).querySelector('.okay-button:not([hidden])') !== null);
  sized(p, 800, 600);
  const img = boxImgs(p)[0];
  check('6.1 an image pasted with the box engaged: its thumbnail inside the box', boxImgs(p).length === 1 && p.editorContainer.contains(img));
  const okay = field(p).querySelector('.okay-button');
  check('6.1 ...left of the text, after Okay?: Okay?, the image, the textarea in that order',
    before(okay, img) && before(img, textarea(p)), [...field(p).children].map((el) => el.className));
  check('6.2 its size (w×h) in its tooltip and accessible name',
    img?.title.includes('800\u00d7600') && img?.alt.includes('800\u00d7600'), { title: img?.title, alt: img?.alt });
  check('6.3 no × on a thumbnail in the box',
    boxImgs(p).length === 1 && field(p).querySelectorAll('.paste-chip-remove').length === 0 && ![...field(p).querySelectorAll('button')].some((b) => b.textContent.includes('\u00d7')));
  check('6.4 the strip above the box is not used', strip(p).hidden === true);
  sized(p, 801, 1); sized(p, 802, 2); sized(p, 803, 3); sized(p, 804, 4);
  check('6.5 five images: the first three and "+2"',
    boxImgs(p).length === 3 && boxImgs(p).map((i) => i.alt).join('|') === 'Pasted image, 800\u00d7600|Pasted image, 801\u00d71|Pasted image, 802\u00d72'
      && more(p)?.textContent === '+2' && before(boxImgs(p)[2], more(p)) && before(more(p), textarea(p)),
    { alts: boxImgs(p).map((i) => i.alt), more: more(p)?.textContent });
  check('6.5 ...still no strip', strip(p).hidden === true);
  // Each clear: thumbnails were in the box before it, none after.
  const inBox = () => boxImgs(p).length;
  let had = inBox();
  await submit(p);
  check('6.6 a send from the box clears them, the box\'s row with them', had === 3 && chips(p) === 0 && inBox() === 0 && !more(p), { had });
  sized(p, 10, 10);
  had = inBox();
  type(p, '\r');
  check('6.6 Enter clears them', had === 1 && chips(p) === 0 && inBox() === 0, { had });
  sized(p, 10, 10);
  had = inBox();
  report(p, 'working');
  check('6.6 the turn starting clears them', had === 1 && chips(p) === 0 && inBox() === 0, { had });
  p.dispose();

  // The 10-minute timer, shortened.
  const ttl = PA.Pane.PASTE_CHIP_TTL_MS;
  PA.Pane.PASTE_CHIP_TTL_MS = 30;
  const t = await engaged();
  sized(t, 20, 20);
  await wait(120);
  const held = chips(t) === 1 && boxImgs(t).length === 1;
  check('6.7 the timer never clears a thumbnail while the box is engaged', held);
  t.setComposeFirst(false, null);
  check('6.8 the box closed: the thumbnail back in the strip, × included, none left in the box',
    strip(t).hidden === false && strip(t).querySelectorAll('.paste-chip-remove').length === 1 && boxImgs(t).length === 0);
  await wait(120);
  check('6.8 ...and the timer clears it again once the box is closed', held && chips(t) === 0 && strip(t).hidden === true);
  t.dispose();

  const off = await makePane();
  report(off, 'idle');
  sized(off, 30, 30);
  // 6.9 is a control: unchanged from before D14, so it holds on the base too.
  check('6.9 the box off: the strip as before (chip with ×), nothing in the box',
    off.composeFirstEngaged === false && strip(off).hidden === false && strip(off).querySelectorAll('.paste-chip .paste-chip-remove').length === 1 && boxImgs(off).length === 0);
  await wait(120);
  check('6.9 ...and its timer still clears it', chips(off) === 0);
  off.dispose();
  PA.Pane.PASTE_CHIP_TTL_MS = ttl;
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
