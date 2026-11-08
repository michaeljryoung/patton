// Check of the REAL PtyManager window cleanup (src/main/pty-manager.ts), the
// part main's 'closed' safety net relies on (S46): destroyByWindowId(id) ends
// every shell of a window whose BrowserWindow object is already destroyed.
// Bundles the real module with esbuild; only electron, node-pty and
// resources-path are stubbed (node-pty with fake shells that count kill()).
// Run: node scripts/check-pty-window-cleanup.mjs   (no extra dependencies)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const stubs = [
  [/^electron$/, 'module.exports = { BrowserWindow: class {}, nativeTheme: { shouldUseDarkColors: false } };'],
  [/^node-pty$/, `const fakes = globalThis.__fakes;
    module.exports = { spawn: () => { const p = { kills: 0, exitCb: null,
      kill() { p.kills++; }, write() {}, resize() {},
      onData() {}, onExit(cb) { p.exitCb = cb; } }; fakes.push(p); return p; } };`],
  [/^\.\/resources-path$/, 'module.exports = { getResourcesPath: () => "/nonexistent" };'],
];

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

globalThis.__fakes = [];
const work = mkdtempSync(join(tmpdir(), 'pty-cleanup-'));
try {
  const out = join(work, 'pty-manager.cjs');
  await build({
    entryPoints: [join(repo, 'src/main/pty-manager.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        for (const [filter] of stubs) b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
          for (const [filter, contents] of stubs) if (filter.test(a.path)) return { contents, loader: 'js', resolveDir: work };
          return null;
        });
      },
    }],
  });
  const { PtyManager } = createRequire(import.meta.url)(out);

  const sent = [];
  /** A window whose every property throws once destroyed, like Electron's. */
  const makeWindow = (id) => {
    const w = {
      id, destroyed: false,
      isDestroyed() { return w.destroyed; },
      webContents: { send: (...a) => { if (w.destroyed) throw new Error('Object has been destroyed'); sent.push([id, ...a]); } },
    };
    return w;
  };
  const manager = new PtyManager();
  const fakes = globalThis.__fakes;
  const A = makeWindow(1);
  const B = makeWindow(2);
  const a1 = manager.create(A, {});
  const a2 = manager.create(A, {});
  const a3 = manager.create(A, {});
  const b1 = manager.create(B, {});
  const [fa1, fa2, fa3, fb1] = fakes;
  check('setup: four live shells, three in window 1', manager.size === 4 && manager.liveCountForWindow(A) === 3 && manager.liveCountForWindow(B) === 1);

  // 'closed' fires after the window object is destroyed: only the id is usable.
  A.destroyed = true;
  const ended = manager.destroyByWindowId(1);
  check('destroyed window: returns how many shells were alive', ended === 3, ended);
  check('destroyed window: one kill per shell', fa1.kills === 1 && fa2.kills === 1 && fa3.kills === 1, fakes.map((f) => f.kills));
  check('other window untouched: its shell is alive and not killed', fb1.kills === 0 && manager.size === 1 && manager.liveCountForWindow(B) === 1, { kills: fb1.kills, size: manager.size });
  check('destroyed window: its shells are gone from the manager', !manager.validateOwnership(a1, A) && !manager.validateOwnership(a2, A) && !manager.validateOwnership(a3, A));
  check('other window: ownership still valid', manager.validateOwnership(b1, B));

  // A late onExit from a killed shell must not double-count or throw.
  let threw = false;
  try { fa1.exitCb({ exitCode: 0 }); } catch { threw = true; }
  check('late exit of a destroyed shell is ignored', !threw && fa1.kills === 1 && manager.size === 1);

  // Idempotent, in both spellings.
  check('second destroyByWindowId finds nothing', manager.destroyByWindowId(1) === 0);
  let threw2 = false;
  try { manager.destroyByWindow(A); } catch { threw2 = true; }
  check('destroyByWindow after destroyByWindowId: no throw, no second kill', !threw2 && fakes.slice(0, 3).every((f) => f.kills === 1) && manager.size === 1);

  // The other order: destroyByWindow first (window still alive), then by id.
  const C = makeWindow(3);
  manager.create(C, {});
  manager.create(C, {});
  const [fc1, fc2] = fakes.slice(4);
  manager.destroyByWindow(C);
  check('destroyByWindow ends every shell once', fc1.kills === 1 && fc2.kills === 1 && manager.liveCountForWindow(C) === 0);
  C.destroyed = true;
  check('then destroyByWindowId on the destroyed window: 0 and no extra kill', manager.destroyByWindowId(3) === 0 && fc1.kills === 1 && fc2.kills === 1);

  // The window's counter is reset, so a new window with a reused id starts clean.
  const D = makeWindow(1);
  let created = true;
  try { manager.create(D, {}); } catch { created = false; }
  check('a window id reused after cleanup can open shells again', created && manager.liveCountForWindow(D) === 1);

  // Unknown ids and the survivor are fine.
  check('unknown window id: 0, nothing else touched', manager.destroyByWindowId(99) === 0 && fb1.kills === 0);
  manager.destroyByWindowId(2);
  check('window 2 cleaned by id once its turn comes', fb1.kills === 1);
  manager.destroyAll();
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\n${passed} checks passed`);
process.exit(failed ? 1 : 0);
