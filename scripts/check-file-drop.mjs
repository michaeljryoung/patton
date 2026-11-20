// Headless check of dropped files (design D5, docs/compose-box.md): a file or
// files dropped on a pane add their escaped paths, at the caret when the compose
// box is engaged, else into the terminal as a paste. Drives a REAL Pane
// (constructed and init()ed, terminal/editor/overlays stubbed) in jsdom, with a
// stub window.patton.getPathForFile; drag events are plain Events carrying a
// dataTransfer. The escaping helpers are tested through services/file-drop.ts.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-file-drop.mjs
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
      export * as FD from './src/renderer/services/file-drop';
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
  getPathForFile: (f) => f.__path,
  log: { send: (_lvl, args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) },
});
w.eval(bundle.outputFiles[0].text);
const PA = w.PA;

const makePane = async () => {
  const p = new PA.Pane({ onFocus() {}, onTitleChange() {} });
  await p.init();
  return p;
};
const file = (path) => ({ __path: path, name: path.split('/').pop() });
const dragEvent = (type, types, files = []) => {
  const e = new w.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { types, files, dropEffect: 'none' } });
  return e;
};
const fileDrag = (type, paths) => dragEvent(type, ['Files'], paths.map(file));

// ── 1. Escaping, as Terminal.app escapes a dropped file ──
{
  const { escapeDropPath: esc, formatDropPaths: fmt } = PA.FD;
  check('plain path is untouched', esc('/Users/me/a-b_c.d,e:f@g%h+i=j~k') === '/Users/me/a-b_c.d,e:f@g%h+i=j~k');
  check('spaces get a backslash', esc('/Users/me/My File.txt') === '/Users/me/My\\ File.txt');
  check('single and double quotes', esc(`/a/it's "q"`) === `/a/it\\'s\\ \\"q\\"`, esc(`/a/it's "q"`));
  check('$ and &', esc('/a/$HOME & co') === '/a/\\$HOME\\ \\&\\ co', esc('/a/$HOME & co'));
  check('parentheses', esc('/a/Shot (1).png') === '/a/Shot\\ \\(1\\).png', esc('/a/Shot (1).png'));
  const chars = [';', '*', '?', '[', ']', '{', '}', '<', '>', '|', '!', '#', '`', '^', '\\'];
  check('other specials ; * ? [ ] { } < > | ! # ` ^ \\', esc('/a/' + chars.join('')) === '/a/' + chars.map((c) => '\\' + c).join(''), esc('/a/' + chars.join('')));
  check('unicode letters stay bare', esc('/Users/zoë/日本語/café.txt') === '/Users/zoë/日本語/café.txt', esc('/Users/zoë/日本語/café.txt'));
  check('unicode with a space is escaped only at the space', esc('/Users/zoë/naïve file.txt') === '/Users/zoë/naïve\\ file.txt');
  check('a line break in a name is removed, never escaped into a continuation', esc('/a/x\ny\r.txt') === '/a/xy.txt', esc('/a/x\ny\r.txt'));
  check('ESC and other controls are removed', esc('/a/\x1b[201~b\x07') === String.raw`/a/\[201~b`, esc('/a/\x1b[201~b\x07'));
  check('no ESC byte survives', !esc('/a/\x1b[201~b').includes('\x1b'));
  check('several files: single spaces and a trailing space', fmt(['/a/b c', '/d/e']) === '/a/b\\ c /d/e ', fmt(['/a/b c', '/d/e']));
  check('one file: trailing space', fmt(['/a/b']) === '/a/b ');
  check('no files: empty', fmt([]) === '' && fmt(['']) === '');
  check('dropTarget', PA.FD.dropTarget(true) === 'box' && PA.FD.dropTarget(false) === 'terminal');
  check('isFileDrag only for Files', PA.FD.isFileDrag({ types: ['Files'] }) === true
    && PA.FD.isFileDrag({ types: ['text/plain'] }) === false
    && PA.FD.isFileDrag({ types: ['application/x-patton-tab'] }) === false
    && PA.FD.isFileDrag(null) === false);
  check('dropText skips a file with no path', PA.FD.dropText([file('/a/b'), file(''), file('/c d')], (f) => f.__path) === '/a/b /c\\ d ');
}

