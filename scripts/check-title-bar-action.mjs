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
for (const platform of ['win32', 'linux']) {
  for (const pref of ['Minimize', 'None', undefined, 'Maximize']) {
    check(`${platform}, ${JSON.stringify(pref)} -> zoom`, titleBarActionFor(pref, platform), 'zoom');
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
