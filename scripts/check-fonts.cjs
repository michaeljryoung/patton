// Hidden-Electron check of Patton's font handling: SF Mono read from the
// Mac's Terminal.app (src/main/system-fonts.ts), registered in document.fonts
// (src/renderer/services/system-fonts.ts), the Settings availability detector
// (src/renderer/services/font-choices.ts), and a live xterm Terminal re-measuring
// on a fontFamily change with the DOM renderer and with WebGL.
//
// Run: node scripts/check-fonts.cjs
//   FONT_CHECK_DIR=<folder>   where the bundles, userData and result go (default: a new temp folder)
//   FONT_CHECK_EXPECT=a,b,... families expected to draw after registration
//                             (default: what Michael's Mac has, see EXPECT_DEFAULT)
// The same file runs twice: under Node it bundles the real sources with esbuild
// and starts Electron on itself; under Electron it opens one window that is
// never shown (show:false, dock hidden), runs the checks and exits.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXPECT_DEFAULT = ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'PT Mono', 'Andale Mono', 'Courier New'];
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
        import { registerSystemFonts } from './src/renderer/services/system-fonts';
        import { FONT_CHOICES, buildFontOptions, fontDraws } from './src/renderer/services/font-choices';
        import { Terminal } from '@xterm/xterm';
        import { WebglAddon } from '@xterm/addon-webgl';
        (window as any).__fc = { registerSystemFonts, FONT_CHOICES, buildFontOptions, fontDraws, Terminal, WebglAddon };
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
  const log = fs.openSync(path.join(outDir, 'electron.log'), 'w');
  const env = { ...process.env, FONT_CHECK_DIR: outDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [__filename], { env, stdio: ['ignore', log, log] });
  const killer = setTimeout(() => child.kill('SIGKILL'), HARD_TIMEOUT_MS + 5000);
  await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(killer);

  if (!fs.existsSync(resultFile)) {
    console.error(`no result; see ${path.join(outDir, 'electron.log')}`);
    process.exit(2);
  }
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
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
  setTimeout(() => { write({ error: 'timeout' }); app.exit(1); }, HARD_TIMEOUT_MS);

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

      // --- renderer
      const w = new BrowserWindow({ show: false, width: 900, height: 500, webPreferences: { backgroundThrottling: false } });
      await w.loadFile(path.join(outDir, 'page.html'));
      const payload = {
        families: sf ? [{ family: sf.family, dir: sf.dir, faces: sf.faces.map(f => ({ weight: f.weight, style: f.style, b64: Buffer.from(f.data).toString('base64') })) }] : [],
        expect: (process.env.FONT_CHECK_EXPECT ? process.env.FONT_CHECK_EXPECT.split(',') : EXPECT_DEFAULT).map(s => s.trim()),
        legacy: LEGACY_VALUES,
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

  // --- registration
  check('before registration, SF Mono does not draw', !fc.fontDraws('SF Mono'));
  check('detector: Menlo draws (sanity)', fc.fontDraws('Menlo'));
  check('detector: a made-up family does not draw', !fc.fontDraws('Patton No Such Font'));
  const families = payload.families.map(f => ({
    family: f.family, dir: f.dir,
    faces: f.faces.map(x => ({ weight: x.weight, style: x.style, data: Uint8Array.from(atob(x.b64), ch => ch.charCodeAt(0)) })),
  }));
  const added = await fc.registerSystemFonts(families);
  const sfFaces = Array.from(document.fonts).filter(f => f.family.replace(/["']/g, '') === 'SF Mono');
  check('registerSystemFonts adds 4 loaded SF Mono faces', added === 4 && sfFaces.length === 4 && sfFaces.every(f => f.status === 'loaded'),
    { added, faces: sfFaces.map(f => `${f.weight}/${f.style}/${f.status}`) });
  check('after registration, SF Mono draws', fc.fontDraws('SF Mono'));

  // --- availability detector
  const drawn = fc.FONT_CHOICES.filter(c => fc.fontDraws(c.family)).map(c => c.family).sort();
  const expected = payload.expect.slice().sort();
  check('detector returns the expected set on this Mac', drawn.join() === expected.join(), { drawn, expected });

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
