// Check of the pure mapping behind a double-click on the tab strip's empty
// space (src/main/title-bar-action.ts): the Mac's AppleActionOnDoubleClick
// setting -> zoom / minimize / none. Run: node scripts/check-title-bar-action.mjs
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  entryPoints: [join(repo, 'src/main/title-bar-action.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { titleBarActionFor } = mod;

let failed = 0;
let passed = 0;
const check = (name, got, want) => {
  if (got === want) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, JSON.stringify({ got, want })); }
};

for (const [pref, want] of [
  ['Minimize', 'minimize'], ['None', 'none'], ['Maximize', 'zoom'], ['Fill', 'zoom'],
  [undefined, 'zoom'], [null, 'zoom'], ['', 'zoom'], ['garbage', 'zoom'], ['minimize', 'zoom'], ['MINIMIZE', 'zoom'],
]) {
  check(`darwin, ${JSON.stringify(pref)} -> ${want}`, titleBarActionFor(pref, 'darwin'), want);
}
// Legacy boolean AppleMiniaturizeOnDoubleClick, consulted only when the string pref is missing/empty.
for (const [pref, legacy, want] of [
  [undefined, true, 'minimize'], [null, true, 'minimize'], ['', true, 'minimize'],
  [undefined, false, 'zoom'], [undefined, undefined, 'zoom'], [undefined, null, 'zoom'],
  ['Maximize', true, 'zoom'], ['None', true, 'none'], ['Minimize', false, 'minimize'], ['garbage', true, 'zoom'],
]) {
  check(`darwin, pref ${JSON.stringify(pref)}, legacy ${JSON.stringify(legacy)} -> ${want}`, titleBarActionFor(pref, 'darwin', legacy), want);
}
check('win32 ignores the legacy flag', titleBarActionFor(undefined, 'win32', true), 'zoom');
for (const platform of ['win32', 'linux']) {
  for (const pref of ['Minimize', 'None', undefined, 'Maximize']) {
    check(`${platform}, ${JSON.stringify(pref)} -> zoom`, titleBarActionFor(pref, platform), 'zoom');
  }
}

// Wiring of main's handler (source regex: calling a real maximize() would show a window).
import { readFileSync } from 'node:fs';
const src = readFileSync(join(repo, 'src/main/ipc-handlers.ts'), 'utf8');
const m = src.match(/ipcMain\.on\(IPC\.WINDOW_TITLE_BAR_DOUBLE_CLICK,[\s\S]*?\n {2}\}\);/);
const h = m ? m[0] : '';
const has = (name, re) => check(`handler wiring: ${name}`, re.test(h), true);
has('found', /WINDOW_TITLE_BAR_DOUBLE_CLICK/);
has('rate limited', /titleBarDoubleClickLimiter\.allow\(\)/);
has('acts on the sender\'s window only', /BrowserWindow\.fromWebContents\(event\.sender\)/);
check('handler wiring: never touches another window', !/getAllWindows|getFocusedWindow/.test(h), true);
has('destroyed guard', /!win \|\| win\.isDestroyed\(\)/);
has('full-screen guard returns early and logs', /win\.isFullScreen\(\)[\s\S]*?none \(full screen\)[\s\S]*?return;/);
has('reads AppleActionOnDoubleClick', /getUserDefault\('AppleActionOnDoubleClick', 'string'\)/);
has('reads AppleMiniaturizeOnDoubleClick', /getUserDefault\('AppleMiniaturizeOnDoubleClick', 'boolean'\)/);
has('passes both to titleBarActionFor', /titleBarActionFor\(pref, process\.platform, legacyMinimize\)/);
has('logs both values and the action', /\[WINDOW\] title-bar double-click', \{ pref, legacyMinimize, action \}/);
check('handler wiring: full-screen check comes before the zoom', h.indexOf('isFullScreen') > 0 && h.indexOf('isFullScreen') < h.indexOf('maximize()'), true);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
