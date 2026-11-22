// Hidden-Electron checks of the compose box's room below (docs/compose-box.md D15), for the cases
// check-compose-over.cjs does not reach: a font change or resize while the pane is hidden (the rows given up
// stay given up when it is shown), a pane that changes height only (k follows the third-of-the-pane cap, and
// Patton's own padding change is no resize), and a content change that lands after Patton's own room resize
// but before Claude's redraw (k is worked out from the fresh bar, not the pre-resize one).
// Settling (S60, D15): Claude's redraw after Patton's own resize delayed 100 to 4000 ms (no flapping, k once),
// and k after a split, a font change, an aside's end over scrolled output, and a window resize with a slow
// redraw, each compared with the k the same screen and draft give from scratch; a send gives the rows back in
// one resize. These run at the first scale only, and print one summary line each under "Measured".
// The harness (stub bridge, real Pane, recorded screens, Claude's redraw stood in for) is copied from
// check-compose-over.cjs; see its header.
//
// Run: node scripts/check-compose-room-live.cjs
//   COMPOSE_SRC_ROOT=<folder holding src/>   bundle another source tree (to prove the check bites)
//   COMPOSE_ROOMLIVE_CHECK_DIR=<folder>      where the bundle, userData and result go (default: a temp folder, removed after)
//   COMPOSE_ROOMLIVE_GROUPS=<a,b,...>         run only these groups (hidden,height,stale,delay,split,font,aside,window,late,holdwrap,send)
// Prints `ok <what>` or `not ok <what>: <measured>` per assertion; exit 1 on any failure.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HARD_TIMEOUT_MS = 480000;
const GROUPS = process.env.COMPOSE_ROOMLIVE_GROUPS ? process.env.COMPOSE_ROOMLIVE_GROUPS.split(',') : null;
const SCALES = process.env.COMPOSE_ROOMLIVE_SCALES ? process.env.COMPOSE_ROOMLIVE_SCALES.split(',').map(Number) : [1, 1.5];

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
  const srcRoot = process.env.COMPOSE_SRC_ROOT ? path.resolve(process.env.COMPOSE_SRC_ROOT) : repo;
  const ownDir = !process.env.COMPOSE_ROOMLIVE_CHECK_DIR;
  const outDir = process.env.COMPOSE_ROOMLIVE_CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'patton-check-compose-room-live-'));
  fs.mkdirSync(outDir, { recursive: true });
  const resultFile = path.join(outDir, 'result.json');
  fs.rmSync(resultFile, { force: true });

  await build({
    stdin: {
      resolveDir: srcRoot,
      loader: 'ts',
      contents: `
        import { Pane } from './src/renderer/components/pane';
        import { SplitContainer } from './src/renderer/components/split-container';
        import { applyUiTextScale } from './src/renderer/services/ui-text-scale';
        (window as any).__co = { Pane, SplitContainer, applyUiTextScale };
      `,
    },
    bundle: true, platform: 'browser', format: 'iife', outfile: path.join(outDir, 'page.js'),
    nodePaths: [path.join(repo, 'node_modules')], // a source tree outside the repo has none of its own
    loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const styles = ['main', 'tabs', 'terminal', 'editor', 'settings', 'board']
    .map((n) => fs.readFileSync(path.join(srcRoot, 'src/renderer/styles', n + '.css'), 'utf8'));
  fs.writeFileSync(path.join(outDir, 'page.css'),
    fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8') + '\n' + styles.join('\n'));
  const fixture = fs.readFileSync(path.join(repo, 'scripts/fixtures/claude-bar-screens.json'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'fixture.js'), `window.__fixture = ${fixture};`);
  fs.writeFileSync(path.join(outDir, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head><body>' +
    '<div id="app"><div id="main"><div id="content"></div></div></div>' +
    '<script src="fixture.js"></script><script src="page.js"></script></body></html>');

  const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  // Electron given a missing script opens its default window: refuse instead.
  if (!fs.existsSync(__filename) || !fs.existsSync(electronBin)) {
    console.error('missing script or Electron binary (run `npx install-electron --no` once)', { script: __filename, electronBin });
    process.exit(2);
  }
  const log = fs.openSync(path.join(outDir, 'electron.log'), 'w');
  const env = { ...process.env, COMPOSE_ROOMLIVE_CHECK_DIR: outDir };
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
  for (const c of result.checks) {
    if (!c.ok) failed++;
    console.log(c.ok ? `ok ${c.name}` : `not ok ${c.name}: ${JSON.stringify(c.detail)}`);
  }
  if (result.error) {
    failed++;
    console.log(`not ok the page ran to the end: ${result.error}`);
  }
  console.log('\nMeasured (px; a row is the terminal cell height):');
  for (const m of result.measures || []) console.log('  ' + m);
  console.log(`\n${result.checks.length - (failed - (result.error ? 1 : 0))} ok, ${failed} not ok`);
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------ Electron side
function electronMain() {
  const { app, BrowserWindow, nativeTheme } = require('electron');
  const outDir = process.env.COMPOSE_ROOMLIVE_CHECK_DIR;
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
        show: false, width: 1400, height: 1000,
        webPreferences: { backgroundThrottling: false, contextIsolation: false, nodeIntegration: false },
      });
      await win.loadFile(path.join(outDir, 'page.html'));
      win.webContents.focus(); // page focus, so the box's textarea can hold the keyboard; the window stays hidden
      const result = await win.webContents.executeJavaScript(`(${pageRun.toString()})(${JSON.stringify(SCALES)}, ${JSON.stringify(GROUPS)})`);
      write(result);
      app.exit(0);
    } catch (err) {
      write({ error: String((err && err.stack) || err) });
      app.exit(1);
    }
  });
}

