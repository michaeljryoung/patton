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
//  2. a long draft grows the box down from the same top edge (D15; upward until
//     S60), never past a third of the pane, the text scrolling inside it; with
//     blank rows below Claude's bar to grow over, the terminal's rows stay;
//  3. `dock` on the terminal's bottom edge (hairline on top) when scrolled up,
//     `over` again when scrolled down;
//  4. `under` (in the flow, below the terminal) on the typed (after 400 ms),
//     wrapped, multi-line, history and `/` screens; `over` again once cleared;
//  5. a question with a draft: box transparent at once, visibility hidden after
//     the typing grace, "Draft kept" in the pane's bottom-right corner; no note
//     without a draft; the box back over the bar after; a menu aside shows
//     "Type here", never "Draft kept";
//  6. no Okay? button or row in any placement (removed 2026-11-20, S58), the
//     box's first item from the left the image chips when there are some, else
//     the textarea, the box three rows tall where its contents fit (D12, D15: it grows down where they
//     don't; the height is printed in px and rows at each scale);
//  7. composeOverBar off: `under` throughout, still no Okay? anywhere.
//  8. D15/D17 (docs/compose-box.md, "Design, part 3", `draftRoomChecks`): a draft taller than the rows below
//     the bar leaves the box's top on row R-1's top, covers no row above it, makes the terminal k >= 1 rows
//     shorter with the box's bottom at or below the terminal's last row and no taller than a third of the pane (S61; no blank space under the textarea, Send on the box's first line, the caret kept in view after real paste events), logs `[COMPOSE] room` with rows = k; past a
//     third of the pane the text scrolls; cleared, the terminal has its rows back and the box is over R-1..R+1;
//     in `dock` no row above the last three is covered; three more redraws 600 ms apart leave k alone. Claude's
//     redraw after a resize is stood in for by `redrawFor` (the stub pty sends no SIGWINCH): it clears the
//     viewport and repaints the recorded bar and footer lines bottom-aligned in the new row count.
// Not covered: the WebGL renderer (the grid is the same .xterm-screen box),
// Claude Code's own redraw after a resize (the recordings were made at 100x30;
// when the box goes under, xterm reflows the recorded screen instead).
//
// D14 (20 Nov): with two pasted images the box stays three rows and the images
// sit first from the box's left, then the textarea, left to right, inside it.
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
      if (name === 'log.send') { logs.push({ tag: String(args[1] && args[1][0]), data: args[1] && args[1][1], at: performance.now() }); return undefined; }
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
    check(`${label}: top edge on row R-1's top (1 px), no row above it covered (D15)`, Math.abs(b.top - wantTop) <= 1, d);
    if (fits) check(`${label}: bottom edge on row R+1's bottom (1 px): three rows, no other row covered`, Math.abs(b.bottom - wantBottom) <= 1, d);
    else check(`${label}: contents need more than three rows, so the box grows down to fit them (D15)`, Math.abs(b.height - need) <= 1 && b.bottom > wantBottom, d);
    check(`${label}: left and right on the grid's edges (1 px)`,
      Math.abs(b.left - g.screen.left) <= 1 && Math.abs(b.right - g.screen.right) <= 1, d);
    // D10: the overlay's sizes and visibility change at once, no 0.2 s transition.
    const instant = ['min-height', 'max-height', 'opacity'].every((prop) =>
      !cs.transitionProperty.split(',').some((t) => ['all', prop].includes(t.trim()))
      || cs.transitionDuration.split(',').every((t) => parseFloat(t) === 0));
    check(`${label}: min-height, max-height and opacity change at once (no transition)`, instant,
      { property: cs.transitionProperty, duration: cs.transitionDuration });
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

  /** No Okay? button or row in any placement (removed 2026-11-20, S58); the box's first item from the
   *  left is the image chips when there are some, else the textarea; and, in `over`, three rows tall. */
  function boxFirstItem(label, inOver) {
    const noOkay = !q('.okay-button') && !q('.okay-row');
    const shown = [...box().querySelector('.editor-field').children].filter((el) => !el.hidden && getComputedStyle(el).display !== 'none');
    const first = shown[0];
    const hasImages = Boolean(box().querySelector('.editor-field .compose-image'));
    const want = hasImages ? 'compose-images' : null;
    const isFirstOk = Boolean(first) && (want ? first.classList.contains(want) : first === textarea());
    const g = grid();
    const h = box().getBoundingClientRect().height;
    const d = { noOkay, first: first ? first.className || first.tagName : null, hasImages, boxH: r1(h), rows: r1(h / g.cellH) };
    check(`${label}: no Okay? button or row anywhere`, noOkay, d);
    check(`${label}: the box's first item from the left is the ${hasImages ? 'image chips' : 'textarea'}`, isFirstOk, d);
    if (inOver) check(`${label}: the box is three rows tall in \`over\``, Math.abs(h - 3 * g.cellH) <= 1, d);
  }

  /** D14: n pasted images inside the box, first from the box's left, then the textarea, left to right; the box three rows. */
  function imagesInBox(label, n) {
    const g = grid();
    const b = box().getBoundingClientRect();
    const imgs = [...box().querySelectorAll('.editor-field img')];
    boxFirstItem(label, true);
    const ta = textarea();
    const strip = q('.paste-strip');
    const stripShown = Boolean(strip) && !strip.hidden && getComputedStyle(strip).display !== 'none';
    const lineH = parseFloat(getComputedStyle(ta).lineHeight);
    const rects = imgs.map((el) => el.getBoundingClientRect());
    const t = ta.getBoundingClientRect();
    const d = {
      count: imgs.length, cellH: r1(g.cellH), box: { top: r1(b.top), bottom: r1(b.bottom), left: r1(b.left), right: r1(b.right), h: r1(b.height) },
      textarea: { left: r1(t.left), lineH: r1(lineH) },
      imgs: rects.map((r) => ({ left: r1(r.left), right: r1(r.right), top: r1(r.top), bottom: r1(r.bottom), w: r1(r.width), h: r1(r.height) })), stripShown,
    };
    check(`${label}: ${n} images in the box, the box still three rows, no strip above it`,
      imgs.length === n && Math.abs(b.height - 3 * g.cellH) <= 1 && !stripShown, d);
    let order = rects.length === n;
    let prev = b.left;
    for (const r of rects) {
      order = order && r.width > 0 && r.left >= prev - 0.5 && r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5;
      prev = r.right;
    }
    check(`${label}: the images first from the box's left, then the textarea, left to right, all inside the box`, order && n > 0 && prev <= t.left + 0.5, d);
    check(`${label}: each image as tall as one line of the box's text (1 px)`,
      rects.length === n && n > 0 && rects.every((r) => Math.abs(r.height - lineH) <= 1), d);
    measures.push(`${label}: box ${d.box.h} px (${r1(b.height / g.cellH)} rows), images ${d.imgs.map((r) => `${r.w}x${r.h}`).join(', ')} from ${d.imgs[0] ? d.imgs[0].left : '-'} (text from ${d.textarea.left}), text line ${d.textarea.lineH} px`);
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
  function startStandIn(lines) {
    let last = term().rows;
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (stopped) return;
      if (!busy && term().rows !== last) {
        busy = true;
        last = term().rows;
        await redrawFor(lines);
        last = term().rows;
        busy = false;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { stopped = true; };
  }

  const room = (n) => Array.from({ length: n }, (_, i) => `draft line ${i + 1}`).join('\n');
  /** The newest `[COMPOSE] room` line's rows since logs index `since` (null if none). */
  function lastRoomRows(since) {
    for (let i = logs.length - 1; i >= since; i--) {
      if (logs[i].tag !== '[COMPOSE] room') continue;
      const d = logs[i].data;
      if (d && typeof d === 'object' && 'rows' in d) return Number(d.rows);
      const m = String(typeof d === 'string' ? d : JSON.stringify(d)).match(/rows\D{0,4}(\d+)/);
      return m ? Number(m[1]) : null;
    }
    return null;
  }

  /** A frame-by-frame record of the terminal's rows, the placement and the box, and the [COMPOSE] log lines, with times. */
  function startTimeline() {
    const t0 = performance.now();
    const from = logs.length;
    const frames = [];
    let stopped = false;
    let last = '';
    const tick = () => {
      if (stopped) return;
      const b = box().getBoundingClientRect();
      const key = `${term().rows}|${place()}|${Math.round(b.top)}|${Math.round(b.bottom)}`;
      if (key !== last) { last = key; frames.push(`${Math.round(performance.now() - t0)} ms: rows ${term().rows}, ${place()}, box ${r1(b.top)}..${r1(b.bottom)}`); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return {
      stop() {
        stopped = true;
        const events = logs.slice(from).filter((l) => String(l.tag).startsWith('[COMPOSE]'))
          .map((l) => `${Math.round(l.at - t0)} ms: ${l.tag} ${JSON.stringify(l.data)}`);
        return [...frames, ...events];
      },
    };
  }

  /** S61: the box is its contents' height: nothing between the textarea's bottom and the box's own padding. */
  function noBlankBelowText(label) {
    const b = box().getBoundingClientRect();
    const t = textarea().getBoundingClientRect();
    const cs = getComputedStyle(box());
    const chrome = parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
    const d = { boxBottom: r1(b.bottom), textareaBottom: r1(t.bottom), boxPaddingBottom: r1(chrome), blank: r1(b.bottom - t.bottom - chrome), boxH: r1(b.height), textareaH: r1(t.height) };
    check(`${label}: no blank space below the textarea inside the box (within 1 px of the box's padding)`, d.blank <= 1 && d.blank >= -1, d);
  }

  /** The one-line box is three rows with its line and Send centred in it (the look the tall box keeps, S61). */
  function sendCentredInOneLineBox(label) {
    const b = box().getBoundingClientRect();
    const sb = q('.editor-send').getBoundingClientRect();
    const d = { sendCentreInBox: r1((sb.top + sb.bottom) / 2 - b.top), boxHalf: r1(b.height / 2) };
    check(`${label}: Send centred in the three-row box (within 1.5 px)`, Math.abs(d.sendCentreInBox - d.boxHalf) <= 1.5, d);
  }

  /** S61: Send sits on the box's first line: centred on the textarea's first line (within 1.5 px), inside the box. */
  function sendOnFirstLine(label) {
    const b = box().getBoundingClientRect();
    const ta = textarea();
    const t = ta.getBoundingClientRect();
    const tcs = getComputedStyle(ta);
    const firstLineH = parseFloat(tcs.lineHeight) + parseFloat(tcs.paddingTop) + parseFloat(tcs.paddingBottom) + 2 * parseFloat(tcs.borderTopWidth);
    const sb = q('.editor-send').getBoundingClientRect();
    const d = { sendTop: r1(sb.top - b.top), sendBottom: r1(sb.bottom - b.top), sendCentre: r1((sb.top + sb.bottom) / 2 - t.top), firstLineCentre: r1(firstLineH / 2), boxH: r1(b.height) };
    // At a UI scale where Send is taller than the textarea's line (1.5), it can't centre on the line without leaving
    // the box: it sits at the box's top padding instead.
    const taller = sb.height > firstLineH + 0.5;
    check(`${label}: Send centred on the box's first line (within 1.5 px; at the box's top padding when taller than the line), not at the middle of the box`,
      taller ? sb.top - b.top <= 3 && sb.top <= t.top + 0.5 : Math.abs(d.sendCentre - d.firstLineCentre) <= 1.5, { ...d, sendH: r1(sb.height), firstLineH: r1(firstLineH) });
    check(`${label}: Send inside the box's rectangle`, sb.top >= b.top - 0.5 && sb.bottom <= b.bottom + 0.5 && sb.right <= b.right + 0.5, d);
  }

  /** S61 review: the box's first line. A one-line box and the `under` box are not taller than their contents (the
   *  textarea or Send, whichever is taller), the one-line text is centred in the box, a resize leaves a draft he scrolled
   *  up in alone, a caret in view stays in view, and a composition (IME) keeps its text and caret. */
  async function firstLineChecks(at) {
    const D = `${at} first line`;
    await newPane();
    const f = feeder('steps');
    await f.to('idle');
    await engage();
    const bar = findBar();
    if (!bar || !bar.empty) { check(`${D}: Claude's bar found`, false, bar); return; }
    const ta = textarea();
    const taCs = getComputedStyle(ta);
    const lineCentre = (rect) => rect.top + parseFloat(taCs.borderTopWidth) + parseFloat(taCs.paddingTop) + parseFloat(taCs.lineHeight) / 2;
    const fieldNotTaller = (label) => {
      const fr = q('.editor-field').getBoundingClientRect();
      const tr = ta.getBoundingClientRect();
      const sr = q('.editor-send').getBoundingClientRect();
      const d = { field: r1(fr.height), textarea: r1(tr.height), send: r1(sr.height), box: r1(box().getBoundingClientRect().height), place: place() };
      check(`${label}: the row is no taller than the textarea or Send, whichever is taller (the first line's height counts no border)`, fr.height <= Math.max(tr.height, sr.height) + 0.5, d);
      return d;
    };
    await typeDraft('hi');
    fieldNotTaller(`${D} one-line draft, over`);
    {
      const b = box().getBoundingClientRect();
      const t = ta.getBoundingClientRect();
      const d = { textLineCentre: r1(lineCentre(t)), boxCentre: r1((b.top + b.bottom) / 2), boxH: r1(b.height) };
      check(`${D} one-line draft, over: the text's line is centred in the three-row box (within 1.5 px)`, Math.abs(d.textLineCentre - d.boxCentre) <= 1.5, d);
      const sb = q('.editor-send').getBoundingClientRect();
      check(`${D} one-line draft, over: the text's line and Send are centred on each other (within 1.5 px)`, Math.abs(lineCentre(t) - (sb.top + sb.bottom) / 2) <= 1.5, { ...d, sendCentre: r1((sb.top + sb.bottom) / 2) });
    }
    pane.setComposeOverBar(false);
    await settle(500);
    {
      const d = fieldNotTaller(`${D} one-line draft, under`);
      const cs = getComputedStyle(box());
      const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const bh = box().getBoundingClientRect().height;
      check(`${D} one-line draft, under: the box is its row's height plus its own padding and rule, no more (within 0.5 px)`, Math.abs(bh - (d.field + chrome)) <= 0.5, { ...d, chrome: r1(chrome), boxH: r1(bh) });
    }
    pane.setComposeOverBar(true);
    await settle(500);

    // a long draft: his scroll through a resize, a caret in view through one
    await typeDraft(room(40));
    await settle(1800);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.scrollTop = 0; // scrolled up to reread, the caret still at the end
    const h0 = host.getBoundingClientRect().height;
    host.style.height = `${h0 + 40}px`;
    await settle(1500);
    check(`${D} scrolled up in a long draft, focused: a resize leaves his scroll alone`, ta.scrollTop <= 2, { scrollTop: r1(ta.scrollTop), max: ta.scrollHeight - ta.clientHeight });
    pane.editorInput.setValue(room(40)); // an edit: follows the caret to the end
    await settle(400);
    const atEnd = ta.scrollTop;
    host.style.height = `${h0}px`;
    await settle(1500);
    check(`${D} caret at the end in view: a resize that shrinks the cap keeps it in view`, ta.scrollTop >= ta.scrollHeight - ta.clientHeight - 2, { before: r1(atEnd), scrollTop: r1(ta.scrollTop), max: ta.scrollHeight - ta.clientHeight });

    // a composition (IME): synthetic events, the text and the caret are as typed, the caret's line in view
    await typeDraft('');
    await settle(600);
    ta.focus();
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    for (let i = 0; i < 30; i++) {
      const next = ta.value + (i % 3 === 2 ? '\n' : '') + 'あ';
      ta.value = next;
      ta.setSelectionRange(next.length, next.length);
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'あ', isComposing: true }));
    }
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'あ' }));
    await settle(500);
    check(`${D} composing: the text and the caret are as typed and the caret's line is in view`,
      ta.value.length === 40 && ta.selectionStart === 40 && ta.selectionEnd === 40
      && (ta.scrollHeight <= ta.clientHeight || ta.scrollTop >= ta.scrollHeight - ta.clientHeight - 2),
      { len: ta.value.length, sel: [ta.selectionStart, ta.selectionEnd], scrollTop: r1(ta.scrollTop), max: ta.scrollHeight - ta.clientHeight });
    await typeDraft('');
    await settle(400);
  }

  async function draftRoomChecks(at) {
    const D = `${at} D15`;
    // -------- over
    await newPane();
    const baseRows = term().rows;
    // The steps recording's idle screen has the bar at row ~11 with 17 blank rows under it, so a draft (capped at
    // a third of the pane) can never need more than they give: k stays 0 there, which tests nothing. Use the
    // screen a real session lives on: the end of the `turn` recording, the bar low on the screen with the footer
    // under it. If that still leaves more rows under the bar than a capped draft can use, fall back to a stand-in
    // layout (the bar and a footer line bottom-aligned, see redrawFor).
    const f = feeder('turn');
    await f.untilEmptyBar();
    await engage();
    await report('working');
    while (await f.next()) { /* every chunk of the recorded turn */ }
    await report('idle');
    await settle(450);
    let bar = findBar();
    let source = 'turn recording, end';
    if (!bar || !bar.empty || lastRow() - (bar.R + 1) > 4) {
      const was = bar ? `R=${bar.R}` : 'no bar';
      await redrawFor(['─'.repeat(term().cols), '❯ ', '─'.repeat(term().cols), '  ? for shortcuts', '  Opus']);
      await settle(450);
      bar = findBar();
      source = `stand-in layout (the turn recording's end had ${was})`;
    }
    if (!bar || !bar.empty) { check(`${D} start: Claude's bar found on screen`, false, bar); return; }
    const R0 = bar.R;
    const barLines = snapshotLines(R0 - 1, lastRow()); // rule, bar, rule, footer rows, as recorded
    const rowsBelow = lastRow() - (R0 + 1);
    const stopStandIn = startStandIn(barLines); // Claude's redraw, the frame after any resize (see redrawFor) // terminal rows under the bar's bottom rule
    const cellH = grid().cellH;
    const paneH = pane.element.getBoundingClientRect().height;
    const third = Math.floor(paneH / 3);
    measures.push(`${D} screen: ${source}; bar at viewport row ${R0 - (term().buffer.active.baseY)} of ${baseRows}; ${rowsBelow} rows below the bar's rule; cell ${r1(cellH)} px; pane ${r1(paneH)} px, a third ${third} px`);

    // 1. a one-line draft: box over R-1..R+1, the terminal keeps the pane's rows (a regression guard: true on main too)
    await typeDraft('one line');
    overGeometry(`${D} one-line draft`, R0);
    sendCentredInOneLineBox(`${D} one-line draft`);
    check(`${D} one-line draft: the terminal's rows equal the pane's full rows`, term().rows === baseRows, { rows: term().rows, baseRows });

    // 2a. a draft that fits in room the cap allows: the pin to the pane's bottom is exact. (The box ends on
    //     the pane's bottom unless the cap of a third of the pane stops it first: from row R-1's top to the pane's
    //     bottom is whole rows of the draft's need plus the pane's own 20 px, which can pass the cap; then 2b.)
    {
      await typeDraft(room(6));
      await settle(1800);
      const bar6 = findBar();
      if (!bar6 || !bar6.empty) check(`${D} 6-line draft: Claude's bar found after the stand-in redraw`, false, { bar: bar6, rows: term().rows });
      else {
        const g6 = grid();
        const b6 = box().getBoundingClientRect();
        const k6 = baseRows - term().rows;
        const d6 = { placement: place(), R: bar6.R, rows: term().rows, baseRows, k: k6, box: { top: r1(b6.top), bottom: r1(b6.bottom), h: r1(b6.height) }, rowTop: r1(g6.top(bar6.R - 1)), paneContentBottom: r1(paneContentBottom()), rowsBelow, third };
        check(`${D} precondition: the 6-line draft is taller than the three bar rows plus the ${rowsBelow} rows below the bar, and under the cap`,
          b6.height > (3 + rowsBelow) * g6.cellH + 0.5 && b6.height < third - 0.5, d6);
        check(`${D} 6-line draft: top within 1 px of row R-1's top, the terminal k >= 1 rows shorter, the box's bottom at or below the terminal's last row (Claude's footer covered, S61)`,
          place() === 'over' && Math.abs(b6.top - g6.top(bar6.R - 1)) <= 1 && k6 >= 1 && b6.bottom >= g6.screen.bottom - 1, d6);
        noBlankBelowText(`${D} 6-line draft`);
        sendOnFirstLine(`${D} 6-line draft`);
        measures.push(`${D} 6-line draft: terminal ${term().cols}x${term().rows} (k=${k6}), box ${r1(b6.height)} px from ${r1(b6.top)} to ${r1(b6.bottom)}, pane content bottom ${r1(paneContentBottom())}`);
      }
    }

    // 2b. a draft taller than the rows below the bar
    const logsBefore = logs.length;
    const tl = startTimeline();
    await typeDraft(room(8));
    await settle(1100); // past D9's once-a-second limit and the 500 ms refit window
    for (const l of tl.stop()) measures.push(`${D} timeline, 8-line draft: ${l}`);
    const rowsAfterType = term().rows;
    await settle(700);
    bar = findBar();
    if (!bar || !bar.empty) { check(`${D} tall draft: Claude's bar found after the stand-in redraw`, false, { bar, rows: term().rows }); return; }
    const R1 = bar.R;
    let g = grid();
    let b = box().getBoundingClientRect();
    const k = baseRows - term().rows;
    const dTall = { placement: place(), R: R1, rows: term().rows, baseRows, k, rowsAfterType, box: { top: r1(b.top), bottom: r1(b.bottom), h: r1(b.height) }, row_R1m1_top: r1(g.top(R1 - 1)), paneContentBottom: r1(paneContentBottom()), rowsBelow,
      grid: { top: r1(g.screen.top), bottom: r1(g.screen.bottom), cellH: r1(g.cellH) }, container: (({ top, bottom }) => ({ top: r1(top), bottom: r1(bottom) }))(q('.terminal-container').getBoundingClientRect()), pane: (({ top, bottom }) => ({ top: r1(top), bottom: r1(bottom) }))(pane.element.getBoundingClientRect()) };
    check(`${D} precondition: the 8-line draft is taller than the three bar rows plus the ${rowsBelow} rows below the bar`, b.height > (3 + rowsBelow) * g.cellH + 0.5, dTall);
    check(`${D} tall draft: placement over`, place() === 'over', dTall);
    check(`${D} tall draft: the box's top within 1 px of row R-1's top (R from the bar after Claude's redraw)`, Math.abs(b.top - g.top(R1 - 1)) <= 1, dTall);
    let worst = -Infinity;
    for (let r = g.vy; r <= R1 - 2; r++) worst = Math.max(worst, g.top(r) + g.cellH);
    check(`${D} tall draft: no terminal row above R-1 intersects the box`, b.top >= worst - 1, { ...dTall, lowestRowAboveBottom: r1(worst) });
    check(`${D} tall draft: the terminal gives up k >= 1 whole rows at its bottom (fewer rows than the pane's ${baseRows})`, k >= 1, dTall);
    check(`${D} tall draft: the box's bottom at or below the terminal's last row, so Claude's footer is under it, and never past a third of the pane (S61)`,
      b.bottom >= g.screen.bottom - 1 && b.height <= third + 1, dTall);
    noBlankBelowText(`${D} tall draft`);
    sendOnFirstLine(`${D} tall draft`);
    measures.push(`${D} 8-line draft: terminal ${term().cols}x${term().rows} (k=${k}), box ${r1(b.height)} px from ${r1(b.top)} to ${r1(b.bottom)}, pane content bottom ${r1(paneContentBottom())}, row R-1 top ${r1(g.top(R1 - 1))}`);
    // the room line (only if the stub captures renderer logs)
    if (logs.some((l) => l.tag === '[COMPOSE] place')) {
      const got = lastRoomRows(logsBefore);
      check(`${D} tall draft: a \`[COMPOSE] room\` line with rows equal to k (${k})`, got === k, { got, k, lines: logs.slice(logsBefore).map((l) => l.tag) });
    } else measures.push(`NOTE ${D}: the stub captured no renderer logs, the [COMPOSE] room assertion is skipped`);
    const tallRows = term().rows;

    // 3. a draft longer than a third of the pane: the box stops growing and the text scrolls inside
    await typeDraft(room(40));
    await settle(1800);
    bar = findBar();
    b = box().getBoundingClientRect();
    g = grid();
    const ta = textarea();
    const dCap = { placement: place(), rows: term().rows, h: r1(b.height), third, scrollH: ta.scrollHeight, clientH: ta.clientHeight, top: r1(b.top), bottom: r1(b.bottom), paneContentBottom: r1(paneContentBottom()) };
    check(`${D} 40-line draft: the box stops growing at a third of the pane (S61: no fill to the pane's bottom, so no rounding allowance)`, b.height <= third + 1, dCap);
    noBlankBelowText(`${D} 40-line draft`);
    sendOnFirstLine(`${D} 40-line draft`);
    {
      // S61 review: k is worked out from a box of the cap's height (a third of the pane, or less to the pane's bottom),
      // so the capped box must be that tall, not the textarea's cap less the box's own padding.
      const wantCap = Math.min(third, Math.floor(pane.element.getBoundingClientRect().bottom - b.top));
      check(`${D} 40-line draft: the capped box is exactly the cap tall (a third of the pane, or to the pane's bottom), within 1 px`,
        Math.abs(b.height - wantCap) <= 1, { ...dCap, wantCap });
    }
    check(`${D} 40-line draft: the textarea scrolls (scrollHeight > clientHeight)`, ta.scrollHeight > ta.clientHeight, dCap);
    check(`${D} 40-line draft: the box's bottom at or below the terminal's last row, its top on row R-1's top`,
      Boolean(bar && bar.empty) && b.bottom >= g.screen.bottom - 1 && Math.abs(b.top - g.top(bar.R - 1)) <= 1, dCap);
    // S61: the caret stays in view after any change of the text. typeDraft sets the value and fires `input`
    // (a restored or typed draft: the caret at the end); a real paste event, at the end and at the start.
    check(`${D} 40-line draft typed: the textarea is scrolled to the caret at its end (scrollTop ${r1(ta.scrollTop)} of ${ta.scrollHeight - ta.clientHeight})`,
      ta.scrollTop >= ta.scrollHeight - ta.clientHeight - 2, dCap);
    {
      const realPaste = (text) => {
        const dt = new DataTransfer();
        dt.setData('text', text);
        ta.focus();
        ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      };
      await typeDraft('');
      await settle(900);
      realPaste(room(40));
      await settle(900);
      const dEnd = { scrollTop: r1(ta.scrollTop), max: ta.scrollHeight - ta.clientHeight, sel: ta.selectionEnd, len: ta.value.length };
      check(`${D} real paste of 40 lines into an empty box: the textarea is scrolled to the caret at the end`, dEnd.max > 50 && ta.scrollTop >= dEnd.max - 2, dEnd);
      ta.setSelectionRange(0, 0);
      ta.scrollTop = 0;
      realPaste('ZZ');
      await settle(300);
      const dStart = { scrollTop: r1(ta.scrollTop), max: ta.scrollHeight - ta.clientHeight, sel: ta.selectionEnd };
      check(`${D} real paste at the start of a long draft scrolled to its end: the textarea scrolls back to the caret`, ta.scrollTop <= 2 && dStart.sel === 2, dStart);
      ta.scrollTop = 100;
      ta.setSelectionRange(ta.value.length, ta.value.length);
      realPaste('tail');
      await settle(300);
      const dMid = { scrollTop: r1(ta.scrollTop), max: ta.scrollHeight - ta.clientHeight };
      check(`${D} real paste at the end after scrolling up: the textarea scrolls down to the caret`, ta.scrollTop >= dMid.max - 2, dMid);
      pane.editorInput.setValue(room(40));
      await settle(300);
      check(`${D} a draft restored with setValue: scrolled to the caret at its end`, ta.scrollTop >= ta.scrollHeight - ta.clientHeight - 2, { scrollTop: r1(ta.scrollTop), max: ta.scrollHeight - ta.clientHeight });
      ta.scrollTop = 0;
      pane.editorInput.insertText('\n/path/to/dropped/file.png', { focus: false });
      await settle(300);
      check(`${D} a dropped file's path inserted with insertText: scrolled to the caret`, ta.scrollTop >= ta.scrollHeight - ta.clientHeight - 2, { scrollTop: r1(ta.scrollTop), max: ta.scrollHeight - ta.clientHeight });
      await typeDraft(room(40));
      await settle(900);
    }
    measures.push(`${D} 40-line draft: terminal ${term().rows} rows, box ${r1(b.height)} px, a third ${third} px`);

    // 6. stability (D15: "Claude's redraw after the resize can't feed back"): back to the 8-line draft, let it settle,
    //    then feed the same screen three more times, 600 ms apart; the row count must not change.
    await typeDraft(room(8));
    await settle(1800);
    const stableRows = term().rows;
    const seen = [stableRows];
    for (let i = 0; i < 3; i++) {
      await sleep(600);
      await redrawFor(barLines);
      seen.push(term().rows);
    }
    await settle(700);
    seen.push(term().rows);
    check(`${D} stability: three more redraws of the same screen, 600 ms apart, leave the terminal's rows alone (${stableRows} rows)`,
      seen.every((n) => n === stableRows) && stableRows < baseRows, { seen, baseRows });

    // 4. cleared: the terminal back to the pane's rows (after it had given some up), the box over R-1..R+1 again
    await typeDraft('');
    await settle(1100);
    await settle(700);
    const rowsAfterClear = term().rows;
    bar = findBar();
    check(`${D} cleared: the terminal back to the pane's full rows after having given rows up (${tallRows} -> ${rowsAfterClear} of ${baseRows})`,
      tallRows < baseRows && rowsAfterClear === baseRows && term().rows === baseRows, { tallRows, rowsAfterClear, baseRows });
    if (bar && bar.empty) overGeometry(`${D} cleared`, bar.R);
    else check(`${D} cleared: Claude's bar found on screen`, false, bar);

    stopStandIn();

    // -------- dock: scrolled up with a tall draft
    await newPane();
    const f2 = feeder('queue');
    await f2.to('idle');
    await engage();
    for (const mark of ['working', 'queued', 'queued+1s', 'after']) {
      if (mark === 'working') await report('working');
      if (mark === 'after') await report('idle');
      await f2.to(mark);
      await settle(250);
    }
    const baseRows2 = term().rows;
    const bar2 = findBar();
    if (!bar2 || !bar2.empty) { check(`${D} dock: Claude's bar found before scrolling up`, false, bar2); return; }
    // Claude redraws on a resize whether or not he is scrolled up: the stand-in runs here too.
    const stopStandIn2 = startStandIn(snapshotLines(bar2.R - 1, lastRow()));
    term().scrollToTop();
    await settle(500);
    if (place() !== 'dock') { check(`${D} dock: scrolled up, placement dock`, false, { placement: place() }); stopStandIn2(); return; }
    const tl2 = startTimeline();
    await typeDraft(room(8));
    await settle(1200);
    for (const l of tl2.stop()) measures.push(`${D} timeline, dock 8-line draft: ${l}`);
    g = grid();
    b = box().getBoundingClientRect();
    const n = term().rows;
    let lowest = -Infinity;
    for (let i = 0; i < n - 3; i++) lowest = Math.max(lowest, g.screen.top + (i + 1) * g.cellH);
    const dDock = { placement: place(), rows: n, baseRows2, box: { top: r1(b.top), bottom: r1(b.bottom), h: r1(b.height) }, lowestRowAboveLastThreeBottom: r1(lowest), vy: g.vy };
    check(`${D} dock tall draft: placement dock`, place() === 'dock', dDock);
    check(`${D} dock tall draft: no terminal row above the last three intersects the box (1 px)`, b.top >= lowest - 1, dDock);
    check(`${D} dock tall draft: the terminal gave up rows at its bottom (fewer than the pane's ${baseRows2})`, n < baseRows2, dDock);
    measures.push(`${D} dock 8-line draft: terminal ${term().cols}x${n} of ${baseRows2}, box ${r1(b.height)} px from ${r1(b.top)}, row ${n - 3} top ${r1(g.screen.top + (n - 3) * g.cellH)}`);
    // S61 review: a draft past the cap in dock: the box is exactly the cap tall and reaches the terminal's last row.
    await typeDraft(room(40));
    await settle(1800);
    stopStandIn2();
    g = grid();
    b = box().getBoundingClientRect();
    const paneH2 = pane.element.getBoundingClientRect().height;
    const wantCap2 = Math.min(Math.floor(paneH2 / 3), Math.floor(pane.element.getBoundingClientRect().bottom - b.top));
    const dDock40 = { placement: place(), rows: term().rows, box: { top: r1(b.top), bottom: r1(b.bottom), h: r1(b.height) }, wantCap: wantCap2, screenBottom: r1(g.screen.bottom) };
    check(`${D} dock 40-line draft: the capped box is exactly the cap tall (the dock's rule counted), within 1 px, and reaches the terminal's last row`,
      place() === 'dock' && Math.abs(b.height - wantCap2) <= 1 && b.bottom >= g.screen.bottom - 1, dDock40);
    noBlankBelowText(`${D} dock 40-line draft`);
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
    boxFirstItem(`${at} steps/idle`, true);
    measures.push(`${at} idle: cell ${r1(idle.g.cellH)} px; box ${r1(idle.b.height)} px = ${r1(idle.b.height / idle.g.cellH)} rows (contents need ${r1(idle.need)} px, ${idle.fits ? 'fit' : 'do not fit'} in 3 rows); box top ${r1(idle.b.top)} vs row R-1 ${r1(idle.g.top(bar.R - 1))}, bottom ${r1(idle.b.bottom)} vs ${r1(idle.g.top(bar.R + 2))}; pane ${r1(pane.element.getBoundingClientRect().height)} px, terminal ${term().cols}x${term().rows}`);

    // Review fixes. (a) The overlay's colour follows a theme change at once.
    const frameBg = () => {
      const probe = document.createElement('div');
      probe.style.background = 'var(--term-bg)';
      q('.terminal-container').appendChild(probe);
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return c;
    };
    pane.setTerminalTheme({ background: '#123456', foreground: '#ffffff' });
    check(`${at} theme changed while over: the box's background is the new one at once`,
      getComputedStyle(box()).backgroundColor === 'rgb(18, 52, 86)', { box: getComputedStyle(box()).backgroundColor });
    pane.setTerminalTheme(null);
    check(`${at} theme reset: the box follows the terminal's frame colour again`,
      getComputedStyle(box()).backgroundColor === frameBg(), { box: getComputedStyle(box()).backgroundColor, frame: frameBg() });
    // The typing box itself wears --compose-fill, a very faint yellow (Michael,
    // 22 Nov 2026), so it stands out from the terminal's ground around it.
    {
      const fillProbe = document.createElement('div');
      fillProbe.style.background = 'var(--compose-fill)';
      document.body.appendChild(fillProbe);
      const fill = getComputedStyle(fillProbe).backgroundColor;
      fillProbe.remove();
      const ta = getComputedStyle(textarea()).backgroundColor;
      const [fr, fg, fb] = (ta.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      check(`${at} the typing box is filled with --compose-fill (a faint yellow), not the terminal's ground`,
        ta === fill && ta !== frameBg() && fr > fb + 8 && fg > fb + 8, { textarea: ta, fill, frame: frameBg() });
    }
    // (b) A reading that finds the bar where it was measures nothing.
    {
      const screen = q('.xterm-screen');
      const orig = screen.getBoundingClientRect.bind(screen);
      let measured = 0;
      screen.getBoundingClientRect = () => { measured++; return orig(); };
      for (let i = 0; i < 5; i++) { await write('\x1b[0m'); await frame(); }
      delete screen.getBoundingClientRect;
      check(`${at} five readings of the unchanged empty bar lay the overlay out no more`, measured === 0, { measured });
    }
    // (c) Switching the renderer lays the overlay out again.
    {
      // D15: the overlay is laid out by its top edge (it grows down).
      const want = parseFloat(box().style.top);
      box().style.top = `${want + 37}px`;
      pane.setRenderer('dom');
      await settle(120);
      check(`${at} renderer switched: the overlay laid out again`, Math.abs(parseFloat(box().style.top) - want) <= 0.5,
        { top: box().style.top, want });
    }

    // 2. A long draft grows the box down from the same top edge (D15; until
    //    S60 upward from the bottom edge, D9), capped at a third of the pane. On
    //    these screens Claude's bar has many blank rows below it, so the box
    //    grows over them and the terminal keeps its rows.
    const paneH = pane.element.getBoundingClientRect().height;
    await typeDraft(Array.from({ length: 7 }, (_, i) => `draft line ${i + 1}`).join('\n'));
    let b7 = box().getBoundingClientRect();
    let g7 = grid();
    check(`${at} long draft (7 lines): grows down from the same top edge (row R-1), terminal rows unchanged`,
      place() === 'over' && Math.abs(b7.top - idle.b.top) <= 1 && b7.height > idle.b.height + 1 && b7.height <= Math.floor(paneH / 3) + 1 && term().rows === baseRows,
      { placement: place(), top: r1(b7.top), wasTop: r1(idle.b.top), h: r1(b7.height), wasH: r1(idle.b.height), third: Math.floor(paneH / 3), rows: term().rows });
    measures.push(`${at} 7-line draft: box ${r1(b7.height)} px (${r1(b7.height / g7.cellH)} rows), a third of the pane ${Math.floor(paneH / 3)} px`);
    await typeDraft(Array.from({ length: 30 }, (_, i) => `draft line ${i + 1}`).join('\n'));
    b7 = box().getBoundingClientRect();
    const ta = textarea();
    check(`${at} long draft (30 lines): never past a third of the pane, the text scrolls inside, terminal rows unchanged`,
      place() === 'over' && Math.abs(b7.top - idle.b.top) <= 1 && b7.height <= Math.floor(paneH / 3) + 1 && ta.scrollHeight > ta.clientHeight && term().rows === baseRows,
      { placement: place(), top: r1(b7.top), h: r1(b7.height), third: Math.floor(paneH / 3), scrollH: ta.scrollHeight, clientH: ta.clientHeight, rows: term().rows });
    measures.push(`${at} 30-line draft: box ${r1(b7.height)} px, cap ${Math.floor(paneH / 3)} px`);
    await typeDraft('');
    overGeometry(`${at} draft cleared`, bar.R);

    // 3. D14: two pasted images sit inside the box, left of the text; it keeps its three rows.
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    pane.addPasteChip(PNG, 640, 480);
    pane.addPasteChip(PNG, 320, 200);
    await settle(250);
    imagesInBox(`${at} two pasted images`, 2);
    overGeometry(`${at} two pasted images`, bar.R);
    pane.clearPasteChips();
    await settle(250);

    // 4. under when Claude's bar holds text or isn't found; over again once cleared.
    for (const [mark, clearMark] of [['typed', 'cleared'], ['wrapped', null], ['multiline', 'cleared2']]) {
      await f.to(mark);
      await settle(1150); // the 400 ms wait, then D9's once-a-second rule
      underGeometry(`${at} steps/${mark} (after the 400 ms wait)`);
      if (clearMark) {
        await f.to(clearMark);
        await settle(1150);
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
      const rgb = (css) => (css.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = (c) => { const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const hereBorder = rgb(getComputedStyle(typeHere).borderTopColor);
      const ground = rgb(getComputedStyle(typeHere).backgroundColor);
      const [hi, lo] = [lum(hereBorder), lum(ground)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      check(`${at} "Type here" border has 3:1 against its ground (a control's border, main.css)`, ratio >= 3, { border: hereBorder, ground, ratio: r1(ratio) });
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
    boxFirstItem(`${at} turn/after the turn`, true);

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

    // ---------------- 7. composeOverBar off: under throughout, no Okay? anywhere
    await newPane();
    f = feeder('steps');
    await f.to('idle');
    await engage(false);
    const seen = [];
    let allUnder = true;
    underGeometry(`${at} over-bar off, idle`);
    boxFirstItem(`${at} over-bar off, idle`, false);
    for (const mark of ['typed', 'cleared', 'wrapped', 'cleared2', 'end']) {
      await f.to(mark);
      await settle(200);
      seen.push(`${mark}:${place()}`);
      if (place() !== 'under') allUnder = false;
    }
    check(`${at} over-bar off: under at every screen of the steps recording`, allUnder, seen);

    // ---------------- D15/D17: long drafts make room below
    await draftRoomChecks(at);
    await firstLineChecks(at);
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
