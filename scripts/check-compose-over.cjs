// Hidden-Electron layout check of the compose box laid over Claude Code's own
// input bar (docs/compose-box.md, "Design, part 2: one typing bar", D8-D13;
// map node bar_layout_check). The REAL Pane (real TerminalView and xterm, DOM
// renderer, real CSS, a stub preload bridge) in a window that is never shown,
// fed Claude Code v2.1.321's recorded pty bytes (scripts/fixtures/
// claude-bar-screens.json, 100x30) through its real terminal; the pane is sized
// so the terminal is 100x30 when it has the pane to itself. Measured with
// getBoundingClientRect against the DESIGN (not the code), at UI scale 1, 1.1
// and 1.5 (the real applyUiTextScale), light scheme:
//  1. `over` at idle, mid-turn (every chunk of the `turn` recording that leaves
//     the cursor on an empty bar), after a turn and on the `queue` recording:
//     the box covers rows R-1..R+1 within 1 px (R found here, independently of
//     services/claude-bar.ts: the cursor's row starts with `❯`, the rows above
//     and below are `─` rules), left/right on the grid's edges, opaque; the
//     terminal keeps the rows the whole pane gives (as with no box at all);
//  2. a long draft grows the box upward from the same bottom edge, never past a
//     third of the pane, the text scrolling inside it; the terminal's rows stay;
//  3. `dock` on the terminal's bottom edge (hairline on top) when scrolled up,
//     `over` again when scrolled down;
//  4. `under` (in the flow, below the terminal) on the typed (after 400 ms),
//     wrapped, multi-line, history and `/` screens; `over` again once cleared;
//  5. a question with a draft: box transparent at once, visibility hidden after
//     the typing grace, "Draft kept" in the pane's bottom-right corner; no note
//     without a draft; the box back over the bar after; a menu aside shows
//     "Type here", never "Draft kept";
//  6. Okay? inside the box at its left, the Okay? row hidden, the box three
//     rows tall where its contents fit (D12: it may grow upward where they
//     don't; the height is printed in px and rows at each scale);
//  7. composeOverBar off: `under` throughout, Okay? in the box.
// Not covered: the WebGL renderer (the grid is the same .xterm-screen box),
// Claude Code's own redraw after a resize (the recordings were made at 100x30;
// when the box goes under, xterm reflows the recorded screen instead).
//
// Run: node scripts/check-compose-over.cjs
//   COMPOSE_SRC_ROOT=<folder holding src/>  bundle another source tree (to prove the check bites)
//   COMPOSE_OVER_CHECK_DIR=<folder>         where the bundle, userData and result go (default: a temp folder, removed after)
// Prints `ok <what>` or `not ok <what>: <measured>` per assertion; exit 1 on any failure.
// The same file runs twice: under Node it bundles the sources with esbuild and
// starts Electron on itself; under Electron it opens one window that is never
// shown (show:false, dock hidden), runs the checks and exits.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HARD_TIMEOUT_MS = 240000;
const SCALES = process.env.COMPOSE_OVER_SCALES ? process.env.COMPOSE_OVER_SCALES.split(',').map(Number) : [1, 1.1, 1.5];

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
  const ownDir = !process.env.COMPOSE_OVER_CHECK_DIR;
  const outDir = process.env.COMPOSE_OVER_CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'patton-check-compose-over-'));
  fs.mkdirSync(outDir, { recursive: true });
  const resultFile = path.join(outDir, 'result.json');
  fs.rmSync(resultFile, { force: true });

  await build({
    stdin: {
      resolveDir: srcRoot,
      loader: 'ts',
      contents: `
        import { Pane } from './src/renderer/components/pane';
        import { applyUiTextScale } from './src/renderer/services/ui-text-scale';
        (window as any).__co = { Pane, applyUiTextScale };
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
  const env = { ...process.env, COMPOSE_OVER_CHECK_DIR: outDir };
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
  const outDir = process.env.COMPOSE_OVER_CHECK_DIR;
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
  const answers = {
    'pty.create': () => 1, 'pty.respawn': () => 2, 'pty.getShell': () => '/bin/zsh', 'pty.getCwd': () => '',
    'pty.inputState': () => [{ dirty: false, length: 0, lastInputAt: 0, slashSubmitAt: 0, userStashAt: 0, pattonStashAt: 0 }],
    'history.get': () => [], 'pauseAll.stashKey': () => ({ ok: true }),
  };
  const stub = (name) => new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : stub(name ? name + '.' + String(k) : String(k))),
    apply: (_t, _this, args) => {
      if (name === 'log.send') { logs.push({ tag: String(args[1] && args[1][0]), data: args[1] && args[1][1] }); return undefined; }
      const last = name.split('.').pop();
      if (/^on[A-Z]/.test(last)) return () => {};
      if (name === 'pty.write' || name === 'pty.resize') return undefined;
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
  const place = () => pane.element.dataset.composePlacement || '(none)';
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

  /** The box's geometry against Claude's bar rows R-1..R+1 (D9 over, D12). */
  function overGeometry(label, R) {
    const g = grid();
    const b = box().getBoundingClientRect();
    const cs = getComputedStyle(box());
    const wantTop = g.top(R - 1);
    const wantBottom = g.top(R + 2);
    const field = q('.editor-container .editor-field');
    const need = field ? field.getBoundingClientRect().height + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) : 0;
    const fits = need <= 3 * g.cellH + 0.5;
    const d = {
      placement: place(), R, viewportY: g.vy, cellH: r1(g.cellH),
      box: { top: r1(b.top), bottom: r1(b.bottom), left: r1(b.left), right: r1(b.right), h: r1(b.height) },
      want: { top: r1(wantTop), bottom: r1(wantBottom), left: r1(g.screen.left), right: r1(g.screen.right) },
      contentNeeds: r1(need),
    };
    check(`${label}: placement over`, place() === 'over', d);
    check(`${label}: bottom edge on row R+1's bottom (1 px)`, Math.abs(b.bottom - wantBottom) <= 1, d);
    if (fits) check(`${label}: top edge on row R-1's top (1 px), three rows, no other row covered`, Math.abs(b.top - wantTop) <= 1, d);
    else check(`${label}: contents need more than three rows, so the box grows upward to fit them (D12)`, Math.abs(b.height - need) <= 1 && b.top < wantTop, d);
    check(`${label}: left and right on the grid's edges (1 px)`,
      Math.abs(b.left - g.screen.left) <= 1 && Math.abs(b.right - g.screen.right) <= 1, d);
    return { g, b, d, fits, need };
  }

  function opaque(label) {
    const cs = getComputedStyle(box());
    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    const alpha = m && m[1].split(',').length === 4 ? parseFloat(m[1].split(',')[3]) : 1;
    check(`${label}: opaque (background alpha 1, opacity 1, visible)`,
      m && alpha === 1 && cs.opacity === '1' && cs.visibility === 'visible',
      { background: cs.backgroundColor, opacity: cs.opacity, visibility: cs.visibility });
  }

  function underGeometry(label) {
    const g = grid();
    const b = box().getBoundingClientRect();
    const tc = q('.terminal-container').getBoundingClientRect();
    const cs = getComputedStyle(box());
    const tcs = getComputedStyle(q('.terminal-container'));
    const contentH = parseFloat(tcs.height) - (tcs.boxSizing === 'border-box' ? parseFloat(tcs.paddingTop) + parseFloat(tcs.paddingBottom) : 0);
    const d = { placement: place(), position: cs.position, boxTop: r1(b.top), boxH: r1(b.height), terminalBottom: r1(tc.bottom), gridBottom: r1(g.screen.bottom), rows: g.rows, rowsThatFit: Math.floor(contentH / g.cellH), containerContentH: r1(contentH) };
    const core = term()._core;
    const fitCell = core && core._renderService ? core._renderService.dimensions.css.cell.height : null;
    d.xtermCellH = fitCell === null ? null : r1(fitCell);
    check(`${label}: placement under, the box in the flow below the terminal container, overlapping none of it`,
      place() === 'under' && cs.position !== 'absolute' && b.height > 0 && b.top >= tc.bottom - 0.5, d);
    check(`${label}: the terminal's last row whole above the box (not clipped under it)`, b.top >= g.screen.bottom - 0.5, d);
    measures.push(`${label}: box ${d.boxH} px from ${d.boxTop}; terminal ${d.rows} rows (${d.rowsThatFit} fit its ${d.containerContentH} px), grid bottom ${d.gridBottom}, container bottom ${d.terminalBottom}`);
    // The columns, the same way (fit_padding): the last column inside the container's content box
    // and clear of the vertical scrollbar's strip on the .xterm element's right edge.
    const xr = q('.terminal-container .xterm').getBoundingClientRect();
    const sb = q('.terminal-container .xterm .scrollbar.vertical');
    const sbW = sb ? sb.getBoundingClientRect().width : 14;
    const contentRight = tc.right - (tcs.boxSizing === 'border-box' ? parseFloat(tcs.paddingRight) : 0);
    const c = { cols: term().cols, gridRight: r1(g.screen.right), contentRight: r1(contentRight), xtermRight: r1(xr.right), scrollbarW: r1(sbW), scrollbarLeft: r1(xr.right - sbW) };
    check(`${label}: the terminal's last column inside the container's content box and clear of the scrollbar`, g.screen.right <= contentRight + 0.5 && g.screen.right <= xr.right - sbW + 0.5, c);
    measures.push(`${label}: ${c.cols} cols, grid right ${c.gridRight}, content right ${c.contentRight}, scrollbar from ${c.scrollbarLeft} (${c.scrollbarW} px)`);
  }

  function okayInBox(label) {
    const btn = q('.editor-container.compose-first .editor-field > .okay-button:first-child');
    const row = q('.okay-row');
    const rowHidden = !row || row.hidden || getComputedStyle(row).display === 'none';
    if (!btn) { check(`${label}: Okay? is the first thing in the box's field`, false, { found: false, rowHidden }); return; }
    const b = box().getBoundingClientRect();
    const k = btn.getBoundingClientRect();
    const padL = parseFloat(getComputedStyle(box()).paddingLeft);
    const d = { boxLeft: r1(b.left), okayLeft: r1(k.left), paddingLeft: padL, okayW: r1(k.width), okayH: r1(k.height), rowHidden };
    check(`${label}: Okay? in the box at its left (within the box's left padding), drawn`,
      k.width > 0 && k.left >= b.left - 0.5 && k.left - b.left <= padL + 1 && k.top >= b.top - 0.5 && k.bottom <= b.bottom + 0.5, d);
    check(`${label}: no Okay? row under the terminal`, rowHidden, d);
  }

  function noteInCorner(label, el) {
    const p = pane.element.getBoundingClientRect();
    const n = el.getBoundingClientRect();
    const d = { note: { left: r1(n.left), right: r1(n.right), top: r1(n.top), bottom: r1(n.bottom) }, pane: { right: r1(p.right), bottom: r1(p.bottom), width: r1(p.width) } };
    return {
      ok: n.width > 0 && n.height > 0 && n.right <= p.right + 0.5 && p.right - n.right <= 16
        && n.bottom <= p.bottom + 0.5 && p.bottom - n.bottom <= 12 && n.left > p.left + p.width / 2,
      d,
    };
  }

  const visibleEl = (sel) => {
    const el = pane.element.querySelector(sel);
    if (!el || el.hidden) return null;
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden' ? null : el;
  };

  async function typeDraft(text, withKey) {
    const ta = textarea();
    ta.focus();
    if (withKey) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(300);
  }

  async function runScale(S) {
    const at = `x${S}`;
    U.applyUiTextScale(S, 'change');

    // ---------------- steps recording: idle, draft, typed/wrapped/multi-line, question, menu, history
    const size = await newPane();
    const baseRows = term().rows;
    check(`${at} the pane gives the terminal 100x30 with no box (the recordings' size)`, size.cols === FX.cols && size.rows === FX.rows, size);
    let f = feeder('steps');
    await f.to('idle');
    await engage();
    let bar = findBar();
    if (!bar || !bar.empty) { check(`${at} steps/idle: Claude's bar found on screen`, false, bar); return; }
    const idle = overGeometry(`${at} steps/idle`, bar.R);
    opaque(`${at} steps/idle`);
    check(`${at} steps/idle: the terminal keeps the whole pane's rows (as with no box)`, term().rows === baseRows, { rows: term().rows, baseRows });
    okayInBox(`${at} steps/idle`);
    measures.push(`${at} idle: cell ${r1(idle.g.cellH)} px; box ${r1(idle.b.height)} px = ${r1(idle.b.height / idle.g.cellH)} rows (contents need ${r1(idle.need)} px, ${idle.fits ? 'fit' : 'do not fit'} in 3 rows); box top ${r1(idle.b.top)} vs row R-1 ${r1(idle.g.top(bar.R - 1))}, bottom ${r1(idle.b.bottom)} vs ${r1(idle.g.top(bar.R + 2))}; pane ${r1(pane.element.getBoundingClientRect().height)} px, terminal ${term().cols}x${term().rows}`);

    // 2. A long draft grows the box upward, capped at a third of the pane.
    const paneH = pane.element.getBoundingClientRect().height;
    await typeDraft(Array.from({ length: 7 }, (_, i) => `draft line ${i + 1}`).join('\n'));
    let b7 = box().getBoundingClientRect();
    let g7 = grid();
    check(`${at} long draft (7 lines): grows upward from the same bottom edge, terminal rows unchanged`,
      place() === 'over' && Math.abs(b7.bottom - idle.b.bottom) <= 1 && b7.height > idle.b.height + 1 && b7.height <= Math.floor(paneH / 3) + 1 && term().rows === baseRows,
      { placement: place(), bottom: r1(b7.bottom), wasBottom: r1(idle.b.bottom), h: r1(b7.height), wasH: r1(idle.b.height), third: Math.floor(paneH / 3), rows: term().rows });
    measures.push(`${at} 7-line draft: box ${r1(b7.height)} px (${r1(b7.height / g7.cellH)} rows), a third of the pane ${Math.floor(paneH / 3)} px`);
    await typeDraft(Array.from({ length: 30 }, (_, i) => `draft line ${i + 1}`).join('\n'));
    b7 = box().getBoundingClientRect();
    const ta = textarea();
    check(`${at} long draft (30 lines): never past a third of the pane, the text scrolls inside, terminal rows unchanged`,
      place() === 'over' && Math.abs(b7.bottom - idle.b.bottom) <= 1 && b7.height <= Math.floor(paneH / 3) + 1 && ta.scrollHeight > ta.clientHeight && term().rows === baseRows,
      { placement: place(), bottom: r1(b7.bottom), h: r1(b7.height), third: Math.floor(paneH / 3), scrollH: ta.scrollHeight, clientH: ta.clientHeight, rows: term().rows });
    measures.push(`${at} 30-line draft: box ${r1(b7.height)} px, cap ${Math.floor(paneH / 3)} px`);
    await typeDraft('');
    overGeometry(`${at} draft cleared`, bar.R);

    // 4. under when Claude's bar holds text or isn't found; over again once cleared.
    for (const [mark, clearMark] of [['typed', 'cleared'], ['wrapped', null], ['multiline', 'cleared2']]) {
      await f.to(mark);
      await settle(650);
      underGeometry(`${at} steps/${mark} (after the 400 ms wait)`);
      if (clearMark) {
        await f.to(clearMark);
        await settle(450);
        bar = findBar();
        if (bar && bar.empty) overGeometry(`${at} steps/${clearMark}: over again`, bar.R);
        else check(`${at} steps/${clearMark}: Claude's bar found on screen`, false, bar);
        check(`${at} steps/${clearMark}: the terminal has the whole pane's rows again`, term().rows === baseRows, { rows: term().rows, baseRows });
      }
    }

    // 5. A question with a draft: hidden, "Draft kept"; back over the bar after.
    await f.to('q-sent');
    await report('working');
    await settle(200);
    const overBefore = place();
    await typeDraft('a draft he is writing', true);
    await report('blocked', 'question');
    await f.to('question');
    await sleep(320); await frame(); // past the 250 ms hold, inside the typing grace
    let cs = getComputedStyle(box());
    check(`${at} question with a draft: the box turns transparent at once and takes no pointer`,
      overBefore === 'over' && cs.opacity === '0' && cs.pointerEvents === 'none',
      { placementBefore: overBefore, opacity: cs.opacity, pointerEvents: cs.pointerEvents });
    check(`${at} question with a draft: still focusable inside the typing grace (not visibility hidden yet)`,
      cs.visibility === 'visible' && document.activeElement === textarea(), { visibility: cs.visibility, focused: document.activeElement === textarea() });
    await settle(1500);
    cs = getComputedStyle(box());
    check(`${at} question with a draft: visibility hidden after the grace`, cs.visibility === 'hidden' && cs.opacity === '0', { visibility: cs.visibility, opacity: cs.opacity });
    let note = visibleEl('.compose-draft-note');
    if (!note) check(`${at} question with a draft: "Draft kept" shown`, false, { found: Boolean(pane.element.querySelector('.compose-draft-note')) });
    else {
      const c = noteInCorner(`${at} draft kept`, note);
      check(`${at} question with a draft: "Draft kept" shown inside the pane's bottom-right corner`, c.ok && note.textContent.trim() === 'Draft kept' && note.parentElement === pane.element, c.d);
      measures.push(`${at} "Draft kept": ${JSON.stringify(c.d.note)} in pane right ${c.d.pane.right} bottom ${c.d.pane.bottom}`);
    }
    check(`${at} question: placement frozen (still over)`, place() === 'over', place());
    check(`${at} question: no "Type here" (that is for a menu)`, !visibleEl('.compose-type-here'), null);
    await report('idle');
    await f.to('question-cancelled');
    await settle(500);
    bar = findBar();
    if (bar && bar.empty) overGeometry(`${at} question over, bar back`, bar.R);
    else check(`${at} question over: Claude's bar found on screen`, false, bar);
    opaque(`${at} question over: the box shown again`);
    check(`${at} question over: "Draft kept" gone, the draft still in the box`, !visibleEl('.compose-draft-note') && textarea().value === 'a draft he is writing', { draft: textarea().value });

    // ...and without a draft: hidden, no note.
    await typeDraft('');
    await report('blocked', 'permission');
    await settle(450);
    cs = getComputedStyle(box());
    check(`${at} permission prompt, no draft: box hidden, no "Draft kept"`,
      cs.opacity === '0' && !visibleEl('.compose-draft-note'), { opacity: cs.opacity, note: Boolean(visibleEl('.compose-draft-note')) });
    await report('idle');
    await settle(500);
    bar = findBar();
    if (bar && bar.empty) overGeometry(`${at} permission prompt over: back over the bar`, bar.R);
    opaque(`${at} permission prompt over`);

    // A menu aside (a / line sent from the box): "Type here", never "Draft kept".
    textarea().focus();
    textarea().value = '/help';
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle(200);
    textarea().value = 'a draft during the menu';
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
    await settle(150);
    const typeHere = visibleEl('.compose-type-here');
    cs = getComputedStyle(box());
    if (!typeHere) check(`${at} menu aside: "Type here" shown`, false, { found: Boolean(pane.element.querySelector('.compose-type-here')), opacity: cs.opacity, placement: place() });
    else {
      const c = noteInCorner(`${at} type here`, typeHere);
      check(`${at} menu aside: "Type here" shown inside the pane's bottom-right corner, the box hidden`, c.ok && cs.opacity === '0', { ...c.d, opacity: cs.opacity });
    }
    check(`${at} menu aside with a draft: no "Draft kept"`, !visibleEl('.compose-draft-note'), null);
    if (typeHere) {
      typeHere.click();
      await settle(400);
      cs = getComputedStyle(box());
      check(`${at} "Type here" clicked: the box back, holding the keyboard`, cs.opacity === '1' && document.activeElement === textarea() && !visibleEl('.compose-type-here'),
        { opacity: cs.opacity, focused: document.activeElement === textarea() });
    }
    await typeDraft('');
    await sleep(1300); // past the own-typing window of the / send (D9)

    // History recall and / in Claude's bar: under; the cleared screen: over.
    await f.to('permission-cancelled');
    await settle(450);
    for (const mark of ['history', 'slash']) {
      await f.to(mark);
      await settle(650);
      underGeometry(`${at} steps/${mark} (after the 400 ms wait)`);
    }
    await f.to('end');
    await settle(450);
    bar = findBar();
    if (bar && bar.empty) overGeometry(`${at} steps/end: over again`, bar.R);
    else check(`${at} steps/end: Claude's bar found on screen`, false, bar);

    // ---------------- turn recording: every chunk that leaves the cursor on an empty bar
    await newPane();
    f = feeder('turn');
    await f.untilEmptyBar();
    await engage();
    await report('working');
    let found = 0; let good = 0; let chunks = 0; const bad = [];
    while (await f.next()) {
      chunks++;
      const b2 = findBar();
      if (!b2 || !b2.empty) continue;
      found++;
      const g = grid();
      const r = box().getBoundingClientRect();
      const ok = place() === 'over' && Math.abs(r.bottom - g.top(b2.R + 2)) <= 1 && r.top <= g.top(b2.R - 1) + 1 && r.top >= g.top(b2.R - 1) - 1 - (idle.fits ? 0 : idle.need - 3 * g.cellH);
      if (ok) good++; else if (bad.length < 4) bad.push({ chunk: chunks, placement: place(), R: b2.R, vy: g.vy, top: r1(r.top), bottom: r1(r.bottom), wantTop: r1(g.top(b2.R - 1)), wantBottom: r1(g.top(b2.R + 2)) });
    }
    check(`${at} turn: over Claude's bar rows at every chunk that leaves the cursor on an empty bar (${good} of ${found}; ${chunks} chunks)`, found >= 15 && good === found, { found, good, chunks, bad });
    check(`${at} turn: the terminal keeps the whole pane's rows mid-turn`, term().rows === baseRows, { rows: term().rows, baseRows });
    await report('idle');
    await settle(450);
    bar = findBar();
    if (bar && bar.empty) overGeometry(`${at} turn/after the turn`, bar.R);
    else check(`${at} turn/after the turn: Claude's bar found on screen`, false, bar);
    okayInBox(`${at} turn/after the turn`);

    // ---------------- queue recording, and dock (3)
    await newPane();
    f = feeder('queue');
    await f.to('idle');
    await engage();
    for (const mark of ['working', 'queued', 'queued+1s', 'after']) {
      if (mark === 'working') await report('working');
      if (mark === 'after') await report('idle');
      await f.to(mark);
      await settle(250);
      bar = findBar();
      if (bar && bar.empty) overGeometry(`${at} queue/${mark}`, bar.R);
      else check(`${at} queue/${mark}: Claude's bar found on screen`, false, bar);
    }
    check(`${at} queue: the terminal keeps the whole pane's rows`, term().rows === baseRows, { rows: term().rows, baseRows });
    term().scrollToTop();
    await settle(400);
    {
      const g = grid();
      const r = box().getBoundingClientRect();
      const cs2 = getComputedStyle(box());
      const d = { placement: place(), vy: g.vy, top: r1(r.top), bottom: r1(r.bottom), gridBottom: r1(g.screen.bottom), h: r1(r.height), rowsTall: r1(r.height / g.cellH), borderTop: cs2.borderTopWidth };
      check(`${at} scrolled up (bar out of view): dock, on the terminal's bottom edge (1 px), on the grid's edges`,
        place() === 'dock' && Math.abs(r.bottom - g.screen.bottom) <= 1 && Math.abs(r.left - g.screen.left) <= 1 && Math.abs(r.right - g.screen.right) <= 1, d);
      check(`${at} dock: a hairline on its top edge, three rows tall where its contents fit`,
        parseFloat(cs2.borderTopWidth) >= 1 && (!idle.fits || Math.abs(r.height - 3 * g.cellH) <= 1), d);
      measures.push(`${at} dock: box ${r1(r.height)} px (${r1(r.height / g.cellH)} rows), bottom ${r1(r.bottom)} vs grid bottom ${r1(g.screen.bottom)}`);
    }
    term().scrollToBottom();
    await settle(400);
    bar = findBar();
    if (bar && bar.empty) overGeometry(`${at} scrolled back down: over`, bar.R);

    // ---------------- 7. composeOverBar off: under throughout, Okay? in the box
    await newPane();
    f = feeder('steps');
    await f.to('idle');
    await engage(false);
    const seen = [];
    let allUnder = true;
    underGeometry(`${at} over-bar off, idle`);
    okayInBox(`${at} over-bar off, idle`);
    for (const mark of ['typed', 'cleared', 'wrapped', 'cleared2', 'end']) {
      await f.to(mark);
      await settle(200);
      seen.push(`${mark}:${place()}`);
      if (place() !== 'under') allUnder = false;
    }
    check(`${at} over-bar off: under at every screen of the steps recording`, allUnder, seen);
  }

  try {
    for (const S of SCALES) {
      try { await runScale(S); } catch (err) { check(`x${S} ran to the end`, false, String((err && err.stack) || err).slice(0, 400)); }
    }
  } finally {
    if (pane) pane.dispose();
  }
  const placesLogged = logs.filter((l) => l.tag === '[COMPOSE] place').length;
  measures.push(`[COMPOSE] place lines logged: ${placesLogged}`);
  return { checks, measures };
}
