// Check of Interface Text Size in the main-process settings store (src/main/store.ts).
// Run: node scripts/check-ui-text-scale-store.mjs
// Bundles the REAL store module with esbuild (electron, electron-store and node-pty
// stubbed; the store is a Map in memory) and drives setSettings/getSettings:
// the five allowed values are kept; anything else is refused and the saved
// value stays; an old settings file without the field reads back as 1 through
// the one reader the renderer and main share (uiTextScaleOf).
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'ui-scale-store-'));
const stubs = [
  [/^electron$/, 'module.exports = { app: { getPath: () => "/nonexistent" }, safeStorage: { isEncryptionAvailable: () => false } };'],
  [/^node-pty$/, 'module.exports = { spawn: () => { throw new Error("no pty in checks"); } };'],
  [/^electron-store$/, 'class S { constructor(o) { this.m = new Map(Object.entries(JSON.parse(JSON.stringify(o.defaults)))); globalThis.__store = this.m; } get(k, d) { return this.m.has(k) ? this.m.get(k) : d; } set(k, v) { this.m.set(k, v); } get store() { return Object.fromEntries(this.m); } }\nmodule.exports = S; module.exports.default = S;'],
];
const out = join(work, 'store.cjs');
try {
  await build({
    entryPoints: [join(repo, 'src/main/store.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent',
    plugins: [{
      name: 'stubs',
      setup(b) {
        for (const [re] of stubs) {
          b.onResolve({ filter: re }, (a) => ({ path: a.path, namespace: 'stub' }));
        }
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs.find(([re]) => re.test(a.path))[1], loader: 'js' }));
      },
    }],
  });
  const store = createRequire(import.meta.url)(out);
  const readerOut = join(work, 'reader.cjs');
  await build({
    entryPoints: [join(repo, 'src/shared/constants.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: readerOut, logLevel: 'silent',
  });
  const { uiTextScaleOf, uiTextScaleFromArgv, UI_TEXT_SCALE_ARG } = createRequire(import.meta.url)(readerOut);

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail) => {
    if (ok) { passed++; console.log('ok  ', name); } else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
  };
  const read = () => store.getSettings().uiTextScale;

  check('a fresh store starts at 1', read() === 1, read());
  for (const v of [0.9, 1, 1.1, 1.25, 1.5]) {
    store.setSettings({ uiTextScale: v });
    check(`allowed ${v} is kept`, read() === v, read());
  }
  store.setSettings({ uiTextScale: 1.25 });
  for (const [label, v] of [['2', 2], ['"1.5" (a string)', '1.5'], ['-1', -1], ['NaN', NaN], ['Infinity', Infinity], ['0', 0], ['1.2', 1.2], ['null', null], ['an object', {}], ['true', true]]) {
    store.setSettings({ uiTextScale: v });
    check(`refused ${label}: the saved 1.25 stays`, read() === 1.25, read());
  }
  store.setSettings({ fontSize: 16 });
  check('saving another setting leaves it alone', read() === 1.25 && store.getSettings().fontSize === 16, store.getSettings());

  // An old settings file has no field at all.
  const saved = globalThis.__store.get('settings');
  delete saved.uiTextScale;
  globalThis.__store.set('settings', saved);
  check('an old file without the field has none stored', read() === undefined, read());
  check('refused value on an old file leaves it absent', (store.setSettings({ uiTextScale: 3 }), read() === undefined), read());
  for (const v of [undefined, null, 2, '1.5', -1, NaN, 0, {}]) {
    check(`uiTextScaleOf(${typeof v === 'object' ? JSON.stringify(v) : String(v)}) is 1`, uiTextScaleOf(v) === 1, uiTextScaleOf(v));
  }
  for (const v of [0.9, 1, 1.1, 1.25, 1.5]) check(`uiTextScaleOf(${v}) is ${v}`, uiTextScaleOf(v) === v);
  // The switch main hands the preload (finding: first paint at size).
  const argv = (v) => ['/x/Patton', '--foo', ...(v === undefined ? [] : [UI_TEXT_SCALE_ARG + v])];
  for (const v of [0.9, 1, 1.1, 1.25, 1.5]) check(`argv carrying ${v} reads ${v}`, uiTextScaleFromArgv(argv(v)) === v, uiTextScaleFromArgv(argv(v)));
  for (const v of [undefined, '', 'abc', '2', '1.2', '-1', 'NaN']) {
    check(`argv with ${v === undefined ? 'no switch' : `"${v}"`} reads 1`, uiTextScaleFromArgv(argv(v)) === 1, uiTextScaleFromArgv(argv(v)));
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(work, { recursive: true, force: true });
}
