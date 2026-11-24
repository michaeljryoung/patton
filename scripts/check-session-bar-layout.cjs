// Hidden-Electron layout check of the session bar (docs/session-bar.md D1, D2,
// D3, D5, D6, D7, D13; map node bar_layout_check). The REAL TabManager, Tab,
// Pane, SessionBar, TabBar and xterm (DOM renderer), the real CSS and a stub
// preload bridge, in a window that is never shown. The stub's
// `sessionFeed.onEvent` is driven by the check, and the pane is told it runs
// Claude Code the way Claude does it: OSC 7501 `app=claude-code` through its
// real terminal. Measured with getBoundingClientRect against the DESIGN, at UI
// scale 1, 1.1 and 1.5 (the real applyUiTextScale), light scheme:
//  1. a Claude tab shows the bar, 248 px x the scale wide, right of #content;
//     its terminal has fewer columns than a plain-shell tab's in the same
//     window, by the bar's width in cells (within one column);
//  2. ⇥ folds it to the 26 px x scale strip and the terminal widens by the
//     difference; ⇤ restores; the saved SessionState.sessionBar.minimized
//     follows each press;
//  3. a window too narrow for 80 columns beside the open bar shows the strip,
//     marked narrow, without changing the saved choice; widened, it opens again;
//  4. no checkpoint clock in the tab strip; the bar's Checkpoint button, and
//     the strip's small checkpoint button once folded (D7);
//  5. fed events: a `task-start` gives a Running row; its `task-end` strikes it
//     through, and 30 s later (a faked clock) it is gone; a failed task-end
//     gives a Failures row whose × removes it; a link fed twice is one row;
//  6. with the bar open, the compose box still covers Claude's bar rows
//     R-1..R+1 and the grid's width (Claude Code v2.1.321's recorded idle
//     screen, scripts/fixtures/claude-bar-screens.json, at its 100x30);
//  7. a plain-shell tab hides the bar (it exists, hidden).
// Every assertion fails on main before the session bar (0f4e3dd): there is no
// bar there and the clock sits in the tab strip. Prove it with
//   git -C . archive 0f4e3dd src | tar -x -C <dir>; SB_SRC_ROOT=<dir> node scripts/check-session-bar-layout.cjs
// Run: node scripts/check-session-bar-layout.cjs
//   SB_SRC_ROOT=<folder holding src/>     bundle another source tree (to prove the check bites)
//   SB_LAYOUT_CHECK_DIR=<folder>          where the bundle, userData and result go (default: a temp folder, removed after)
// Prints `ok <what>` or `not ok <what>: <measured>` per assertion; exit 1 on any failure.
// The same file runs twice: under Node it bundles the sources with esbuild and
// starts Electron on itself; under Electron it opens one window that is never
// shown (show:false, dock hidden), runs the checks and exits.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HARD_TIMEOUT_MS = 180000;
const SCALES = [1, 1.1, 1.5];

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
  const srcRoot = process.env.SB_SRC_ROOT ? path.resolve(process.env.SB_SRC_ROOT) : repo;
  const ownDir = !process.env.SB_LAYOUT_CHECK_DIR;
  const outDir = process.env.SB_LAYOUT_CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'patton-check-sb-layout-'));
  fs.mkdirSync(outDir, { recursive: true });
  const resultFile = path.join(outDir, 'result.json');
  fs.rmSync(resultFile, { force: true });

  await build({
    stdin: {
      resolveDir: srcRoot,
      loader: 'ts',
      contents: `
        import { TabManager } from './src/renderer/services/tab-manager';
        import { applyUiTextScale } from './src/renderer/services/ui-text-scale';
        (window as any).__sb = { TabManager, applyUiTextScale };
      `,
    },
    bundle: true, platform: 'browser', format: 'iife', outfile: path.join(outDir, 'page.js'),
    nodePaths: [path.join(repo, 'node_modules')], // a source tree outside the repo has none of its own
    loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  // The app's own stylesheets, in index.ts's order; one a source tree lacks is skipped.
  const styles = ['main', 'tabs', 'terminal', 'editor', 'settings', 'board', 'session-bar']
    .map((n) => path.join(srcRoot, 'src/renderer/styles', n + '.css'))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(path.join(outDir, 'page.css'),
    fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8') + '\n' + styles.join('\n'));
  const fixture = fs.readFileSync(path.join(repo, 'scripts/fixtures/claude-bar-screens.json'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'fixture.js'), `window.__fixture = ${fixture};`);
  // index.html's frame: #app > #tab-bar, #main > #content (the bar is #content's next sibling).
  fs.writeFileSync(path.join(outDir, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head><body>' +
    '<div id="app"><div id="tab-bar"></div><div id="main"><div id="content"></div></div></div>' +
    '<script src="fixture.js"></script><script src="page.js"></script></body></html>');

  const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if (!fs.existsSync(__filename) || !fs.existsSync(electronBin)) {
    console.error('missing script or Electron binary (run `npx install-electron --no` once)', { script: __filename, electronBin });
    process.exit(2);
  }
  const log = fs.openSync(path.join(outDir, 'electron.log'), 'w');
  const env = { ...process.env, SB_LAYOUT_CHECK_DIR: outDir };
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
  if (result.error && !result.checks) {
    console.error('check errored:', result.error);
    process.exit(2);
  }
  if (srcRoot !== repo) console.log(`(source tree: ${srcRoot})`);
  let failed = 0;
  const perScale = {};
  for (const c of result.checks) {
    if (!c.ok) failed++;
    const m = /^x([\d.]+) /.exec(c.name);
    const k = m ? `x${m[1]}` : 'other';
    perScale[k] = perScale[k] || { ok: 0, fail: 0 };
    perScale[k][c.ok ? 'ok' : 'fail']++;
    console.log(c.ok ? `ok ${c.name}` : `not ok ${c.name}: ${JSON.stringify(c.detail)}`);
  }
  if (result.error) {
    failed++;
    console.log(`not ok the page ran to the end: ${result.error}`);
  }
  console.log('\nMeasured:');
  for (const m of result.measures || []) console.log('  ' + m);
  console.log('Per scale: ' + Object.entries(perScale).map(([k, v]) => `${k} ${v.ok} ok ${v.fail} not ok`).join('; '));
  console.log(`\n${result.checks.length - (failed - (result.error ? 1 : 0))} ok, ${failed} not ok`);
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------ Electron side
function electronMain() {
  const { app, BrowserWindow, nativeTheme } = require('electron');
  const outDir = process.env.SB_LAYOUT_CHECK_DIR;
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
      nativeTheme.themeSource = 'light';
      const win = new BrowserWindow({
        show: false, width: 1600, height: 1000,
        webPreferences: { backgroundThrottling: false, contextIsolation: false, nodeIntegration: false },
      });
      await win.loadFile(path.join(outDir, 'page.html'));
      win.webContents.focus();
      const result = await win.webContents.executeJavaScript(`(${pageRun.toString()})(${JSON.stringify(SCALES)})`);
      write(result);
      app.exit(0);
    } catch (err) {
      write({ error: String((err && err.stack) || err) });
      app.exit(1);
    }
  });
}

// Runs inside the page. Self-contained: it is sent as source text.
async function pageRun(SCALES) {
  const U = window.__sb;
  const FX = window.__fixture;
  const checks = [];
  const measures = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: ok ? null : detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const settle = async (ms = 400) => { await sleep(ms); await frame(); };
  const r1 = (n) => Math.round(n * 10) / 10;

  // A clock the check can move: the bar and its model read Date.now().
  const realNow = Date.now.bind(Date);
  let skew = 0;
  Date.now = () => realNow() + skew;

  // --- the preload bridge, stubbed: every call answers; the pty is a sink
  let nextPty = 1;
  let feedCb = null;
  const saved = [];
  const answers = {
    'pty.create': () => nextPty++, 'pty.respawn': () => nextPty++, 'pty.getShell': () => '/bin/zsh', 'pty.getCwd': () => '',
    'pty.inputState': () => [{ dirty: false, length: 0, lastInputAt: 0, slashSubmitAt: 0, userStashAt: 0, pattonStashAt: 0 }],
    'history.get': () => [], 'pauseAll.stashKey': () => ({ ok: true }), 'session.get': () => null,
    'sessionFeed.watch': () => ({ ok: true }), 'sessionFeed.unwatch': () => undefined,
  };
  const stub = (name) => new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : stub(name ? name + '.' + String(k) : String(k))),
    apply: (_t, _this, args) => {
      if (name === 'sessionFeed.onEvent') { feedCb = args[0]; return () => { feedCb = null; }; }
      if (name === 'session.set') { saved.push(JSON.parse(JSON.stringify(args[0] ?? null))); return Promise.resolve(); }
      const last = name.split('.').pop();
      if (/^on[A-Z]/.test(last)) return () => {};
      if (name === 'pty.write' || name === 'pty.resize' || name === 'log.send') return undefined;
      return Promise.resolve(answers[name] ? answers[name]() : undefined);
    },
  });
  window.patton = stub('');

  const appEl = document.getElementById('app');
  const sizeApp = (w, h) => { appEl.style.width = `${w}px`; appEl.style.height = `${h}px`; };
  sizeApp(1400, 900);
  const tm = new U.TabManager(document.getElementById('tab-bar'), document.getElementById('content'));
  tm.setComposeFirst?.(true);
  const barEl = () => document.querySelector('.session-bar');
  const barState = () => (barEl() ? barEl().dataset.state : '(no bar)');
  const barW = () => (barEl() && !barEl().hidden ? barEl().getBoundingClientRect().width : 0);
  const lastSaved = () => {
    for (let i = saved.length - 1; i >= 0; i--) if (saved[i] && saved[i].sessionBar) return saved[i].sessionBar.minimized;
    return '(never saved)';
  };

  const termOf = (pane) => pane.terminalView.terminal;
  const write = (pane, data) => new Promise((r) => termOf(pane).write(data, r));
  const claudeIdle = (pane) => write(pane, '\x1b]7501;state=idle:app=claude-code\x07');
  const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  function grid(pane) {
    const screen = pane.element.querySelector('.terminal-container .xterm-screen').getBoundingClientRect();
    const t = termOf(pane);
    const cellH = screen.height / t.rows;
    return { screen, cellH, cellW: screen.width / t.cols, vy: t.buffer.active.viewportY };
  }
  const press = async (sel) => {
    const b = barEl() && barEl().querySelector(sel);
    if (b) b.click();
    await settle(450);
    return !!b;
  };
  const feed = async (pane, event) => {
    if (feedCb) feedCb(pane.ptyId, event);
    await frame();
  };
  const rowsIn = (sec) => [...(barEl()?.querySelectorAll(`.sb-sec-${sec} .sb-item`) ?? [])];
  const lineH = (e) => parseFloat(getComputedStyle(e).lineHeight);
  /** The first line's baseline (y of the bottom of a zero-size inline-block on it). The clamped
   *  box is made a plain block for the probe: a flex-like box would blockify the probe. */
  const baselineOf = (e) => {
    const d = e.style.display;
    e.style.display = 'block';
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0';
    e.insertBefore(probe, e.firstChild);
    const y = probe.getBoundingClientRect().bottom;
    probe.remove();
    e.style.display = d;
    return y;
  };
  const rowFits = (li) => { const b = barEl().getBoundingClientRect(); const r = li.getBoundingClientRect(); return r.right <= b.right + 0.5 && li.scrollWidth <= li.clientWidth + 1; };

  // The plain-shell tab, made once: it never reports Claude.
  const plainTab = await tm.createTab();
  await settle(300);

  async function runScale(S) {
    const at = `x${S}`;
    U.applyUiTextScale(S, 'change');
    sizeApp(1400, 900);
    skew = 0;
    await settle(300);

    // ---- 7 and the baseline: the plain-shell tab
    tm.switchToId(plainTab.id);
    await settle(450);
    const plain = plainTab.focusedPane;
    const plainCols = termOf(plain).cols;
    check(`${at} plain-shell tab: the bar exists and is hidden`, !!barEl() && barEl().hidden === true && barState() === 'hidden', { state: barState() });

    // ---- 1. a Claude tab: the bar open, 248 px x scale
    const tab = await tm.createTab();
    await settle(300);
    const pane = tab.focusedPane;
    await claudeIdle(pane);
    await settle(500);
    const want = 248 * S;
    const w1 = barW();
    const bar1 = barEl() ? barEl().getBoundingClientRect() : null;
    const content = document.getElementById('content').getBoundingClientRect();
    check(`${at} Claude tab: the bar is open and visible`, barState() === 'open' && w1 > 0, { state: barState() });
    check(`${at} Claude tab: the bar is 248 px x ${S} = ${r1(want)} px wide (0.5 px)`, Math.abs(w1 - want) <= 0.5, { width: r1(w1), want: r1(want) });
    check(`${at} Claude tab: the bar sits right of the content, at the window's right edge`, bar1 && Math.abs(bar1.left - content.right) <= 0.5 && Math.abs(bar1.right - appEl.getBoundingClientRect().right) <= 0.5,
      bar1 && { barLeft: r1(bar1.left), contentRight: r1(content.right), barRight: r1(bar1.right) });
    const g1 = grid(pane);
    const openCols = termOf(pane).cols;
    const lostCols = plainCols - openCols;
    check(`${at} Claude tab: the terminal has fewer columns by the bar's width in cells (within one)`, w1 > 0 && Math.abs(lostCols - w1 / g1.cellW) <= 1,
      { plainCols, openCols, lostCols, barCells: r1(w1 / g1.cellW) });
    measures.push(`${at}: bar ${r1(w1)} px; cell ${r1(g1.cellW)} x ${r1(g1.cellH)} px; plain ${plainCols} cols, with the bar ${openCols}`);

    // ---- 4. the checkpoint: in the bar, not in the tab strip
    check(`${at} no checkpoint clock in the tab strip`, !document.querySelector('#tab-bar .tab-bar-checkpoint') && !/checkpoint/i.test([...document.querySelectorAll('#tab-bar button')].map((b) => b.className).join(' ')),
      [...document.querySelectorAll('#tab-bar > *')].map((e) => e.className));
    const ck = barEl()?.querySelector('.sb-ckpt-btn');
    check(`${at} the bar's Checkpoint button is shown`, !!ck && !ck.hidden && ck.getBoundingClientRect().width > 0, ck && ck.outerHTML);

    // ---- 6. the compose box over Claude's bar rows with the session bar open
    {
      // Size the window so the terminal is the recordings' 100x30 beside the open bar.
      for (let i = 0; i < 8 && (termOf(pane).cols !== FX.cols || termOf(pane).rows !== FX.rows); i++) {
        const g = grid(pane);
        const r = appEl.getBoundingClientRect();
        sizeApp(r.width + (FX.cols - termOf(pane).cols) * g.cellW, r.height + (FX.rows - termOf(pane).rows) * g.cellH);
        await settle(300);
      }
      const t = termOf(pane);
      check(`${at} compose: the terminal is 100x30 beside the open bar`, t.cols === FX.cols && t.rows === FX.rows && barState() === 'open', { cols: t.cols, rows: t.rows, state: barState() });
      for (const e of FX.recordings.steps) {
        if (e.mark === 'idle') break;
        if (e.b) await write(pane, toBytes(e.b));
      }
      await claudeIdle(pane);
      await settle(600);
      const b = t.buffer.active;
      const R = b.baseY + b.cursorY;
      const text = (i) => { const l = b.getLine(i); return l ? l.translateToString(true) : ''; };
      const found = text(R).startsWith('❯') && /^─+$/.test(text(R - 1)) && /^─+$/.test(text(R + 1));
      const box = pane.element.querySelector('.editor-container');
      const g = grid(pane);
      const bb = box ? box.getBoundingClientRect() : null;
      const top = g.screen.top + (R - 1 - g.vy) * g.cellH;
      const bottom = g.screen.top + (R + 2 - g.vy) * g.cellH;
      const d = bb && { placement: pane.element.dataset.composePlacement, bar: barState(), box: { top: r1(bb.top), bottom: r1(bb.bottom), left: r1(bb.left), right: r1(bb.right) },
        want: { top: r1(top), bottom: r1(bottom), left: r1(g.screen.left), right: r1(g.screen.right) } };
      check(`${at} compose: Claude's bar found on the recorded idle screen beside the open session bar`, found && barState() === 'open', { R, line: text(R).slice(0, 20), state: barState() });
      check(`${at} compose, session bar open: the box is over Claude's bar`, barState() === 'open' && pane.element.dataset.composePlacement === 'over', d);
      check(`${at} compose, session bar open: the box covers rows R-1..R+1 (1 px)`, barState() === 'open' && bb && Math.abs(bb.top - top) <= 1 && Math.abs(bb.bottom - bottom) <= 1, d);
      check(`${at} compose, session bar open: the box spans the grid's width, not under the bar (1 px)`,
        barState() === 'open' && bb && Math.abs(bb.left - g.screen.left) <= 1 && Math.abs(bb.right - g.screen.right) <= 1 && bb.right <= barEl().getBoundingClientRect().left + 0.5, d);
      sizeApp(1400, 900);
      await settle(450);
    }

    // ---- 2. ⇥ and ⇤
    const savesBefore = saved.length;
    const hadMin = await press('.sb-min');
    const w2 = barW();
    const stripCols = termOf(pane).cols;
    const g2 = grid(pane);
    check(`${at} ⇥: the bar folds to the strip, 26 px x ${S} = ${r1(26 * S)} px (0.5 px)`, hadMin && barState() === 'strip' && Math.abs(w2 - 26 * S) <= 0.5, { state: barState(), width: r1(w2) });
    check(`${at} ⇥: the terminal widens by the difference in cells (within one)`, hadMin && Math.abs((stripCols - openCols) - (w1 - w2) / g2.cellW) <= 1 && stripCols > openCols,
      { openCols, stripCols, cells: r1((w1 - w2) / g2.cellW) });
    check(`${at} ⇥: the saved choice is minimized`, saved.length > savesBefore && lastSaved() === true, { saves: saved.length - savesBefore, minimized: lastSaved() });
    const sc = barEl()?.querySelector('.sb-strip-ckpt');
    check(`${at} the strip has its small checkpoint button`, !!sc && !sc.hidden && sc.getBoundingClientRect().width > 0, sc && sc.outerHTML);
    // A refused Checkpoint click, folded: the note is hidden, so the strip's button carries the reason for 4 s.
    {
      const reason = 'Claude is busy: not sent';
      tm.sessionBar.showCheckpointReason(reason);
      const b = barEl()?.querySelector('.sb-strip-ckpt');
      const noteHidden = !barEl().querySelector('.sb-note') || barEl().querySelector('.sb-note').getBoundingClientRect().width === 0;
      check(`${at} ⇥ a refused checkpoint click: the strip's button shows "!" and the reason as its title and label`,
        !!b && b.textContent === '!' && b.title === reason && b.getAttribute('aria-label') === reason && b.classList.contains('reason') && noteHidden,
        b && { text: b.textContent, title: b.title, noteHidden });
      await settle(4300);
      check(`${at} ⇥ ... and 4 s later the button is its old self (✓, its own label)`,
        !!b && b.textContent === '✓' && b.title !== reason && !b.classList.contains('reason'), b && { text: b.textContent, title: b.title });
    }
    const hadRestore = await press('.sb-restore');
    check(`${at} ⇤: the bar opens again at ${r1(want)} px`, hadRestore && barState() === 'open' && Math.abs(barW() - want) <= 0.5, { state: barState(), width: r1(barW()) });
    check(`${at} ⇤: the terminal has its columns with the bar back`, hadRestore && termOf(pane).cols === openCols, { cols: termOf(pane).cols, openCols });
    check(`${at} ⇤: the saved choice is open`, hadRestore && lastSaved() === false, { minimized: lastSaved() });

    // ---- 3. the narrow fold
    {
      const g = grid(pane);
      const savesNow = saved.length;
      // Wide enough for about 70 columns beside the open bar: under 80, over the strip's need.
      const narrowW = Math.round(want + 70 * g.cellW + 60);
      sizeApp(narrowW, 900);
      await settle(600);
      const narrowCols = termOf(pane).cols;
      check(`${at} narrow window (${narrowW} px): the strip shows, marked narrow`, barState() === 'strip' && barEl().dataset.narrow === 'true' && Math.abs(barW() - 26 * S) <= 0.5,
        { state: barState(), narrow: barEl() && barEl().dataset.narrow, width: r1(barW()), cols: narrowCols });
      check(`${at} narrow window: the saved choice is unchanged (open)`, barEl() && tm.sessionBar && tm.sessionBar.isMinimized === false && saved.slice(savesNow).every((s) => !s || !s.sessionBar || s.sessionBar.minimized === false),
        { minimized: tm.sessionBar && tm.sessionBar.isMinimized, saves: saved.slice(savesNow).map((s) => s && s.sessionBar) });
      sizeApp(1400, 900);
      await settle(600);
      check(`${at} widened again: the bar opens`, barState() === 'open' && termOf(pane).cols === openCols, { state: barState(), cols: termOf(pane).cols, openCols });
    }

    // ---- 5. fed events
    {
      const id = `bt${String(S).replace('.', '')}`;
      const LONG = `npm run check ${S} and then merge the results for the German subsidiaries into one register, checking every filing twice`;
      await feed(pane, { type: 'task-start', id, kind: 'shell', description: LONG, command: `npm run check -- --scale ${S}`, at: Date.now() });
      let row = rowsIn('running').find((li) => li.dataset.id === id);
      check(`${at} feed task-start: a Running row (Shell, its description)`, !!row && row.querySelector('.sb-kind')?.textContent === 'Shell' && row.querySelector('.sb-what')?.textContent === LONG && !row.classList.contains('done'),
        rowsIn('running').map((li) => li.textContent));
      // A row's text: the UI font like every other row (not a code element), wrapped to at most 3 lines.
      {
        const w = row && row.querySelector('.sb-what');
        const cs = w && getComputedStyle(w);
        const lh = cs && parseFloat(cs.lineHeight);
        const h = w && w.getBoundingClientRect().height;
        check(`${at} a Shell row's text is not a code element, and is in the UI font`, !!w && w.tagName !== 'CODE' && cs.fontFamily === getComputedStyle(barEl()).fontFamily && !row.querySelector('code'), w && { tag: w.tagName, font: cs.fontFamily });
        check(`${at} row text carries the 3-line clamp and wraps`, !!cs && (cs.webkitLineClamp === '3' || cs.lineClamp === '3') && cs.whiteSpace === 'normal', cs && { clamp: cs.webkitLineClamp, ws: cs.whiteSpace });
        check(`${at} a long Shell row wraps to 3 lines, no more (1 px)`, !!lh && Math.abs(h - 3 * lh) <= 1, { h, lh });
        const kb = row && baselineOf(row.querySelector('.sb-kind'));
        const wb = w && baselineOf(w);
        check(`${at} the kind label shares the text's first-line baseline (1 px)`, kb !== null && wb !== null && Math.abs(kb - wb) <= 1, { kindBaseline: kb, textBaseline: wb });
        const kEl = row && row.querySelector('.sb-kind');
        check(`${at} the Shell kind label is not clipped`, !!kEl && kEl.scrollWidth <= kEl.clientWidth, kEl && { sw: kEl.scrollWidth, cw: kEl.clientWidth });
      }
      // Every kind label D3, D4 and D6 can show fits its column whole (a probe row per label).
      {
        const KINDS = ['Agent', 'Workflow', 'Teammate', 'Cloud', 'Shell', 'Monitor', 'Task', 'Loop', 'Cron', 'Wake', 'Page', 'Doc', 'Sheet', 'Drive', 'Release', 'PR', 'Link', 'File', 'Claude'];
        const ul = document.createElement('ul');
        ul.className = 'sb-list';
        for (const k of KINDS) {
          const li = document.createElement('li');
          li.className = 'sb-item fail';
          li.innerHTML = `<span class="sb-kind"></span><span class="sb-what">x</span><span class="sb-t">12:00</span><button class="sb-x">×</button>`;
          li.firstChild.textContent = k;
          ul.append(li);
        }
        const TIMES = ['23:59', '59 min', '23 h 59', '59 s'];
        for (const t of TIMES) {
          const li = document.createElement('li');
          li.className = 'sb-item long';
          li.innerHTML = `<span class="sb-kind">Shell</span><span class="sb-what">x</span><span class="sb-t"></span>`;
          li.lastChild.textContent = t;
          ul.append(li);
        }
        barEl().querySelector('.sb-lists').append(ul);
        const wrapped = [...ul.querySelectorAll('.sb-item.long .sb-t')].filter((e) => e.getBoundingClientRect().height > lineH(e) + 1).map((e) => `${e.textContent} ${r1(e.getBoundingClientRect().height)}`);
        const clipped = [...ul.querySelectorAll('.sb-kind')].filter((k) => k.scrollWidth > k.clientWidth).map((k) => `${k.textContent} ${k.scrollWidth}>${k.clientWidth}`);
        ul.remove();
        check(`${at} the times a row normally shows (${TIMES.join(', ')}, in the long-running bold) stay on one line`, wrapped.length === 0, wrapped);
        check(`${at} every kind label (${KINDS.join(', ')}) fits its column whole`, clipped.length === 0, clipped);
      }
      // A row's age ticking patches its time in place: the same row, its tooltip kept (not rebuilt).
      {
        const tid = `bp${String(S).replace('.', '')}`;
        await feed(pane, { type: 'task-start', id: tid, kind: 'shell', description: 'tick test', at: Date.now() });
        const li0 = rowsIn('running').find((r) => r.dataset.id === tid);
        const t0 = li0 && li0.querySelector('.sb-t').textContent;
        skew += 65_000;
        tm.sessionBar.renderLists();
        const li1 = rowsIn('running').find((r) => r.dataset.id === tid);
        const t1 = li1 && li1.querySelector('.sb-t').textContent;
        check(`${at} an age tick patches the row in place: the same <li>, a new time (${t0} -> ${t1})`, !!li0 && li0 === li1 && li0.isConnected && !!t0 && t1 !== t0, { t0, t1, same: li0 === li1 });
        await feed(pane, { type: 'task-end', id: tid, status: 'completed', at: Date.now() });
        skew += 31_000;
        tm.sessionBar.renderLists();
      }
      // Wrapping, with nothing to break on, and the time column's cap.
      {
        const bid = `bu${String(S).replace('.', '')}`;
        await feed(pane, { type: 'task-start', id: bid, kind: 'agent', description: 'W'.repeat(150), at: Date.now() });
        const li = rowsIn('running').find((r) => r.dataset.id === bid);
        const w = li && li.querySelector('.sb-what');
        const lh = w && lineH(w);
        const h = w && w.getBoundingClientRect().height;
        check(`${at} an unbroken 150-character description wraps to 3 lines, no more, and stays inside the row (1 px)`, !!w && Math.abs(h - 3 * lh) <= 1 && w.scrollWidth <= w.clientWidth + 1 && rowFits(li), w && { h, lh, sw: w.scrollWidth, cw: w.clientWidth });
        await feed(pane, { type: 'task-end', id: bid, status: 'completed', at: Date.now() });
      }
      const strip = barEl()?.querySelector('.sb-n-running');
      check(`${at} feed task-start: the Running count says 1`, !!row && barEl().querySelector('.sb-sec-running .sb-count')?.textContent === '1', strip && strip.textContent);
      await feed(pane, { type: 'task-end', id, status: 'completed', at: Date.now() });
      row = rowsIn('running').find((li) => li.dataset.id === id);
      const what = row && row.querySelector('.sb-what');
      check(`${at} feed task-end: the row stays, struck through`, !!row && row.classList.contains('done') && !!what && getComputedStyle(what).textDecorationLine.includes('line-through'),
        row && { cls: row.className, deco: what && getComputedStyle(what).textDecorationLine });
      skew += 29_000;
      await feed(pane, { type: 'link', url: `https://github.com/example/repo/pull/${Math.round(S * 10)}`, label: 'tick', at: Date.now() });
      check(`${at} 29 s later: the ended row is still there`, rowsIn('running').some((li) => li.dataset.id === id), rowsIn('running').map((li) => li.dataset.id));
      skew += 2_000;
      await feed(pane, { type: 'link', url: `https://github.com/example/repo/pull/${Math.round(S * 10) + 1}`, label: 'tick2', at: Date.now() });
      check(`${at} 31 s later: the ended row is gone`, !!barEl() && barState() === 'open' && !rowsIn('running').some((li) => li.dataset.id === id), rowsIn('running').map((li) => li.dataset.id));

      const fid = `bf${String(S).replace('.', '')}`;
      await feed(pane, { type: 'task-start', id: fid, kind: 'shell', description: 'gh run watch', at: Date.now() });
      await feed(pane, { type: 'task-end', id: fid, status: 'failed', exitCode: 1, at: Date.now() });
      const fails = rowsIn('failures');
      check(`${at} a failed task-end: one Failures row`, fails.length === 1 && fails[0].classList.contains('fail'), fails.map((li) => li.textContent));
      const x = fails[0] && fails[0].querySelector('.sb-x');
      const nf = () => barEl().querySelector('.sb-n-failures');
      check(`${at} strip failures box: one failure shows "!1" in the failure colour, labelled "1 failure"`, !!nf() && !nf().hidden && getComputedStyle(nf()).display !== 'none' && nf().textContent === '!1' && nf().getAttribute('aria-label') === '1 failure' && nf().classList.contains('some'), nf() && nf().outerHTML);
      check(`${at} the Failures row has a × labelled Dismiss`, !!x && x.getAttribute('aria-label') === 'Dismiss', x && x.outerHTML);
      if (x) x.click();
      await frame();
      check(`${at} × removes the Failures row`, !!x && rowsIn('failures').length === 0 && !barEl().querySelector('.sb-sec-failures'), rowsIn('failures').map((li) => li.textContent));
      check(`${at} strip failures box: no failures, the box is hidden (display none) and empty`, !!nf() && nf().hidden && getComputedStyle(nf()).display === 'none' && nf().textContent === '', nf() && nf().outerHTML);
      for (const n of [1, 2]) {
        await feed(pane, { type: 'task-start', id: `${fid}-${n}`, kind: 'shell', description: `second ${n}`, at: Date.now() });
        await feed(pane, { type: 'task-end', id: `${fid}-${n}`, status: 'failed', exitCode: 2, at: Date.now() });
      }
      check(`${at} strip failures box: two failures show "!2", labelled "2 failures"`, !!nf() && !nf().hidden && nf().textContent === '!2' && nf().getAttribute('aria-label') === '2 failures', nf() && nf().outerHTML);
      for (let i = 0; i < 2; i++) {
        barEl().querySelector('.sb-sec-failures .sb-x')?.click();
        await frame();
      }
      check(`${at} strip failures box: hidden again (display none) once both are dismissed`, !!nf() && nf().hidden && getComputedStyle(nf()).display === 'none' && rowsIn('failures').length === 0, nf() && nf().outerHTML);

      // A long failure: the reason first, 3 lines at most, the × beside it inside the row.
      {
        const lid = `bl${String(S).replace('.', '')}`;
        await feed(pane, { type: 'task-start', id: lid, kind: 'shell', description: `npm run build --workspace=packages/${'long-package-name-'.repeat(8)}`, at: Date.now() });
        await feed(pane, { type: 'task-end', id: lid, status: 'killed', exitCode: 137, at: Date.now() - 3 * 86_400_000 });
        const li = rowsIn('failures')[0];
        const w = li && li.querySelector('.sb-what');
        const lh = w && lineH(w);
        const h = w && w.getBoundingClientRect().height;
        const xr = li && li.querySelector('.sb-x').getBoundingClientRect();
        const lr = li && li.getBoundingClientRect();
        const tr = li && li.querySelector('.sb-t').getBoundingClientRect();
        check(`${at} a long Failures row: the reason comes first ("exit 137: ..."), 3 lines at most (1 px)`, !!w && w.textContent.startsWith('exit 137: ') && h <= 3 * lh + 1 && h >= 2 * lh && rowFits(li), w && { text: w.textContent.slice(0, 30), h, lh });
        check(`${at} a long Failures row: the × sits inside the row, right of the time`, !!xr && xr.width > 0 && xr.right <= lr.right + 0.5 && xr.left >= tr.right - 0.5, xr && { x: [r1(xr.left), r1(xr.right)], t: r1(tr.right), row: r1(lr.right) });
        const ww = w && w.getBoundingClientRect().width;
        check(`${at} an older Failures row ("${li && li.querySelector('.sb-t').textContent}"): its time wraps within ${r1(52 * S)} px and the text keeps at least ${r1(70 * S)} px`, !!li && tr.width <= 52 * S + 0.5 && ww >= 70 * S, { time: tr && r1(tr.width), text: r1(ww) });
        li.querySelector('.sb-x').click();
        await frame();
      }
      // A Scheduled row with a schedule Patton can't read: the time cap keeps the text column.
      {
        const crons = [
          { id: 'c-a', s: '0 9 L * MON-FRI', r: false, p: 'Check the German subsidiaries register and email the summary to the team' },
          { id: 'c-b', s: '0 0 9 * * MON-FRI 2026 extra tail', r: true, p: 'six-field schedule row' },
        ];
        pane.sessionBarModel.applyStop({ tasks: 0, taskList: null, cronList: crons, transcriptPath: null }, Date.now());
        await frame();
        const rows = rowsIn('scheduled');
        const detail = rows.map((li) => ({ t: li.querySelector('.sb-t').textContent, tw: r1(li.querySelector('.sb-t').getBoundingClientRect().width), ww: r1(li.querySelector('.sb-what').getBoundingClientRect().width), th: r1(li.querySelector('.sb-t').getBoundingClientRect().height), lh: r1(lineH(li.querySelector('.sb-t'))) }));
        check(`${at} two unreadable-schedule rows: the time wraps (3 lines at most) within ${r1(52 * S)} px, the text keeps at least ${r1(70 * S)} px, nothing overflows`,
          rows.length === 2 && detail.every((d) => d.tw <= 52 * S + 0.5 && d.ww >= 70 * S && d.th <= 3 * d.lh + 1) && rows.every(rowFits), detail);
        const sw = rows[0] && rows[0].querySelector('.sb-what');
        check(`${at} a Scheduled row's text is clamped to 3 lines too`, !!sw && sw.getBoundingClientRect().height <= 3 * lineH(sw) + 1 && getComputedStyle(sw).webkitLineClamp === '3', sw && sw.getBoundingClientRect().height);
        pane.sessionBarModel.applyStop({ tasks: 0, taskList: null, cronList: [], transcriptPath: null }, Date.now());
        await frame();
      }

      // A Links row: its button wraps to 3 lines, and its tooltip says the label, then the address.
      {
        const lurl = `https://example.com/docs/${'segment-'.repeat(6)}${Math.round(S * 10)}`;
        const label = 'The quarterly register of German subsidiaries with every filing deadline and the owner of each filing marked '.repeat(2);
        await feed(pane, { type: 'link', url: lurl, label, at: Date.now() - 2 * 86_400_000 });
        const btn = [...(barEl()?.querySelectorAll('.sb-sec-links .sb-link') ?? [])].find((b) => (b.title || '').includes(lurl));
        const lh = btn && lineH(btn);
        const h = btn && btn.getBoundingClientRect().height;
        const li = btn && btn.closest('li');
        const ww = btn && btn.getBoundingClientRect().width;
        check(`${at} a long Links button wraps to 3 lines, no more (1 px), with the clamp on the button`, !!btn && Math.abs(h - 3 * lh) <= 1 && getComputedStyle(btn).webkitLineClamp === '3' && rowFits(li), btn && { h, lh });
        check(`${at} a Links row's tooltip is the label, then the address on a second line`, !!btn && btn.title.split('\n').length === 2 && btn.title.split('\n')[1] === lurl && btn.title.startsWith(label.slice(0, 40)), btn && btn.title);
        check(`${at} an older Links row ("${li && li.querySelector('.sb-t').textContent}"): the text keeps at least ${r1(70 * S)} px`, !!li && ww >= 70 * S && li.querySelector('.sb-t').getBoundingClientRect().width <= 52 * S + 0.5, { text: r1(ww) });
        btn && btn.closest('li').remove();
      }

      const url = `https://claude.ai/code/artifact/abcdef12-${Math.round(S * 10)}`;
      await feed(pane, { type: 'link', url, label: 'The plan', at: Date.now() });
      await feed(pane, { type: 'link', url: url + '.', label: 'The plan', at: Date.now() + 1000 });
      const links = [...(barEl()?.querySelectorAll('.sb-sec-links .sb-link') ?? [])].filter((b) => (b.title || '').split('\n').includes(url));
      check(`${at} a link fed twice is one row`, links.length === 1, links.map((b) => b.title));
    }

    // ---- 7 again: back to the plain shell, the bar hides and its terminal keeps its columns
    tm.switchToId(plainTab.id);
    await settle(450);
    check(`${at} back on the plain-shell tab: the bar hides, the terminal keeps its full width`, !!barEl() && barEl().hidden && termOf(plain).cols === plainCols,
      { state: barState(), cols: termOf(plain).cols, plainCols });
  }

  try {
    for (const S of SCALES) {
      try {
        await runScale(S);
      } catch (err) {
        check(`x${S} the scale ran to the end`, false, String((err && err.stack) || err));
      }
    }
    U.applyUiTextScale(1, 'change');
    return { checks, measures };
  } catch (err) {
    return { checks, measures, error: String((err && err.stack) || err) };
  }
}
