// Check of the session feed's IPC (src/main/session-feed-ipc.ts): a window may
// watch only its own PTYs, bad ids are refused, events go to the owning
// window alone, and a pty's exit stops its watch. Bundles the real module with
// esbuild; Electron is stubbed (ipcMain records handlers), the PtyManager is a
// fake with the four methods the module uses.
// Run: node scripts/check-session-feed-ipc.mjs   (no extra dependencies)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)); }
};

globalThis.__handlers = {};
const work = mkdtempSync(join(tmpdir(), 'session-feed-ipc-'));
const home = mkdtempSync(join(tmpdir(), 'session-feed-ipc-home-'));
const realHome = process.env.HOME;
process.env.HOME = home; // no sessions here: watches stay unresolved
let feed = null;
try {
  const out = join(work, 'ipc.cjs');
  await build({
    entryPoints: [join(repo, 'src/main/session-feed-ipc.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `module.exports = {
            ipcMain: { handle: (ch, fn) => { globalThis.__handlers[ch] = fn; } },
            BrowserWindow: { fromWebContents: (wc) => wc.win ?? null },
          };`,
          loader: 'js',
        }));
      },
    }],
  });
  const { registerSessionFeedHandlers } = createRequire(import.meta.url)(out);
  const { SESSION_FEED_IPC } = { SESSION_FEED_IPC: { EVENT: 'session-feed:event', WATCH: 'session-feed:watch', UNWATCH: 'session-feed:unwatch' } };

  const mkWin = (name) => {
    const win = { name, sent: [], isDestroyed: () => false };
    win.webContents = { win, isDestroyed: () => false, send: (...a) => win.sent.push(a) };
    return win;
  };
  const winA = mkWin('A');
  const winB = mkWin('B');
  const owner = { 7: winA };
  const exitListeners = [];
  const ptyManager = {
    validateOwnership: (id, w) => owner[id] === w,
    getPid: (id) => (owner[id] ? process.pid : null),
    getWindow: (id) => owner[id] ?? null,
    addExitListener: (fn) => exitListeners.push(fn),
  };
  feed = registerSessionFeedHandlers(ptyManager);
  const watch = globalThis.__handlers[SESSION_FEED_IPC.WATCH];
  const unwatch = globalThis.__handlers[SESSION_FEED_IPC.UNWATCH];
  check('WATCH and UNWATCH are registered on the contract\'s channel names', typeof watch === 'function' && typeof unwatch === 'function');

  const from = (w) => ({ sender: w.webContents });
  check('another window\'s pty is refused', watch(from(winB), 7) === false && !feed.isWatching(7));
  check('a non-number id is refused', watch(from(winA), '7') === false && watch(from(winA), 7.5) === false && !feed.isWatching(7));
  check('the owner may watch its pty', watch(from(winA), 7, { transcriptPath: '/etc/passwd' }) === true && feed.isWatching(7));
  await new Promise((r) => setTimeout(r, 300));
  check('a hint outside ~/.claude/projects is refused, told only to the owner',
    winA.sent.some(([ch, id, ev]) => ch === 'session-feed:event' && id === 7 && ev.type === 'error' && ev.why === 'hint refused')
    && winB.sent.length === 0, { a: winA.sent, b: winB.sent });
  unwatch(from(winB), 7);
  check('another window cannot unwatch it', feed.isWatching(7));
  check('the pty manager is told to report exits', exitListeners.length === 1);
  exitListeners[0](7);
  check('a pty exit stops its watch', !feed.isWatching(7));
  watch(from(winA), 7);
  unwatch(from(winA), 7);
  check('the owner can unwatch', !feed.isWatching(7));
} finally {
  feed?.stopAll('test end');
  process.env.HOME = realHome;
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(`${passed} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
