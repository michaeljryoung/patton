// Hidden-Electron check of a long paste into the compose box (docs/compose-box.md D19).
// On 27 Nov 2026 a 413,762-character, 3,397-line paste froze the renderer for 2 min 11 s: Chromium's
// execCommand('insertText') fires one `input` event per line, and each ran a whole-text mirror layout
// (quadratic; 119 s). Now a paste over 200 line breaks or 50,000 characters goes in as one edit
// (setRangeText), the box's input handler skips the events Patton's own insertion raises, and a caret at the
// end of the text is placed without a mirror. This check pastes SYNTHETIC text (words, blank lines, a few
// long lines; the repo is public) into a real Pane in a hidden Electron and asserts the structure and the time.
// The harness (stub bridge, real Pane, recorded screens, Claude's redraw stood in for) is copied from
// check-compose-room-live.cjs.
//
// Run: node scripts/check-compose-long-paste.cjs
//   COMPOSE_SRC_ROOT=<folder holding src/>   bundle another source tree (to prove the check bites)
//   COMPOSE_LONGPASTE_CHECK_DIR=<folder>     where the bundle, userData and result go (default: a temp folder, removed after)
// Prints `ok <what>` or `not ok <what>: <measured>` per assertion; exit 1 on any failure.
// Run it alone: one hidden Electron at a time (`pgrep -f check-` empty first).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HARD_TIMEOUT_MS = 300000;
const REPO = path.resolve(__dirname, '..');

if (process.versions.electron) electronMain();
else nodeRunner().catch((err) => { console.error(err); process.exit(2); });

