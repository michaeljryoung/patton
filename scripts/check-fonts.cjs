// Hidden-Electron check of Patton's font handling: SF Mono read from the
// Mac's Terminal.app (src/main/system-fonts.ts), registered in document.fonts
// (src/renderer/services/system-fonts.ts), the Settings availability detector
// (src/renderer/services/font-choices.ts), and a live xterm Terminal re-measuring
// on a fontFamily change with the DOM renderer and with WebGL.
//
// Also drives the real renderer loadSystemFonts() against fixture folders of
// SF Mono (full, partial, corrupt, unreadable, missing) read by the real main
// findSfMono(dir). Not covered here: the ipc handler, the preload bridge and
// the Uint8Array crossing contextBridge (the page gets the bytes as base64),
// the app's CSP, and App/Tab/QuickTerminal/Settings wiring (those get source
// checks only).
//
// Needs the SF Mono that ships in Terminal.app (the fixtures are copies of it).
// Run: node scripts/check-fonts.cjs
//   FONT_CHECK_DIR=<folder>   where the bundles, userData and result go (default: a new temp folder, removed after)
//   FONT_CHECK_EXPECT=a,b,... families expected to draw after registration
//                             (default: derived from this Mac: the Settings
//                             choices that \`system_profiler SPFontsDataType\` lists,
//                             plus SF Mono once registered; takes ~8 s)
// The same file runs twice: under Node it bundles the real sources with esbuild
// and starts Electron on itself; under Electron it opens one window that is
// never shown (show:false, dock hidden), runs the checks and exits.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEGACY_VALUES = [
  "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
  "'Menlo', 'Monaco', 'Courier New', monospace",
  "'JetBrains Mono', 'Fira Code', monospace",
  "'Fira Code', monospace",
  "'Monaco', 'Courier New', monospace",
  "'Courier New', monospace",
];
const HARD_TIMEOUT_MS = 40000;

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
  const ownDir = !process.env.FONT_CHECK_DIR;
  const outDir = process.env.FONT_CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'patton-check-fonts-'));
  fs.mkdirSync(outDir, { recursive: true });
  const resultFile = path.join(outDir, 'result.json');
  fs.rmSync(resultFile, { force: true });

  await build({
    entryPoints: [path.join(repo, 'src/main/system-fonts.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(outDir, 'system-fonts-main.cjs'),
    logLevel: 'silent',
  });
  await build({
    stdin: {
      resolveDir: repo,
      loader: 'ts',
      contents: `
        import { registerSystemFonts, loadSystemFonts } from './src/renderer/services/system-fonts';
        import { FONT_CHOICES, buildFontOptions, fontDraws, safeFontOptions } from './src/renderer/services/font-choices';
        import { Terminal } from '@xterm/xterm';
        import { WebglAddon } from '@xterm/addon-webgl';
        (window as any).__fc = { registerSystemFonts, loadSystemFonts, FONT_CHOICES, buildFontOptions, fontDraws, safeFontOptions, Terminal, WebglAddon };
      `,
    },
    bundle: true, platform: 'browser', format: 'iife', outfile: path.join(outDir, 'page.js'),
    logLevel: 'silent',
  });
  fs.copyFileSync(require.resolve('@xterm/xterm/css/xterm.css'), path.join(outDir, 'xterm.css'));
  fs.writeFileSync(path.join(outDir, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="xterm.css"></head>' +
    '<body style="margin:0"><script src="page.js"></script></body></html>');

  const electronBin = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  // Electron given a missing script opens its default window: refuse instead.
  if (!fs.existsSync(__filename) || !fs.existsSync(electronBin)) {
    console.error('missing script or Electron binary', { script: __filename, electronBin });
    process.exit(2);
  }
  // What this Mac has, from the OS rather than from the detector under test.
  let systemFamilies = [];
  if (!process.env.FONT_CHECK_EXPECT) {
    try {
      const out = require('node:child_process').execFileSync('system_profiler', ['SPFontsDataType', '-json'], { maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
      const names = new Set();
      for (const f of JSON.parse(out.toString()).SPFontsDataType) for (const t of f.typefaces || []) if (t.family) names.add(t.family);
      systemFamilies = [...names];
    } catch (err) {
      console.error('could not list the Mac\'s fonts with system_profiler; set FONT_CHECK_EXPECT=a,b,... instead', String(err));
      process.exit(2);
    }
  }
  const log = fs.openSync(path.join(outDir, 'electron.log'), 'w');
  const env = { ...process.env, FONT_CHECK_DIR: outDir, FONT_CHECK_SYSTEM_FAMILIES: JSON.stringify(systemFamilies) };
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
  if (result.measurements) console.log(JSON.stringify(result.measurements));
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------ Electron side
function electronMain() {
  const { app, BrowserWindow } = require('electron');
  const outDir = process.env.FONT_CHECK_DIR;
  const resultFile = path.join(outDir, 'result.json');
  const write = (obj) => fs.writeFileSync(resultFile, JSON.stringify(obj, null, 1));
  app.setPath('userData', path.join(outDir, 'ud'));
  if (app.dock) app.dock.hide();
  setTimeout(() => {
    try { write({ error: 'timeout' }); } catch { /* the parent reports "no result" */ }
    app.exit(1);
  }, HARD_TIMEOUT_MS);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  app.whenReady().then(async () => {
    try {
      // --- main process: finding SF Mono on fixed paths
      const logged = [];
      const origInfo = console.info;
      console.info = (...a) => { logged.push(a.map(String).join(' ')); origInfo(...a); };
      const sys = require(path.join(outDir, 'system-fonts-main.cjs'));
      const sf = sys.findSfMono();
      const none = sys.findSfMono(['/nonexistent/patton-font-check']);
      console.info = origInfo;
      const faceKeys = sf ? sf.faces.map(f => `${f.weight}/${f.style}`).sort() : [];
      check('main: SF Mono found with Regular, Italic, Bold, BoldItalic',
        sf && sf.family === 'SF Mono' && faceKeys.join() === '400/italic,400/normal,700/italic,700/normal' &&
        sf.faces.every(f => f.data.byteLength > 10000), { dir: sf && sf.dir, faceKeys });
      check('main: missing directories give null', none === null, none);
      check('main: logs "[FONT] SF Mono found"', logged.some(l => l.includes('[FONT] SF Mono found')), logged);
      check('main: logs "[FONT] SF Mono not on this Mac"', logged.some(l => l.includes('[FONT] SF Mono not on this Mac')), logged);

      // --- main process: fixture folders of SF Mono, read by the real findSfMono(dir)
      const b64 = (u8) => Buffer.from(u8).toString('base64');
      const familiesOf = (fam) => (fam ? [{ family: fam.family, dir: fam.dir, faces: fam.faces.map(f => ({ weight: f.weight, style: f.style, b64: b64(f.data) })) }] : []);
      const cases = [];
      if (sf) {
        const fx = path.join(outDir, 'fixtures');
        fs.rmSync(fx, { recursive: true, force: true });
        const FILES = { regular: 'SF-Mono-Regular.otf', italic: 'SF-Mono-RegularItalic.otf', bold: 'SF-Mono-Bold.otf', boldItalic: 'SF-Mono-BoldItalic.otf' };
        const garbage = Buffer.alloc(30000, 7);
        // spec: file -> 'copy' | 'garbage' | 'unreadable' | 'dir' | absent
        const make = (name, spec) => {
          const dir = path.join(fx, name);
          fs.mkdirSync(dir, { recursive: true });
          for (const [key, how] of Object.entries(spec)) {
            const f = path.join(dir, FILES[key]);
            if (how === 'copy') fs.copyFileSync(path.join(sf.dir, FILES[key]), f);
            else if (how === 'garbage') fs.writeFileSync(f, garbage);
            else if (how === 'unreadable') { fs.copyFileSync(path.join(sf.dir, FILES[key]), f); fs.chmodSync(f, 0); }
            else if (how === 'dir') fs.mkdirSync(f);
          }
          return dir;
        };
        const all = { regular: 'copy', italic: 'copy', bold: 'copy', boldItalic: 'copy' };
        const cap = (name, dir) => {
          const warned = [];
          const origWarn = console.warn;
          console.warn = (...a) => { warned.push(a.map(String).join(' ')); };
          const fam = sys.findSfMono([dir]);
          console.warn = origWarn;
          cases.push({ name, mainFaces: fam ? fam.faces.length : null, families: familiesOf(fam), warned });
        };
        cap('missing folder', path.join(fx, 'does-not-exist'));
        cap('empty folder', make('empty', {}));
        cap('Bold only, no Regular', make('bold-only', { bold: 'copy' }));
        cap('Regular is a directory', make('regular-dir', { ...all, regular: 'dir' }));
        if (process.getuid && process.getuid() !== 0) cap('Regular unreadable (chmod 000)', make('regular-unreadable', { ...all, regular: 'unreadable' }));
        cap('Regular corrupt, others good', make('regular-corrupt', { ...all, regular: 'garbage' }));
        cap('Bold corrupt, others good', make('bold-corrupt', { ...all, bold: 'garbage' }));
        cap('Regular only', make('regular-only', { regular: 'copy' }));
        cap('all four good', make('full', all));
      }

      // --- renderer
      const w = new BrowserWindow({ show: false, width: 900, height: 500, webPreferences: { backgroundThrottling: false } });
      await w.loadFile(path.join(outDir, 'page.html'));
      const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      const storeSrc = readSrc('src/main/store.ts');
      const fontRe = /fontFamily[\s\S]{0,200}?\/(\^[^/]+\$)\/\.test/.exec(storeSrc);
      const appSrc = readSrc('src/renderer/components/app.ts');
      const zoomFn = /private applyFontSize\(\): void \{[\s\S]*?\n {2}\}/.exec(appSrc);
      const systemFamilies = JSON.parse(process.env.FONT_CHECK_SYSTEM_FAMILIES || '[]');
      const payload = {
        families: familiesOf(sf),
        cases,
        expectOverride: process.env.FONT_CHECK_EXPECT ? process.env.FONT_CHECK_EXPECT.split(',').map(s => s.trim()) : null,
        systemFamilies,
        legacy: LEGACY_VALUES,
        storeFontRegex: fontRe && fontRe[1],
        src: {
          appSetsFontMono: /setProperty\(\s*'--font-mono'/.test(appSrc),
          zoomReachesQuick: Boolean(zoomFn && /quickTerminal\.setFontSize\(/.test(zoomFn[0])),
          settingsUsesSafeOptions: /safeFontOptions\(/.test(readSrc('src/renderer/components/settings-panel.ts')),
        },
      };
      const page = await w.webContents.executeJavaScript(`(${pageChecks.toString()})(${JSON.stringify(payload)})`);
      for (const c of page.checks) checks.push(c);
      write({ checks, measurements: page.measurements });
    } catch (err) {
      write({ error: String(err && err.stack || err), checks });
    }
    app.exit(0);
  });
}

// Runs inside the hidden window (serialized with toString: no closures).
async function pageChecks(payload) {
  const fc = window.__fc;
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const measurements = {};

  const sfSystemWide = payload.systemFamilies.includes('SF Mono');
  const sfFacesNow = () => Array.from(document.fonts).filter(f => f.family.replace(/["']/g, '') === 'SF Mono');
  const toFamilies = (fams) => fams.map(f => ({
    family: f.family, dir: f.dir,
    faces: f.faces.map(x => ({ weight: x.weight, style: x.style, data: Uint8Array.from(atob(x.b64), ch => ch.charCodeAt(0)) })),
  }));

  // --- before registration
  if (sfSystemWide) {
    checks.push({ name: 'SKIPPED: "SF Mono does not draw before registration" (SF Mono is installed system-wide on this Mac)', ok: true });
  } else {
    check('before registration, SF Mono does not draw', !fc.fontDraws('SF Mono'));
  }
  check('detector: Menlo draws (sanity)', fc.fontDraws('Menlo'));
  check('detector: a made-up family does not draw', !fc.fontDraws('Patton No Such Font'));
  check('detector: an invalid family name does not draw (an ignored font setting must not reuse the last font)', !fc.fontDraws('Foo\nBar'));
  check('detector: a generic keyword (monospace) draws', fc.fontDraws('monospace'));

  // --- the real loadSystemFonts() against fixture folders read by the real findSfMono(dir)
  // (the page stands in for the ipc/preload link with a stub getSystem)
  const want = {
    'missing folder': { main: null, added: 0, draws: false },
    'empty folder': { main: null, added: 0, draws: false },
    'Bold only, no Regular': { main: null, added: 0, draws: false },
    'Regular is a directory': { main: null, added: 0, draws: false },
    'Regular unreadable (chmod 000)': { main: null, added: 0, draws: false },
    'Regular corrupt, others good': { main: 4, added: 0, draws: false },
    'Bold corrupt, others good': { main: 4, added: 3, draws: true, noBold: true },
    'Regular only': { main: 1, added: 1, draws: true },
    'all four good': { main: 4, added: 4, draws: true },
  };
  for (const c of payload.cases) {
    const w = want[c.name];
    window.patton = { fonts: { getSystem: async () => toFamilies(c.families) } };
    await fc.loadSystemFonts();
    const faces = sfFacesNow();
    const draws = fc.fontDraws('SF Mono');
    check(`fixture "${c.name}": main reads ${w.main === null ? 'nothing' : w.main + ' faces'}`, c.mainFaces === w.main, { got: c.mainFaces, warned: c.warned });
    check(`fixture "${c.name}": renderer registers ${w.added} faces${w.noBold ? ', none of them Bold' : ''}${w.added === 0 ? ' and SF Mono does not draw' : ''}`,
      faces.length === w.added && (sfSystemWide || draws === w.draws) && (!w.noBold || !faces.some(f => f.weight === '700' && f.style === 'normal')),
      { faces: faces.map(f => `${f.weight}/${f.style}/${f.status}`), draws });
    document.fonts.clear();
  }
  window.patton = { fonts: { getSystem: async () => { throw new Error('ipc down'); } } };
  await fc.loadSystemFonts().then(() => check('loadSystemFonts survives a failing getSystem and registers nothing', sfFacesNow().length === 0),
    (err) => check('loadSystemFonts survives a failing getSystem and registers nothing', false, String(err)));
  window.patton = { fonts: { getSystem: async () => [] } };
  await fc.loadSystemFonts().then(() => check('loadSystemFonts with no fonts registers nothing', sfFacesNow().length === 0),
    (err) => check('loadSystemFonts with no fonts registers nothing', false, String(err)));

  // --- registration (the main process's own read of this Mac's SF Mono)
  const families = toFamilies(payload.families);
  const added = await fc.registerSystemFonts(families);
  const sfFaces = sfFacesNow();
  check('registerSystemFonts adds 4 loaded SF Mono faces', added === 4 && sfFaces.length === 4 && sfFaces.every(f => f.status === 'loaded'),
    { added, faces: sfFaces.map(f => `${f.weight}/${f.style}/${f.status}`) });
  check('after registration, SF Mono draws', fc.fontDraws('SF Mono'));

  // --- availability detector: the expected set comes from the OS (system_profiler), not from the detector
  const drawn = fc.FONT_CHOICES.filter(c => fc.fontDraws(c.family)).map(c => c.family).sort();
  const expected = (payload.expectOverride ||
    Array.from(new Set(fc.FONT_CHOICES.map(c => c.family).filter(f => payload.systemFamilies.includes(f)).concat(families.length ? ['SF Mono'] : [])))
  ).slice().sort();
  check('detector returns the set this Mac has (+ registered SF Mono)', drawn.join() === expected.join(), { drawn, expected });

  // --- options Settings shows
  const values = fc.FONT_CHOICES.map(c => c.value);
  check('all six pre-existing option values are still choices', payload.legacy.every(v => values.includes(v)),
    payload.legacy.filter(v => !values.includes(v)));
  const draws = (f) => fc.fontDraws(f);
  const firaValue = "'Fira Code', monospace";
  const optsFira = fc.buildFontOptions(firaValue, draws);
  const firaOpt = optsFira.find(o => o.value === firaValue);
  check('saved Fira Code stays listed, labelled "(not on this Mac)"', firaOpt && firaOpt.label === 'Fira Code (not on this Mac)' && !firaOpt.available, firaOpt);
  const optsSf = fc.buildFontOptions(payload.legacy[0], draws);
  check('saved SF Mono: options are exactly the families that draw, no "not on this Mac"',
    optsSf.map(o => o.label).sort().join() === expected.join() && optsSf.every(o => o.available), optsSf.map(o => o.label));
  const custom = "'Foo Bar Mono', monospace";
  const optsCustom = fc.buildFontOptions(custom, draws);
  check('saved custom stack is listed as "Foo Bar Mono (not on this Mac)"',
    optsCustom.some(o => o.value === custom && o.label === 'Foo Bar Mono (not on this Mac)'), optsCustom.slice(-1));

  // --- a throwing probe must not stop Settings: safeFontOptions falls back
  const boom = () => { throw new Error('no 2d canvas context'); };
  const fb = fc.safeFontOptions("'Courier New', monospace", boom);
  check('probe throws: safeFontOptions lists the six original options', ['SF Mono', 'Menlo', 'JetBrains Mono', 'Fira Code', 'Monaco', 'Courier New'].every(l => fb.some(o => o.label === l)), fb.map(o => o.label));
  const fbCustom = fc.safeFontOptions(custom, boom);
  check('probe throws: the saved custom stack is still listed', fbCustom.some(o => o.value === custom), fbCustom.map(o => o.value));
  check('probe works: safeFontOptions equals buildFontOptions',
    JSON.stringify(fc.safeFontOptions(payload.legacy[0], draws)) === JSON.stringify(fc.buildFontOptions(payload.legacy[0], draws)));

  // --- every choice must pass the store's fontFamily validation, or it applies live and never persists
  const storeRe = payload.storeFontRegex && new RegExp(payload.storeFontRegex);
  const bad = storeRe ? fc.FONT_CHOICES.filter(c => c.value.length > 200 || !storeRe.test(c.value)).map(c => c.value) : ['(store regex not found)'];
  check('every FONT_CHOICES value passes the store fontFamily regex', storeRe && bad.length === 0, bad);

  // --- source checks (the wiring is not run here): the fixes stay in place
  check('source: Font Family no longer rewrites --font-mono', !payload.src.appSetsFontMono);
  check('source: Cmd+/- zoom reaches the quick terminal', payload.src.zoomReachesQuick);
  check('source: Settings builds its font list through safeFontOptions', payload.src.settingsUsesSafeOptions);

  // --- a live xterm Terminal re-measures on fontFamily change
  const stacks = {
    Menlo: "'Menlo', 'Monaco', 'Courier New', monospace",
    'JetBrains Mono': "'JetBrains Mono', 'Fira Code', monospace",
    'SF Mono': payload.legacy[0],
  };
  const atlasHash = (canvas) => {
    if (!canvas) return null;
    const url = canvas.toDataURL();
    let h = 0;
    for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
    return h;
  };
  for (const mode of ['dom', 'webgl']) {
    const host = document.createElement('div');
    host.style.cssText = 'width:800px;height:300px;position:absolute;top:0;left:0';
    document.body.appendChild(host);
    const term = new fc.Terminal({ fontSize: 13, fontFamily: stacks.Menlo, allowProposedApi: true });
    term.open(host);
    let addon = null;
    if (mode === 'webgl') {
      addon = new fc.WebglAddon();
      term.loadAddon(addon);
    }
    await new Promise(r => term.write('Hello WWW mmm 0O ilil @@ The quick brown fox\r\n', r));
    await sleep(200);
    const core = term._core;
    const rows = [];
    for (const name of ['Menlo', 'JetBrains Mono', 'SF Mono']) {
      term.options.fontFamily = stacks[name];
      term.refresh(0, term.rows - 1);
      await sleep(250);
      const rowsEl = term.element.querySelector('.xterm-rows');
      rows.push({
        name,
        charWidth: core._charSizeService.width,
        cellWidth: core._renderService.dimensions.css.cell.width,
        rowsFont: rowsEl ? getComputedStyle(rowsEl).fontFamily : null,
        atlas: addon ? atlasHash(addon.textureAtlas) : null,
      });
    }
    measurements[mode] = rows;
    const [m, j, s] = rows;
    check(`${mode}: measured char width changes Menlo -> JetBrains Mono -> SF Mono`,
      m.charWidth !== j.charWidth && j.charWidth !== s.charWidth && m.charWidth !== s.charWidth,
      rows.map(r => [r.name, r.charWidth]));
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `13px ${stacks['SF Mono']}`;
    const sfW = ctx.measureText('W').width;
    check(`${mode}: SF Mono cell matches SF Mono's own glyph width`, Math.abs(s.charWidth - sfW) < 0.05, { charWidth: s.charWidth, sfW });
    check(`${mode}: cell width changes Menlo -> SF Mono`, m.cellWidth !== s.cellWidth, [m.cellWidth, s.cellWidth]);
    if (mode === 'dom') {
      check('dom: row text styled with the new family', /SF Mono/.test(s.rowsFont || '') && /JetBrains/.test(j.rowsFont || ''), rows.map(r => r.rowsFont));
    } else {
      check('webgl: the WebGL renderer is active (texture atlas present)', rows.every(r => r.atlas !== null), rows.map(r => r.atlas));
      check('webgl: glyph atlas redrawn for each family', new Set(rows.map(r => r.atlas)).size === 3, rows.map(r => r.atlas));
    }
    term.dispose();
    host.remove();
  }
  return { checks, measurements };
}
