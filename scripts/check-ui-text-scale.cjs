// Hidden-Electron layout check of Interface Text Size (Settings): the real CSS and
// the real bundled components (tab bar with its hover card and context menu,
// project board, settings panel, bookmarks panel, command palette, close dialog,
// terminal search bar, compose panel) in a window that is never shown, measured
// at scale 1 and again at 1.5 after the real applyUiTextScale() sets --ui-scale.
//
// Asserts, at 1.5 against 1:
//  - every text element's computed font-size is its scale-1 size x 1.5 (a table
//    lists any that is not);
//  - no text box clips (scrollHeight <= clientHeight + 1 for blocks; a form
//    control's content height holds one line of its text);
//  - the xterm terminal and the compose textarea keep their size (both follow
//    Font Size, not this setting);
//  - squeezed strip (40 tabs, every tab at its floor): no tab's close button spills
//    out of its tab, at 1 and 1.5; the active tab is still in view after a size change;
//  - the selected tab sits on the terminal's ground with a 3 px ink bar under it, and
//    a flagged or plain tab has neither (light scheme only: the hidden window's);
//  - the collapsed bookmarks rail's mark is centred on the header row it stood in;
//  - every text box taller than its text grew with the text (a fixed height shows up as no growth);
//  - the real preload hands the renderer the launch scale synchronously (additionalArguments);
// and that the Settings row exists, writes uiTextScale through the real panel,
// invalid values fall back to 1, and the wiring (App, preload, main) is present.
// Not covered: the app's real window (no preload bridge, so IPC is a stub),
// App's own subscription (a source check), traffic-light position (native).
//
// Run: node scripts/check-ui-text-scale.cjs
//   UI_SCALE_CHECK_DIR=<folder>  where the bundle, userData and result go (default: a new temp folder, removed after)
// The same file runs twice: under Node it bundles the sources with esbuild and
// starts Electron on itself; under Electron it opens one window that is never
// shown (show:false, dock hidden), runs the checks and exits.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HARD_TIMEOUT_MS = 40000;
const BIG = 1.5;

if (process.versions.electron) {
  electronMain();
} else {
  nodeRunner().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}

