// Check of how a pane asks main to follow its session
// (src/renderer/services/session-feed-watch.ts; docs/session-bar.md D8), from
// the review of 22 Nov 2026: a refused watch() is retried once after 2 s and
// logged `[BAR] watch refused` (I); a 7501 Claude report re-sends watch() at
// most once a minute while main hasn't attached (F). Fake clock and timers.
// Run: node scripts/check-session-feed-watch.mjs   (no extra dependencies)
//   SB_SRC_ROOT=<folder holding src/>  check another source tree (to prove the check bites)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = process.env.SB_SRC_ROOT || repo;
let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
};
const flush = () => new Promise((r) => setImmediate(r));

const entry = join(srcRoot, 'src/renderer/services/session-feed-watch.ts');
if (!existsSync(entry)) {
  check('src/renderer/services/session-feed-watch.ts exists', false);
  console.log(`${passed} ok, ${failed} failed`);
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), 'feed-watch-'));
try {
  const out = join(work, 'w.cjs');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
  const { SessionFeedWatch, WATCH_RETRY_MS, REWATCH_EVERY_MS } = createRequire(import.meta.url)(out);

  const mk = (answers) => {
    let now = 1_000_000;
    const timers = [];
    const calls = [];
    const logs = [];
    let current = 7;
    const w = new SessionFeedWatch({
      api: () => ({ watch: async (pty, hint) => { calls.push({ pty, hint, at: now }); return answers.length ? answers.shift() : true; } }),
      current: () => current,
      log: (level, msg, data) => logs.push({ level, msg, data }),
      now: () => now,
      setTimer: (fn, ms) => { const t = { fn, at: now + ms, done: false }; timers.push(t); return t; },
      clearTimer: (t) => { t.done = true; },
    });
    const advance = async (ms) => {
      now += ms;
      for (const t of timers) if (!t.done && t.at <= now) { t.done = true; t.fn(); }
      await flush();
    };
    return { w, calls, logs, advance, setCurrent: (p) => { current = p; } };
  };

  // ── I: a refused watch is retried once after 2 s ──
  {
    const { w, calls, logs, advance } = mk([false, false]);
    w.watch(7, '/x/s.jsonl');
    await flush();
    check('a refusal is logged `[BAR] watch refused`', logs.some((l) => l.msg === '[BAR] watch refused' && l.data.retry === true), logs);
    await advance(WATCH_RETRY_MS - 1);
    check('no retry before 2 s', calls.length === 1, calls.length);
    await advance(1);
    check('one retry at 2 s, with the same hint', calls.length === 2 && calls[1].hint?.transcriptPath === '/x/s.jsonl', calls);
    await advance(10_000);
    check('a second refusal is logged and not retried again', calls.length === 2 && logs.filter((l) => l.msg === '[BAR] watch refused').length === 2, { calls: calls.length, logs });
  }
  {
    const { w, calls, advance, setCurrent } = mk([false]);
    w.watch(7);
    await flush();
    setCurrent(null); // the pane stopped following
    await advance(WATCH_RETRY_MS);
    check('no retry once the pane follows nothing', calls.length === 1, calls.length);
  }
  {
    const { w, calls, advance } = mk([false]);
    w.watch(7);
    await flush();
    w.reset();
    await advance(WATCH_RETRY_MS);
    check('reset() cancels the pending retry', calls.length === 1, calls.length);
  }
  {
    const { w, calls, logs, advance } = mk([true]);
    w.watch(7);
    await advance(WATCH_RETRY_MS);
    check('an accepted watch is not retried and logs nothing', calls.length === 1 && logs.length === 0, { calls, logs });
  }

  // ── F: a 7501 Claude report re-watches, at most once a minute, while unattached ──
  {
    const { w, calls, advance } = mk([]);
    w.watch(7);
    await flush();
    w.claudeReport();
    check('a report within the minute sends nothing', calls.length === 1, calls.length);
    await advance(REWATCH_EVERY_MS);
    w.claudeReport();
    await flush();
    check('a report a minute later re-sends watch()', calls.length === 2 && calls[1].pty === 7 && calls[1].hint === undefined, calls);
    w.claudeReport();
    check('and not again straight after', calls.length === 2, calls.length);
    w.noteEvent({ type: 'attached', sessionId: 's', how: 'sessions-file' });
    await advance(5 * REWATCH_EVERY_MS);
    w.claudeReport();
    check('nothing while attached', calls.length === 2, calls.length);
    w.noteEvent({ type: 'detached', reason: 'claude exited' });
    w.claudeReport();
    await flush();
    check('a report after a detach re-sends watch()', calls.length === 3, calls.length);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`${passed} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
