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
//  - squeezed strip (40 tabs, every tab at its floor): nothing spills out of a tab's padding
//    and the close button's box stays inside its tab, at 1 and 1.5;
//  - Pause all is an icon while idle; the close button takes no room and shows only on a real
//    hover (sendInputEvent) or Tab-key focus; 13 tabs fit a 1000 px window at 1 and 1.5; the active tab is still in view after a size change;
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
      win.webContents.focus(); // page focus, so :focus and :focus-visible can match; the window stays hidden
      // The page asks for real input (a hover is not something a script can fake): it sets
      // window.__inputReq, this poll sends it with sendInputEvent and flags window.__inputDone.
      const relay = setInterval(async () => {
        try {
          const req = await win.webContents.executeJavaScript('window.__inputReq || null');
          if (!req) return;
          await win.webContents.executeJavaScript('window.__inputReq = null');
          win.webContents.sendInputEvent(req);
          await win.webContents.executeJavaScript('window.__inputDone = true');
        } catch { /* the window is going away */ }
      }, 15);
      const result = await win.webContents.executeJavaScript(`(${pageRun.toString()})(${BIG})`);
      clearInterval(relay);
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
  // Real input from outside the page (see electronMain): resolves once Chromium has had it and drawn.
  const sendInput = async (ev) => {
    window.__inputDone = false;
    window.__inputReq = ev;
    for (let i = 0; i < 200 && !window.__inputDone; i++) await sleep(10);
    await frame();
    return window.__inputDone;
  };
  const hoverAt = (x, y) => sendInput({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });

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
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i + 1}`, title: `tab number ${i + 1}`, active: false, flag: i === 3 || i === 5 ? 'red' : undefined, checkpointDone: i === 4 || i === 5 }));
  // m4 flagged, m5 red circle, m6 both (12 Nov: the two together overflowed the plain floor by ~16 px).
  const withActive = (id) => many.map((t) => ({ ...t, active: t.id === id }));
  const strip = document.querySelector('.tab-bar-tabs');
  for (const s of [1, BIG]) {
    await setScale(s);
    tabBar.update(withActive('m1'));
    await frame();
    const tabEls = [...strip.querySelectorAll('.tab-bar-tab')];
    const floor = parseFloat(getComputedStyle(tabEls[0]).minWidth);
    const atFloor = tabEls.filter((t) => Math.abs(t.getBoundingClientRect().width - parseFloat(getComputedStyle(t).minWidth)) <= 0.5).length;
    const both = tabEls.filter((t) => t.querySelector('.checkpoint-done') && t.querySelector('[class*="flag-"]'));
    check(`squeezed strip x${s}: all 40 tabs sit at their own floor (${floor}px plain; a flag with the red circle has a taller one)`, tabEls.length === 40 && atFloor === 40 && both.length === 1, { tabs: tabEls.length, atFloor, floor, both: both.length });
    // The close button is out of the tab's flow (13 Nov: shown only on hover, overlaid on the
    // tab's right end), so nothing in the flow may spill instead: the close button's box stays
    // inside its tab, and the dot, flag, red circle and title all end inside the tab's padding.
    const spills = [];
    for (const t of tabEls) {
      const close = t.querySelector('.tab-bar-tab-close');
      if (!close) { spills.push({ tab: t.dataset.tabId, why: 'no close button' }); continue; }
      const tr = t.getBoundingClientRect();
      const cr = close.getBoundingClientRect();
      const ts = getComputedStyle(t);
      const contentEnd = tr.right - parseFloat(ts.paddingRight);
      if (cr.left < tr.left - 0.5 || cr.right > tr.right + 0.5) spills.push({ tab: t.dataset.tabId, why: 'close box outside the tab', cl: cr.left - tr.left, cr: cr.right - tr.right });
      for (const el of t.querySelectorAll('.tab-bar-tab-indicator, .tab-bar-tab-title')) {
        const er = el.getBoundingClientRect();
        if (er.right > contentEnd + 0.5) spills.push({ tab: t.dataset.tabId, el: el.className, over: +(er.right - contentEnd).toFixed(1), tabW: tr.width });
      }
    }
    check(`squeezed strip x${s}: nothing spills out of a tab's padding, and the close button's box stays inside its tab`, spills.length === 0, spills.slice(0, 4));

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

    // Pause all is only an icon while idle (13 Nov: the strip's room is for tabs; the words
    // cost ~80 px): no wider than + and 2 px, its text "⏸", the full words in aria-label
    // and title; a press's result shows as text, then the icon comes back.
    const pause = document.querySelector('.tab-bar-pause-all');
    const pwid = pause.getBoundingClientRect().width;
    check(`Pause all x${s}: idle it is the "⏸" icon, ${pwid.toFixed(1)}px against + at ${pw.toFixed(1)}px (no more than + and 2px)`, pause.textContent === '\u23f8' && pwid <= pw + 2, { text: pause.textContent, pause: pwid, plus: pw });
    check(`Pause all x${s}: the full words stay in its aria-label and title`, /^Pause all: type pause into every Claude session/.test(pause.getAttribute('aria-label') || '') && pause.title === pause.getAttribute('aria-label'), { aria: pause.getAttribute('aria-label'), title: pause.title });
    tabBar.constructor.PAUSE_RESULT_MS = 60;
    const resultText = 'Paused 4 Claude sessions (2 in this window); skipped 1';
    tabBar.showPauseResult(resultText);
    await frame();
    const shown = { text: pause.textContent, title: pause.title, w: pause.getBoundingClientRect().width };
    check(`Pause all x${s}: a press's result shows as text (title holds it whole)`, shown.text === resultText && shown.title === resultText && shown.w > pwid + 40, shown);
    await sleep(200);
    const back = { text: pause.textContent, title: pause.title, w: pause.getBoundingClientRect().width };
    check(`Pause all x${s}: after the result time it is the icon again, at the same width`, back.text === '\u23f8' && /^Pause all: type pause/.test(back.title) && Math.abs(back.w - pwid) < 0.5, back);
    tabBar.constructor.PAUSE_RESULT_MS = 4000;
  }

  // --- a squeezed tab's label starts right after the dot and runs to the close button
  // (12 Nov, Michael: "it leaves a lot of space to the left, and I can't see what the tab
  // actually is ... to the left of the dot, there's only one letter"). Measured cause: the
  // drag grip, drawn only on hover, still took 7 px plus a 7 px gap in the flow, so a 90 px
  // tab spent 14 px on nothing before its dot or label. For every tab, at a narrow and a
  // wide window and at both text sizes: the title span begins within 2 px of the dot's
  // right edge plus the gap (of the left padding when there is no dot), ends within 2 px of
  // the close button's left edge minus the gap, and, from a 120 px tab up, shows 6 characters.
  // Visible characters are counted with a Range per character: the text is laid out in full
  // (overflow only clips it), so a character is visible if its box ends before the span's
  // right edge less the width of an "..." when the text is cut.
  const barEl = byId('tab-bar');
  const visibleChars = (span) => {
    const node = span.firstChild;
    const text = node.textContent;
    const sr = span.getBoundingClientRect();
    const cut = span.scrollWidth > span.clientWidth + 0.5;
    const probeEl = document.createElement('span');
    probeEl.textContent = '\u2026';
    probeEl.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:inherit';
    span.appendChild(probeEl);
    const ell = cut ? probeEl.getBoundingClientRect().width : 0;
    probeEl.remove();
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + 1);
      if (r.getBoundingClientRect().right <= sr.right - ell + 0.5) n++; else break;
    }
    return n;
  };
  const layoutTabs = [
    { id: 'p1', title: 'Repeated permission prompts', active: false },
    { id: 'p2', title: 'Calendly personal Gmail account', active: false, parked: { tasks: 1, crons: 0 } },
    { id: 'p3', title: 'generated report build', active: true },
    { id: 'p4', title: 'Fixing the flaky test suite', active: false, parked: { tasks: 1, crons: 0 } },
    { id: 'p5', title: 'bash', active: false },
    { id: 'p6', title: 'Refactor tab strip layout now', active: false, checkpointDone: true },
  ];
  const measured = [];
  for (const winW of [820, 1200]) {
    barEl.style.width = `${winW}px`;
    barEl.style.flex = 'none';
    for (const s of [1, BIG]) {
      await setScale(s);
      tabBar.update(layoutTabs);
      await frame();
      const bad = [];
      let widest = 0;
      for (const t of strip.querySelectorAll('.tab-bar-tab')) {
        const tr = t.getBoundingClientRect();
        const ts = getComputedStyle(t);
        const gap = parseFloat(ts.columnGap);
        const span = t.querySelector('.tab-bar-tab-title');
        const sr = span.getBoundingClientRect();
        const dot = t.querySelector('.tab-bar-tab-indicator');
        const wantLeft = dot ? dot.getBoundingClientRect().right + gap : tr.left + parseFloat(ts.paddingLeft);
        const wantRight = tr.right - parseFloat(ts.paddingRight); // the close button is out of the flow: the title runs to the right padding
        const chars = visibleChars(span);
        const need = Math.min(6, span.textContent.length);
        const firstEl = dot || span;
        const first = firstEl.getBoundingClientRect().left - (tr.left + parseFloat(ts.paddingLeft));
        const row = { tab: t.dataset.tabId, first: +first.toFixed(1), tabW: +tr.width.toFixed(1), left: +(sr.left - wantLeft).toFixed(1), right: +(sr.right - wantRight).toFixed(1), titleW: +sr.width.toFixed(1), chars, dot: !!dot, align: getComputedStyle(span).textAlign };
        widest = Math.max(widest, tr.width);
        if (Math.abs(row.first) > 2 || Math.abs(row.left) > 2 || Math.abs(row.right) > 2 || (tr.width >= 120 && chars < need)) bad.push(row);
        if (s === 1 && winW === 820) measured.push(row);
      }
      check(`label layout (${winW}px window, x${s}): the dot or title starts at the left padding, every title starts after its dot, ends at the right padding, shows 6 characters from a 120px tab`, bad.length === 0 && strip.querySelectorAll('.tab-bar-tab').length === 6, { bad: bad.slice(0, 3), widest });
    }
  }
  check('label layout: measurements of the 820px window at x1 (for the record)', measured.length === 6, measured);

  // --- the drag grip is out of the flow, so its hit area must end where the first item
  // (dot, else title) begins, at every text size: review of 12 Nov found the box 16.8 px wide
  // at x1 and 20 px at x1.5 against a 12 px padding, so pressing or double-clicking the first
  // few px of a label hit the invisible grip (no select, no rename, no window drag). For every
  // tab: the grip box ends at or before the first item's left edge, the point at the glyph's
  // centre is the grip (drag-reorder stays grabbable), and a point 1 px inside the first item
  // is not.
  barEl.style.width = '820px';
  barEl.style.flex = 'none';
  const gripRows = {};
  // Earlier steps leave overlays open (command palette, context menu) that would answer every hit
  // test: any element above the tab bar that answers is made click-through for this block.
  const clickThrough = [];
  const hitAt = (x, y) => {
    for (let i = 0; i < 12; i++) {
      const el = document.elementFromPoint(x, y);
      if (!el || barEl.contains(el) || el === document.body || el === document.documentElement) return el;
      el.style.pointerEvents = 'none';
      clickThrough.push(el);
    }
    return null;
  };
  for (const s of [1, BIG]) {
    await setScale(s);
    tabBar.update(layoutTabs);
    await frame();
    const rows = [];
    for (const t of strip.querySelectorAll('.tab-bar-tab')) {
      const grip = t.querySelector('.tab-bar-tab-grip');
      const first = t.querySelector('.tab-bar-tab-indicator') || t.querySelector('.tab-bar-tab-title');
      const gr = grip.getBoundingClientRect();
      const fr = first.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(grip);
      const glyph = range.getBoundingClientRect();
      const cx = glyph.left + glyph.width / 2;
      const cy = glyph.top + glyph.height / 2;
      const atGlyph = hitAt(cx, cy);
      const insideFirst = hitAt(fr.left + 1, fr.top + fr.height / 2);
      rows.push({
        tab: t.dataset.tabId,
        boxRightOverFirst: +(gr.right - fr.left).toFixed(2),
        glyphRightOverFirst: +(glyph.right - fr.left).toFixed(2),
        boxW: +gr.width.toFixed(1), glyphW: +glyph.width.toFixed(1),
        glyphHit: atGlyph === grip, hitWas: atGlyph && (atGlyph.className + '|' + atGlyph.tagName), pt: [+cx.toFixed(1), +cy.toFixed(1)], gbox: [gr.left, gr.top, gr.right, gr.bottom].map((v) => +v.toFixed(1)), firstHitGrip: insideFirst === grip || (insideFirst && insideFirst.closest('.tab-bar-tab-grip') !== null),
      });
    }
    gripRows[s] = rows;
    const bad = rows.filter((r) => r.boxRightOverFirst > 0.01 || r.glyphRightOverFirst > 0.01 || !r.glyphHit || r.firstHitGrip);
    check(`drag grip x${s}: its box and glyph end before the first item, the glyph centre hits the grip, 1px inside the first item does not`, rows.length === 6 && bad.length === 0, { bad: bad.slice(0, 3), sample: rows[1] });
  }
  for (const el of clickThrough) el.style.pointerEvents = '';
  check('drag grip: measurements, tab 2, x1 and x1.5 (for the record)', true, { x1: gripRows[1][1], big: gripRows[BIG][1] });
  barEl.style.width = '';
  barEl.style.flex = '';
  await setScale(1);

  // --- Michael's usual 13 tabs: all of them stay visible (12 Nov: asked whether squeezed tabs
  // should show 5+ letters with the strip scrolling, their dots going off-screen, or keep every tab
  // and dot visible with crowded tabs showing 1 to 3 letters, he chose "all tabs visible"). With a
  // mix of dots (needs-you, a flag, the red circle, the parked ring) and one active tab, at x1 and
  // x1.5: no horizontal scrolling, every tab and every dot inside the strip.
  // MEASURED LIMIT (13 Nov, after Pause all became an icon and the close button left the flow):
  // all 13 fit from 830 px (x1) / 860 px (x1.5), asserted at 1000 px; before, 1100 / 1220 with the
  // icon alone, ~1200 / ~1300 with the words and a close button a tab. The 13
  // floors are 42 px each (58 with a flag and the red circle) against what the traffic-light
  // padding, settings button, +, spacer, clock and icon leave of the window, so an 820 px window
  // is ~10 px short at x1 and is not asserted. A tab at its floor shows no label at all.
  const thirteen = Array.from({ length: 13 }, (_, i) => ({
    id: `k${i + 1}`,
    title: ['Repeated permission prompts', 'Calendly personal Gmail', 'generated report build', 'Fixing the flaky test suite', 'bash', 'Refactor tab strip layout', 'wake', 'ssh prod-db', 'npm run check', 'Draft the quarterly note', 'git rebase main', 'Patton tabs', 'claude'][i],
    active: i === 2,
    flag: i === 3 ? 'red' : i === 6 ? 'yellow' : undefined,
    checkpointDone: i === 5 || i === 3,
    parked: i === 1 || i === 8 ? { tasks: 1, crons: 0 } : undefined,
    awaitingInput: i === 0 || i === 10,
  }));
  // Fit test for one window width and scale: no horizontal scrolling, every tab and dot inside the strip.
  const fits = async (winW, s) => {
    barEl.style.width = `${winW}px`;
    barEl.style.flex = 'none';
    await setScale(s);
    tabBar.update(thirteen);
    await frame();
    const sr = strip.getBoundingClientRect();
    const rows = [];
    for (const t of strip.querySelectorAll('.tab-bar-tab')) {
      const tr = t.getBoundingClientRect();
      const dot = t.querySelector('.tab-bar-tab-indicator');
      const dr = dot ? dot.getBoundingClientRect() : null;
      rows.push({
        tab: t.dataset.tabId, w: +tr.width.toFixed(1),
        inStrip: tr.left >= sr.left - 0.5 && tr.right <= sr.right + 0.5,
        dotInTab: !dr || (dr.left >= tr.left - 0.5 && dr.right <= tr.right + 0.5 && dr.width > 0),
        dotInStrip: !dr || (dr.left >= sr.left - 0.5 && dr.right <= sr.right + 0.5),
      });
    }
    const info = { stripW: +sr.width.toFixed(1), scrollW: strip.scrollWidth, scrolls: strip.scrollWidth > strip.clientWidth + 0.5, widths: rows.map((r) => r.w) };
    const bad = rows.filter((r) => !r.inStrip || !r.dotInTab || !r.dotInStrip);
    return { ok: rows.length === 13 && !info.scrolls && bad.length === 0, bad: bad.slice(0, 4), ...info };
  };
  const minFit = {};
  for (const s of [1, BIG]) {
    let found = null;
    for (let w = 500; w <= 1500 && !found; w += 10) if ((await fits(w, s)).ok) found = w;
    minFit[s] = found;
  }
  check('13 tabs: the smallest window width (10px steps) at which all fit, x1 and x' + BIG + ' (was ~1200 and ~1300 before 13 Nov)', minFit[1] !== null && minFit[BIG] !== null, minFit);
  for (const [winW, s] of [[1000, 1], [1000, BIG]]) {
    const r = await fits(winW, s);
    const { ok, ...detail } = r;
    check(`13 tabs in a ${winW}px window, x${s}: all fit with no scrolling, every tab and dot inside the strip`, ok, detail);
  }

  // --- the close button: out of the flow, shown only over its tab (13 Nov: ~20 px a tab back).
  // Hover is real: the page asks main for a mouseMove through sendInputEvent (see electronMain).
  // The command palette check above leaves its overlay open over the whole window, which
  // would take every hover: close it for this section and put it back after.
  const overlays = [...document.querySelectorAll('.visible')].filter((e) => /overlay|backdrop/.test(e.className));
  for (const o of overlays) o.classList.remove('visible');
  barEl.style.width = '1200px';
  barEl.style.flex = 'none';
  const hoverTabs = [
    { id: 'h1', title: 'Repeated permission prompts', active: false },
    { id: 'h2', title: 'Calendly personal Gmail', active: true },
    { id: 'h3', title: 'bash', active: false },
  ];
  for (const s of [1, BIG]) {
    await setScale(s);
    tabBar.update(hoverTabs);
    await frame();
    const tabOf = (id) => strip.querySelector(`.tab-bar-tab[data-tab-id="${id}"]`);
    const closeOf = (id) => tabOf(id).querySelector('.tab-bar-tab-close');
    const centre = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const state = (id) => {
      const c = closeOf(id);
      const cs = getComputedStyle(c);
      const [cx, cy] = centre(c);
      return { opacity: cs.opacity, events: cs.pointerEvents, position: cs.position, hit: document.elementFromPoint(cx, cy) === c };
    };
    // Pointer parked over the terminal area, away from every tab.
    const [px, py] = [600, 700];
    await hoverAt(px, py);
    const rows = ['h1', 'h2', 'h3'].map((id) => {
      const t = tabOf(id);
      const tr = t.getBoundingClientRect();
      const ts = getComputedStyle(t);
      const title = t.querySelector('.tab-bar-tab-title').getBoundingClientRect();
      return { id, gap: +(tr.right - parseFloat(ts.paddingRight) - title.right).toFixed(1), ...state(id) };
    });
    check(`close x${s}: no tab is hovered, so no close button is visible (selected tab included), none takes a click`, rows.every((r) => r.opacity === '0' && r.events === 'none' && !r.hit), rows);
    check(`close x${s}: without hover it takes no room: every label's right edge reaches the tab's right padding (within 2px), and the button is out of the flow`, rows.every((r) => Math.abs(r.gap) <= 2 && r.position === 'absolute'), rows);
    const hovered = {};
    for (const id of ['h1', 'h2', 'h3']) {
      const [tx, ty] = centre(tabOf(id).querySelector('.tab-bar-tab-title'));
      await hoverAt(tx, ty);
      hovered[id] = { self: state(id), others: ['h1', 'h2', 'h3'].filter((o) => o !== id).map((o) => state(o).opacity), isHover: tabOf(id).matches(':hover') };
    }
    check(`close x${s}: hovering a tab (real mouseMove) shows its own close button, reachable at its centre, and no other tab's`, Object.values(hovered).every((h) => h.isHover && h.self.opacity === '1' && h.self.events === 'auto' && h.self.hit && h.others.every((o) => o === '0')), hovered);
    // The button sits on the tab's own ground and inside the tab, over its right end.
    await hoverAt(...centre(tabOf('h1').querySelector('.tab-bar-tab-title')));
    const c1 = closeOf('h1'); const t1 = tabOf('h1');
    await sleep(300); // both backgrounds transition (0.12-0.15 s)
    const hoverGround = getComputedStyle(t1).backgroundColor;
    const cr = c1.getBoundingClientRect(); const tr1 = t1.getBoundingClientRect();
    check(`close x${s}: hovered, it paints the tab's hover ground and lies inside the tab's right end`, getComputedStyle(c1).backgroundColor === hoverGround && cr.right <= tr1.right + 0.5 && cr.left > tr1.left + tr1.width / 2, { close: getComputedStyle(c1).backgroundColor, tab: hoverGround, cr: [cr.left, cr.right], tabBox: [tr1.left, tr1.right] });
    await hoverAt(px, py);
    // Keyboard: Tab onto the close button of an unhovered tab shows it (:focus-visible).
    const c3 = closeOf('h3');
    await sendInput({ type: 'keyDown', keyCode: 'Tab' });
    await sendInput({ type: 'keyUp', keyCode: 'Tab' });
    const reached = [];
    for (let i = 0; i < 40 && document.activeElement !== c3; i++) {
      if (document.activeElement && document.activeElement.classList.contains('tab-bar-tab-close')) reached.push(document.activeElement.getAttribute('aria-label'));
      await sendInput({ type: 'keyDown', keyCode: 'Tab' });
      await sendInput({ type: 'keyUp', keyCode: 'Tab' });
    }
    const kf = { focused: document.activeElement === c3, focusVisible: c3.matches(':focus-visible'), pageFocus: document.hasFocus(), ...state('h3'), hovered: tabOf('h3').matches(':hover') };
    check(`close x${s}: Tab-key focus on an unhovered tab's close button shows it and keeps it clickable (keyboard users can still reach it)`, kf.focused && kf.focusVisible && !kf.hovered && kf.opacity === '1' && kf.events === 'auto' && kf.hit, { ...kf, reached });
    if (document.activeElement) document.activeElement.blur();
  }
  tabBar.update([{ id: 'solo', title: 'only tab', active: true }]);
  await frame();
  check('close: a single tab has no close button', strip.querySelectorAll('.tab-bar-tab-close').length === 0);
  await hoverAt(600, 700);
  for (const o of overlays) o.classList.add('visible');
  tabBar.update(withActive('m1'));
  barEl.style.width = '';
  barEl.style.flex = '';
  await setScale(1);

  // An automatic name arrives cut to 15 characters (Tab.displayTitle); the tab keeps the
  // full title for its tooltip and screen-reader label, and the hidden bold copy follows
  // the shown text, so the width is the short name's.
  tabBar.update([{ id: 'n1', title: 'Repeated permission prompts', displayTitle: 'Repeated permi\u2026', active: true }, { id: 'n2', title: 'a-project-with-a-long-name', active: false }]);
  await frame();
  const n1 = strip.querySelector('.tab-bar-tab[data-tab-id="n1"]');
  const n2 = strip.querySelector('.tab-bar-tab[data-tab-id="n2"]');
  const n1t = n1.querySelector('.tab-bar-tab-title');
  check('auto name: the tab shows the 15-character name, its width copy too', n1t.textContent === 'Repeated permi\u2026' && n1t.dataset.title === 'Repeated permi\u2026' && n1t.textContent.length <= 15, { text: n1t.textContent, data: n1t.dataset.title });
  check('auto name: the full title stays in the accessible name (and the native tooltip, when the hover card is off)', n1.getAttribute('aria-label') === 'Repeated permission prompts' && (n1.title === 'Repeated permission prompts' || n1.title === ''), { aria: n1.getAttribute('aria-label'), title: n1.title });
  check('auto name: a title sent with no short name (a project\'s) is untouched', n2.querySelector('.tab-bar-tab-title').textContent === 'a-project-with-a-long-name');
  tabBar.update(withActive('m30'));
  await frame();

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
