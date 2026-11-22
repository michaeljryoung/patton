// Check of the session feed's failure paths (src/main/session-feed.ts,
// transcript-tail.ts, session-link.ts; docs/session-bar.md D8, D9), from the
// review of 22 Nov 2026: a tail that can't start leaves no dead attach (D);
// a replaced, shrunk or jumped transcript re-attaches with at most 2 MB read
// (E); an unresolved pane backs off its `ps` (F); a sessions file counts only
// for a Claude process (G); `ps` is /bin/ps, not the one on PATH (H).
// Bundles the real modules with esbuild (they import no Electron).
// Run: node scripts/check-session-feed-robust.mjs   (no extra dependencies; ~5 s)
//   SB_SRC_ROOT=<folder holding src/>  check another source tree (to prove the check bites)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendFileSync, chmodSync, mkdirSync, mkdtempSync, promises as fsp, realpathSync, renameSync, rmSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = process.env.SB_SRC_ROOT || repo;
let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), 'session-robust-'));
const home = realpathSync(mkdtempSync(join(tmpdir(), 'session-robust-home-')));
const realHome = process.env.HOME;
const realPath = process.env.PATH;
const realStat = fsp.stat;
const feeds = [];
try {
  const out = join(work, 'mods.cjs');
  await build({
    stdin: {
      contents: `export { SessionFeed } from './src/main/session-feed';
                 export { TranscriptTail, BACKLOG_BYTES } from './src/main/transcript-tail';
                 export * from './src/main/session-link';`,
      resolveDir: srcRoot, loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
  });
  const M = createRequire(import.meta.url)(out);
  const MB = 1024 * 1024;
  const line = (i, pad = 0) => JSON.stringify({ type: 'x', i, pad: 'p'.repeat(pad) }) + '\n';

  // ── E: the tail re-attaches, reading at most 2 MB ──
  {
    const f = join(work, 'tail.jsonl');
    writeFileSync(f, line(0));
    const texts = [];
    const resets = [];
    const errors = [];
    const tail = new M.TranscriptTail(f, {
      onText: (t) => texts.push(t), onError: (w) => errors.push(w), onReset: (w) => resets.push(w),
    });
    check('start() of a readable file resolves true', (await tail.start()) === true);
    texts.length = 0;
    // 5 MB at once: whole lines of ~1 KB.
    let big = '';
    for (let i = 1; big.length < 5 * MB; i++) big += line(i, 1000);
    appendFileSync(f, big);
    await tail.poll();
    const got = texts.join('');
    check('a 5 MB jump is read as at most 2 MB', got.length > 0 && got.length <= 2 * MB, got.length);
    check('and starts at a whole line', got.startsWith('{"type":"x"'), got.slice(0, 40));
    check('the jump calls onReset first (the parser drops its partial line)', resets.includes('transcript jumped'), resets);
    // Replaced: a new file renamed over the old one.
    texts.length = 0; resets.length = 0;
    writeFileSync(f + '.new', line(900) + line(901));
    renameSync(f + '.new', f);
    await tail.poll();
    check('a file replaced by rename is re-read from its start', texts.join('') === line(900) + line(901), texts);
    check('as a reset, "transcript replaced"', resets.includes('transcript replaced') && errors.includes('transcript replaced'), { resets, errors });
    // Shrunk in place.
    texts.length = 0; resets.length = 0;
    truncateSync(f, 0);
    appendFileSync(f, line(950));
    await tail.poll();
    check('a file shrunk in place is re-read (its last 2 MB)', texts.join('') === line(950) && resets.includes('transcript shrank'), { texts, resets });
    // Plain appends still arrive whole.
    texts.length = 0;
    appendFileSync(f, line(951));
    await tail.poll();
    check('an append after a reset arrives as itself', texts.join('') === line(951), texts);
    tail.stop();
    const missing = new M.TranscriptTail(join(work, 'nope.jsonl'), { onText: () => {}, onError: () => {} });
    check('start() of a missing file resolves false', (await missing.start()) === false);
    missing.stop();
  }

  // A Claude-like process table: the shell 100 → its child 200.
  const claudeDir = join(home, '.claude');
  const proj = join(claudeDir, 'projects', '-tmp-demo');
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  const S1 = '11111111-2222-4333-8444-555555555555';
  const t1 = join(proj, `${S1}.jsonl`);
  writeFileSync(t1, line(0));
  writeFileSync(join(claudeDir, 'sessions', '200.json'), JSON.stringify({ pid: 200, sessionId: S1, cwd: '/tmp/demo' }));
  process.env.HOME = home;

  // ── G: a sessions file counts only for a Claude process ──
  {
    const table = (claude) => async () => [{ pid: 100, ppid: 1, claude: false }, { pid: 200, ppid: 100, claude }];
    const yes = await M.resolveSession(100, claudeDir, table(true));
    check('a sessions file for a Claude process resolves', yes?.sessionId === S1 && yes.claudePid === 200, yes);
    const no = await M.resolveSession(100, claudeDir, table(false));
    check('the same file for a pid running something else resolves nothing', no === null, no);
    const rows = M.parsePs('  100     1 -zsh\n  200   100 claude --effort xhigh\n  300   100 /bin/sleep 60\n  400   100 node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js\n  500   100 sh /x/claude abc\n  600   100 bash /private/tmp/claude-501/x.sh\n');
    check('ps rows name Claude: claude, npm\'s cli.js, a script named claude; not sleep, zsh or a script under claude-501',
      JSON.stringify(rows.map((r) => [r.pid, r.claude])) === JSON.stringify([[100, false], [200, true], [300, false], [400, true], [500, true], [600, false]]), rows);
  }

  // ── H: `ps` is /bin/ps, whatever PATH says ──
  {
    const bin = join(work, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\necho "    1     1 claude"\necho "$$ 1 claude"\n');
    chmodSync(join(bin, 'ps'), 0o755);
    process.env.PATH = `${bin}:${realPath}`;
    const rows = await M.listProcesses();
    process.env.PATH = realPath;
    check('listProcesses reads the real process table, not a ps on PATH', rows.length > 10 && rows.some((r) => r.pid === process.pid), rows.length);
    const me = rows.find((r) => r.pid === process.pid);
    check('this node process is not counted as Claude', me?.claude === false, me);
  }

  const mkFeed = (opts) => {
    const events = [];
    const logs = [];
    const feed = new M.SessionFeed({
      shellPid: () => 100,
      send: (pty, ev) => { events.push({ pty, ev, t: Date.now() }); return true; },
      log: (msg, data) => logs.push([msg, data]),
      ...opts,
    });
    feeds.push(feed);
    return { feed, events, logs };
  };

  // ── D: a tail that can't start leaves no dead attach ──
  {
    // stat() of the transcript fails only inside TranscriptTail.start: after
    // findTranscript has already found it.
    let failStart = true;
    fsp.stat = function (p, ...rest) {
      if (failStart && String(p) === t1 && /TranscriptTail\.start|start \(/.test(new Error().stack ?? '')) {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }
      return realStat.call(this, p, ...rest);
    };
    const ps = async () => [{ pid: 100, ppid: 1, claude: false }, { pid: 200, ppid: 100, claude: true }];
    const { feed, events } = mkFeed({ ps, resolveEveryMs: 200, resolveFastForMs: 60_000, checkEveryMs: 50 });
    feed.watch(1);
    await sleep(150);
    const att = events.filter((e) => e.ev.type === 'attached').length;
    const det = events.find((e) => e.ev.type === 'detached');
    check('the stat failure was hit (attached, then the tail failed)', att === 1, events.map((e) => e.ev));
    check('a tail that can\'t start is detached ("transcript unreadable")', det?.ev.reason === 'transcript unreadable', events.map((e) => e.ev));
    failStart = false;
    appendFileSync(t1, line(1));
    await sleep(600);
    check('the next resolve attaches again', events.filter((e) => e.ev.type === 'attached').length >= 2, events.map((e) => e.ev.type));
    fsp.stat = realStat;
    feed.stopAll('test end');
  }

  // ── F: an unresolved pane backs off its ps ──
  {
    let calls = 0;
    const ps = async () => { calls++; return []; };
    const { feed } = mkFeed({ ps, resolveEveryMs: 50, resolveFastForMs: 300, resolveSlowEveryMs: 1000, checkEveryMs: 10 });
    feed.watch(1);
    await sleep(320);
    const fast = calls;
    await sleep(900);
    const slow = calls - fast;
    check('fast retries for the first period (every 50 ms here)', fast >= 4 && fast <= 8, fast);
    check('then one retry per slow period (1 s here)', slow <= 1, slow);
    feed.watch(1); // the renderer's next 7501 report or Stop hint
    const before = calls;
    await sleep(320);
    check('a fresh watch() starts the fast retries again', calls - before >= 4, calls - before);
    feed.stopAll('test end');
  }
} finally {
  fsp.stat = realStat;
  for (const f of feeds) f.stopAll('test end');
  process.env.HOME = realHome;
  process.env.PATH = realPath;
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(`${passed} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
