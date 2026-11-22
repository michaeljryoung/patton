// Live check of the session bar's session link and feed (src/main/session-feed.ts,
// session-link.ts, transcript-tail.ts; docs/session-bar.md D8, D9) against a
// temporary HOME: a real shell (sh) whose child (sleep) plays Claude, a fake
// ~/.claude/sessions/<pid>.json naming that child, and a transcript that grows.
// Bundles the real modules with esbuild (they import no Electron).
// Run: node scripts/check-session-link.mjs   (no extra dependencies; ~10 s)
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), 'session-link-'));
const home = realpathSync(mkdtempSync(join(tmpdir(), 'session-home-')));
const children = [];
const realHome = process.env.HOME;
let feed = null;
try {
  const out = join(work, 'feed.cjs');
  await build({
    entryPoints: [join(repo, 'src/main/session-feed.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
  });
  // Count the intervals the feed and its tails hold, to prove stop clears them.
  const live = new Set();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (...args) => { const h = realSet(...args); live.add(h); return h; };
  globalThis.clearInterval = (h) => { live.delete(h); realClear(h); };
  const { SessionFeed } = createRequire(import.meta.url)(out);

  // A shell with a child: `sh` prints its child's pid, then waits on it.
  const shell = () => new Promise((resolve) => {
    const sh = spawn('/bin/sh', ['-c', 'sleep 60 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(sh);
    sh.stdout.once('data', (d) => resolve({ shellPid: sh.pid, childPid: Number(String(d).trim()) }));
  });
  const a = await shell();
  const b = await shell();

  const claude = join(home, '.claude');
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  const proj = join(claude, 'projects', '-tmp-demo');
  mkdirSync(proj, { recursive: true });
  const S1 = '11111111-2222-4333-8444-555555555555';
  const S2 = '66666666-7777-4888-8999-000000000000';
  const sessionsFile = join(claude, 'sessions', `${a.childPid}.json`);
  const writeSession = (id) => writeFileSync(sessionsFile, JSON.stringify({
    pid: a.childPid, sessionId: id, cwd: '/tmp/demo', startedAt: Date.now(), version: '2.1.321', kind: 'interactive', status: 'busy', updatedAt: Date.now(),
  }));
  writeSession(S1);
  const t1 = join(proj, `${S1}.jsonl`);
  const ts = () => new Date().toISOString();
  const line = (o) => JSON.stringify(o) + '\n';
  const toolUse = (id, cmd) => line({ parentUuid: 'p', isSidechain: false, type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd, description: `Run ${cmd}`, run_in_background: true } }] } });
  const bgResult = (id, task) => line({ parentUuid: 'p', isSidechain: false, type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `Command running in background with ID: ${task}. Output is being written to: /tmp/x` }] }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: task } });
  const notice = (task, status, summary) => line({ type: 'queue-operation', operation: 'enqueue', timestamp: ts(), sessionId: S1, content: `<task-notification>\n<task-id>${task}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` });
  // Backlog: one shell already running at attach.
  writeFileSync(t1, toolUse('toolu_0', 'old job') + bgResult('toolu_0', 'backlog01'));

  process.env.HOME = home; // the feed must read HOME, not the real one
  const events = [];
  const logs = [];
  const shellOf = { 1: a.shellPid, 2: b.shellPid, 3: b.shellPid };
  feed = new SessionFeed({
    shellPid: (pty) => shellOf[pty] ?? null,
    send: (pty, ev) => { events.push({ pty, ev, t: Date.now() }); return true; },
    log: (msg, data) => logs.push([msg, data]),
  });
  const waitFor = async (pred, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    return null;
  };

  check('watch of an unknown pty is refused', feed.watch(99) === false);
  check('watch of a live pty is accepted', feed.watch(1) === true);
  const att = await waitFor((e) => e.pty === 1 && e.ev.type === 'attached', 3000);
  check('attaches through the sessions file of the shell\'s child', att?.ev.how === 'sessions-file' && att.ev.sessionId === S1, att?.ev);
  check('the backlog\'s running shell is sent at attach',
    !!(await waitFor((e) => e.pty === 1 && e.ev.type === 'task-start' && e.ev.id === 'backlog01', 2000)));
  check('[BAR] attach is logged with pty and how, no content',
    logs.some(([m, d]) => m === '[BAR] attach' && d.pty === 1 && d.how === 'sessions-file' && Object.keys(d).length === 2), logs);

  await sleep(300);
  let t0 = Date.now();
  appendFileSync(t1, toolUse('toolu_1', 'npm test') + bgResult('toolu_1', 'live00001'));
  const start = await waitFor((e) => e.pty === 1 && e.ev.type === 'task-start' && e.ev.id === 'live00001', 3000);
  check('a background start appended is sent within 1 s', !!start && start.t - t0 <= 1000, start ? start.t - t0 : null);
  check('it carries kind, description and command', start?.ev.kind === 'shell' && start.ev.description === 'Run npm test' && start.ev.command === 'npm test', start?.ev);

  // A line written in two pieces: nothing until it is whole.
  const half = notice('live00001', 'failed', 'Background command "npm test" failed with exit code 3');
  appendFileSync(t1, half.slice(0, 40));
  await sleep(1300);
  check('half a line sends nothing', !events.some((e) => e.ev.type === 'task-end'));
  t0 = Date.now();
  appendFileSync(t1, half.slice(40));
  const end = await waitFor((e) => e.pty === 1 && e.ev.type === 'task-end' && e.ev.id === 'live00001', 3000);
  check('the task\'s end is sent within 1 s of its line completing', !!end && end.t - t0 <= 1000, end ? end.t - t0 : null);
  check('with its status and exit code', end?.ev.status === 'failed' && end.ev.exitCode === 3, end?.ev);

  // Hint (the Stop hook's tp) for a pane with no Claude under it.
  feed.watch(2, { transcriptPath: join(home, 'evil.jsonl') }.transcriptPath);
  writeFileSync(join(home, 'evil.jsonl'), '');
  await sleep(600);
  check('a hint outside ~/.claude/projects is refused', !events.some((e) => e.pty === 2 && e.ev.type === 'attached')
    && events.some((e) => e.pty === 2 && e.ev.type === 'error' && e.ev.why === 'hint refused'));
  writeFileSync(join(work, 'outside.jsonl'), '');
  symlinkSync(join(work, 'outside.jsonl'), join(proj, '99999999-0000-4000-8000-000000000000.jsonl'));
  feed.watch(3, join(proj, '99999999-0000-4000-8000-000000000000.jsonl'));
  await sleep(600);
  check('a hint symlinked out of ~/.claude/projects is refused', !events.some((e) => e.pty === 3 && e.ev.type === 'attached'));
  feed.watch(2, t1);
  const hinted = await waitFor((e) => e.pty === 2 && e.ev.type === 'attached', 2000);
  check('a hint inside ~/.claude/projects attaches when nothing else resolved', hinted?.ev.how === 'hook' && hinted.ev.sessionId === S1, hinted?.ev);

  // /clear: the sessions file names a new session.
  t0 = Date.now();
  writeSession(S2);
  const det = await waitFor((e) => e.pty === 1 && e.ev.type === 'detached', 3000);
  check('detaches when the sessions file\'s sessionId changes', det?.ev.reason === 'session changed' && det.t - t0 <= 1500, det ? [det.ev, det.t - t0] : null);
  check('[BAR] detach is logged', logs.some(([m, d]) => m === '[BAR] detach' && d.pty === 1 && d.reason === 'session changed'));
  const before = events.length;
  appendFileSync(t1, toolUse('toolu_2', 'late') + bgResult('toolu_2', 'late00001'));
  await sleep(1300);
  check('the old transcript is no longer followed for that pane',
    !events.slice(before).some((e) => e.pty === 1 && e.ev.type === 'task-start'));
  t0 = Date.now();
  writeFileSync(join(proj, `${S2}.jsonl`), '');
  const re = await waitFor((e) => e.pty === 1 && e.ev.type === 'attached' && e.ev.sessionId === S2, 3000);
  check('re-attaches to the new session within 2 s of its transcript appearing', re?.ev.how === 'sessions-file' && re.t - t0 <= 2000, re ? [re.ev, re.t - t0] : null);

  // Claude exits.
  process.kill(a.childPid, 'SIGTERM');
  const gone = await waitFor((e) => e.pty === 1 && e.ev.type === 'detached' && e.ev.reason === 'claude exited', 3000);
  check('detaches when the Claude process exits', !!gone);

  // UNWATCH stops everything.
  feed.unwatch(2, 'unwatch');
  check('unwatch detaches', events.some((e) => e.pty === 2 && e.ev.type === 'detached' && e.ev.reason === 'unwatch'));
  const after = events.length;
  appendFileSync(t1, toolUse('toolu_3', 'after') + bgResult('toolu_3', 'after0001'));
  await sleep(1300);
  check('nothing is sent after unwatch', !events.slice(after).some((e) => e.pty === 2), events.slice(after));
  feed.stopAll('test end');
  check('stopAll leaves no watch', !feed.isWatching(1) && !feed.isWatching(2) && !feed.isWatching(3));
  check('and no interval running', live.size === 0, live.size);
  check('no log line carries transcript text', !JSON.stringify(logs).includes('npm test'));
} finally {
  feed?.stopAll('test end');
  process.env.HOME = realHome;
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(`${passed} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