// ---------------------------------------------------------------- Node side
async function nodeRunner() {
  const { build } = require('esbuild');
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const repo = path.join(__dirname, '..');
  const ownDir = !process.env.UI_SCALE_CHECK_DIR;
  const outDir = process.env.UI_SCALE_CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'patton-check-ui-scale-'));
  fs.mkdirSync(outDir, { recursive: true });
  const resultFile = path.join(outDir, 'result.json');
  fs.rmSync(resultFile, { force: true });

  await build({
    stdin: {
      resolveDir: repo,
      loader: 'ts',
      contents: `
        import { Terminal } from '@xterm/xterm';
        import { SearchAddon } from '@xterm/addon-search';
        import { applyUiTextScale } from './src/renderer/services/ui-text-scale';
        import { TabBar } from './src/renderer/components/tab-bar';
        import { ProjectBoard } from './src/renderer/components/project-board';
        import { SettingsPanel } from './src/renderer/components/settings-panel';
        import { BookmarksPanel } from './src/renderer/components/bookmarks-panel';
        import { CommandPalette } from './src/renderer/components/command-palette';
        import { ConfirmDialog } from './src/renderer/components/confirm-dialog';
        import { SearchOverlay } from './src/renderer/components/search-overlay';
        import { EditorInput } from './src/renderer/components/editor-input';
        import { ContextMenu } from './src/renderer/components/context-menu';
        (window as any).__ui = { Terminal, SearchAddon, applyUiTextScale, TabBar, ProjectBoard, SettingsPanel, BookmarksPanel, CommandPalette, ConfirmDialog, SearchOverlay, EditorInput, ContextMenu };
      `,
    },
    bundle: true, platform: 'browser', format: 'iife', outfile: path.join(outDir, 'page.js'),
    loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  // The real preload (electron left external, as in a sandboxed preload) and a page that reads
  // what it exposes in its very first script: the proof the launch scale is known synchronously.
  await build({
    entryPoints: [path.join(repo, 'src/preload/preload.ts')],
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(outDir, 'preload.cjs'), logLevel: 'silent',
  });
  fs.writeFileSync(path.join(outDir, 'launch.html'),
    '<!doctype html><html><head><script>window.__atLaunch = window.patton && window.patton.settings.uiTextScaleAtLaunch;</script></head><body></body></html>');
  // The real stylesheets, in the order src/renderer/index.ts imports them.
  const styles = ['main', 'tabs', 'terminal', 'editor', 'settings', 'board']
    .map((n) => fs.readFileSync(path.join(repo, 'src/renderer/styles', n + '.css'), 'utf8'));
  fs.writeFileSync(path.join(outDir, 'page.css'),
    fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8') + '\n' + styles.join('\n'));
  fs.writeFileSync(path.join(outDir, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head><body>' +
    '<div id="app"><div id="tab-bar"></div><div id="main"><div id="content"></div></div></div>' +
    '<script src="page.js"></script></body></html>');

  const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  // Electron given a missing script opens its default window: refuse instead.
  if (!fs.existsSync(__filename) || !fs.existsSync(electronBin)) {
    console.error('missing script or Electron binary', { script: __filename, electronBin });
    process.exit(2);
  }
  const log = fs.openSync(path.join(outDir, 'electron.log'), 'w');
  const env = { ...process.env, UI_SCALE_CHECK_DIR: outDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [__filename], { env, stdio: ['ignore', log, log] });
  const killer = setTimeout(() => child.kill('SIGKILL'), HARD_TIMEOUT_MS + 5000);
  await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(killer);
  fs.closeSync(log);

  if (!fs.existsSync(resultFile)) {
    console.error(`no result; see ${path.join(outDir, 'electron.log')}`);
    process.exit(2);
  }
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (ownDir) fs.rmSync(outDir, { recursive: true, force: true });
  if (result.error) {
    console.error('check errored:', result.error);
    process.exit(2);
  }

  // Source checks: the wiring the hidden page cannot exercise.
  const src = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
  const wiring = [
    ['App.init applies the stored value too (idempotent after the launch apply)', /applyUiTextScale\(settings\.uiTextScale, 'startup'\)/.test(src('src/renderer/components/app.ts'))],
    ['the renderer entry applies the launch scale BEFORE `new App()` builds the tab bar', (() => {
      const s = src('src/renderer/index.ts');
      const at = s.indexOf('applyUiTextScale(window.patton.settings.uiTextScaleAtLaunch');
      const build = s.indexOf('new App()');
      return at >= 0 && build >= 0 && at < build;
    })()],
    ['main passes the launch scale to each window as a preload switch', /additionalArguments:\s*\[`\$\{UI_TEXT_SCALE_ARG\}\$\{uiTextScaleOf\(store\.getSettings\(\)\.uiTextScale\)\}`\]/.test(src('src/main/window-manager.ts'))],
    ['preload exposes uiTextScaleAtLaunch from process.argv', /uiTextScaleAtLaunch:\s*uiTextScaleFromArgv\(process\.argv\)/.test(src('src/preload/preload.ts'))],
    ['traffic lights move only on macOS', /process\.platform === 'darwin'\)\s*win\.setWindowButtonPosition/.test(src('src/main/window-manager.ts'))],
    ['App follows a change made in any window', /settings\.onUiTextScale\(\(scale\) => applyUiTextScale\(scale, 'change'\)\)/.test(src('src/renderer/components/app.ts'))],
    ['App applies the value the panel saves', /settings\.uiTextScale !== undefined/.test(src('src/renderer/components/app.ts'))],
    ['preload exposes onUiTextScale on the settings channel', /onUiTextScale[\s\S]{0,200}IPC\.SETTINGS_UI_TEXT_SCALE/.test(src('src/preload/preload.ts'))],
    ['main broadcasts to every window after a save', /broadcastUiTextScale\(uiTextScaleOf\(store\.getSettings\(\)\.uiTextScale\)\)/.test(src('src/main/ipc-handlers.ts'))],
    ['main sends it to each window and moves the traffic lights', /webContents\.send\(IPC\.SETTINGS_UI_TEXT_SCALE, scale\)[\s\S]{0,120}setWindowButtonPosition/.test(src('src/main/window-manager.ts'))],
    ['logs "[SETTINGS] uiTextScale"', /\[SETTINGS\] uiTextScale/.test(src('src/renderer/services/ui-text-scale.ts'))],
  ];
  for (const [name, ok] of wiring) result.checks.push({ name: 'wiring: ' + name, ok, detail: null });

  let failed = 0;
  for (const c of result.checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  ${JSON.stringify(c.detail)}`}`);
  }
  if (result.table && result.table.length) {
    console.log('\nText that did not scale by exactly x' + BIG + ':');
    for (const r of result.table.slice(0, 40)) console.log(`  ${r.surface.padEnd(10)} ${r.key.padEnd(48)} ${r.at1}px -> ${r.atBig}px  "${r.text}"`);
    if (result.table.length > 40) console.log(`  ... and ${result.table.length - 40} more`);
  }
  console.log('\nText elements seen per surface: ' + JSON.stringify(result.surfaces));
  console.log(`\n${result.checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------ Electron side
function electronMain() {
  const { app, BrowserWindow } = require('electron');
  const outDir = process.env.UI_SCALE_CHECK_DIR;
  const resultFile = path.join(outDir, 'result.json');
  const write = (obj) => fs.writeFileSync(resultFile, JSON.stringify(obj, null, 1));
  app.setPath('userData', path.join(outDir, 'ud'));
  if (app.dock) app.dock.hide();
  setTimeout(() => {
    try { write({ error: 'timeout' }); } catch { /* the parent reports "no result" */ }
    app.exit(1);
  }, HARD_TIMEOUT_MS);

  app.whenReady().then(async () => {
    try {
      const win = new BrowserWindow({
        show: false, width: 1200, height: 900,
        webPreferences: { backgroundThrottling: false, contextIsolation: false, nodeIntegration: false },
      });
      await win.loadFile(path.join(outDir, 'page.html'));
      const result = await win.webContents.executeJavaScript(`(${pageRun.toString()})(${BIG})`);
      // The real preload in a sandboxed, context-isolated window, as main creates it.
      for (const [label, args, want] of [['1.5', ['--patton-ui-scale=1.5'], 1.5], ['0.9', ['--patton-ui-scale=0.9'], 0.9], ['no switch', [], 1], ['a bad switch', ['--patton-ui-scale=7'], 1]]) {
        const w = new BrowserWindow({
          show: false, width: 300, height: 200,
          webPreferences: { preload: path.join(outDir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: args },
        });
        await w.loadFile(path.join(outDir, 'launch.html'));
        const got = await w.webContents.executeJavaScript('window.__atLaunch');
        result.checks.push({ name: `preload (${label}): the page's first script already reads uiTextScaleAtLaunch = ${want}`, ok: got === want, detail: got });
        w.destroy();
      }
      write(result);
      app.exit(0);
    } catch (err) {
      write({ error: String((err && err.stack) || err) });
      app.exit(1);
    }
  });
}

