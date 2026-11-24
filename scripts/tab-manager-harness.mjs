// Shared set-up for the jsdom checks that drive the REAL TabManager (and the
// REAL TabBar, Tab and Pane it builds): a jsdom window as the page's globals, a
// stub window.patton whose PTYs are fake (bytes reach a pane through `emit`),
// the session kept in memory, and every rlog line of the given tags captured.
// Not a check itself (run-checks.sh runs only scripts/check-*).
// Used by check-tab-working-mark.mjs and check-tab-select.mjs.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Build and load the renderer; returns helpers. `tags`: the log tags kept, e.g. ['TAB', 'GROUP']. */
export async function setUpTabManager({ tags }) {
  const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
  if (!jsdomDir) {
    console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
    process.exit(2);
  }
  const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const work = mkdtempSync(join(tmpdir(), 'tab-manager-check-'));

  await build({
    stdin: {
      contents: `export { TabManager } from './services/tab-manager';
export { repairRuns } from './services/tab-groups';
export * as tabGroups from './services/tab-groups';`,
      resolveDir: join(repo, 'src', 'renderer'), loader: 'ts',
    },
    bundle: true, format: 'cjs', platform: 'browser', outfile: join(work, 'renderer.cjs'),
    loader: { '.css': 'empty' }, logLevel: 'error',
  });

  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const doc = w.document;
  for (const key of Object.getOwnPropertyNames(w)) {
    if (!(key in globalThis)) {
      try { globalThis[key] = w[key]; } catch { /* read-only */ }
    }
  }
  for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
    if (!(key in globalThis)) globalThis[key] = w[key].bind(w);
  }
  globalThis.window = w;
  globalThis.document = doc;
  w.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.matchMedia = w.matchMedia;
  class RO { observe() {} unobserve() {} disconnect() {} }
  w.ResizeObserver = globalThis.ResizeObserver = RO;
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.Element.prototype.scrollIntoView ||= () => {};

  const dataListeners = [];
  const emit = (ptyId, data) => { for (const cb of dataListeners) cb(ptyId, data); };
  const loose = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : loose), apply: () => loose });
  let nextPty = 1;
  let session = null;
  const api = {
    pty: {
      create: async () => nextPty++,
      write: () => {}, resize: () => {}, destroy: () => {},
      getCwd: async () => '', getShell: async () => '/bin/zsh',
      onData: (cb) => { dataListeners.push(cb); return () => {}; },
      onExit: () => () => {},
    },
    settings: { get: async () => ({ startupCommand: '' }), set: async () => {} },
    session: { get: async () => session, set: async (s) => { session = s; } },
    projects: { getNames: async () => ({}), onNamesChanged: () => () => {}, resolve: async () => null, setName: async () => {} },
    history: { get: async () => [], add: () => {}, clear: () => {} },
    log: { send: () => {} },
    sessionFeed: { watch: async () => true, unwatch: async () => {}, onEvent: () => () => {} },
  };
  w.patton = new Proxy(api, { get: (t, p) => (p in t ? t[p] : loose) });

  // rlog's console side, for the kept tags.
  const logs = [];
  const tagRe = new RegExp(`^\\[(${tags.join('|')})\\]`);
  for (const level of ['info', 'warn']) {
    const orig = console[level];
    console[level] = (...args) => {
      if (typeof args[0] === 'string' && tagRe.test(args[0])) logs.push({ level, msg: args[0], data: args[1] });
      else if (level === 'warn' && !String(args[0]).startsWith('[RENDER]')) orig(...args);
    };
  }

  const R = await import(pathToFileURL(join(work, 'renderer.cjs')).href);
  const { TabManager, repairRuns, tabGroups } = R.default ?? R;

  /** A window: its own strip and content, a TabManager, a tab per name (the last selected). */
  async function makeWindow(names) {
    const bar = doc.createElement('div');
    const content = doc.createElement('div');
    doc.body.append(bar, content);
    const tm = new TabManager(bar, content);
    tm.setUserNewTabHandler(async () => tm.createTab());
    tm.closeWindow = async () => {};
    for (const name of names) {
      const tab = await tm.createTab();
      tm.renameTab(tab.id, name);
    }
    tm.bar = bar;
    return tm;
  }

  return { w, doc, emit, logs, makeWindow, TabManager, repairRuns, tabGroups };
}

/** check(), section() and the exit guard every check uses. */
export function checker() {
  const counts = { passed: 0, failed: 0 };
  const check = (name, ok, detail) => {
    if (ok) { counts.passed++; console.log('ok  ', name); }
    else { counts.failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
  };
  process.on('unhandledRejection', (err) => { counts.failed++; console.log('FAIL unhandled rejection', String(err?.stack ?? err)); });
  let finished = false;
  process.on('exit', (code) => {
    if (!finished && code === 0) process.exitCode = 1;
    if (!finished) console.log('FAIL script ended before all checks ran');
  });
  const section = async (fn) => {
    try { await fn(); } catch (err) {
      counts.failed++;
      console.log('FAIL section threw:', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | '));
    }
  };
  const finish = () => {
    finished = true;
    console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
    process.exit(counts.failed > 0 ? 1 : 0);
  };
  return { check, section, finish, counts };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await tick(10);
  }
  return fn();
}
