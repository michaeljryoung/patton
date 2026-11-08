// Check of PTY respawn (board-in-place): the project board opens a project in
// the board's own tab by replacing that pane's shell. Bundles the REAL
// PtyManager (src/main/pty-manager.ts) with esbuild; only electron, node-pty and
// resources-path are stubbed (node-pty with fake shells that record how they
// were started and count kill()). The IPC handler (ipc-handlers.ts) is checked
// against its source: it pulls in the whole main process, so it is not bundled.
// Run: node scripts/check-pty-respawn.mjs   (no extra dependencies)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const stubs = [
  [/^electron$/, 'module.exports = { BrowserWindow: class {}, nativeTheme: { shouldUseDarkColors: false } };'],
  [/^node-pty$/, `const fakes = globalThis.__fakes;
    module.exports = { spawn: (shell, args, o) => { if (globalThis.__failSpawn) throw new Error('spawn failed');
      const p = { shell, args, cwd: o.cwd, env: o.env, kills: 0, exitCb: null,
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
const work = mkdtempSync(join(tmpdir(), 'pty-respawn-'));
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
  const makeWindow = (id) => ({
    id,
    isDestroyed: () => false,
    webContents: { send: (...a) => sent.push([id, ...a]) },
  });
  const manager = new PtyManager();
  const fakes = globalThis.__fakes;
  const A = makeWindow(1);
  const B = makeWindow(2);
  const project = join(work, 'project');
  mkdirSync(project);

  const a1 = manager.create(A, {});
  const b1 = manager.create(B, {});
  const [fa1, fb1] = fakes;

  // --- a valid respawn ---
  const a2 = manager.respawn(A, a1, { cwd: project, projectDir: true, hyperlinks: true, cols: 100, rows: 30 });
  const fa2 = fakes[2];
  check('respawn: returns a new id', typeof a2 === 'number' && a2 !== a1);
  check('respawn: the new shell starts in the validated folder', fa2.cwd === project, fa2.cwd);
  check('respawn: PATTON_PROJECT_DIR exported from the validated cwd', fa2.env.PATTON_PROJECT_DIR === project, fa2.env.PATTON_PROJECT_DIR);
  check('respawn: FORCE_HYPERLINK=1 when asked', fa2.env.FORCE_HYPERLINK === '1');
  check('respawn: the old shell is killed exactly once', fa1.kills === 1, fa1.kills);
  check('respawn: the new shell is alive, the window still has one shell of its own', fakes[2].kills === 0 && manager.liveCountForWindow(A) === 1 && manager.size === 2);
  check('respawn: the old id is gone, the new one owned by the window', !manager.validateOwnership(a1, A) && manager.validateOwnership(a2, A));
  fa1.exitCb?.({ exitCode: 0 });
  check('respawn: the old shell\'s exit reaches the renderer as nothing (no PTY exit event)', !sent.some((m) => m[1] === 'pty:exit'), sent);
  check('respawn: the window\'s PTY count stays right (one slot, not two)', (() => { for (let i = 0; i < 49; i++) manager.create(A, {}); try { manager.create(A, {}); return false; } catch { return true; } })());
  manager.destroyByWindowId(1);
  const a3 = manager.create(A, {});

  // --- an invalid cwd: the same fallback as a new tab, and no PATTON_PROJECT_DIR ---
  for (const bad of ['/etc', '/Users/someone/../../etc', join(work, 'nope'), 'relative/path', '']) {
    const before = fakes.length;
    const prev = manager.create(A, {});
    const id = manager.respawn(A, prev, { cwd: bad, projectDir: true });
    const f = fakes[fakes.length - 1];
    check(`invalid cwd ${JSON.stringify(bad)}: shell starts at home, PATTON_PROJECT_DIR not exported`, fakes.length === before + 2 && f.cwd !== bad && !('PATTON_PROJECT_DIR' in f.env), { cwd: f.cwd, env: f.env.PATTON_PROJECT_DIR });
    check(`invalid cwd ${JSON.stringify(bad)}: the old shell is still ended once`, fakes[fakes.length - 2].kills === 1);
    manager.destroy(id);
  }
  // projectDir is a literal true only
  manager.respawn(A, a3, { cwd: project, projectDir: 'yes' });
  check('projectDir other than literal true: not exported', !('PATTON_PROJECT_DIR' in fakes[fakes.length - 1].env));

  // --- another window's PTY is refused, untouched ---
  const before = fakes.length;
  let refused = false;
  try { manager.respawn(A, b1, { cwd: project }); } catch { refused = true; }
  check('another window\'s PTY: refused', refused);
  check('another window\'s PTY: nothing started, nothing killed', fakes.length === before && fb1.kills === 0 && manager.validateOwnership(b1, B));
  refused = false;
  try { manager.respawn(A, 99999, {}); } catch { refused = true; }
  check('an unknown PTY id: refused, nothing started', refused && fakes.length === before);

  // --- the new shell cannot start: the old one is kept ---
  const keep = manager.create(A, {});
  const fkeep = fakes[fakes.length - 1];
  globalThis.__failSpawn = true;
  let threw = false;
  try { manager.respawn(A, keep, { cwd: project }); } catch { threw = true; }
  globalThis.__failSpawn = false;
  check('spawn failure: respawn throws and the old shell is kept alive and owned', threw && fkeep.kills === 0 && manager.validateOwnership(keep, A));

  // --- the IPC handler, from its source ---
  const ipc = readFileSync(join(repo, 'src/main/ipc-handlers.ts'), 'utf8');
  const handler = ipc.slice(ipc.indexOf('ipcMain.handle(IPC.PTY_RESPAWN'));
  const body = handler.slice(0, handler.indexOf('\n  });') + 6);
  check('handler: registered for PTY_RESPAWN', ipc.includes('ipcMain.handle(IPC.PTY_RESPAWN'));
  check('handler: rate-limited, like its neighbours', /ptyRespawnLimiter = new RateLimiter\(\d+\)/.test(ipc) && /ptyRespawnLimiter\.allow\(\)/.test(body));
  check('handler: id and options type-checked', /typeof id !== 'number'/.test(body) && /typeof opts !== 'object'/.test(body));
  check('handler: acts for the sender\'s own window only, through PtyManager.respawn', /BrowserWindow\.fromWebContents\(event\.sender\)/.test(body) && /ptyManager\.respawn\(window, id, opts\)/.test(body));
  const pre = readFileSync(join(repo, 'src/preload/preload.ts'), 'utf8');
  check('preload: respawn goes over PTY_RESPAWN', /respawn: \(id, opts\) => ipcRenderer\.invoke\(IPC\.PTY_RESPAWN, id, opts\)/.test(pre));
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