// Runs inside the page. Self-contained: it is sent as source text.
async function pageRun(BIG) {
  const U = window.__ui;
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // --- the preload bridge, stubbed: every call answers, the ones the components read answer with data
  const calls = [];
  const NOW = Date.now();
  const bookmarks = [
    { id: 'b1', kind: 'project', label: 'Alpha project', path: '/tmp/pb/alpha', displayPath: '~/pb/alpha', addedAt: NOW },
    { id: 'b2', kind: 'project', label: 'Beta project with a longer name', path: '/tmp/pb/beta', displayPath: '~/pb/beta', addedAt: NOW },
    { id: 'b3', kind: 'artifact', label: 'A shared page', url: 'https://example.com/page', addedAt: NOW },
  ];
  const settings = {
    fontSize: 14, fontFamily: "'Menlo', monospace", scrollback: 10000, shell: '/bin/zsh', notificationSound: true,
    notificationSoundType: 'chime', copyOnSelect: false, globalHotkey: 'Control+`', theme: 'system', startupCommand: '',
    opacity: 1, restoreSession: false, shellIntegration: true, renderer: 'dom', composeFirst: true,
    confirmMultilinePaste: false, programStatus: true, checkpointNudgePct: 20, projectBoard: true, projectListFile: '', boardWakeCommand: 'wake',
  };
  const answers = {
    'bookmarks.get': () => bookmarks,
    'settings.get': () => settings,
    'claudeHook.status': () => ({ installed: true, scriptPresent: true, entryPresent: true, scriptPath: '/tmp/x' }),
    'fonts.getSystem': () => [],
  };
  const stub = (name) => new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : stub(name ? name + '.' + String(k) : String(k))),
    apply: (_t, _this, args) => {
      calls.push({ name, args });
      const last = name.split('.').pop();
      if (/^on[A-Z]/.test(last)) return () => {};
      return Promise.resolve(answers[name] ? answers[name]() : undefined);
    },
  });
  window.patton = stub('');

  const CLOSED = { isOpen: false, isCurrent: false, open: 0, waiting: 0, parked: 0, working: 0 };
  const noop = () => {};
  const host = {
    getTabs: () => [], getActiveTab: () => null, switchToTab: noop, createTab: async () => null,
    listSessions: () => [], goToSession: () => false, focusTerminal: noop,
  };
  const P = (n) => `/tmp/pb/${n}`;
  const payload = {
    listFile: '~/tmp/projects.md', listFound: true, listTable: true,
    projects: [
      { path: P('alpha'), name: 'Alpha', lastSessionAt: NOW - 3 * 3600e3, subProjects: [
        { path: P('alpha-wt'), name: 'Alpha feature worktree', displayName: 'feature', kind: 'worktree', lastSessionAt: NOW - 20 * 3600e3 },
        { path: P('alpha/docs'), name: 'Docs', displayName: 'docs', kind: 'folder' } ] },
      { path: P('beta'), name: 'Beta', lastSessionAt: NOW - 4 * 3600e3, subProjects: [] },
      { path: P('gamma'), name: 'Gamma', lastSessionAt: NOW - 21 * 24 * 3600e3, subProjects: [] },
      { path: P('zeta'), name: 'Zeta', subProjects: [] },
      { path: P('epsilon'), name: 'Epsilon', missing: true, subProjects: [] },
    ],
    layout: { version: 1, themes: [
      { id: 'work', name: 'Work', tint: 'sand', projects: [P('alpha'), P('beta')] },
      { id: 'home', name: 'Home', tint: 'teal', projects: [P('gamma'), P('zeta')] },
      { id: 'empty', name: 'Empty', tint: 'none', projects: [] } ],
      tiles: { [P('gamma')]: { wide: true, note: 'a short note' } } },
  };
  const live = new Map([[P('alpha'), { ...CLOSED, isOpen: true, open: 2, working: 1, waiting: 1 }], [P('beta'), { ...CLOSED, isOpen: true, open: 1, waiting: 1 }]]);

  const byId = (id) => document.getElementById(id);
  const surfaces = {}; // name -> root element
  const app = byId('app');
  const main = byId('main');
  const content = byId('content');

  // --- build every surface from the real components
  const tabs = [
    { id: 't1', title: 'patton', active: true },
    { id: 't2', title: 'a tab with a rather long title that gets cut', active: false, awaitingInput: true, waitingText: 'a question' },
    { id: 't3', title: 'parked', active: false, parked: { tasks: 2, crons: 1, titles: ['build', 'watch'] } },
    { id: 't4', title: 'flagged', active: false, flag: 'red' },
    { id: 't5', title: 'wake', active: false, autoFlag: 'yellow' },
    { id: 't6', title: 'six', active: false },
  ];
  const tabBar = new U.TabBar(byId('tab-bar'), {
    onSelect: noop, onClose: noop, onNew: noop, onReorder: noop, onSettings: noop, onRename: noop, onRenameProject: noop, onSetFlag: noop,
    onCheckpoint: noop,
    describeTab: (id) => (id === 't2' ? [{ label: 'Pane 1 · focused', title: 'Claude Code', place: '~/projects/alpha', state: 'Blocked: question · 4 min', activity: 'blocked', detail: 'Which file should I edit?', tasks: [], checkpoint: 'Checkpoint 10:10 · 12% since' }] : null),
  });
  tabBar.update(tabs);
  tabBar.setCheckpoint({ text: '12%', due: true, blocked: false, label: 'Checkpoint' });
  surfaces.tabbar = byId('tab-bar');

  const bookmarksPanel = new U.BookmarksPanel(main, host);
  await bookmarksPanel.toggle();
  surfaces.bookmarks = byId('bookmarks-panel');

  const board = new U.ProjectBoard({
    openProject: noop, dismiss: noop, liveState: (p) => live.get(p) || CLOSED, wakeState: () => ({ command: 'wake', awake: false }), wake: noop, startClaude: noop,
  }, payload);
  content.appendChild(board.element);
  surfaces.board = board.element;

  const compose = document.createElement('div');
  compose.className = 'editor-container';
  content.appendChild(compose);
  new U.EditorInput(compose, { onSubmit: noop, onInterrupt: noop, onHistoryUp: () => null, onHistoryDown: () => null, onTab: noop }, 14);
  surfaces.compose = compose;

  const term = new U.Terminal({ fontSize: 14, rows: 4, cols: 40 });
  const termEl = document.createElement('div');
  termEl.className = 'terminal-container';
  content.appendChild(termEl);
  term.open(termEl);
  term.write('hello from xterm\r\n');
  const search = new U.SearchAddon();
  term.loadAddon(search);
  const searchHost = document.createElement('div');
  searchHost.style.position = 'relative';
  termEl.appendChild(searchHost);
  const searchOverlay = new U.SearchOverlay(searchHost, search);
  searchOverlay.show();
  surfaces.search = searchHost.firstElementChild;

  const settingsPanel = new U.SettingsPanel(app, (s) => { calls.push({ name: 'onSettingsChanged', args: [s] }); if (s.uiTextScale !== undefined) U.applyUiTextScale(s.uiTextScale, 'change'); });
  settingsPanel.loadSettings(settings);
  settingsPanel.show();
  surfaces.settings = document.querySelector('.settings-overlay');

  const palette = new U.CommandPalette(app, noop);
  palette.show([
    { label: 'New Tab', shortcut: '⌘T', action: 'new-tab' },
    { label: 'Settings', shortcut: '⌘,', action: 'settings' },
    { label: 'patton: waiting', action: 'go', glyph: 'waiting' },
    { label: 'build: parked', action: 'go2', glyph: 'parked' },
  ]);
  surfaces.palette = document.querySelector('.command-palette-overlay');

  const dialog = new U.ConfirmDialog(app);
  dialog.confirm({ title: 'Close tab?', message: 'A shell is still running in this tab. Closing it ends the shell.', confirmLabel: 'Close', cancelLabel: 'Cancel' });
  surfaces.confirm = document.querySelector('.confirm-dialog-overlay');

  // hover card: mouse over the second tab, wait out its 400 ms delay
  const tab2 = document.querySelector('.tab-bar-tab[data-tab-id="t2"]');
  tab2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await sleep(700);
  surfaces.hover = document.querySelector('.tab-hover-card');
  const menu = new U.ContextMenu();
  menu.show(300, 300, [{ label: 'Rename', action: noop, shortcut: 'F2' }, { separator: true }, { label: 'Close', action: noop }]);
  surfaces.menu = document.querySelector('.context-menu-item').closest('div:not(.context-menu-item)');
  await frame();

  // --- measuring
  const textOf = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.trim();
  };
  const pathKey = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const sibs = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [e];
      parts.unshift(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/)[0] : '') + (sibs.length > 1 ? `[${sibs.indexOf(e)}]` : ''));
    }
    return parts.join('>');
  };
  const surfaceOf = (el) => {
    for (const [name, root] of Object.entries(surfaces)) if (root && root.contains(el)) return name;
    return 'other';
  };
  const FORM = new Set(['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA']);
  const isExempt = (el) => Boolean(el.closest('.xterm, .editor-textarea'));
  function snapshot() {
    const map = new Map();
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('svg')) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      // r.height <= 1: the visually hidden live regions; no text size to speak of.
      if (cs.display === 'none' || r.width === 0 || r.height <= 1 || parseFloat(cs.fontSize) === 0) continue;
      if (el.tagName === 'INPUT' && ['range', 'checkbox', 'radio'].includes(el.type)) continue;
      const form = FORM.has(el.tagName);
      const text = form ? (el.value || el.textContent || el.placeholder || '').trim() : textOf(el);
      if (!text && !(form && el.placeholder)) continue;
      map.set(pathKey(el), {
        el, surface: surfaceOf(el), fs: parseFloat(cs.fontSize), text: (text || el.placeholder || '').slice(0, 28), form, exempt: isExempt(el),
        tag: el.tagName, display: cs.display, h: r.height, ch: el.clientHeight, sh: el.scrollHeight,
        padV: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom), borV: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth),
      });
    }
    return map;
  }
  const setScale = async (s) => { U.applyUiTextScale(s, 'change'); await frame(); };

  await setScale(1);
  const one = snapshot();
  await setScale(BIG);
  const big = snapshot();

  const surfaceCounts = {};
  for (const v of one.values()) surfaceCounts[v.surface] = (surfaceCounts[v.surface] || 0) + 1;
  for (const name of ['tabbar', 'board', 'settings', 'bookmarks', 'palette', 'confirm', 'search', 'compose', 'menu', 'hover']) {
    check(`measured: the ${name} surface has text on screen (${surfaceCounts[name] || 0})`, (surfaceCounts[name] || 0) >= 2, surfaceCounts);
  }

  // --- every text element scales by exactly BIG, except the terminal and the compose textarea
  const table = [];
  let scaled = 0;
  for (const [key, a] of one) {
    const b = big.get(key);
    if (!b) continue;
    if (a.exempt) continue;
    scaled++;
    if (Math.abs(b.fs - a.fs * BIG) > 0.02) table.push({ surface: a.surface, key: key.slice(-48), at1: a.fs, atBig: b.fs, text: a.text });
  }
  check(`every interface text element scales by x${BIG} (${scaled} measured)`, table.length === 0 && scaled > 60, { unscaled: table.length, scaled });

  // --- no text box clips at the big size (and none at 1)
  const clips = [];
  for (const snap of [['x1', one], [`x${BIG}`, big]]) {
    for (const [key, v] of snap[1]) {
      if (v.exempt) continue;
      let clipped = false;
      if (v.form) {
        // content height of a control must hold a line of its text
        const content = v.ch - v.padV;
        clipped = v.tag !== 'TEXTAREA' && content < v.fs * 0.95; // line-height 1 is the tightest the CSS uses
      } else if (v.display !== 'inline') {
        clipped = v.sh > v.ch + 1 && getComputedStyle(v.el).overflowY !== 'visible' && getComputedStyle(v.el).overflowY !== 'auto' && getComputedStyle(v.el).overflowY !== 'scroll';
        // a block with fixed height whose text overflows it (overflow visible still spills over its neighbours)
        if (!clipped && v.sh > v.ch + 1 && v.ch > 0 && getComputedStyle(v.el).overflowY === 'visible') clipped = true;
      }
      if (clipped) clips.push({ at: snap[0], surface: v.surface, key: key.slice(-48), h: v.h, ch: v.ch, sh: v.sh, fs: v.fs, text: v.text });
    }
  }
  // Any box that cuts off its contents (overflow hidden or clip) and whose contents are taller than it.
  const cuts = (label) => {
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('svg, .terminal-container, .editor-textarea') || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'inline' || cs.display === 'none' || el.clientHeight <= 1) continue;
      if ((cs.overflowY === 'hidden' || cs.overflowY === 'clip') && el.scrollHeight > el.clientHeight + 1 && !el.closest('.tab-hover-card')) {
        clips.push({ at: label, surface: surfaceOf(el), key: pathKey(el).slice(-48), ch: el.clientHeight, sh: el.scrollHeight, text: (el.textContent || '').trim().slice(0, 24) });
      }
    }
  };
  cuts('x' + BIG);
  check('no text box clips at x1 or x' + BIG, clips.length === 0, clips.slice(0, 8));

  // --- a text box that grew its text grew itself: a fixed pixel height shows up as no growth even
  // when the larger text still fits inside it (a 20 px row holding 11 px text -> 16.5 px text).
  // Single-line boxes must gain at least the text's own growth; wrapped ones gain more.
  const noGrowth = [];
  for (const [key, a] of one) {
    const b = big.get(key);
    if (!b || a.exempt || a.display === 'inline' || b.fs <= a.fs + 0.5) continue;
    const need = (b.fs - a.fs) * 0.9;
    if (b.h - a.h < need - 0.1) noGrowth.push({ surface: a.surface, key: key.slice(-48), h1: a.h, hBig: b.h, fs1: a.fs, fsBig: b.fs, text: a.text });
  }
  check(`every text box grows with its text at x${BIG} (a fixed height does not)`, noGrowth.length === 0, noGrowth.slice(0, 10));

  // --- the terminal and the compose textarea do not move
  const xt1 = [...one.values()].filter((v) => v.exempt);
  const xtBig = [...big.values()].filter((v) => v.exempt);
  const xtRows = document.querySelector('.xterm-rows');
  const composeTa = document.querySelector('.editor-textarea');
  check('xterm text keeps its size (14px) at x' + BIG, getComputedStyle(xtRows).fontSize === '14px', getComputedStyle(xtRows).fontSize);
  check('compose textarea keeps its size (14px, the terminal Font Size) at x' + BIG, getComputedStyle(composeTa).fontSize === '14px', getComputedStyle(composeTa).fontSize);
  check('terminal and compose text were measured and unchanged', xt1.length > 0 && xt1.every((a, i) => xtBig[i] && xtBig[i].fs === a.fs), { n: xt1.length });

  // --- the setting itself
  const select = document.getElementById('setting-ui-text-scale');
  const label = document.querySelector('label[for="setting-ui-text-scale"]');
  const opts = select ? [...select.options].map((o) => [o.value, o.textContent]) : [];
  check('Settings row: label "Interface Text Size" for a select', label && label.textContent === 'Interface Text Size' && select && select.tagName === 'SELECT', label && label.textContent);
  check('Settings row: 90, 100 (default), 110, 125, 150 %', JSON.stringify(opts) === JSON.stringify([['0.9', '90%'], ['1', '100% (default)'], ['1.1', '110%'], ['1.25', '125%'], ['1.5', '150%']]), opts);
  const hint = select && document.getElementById(select.getAttribute('aria-describedby') || 'none');
  check('Settings row: hint is linked by aria-describedby and says the terminal keeps its Font Size', hint && /terminal keeps its own Font Size/.test(hint.textContent) && /tabs/.test(hint.textContent), hint && hint.textContent);
  check('Settings row: shows 100% for a settings file without the field', select && select.value === '1', select && select.value);

  const rootScale = () => document.documentElement.style.getPropertyValue('--ui-scale');
  select.value = '1.25';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await frame();
  const wrote = calls.filter((c) => c.name === 'settings.set').map((c) => c.args[0]);
  check('picking 125% saves { uiTextScale: 1.25 } through settings.set', wrote.some((w) => w.uiTextScale === 1.25), wrote);
  check('picking 125% sets --ui-scale 1.25 on :root at once', rootScale() === '1.25', rootScale());
  const t125 = parseFloat(getComputedStyle(document.querySelector('.pboard-title')).fontSize);
  check('the board title (14px) is 17.5px at 125%', Math.abs(t125 - 17.5) < 0.02, t125);

  for (const bad of [2, '1.5', -1, NaN, undefined, null, 'big']) {
    await setScale(1.5);
    U.applyUiTextScale(bad, 'change');
    await frame();
    check(`an invalid value (${String(bad)}) gives 1, not a broken size`, rootScale() === '1' && getComputedStyle(document.querySelector('.pboard-title')).fontSize === '14px', rootScale());
  }

  const logged = calls.filter((c) => c.name === 'log.send' && String(c.args[1][0]).startsWith('[SETTINGS] uiTextScale'));
  check('each change is logged with rlog ([SETTINGS] uiTextScale <n>)', logged.length >= 3 && logged.some((c) => c.args[1][0] === '[SETTINGS] uiTextScale 1.5'), logged.map((c) => c.args[1][0]));

  // --- bookmarks rail: the collapsed sidebar's mark sits level with the header row it stood in
  const hdr = document.querySelector('.bookmarks-header');
  const hdrCentre = {};
  for (const s of [1, BIG]) {
    await setScale(s);
    const r = hdr.getBoundingClientRect();
    hdrCentre[s] = r.top + r.height / 2;
  }
  await bookmarksPanel.toggle(); // collapse: the rail shows
  for (const s of [1, BIG]) {
    await setScale(s);
    const mark = document.querySelector('.bookmarks-rail-mark');
    const r = mark.getBoundingClientRect();
    const centre = r.top + r.height / 2;
    check(`bookmarks rail mark is centred on the header row at x${s}`, r.height > 0 && Math.abs(centre - hdrCentre[s]) <= 1, { markCentre: centre, headerCentre: hdrCentre[s] });
  }

  // --- squeezed strip: enough tabs that every one sits at its min-width floor
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i + 1}`, title: `tab number ${i + 1}`, active: false, flag: i === 3 ? 'red' : undefined }));
  const withActive = (id) => many.map((t) => ({ ...t, active: t.id === id }));
  const strip = document.querySelector('.tab-bar-tabs');
  for (const s of [1, BIG]) {
    await setScale(s);
    tabBar.update(withActive('m1'));
    await frame();
    const tabEls = [...strip.querySelectorAll('.tab-bar-tab')];
    const floor = parseFloat(getComputedStyle(tabEls[0]).minWidth);
    const atFloor = tabEls.filter((t) => Math.abs(t.getBoundingClientRect().width - floor) <= 0.5).length;
    check(`squeezed strip x${s}: all 40 tabs sit at their ${floor}px floor`, tabEls.length === 40 && atFloor === 40, { tabs: tabEls.length, atFloor, floor });
    const spills = [];
    for (const t of tabEls) {
      const close = t.querySelector('.tab-bar-tab-close');
      if (!close) { spills.push({ tab: t.dataset.tabId, why: 'no close button' }); continue; }
      const tr = t.getBoundingClientRect();
      const cr = close.getBoundingClientRect();
      const cs = getComputedStyle(close);
      const ts = getComputedStyle(t);
      const closeEnd = cr.right + parseFloat(cs.marginRight); // the drawn close button's right edge
      const contentEnd = tr.right - parseFloat(ts.paddingRight);
      if (closeEnd > contentEnd + 0.5) spills.push({ tab: t.dataset.tabId, over: +(closeEnd - contentEnd).toFixed(1), tabW: tr.width });
    }
    check(`squeezed strip x${s}: no close button spills out of its tab's padding`, spills.length === 0, spills.slice(0, 4));

    // The blank spacer beside + (12 Nov: "nowhere I can click in the top bar"): present
    // however full the strip is, as wide as +, between + and the checkpoint clock,
    // and no-drag so the JS drag and double-click in tab-bar.ts get the mouse.
    // Built by the real TabBar, so this is the shipped element.
    const space = document.querySelector('.tab-bar-drag-space');
    const plus = document.querySelector('.tab-bar-new');
    const clock = document.querySelector('.tab-bar-checkpoint');
    const order = space && plus && clock && (plus.nextElementSibling === space) && (space.nextElementSibling === clock);
    check(`blank spacer x${s}: sits between + and the checkpoint clock`, !!order);
    const sw = space ? space.getBoundingClientRect() : { width: 0, height: 0 };
    const pw = plus.getBoundingClientRect().width;
    check(`blank spacer x${s}: as wide as + (${pw.toFixed(1)}px) with 40 tabs squeezing the strip`, Math.abs(sw.width - pw) < 0.5, { spacer: sw.width, plus: pw });
    check(`blank spacer x${s}: full strip height, no-drag, default cursor`, !!space && Math.abs(sw.height - strip.getBoundingClientRect().height) <= 1 && getComputedStyle(space).webkitAppRegion === 'no-drag' && getComputedStyle(space).cursor === 'default', space && { h: sw.height, region: getComputedStyle(space).webkitAppRegion, cursor: getComputedStyle(space).cursor });
  }

  // --- the active tab is still on screen after a size change
  await setScale(1);
  tabBar.update(withActive('m30'));
  await frame();
  const inView = (id) => {
    const t = strip.querySelector(`.tab-bar-tab[data-tab-id="${id}"]`).getBoundingClientRect();
    const c = strip.getBoundingClientRect();
    return t.left >= c.left - 0.5 && t.right <= c.right + 0.5;
  };
  check('active tab m30 is in view at x1 (the scroll baseline)', inView('m30'), strip.scrollLeft);
  await setScale(BIG);
  check(`active tab m30 is still in view after the size changes to x${BIG}`, inView('m30'), { scrollLeft: strip.scrollLeft });
  await setScale(1);
  check('active tab m30 is still in view after the size changes back to x1', inView('m30'), { scrollLeft: strip.scrollLeft });

  // --- the selected tab is drawn apart from the rest, not by bold alone
  // (10 Nov: "not very clear … which one's selected"): the terminal's ground
  // (--bg) and a 3 px ink bar on its bottom edge; a flagged or plain tab has
  // neither, and dragging over the selected tab keeps the bar.
  tabBar.update(tabs);
  await frame();
  const tabEl = (id) => strip.querySelector(`.tab-bar-tab[data-tab-id="${id}"]`);
  const probe = document.createElement('div');
  probe.style.background = 'var(--bg)';
  document.body.appendChild(probe);
  const bgColour = getComputedStyle(probe).backgroundColor;
  probe.style.background = 'var(--ink)';
  const inkColour = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const sel = getComputedStyle(tabEl('t1'));
  const bar = `${inkColour} 0px -3px 0px 0px inset`;
  check('selected tab sits on the terminal ground (--bg)', sel.backgroundColor === bgColour, { tab: sel.backgroundColor, bg: bgColour });
  check('selected tab carries a 3px ink bar on its bottom edge', sel.boxShadow === bar, { boxShadow: sel.boxShadow, want: bar });
  for (const id of ['t4', 't6']) {
    const other = getComputedStyle(tabEl(id));
    check(`unselected tab ${id} has neither the ground nor the bar`, other.backgroundColor !== bgColour && other.boxShadow === 'none', { background: other.backgroundColor, boxShadow: other.boxShadow });
  }
  tabEl('t1').classList.add('drag-over');
  const dragged = getComputedStyle(tabEl('t1')).boxShadow;
  check('dragging over the selected tab keeps its bar beside the drop line', dragged.includes(bar) && dragged.split('inset').length - 1 === 2, { boxShadow: dragged });
  tabEl('t1').classList.remove('drag-over');

  return { checks, table, surfaces: surfaceCounts };
}