async function nodeRunner() {
  const { build } = require(path.join(REPO, 'node_modules/esbuild'));
  const { spawn } = require('node:child_process');
  const srcRoot = process.env.COMPOSE_SRC_ROOT ? path.resolve(process.env.COMPOSE_SRC_ROOT) : REPO;
  const ownDir = !process.env.COMPOSE_LONGPASTE_CHECK_DIR;
  const outDir = process.env.COMPOSE_LONGPASTE_CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'patton-check-compose-long-paste-'));
  fs.mkdirSync(outDir, { recursive: true });
  const resultFile = path.join(outDir, 'result.json');
  fs.rmSync(resultFile, { force: true });
  await build({
    stdin: {
      resolveDir: srcRoot, loader: 'ts',
      contents: `
        import { Pane } from './src/renderer/components/pane';
        import { stripPasteControls } from './src/renderer/services/paste-sanitize';
        import { scrollCaretIntoView, caretInView, caretLineTop, scrollForCaret } from './src/renderer/services/textarea-caret';
        (window as any).__co = { Pane, stripPasteControls, scrollCaretIntoView, caretInView, caretLineTop, scrollForCaret };
      `,
    },
    bundle: true, platform: 'browser', format: 'iife', outfile: path.join(outDir, 'page.js'),
    nodePaths: [path.join(REPO, 'node_modules')], loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const styles = ['main', 'tabs', 'terminal', 'editor', 'settings', 'board']
    .map((n) => fs.readFileSync(path.join(srcRoot, 'src/renderer/styles', n + '.css'), 'utf8'));
  fs.writeFileSync(path.join(outDir, 'page.css'),
    fs.readFileSync(path.join(REPO, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8') + '\n' + styles.join('\n'));
  const fixture = fs.readFileSync(path.join(REPO, 'scripts/fixtures/claude-bar-screens.json'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'fixture.js'), `window.__fixture = ${fixture};`);
  // Real Chromium editing commands (the Edit menu's Undo, typed text) come from the main process, not execCommand in the page.
  fs.writeFileSync(path.join(outDir, 'preload.cjs'),
    "const { ipcRenderer } = require('electron'); window.__op = (n, a) => ipcRenderer.invoke('op', n, a);");
  fs.writeFileSync(path.join(outDir, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head><body>' +
    '<div id="app"><div id="main"><div id="content"></div></div></div>' +
    '<script src="fixture.js"></script><script src="page.js"></script></body></html>');
  const electronBin = path.join(REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if (!fs.existsSync(electronBin)) { console.error('no electron binary'); process.exit(2); }
  const log = fs.openSync(path.join(outDir, 'electron.log'), 'w');
  const env = { ...process.env, COMPOSE_LONGPASTE_CHECK_DIR: outDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [__filename], { env, stdio: ['ignore', log, log] });
  const killer = setTimeout(() => child.kill('SIGKILL'), HARD_TIMEOUT_MS + 5000);
  await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(killer);
  fs.closeSync(log);
  if (!fs.existsSync(resultFile)) { console.error('no result; see', path.join(outDir, 'electron.log')); process.exit(2); }
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (ownDir) fs.rmSync(outDir, { recursive: true, force: true });
  if (result.error) { console.error('electron error:', result.error); process.exit(2); }
  let failed = 0;
  for (const c of result.checks) {
    if (c.ok) console.log(`ok ${c.name}`);
    else { failed++; console.log(`not ok ${c.name}: ${JSON.stringify(c.detail)}`); }
  }
  for (const m of result.measured) console.log(`Measured: ${m}`);
  console.log(`\n${result.checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function electronMain() {
  const { app, BrowserWindow, nativeTheme, ipcMain } = require('electron');
  const outDir = process.env.COMPOSE_LONGPASTE_CHECK_DIR;
  const resultFile = path.join(outDir, 'result.json');
  const write = (obj) => fs.writeFileSync(resultFile, JSON.stringify(obj, null, 1));
  app.setPath('userData', path.join(outDir, 'ud'));
  if (app.dock) app.dock.hide();
  setTimeout(() => { try { write({ error: 'timeout' }); } catch { /* */ } app.exit(1); }, HARD_TIMEOUT_MS);
  app.whenReady().then(async () => {
    try {
      nativeTheme.themeSource = 'light';
      const win = new BrowserWindow({
        show: false, width: 1400, height: 1000,
        webPreferences: { backgroundThrottling: false, contextIsolation: false, nodeIntegration: false, preload: path.join(outDir, 'preload.cjs') },
      });
      ipcMain.handle('op', async (_e, name, arg) => {
        const wc = win.webContents;
        if (name === 'undo') { wc.undo(); return true; }
        if (name === 'insertText') { wc.insertText(arg); return true; }
        throw new Error('unknown op ' + name);
      });
      await win.loadFile(path.join(outDir, 'page.html'));
      win.webContents.focus();
      await win.webContents.executeJavaScript(`(${pageSetup.toString()})()`);
      const out = await win.webContents.executeJavaScript('window.__run()');
      write(out);
      app.exit(0);
    } catch (err) {
      write({ error: String((err && err.stack) || err) });
      app.exit(1);
    }
  });
}

// Runs in the page.
async function pageSetup() {
  const U = window.__co;
  const FX = window.__fixture;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const settle = async (ms = 350) => { await sleep(ms); await frame(); };
  const logs = []; // { tag, data }
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
      if (name === 'pty.resize' || name === 'pty.write') return undefined;
      return Promise.resolve(answers[name] ? answers[name]() : undefined);
    },
  });
  window.patton = stub('');
  const content = document.getElementById('content');
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:900px;height:600px;display:flex;flex-direction:column';
  content.appendChild(host);
  let pane = null;
  const term = () => pane.terminalView.terminal;
  const q = (sel) => pane.element.querySelector(sel);
  const textarea = () => q('.editor-container textarea');
  const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const write = (data) => new Promise((r) => term().write(data, r));
  const report = (state) => write(`\x1b]7501;state=${state}:app=claude-code\x07`);
  function grid() {
    const screen = q('.terminal-container .xterm-screen').getBoundingClientRect();
    return { cellH: screen.height / term().rows, cellW: screen.width / term().cols };
  }
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
  }
  function findBar() {
    const b = term().buffer.active;
    const R = b.baseY + b.cursorY;
    const l = b.getLine(R);
    return l && l.translateToString(true).startsWith('❯') ? { R } : null;
  }
  async function redrawFor(lines) {
    const rows = term().rows; const cols = term().cols;
    const first = rows - lines.length + 1;
    let out = `\x1b[0m\x1b[${first};1H\x1b[J`;
    let cursorRow = first;
    lines.forEach((l, i) => {
      const isBar = l.startsWith('❯');
      if (isBar) cursorRow = first + i;
      const txt = isBar ? '❯ ' : /^─+$/.test(l) ? '─'.repeat(cols) : l;
      out += `\x1b[${first + i};1H\x1b[2K${txt}`;
    });
    out += `\x1b[${cursorRow};3H`;
    await write(out);
  }
  let stopStandIn = () => {};
  function startStandIn(lines) {
    let last = term().rows; let stopped = false; let busy = false;
    const tick = async () => {
      if (stopped) return;
      if (!busy && term().rows !== last) { busy = true; last = term().rows; await redrawFor(lines); busy = false; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { stopped = true; };
  }
  const barLines = () => ['─'.repeat(term().cols), '❯ ', '─'.repeat(term().cols), '  ? for shortcuts', '  Opus'];
  async function fresh() {
    stopStandIn();
    await newPane();
    for (const e of FX.recordings.turn) { if (e.b) await write(toBytes(e.b)); }
    pane.setComposeFirst(true, null);
    await report('idle');
    await settle(450);
    if (!findBar()) { await redrawFor(barLines()); await settle(450); }
    stopStandIn = startStandIn(barLines());
    pane.setFontSize(term().options.fontSize);
    await settle(1200);
    if (!findBar()) throw new Error('no Claude bar on the fixture screen');
  }

  // Synthetic text: words, a blank line every 40 lines, a very long line every 500th.
  const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima',
    'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];
  function synth(lineCount, wordsPerLine) {
    const lines = [];
    let w = 0;
    for (let i = 0; i < lineCount; i++) {
      if (i % 40 === 39) { lines.push(''); continue; }
      const n = i % 500 === 499 ? 330 : wordsPerLine + (i % 5);
      const parts = [];
      for (let j = 0; j < n; j++) parts.push(WORDS[(w++ * 7 + i) % WORDS.length]);
      lines.push(parts.join(' '));
    }
    return lines.join('\n');
  }

  // What a paste does to the box: counted structurally and timed.
  const mirrors = new MutationObserver(() => {});
  mirrors.observe(document.body, { childList: true });
  const mirrorCount = () => mirrors.takeRecords()
    .reduce((n, r) => n + Array.from(r.addedNodes).filter((x) => x.nodeType === 1 && x.style.left === '-99999px').length, 0);
  let resizeCalls = 0; // autoResize starts with getClientRects on the textarea
  let inputs = 0;
  function instrument() {
    const ta = textarea();
    const orig = ta.getClientRects.bind(ta);
    ta.getClientRects = () => { resizeCalls++; return orig(); };
    ta.addEventListener('input', () => { inputs++; }, true);
    return ta;
  }
  const tags = (tag, from = 0) => logs.slice(from).filter((l) => l.tag === tag);
  async function paste(ta, text) {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    mirrorCount(); resizeCalls = 0; inputs = 0;
    const t0 = performance.now();
    ta.dispatchEvent(ev);
    const ms = performance.now() - t0;
    return { ms: Math.round(ms), mirrors: mirrorCount(), resizes: resizeCalls, inputs, prevented: ev.defaultPrevented };
  }
  const atBottom = (ta) => ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 1;

  const checks = [];
  const measured = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail }); };

  window.__run = async () => {
    const long = synth(3400, 18);
    const lines = long.split('\n').length;
    check('(setup) the synthetic text is about 3,400 lines and 414k characters',
      lines === 3400 && long.length > 380000 && long.length < 460000, { lines, chars: long.length });

    // 1. A long paste: one edit, no per-line work.
    await fresh();
    let ta = instrument();
    ta.focus();
    let logFrom = logs.length;
    const p1 = await paste(ta, long);
    check('a long paste is taken (default prevented)', p1.prevented, p1);
    check('...the box holds exactly the pasted text, the caret at its end',
      ta.value === long && ta.selectionStart === long.length && ta.selectionEnd === long.length,
      { len: ta.value.length, start: ta.selectionStart, end: ta.selectionEnd });
    check('...finished in under 1.5 s (119 s before the fix)', p1.ms < 1500, p1.ms);
    check('...exactly one (synthetic) input event for other listeners, at most 2 resize runs: this class\'s own handler skipped it', p1.inputs === 1 && p1.resizes <= 2, p1);
    check('...no mirror layout (the caret is at the end)', p1.mirrors === 0, p1.mirrors);
    await settle(3000);
    check('...the caret\'s line is in view: scrolled to the bottom', atBottom(ta), { top: ta.scrollTop, client: ta.clientHeight, scroll: ta.scrollHeight });
    const room1 = tags('[COMPOSE] room', logFrom);
    // Once for the paste, then once more when Claude's redraw settles after Patton's own resize (the same two
    // lines on main with a 425-line paste, D15): never one per line or per input event.
    check('...the terminal gave up rows once for the paste ([COMPOSE] room: its change, then at most the settling after Claude\'s redraw)',
      room1.length >= 1 && room1.length <= 2 && room1[0].data.reason === 'content' && room1[0].data.rows > 0, room1.map((l) => l.data));
    const ins1 = tags('[COMPOSE] insert', logFrom);
    check('...[COMPOSE] insert {source: paste, route: replace, chars, lines} logged once',
      ins1.length === 1 && ins1[0].data.source === 'paste' && ins1[0].data.route === 'replace'
      && ins1[0].data.chars === long.length && ins1[0].data.lines === lines && typeof ins1[0].data.ms === 'number',
      ins1.map((l) => l.data));
    measured.push(`long paste ${lines} lines, ${long.length} chars: ${p1.ms} ms, ${p1.inputs} inputs, ${p1.resizes} resizes, ${p1.mirrors} mirrors`);

    // 2. A key typed at the end of the long draft: no mirror.
    mirrorCount(); inputs = 0;
    const k0 = performance.now();
    document.execCommand('insertText', false, 'x');
    const keyMs = performance.now() - k0;
    check('a key typed at the end of the long draft builds no mirror', mirrorCount() === 0 && inputs === 1 && ta.value === long + 'x', { inputs, len: ta.value.length });
    check('...and is still scrolled to the bottom', atBottom(ta), { top: ta.scrollTop, scroll: ta.scrollHeight });
    measured.push(`one key at the end of the long draft: ${keyMs.toFixed(1)} ms`);

    // 3. A caret in the middle keeps the mirror, and the scroll follows it.
    ta.setSelectionRange(0, 0);
    ta.scrollTop = ta.scrollHeight;
    mirrorCount();
    document.execCommand('insertText', false, 'y');
    check('a key typed at the start builds the mirror and scrolls to the top', mirrorCount() === 1 && ta.scrollTop <= 12, { top: ta.scrollTop });

    // 4. The fast path agrees with the mirror's answer at the end of the text.
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const max = ta.scrollHeight - ta.clientHeight;
    ta.scrollTop = 0;
    mirrorCount();
    U.scrollCaretIntoView(ta);
    const fromTop = ta.scrollTop;
    check('at the end of the text: from the top it scrolls to the bottom (no mirror)', mirrorCount() === 0 && Math.abs(fromTop - max) <= 1, { fromTop, max });
    ta.scrollTop = max;
    U.scrollCaretIntoView(ta);
    check('...with the last line in view it leaves the scroll alone', ta.scrollTop === max, { top: ta.scrollTop, max });
    check('...caretInView agrees (in view at the bottom, not at the top)', U.caretInView(ta) === true && (ta.scrollTop = 0, U.caretInView(ta) === false), null);
    ta.scrollTop = max - 0.5; // half a pixel short of the bottom (scrollTop is fractional, scrollHeight rounded) is still in view
    const halfPx = U.caretInView(ta);
    check('...half a pixel short of the bottom still counts as in view (the cap-shrink case in check-compose-over)', halfPx === true, { top: ta.scrollTop, max });
    ta.style.lineHeight = 'normal'; // not a number: the mirror decides (the text's height changes with it)
    const maxNormal = ta.scrollHeight - ta.clientHeight;
    ta.scrollTop = 0;
    mirrorCount();
    U.scrollCaretIntoView(ta);
    check('...a line-height of "normal" falls back to the mirror, which also scrolls it into view',
      mirrorCount() === 1 && ta.scrollTop > 0 && ta.scrollTop >= maxNormal - 30, { top: ta.scrollTop, max: maxNormal });
    ta.style.lineHeight = '';

    // 5. Under the limits: the editing command, ⌘Z undoes it, the handler runs once.
    await fresh();
    ta = instrument();
    ta.focus();
    const five = 'one\ntwo\nthree\nfour\nfive';
    logFrom = logs.length;
    const p5 = await paste(ta, five);
    check('a 5-line paste goes in whole, the caret at its end', ta.value === five && ta.selectionStart === five.length, ta.value);
    const ins5 = tags('[COMPOSE] insert', logFrom);
    check('...it takes the edit route', ins5.length === 1 && ins5[0].data.route === 'edit' && ins5[0].data.lines === 5 && ins5[0].data.source === 'paste', ins5.map((l) => l.data));
    check('...the handler ran once for it, whatever input events Chromium raised', p5.resizes <= 2, p5);
    document.execCommand('undo');
    check('...⌘Z removes it', ta.value === '', ta.value);

    // 6. Just under the limit: still the edit route, and the handler runs once, not once per line.
    const edge = synth(195, 6);
    logFrom = logs.length;
    const p195 = await paste(ta, edge);
    const ins195 = tags('[COMPOSE] insert', logFrom);
    check('195 lines (under 200 breaks, under 50,000 characters) takes the edit route',
      ta.value === edge && ins195.length === 1 && ins195[0].data.route === 'edit', { chars: edge.length, logs: ins195.map((l) => l.data) });
    check('...with hundreds of input events from Chromium, the handler still ran once (not per event)',
      p195.inputs > 150 && p195.resizes <= 2, p195);
    ta.value = '';
    // 200 breaks is still the edit route; 201 is the first replace.
    const many = (n) => Array.from({ length: n + 1 }, () => 'x').join('\n');
    logFrom = logs.length;
    await paste(ta, many(200));
    ta.value = '';
    await paste(ta, many(201));
    const ins200 = tags('[COMPOSE] insert', logFrom);
    check('200 line breaks takes the edit route, 201 the one-edit route',
      ins200.length === 2 && ins200[0].data.route === 'edit' && ins200[1].data.route === 'replace', ins200.map((l) => l.data));
    ta.value = '';
    const wide = 'w'.repeat(50001);
    logFrom = logs.length;
    await paste(ta, wide);
    const insWide = tags('[COMPOSE] insert', logFrom);
    check('50,001 characters on one line takes the one-edit route',
      ta.value === wide && insWide.length === 1 && insWide[0].data.route === 'replace', insWide.map((l) => l.data));
    ta.value = '';

    // 7. An ESC[201~ is stripped on both routes.
    const evil = 'before\x1b[201~rm -rf /\nafter';
    const evilExpect = U.stripPasteControls(evil);
    await paste(ta, evil);
    check('a paste carrying ESC[201~ is stripped on the edit route', ta.value === evilExpect && !ta.value.includes('\x1b'), JSON.stringify(ta.value));
    ta.value = '';
    const evilLong = ('line \x1b[201~ text\n').repeat(260);
    const evilLongExpect = U.stripPasteControls(evilLong);
    logFrom = logs.length;
    await paste(ta, evilLong);
    const insEvil = tags('[COMPOSE] insert', logFrom);
    check('...and on the one-edit route', ta.value === evilLongExpect && !ta.value.includes('\x1b') && insEvil[0] && insEvil[0].data.route === 'replace',
      { esc: ta.value.includes('\x1b'), route: insEvil[0] && insEvil[0].data.route });
    ta.value = '';

    // 8. While an IME composition is open a long paste goes through the editing command.
    const mid = synth(260, 6);
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    logFrom = logs.length;
    await paste(ta, mid);
    const insIme = tags('[COMPOSE] insert', logFrom);
    check('during an IME composition a long paste takes the edit route', ta.value === mid && insIme.length === 1 && insIme[0].data.route === 'edit', insIme.map((l) => l.data));
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    ta.value = '';
    logFrom = logs.length;
    await paste(ta, mid);
    const insAfter = tags('[COMPOSE] insert', logFrom);
    check('...after compositionend the same paste takes the one-edit route', ta.value === mid && insAfter.length === 1 && insAfter[0].data.route === 'replace', insAfter.map((l) => l.data));
    ta.value = '';

    // 9. insertText(): the public call, both ways.
    logFrom = logs.length;
    pane.editorInput.insertText(mid);
    const insCall = tags('[COMPOSE] insert', logFrom);
    check('insertText() of a long text takes the one-edit route, logged as source: call',
      ta.value === mid && insCall.length === 1 && insCall[0].data.source === 'call' && insCall[0].data.route === 'replace', insCall.map((l) => l.data));
    ta.value = '';
    ta.blur();
    logFrom = logs.length;
    pane.editorInput.insertText('small text', { focus: false });
    const insKeep = tags('[COMPOSE] insert', logFrom);
    check('insertText(…, {focus: false}) with the box unfocused keeps the keyboard where it was and goes in without the editing command',
      ta.value === 'small text' && document.activeElement !== ta && insKeep.length === 1 && insKeep[0].data.route === 'replace', { value: ta.value, logs: insKeep.map((l) => l.data) });
    ta.value = '';
    pane.editorInput.insertText('typed');
    check('insertText() of a small text takes the editing command and the keyboard', ta.value === 'typed' && document.activeElement === ta && tags('[COMPOSE] insert').pop().data.route === 'edit', ta.value);
    // 10. Undo in real Chromium (the Edit menu's Undo, `webContents.undo()`, typed text by `webContents.insertText`).
    // D19: a one-edit paste clears the box's whole undo history (typed text before it included); the edit route
    // below the limits keeps ⌘Z. Pinned so a Chromium change shows up.
    const op = (n, a) => window.__op(n, a);
    const BIG = Array.from({ length: 250 }, (_, i) => `B${i}`).join('\n');
    const SMALL = 'S0\nS1\nS2\nS3\nS4';
    await fresh();
    ta = textarea();
    ta.focus();
    await sleep(50);
    await op('insertText', 'hello ');
    await op('insertText', 'world');
    await sleep(30);
    const typed = ta.value;
    await paste(ta, BIG);
    const afterBig = ta.value;
    await op('undo'); await sleep(30);
    check('after typed text and a one-edit paste, ⌘Z leaves the value unchanged (the history is gone)',
      typed === 'hello world' && afterBig === typed + BIG && ta.value === afterBig, { typed, afterLen: afterBig.length, nowLen: ta.value.length });
    await op('undo'); await sleep(30);
    check('...and it stays unchanged on the next ⌘Z (the typed text before the paste can not be undone either)', ta.value === afterBig, { len: ta.value.length });
    await op('insertText', 'x'); await sleep(30);
    check('...typing after the paste adds to the box', ta.value === afterBig + 'x', { len: ta.value.length });
    await op('undo'); await sleep(30);
    check('...and ⌘Z undoes that typing, nothing more', ta.value === afterBig, { len: ta.value.length, tail: ta.value.slice(-8) });
    // A big paste over a selection: the selected text is gone for good.
    await fresh();
    ta = textarea();
    ta.focus();
    await sleep(50);
    await op('insertText', 'abc'); await sleep(30);
    ta.setSelectionRange(0, 3);
    await paste(ta, BIG);
    await op('undo'); await sleep(30);
    check('a one-edit paste over a selection: ⌘Z does not bring the selected text back', ta.value === BIG, { len: ta.value.length, head: ta.value.slice(0, 8) });
    // Below the limits the edit route keeps ⌘Z through the real command.
    await fresh();
    ta = textarea();
    ta.focus();
    await sleep(50);
    await op('insertText', 'abc'); await sleep(30);
    await paste(ta, SMALL);
    check('a 5-line paste after typed text goes in', ta.value === 'abc' + SMALL, ta.value);
    await op('undo'); await sleep(30);
    check('...real ⌘Z removes the paste and leaves the typed text', ta.value === 'abc', ta.value);

    // 11. The aside's "Draft kept" note follows the draft typed during an aside's typing grace; other listeners on the
    // box need an `input` event from a one-edit paste (the pane's syncComposeAsideLook listens for it).
    for (const [label, text] of [['a one-edit paste', BIG], ['an edit-route paste', SMALL]]) {
      await fresh();
      ta = textarea();
      ta.focus();
      await sleep(50);
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); // a keydown: the typing grace applies
      await sleep(50);
      await write('\x1b]7501;state=working:app=claude-code\x07');
      await write('\x1b]7501;state=blocked:kind=question:app=claude-code\x07');
      await sleep(330); // past the 250 ms hold, inside the typing grace (1 s from the keydown)
      const inGrace = pane.composeAside === 'blocked' && pane.composeKeyboardTimer !== null && pane.composePlacement !== 'under';
      const noteBefore = pane.draftNote.hidden;
      await paste(ta, text);
      const noteAfter = pane.draftNote.hidden;
      check(`${label} during an aside's typing grace shows "Draft kept" at once (the pane hears an input event)`,
        inGrace && noteBefore === true && noteAfter === false, { inGrace, noteBefore, noteAfter, aside: pane.composeAside, placement: pane.composePlacement });
      await write('\x1b]7501;state=idle:app=claude-code\x07');
      await settle(300);
    }

    // 12. Focus: the one-edit route takes the keyboard when asked, and leaves it where it is with {focus: false}.
    await fresh();
    ta = textarea();
    const bigText = BIG;
    ta.blur();
    await paste(ta, bigText);
    check('a one-edit paste into an unfocused box takes the keyboard (the paste handler asks for focus)', ta.value === bigText && document.activeElement === ta, { active: document.activeElement && document.activeElement.tagName });
    ta.value = '';
    ta.blur();
    pane.editorInput.insertText(bigText);
    check('insertText() of a long text into an unfocused box takes the keyboard', ta.value === bigText && document.activeElement === ta, { active: document.activeElement && document.activeElement.tagName });
    ta.value = '';
    const other = document.createElement('input');
    host.appendChild(other);
    other.focus();
    pane.editorInput.insertText(bigText, { focus: false });
    check('insertText(long, {focus: false}) from a box that is not focused leaves the keyboard where it is, the text in the box',
      ta.value === bigText && document.activeElement === other, { len: ta.value.length, active: document.activeElement && document.activeElement.tagName });
    other.remove();
    ta.value = '';

    // 13. The `inserting` guard resets after a throw inside the insertion.
    ta = instrument();
    ta.focus();
    const origRange = ta.setRangeText;
    ta.setRangeText = () => { throw new Error('boom'); };
    let thrown = null;
    try { pane.editorInput.insertText(bigText); } catch (e) { thrown = String(e && e.message); }
    ta.setRangeText = origRange;
    check('(setup) a throw inside the insertion reaches the caller', thrown === 'boom', thrown);
    resizeCalls = 0;
    ta.value = '';
    document.execCommand('insertText', false, 'k');
    check('...the box\'s input handler works again after it (the guard was reset): the next key resizes', resizeCalls >= 1 && ta.value === 'k', { resizeCalls, value: ta.value });
    ta.value = '';

    // 14. A paste over a selection in the middle of a long draft, on both routes: the right place, the selection replaced,
    // the caret brought into view through the mirror (checked against the mirror itself, not the fast path).
    const mirrorSaysInView = () => {
      const m = U.caretLineTop(ta);
      const cs = getComputedStyle(ta);
      const need = U.scrollForCaret(m.top, m.height, ta.scrollTop, ta.clientHeight, parseFloat(cs.paddingTop) || 0, parseFloat(cs.paddingBottom) || 0);
      return Math.abs(need - ta.scrollTop) <= 1;
    };
    for (const [label, text, route] of [['edit route', SMALL, 'edit'], ['one-edit route', BIG, 'replace']]) {
      await fresh();
      ta = textarea();
      pane.editorInput.setValue(synth(300, 8));
      ta.focus();
      const before = ta.value;
      const s0 = before.indexOf('\n', before.length >> 1) + 1;
      const e0 = s0 + 25;
      ta.setSelectionRange(s0, e0);
      ta.scrollTop = 0; // the caret will be far below the visible part
      logFrom = logs.length;
      mirrorCount();
      await paste(ta, text);
      const expected = before.slice(0, s0) + text + before.slice(e0);
      const ins = tags('[COMPOSE] insert', logFrom);
      check(`mid-text paste over a selection (${label}): replaces the selection, lands at its place, the caret after the pasted text`,
        ta.value === expected && ta.selectionStart === s0 + text.length && ta.selectionEnd === s0 + text.length && ins.length === 1 && ins[0].data.route === route,
        { ok: ta.value === expected, caret: ta.selectionStart, want: s0 + text.length, route: ins[0] && ins[0].data.route });
      check(`...(${label}) the caret's line is scrolled into view, by the mirror's own measure`, ta.scrollTop > 0 && mirrorSaysInView(), { top: ta.scrollTop, scroll: ta.scrollHeight, client: ta.clientHeight });
    }

    // 15. A one-line draft: the box is 2 px short of its content (the textarea's borders); nothing to scroll.
    await fresh();
    ta = textarea();
    pane.editorInput.setValue('one line');
    ta.focus();
    ta.setSelectionRange(8, 8);
    await settle(200);
    ta.scrollTop = ta.scrollHeight; // the true bottom, whatever the browser allows
    check('a one-line draft in a box a few px short of its content: caretInView is true at the true bottom and at the top',
      U.caretInView(ta) === true && (ta.scrollTop = 0, U.caretInView(ta) === true), { sh: ta.scrollHeight, ch: ta.clientHeight, oh: ta.offsetHeight, top: ta.scrollTop });
    ta.scrollTop = 0;
    U.scrollCaretIntoView(ta);
    check('...and scrollCaretIntoView leaves it unscrolled', ta.scrollTop === 0, { top: ta.scrollTop });

    // 16. (measured) the insertion's own cost at the limits, through the real edit route (the `inserting` guard on).
    await fresh();
    ta = textarea();
    ta.focus();
    const limitLines = Array.from({ length: 201 }, () => 'abcdefg '.repeat(40).slice(0, 247)).join('\n'); // 200 breaks, 49,847 chars
    const limitChars = 'w'.repeat(50000);
    for (const [name, text] of [['200 line breaks of ~250 characters', limitLines], ['50,000 characters on one line', limitChars]]) {
      ta.value = '';
      ta.focus();
      const logAt = logs.length;
      const tStart = performance.now();
      await paste(ta, text);
      await frame(); // with the layout and paint that follow
      const toFrame = Math.round(performance.now() - tStart);
      const ins = tags('[COMPOSE] insert', logAt);
      measured.push(`edit route at the limit, ${name}: ${ins[0] && ins[0].data.ms} ms in insertAtCaret, ${toFrame} ms to the next frame (route ${ins[0] && ins[0].data.route}, ${ta.value.length} chars)`);
      check(`${name} through the edit route: under 100 ms in insertAtCaret and 150 ms to the next frame (measured 23-36 and 34-41 on the M-series Mac; D19)`, ins[0] && ins[0].data.ms < 100 && toFrame < 150, { insert: ins[0] && ins[0].data.ms, toFrame });
      check(`(setup) ${name}: still under both limits, so the edit route`, ins.length === 1 && ins[0].data.route === 'edit' && ta.value === text, ins.map((l) => l.data));
    }
    return { checks, measured };
  };
  return true;
}