const setup = async (engaged) => {
  const p = await makePane();
  const inserted = [];
  const pasted = [];
  p.editorInput = { insertText: (t) => inserted.push(t), dispose() {} };
  p.terminalView.terminal.paste = (t) => pasted.push(t);
  p.composeFirstEngaged = engaged;
  return { p, inserted, pasted };
};
const dropLogs = () => logs.filter((l) => l.includes('[DROP] files'));

// ── 2. A drop into an engaged box lands at the caret ──
{
  const { p, inserted, pasted } = await setup(true);
  writes.length = 0; logs.length = 0;
  const e = fileDrag('drop', ['/Users/me/My File (1).png', '/tmp/b.txt']);
  p.element.dispatchEvent(e);
  check('engaged: insertText gets the escaped paths, joined, trailing space',
    inserted.length === 1 && inserted[0] === '/Users/me/My\\ File\\ \\(1\\).png /tmp/b.txt ', inserted);
  check('engaged: nothing pasted into the terminal and nothing written to the PTY', pasted.length === 0 && writes.length === 0, { pasted, writes });
  check('engaged: drop is preventDefault-ed', e.defaultPrevented === true);
  const l = dropLogs();
  check('engaged: one [DROP] files log, count 2, target box', l.length === 1 && l[0].includes('"count":2') && l[0].includes('"target":"box"'), l);
  check('log carries no path', !l[0]?.includes('/Users') && !l[0]?.includes('b.txt'), l);
}

// ── 3. A drop with the box off reaches the terminal as a paste ──
{
  const { p, inserted, pasted } = await setup(false);
  writes.length = 0; logs.length = 0;
  const e = fileDrag('drop', ['/Users/me/a b.txt', '/x/y']);
  p.element.dispatchEvent(e);
  check('off: terminal.paste (bracketed-paste path) gets the text', pasted.length === 1 && pasted[0] === '/Users/me/a\\ b.txt /x/y ', pasted);
  check('off: nothing inserted into the box', inserted.length === 0);
  check('off: never pty.write directly', writes.length === 0, writes);
  check('off: drop is preventDefault-ed', e.defaultPrevented === true);
  const l = dropLogs();
  check('off: [DROP] files log, count 2, target terminal', l.length === 1 && l[0].includes('"count":2') && l[0].includes('"target":"terminal"'), l);
}

// ── 4. dragover ──
{
  const { p } = await setup(false);
  const e = fileDrag('dragover', ['/a']);
  p.element.dispatchEvent(e);
  check('file dragover is preventDefault-ed (so the drop is allowed)', e.defaultPrevented === true);
  check('file dragover shows a copy cursor', e.dataTransfer.dropEffect === 'copy', e.dataTransfer.dropEffect);
}

// ── 5. Other drags are left alone ──
{
  for (const engaged of [true, false]) {
    const { p, inserted, pasted } = await setup(engaged);
    writes.length = 0; logs.length = 0;
    const kinds = [['text/plain'], ['application/x-patton-tab'], []];
    for (const types of kinds) {
      for (const type of ['dragover', 'drop']) {
        const e = dragEvent(type, types);
        p.element.dispatchEvent(e);
        check(`non-file ${type} (${types.join(',') || 'no types'}, box ${engaged ? 'on' : 'off'}) is not prevented`, e.defaultPrevented === false);
      }
    }
    check(`non-file drags insert, paste and write nothing (box ${engaged ? 'on' : 'off'})`,
      inserted.length === 0 && pasted.length === 0 && writes.length === 0 && dropLogs().length === 0, { inserted, pasted, writes });
  }
}

// ── 6. A file drag with no usable path does nothing but still does not navigate ──
{
  const { p, inserted, pasted } = await setup(true);
  const e = fileDrag('drop', ['']);
  p.element.dispatchEvent(e);
  check('pathless file: prevented, nothing inserted or pasted', e.defaultPrevented === true && inserted.length === 0 && pasted.length === 0);
}

// ── 7. Disposal removes the listeners ──
{
  const { p, inserted } = await setup(true);
  p.dispose();
  p.element.dispatchEvent(fileDrag('drop', ['/a']));
  check('after dispose a drop does nothing', inserted.length === 0);
}

finished = true;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