// Runs inside the page. Self-contained: it is sent as source text.
async function pageRun(SCALES, GROUPS) {
  const U = window.__co;
  const FX = window.__fixture;
  const checks = [];
  const measures = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: ok ? null : detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const settle = async (ms = 350) => { await sleep(ms); await frame(); };
  const r1 = (n) => Math.round(n * 10) / 10;

  // --- the preload bridge, stubbed: every call answers; the pty is a sink
  const logs = [];
  let ptyResizes = 0;
  const answers = {
    'pty.create': () => 1, 'pty.respawn': () => 2, 'pty.getShell': () => '/bin/zsh', 'pty.getCwd': () => '',
    'pty.inputState': () => [{ dirty: false, length: 0, lastInputAt: 0, slashSubmitAt: 0, userStashAt: 0, pattonStashAt: 0 }],
    'history.get': () => [], 'pauseAll.stashKey': () => ({ ok: true }),
  };
  const stub = (name) => new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : stub(name ? name + '.' + String(k) : String(k))),
    apply: (_t, _this, args) => {
      if (name === 'log.send') { logs.push({ tag: String(args[1] && args[1][0]), data: args[1] && args[1][1], at: performance.now() }); return undefined; }
      const last = name.split('.').pop();
      if (/^on[A-Z]/.test(last)) return () => {};
      if (name === 'pty.resize') { ptyResizes++; return undefined; }
      if (name === 'pty.write') return undefined;
      return Promise.resolve(answers[name] ? answers[name]() : undefined);
    },
  });
  window.patton = stub('');

  const content = document.getElementById('content');
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:900px;height:600px;display:flex;flex-direction:column';
  content.appendChild(host);

  // --- one pane, its terminal sized to the recordings' 100x30 with no box
  let pane = null;
  const term = () => pane.terminalView.terminal;
  const q = (sel) => pane.element.querySelector(sel);
  const box = () => q('.editor-container');
  const textarea = () => q('.editor-container textarea');
  const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const write = (data) => new Promise((r) => term().write(data, r));
  const report = (state, kind) => write(`\x1b]7501;state=${state}${kind ? `:kind=${kind}` : ''}:app=claude-code\x07`);

  async function newPane() {
    if (pane) { pane.dispose(); pane.element.remove(); }
    host.style.width = '900px'; host.style.height = '600px';
    pane = new U.Pane({ onFocus() {}, onTitleChange() {} });
    host.appendChild(pane.element);
    await pane.init();
    pane.setRenderer('dom');
    pane.setFocused(true);
    await settle(200);
    for (let i = 0; i < 6 && (term().cols !== FX.cols || term().rows !== FX.rows); i++) {
      const g = grid();
      host.style.width = `${host.getBoundingClientRect().width + (FX.cols - term().cols) * g.cellW}px`;
      host.style.height = `${host.getBoundingClientRect().height + (FX.rows - term().rows) * g.cellH}px`;
      await settle(250);
    }
    return { cols: term().cols, rows: term().rows };
  }

  /** The terminal grid: row k (absolute buffer row) spans [top(k), top(k)+cellH). */
  function grid() {
    const screen = q('.terminal-container .xterm-screen').getBoundingClientRect();
    const rows = term().rows;
    const cellH = screen.height / rows;
    const vy = term().buffer.active.viewportY;
    return { screen, rows, cellH, cellW: screen.width / term().cols, vy, top: (k) => screen.top + (k - vy) * cellH };
  }

  /** Claude's bar, found here from the design's words (D8), not from services/claude-bar.ts. */
  function findBar() {
    const b = term().buffer.active;
    const R = b.baseY + b.cursorY;
    const text = (i) => { const l = b.getLine(i); return l ? l.translateToString(true) : ''; };
    if (!text(R).startsWith('❯')) return null;
    const rule = (s) => /^─+$/.test(s);
    if (!rule(text(R - 1)) || !rule(text(R + 1))) return null;
    const line = b.getLine(R);
    const cell = b.getNullCell();
    let empty = true;
    for (let x = 2; x < term().cols && empty; x++) {
      line.getCell(x, cell);
      const ch = cell.getChars();
      if (ch === '' || ch === ' ' || cell.isDim()) continue;
      if (cell.isInverse()) { // the caret: empty when what follows it is Claude's dim hint
        let dimAfter = 0;
        for (let y = x + 1; y < term().cols; y++) {
          line.getCell(y, cell);
          const c2 = cell.getChars();
          if (c2 === '' || c2 === ' ') continue;
          if (cell.isDim()) dimAfter++; else { empty = false; break; }
        }
        if (empty && dimAfter === 0) empty = false;
        break;
      }
      empty = false;
    }
    return { R, empty };
  }

  const feeder = (name) => {
    const events = FX.recordings[name];
    let i = 0;
    return {
      events,
      get done() { return i >= events.length; },
      async to(mark) { // every chunk up to the mark
        while (i < events.length) {
          const e = events[i++];
          if (e.mark === mark) break;
          if (e.b) await write(toBytes(e.b));
        }
        await frame();
      },
      async next() { // the next chunk alone (marks skipped)
        while (i < events.length) {
          const e = events[i++];
          if (e.b) { await write(toBytes(e.b)); await frame(); return true; }
        }
        return false;
      },
      async untilEmptyBar() {
        while (i < events.length) {
          const e = events[i++];
          if (!e.b) continue;
          await write(toBytes(e.b));
          const bar = findBar();
          if (bar && bar.empty) { await frame(); return true; }
        }
        return false;
      },
    };
  };

  /** Engage the box as a Claude tab does: the compose box on, Claude Code reporting. */
  async function engage(overBar) {
    if (overBar === false) {
      if (typeof pane.setComposeOverBar === 'function') pane.setComposeOverBar(false);
    }
    pane.setComposeFirst(true, null);
    await report('idle');
    await settle(450);
  }

  async function typeDraft(text, withKey) {
    const ta = textarea();
    ta.focus();
    if (withKey) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(300);
  }

  // ---------------------------------------------------------------- D15 / D17: long drafts make room below
  // Written against the DESIGN (docs/compose-box.md, "Design, part 3", D15, D17), from what can be seen: the
  // box's rectangle, xterm's rows, the terminal's row count and the pane's rectangle.

  /** The pane's content bottom: its rectangle's bottom less its own bottom border and padding. */
  function paneContentBottom() {
    const r = pane.element.getBoundingClientRect();
    const cs = getComputedStyle(pane.element);
    return r.bottom - parseFloat(cs.paddingBottom || '0') - parseFloat(cs.borderBottomWidth || '0');
  }

  /** The absolute buffer row of the terminal's last row. */
  const lastRow = () => term().buffer.active.baseY + term().rows - 1;

  /** The text lines of rows [from, to] of the active buffer, for the stand-in redraw below. */
  function snapshotLines(from, to) {
    const b = term().buffer.active;
    const out = [];
    for (let i = from; i <= to; i++) { const l = b.getLine(i); out.push(l ? l.translateToString(true) : ''); }
    return out;
  }

  /**
   * STAND-IN for Claude Code's redraw after a resize. The real Claude Code redraws when the pty's size changes
   * (SIGWINCH); the stub pty can't send one, and the recorded bytes are positioned for 100x30. So, after Patton
   * resizes the terminal (startStandIn calls this the frame the rows change), this repaints the screen as Claude would for the new row count: it writes the bar (rule, `❯` line, rule) and the footer lines taken from the idle screen as
   * they stood in the recording, bottom-aligned in the new row count, the cursor parked on the `❯` line
   * (D8), the `❯` line empty. At 30 rows it reproduces the idle screen's bar and footer where they were.
   * It erases from the bar's first row down and repaints with cursor moves and erase-line (never a full-screen
   * clear), so it is safe over a scrolled-up viewport.
   */
  async function redrawFor(lines) {
    const rows = term().rows;
    const cols = term().cols;
    const first = rows - lines.length + 1; // 1-based row of the first line
    let out = `\x1b[0m\x1b[${first};1H\x1b[J`; // erase from the bar's first row down, as Claude's renderer does
    let cursorRow = first;
    lines.forEach((l, i) => {
      const isBar = l.startsWith('❯');
      if (isBar) cursorRow = first + i;
      const txt = isBar ? '❯ ' : /^─+$/.test(l) ? '─'.repeat(cols) : l;
      out += `\x1b[${first + i};1H\x1b[2K${txt}`;
    });
    out += `\x1b[${cursorRow};3H`;
    await write(out);
    await frame();
  }

  /**
   * The redraw as it happens: Claude Code redraws within about 100 ms of the pty's size changing. This polls the
   * terminal's row count every animation frame and, the frame it changes, calls redrawFor at once (in `over`
   * and in `dock`: the real Claude redraws whether or not he is scrolled up). Returns a stop function.
   */
  function startStandIn(lines, delayMs = 0) {
    let last = term().rows;
    let lastCols = term().cols;
    let stopped = false;
    let busy = false;
    const timers = [];
    const tick = async () => {
      if (stopped) return;
      if (delayMs > 0) { // a slower Claude: the redraw for each size change lands delayMs after it
        if (term().rows !== last || term().cols !== lastCols) {
          last = term().rows;
          lastCols = term().cols;
          timers.push(setTimeout(() => { if (!stopped) redrawFor(lines); }, delayMs));
        }
        requestAnimationFrame(tick);
        return;
      }
      if (!busy && term().rows !== last) {
        busy = true;
        last = term().rows;
        await redrawFor(lines);
        // `last` stays the row count redrawn for: a resize made meanwhile (Patton working k out from this very
        // redraw, S60) is redrawn for at the next frame, as Claude redraws after each SIGWINCH
        busy = false;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { stopped = true; for (const t of timers) clearTimeout(t); };
  }

  const room = (n) => Array.from({ length: n }, (_, i) => `draft line ${i + 1}`).join('\n');

  // ---------------------------------------------------------------- the scenarios
  const kNow = () => pane.composeRoomRows; // Pane's private count of rows given up (D15)

  /** A fresh pane on the end of the `turn` recording (or a stand-in layout), the box engaged, k = 0. */
  async function setupPane() {
    await newPane();
    const baseRows = term().rows;
    const f = feeder('turn');
    await f.untilEmptyBar();
    await engage();
    await report('working');
    while (await f.next()) { /* every chunk of the recorded turn */ }
    await report('idle');
    await settle(450);
    let bar = findBar();
    if (!bar || !bar.empty || lastRow() - (bar.R + 1) > 4) {
      await redrawFor(['─'.repeat(term().cols), '❯ ', '─'.repeat(term().cols), '  ? for shortcuts', '  Opus']);
      await settle(450);
      bar = findBar();
    }
    if (!bar || !bar.empty) return null;
    await settle(1200); // past D9's once-a-second rule, so the first draft is worked out at once
    return { baseRows, bar, barLines: snapshotLines(bar.R - 1, lastRow()) };
  }

  /** Rows of the terminal sampled every frame for `ms`. */
  async function sampleRows(ms) {
    const seen = new Set([term().rows]);
    const end = performance.now() + ms;
    while (performance.now() < end) { await frame(); seen.add(term().rows); }
    return [...seen];
  }

  async function hiddenPaneChecks(at) {
    const s = await setupPane();
    if (!s) { check(`${at} hidden pane: Claude's bar found`, false, null); return; }
    const stop = startStandIn(s.barLines);
    // the box's text takes the terminal's font size from Settings: do that first, so the font change below
    // goes back to a font the box already has
    pane.setFontSize(term().options.fontSize);
    await typeDraft(room(8));
    await settle(1800);
    const k0 = kNow();
    const rows0 = term().rows;
    measures.push(`${at} hidden pane: base ${s.baseRows} rows, after the 8-line draft ${rows0} rows, k ${k0}, placement ${pane.element.dataset.composePlacement}, font ${term().options.fontSize}`);
    check(`${at} hidden pane: precondition, the terminal gave up rows for an 8-line draft`, k0 >= 1 && rows0 < s.baseRows, { k0, rows0, baseRows: s.baseRows });

    // a tab switched away and back: the resize observer fires while the pane is display:none
    pane.hide();
    await settle(300);
    pane.show();
    const rowsA = term().rows;
    const seenA = await sampleRows(500);
    check(`${at} hidden pane: hide, 300 ms, show: the terminal has the same rows straight after show() and after the observer (${rows0})`,
      rowsA === rows0 && seenA.length === 1 && seenA[0] === rows0, { rows0, rowsA, seenA });

    // a font change while hidden (Settings changes it for every tab)
    const size = term().options.fontSize;
    pane.hide();
    await settle(100);
    pane.setFontSize(size + 2);
    pane.setFontSize(size);
    await settle(300);
    pane.show();
    const rowsB = term().rows;
    const seenB = await sampleRows(500);
    check(`${at} hidden pane: a font change while hidden and back: the same rows straight after show() and 500 ms later (${rows0})`,
      rowsB === rows0 && seenB.length === 1 && seenB[0] === rows0, { rows0, rowsB, seenB, k: kNow() });
    measures.push(`${at} hidden pane: rows ${rows0} -> ${rowsA} (hide/show) -> ${rowsB} (font), k ${kNow()}, cell ${r1(grid().cellH)}`);
    stop();
  }

  async function paneHeightChecks(at) {
    const s = await setupPane();
    if (!s) { check(`${at} pane height: Claude's bar found`, false, null); return; }
    const stop = startStandIn(s.barLines);
    await typeDraft(room(40)); // past the cap: k follows the cap
    await settle(1800);
    const paneH = () => pane.element.clientHeight;
    const expectedK = () => {
      const bar = findBar();
      const cellH = grid().cellH;
      if (!bar || !bar.empty) return null;
      const third = Math.floor(paneH() / 3);
      return Math.ceil(Math.max(0, third - 1) / cellH) - 3 - Math.max(0, lastRow() - (bar.R + 1));
    };
    const k0 = kNow();
    const h0 = paneH();
    check(`${at} pane height: precondition, a 40-line draft gives up rows (k ${k0}) and equals the cap's k (${expectedK()})`, k0 >= 1 && k0 === expectedK(), { k0, h0, expected: expectedK() });

    host.style.height = `${parseFloat(host.style.height) - 170}px`;
    await settle(2600); // the observer's 100 ms, D9's second, Claude's redraw
    const k1 = kNow();
    const b1 = box().getBoundingClientRect();
    const g1 = grid();
    const third1 = Math.floor(paneH() / 3);
    const d1 = { h0, h1: paneH(), k0, k1, expected: expectedK(), box: { h: r1(b1.height), bottom: r1(b1.bottom) }, third1, contentBottom: r1(paneContentBottom()), cellH: r1(g1.cellH) };
    check(`${at} pane height: a shorter pane (${h0} -> ${paneH()} px) works k out again from the smaller cap (${k0} -> ${expectedK()})`, k1 === expectedK() && k1 < k0, d1);
    check(`${at} pane height: the box is no taller than a third of the shorter pane, its bottom at or below the terminal's last row (S61: no fill to the pane's bottom)`,
      b1.height <= third1 + 1 && b1.bottom >= g1.screen.bottom - 1, d1);
    const seen1 = [];
    for (let i = 0; i < 3; i++) { await sleep(600); seen1.push(`${term().rows}/${kNow()}`); }
    check(`${at} pane height: no loop, the rows and k hold over 1.8 s after the settle`, new Set(seen1).size === 1, seen1);

    host.style.height = `${parseFloat(host.style.height) + 330}px`;
    await settle(2600);
    const k2 = kNow();
    check(`${at} pane height: a taller pane (${paneH()} px) gives k from the larger cap (${k1} -> ${expectedK()})`, k2 === expectedK() && k2 > k1, { k1, k2, expected: expectedK(), h: paneH() });
    stop();
  }

  async function staleBarChecks(at) {
    // k a clean run gives for an n-line draft
    const clean = {};
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const s = await setupPane();
      if (!s) { check(`${at} stale bar: Claude's bar found`, false, null); return; }
      const stop = startStandIn(s.barLines);
      await typeDraft(room(n));
      await settle(1800);
      clean[n] = kNow();
      stop();
    }
    measures.push(`${at} stale bar: k of a clean n-line draft: ${JSON.stringify(clean)}`);
    // The 7-line draft, then each shorter one that needs less room: n1 lines make the terminal give
    // up rows; in the same tick, before Claude has redrawn its bar (barRow is still the one from before the
    // resize), the draft shrinks to n2 lines. Worked out from the stale bar row, k would stay (or fall too little).
    const pairs = [];
    for (const n2 of [2, 3, 4, 5, 6]) if (clean[n2] < clean[7]) pairs.push([7, n2]);
    check(`${at} stale bar: precondition, draft lengths whose k differs`, pairs.length > 0, clean);
    for (const [n1, n2] of pairs) {
      const s = await setupPane();
      if (!s) { check(`${at} stale bar: Claude's bar found`, false, null); return; }
      const ta = textarea();
      ta.focus();
      ta.value = room(n1);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const rowsAfterFirst = term().rows;
      const k1 = kNow();
      ta.value = room(n2);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const staleWant = pane.composeRoomWanted();
      const pend = pane.composeRoomTimer !== null;
      await sleep(80);
      await redrawFor(s.barLines); // Claude's redraw, after the resize
      await settle(2800);
      check(`${at} stale bar: ${n1} then ${n2} lines: precondition, the first draft made the terminal give up rows at once (k ${k1})`,
        k1 === clean[n1] && rowsAfterFirst < s.baseRows, { k1, rowsAfterFirst, baseRows: s.baseRows, clean });
      measures.push(`${at} stale bar: ${n1} -> ${n2}: right after the second edit k ${k1}, k worked out from the bar row as it stood ${staleWant}, timer ${pend}, rows ${rowsAfterFirst}, barRow ${pane.barRow}`);
      check(`${at} stale bar: ${n1} lines, then ${n2} before Claude's redraw: k is ${clean[n2]} (the ${n2}-line draft's), not ${clean[n1]}`,
        kNow() === clean[n2], { k: kNow(), want: clean[n2], clean });
    }
  }

  // ---------------------------------------------------------------- settling (S60): Claude slow to redraw
  // Each scenario prints one summary line under "Measured": the room changes logged (rows given up, `>`
  // between), placements under, room holds, the terminal's rows over time, pty.resize calls, the settled logs
  // (cause:ms, `!` when the ceiling ended it) and k at the end against the k worked out from scratch.

  /** From now until stop(): the terminal's rows and k each frame, and the logs and pty.resize calls meanwhile. */
  function startWatch() {
    const l0 = logs.length;
    const p0 = ptyResizes;
    const rowsSeq = [term().rows];
    const kSeq = [kNow()];
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      if (term().rows !== rowsSeq[rowsSeq.length - 1]) rowsSeq.push(term().rows);
      if (kNow() !== kSeq[kSeq.length - 1]) kSeq.push(kNow());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return {
      stop() {
        stopped = true;
        const got = logs.slice(l0);
        const of = (tag) => got.filter((x) => x.tag === tag);
        return {
          rowsSeq, kSeq,
          rooms: of('[COMPOSE] room').map((x) => x.data.rows),
          unders: of('[COMPOSE] place').filter((x) => x.data.placement === 'under').length,
          held: of('[COMPOSE] room held').length,
          settled: of('[COMPOSE] settled').map((x) => `${x.data.cause}:${x.data.afterMs}${x.data.found ? '' : '!'}`),
          pty: ptyResizes - p0,
        };
      },
    };
  }
  /** Times k went from 0 to more than 0 (each a give-up of rows: more than one in a run is the box flapping). */
  const giveUps = (kSeq) => kSeq.filter((k, i) => i > 0 && k > 0 && kSeq[i - 1] === 0).length;
  const summary = (r) => `room ${r.rooms.join('>') || '-'}, under ${r.unders}, held ${r.held}, rows ${r.rowsSeq.join('>')}, pty.resize ${r.pty}, settled [${r.settled.join(' ')}]`;

  /** k for `draft` worked out from scratch on the screen as it now stands: a one-line draft (k 0), Claude's
   *  redraw, then the draft again, typed on a settled screen. */
  async function refK(delayMs, draft) {
    await typeDraft('x');
    await sleep(delayMs + 1700);
    await typeDraft(draft);
    await sleep(delayMs + 1900);
    await frame();
    return kNow();
  }

  async function delayChecks(at) {
    const s0 = await setupPane();
    if (!s0) { check(`${at} delay: Claude's bar found`, false, null); return; }
    let stop = startStandIn(s0.barLines);
    await typeDraft(room(8));
    await settle(1800);
    const clean = kNow();
    stop();
    check(`${at} delay: precondition, an 8-line draft gives up rows with a prompt redraw (k ${clean})`, clean >= 1, { clean });
    for (const D of [100, 600, 1200, 2500, 4000]) {
      const s = await setupPane();
      if (!s) { check(`${at} delay ${D}: Claude's bar found`, false, null); continue; }
      stop = startStandIn(s.barLines, D);
      const w = startWatch();
      await typeDraft(room(8));
      await sleep(7700);
      const r = w.stop();
      stop();
      const flaps = giveUps([0, ...r.kSeq]);
      measures.push(`${at} delay ${D} ms: ${summary(r)}, k ${r.kSeq.join('>')} (clean ${clean})`);
      if (D <= 2500) {
        check(`${at} delay ${D}: at most one room resize in 8 s`, r.rooms.length <= 1, summary(r));
        check(`${at} delay ${D}: k at the end is the clean k (${clean})`, kNow() === clean, { k: r.kSeq, clean });
      }
      if (D <= 1200) check(`${at} delay ${D}: the box never goes under`, r.unders === 0, summary(r));
      check(`${at} delay ${D}: no flapping, rows given up at most once in 8 s`, flaps <= 1, { k: r.kSeq, rows: r.rowsSeq });
      if (D > 3000) {
        // Past the settling ceiling the box went under: a later trigger that isn't the draft's content (here
        // the Interface Text Size changed and back) on the redrawn bar must not give rows up again.
        await sleep(2000); // Claude's slow redraw after the box came back over
        const w2 = startWatch();
        U.applyUiTextScale(SCALES[0] + 0.1, 'change');
        await sleep(1500);
        U.applyUiTextScale(SCALES[0], 'change');
        await sleep(1500);
        const r2 = w2.stop();
        measures.push(`${at} delay ${D} ms, then the text size changed and back: ${summary(r2)}, k ${r2.kSeq.join('>')}`);
        check(`${at} delay ${D}: the box went under past the ceiling, and a later trigger gives no rows up (room held, logged)`,
          r.unders >= 1 && kNow() === 0 && r2.held >= 1 && giveUps([0, ...r.kSeq, ...r2.kSeq]) <= 1, summary(r2));
      }
    }
  }

  /** k after `act` (a resize or an aside) with Claude's redraw `delayMs` late, against refK on the same screen. */
  async function kAfterCase(at, name, delayMs, act, before) {
    const s = await setupPane();
    if (!s) { check(`${at} ${name}: Claude's bar found`, false, null); return; }
    const stop = startStandIn(s.barLines, delayMs);
    if (before) await before();
    const draft = room(8);
    await typeDraft(draft);
    await settle(Math.max(1800, delayMs + 1300));
    const k0 = kNow();
    const w = startWatch();
    const cleanup = await act(s);
    await sleep(3200);
    await frame();
    const r = w.stop();
    const k1 = kNow();
    const ref = await refK(delayMs, draft);
    stop();
    if (cleanup) cleanup();
    measures.push(`${at} ${name}: ${summary(r)}, k ${k0} -> ${r.kSeq.join('>')} (from scratch ${ref})`);
    check(`${at} ${name}: precondition, the draft gave up rows (k ${k0})`, k0 >= 1, { k0 });
    check(`${at} ${name}: k after (${k1}) is the k the same screen and draft give from scratch (${ref})`, k1 === ref, summary(r));
  }

  const splitCase = (at) => kAfterCase(at, 'F1 split', 150, async () => {
    const other = document.createElement('div');
    const sc = new U.SplitContainer('horizontal', 0.5, pane.element, other, () => {});
    host.appendChild(sc.element);
    pane.show(); // as Tab does after a split
    return () => { if (typeof sc.dispose === 'function') sc.dispose(); sc.element.remove(); };
  });
  const fontCase = (at) => kAfterCase(at, 'F2 font', 150,
    async () => { pane.setFontSize(term().options.fontSize + 2); },
    async () => { pane.setFontSize(term().options.fontSize); }); // the box takes the terminal's size first
  const asideCase = (at) => kAfterCase(at, 'F3 aside end', 150, async (s) => {
    await report('blocked', 'permission');
    await settle(400);
    // Claude's question: output scrolls the screen and a dialog replaces the bar
    const b = term().buffer.active;
    const bar = findBar();
    const top = bar ? bar.R - 1 - b.baseY + 1 : term().rows - 4;
    let out = `\x1b[0m\x1b[${top};1H\x1b[J`;
    for (let i = 1; i <= 14; i++) out += `output line ${i}\r\n`;
    out += 'Do you want to proceed?\r\n\u276f 1. Yes\r\n  2. No';
    await write(out);
    await settle(300);
    await redrawFor(s.barLines); // answered: Claude's bar again at the bottom
    await report('idle');
  });
  const windowCase = (at) => kAfterCase(at, 'F4 window 120 px shorter, redraw 700 ms', 700, async () => {
    host.style.height = `${parseFloat(host.style.height) - 120}px`;
  });

  /** A draft typed inside a settling, and Claude's redraw later than the settling's ceiling (3 s) but inside the
   *  lost wait: the k decision the ceiling left waiting runs at the reading that finds the bar again, so k ends
   *  as it would from scratch (it stayed 0 until the next height change before the fix). */
  async function lateCase(at) {
    const s = await setupPane();
    if (!s) { check(`${at} late redraw: Claude's bar found`, false, null); return; }
    let stop = startStandIn(s.barLines, 3200);
    const w = startWatch();
    host.style.height = `${parseFloat(host.style.height) - 120}px`; // fewer rows: xterm trims the bar; the settling opens
    await sleep(300);
    const draft = room(8);
    await typeDraft(draft); // a content change inside the settling: its k waits for the bar
    await sleep(3200 + 2200);
    await frame();
    const r = w.stop();
    const k1 = kNow();
    const place = pane.element.dataset.composePlacement;
    stop();
    stop = startStandIn(s.barLines, 150);
    const ref = await refK(150, draft);
    stop();
    measures.push(`${at} late redraw: ${summary(r)}, k ${r.kSeq.join('>')}, placement ${place} (from scratch ${ref})`);
    check(`${at} late redraw: precondition, the ceiling ended the settling without a reading and the box stayed over`,
      r.settled.some((x) => x.endsWith('!')) && place === 'over', summary(r));
    check(`${at} late redraw: k after the redraw (${k1}) is the k the same screen and draft give from scratch (${ref})`,
      ref >= 1 && k1 === ref, summary(r));
  }

  /** The anti-flap hold when the box goes under and the draft wraps differently there: the box is wider under
   *  the terminal (the pane's width, not the grid's), so a draft wrapping over the bar can be shorter under it, and
   *  the under refit's own height change could take the rows back (k 0) before the hold read k, so no hold was set
   *  (pane.ts reads k and its time before refreshSize now). A guard only: in this harness the wider box's first
   *  refreshSize still wraps at the old width, its height change comes after the hold is set, so it passes on the
   *  base too (the reviewer's probe didn't reproduce it either). */
  async function holdWrapCase(at) {
    const s = await setupPane();
    if (!s) { check(`${at} hold wrap: Claude's bar found`, false, null); return; }
    const ta = textarea();
    const inner = () => { const cs = getComputedStyle(ta); return ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); };
    const span = document.createElement('span');
    span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${getComputedStyle(ta).font}`;
    span.textContent = '0'.repeat(100);
    document.body.appendChild(span);
    const chW = span.getBoundingClientRect().width / 100;
    span.remove();
    const wOver = inner();
    pane.setComposeOverBar(false);
    await sleep(700);
    const wUnder = inner();
    pane.setComposeOverBar(true);
    await sleep(1500);
    const nUnder = Math.floor(wUnder / chW);
    const draft = Array.from({ length: 5 }, () => 'x'.repeat(nUnder)).join('\n'); // fits under, wraps over
    const stop = startStandIn(s.barLines, 150);
    await typeDraft(draft);
    await sleep(1800); // past D9's second, the room resize still inside the hold's 5 s
    const k0 = kNow();
    stop();
    const w = startWatch();
    await write(`\x1b[0m\x1b[2J\x1b[Houtput that is not Claude's bar\r\n`); // the bar is gone: lost, the box goes under
    await sleep(1500);
    const r = w.stop();
    const place = pane.element.dataset.composePlacement;
    measures.push(`${at} hold wrap: widths over ${Math.round(wOver)} / under ${Math.round(wUnder)} px, k ${k0}, placement ${place}, held ${pane.composeRoomHeld}, ${summary(r)}`);
    check(`${at} hold wrap: precondition, the draft gave up rows over the bar (k ${k0}) and the box is wider under`, k0 >= 1 && wUnder > wOver, { k0, wOver, wUnder });
    check(`${at} hold wrap: precondition, the bar was lost and the box went under`, place === 'under', { place });
    check(`${at} hold wrap: the hold is set though the box's height changed under (no rows given up again until the draft changes)`,
      pane.composeRoomHeld === true, { held: pane.composeRoomHeld, summary: summary(r) });
  }

  async function sendCase(at) {
    const s = await setupPane();
    if (!s) { check(`${at} send: Claude's bar found`, false, null); return; }
    const stop = startStandIn(s.barLines, 150);
    await typeDraft(room(8));
    await settle(1800);
    const k0 = kNow();
    const w = startWatch();
    const ta = textarea();
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(3000);
    const r = w.stop();
    stop();
    measures.push(`${at} send: ${summary(r)}, k ${k0} -> ${r.kSeq.join('>')}, draft ${JSON.stringify(ta.value.slice(0, 20))}`);
    check(`${at} send: precondition, the draft gave up rows (k ${k0})`, k0 >= 1, { k0 });
    check(`${at} send: the rows come back in one resize and stay`, kNow() === 0 && r.rooms.length === 1 && r.rooms[0] === 0 && r.rowsSeq.length === 2, summary(r));
  }

  const wanted = (g) => !GROUPS || GROUPS.includes(g);
  const guarded = async (at, name, run) => {
    if (!wanted(name)) return;
    try { await run(at); } catch (err) { check(`${at} ${name} ran to the end`, false, String((err && err.stack) || err).slice(0, 400)); }
  };
  try {
    for (const [i, S] of SCALES.entries()) {
      U.applyUiTextScale(S, 'change');
      const at = `x${S}`;
      for (const [name, run] of [['hidden', hiddenPaneChecks], ['height', paneHeightChecks], ['stale', staleBarChecks]]) await guarded(at, name, run);
      if (i > 0) continue; // the settling cases at the first scale only: they are long
      for (const [name, run] of [['delay', delayChecks], ['split', splitCase], ['font', fontCase], ['aside', asideCase], ['window', windowCase], ['late', lateCase], ['holdwrap', holdWrapCase], ['send', sendCase]]) await guarded(at, name, run);
    }
  } finally {
    if (pane) pane.dispose();
  }
  return { checks, measures };
}
