// Headless check of the install gate in forge.config.ts's postPackage (S67).
// Runs the REAL postPackage (forge.config.ts transpiled with the repo's own
// TypeScript) with every side effect stubbed: child_process is a recorder and
// the install helper is a recorder, so nothing here can touch /Applications,
// codesign, ditto or the Dock. It asserts the PATTON_NO_INSTALL=1 gate:
//   - set to "1": no ditto and no pruneAndVerify
//   - unset: ditto runs, pruneAndVerify gets (<out>/Patton.app, '/Applications/Patton.app')
// Run: node scripts/check-install-gate.mjs   (no extra dependencies)
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require(join(root, 'node_modules/typescript'));

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

// Trap: if anything reached the REAL child_process, it would land here (and fail the check) instead of running.
const realCp = require('node:child_process');
const realLeaks = [];
for (const fn of ['execSync', 'exec', 'execFileSync', 'execFile', 'spawn', 'spawnSync']) {
  realCp[fn] = (...a) => { realLeaks.push(`${fn}: ${String(a[0]).slice(0, 80)}`); throw new Error(`real child_process.${fn} reached`); };
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'patton-install-gate-'));
const FAKE_OUT = join(SCRATCH, 'out');
mkdirSync(join(FAKE_OUT, 'Patton.app'), { recursive: true });
const FAKE_APP = join(FAKE_OUT, 'Patton.app');

/** Load forge.config.ts with child_process and the install helper replaced by recorders. */
function loadConfig(events) {
  const src = readFileSync(join(root, 'forge.config.ts'), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const stubClass = class { constructor(...a) { this.args = a; } };
  const anyProxy = new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : 1) });
  const fakeRequire = (id) => {
    if (id.startsWith('@electron-forge/')) return new Proxy({}, { get: () => stubClass });
    if (id === '@electron/fuses') return { FuseV1Options: anyProxy, FuseVersion: { V1: 1 } };
    if (id === 'node:child_process') {
      return { execSync: (cmd) => { events.push({ execSync: String(cmd) }); return ''; } };
    }
    if (id === './scripts/install-prune.cjs') {
      return { pruneAndVerify: (...a) => { events.push({ pruneAndVerify: a }); } };
    }
    if (id === 'node:path' || id === 'node:fs') return require(id);
    throw new Error(`forge.config.ts requires an unstubbed module: ${id}`);
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', js)(fakeRequire, mod, mod.exports, root);
  return mod.exports.default || mod.exports;
}

/** Run postPackage as on a Mac with PATTON_NO_INSTALL set to `value` (undefined = unset). */
async function runHook(value) {
  const events = [];
  const config = loadConfig(events);
  const savedEnv = process.env.PATTON_NO_INSTALL;
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const savedLog = console.log;
  if (value === undefined) delete process.env.PATTON_NO_INSTALL; else process.env.PATTON_NO_INSTALL = value;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  console.log = () => {};
  try {
    await config.hooks.postPackage({}, { outputPaths: [FAKE_OUT] });
  } finally {
    console.log = savedLog;
    Object.defineProperty(process, 'platform', savedPlatform);
    if (savedEnv === undefined) delete process.env.PATTON_NO_INSTALL; else process.env.PATTON_NO_INSTALL = savedEnv;
  }
  return events;
}
const dittos = (ev) => ev.filter((e) => e.execSync && /^ditto /.test(e.execSync));
const prunes = (ev) => ev.filter((e) => e.pruneAndVerify);

const gated = await runHook('1');
check('PATTON_NO_INSTALL=1: the build still signs (stubbed execSync ran)', gated.some((e) => e.execSync && /codesign/.test(e.execSync)), gated.length);
check('PATTON_NO_INSTALL=1: no ditto', dittos(gated).length === 0, dittos(gated));
check('PATTON_NO_INSTALL=1: no pruneAndVerify', prunes(gated).length === 0, prunes(gated));

const open = await runHook(undefined);
check('unset: ditto runs from the built app to /Applications/Patton.app',
  dittos(open).length === 1 && dittos(open)[0].execSync === `ditto "${FAKE_APP}" "/Applications/Patton.app"`, dittos(open));
check("unset: pruneAndVerify gets (<out app>, '/Applications/Patton.app') and nothing else",
  prunes(open).length === 1 && JSON.stringify(prunes(open)[0].pruneAndVerify) === JSON.stringify([FAKE_APP, '/Applications/Patton.app']), prunes(open));
check('unset: pruneAndVerify comes after the ditto',
  open.findIndex((e) => e.pruneAndVerify) > open.findIndex((e) => e.execSync && /^ditto /.test(e.execSync)), open.map((e) => Object.keys(e)[0]));

// Any value but exactly "1" installs (the gate says "exactly 1").
const zero = await runHook('0');
check('PATTON_NO_INSTALL=0: installs (only exactly "1" gates)', dittos(zero).length === 1 && prunes(zero).length === 1, { d: dittos(zero).length, p: prunes(zero).length });

// The stubs mean nothing real ran: the real child_process (trapped above) was never called.
check('nothing reached the real child_process (no real ditto, codesign or lsregister)', realLeaks.length === 0, realLeaks);

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
