// Hidden-Electron check of the bookmarks sidebar's row density: the real BookmarksPanel and the
// real CSS, in a window that is never shown. His words (27 Nov): "starts as today, then becomes A,
// then becomes B, and then, once it hits B, it just becomes scroll". The panel uses the roomiest of
// roomy / tight / compact at which the whole list fits its height ("fits" = Chromium shows no
// scrollbar: the list cannot scroll).
//
// At UI scale 1.1 (the long tour): a tall list is roomy (rows 37.4 px); 460 px is tight (one-line
// rows 30.8 px, rows with a second line about 37 px, group titles 6/4 padding, no overflow); about
// 380 px is compact (24.2 px rows, no overflow); about 300 px is compact and the list scrolls; back
// to tall is roomy; a burst of resizes is debounced to one decision; at a fixed list height, adding
// bookmarks through the onChanged broadcast steps down and removing steps back up; the usage panel
// taking height steps down and giving it back steps up; the UI text scale going 1.1 -> 1.5 at a
// fixed list height steps down in the same task as the change (the subscription, not the observer);
// nothing is measured while the sidebar is hidden, and showing it decides at once (also when only
// the height changed while hidden); a rename (Enter, Escape, blur) or a drag (dragend, drop), driven
// through the panel's real startRename and dragstart/dragend/drop paths, holds the decision until it
// ends; with no bookmarks the density stays roomy whatever the height (the wrapping empty message
// is no reason to tighten) and logs nothing; every change lands within the debounce plus a frame;
// one `[BOOKMARK] density {from, to, listPx, rows}` log per change and none when nothing changes.
//
// At each of the five UI scales (0.9, 1, 1.1, 1.25, 1.5), per density: row heights (34 / 28 / 22
// times the scale for a one-line row, about 33.6 times it for a row with a second line in tight
// and compact), no row's text clipped, the list one pixel taller than its content fits and one
// pixel shorter steps down (roomy -> tight -> compact; compact just short scrolls), and a 1/8 px
// sweep from 3 px below to 3 px above the three boundaries in which the panel's choice
// is compared with the density Chromium really leaves without a scrollbar (the roomiest one that
// does not scroll, else compact): no sample may differ. The sub-pixel sweep exists because the
// rows are fractional (x1.1: 37.4 px) and a whole-pixel comparison of scrollHeight and clientHeight
// picked the wrong density in a band 0.2-0.75 px wide at every boundary. Also at each scale: a
// rename in compact on a list that just fits shows no scrollbar, its field is no taller than a
// compact row and its text is not clipped.
//
// Run: node scripts/check-bookmarks-density.cjs
//   DENSITY_CHECK_DIR=<folder>  where the bundle, userData and result go (default: a new temp folder, removed after)
// The same file runs twice, as check-ui-text-scale.cjs does: under Node it bundles the sources with
// esbuild and starts Electron on itself; under Electron it opens one hidden window and exits.
// Run one hidden-Electron check at a time (pgrep -fl "check-" first).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HARD_TIMEOUT_MS = 150000;

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
  const ownDir = !process.env.DENSITY_CHECK_DIR;
  const outDir = process.env.DENSITY_CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'patton-check-density-'));
  fs.mkdirSync(outDir, { recursive: true });
  const resultFile = path.join(outDir, 'result.json');
  fs.rmSync(resultFile, { force: true });

  await build({
    stdin: {
      resolveDir: repo,
      loader: 'ts',
      contents: `
        import { BookmarksPanel } from './src/renderer/components/bookmarks-panel';
        import { applyUiTextScale } from './src/renderer/services/ui-text-scale';
        (window as any).__bp = { BookmarksPanel, applyUiTextScale };
      `,
    },
    bundle: true, platform: 'browser', format: 'iife', outfile: path.join(outDir, 'page.js'),
    loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const styles = ['main', 'tabs', 'terminal', 'editor', 'settings', 'board']
    .map((n) => fs.readFileSync(path.join(repo, 'src/renderer/styles', n + '.css'), 'utf8'));
  fs.writeFileSync(path.join(outDir, 'page.css'), styles.join('\n'));
  fs.writeFileSync(path.join(outDir, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head><body>' +
    '<div id="app"><div id="main"></div></div><script src="page.js"></script></body></html>');

  const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if (!fs.existsSync(__filename) || !fs.existsSync(electronBin)) {
    console.error('missing script or Electron binary', { script: __filename, electronBin });
    process.exit(2);
  }
  const log = fs.openSync(path.join(outDir, 'electron.log'), 'w');
  const env = { ...process.env, DENSITY_CHECK_DIR: outDir };
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
  let failed = 0;
  for (const c of result.checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  ${JSON.stringify(c.detail)}`}`);
  }
  console.log(`\n${result.checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------ Electron side
function electronMain() {
  const { app, BrowserWindow } = require('electron');
  const outDir = process.env.DENSITY_CHECK_DIR;
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
        show: false, width: 900, height: 900,
        webPreferences: { backgroundThrottling: false, contextIsolation: false, nodeIntegration: false },
      });
      await win.loadFile(path.join(outDir, 'page.html'));
      win.webContents.focus();
      write(await win.webContents.executeJavaScript(`(${pageRun.toString()})()`));
      app.exit(0);
    } catch (err) {
      write({ error: String((err && err.stack) || err) });
      app.exit(1);
    }
  });
}

// Runs inside the page. Self-contained: it is sent as source text.
async function pageRun() {
  const U = window.__bp;
  const SCALE = 1.1;
  const SCALES = [0.9, 1, 1.1, 1.25, 1.5];
  const DEBOUNCE_MS = 100;
  const LAND_MS = 260; // the debounce, the observer's delivery, a frame and some slack
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const r1 = (n) => Math.round(n * 10) / 10;
  const r2 = (n) => Math.round(n * 100) / 100;

  // --- the preload bridge, stubbed: bookmarks and plan usage answer and can be pushed to; the rest answers undefined
  const logs = [];
  let bookmarkListener = null;
  let usageListener = null;
  const P = (label, i) => ({ id: 'p' + i, kind: 'project', label, path: '/tmp/density/' + label.toLowerCase(), displayPath: '~/density/' + label.toLowerCase(), addedAt: i });
  const L = (label, i) => ({ id: 'l' + i, kind: 'artifact', label, url: 'https://example.com/' + label.toLowerCase(), addedAt: 100 + i });
  const projectNames = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
  const linkNames = ['Atlas', 'Basil', 'Cedar', 'Dune'];
  let list = [...projectNames.map(P), ...linkNames.map(L)];
  const stub = (name) => new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : stub(name ? name + '.' + String(k) : String(k))),
    apply: (_t, _this, args) => {
      if (name === 'bookmarks.get') return Promise.resolve(list);
      if (name === 'bookmarks.set') { list = args[0].map((b) => ({ ...b })); return Promise.resolve(list); }
      if (name === 'bookmarks.onChanged') { bookmarkListener = args[0]; return () => {}; }
      if (name === 'planUsage.get') return Promise.resolve(null);
      if (name === 'planUsage.onChanged') { usageListener = args[0]; return () => {}; }
      if (name === 'log.send') { logs.push({ level: args[0], args: args[1] }); return undefined; }
      if (/\.on[A-Z]/.test(name)) return () => {};
      return Promise.resolve(undefined);
    },
  });
  window.patton = stub('');
  try { localStorage.setItem('patton.bookmarks.width', '165'); } catch { /* */ }
  U.applyUiTextScale(SCALE, 'startup');

  // Two project rows have an open session waiting, so each shows a second line ("1 open · 1 waiting").
  const waiting = new Set(['/tmp/density/charlie', '/tmp/density/foxtrot']);
  const host = {
    getTabs: () => [], getActiveTab: () => null, switchToTab() {}, createTab: async () => null,
    listSessions: () => [...waiting].map((cwd, i) => ({ tabId: 't' + i, paneId: 'p' + i, cwd, project: null, state: 'waiting' })),
    goToSession: () => false, focusTerminal() {},
  };
  const app = document.getElementById('app');
  const main = document.getElementById('main');
  const bp = new U.BookmarksPanel(main, host);
  await bp.toggle();
  const panel = document.getElementById('bookmarks-panel');
  panel.style.width = '165px';
  const listEl = panel.querySelector('.bookmarks-list');

  // --- helpers
  const density = () => panel.dataset.density;
  const densityLogs = () => logs.filter((l) => Array.isArray(l.args) && l.args[0] === '[BOOKMARK] density');
  const order = { roomy: 0, tight: 1, compact: 2 };
  const ORDER = ['roomy', 'tight', 'compact'];
  // The list's height is what the sidebar is given: the app's height minus whatever is not the list.
  const setListHeight = (px) => {
    app.style.height = '2000px';
    const spare = listEl.clientHeight; // list height at an app height of 2000
    app.style.height = `${2000 - spare + px}px`;
  };
  // Pin the list to an exact (fractional) height, or release it. A pinned list resizes the observer too.
  const pin = (px) => { listEl.style.flex = `0 0 ${px}px`; listEl.style.height = `${px}px`; };
  const unpin = () => { listEl.style.flex = ''; listEl.style.height = ''; };
  // Truth: the list cannot scroll (no scrollbar shown, nothing to scroll to). The scroll offset is put back.
  const scrolls = () => {
    const keep = listEl.scrollTop;
    listEl.scrollTop = 1e6;
    const furthest = listEl.scrollTop;
    listEl.scrollTop = keep;
    return listEl.offsetWidth - listEl.clientWidth > 0 || furthest > 0;
  };
  const fits = () => !scrolls();
  const rowsInfo = () => {
    const rows = [...panel.querySelectorAll('.bookmark-row')];
    const oneLine = rows.filter((r) => !r.querySelector('.bookmark-subtitle')).map((r) => r.getBoundingClientRect().height);
    const twoLine = rows.filter((r) => r.querySelector('.bookmark-subtitle')).map((r) => r.getBoundingClientRect().height);
    const title = panel.querySelector('.bookmarks-group-title');
    const tcs = title ? getComputedStyle(title) : null;
    return {
      count: rows.length, oneLineN: oneLine.length, twoLineN: twoLine.length,
      one: oneLine.length ? { min: r1(Math.min(...oneLine)), max: r1(Math.max(...oneLine)) } : null,
      two: twoLine.length ? { min: r1(Math.min(...twoLine)), max: r1(Math.max(...twoLine)) } : null,
      titlePad: tcs ? `${tcs.paddingTop} ${tcs.paddingLeft} ${tcs.paddingBottom}` : null,
      listPx: listEl.clientHeight, scrollPx: listEl.scrollHeight,
    };
  };
  // No row's text is clipped by its row: each row holds its own label and second line.
  const textClipped = () => {
    const bad = [];
    for (const row of panel.querySelectorAll('.bookmark-row')) {
      const rr = row.getBoundingClientRect();
      if (row.scrollHeight > row.clientHeight + 1) bad.push(['row scrollHeight', row.dataset.bookmarkId, row.scrollHeight, row.clientHeight]);
      for (const el of row.querySelectorAll('.bookmark-label, .bookmark-subtitle')) {
        const er = el.getBoundingClientRect();
        if (er.height > 0 && (er.top < rr.top - 0.5 || er.bottom > rr.bottom + 0.5)) bad.push(['outside', row.dataset.bookmarkId, el.className, r2(er.top - rr.top), r2(rr.bottom - er.bottom)]);
      }
    }
    return bad;
  };
  // Wait for the attribute to read `want` (polling), returning how long it took, or -1 on a miss.
  const landed = async (want, since) => {
    for (let i = 0; i < 400; i++) {
      if (density() === want) return performance.now() - since;
      await sleep(4);
    }
    return -1;
  };
  // Do something, then expect the density to become `want` within the debounce plus a frame and exactly one
  // `[BOOKMARK] density` log {from, to, listPx, rows}. When `want` is the current density: no log at all.
  const step = async (name, action, want) => {
    const before = density();
    const logsBefore = densityLogs().length;
    const t0 = performance.now();
    await action();
    if (typeof want === 'function') want = want();
    const took = await landed(want, t0);
    await sleep(DEBOUNCE_MS + 120); // anything late or doubled shows up now
    const newLogs = densityLogs().slice(logsBefore);
    const changed = before !== want;
    check(`${name}: ${before} -> ${want}, landed in ${r1(took)} ms (<= ${LAND_MS})`, took >= 0 && took <= LAND_MS && density() === want, { before, now: density(), took });
    if (changed) {
      const a = newLogs[0] && newLogs[0].args[1];
      check(`${name}: exactly one [BOOKMARK] density log, {from: ${before}, to: ${want}, listPx, rows}`,
        newLogs.length === 1 && a && a.from === before && a.to === want && a.listPx === listEl.clientHeight && a.rows === panel.querySelectorAll('.bookmark-row').length, newLogs.map((l) => l.args));
    } else {
      check(`${name}: no [BOOKMARK] density log when the density is unchanged`, newLogs.length === 0, newLogs.map((l) => l.args));
    }
  };
  // The list's content height at each density (measured by trying each, then restoring the one in use).
  const contentAt = (d) => {
    const keep = density();
    panel.dataset.density = d;
    const last = listEl.lastElementChild.getBoundingClientRect().bottom;
    const h = last - listEl.getBoundingClientRect().top + parseFloat(getComputedStyle(listEl).paddingBottom) + listEl.scrollTop;
    panel.dataset.density = keep;
    return h;
  };
  // What Chromium leaves without a scrollbar: the roomiest density at which the list cannot scroll, else compact.
  const truthDensity = () => {
    const keep = density();
    let truth = 'compact';
    for (const d of ORDER) {
      panel.dataset.density = d;
      if (!scrolls()) { truth = d; break; }
    }
    panel.dataset.density = keep;
    return truth;
  };
  const bookmarkOf = (id) => list.find((b) => b.id === id);
  const rowOf = (id) => listEl.querySelector(`.bookmark-row[data-bookmark-id="${id}"]`);
  const keyOn = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  // The density the fit rule gives for a list of this height (from the content heights measured below).
  let cRoomy, cTight, cCompact;
  const ruleFor = (px) => (px >= Math.ceil(cRoomy) ? 'roomy' : px >= Math.ceil(cTight) ? 'tight' : 'compact');

  // --- 1. the heights, and one density per list height (x1.1)
  setListHeight(900);
  await sleep(DEBOUNCE_MS + 150);
  check('start: the sidebar is open with 11 rows, two of them with a second line', rowsInfo().count === 11 && rowsInfo().twoLineN === 2, rowsInfo());
  check('a tall list is roomy: today\'s rows, 37.4 px (x1.1), titles 10/6 padding, no overflow',
    density() === 'roomy' && near(rowsInfo().one.min, 37.4, 0.2) && near(rowsInfo().one.max, 37.4, 0.2) && near(rowsInfo().two.max, 37.4, 0.2)
    && /^(10|11)px 12px 6(\.\d+)?px$/.test(rowsInfo().titlePad) && fits(), rowsInfo());

  await step('460 px', async () => setListHeight(460), 'tight');
  let info = rowsInfo();
  check('460 px is tight: one-line rows 30.8 px, rows with a second line about 37 px (both lines kept), titles 6/4, no overflow',
    near(info.one.min, 30.8, 0.2) && near(info.one.max, 30.8, 0.2) && near(info.two.min, 37, 1.5) && near(info.two.max, 37, 1.5)
    && info.titlePad === '6px 12px 4px' && fits() && info.listPx === 460, info);
  const twoLineText = [...panel.querySelectorAll('.bookmark-row')].filter((r) => r.querySelector('.bookmark-subtitle')).map((r) => r.querySelector('.bookmark-subtitle').textContent);
  check('the second line still reads "1 open · 1 waiting" in tight', twoLineText.length === 2 && twoLineText.every((t) => t === '1 open · 1 waiting'), twoLineText);

  await step('380 px', async () => setListHeight(380), 'compact');
  info = rowsInfo();
  check('about 380 px is compact: one-line rows 24.2 px, second-line rows about 37 px, titles 6/4, no overflow',
    near(info.one.min, 24.2, 0.2) && near(info.one.max, 24.2, 0.2) && near(info.two.max, 37, 1.5) && info.titlePad === '6px 12px 4px' && fits() && info.listPx === 380, info);

  await step('300 px (nothing fits)', async () => setListHeight(300), 'compact');
  info = rowsInfo();
  check('about 300 px stays compact and the list scrolls (content taller than the list, overflow auto)',
    near(info.one.max, 24.2, 0.2) && scrolls() && getComputedStyle(listEl).overflowY === 'auto', info);

  await step('back to 900 px', async () => setListHeight(900), 'roomy');
  info = rowsInfo();
  check('a tall list is roomy again: rows 37.4 px, titles 10/6 padding, no overflow',
    near(info.one.max, 37.4, 0.2) && near(info.two.max, 37.4, 0.2) && /^(10|11)px 12px 6(\.\d+)?px$/.test(info.titlePad) && fits(), info);

  cRoomy = contentAt('roomy');
  cTight = contentAt('tight');
  cCompact = contentAt('compact');
  check(`the three densities are shorter in turn (content ${r1(cRoomy)} > ${r1(cTight)} > ${r1(cCompact)} px)`, cRoomy > cTight + 20 && cTight > cCompact + 20, { cRoomy, cTight, cCompact });

  // A resize inside one density's range changes nothing and logs nothing.
  await step('a resize that keeps the density (deep in compact)', async () => setListHeight(Math.floor(cCompact) - 40), 'compact');

  // The list's resizes are debounced (100 ms): a burst of three decides once, after the last one.
  setListHeight(900);
  await sleep(DEBOUNCE_MS + 150);
  check('debounce: starts roomy', density() === 'roomy', { d: density() });
  {
    const logsBefore = densityLogs().length;
    const t0 = performance.now();
    setListHeight(460);
    await sleep(40);
    check('debounce: 40 ms after a resize nothing has been decided yet', density() === 'roomy', { d: density() });
    setListHeight(380);
    await sleep(40);
    setListHeight(460);
    const took = await landed('tight', t0);
    await sleep(DEBOUNCE_MS + 150);
    const got = densityLogs().slice(logsBefore);
    check(`debounce: a burst of three resizes decides once, after the last (${r1(took)} ms from the first, last at about 80)`,
      took >= 150 && took <= 80 + LAND_MS && got.length === 1 && got[0].args[1].from === 'roomy' && got[0].args[1].to === 'tight', { took, logs: got.map((l) => l.args) });
  }

  // --- 2. a fixed list height: the bookmarks change under it (the broadcast other windows and this one hear)
  const extraProjects = [P('Hotel', 20), P('India', 21), P('Juliet', 22)];
  const fixed = async (px, fn) => {
    listEl.style.flex = `0 0 ${px}px`;
    try { await fn(); } finally { listEl.style.flex = ''; }
  };
  setListHeight(900);
  await sleep(DEBOUNCE_MS + 150);
  await fixed(Math.ceil(cRoomy) + 2, async () => {
    await sleep(DEBOUNCE_MS + 150);
    check('fixed list height that just fits roomy: roomy', density() === 'roomy', { d: density(), listPx: listEl.clientHeight });
    const grown = [...list, extraProjects[0]];
    await step('one more bookmark (broadcast) at a fixed height', async () => { list = grown; bookmarkListener(grown); }, 'tight');
    check('one more bookmark: 12 rows, fits', panel.querySelectorAll('.bookmark-row').length === 12 && fits(), rowsInfo());
    const shrunk = list.filter((b) => b.id !== 'p20');
    await step('that bookmark removed (broadcast) at a fixed height', async () => { list = shrunk; bookmarkListener(shrunk); }, 'roomy');
    // a broadcast of the same list changes nothing
    await step('the same list broadcast again', async () => { bookmarkListener([...list]); }, 'roomy');
  });
  await fixed(Math.ceil(cTight) + 2, async () => {
    await step('tight, just fits', async () => {}, 'tight');
    const grown = [...list, ...extraProjects.slice(0, 2)];
    await step('two more bookmarks at a fixed height', async () => { list = grown; bookmarkListener(grown); }, 'compact');
    const shrunk = grown.slice(0, grown.length - 2);
    await step('the two removed again', async () => { list = shrunk; bookmarkListener(shrunk); }, 'tight');
  });

  // --- 3. the usage panel at the sidebar's foot takes height from the list
  const acct = (i, live) => ({
    id: 'acct' + i, name: 'login' + i, email: null, plan: 'Max', live, lastLive: 1000 + i,
    week: { pct: 30 + i, resetsAt: Math.floor(Date.now() / 1000) + 86400, readAt: Math.floor(Date.now() / 1000), passed: false },
    fiveHour: null, weekTokens: null,
  });
  const usageOf = (n) => ({ liveId: n ? 'acct0' : null, accounts: Array.from({ length: n }, (_, i) => acct(i, i === 0)) });
  setListHeight(900);
  await sleep(DEBOUNCE_MS + 150);
  // Choose the app's height so the list just fits roomy with no usage panel.
  setListHeight(Math.ceil(cRoomy) + 2);
  await step('app height where the list just fits roomy', async () => {}, 'roomy');
  const appH = app.style.height;
  const usageEl = panel.querySelector('.usage-panel');
  const listNow = () => listEl.clientHeight;
  const base = listNow();
  await step('usage panel with 3 logins appears', async () => usageListener(usageOf(3)), () => ruleFor(listNow()));
  const h3 = listNow();
  check('the usage panel is shown and took height from the list, and the density stepped down', usageEl && !usageEl.hidden && h3 < base - 20 && order[density()] > order.roomy && app.style.height === appH, { hidden: usageEl && usageEl.hidden, base, h3, d: density() });
  await step('usage panel with 1 login (less height)', async () => usageListener(usageOf(1)), () => ruleFor(listNow()));
  const h1 = listNow();
  check('1 login takes less height than 3, and the density is no tighter', h1 > h3 && order[density()] <= order[ruleFor(h3)], { h1, h3, d: density() });
  await step('usage panel back to 3 logins', async () => usageListener(usageOf(3)), () => ruleFor(listNow()));
  check('back to 3 logins: the list is as tall as before', listNow() === h3, { h3, now: listNow() });
  await step('usage panel gone', async () => usageListener(usageOf(0)), 'roomy');
  check('usage panel gone: the list is back to its height', listNow() === base, { base, now: listNow() });

  // --- 4. the UI text scale at a fixed list height: decided in the same task as the change (the subscription)
  await fixed(Math.ceil(cRoomy) + 2, async () => {
    await sleep(DEBOUNCE_MS + 150);
    check('fixed list height that just fits roomy at x1.1: roomy', density() === 'roomy', { d: density() });
    U.applyUiTextScale(1.5, 'change');
    const at = density(); // read at once: no await, no observer, no debounce can have run
    check(`UI scale 1.1 -> 1.5 at a fixed list height steps down in the same task as the change (roomy -> ${at})`, order[at] > order.roomy, { at });
    check('...and the density it chose leaves no scrollbar unless it is compact', at === 'compact' || fits(), { at, scrolls: scrolls() });
    const down = densityLogs().slice(-1)[0];
    check('the scale change logged one density change, from roomy', down && down.args[1].from === 'roomy' && down.args[1].to === at, down && down.args);
    U.applyUiTextScale(SCALE, 'change');
    check('UI scale 1.5 -> 1.1 steps back up to roomy in the same task, no scrollbar', density() === 'roomy' && fits(), { d: density() });
    await sleep(DEBOUNCE_MS + 150);
    check('...and it stays roomy once the observer has run', density() === 'roomy', { d: density() });
  });

  // --- 5. hidden: nothing measured; right on show
  setListHeight(460);
  await sleep(DEBOUNCE_MS + 150);
  setListHeight(900);
  const appH900 = app.style.height;
  setListHeight(460);
  await sleep(DEBOUNCE_MS + 150);
  check('before hiding: tight at 460 px', density() === 'tight', { d: density() });
  await bp.toggle(); // hides
  check('the sidebar is hidden (collapsed)', panel.classList.contains('collapsed'), panel.className);
  const logsHidden = densityLogs().length;
  app.style.height = appH900;
  list = [...list, extraProjects[0]];
  bookmarkListener(list);
  U.applyUiTextScale(1.5, 'change');
  await sleep(DEBOUNCE_MS + 200);
  U.applyUiTextScale(SCALE, 'change');
  await sleep(DEBOUNCE_MS + 150);
  check('while hidden: nothing is measured (density attribute and logs unchanged)', density() === 'tight' && densityLogs().length === logsHidden, { d: density(), logs: densityLogs().length - logsHidden });
  const t0 = performance.now();
  await bp.toggle(); // shows
  const took = await landed('roomy', t0);
  await sleep(DEBOUNCE_MS + 120);
  check(`on show the density is decided for the new height: roomy (list ${listEl.clientHeight} px, 12 rows), landed in ${r1(took)} ms`, took >= 0 && took <= LAND_MS && fits(), { d: density(), took });
  check('on show: exactly one density log, tight -> roomy', densityLogs().length === logsHidden + 1 && densityLogs().slice(-1)[0].args[1].from === 'tight' && densityLogs().slice(-1)[0].args[1].to === 'roomy', densityLogs().slice(-2).map((l) => l.args));
  list = list.filter((b) => b.id !== 'p20');
  bookmarkListener(list);
  await sleep(50);
  // Hidden while only the height changes (no row rebuilt, no scale change): showing decides at once, not a debounce later.
  setListHeight(460);
  await sleep(DEBOUNCE_MS + 150);
  check('before the second hide: tight at 460 px', density() === 'tight', { d: density() });
  await bp.toggle(); // hides
  setListHeight(900);
  await bp.toggle(); // shows: the height changed while hidden, nothing else
  check('on show after only a height change, the density is already decided (same task as the show)', density() === 'roomy', { d: density() });
  await sleep(DEBOUNCE_MS + 150);

  // --- 6. mid-rename / mid-drag, through the panel's real paths: rows keep their height until it ends
  const variants = [
    { name: 'rename ended by Enter (label unchanged)', kind: 'rename', end: (ctx) => keyOn(ctx.input, 'Enter') },
    { name: 'rename ended by Escape', kind: 'rename', end: (ctx) => keyOn(ctx.input, 'Escape') },
    { name: 'rename ended by blur', kind: 'rename', end: (ctx) => ctx.input.dispatchEvent(new Event('blur')) },
    { name: 'drag ended by dragend', kind: 'drag', end: (ctx) => ctx.row.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: ctx.dt })) },
    {
      name: 'drag ended by a drop that reorders', kind: 'drag',
      end: (ctx) => {
        const target = rowOf('p3');
        const r = target.getBoundingClientRect();
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: ctx.dt, clientX: r.left + 10, clientY: r.bottom - 2 }));
      },
    },
  ];
  for (const v of variants) {
    setListHeight(900);
    await sleep(DEBOUNCE_MS + 150);
    const ctx = {};
    const orderBefore = list.map((b) => b.id).join();
    if (v.kind === 'rename') {
      bp.startRename(bookmarkOf('p0'));
      ctx.input = listEl.querySelector('.bookmark-rename');
      check(`${v.name}: the rename field is up (startRename)`, !!ctx.input && bp.renamingId === 'p0', { renamingId: bp.renamingId });
    } else {
      ctx.row = rowOf('p0');
      ctx.dt = new DataTransfer();
      ctx.row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: ctx.dt }));
      check(`${v.name}: the drag is under way (dragstart)`, bp.dragId === 'p0', { dragId: bp.dragId });
    }
    const before = densityLogs().length;
    setListHeight(380);
    await sleep(DEBOUNCE_MS + 200);
    check(`${v.name}: the density holds (roomy) though the list shrank to 380 px`, density() === 'roomy' && densityLogs().length === before, { d: density() });
    v.end(ctx);
    await sleep(v.kind === 'drag' && v.name.includes('drop') ? 150 : 20);
    check(`${v.name}: it is over, the held decision is made (compact) and logged once`,
      bp.renamingId === null && bp.dragId === null && density() === 'compact' && densityLogs().length === before + 1, { d: density(), logs: densityLogs().length - before, renamingId: bp.renamingId, dragId: bp.dragId });
    if (v.kind === 'rename') check(`${v.name}: the field is gone and its row is back`, !listEl.querySelector('.bookmark-rename') && rowOf('p0') && !rowOf('p0').hidden, null);
    if (v.name.includes('drop')) check(`${v.name}: the order changed (p0 moved after p3)`, list.map((b) => b.id).join() !== orderBefore && list.findIndex((b) => b.id === 'p0') === 3, list.map((b) => b.id));
    list = list.slice().sort((a, b) => a.addedAt - b.addedAt); // the original order back for the next variant
    bookmarkListener(list);
    setListHeight(900);
    await sleep(DEBOUNCE_MS + 150);
    check(`${v.name}: back to roomy at 900 px`, density() === 'roomy', { d: density() });
  }

  // --- 7. every UI scale: row heights, text, boundaries, the 1/8 px sweep, the rename field
  const perScale = async (s) => {
    unpin();
    U.applyUiTextScale(s, 'change');
    app.style.height = '2000px';
    await sleep(DEBOUNCE_MS + 150);
    const x = `x${s}`;
    const roomy = contentAt('roomy'), tight = contentAt('tight'), compact = contentAt('compact');

    // row heights by density, text not clipped
    const heightCases = [
      ['roomy', roomy + 2, 34 * s, 34 * s],
      ['tight', tight + 1, 28 * s, 33.6 * s],
      ['compact', compact + 1, 22 * s, 33.6 * s],
    ];
    for (const [d, px, one, two] of heightCases) {
      pin(px);
      await sleep(DEBOUNCE_MS + 150);
      const i = rowsInfo();
      check(`${x} ${d}: one-line rows ${r1(one)} px, rows with a second line about ${r1(two)} px, no overflow, no text clipped (list ${r2(px)} px)`,
        density() === d && near(i.one.min, one, 0.25) && near(i.one.max, one, 0.25) && near(i.two.min, two, 1.5) && near(i.two.max, two, 1.5) && fits() && textClipped().length === 0, { d: density(), i, clipped: textClipped() });
    }

    // the boundaries a pixel either side, by the real observer
    const wantAt = [
      ['a pixel of room above roomy', roomy + 1, 'roomy'],
      ['a pixel short of roomy', roomy - 1, 'tight'],
      ['a pixel of room above tight', tight + 1, 'tight'],
      ['a pixel short of tight', tight - 1, 'compact'],
      ['a pixel of room above compact', compact + 1, 'compact'],
    ];
    for (const [name, px, want] of wantAt) {
      pin(px);
      await sleep(DEBOUNCE_MS + 150);
      check(`${x} ${name} (${r2(px)} px): ${want}, and it has no scrollbar`, density() === want && fits(), { d: density(), scrolls: scrolls() });
    }
    pin(compact - 1);
    await sleep(DEBOUNCE_MS + 150);
    check(`${x} a pixel short of compact: compact, and the list scrolls`, density() === 'compact' && scrolls(), { d: density(), scrolls: scrolls() });

    // 1/8 px sweep around the roomy and tight boundaries: the panel's choice against what Chromium leaves scrollless
    const mismatches = [];
    let samples = 0;
    for (const centre of [roomy, tight, compact]) {
      for (let h = centre - 3; h <= centre + 3 + 1e-9; h += 0.125) {
        pin(h);
        bp.updateDensity();
        const decided = density();
        const truth = truthDensity();
        samples++;
        if (decided !== truth) mismatches.push({ h, decided, truth });
      }
    }
    check(`${x} sweep: ${samples} list heights at 1/8 px steps around the three boundaries, the panel's density equals the one Chromium leaves scrollless in every one`, mismatches.length === 0 && samples >= 140, { samples, first: mismatches.slice(0, 6), n: mismatches.length });

    // a rename in compact on a list that just fits: no scrollbar, a field no taller than a row, text not clipped
    for (const id of ['p3', 'p2']) {
      pin(Math.ceil(compact) + 0.5);
      await sleep(DEBOUNCE_MS + 150);
      const before = density();
      const rowH = rowOf('p4').getBoundingClientRect().height;
      bp.startRename(bookmarkOf(id));
      await sleep(DEBOUNCE_MS + 120); // the observer, were the list to change
      const input = listEl.querySelector('.bookmark-rename');
      const ih = input.getBoundingClientRect().height;
      const cs = getComputedStyle(input);
      const inner = input.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      check(`${x} rename of ${id} in compact on a just-fitting list: the list does not scroll, the field (${r2(ih)} px) is no taller than a compact row (${r2(rowH)} px), its text (${cs.fontSize}) is not clipped, the density stays compact`,
        before === 'compact' && density() === 'compact' && fits() && ih <= rowH + 0.05 && input.scrollHeight <= input.clientHeight + 0.5 && inner >= parseFloat(cs.fontSize) * 1.05, { before, d: density(), scrolls: scrolls(), ih, rowH, scrollH: input.scrollHeight, clientH: input.clientHeight, inner, font: cs.fontSize });
      keyOn(input, 'Escape');
      await sleep(30);
    }
    unpin();
  };
  for (const s of SCALES) await perScale(s);
  U.applyUiTextScale(SCALE, 'change');
  unpin();

  // --- 8. no bookmarks: the empty message (it wraps in a narrow, short list) never tightens anything
  setListHeight(900);
  await sleep(DEBOUNCE_MS + 150);
  const keepList = list;
  list = [];
  bookmarkListener([]);
  await sleep(DEBOUNCE_MS + 100);
  check('with no bookmarks the density is roomy (nothing to fit)', density() === 'roomy' && !!panel.querySelector('.bookmarks-empty'), { d: density() });
  const logsEmpty = densityLogs().length;
  const empty = panel.querySelector('.bookmarks-empty');
  for (const px of [120, 60, 30]) {
    pin(px);
    await sleep(DEBOUNCE_MS + 150);
    check(`no bookmarks in a ${px} px list (the message is ${r1(empty.getBoundingClientRect().height)} px tall, ${listEl.scrollHeight > listEl.clientHeight ? 'taller than the list' : 'fits'}): still roomy, no density log`,
      density() === 'roomy' && densityLogs().length === logsEmpty, { d: density(), logs: densityLogs().length - logsEmpty });
  }
  check('the empty message wraps (more than one line, so a short list really is shorter than it)', empty.getBoundingClientRect().height > 2 * parseFloat(getComputedStyle(empty).lineHeight), empty.getBoundingClientRect().height);
  unpin();
  list = keepList;
  bookmarkListener(list);
  await sleep(50);

  return { checks };
}
