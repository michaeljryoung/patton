// End-to-end check of the session bar (docs/session-bar.md, THE MAP's "Done when" and D1-D13;
// map node bar_e2e). Written from the DESIGN by an agent that did not build the feature, and it
// measures what a person could see; it reads no private state of the bar.
//
// ONE hidden Electron process hosts both halves, joined by real IPC:
//   main side:     a REAL PtyManager (real node-pty, real zsh) and the REAL session-feed
//                  handlers (src/main/session-feed-ipc.ts: session link, transcript tail,
//                  parser) answer a window that is never shown;
//   renderer side: the REAL TabManager, Tab, Pane, terminal and session bar, real CSS, with a
//                  bridge whose pty and sessionFeed calls go straight to those main objects
//                  (everything else is a stub). Every event the bar gets crossed the real IPC.
// A fake Claude session runs under a temporary HOME: `sh fake-claude.sh <sessionId>` typed into the
// pane's real pty. It is a real child of the pty's shell, writes
// <HOME>/.claude/sessions/<pid>.json, and prints the OSC 7501 report `app=claude-code` and an OSC 777
// Stop message with a context reading into the real pty (so the report reaches the pane's terminal as
// bytes from the pty). The transcript <HOME>/.claude/projects/<slug>/<sessionId>.jsonl grows by
// lines in the real shapes (scripts/fixtures/session-feed-lines.jsonl, check-session-link.mjs).
//
// Per UI scale (1, 1.1, 1.5) it asserts, numbered as in the brief:
//   1 a background shell's start line -> a Running row with its description within 1 s
//   2 its notice (completed) -> the row struck through within 1 s, gone after the 30 s linger
//   3 a failed notice -> a Failures row that stays until its x is pressed; the minimized strip's
//     failure count follows it
//   4 a link written twice -> one Links row, moved to the top; `Plan v2.docx` after `Plan.docx` -> one row, the v2
//   5 the checkpoint clock is in the bar's Checkpoint section and not on the tab strip (D7)
//   6 the fold button folds the bar to the strip (and the terminal gets the width), the open button restores it
//   7 a plain-shell tab has no bar
//   8 /clear (the sessions file's sessionId changes): detach, then attach to the new transcript
// plus `0` (the session attaches) and `Na` lines that check the main-side event itself.
//
// Time: the 30 s linger is not waited for in real time. The page's Date.now() (what the bar reads
// as "now") is moved 31 s forward after the notices, then the bar's own 10 s tick must remove the
// ended rows. Transcript timestamps and file times stay real (`new Date()` is not affected).
//
// Run: node scripts/check-session-bar-e2e.cjs
//   SB_E2E_SRC_ROOT=<folder holding src/>  bundle another source tree (proves the check bites: run it on main)
//   SB_E2E_DIR=<folder>                    where bundles, userData and the result go (default: temp, removed after)
//   SB_E2E_SCALES=1,1.1,1.5                UI text scales to run
// Prints `ok <what>` or `not ok <what>: <measured>`; exit 1 on any failure.
// Same file twice: under Node it bundles and starts Electron on itself; under Electron it runs.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HARD_TIMEOUT_MS = 300000;
const SCALES = process.env.SB_E2E_SCALES ? process.env.SB_E2E_SCALES.split(',').map(Number) : [1, 1.1, 1.5];

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
  const srcRoot = process.env.SB_E2E_SRC_ROOT ? path.resolve(process.env.SB_E2E_SRC_ROOT) : repo;
  const ownDir = !process.env.SB_E2E_DIR;
  const outDir = process.env.SB_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'patton-check-sb-e2e-'));
  fs.mkdirSync(outDir, { recursive: true });
  const resultFile = path.join(outDir, 'result.json');
  fs.rmSync(resultFile, { force: true });
  const hasFeedIpc = fs.existsSync(path.join(srcRoot, 'src/main/session-feed-ipc.ts'));

  // The renderer: the real TabManager (tabs, panes, terminals, the bar if the tree has one).
  await build({
    stdin: {
      resolveDir: srcRoot,
      loader: 'ts',
      contents: `
        import { TabManager } from './src/renderer/services/tab-manager';
        import { applyUiTextScale } from './src/renderer/services/ui-text-scale';
        import { IPC } from './src/shared/constants';
        import { SESSION_FEED_IPC } from './src/shared/session-feed';
        (window as any).__e2e = { TabManager, applyUiTextScale, IPC, SESSION_FEED_IPC };
      `,
    },
    bundle: true, platform: 'browser', format: 'iife', outfile: path.join(outDir, 'page.js'),
    nodePaths: [path.join(repo, 'node_modules')],
    loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  // node-pty is native: left out of the bundle, and reached through a shim that gives the CJS module
  // the `default` export Vite's interop gives it in the real build (esbuild's __esModule check differs).
  const ptyReal = path.join(repo, 'node_modules/node-pty');
  // npm leaves node-pty's prebuilt spawn-helper without its execute bit (posix_spawnp then fails);
  // Forge fixes it for the packaged app, so do the same here, in this checkout's node_modules only.
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    const helper = path.join(ptyReal, 'prebuilds', arch, 'spawn-helper');
    try { if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755); } catch { /* read-only: the spawn will say so */ }
  }
  const ptyShim = path.join(outDir, 'node-pty-shim.cjs');
  fs.writeFileSync(ptyShim, `const m = require(${JSON.stringify(ptyReal)}); module.exports = Object.assign({}, m, { default: m });\n`);
  // Main: the real PtyManager and (where the tree has it) the real session-feed handlers.
  await build({
    stdin: {
      resolveDir: srcRoot,
      loader: 'ts',
      contents: `
        import { PtyManager } from './src/main/pty-manager';
        ${hasFeedIpc ? "import { registerSessionFeedHandlers } from './src/main/session-feed-ipc';" : ''}
        module.exports = { PtyManager, registerSessionFeedHandlers: ${hasFeedIpc ? 'registerSessionFeedHandlers' : 'null'} };
      `,
    },
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(outDir, 'main.cjs'),
    nodePaths: [path.join(repo, 'node_modules')],
    alias: { 'node-pty': ptyShim }, external: ['electron', ptyReal], logLevel: 'silent',
  });
  const sheets = ['main', 'tabs', 'terminal', 'editor', 'settings', 'board', 'session-bar']
    .filter((n) => fs.existsSync(path.join(srcRoot, 'src/renderer/styles', n + '.css')))
    .map((n) => fs.readFileSync(path.join(srcRoot, 'src/renderer/styles', n + '.css'), 'utf8'));
  fs.writeFileSync(path.join(outDir, 'page.css'),
    fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8') + '\n' + sheets.join('\n'));
  // The real index.html's skeleton.
  fs.writeFileSync(path.join(outDir, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head><body>' +
    '<div id="app"><div id="tab-bar"></div><div id="main"><div id="content"></div></div></div>' +
    '<script src="page.js"></script></body></html>');
  // The fake Claude: a child of the pty's shell that registers itself the way Claude Code does.
  fs.writeFileSync(path.join(outDir, 'fake-claude.sh'), [
    '#!/bin/sh',
    'mkdir -p "$HOME/.claude/sessions"',
    'NOW=$(date +%s)',
    `printf '{"pid":%s,"sessionId":"%s","cwd":"%s","startedAt":%s000,"version":"2.1.321","kind":"interactive","status":"idle","updatedAt":%s000}\\n' "$$" "$1" "$PWD" "$NOW" "$NOW" > "$HOME/.claude/sessions/$$.json"`,
    `printf '\\033]7501;state=idle:app=claude-code\\007'`,
    `printf '\\033]777;patton;stop;tasks=0;crons=0;ctx=120000;since=4000;cpt=%s\\007' "$((NOW - 300))"`,
    'exec sleep 3600',
    '',
  ].join('\n'));

  const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if (!fs.existsSync(__filename) || !fs.existsSync(electronBin)) {
    console.error('missing script or Electron binary (run `npx install-electron --no` once)', { script: __filename, electronBin });
    process.exit(2);
  }
  const log = fs.openSync(path.join(outDir, 'electron.log'), 'w');
  const env = { ...process.env, SB_E2E_DIR: outDir, SB_E2E_SCALES: SCALES.join(',') };
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
  if (result.error && !result.checks) {
    console.error('check errored:', result.error, `(log: ${path.join(outDir, 'electron.log')})`);
    process.exit(2);
  }
  if (ownDir) fs.rmSync(outDir, { recursive: true, force: true });
  if (srcRoot !== repo) console.log(`(source tree: ${srcRoot}; session-feed handlers ${hasFeedIpc ? 'present' : 'absent'})`);
  let failed = 0;
  for (const c of result.checks) {
    if (!c.ok) failed++;
    console.log(c.ok ? `ok ${c.name}` : `not ok ${c.name}: ${JSON.stringify(c.detail)}`);
  }
  if (result.error) {
    failed++;
    console.log(`not ok the page ran to the end: ${result.error}`);
  }
  console.log('\nMeasured:');
  for (const m of result.measures || []) console.log('  ' + m);
  console.log(`\n${result.checks.length - (failed - (result.error ? 1 : 0))} ok, ${failed} not ok`);
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------ Electron side
function electronMain() {
  const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
  const os = require('node:os');
  const outDir = process.env.SB_E2E_DIR;
  const resultFile = path.join(outDir, 'result.json');
  const write = (obj) => fs.writeFileSync(resultFile, JSON.stringify(obj, null, 1));
  app.setPath('userData', path.join(outDir, 'ud'));
  if (app.dock) app.dock.hide();
  let ptyManager = null;
  const bail = (why) => {
    try { write({ error: why }); } catch { /* the parent reports "no result" */ }
    try { ptyManager?.destroyAll(); } catch { /* gone */ }
    app.exit(1);
  };
  setTimeout(() => bail('timeout'), HARD_TIMEOUT_MS);

  app.whenReady().then(async () => {
    try {
      nativeTheme.themeSource = 'light';
      // The temporary HOME: everything the session link reads lives under it.
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-home-')));
      process.env.HOME = home;
      delete process.env.ZDOTDIR;
      process.env.SHELL = '/bin/zsh';
      const win = new BrowserWindow({
        show: false, width: 1600, height: 1000,
        webPreferences: { backgroundThrottling: false, contextIsolation: false, nodeIntegration: true },
      });
      const main = require(path.join(outDir, 'main.cjs'));
      ptyManager = new main.PtyManager();
      ptyManager.shellIntegrationEnabled = false;
      ipcMain.handle('e2e:pty-create', (_e, opts) => ptyManager.create(win, { ...(opts || {}), shell: '/bin/zsh' }));
      ipcMain.on('e2e:pty-write', (_e, id, data) => { try { ptyManager.write(id, data); } catch { /* gone */ } });
      ipcMain.on('e2e:pty-resize', (_e, id, c, r) => { try { ptyManager.resize(id, c, r); } catch { /* gone */ } });
      ipcMain.on('e2e:pty-destroy', (_e, id) => { try { ptyManager.destroy(id); } catch { /* gone */ } });
      ipcMain.handle('e2e:pty-cwd', (_e, id) => ptyManager.getCwd(id));
      if (main.registerSessionFeedHandlers) main.registerSessionFeedHandlers(ptyManager);

      await win.loadFile(path.join(outDir, 'page.html'));
      win.webContents.focus();
      const cfg = { scales: SCALES_FROM_ENV(), home, fakeClaude: path.join(outDir, 'fake-claude.sh'), hasFeed: !!main.registerSessionFeedHandlers };
      const result = await win.webContents.executeJavaScript(`(${pageRun.toString()})(${JSON.stringify(cfg)})`);
      write(result);
      try { ptyManager.destroyAll(); } catch { /* gone */ }
      await new Promise((r) => setTimeout(r, 300)); // the shells' last writes (history) land first
      try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a temp folder; the OS clears it */ }
      app.exit(0);
    } catch (err) {
      bail(String((err && err.stack) || err));
    }
  });
}

function SCALES_FROM_ENV() {
  return process.env.SB_E2E_SCALES.split(',').map(Number);
}

// Runs inside the page. Self-contained: it is sent as source text.
async function pageRun(cfg) {
  const U = window.__e2e;
  const { ipcRenderer } = window.require('electron');
  const nfs = window.require('fs');
  const nodePath = window.require('path');
  const checks = [];
  const measures = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: ok ? null : detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // ---- the bar reads "now" from Date.now(); the linger test moves it (see the header)
  const realNow = Date.now.bind(Date);
  let skewMs = 0;
  Date.now = () => realNow() + skewMs;

  // ---- the bridge: pty and sessionFeed are real (through main); the rest answers and does nothing
  const feedLog = []; // every event main sent, as the renderer got it
  const answers = {
    'pty.respawn': () => 2, 'pty.getShell': () => '/bin/zsh', 'pty.inputState': () => [{ dirty: false, length: 0, lastInputAt: 0, slashSubmitAt: 0, userStashAt: 0, pattonStashAt: 0 }],
    'history.get': () => [], 'pauseAll.stashKey': () => ({ ok: true }), 'settings.get': () => ({}), 'session.get': () => null,
    'projects.getNames': () => ({}), 'projects.resolve': () => null,
  };
  const stub = (name) => new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : stub(name ? name + '.' + String(k) : String(k))),
    apply: (_t, _this, args) => {
      void args;
      const last = name.split('.').pop();
      if (/^on[A-Z]/.test(last)) return () => {};
      return Promise.resolve(answers[name] ? answers[name]() : undefined);
    },
  });
  const real = {
    pty: {
      create: (opts) => ipcRenderer.invoke('e2e:pty-create', opts),
      write: (id, data) => ipcRenderer.send('e2e:pty-write', id, data),
      resize: (id, c, r) => ipcRenderer.send('e2e:pty-resize', id, c, r),
      destroy: (id) => ipcRenderer.send('e2e:pty-destroy', id),
      getCwd: (id) => ipcRenderer.invoke('e2e:pty-cwd', id),
      onData: (cb) => { const l = (_e, id, d) => cb(id, d); ipcRenderer.on(U.IPC.PTY_DATA, l); return () => ipcRenderer.removeListener(U.IPC.PTY_DATA, l); },
      onExit: (cb) => { const l = (_e, id, c) => cb(id, c); ipcRenderer.on(U.IPC.PTY_EXIT, l); return () => ipcRenderer.removeListener(U.IPC.PTY_EXIT, l); },
      onTitle: (cb) => { const l = (_e, id, t) => cb(id, t); ipcRenderer.on(U.IPC.PTY_TITLE, l); return () => ipcRenderer.removeListener(U.IPC.PTY_TITLE, l); },
    },
    // The same calls as preload.ts makes: the real channels, so main's real ownership check runs.
    sessionFeed: {
      watch: (ptyId, hint) => ipcRenderer.invoke(U.SESSION_FEED_IPC.WATCH, ptyId, hint),
      unwatch: (ptyId) => ipcRenderer.invoke(U.SESSION_FEED_IPC.UNWATCH, ptyId),
      onEvent: (cb) => {
        const l = (_e, ptyId, event) => { feedLog.push({ ptyId, ev: event, t: performance.now() }); cb(ptyId, event); };
        ipcRenderer.on(U.SESSION_FEED_IPC.EVENT, l);
        return () => ipcRenderer.removeListener(U.SESSION_FEED_IPC.EVENT, l);
      },
    },
  };
  const layer = (name, obj) => new Proxy(obj, { get: (t, k) => (k in t ? t[k] : stub(name + '.' + String(k))) });
  window.patton = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'then') return undefined;
      if (k in real) return layer(String(k), real[k]);
      return stub(String(k));
    },
  });

  // ---- measuring helpers: from the design's words, not from the bar's code
  const visible = (el) => {
    if (!el || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const minBtn = () => document.querySelector('[aria-label="Minimize the session bar"]');
  const openBtn = () => document.querySelector('[aria-label="Open the session bar"]');
  const barRoot = () => { const b = minBtn() || openBtn(); return b ? (b.closest('aside') || b.closest('[aria-label^="Session bar"]')) : null; };
  const barState = () => (visible(minBtn()) ? 'open' : visible(openBtn()) ? 'strip' : 'hidden');
  const headings = (root) => Array.from(root.querySelectorAll('h1,h2,h3,h4,[role="heading"]'));
  /** A section of the open bar by its heading ("Running", "Failures", "Links", "Checkpoint"). */
  const section = (name) => {
    const root = barRoot();
    if (!root) return null;
    const h = headings(root).find((x) => norm(x.textContent).toLowerCase().startsWith(name.toLowerCase()));
    return h ? (h.closest('section') || h.parentElement) : null;
  };
  const rows = (name) => {
    const s = section(name);
    if (!s || barState() !== 'open') return [];
    return Array.from(s.querySelectorAll('li')).filter((li) => visible(li) && !/^nothing/i.test(norm(li.textContent)));
  };
  /** Everything a row says: its text, tooltip and accessible name. */
  const said = (li) => norm([li.textContent, li.title, li.getAttribute('aria-label'),
    ...Array.from(li.querySelectorAll('[title],[aria-label]')).map((e) => (e.title || '') + ' ' + (e.getAttribute('aria-label') || ''))].join(' '));
  const rowWith = (name, text) => rows(name).find((li) => said(li).includes(text)) || null;
  const struck = (li) => [li, ...li.querySelectorAll('*')].some((e) => /line-through/.test(getComputedStyle(e).textDecorationLine));
  const strip = () => {
    const root = barRoot();
    if (!root || barState() !== 'strip') return null;
    const leaves = Array.from(root.querySelectorAll('*')).filter((e) => e.children.length === 0 && visible(e) && /^\d+$/.test(norm(e.textContent)));
    return { running: leaves[0] ? Number(norm(leaves[0].textContent)) : null, failures: leaves[1] ? Number(norm(leaves[1].textContent)) : null, failureEl: leaves[1] || null };
  };
  const waitFor = async (pred, ms, step = 10) => {
    const t0 = performance.now();
    for (;;) {
      let v = null;
      try { v = pred(); } catch { v = null; }
      if (v) return { v, ms: performance.now() - t0 };
      if (performance.now() - t0 > ms) return null;
      await sleep(step);
    }
  };

  // ---- the session under test
  const SLUG = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
  const projDir = nodePath.join(cfg.home, '.claude', 'projects', SLUG(cfg.home));
  const sessDir = nodePath.join(cfg.home, '.claude', 'sessions');
  nfs.mkdirSync(projDir, { recursive: true });
  nfs.mkdirSync(sessDir, { recursive: true });
  let uuidN = 0;
  const hex = (n) => String(n).padStart(12, '0');
  const sid = (n) => `${hex(n).slice(0, 8)}-2222-4333-8444-${hex(n)}`;
  const mk = (session) => {
    const base = () => ({ isSidechain: false, userType: 'external', cwd: cfg.home, sessionId: session, version: '2.1.321', timestamp: new Date().toISOString() });
    const uid = () => `10000000-0000-4000-8000-${hex(++uuidN)}`;
    const L = (o) => JSON.stringify(o) + '\n';
    return {
      toolUse: (id, command, description) => L({ parentUuid: uid(), ...base(), type: 'assistant', uuid: uid(), message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description, run_in_background: true } }] } }),
      started: (id, task) => L({ parentUuid: uid(), ...base(), type: 'user', uuid: uid(), message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: `Command running in background with ID: ${task}. Output is being written to: /tmp/x/${task}.output` }] }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: task } }),
      notice: (task, status, summary) => {
        const body = `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<output-file>/tmp/x/${task}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
        // as Claude Code writes it: the queue line, then the delivered copy
        return L({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), sessionId: session, content: body })
          + L({ parentUuid: uid(), ...base(), type: 'attachment', uuid: uid(), attachment: { type: 'queued_command', prompt: body } });
      },
      say: (text) => L({ parentUuid: uid(), ...base(), type: 'assistant', uuid: uid(), message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] } }),
      user: (text) => L({ parentUuid: uid(), ...base(), type: 'user', uuid: uid(), message: { role: 'user', content: text } }),
    };
  };

  const tm = new U.TabManager(document.getElementById('tab-bar'), document.getElementById('content'));
  tm.setRenderer('dom');

  const events = (ptyId, type) => feedLog.filter((e) => e.ptyId === ptyId && e.ev.type === type);

  const screenText = (term) => { const b = term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const t = b.getLine(i)?.translateToString(true); if (t) out.push(t); } return out.slice(-6).join(' | '); };

  async function newTab() {
    const tab = await tm.createTab();
    const pane = tab.focusedPane;
    const term = pane.terminalView.terminal;
    await waitFor(() => (term.buffer.active.getLine(0)?.translateToString(true) || '').length > 0, 8000, 50); // the shell's prompt
    await sleep(300);
    return { tab, pane, term };
  }

  async function runScale(scale) {
    const S = `[scale ${scale}]`;
    const n = (id, what) => `${id}. ${what} ${S}`;
    U.applyUiTextScale(scale, 'change');
    await sleep(250);

    // A plain-shell tab first, then the Claude tab.
    const plain = await newTab();
    await sleep(400);
    const plainShowsBar = barState() !== 'hidden';
    const claude = await newTab();
    const ptyId = claude.pane.ptyId;
    const session = sid(Math.round(scale * 100) + 1);
    const T = mk(session);
    const transcript = nodePath.join(projDir, `${session}.jsonl`);
    nfs.writeFileSync(transcript, T.user('hello'));
    ipcRenderer.send('e2e:pty-write', ptyId, `sh ${cfg.fakeClaude} ${session}\r`);

    const att = await waitFor(() => events(ptyId, 'attached').find((e) => e.ev.sessionId === session), 8000, 25);
    check(n(0, 'the session attaches (main side: real pty, session link, tail; event reaches the pane)'),
      att && att.v.ev.how === 'sessions-file', att ? att.v.ev : { sawEvents: feedLog.map((e) => e.ev.type), sessionsDir: nfs.readdirSync(sessDir), screen: screenText(claude.term), isClaudePane: claude.pane.isClaudePane });
    const shown = await waitFor(() => barState() !== 'hidden', 4000, 25);
    const claudePid = (() => { try { for (const f of nfs.readdirSync(sessDir)) { const o = JSON.parse(nfs.readFileSync(nodePath.join(sessDir, f), 'utf8')); if (o.sessionId === session) return { pid: o.pid, file: nodePath.join(sessDir, f), o }; } } catch { /* none */ } return null; })();

    // ---- 7 (first half is above): bar on the Claude tab, none on the plain tab
    let plainAfter = null;
    if (shown) {
      tm.switchToId(plain.tab.id); await sleep(500);
      plainAfter = barState();
      tm.switchToId(claude.tab.id); await sleep(500);
    }
    check(n(7, 'a Claude tab has the bar and a plain-shell tab has none'),
      shown && !plainShowsBar && plainAfter === 'hidden' && barState() !== 'hidden', { shown: !!shown, plainShowsBar, plainAfter, back: barState() });

    if (!shown || !claudePid) {
      // Nothing more can be observed: each remaining assertion fails with the reason.
      for (const [id, what] of [[1, 'a shell start line gives a Running row with its description within 1 s'], ['1a', 'the shell\'s task-start event reached the pane'],
        [2, 'its notice strikes the row within 1 s and it is gone after the linger'], ['2a', 'the completed task-end event reached the pane'],
        [3, 'a failed notice gives a Failures row kept until its x; the strip count follows'], ['3a', 'the failed task-end event reached the pane'],
        [4, 'a link written twice gives one row, moved to the top; Plan v2 replaces Plan'], ['4a', 'link events reached the pane'], ['4b', 'markdown and bare in one message keeps the markdown label'],
        [5, 'the checkpoint clock is in the bar and not on the tab strip'], [6, 'the fold button folds the bar to the strip and the open button restores it'],
        [8, '/clear detaches and re-attaches to the new transcript']]) check(n(id, what), false, 'no session bar on the Claude tab' + (claudePid ? '' : ' (and no fake Claude session found)'));
      return;
    }

    // ---- 5: the checkpoint clock lives in the bar (the Stop message gave it a reading)
    await waitFor(() => /\d+\s*%/.test(norm(section('checkpoint')?.textContent)), 3000, 50);
    const secs = Array.from(barRoot().querySelectorAll('section'));
    const ckSec = section('checkpoint');
    const ckText = norm(ckSec?.textContent);
    const tabBar = document.getElementById('tab-bar');
    const clocksOnStrip = Array.from(tabBar.querySelectorAll('button, [role="button"]')).filter((b) => visible(b)
      && (/^\s*✓/.test(b.textContent || '') || /\/checkpoint/i.test(`${b.title} ${b.getAttribute('aria-label') || ''}`)));
    const ckBtn = ckSec && Array.from(ckSec.querySelectorAll('button')).find((b) => /checkpoint/i.test(norm(b.textContent) + (b.getAttribute('aria-label') || '')));
    check(n(5, 'the checkpoint clock is the bar\'s last section (percent, last age, a Checkpoint button) and is not on the tab strip (D7)'),
      ckSec && /\d+\s*%/.test(ckText) && /context/i.test(ckText) && !!ckBtn && secs[secs.length - 1] === ckSec && clocksOnStrip.length === 0,
      { checkpointSection: ckText || null, button: !!ckBtn, last: secs[secs.length - 1] === ckSec, clockOnTabStrip: clocksOnStrip.map((b) => norm(b.textContent)) });

    // ---- 1: a background shell's start line -> a Running row within 1 s
    const DESC_A = 'Build the demo app';
    const CMD_A = 'npm run build-demo';
    nfs.appendFileSync(transcript, T.toolUse('toolu_a', CMD_A, DESC_A));
    const t0a = performance.now();
    nfs.appendFileSync(transcript, T.started('toolu_a', 'bgshellaa'));
    const rowA = await waitFor(() => rowWith('running', DESC_A), 3000, 10);
    const dtA = rowA ? performance.now() - t0a : null;
    check(n(1, 'a background shell\'s start line gives a Running row with its description within 1 s'),
      rowA && dtA <= 1000 && /shell/i.test(said(rowA.v)) && said(rowA.v).includes(CMD_A), { ms: dtA, row: rowA ? said(rowA.v) : null });
    if (dtA !== null) measures.push(`${S} Running row ${Math.round(dtA)} ms after the start line`);
    const startEv = events(ptyId, 'task-start').find((e) => e.ev.id === 'bgshellaa');
    check(n('1a', 'main side: a task-start event (shell, description, command) reached the pane'),
      startEv && startEv.ev.kind === 'shell' && startEv.ev.description === DESC_A && startEv.ev.command === CMD_A, startEv && startEv.ev);

    // a second shell, which will fail
    const DESC_B = 'Run the flaky tests';
    nfs.appendFileSync(transcript, T.toolUse('toolu_b', 'npm test', DESC_B));
    nfs.appendFileSync(transcript, T.started('toolu_b', 'bgshellbb'));
    await waitFor(() => rowWith('running', DESC_B), 3000, 10);

    // ---- 2: its notice -> struck within 1 s
    const t0n = performance.now();
    nfs.appendFileSync(transcript, T.notice('bgshellaa', 'completed', `Background command "${DESC_A}" completed (exit code 0)`));
    const struckA = await waitFor(() => { const r = rowWith('running', DESC_A); return r && struck(r) ? r : null; }, 3000, 10);
    const dtS = struckA ? performance.now() - t0n : null;
    check(n(2, 'its notice (completed) strikes the Running row through within 1 s'), struckA && dtS <= 1000, { ms: dtS, row: rowWith('running', DESC_A) ? 'present, not struck' : 'row missing' });
    if (dtS !== null) measures.push(`${S} struck ${Math.round(dtS)} ms after the notice`);
    check(n('2a', 'main side: the task-end (completed, exit 0) reached the pane'),
      events(ptyId, 'task-end').some((e) => e.ev.id === 'bgshellaa' && e.ev.status === 'completed'), events(ptyId, 'task-end').map((e) => e.ev));

    // ---- 3: a failed notice -> Failures row
    nfs.appendFileSync(transcript, T.notice('bgshellbb', 'failed', `Background command "${DESC_B}" failed with exit code 3`));
    const failRow = await waitFor(() => rowWith('failures', DESC_B), 3000, 10);
    const failTxt = failRow ? said(failRow.v) : '';
    const dismiss = () => { const r = rowWith('failures', DESC_B); return r && Array.from(r.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Dismiss' || norm(b.textContent) === '×'); };
    check(n(3, 'a failed notice gives one Failures row with its description, exit code and a Dismiss x'),
      failRow && rows('failures').filter((li) => said(li).includes(DESC_B)).length === 1 && /\b3\b/.test(failTxt) && !!dismiss(), { failures: rows('failures').map(said) });
    check(n('3a', 'main side: the task-end (failed, exit 3) reached the pane'),
      events(ptyId, 'task-end').some((e) => e.ev.id === 'bgshellbb' && e.ev.status === 'failed' && e.ev.exitCode === 3), events(ptyId, 'task-end').map((e) => e.ev));

    // ---- 2 (second half): the ended rows linger, then go; the failure stays
    await sleep(2000);
    const stillThere = !!rowWith('running', DESC_A) && !!rowWith('running', DESC_B);
    skewMs = 31000; // the bar's "now" is 31 s on; its own 10 s tick must drop the ended rows
    const gone = await waitFor(() => !rowWith('running', DESC_A) && !rowWith('running', DESC_B), 13000, 50);
    skewMs = 0;
    check(n(2, 'the struck rows stay while they linger and are gone once 30 s have passed (D3)'),
      struckA && stillThere && gone && gone.ms < 12500, { struckBefore: !!struckA, stillThere2sAfter: stillThere, goneAfterMs: gone ? Math.round(gone.ms) : null, running: rows('running').map(said) });
    check(n(3, 'the Failures row is still there after the rows\' linger (kept until dismissed)'),
      !!rowWith('failures', DESC_B), rows('failures').map(said));

    // ---- 3: the minimized strip's failure count follows; dismiss lowers it
    const nFold0 = claude.term.cols;
    minBtn().click(); await sleep(500);
    const sFold = strip();
    const colsFolded = claude.term.cols;
    const redOk = (() => { if (!sFold || !sFold.failureEl) return false; const m = /rgba?\((\d+), (\d+), (\d+)/.exec(getComputedStyle(sFold.failureEl).color); return !!m && Number(m[1]) - Math.max(Number(m[2]), Number(m[3])) > 60; })();
    openBtn().click(); await sleep(500);
    const colsRestored = claude.term.cols;
    const x = dismiss();
    if (x) x.click();
    const failGone = await waitFor(() => !rowWith('failures', DESC_B), 1500, 20);
    minBtn().click(); await sleep(400);
    const sAfter = strip();
    openBtn().click(); await sleep(400);
    check(n(3, 'the minimized strip counts the failure (red above 0) and drops it once the x has been pressed'),
      sFold && sFold.failures === 1 && redOk && !!failGone && sAfter && sAfter.failures === 0, { foldedStrip: sFold && { r: sFold.running, f: sFold.failures }, red: redOk, rowGoneAfterX: !!failGone, afterX: sAfter && { r: sAfter.running, f: sAfter.failures } });

    // ---- 6: fold and restore (measured on the bar's own width and the terminal's columns)
    const root = barRoot();
    const wOpen = root.getBoundingClientRect().width;
    minBtn().click(); await sleep(450);
    const wStrip = root.getBoundingClientRect().width;
    const stateFolded = barState();
    openBtn().click(); await sleep(450);
    const wBack = root.getBoundingClientRect().width;
    measures.push(`${S} bar ${wOpen.toFixed(1)} px open (design ${(248 * scale).toFixed(1)}), ${wStrip.toFixed(1)} px strip (design ${(26 * scale).toFixed(1)}); terminal ${nFold0} cols open, ${colsFolded} folded, ${colsRestored} restored`);
    check(n(6, 'the fold button folds the bar to a 26 px strip (the terminal gets the width), the open button restores the 248 px bar'),
      stateFolded === 'strip' && barState() === 'open' && Math.abs(wOpen - 248 * scale) <= 3 && Math.abs(wStrip - 26 * scale) <= 3 && Math.abs(wBack - wOpen) <= 1
      && colsFolded > nFold0 && colsRestored === nFold0, { stateFolded, wOpen, wStrip, wBack, nFold0, colsFolded, colsRestored });

    // ---- 4: links
    const A = { url: 'https://claude.ai/code/artifact/aaaaaaaa-1111-4111-8111-111111111111', label: 'Sketch v3' };
    const B = { url: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit', label: 'Design doc' };
    const linkLabels = () => rows('links').map((li) => norm(li.textContent));
    const hasLabel = (li, l) => norm(li.textContent).includes(l);
    nfs.appendFileSync(transcript, T.say(`The sketch: [${A.label}](${A.url}) is ready.`)); await sleep(40);
    nfs.appendFileSync(transcript, T.say(`And the plan: [${B.label}](${B.url}).`));
    await waitFor(() => rows('links').length >= 2, 3000, 20);
    const before = rows('links');
    const orderBefore = before.map((li) => (hasLabel(li, B.label) ? 'B' : hasLabel(li, A.label) ? 'A' : '?')).join('');
    await sleep(40);
    nfs.appendFileSync(transcript, T.say(`Again, the sketch [${A.label}](${A.url}), still ready.`));
    const moved = await waitFor(() => { const r = rows('links'); return r[0] && hasLabel(r[0], A.label) ? r : null; }, 3000, 20);
    const aRows = rows('links').filter((li) => hasLabel(li, A.label)).length;
    const bRows = rows('links').filter((li) => hasLabel(li, B.label)).length;
    check(n(4, 'a link written twice is one Links row, moved to the top'),
      orderBefore === 'BA' && !!moved && aRows === 1 && bRows === 1 && rows('links').length === 2, { orderBefore, labels: linkLabels(), events: events(ptyId, 'link').map((e) => [e.ev.label, (e.ev.url || e.ev.path || '').slice(-12)]) });
    if (moved) measures.push(`${S} repeated link moved to the top ${Math.round(moved.ms)} ms after its line`);
    // 4b: one message that gives a link as markdown and again bare keeps the markdown label (D6)
    const C = { url: 'https://claude.ai/code/artifact/bbbbbbbb-2222-4222-8222-222222222222', label: 'Second sketch' };
    await sleep(40);
    nfs.appendFileSync(transcript, T.say(`See [${C.label}](${C.url}), the same page again as ${C.url} for pasting.`));
    await waitFor(() => rows('links').some((li) => /bbbbbbbb|Second sketch/.test(norm(li.textContent))), 3000, 20);
    await sleep(300);
    const cRows = rows('links').filter((li) => /bbbbbbbb|Second sketch/.test(norm(li.textContent)));
    check(n('4b', 'a link given as markdown and again bare in one message is one row and keeps the markdown label (D6)'),
      cRows.length === 1 && hasLabel(cRows[0], C.label), { rows: linkLabels() });
    // a newer version of a file replaces the older row
    nfs.appendFileSync(transcript, T.say('Saved `~/Downloads/Plan.docx` for you.')); await sleep(40);
    const one = await waitFor(() => rows('links').some((li) => /Plan\.docx/.test(norm(li.textContent))), 3000, 20);
    nfs.appendFileSync(transcript, T.say('Revised: `~/Downloads/Plan v2.docx`.'));
    const two = await waitFor(() => { const r = rows('links'); return r[0] && /Plan v2\.docx/.test(norm(r[0].textContent)) ? r : null; }, 3000, 20);
    const planRows = rows('links').filter((li) => /Plan/.test(norm(li.textContent)));
    check(n(4, '`Plan v2.docx` after `Plan.docx` leaves one row, the v2, at the top'),
      one && two && planRows.length === 1 && /Plan v2\.docx/.test(norm(planRows[0].textContent)) && !rows('links').some((li) => /Plan\.docx/.test(norm(li.textContent))), { labels: linkLabels() });
    const linkEvents = events(ptyId, 'link');
    check(n('4a', 'main side: link events carry the artifact URL, the doc URL and both file paths (the repeat sent again)'),
      linkEvents.filter((e) => e.ev.url === A.url).length === 2 && linkEvents.some((e) => e.ev.url === B.url)
      && linkEvents.some((e) => /Plan\.docx$/.test(e.ev.path || '')) && linkEvents.some((e) => /Plan v2\.docx$/.test(e.ev.path || '')), linkEvents.map((e) => e.ev.url || e.ev.path));

    // ---- 8: /clear
    const S2 = sid(Math.round(scale * 100) + 501);
    const T2 = mk(S2);
    const transcript2 = nodePath.join(projDir, `${S2}.jsonl`);
    const nEv = feedLog.length;
    const t0c = performance.now();
    nfs.writeFileSync(claudePid.file, JSON.stringify({ ...claudePid.o, sessionId: S2, updatedAt: Date.now() }));
    nfs.writeFileSync(transcript2, T2.user('after clear'));
    const det = (await waitFor(() => feedLog.slice(nEv).find((e) => e.ptyId === ptyId && e.ev.type === 'detached'), 4000, 25))?.v;
    const re = (await waitFor(() => feedLog.slice(nEv).find((e) => e.ptyId === ptyId && e.ev.type === 'attached' && e.ev.sessionId === S2), 5000, 25))?.v;
    const order = feedLog.slice(nEv).map((e) => e.ev.type + (e.ev.sessionId ? ':' + e.ev.sessionId.slice(-4) : ''));
    // the old transcript is no longer followed; the new one is
    const DESC_OLD = 'Stale job from before the clear';
    nfs.appendFileSync(transcript, T.toolUse('toolu_o', 'sleep 1', DESC_OLD)); nfs.appendFileSync(transcript, T.started('toolu_o', 'bgshelloo'));
    const DESC_NEW = 'Job after the clear';
    nfs.appendFileSync(transcript2, T2.toolUse('toolu_n', 'sleep 2', DESC_NEW)); nfs.appendFileSync(transcript2, T2.started('toolu_n', 'bgshellnn'));
    const newRow = await waitFor(() => rowWith('running', DESC_NEW), 3000, 20);
    await sleep(1300);
    check(n(8, '/clear detaches, then attaches to the new transcript (its rows appear, the old transcript is ignored)'),
      det && re && det.t <= re.t && newRow && !rowWith('running', DESC_OLD), { order, detMs: det ? Math.round(det.t - t0c) : null, reMs: re ? Math.round(re.t - t0c) : null, newRow: !!newRow, oldRowShown: !!rowWith('running', DESC_OLD) });
    check(n('8a', 'main side: the detach says "session changed" and the attach is by the sessions file'),
      det && det.ev.reason === 'session changed' && re && re.ev.how === 'sessions-file', { det: det && det.ev, re: re && re.ev });
    if (det && re) measures.push(`${S} /clear: detached ${Math.round(det.t - t0c)} ms, re-attached ${Math.round(re.t - t0c)} ms after the sessions file changed`);

    try { process.kill(claudePid.pid, 'SIGKILL'); } catch { /* gone */ }
  }

  for (const scale of cfg.scales) {
    try { await runScale(scale); } catch (err) { check(`the run at scale ${scale} finished`, false, String((err && err.stack) || err)); }
  }
  return { checks, measures };
}
