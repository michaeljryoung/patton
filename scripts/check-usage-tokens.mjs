// Check of the usage panel's token count (24 Nov 2026, Michael: "Ideally, it's
// not just a percent, but a percent and a token count"; the raw count of all
// tokens, read from Claude Code's transcripts and credited to the login live
// at each request by accounts.json's `switches`).
// (a) one transcript line as a request (src/main/token-scan.ts requestFromLine);
// (b) the scanner on a temp projects tree: duplicates counted once (a repeat with
//     more tokens raises it), a partial last line left for the next scan, a
//     subagent's file, bad JSON and a user line that merely quotes the marks, a
//     file older than the floor, a request older than the floor, truncation and
//     replacement read from the start without double counting, the incremental
//     scan reading only new bytes, the floor moving later (prune) and earlier
//     (start over), a missing root;
// (c) crediting (src/shared/token-credit.ts): the last switch at or before each
//     request, nothing before the first switch, two logins with a switch mid-week,
//     window bounds, complete vs partial, the scan floor, the estimate rule;
// (d) the words (src/renderer/services/usage-format.ts): k / M / bn, the sub line
//     complete, without an estimate, partial, passed, for another week, the detail;
// (e) the real worker (bundled as Forge builds it, run with eval through
//     src/main/token-scan-host.ts): same totals as the scanner, state kept;
// (f) main's IPC module with the worker: counts joined into the push per login,
//     one "[USAGE] tokens" line per changed scan and none for an unchanged one,
//     a scan error logged once and the last counts kept, stop ends the worker;
// (g) wiring: Forge builds the worker beside main, the worker needs only Node.
// TOKEN_SCAN_PROBE=1 also scans this Mac's real ~/.claude/projects once,
// read-only, and prints the time and file count (no assertion).
// Run: node scripts/check-usage-tokens.mjs
import { build } from 'esbuild';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const section = async (name, fn) => {
  try { await fn(); } catch (err) { failed++; console.log(`FAIL ${name} threw`, String(err?.stack ?? err).split('\n').slice(0, 4).join(' | ')); }
};

const DAY = 86400;
const iso = (sec) => new Date(sec * 1000).toISOString();
/** One transcript line of a request. */
const asst = (msgId, reqId, sec, u = {}) => JSON.stringify({
  type: 'assistant', requestId: reqId, timestamp: iso(sec), sessionId: 's',
  message: { id: msgId, role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: u.i ?? 0, cache_creation_input_tokens: u.w ?? 0, cache_read_input_tokens: u.r ?? 0, output_tokens: u.o ?? 0, service_tier: 'standard' } },
});
const userQuoting = (sec) => JSON.stringify({ type: 'user', timestamp: iso(sec), message: { role: 'user', content: 'a line with "type":"assistant" and "usage" in it' } });
const setMtime = (path, sec) => utimesSync(path, sec, sec);

const tmp = mkdtempSync(join(tmpdir(), 'check-usage-tokens-'));
try {
  const nodeBundle = await build({
    stdin: {
      resolveDir: repo, loader: 'ts',
      contents: `export * from './src/shared/plan-usage';
                 export * from './src/shared/token-credit';
                 export * from './src/main/token-scan';
                 export * from './src/main/token-scan-host';
                 export * from './src/renderer/services/usage-format';`,
    },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  });
  writeFileSync(join(tmp, 'm.mjs'), nodeBundle.outputFiles[0].text);
  const M = await import(pathToFileURL(join(tmp, 'm.mjs')).href);

  // The worker as Forge builds it: one CommonJS file, Node built-ins external.
  const workerBundle = await build({
    entryPoints: [join(repo, 'src/main/token-scan-worker.ts')],
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  });
  const workerPath = join(tmp, 'token-scan-worker.cjs');
  writeFileSync(workerPath, workerBundle.outputFiles[0].text);

  const NOW = Math.floor(Date.now() / 1000);

  // ── (a) one line
  await section('line', async () => {
    const r = M.requestFromLine(asst('m1', 'r1', NOW - 60, { i: 3, w: 40, r: 500, o: 7 }));
    check('line: tokens are input + cache writes + cache reads + output', r?.n === 550, r);
    check('line: the time is the line\'s timestamp, in seconds', r?.t === NOW - 60, r?.t);
    check('line: keyed by message id and request id', typeof r?.key === 'string' && r.key.includes('m1') && r.key.includes('r1'));
    check('line: a user line is not a request', M.requestFromLine(userQuoting(NOW)) === null);
    check('line: bad JSON is not a request', M.requestFromLine('{"type":"assistant","usage":') === null);
    const noUsage = JSON.parse(asst('m1', 'r1', NOW)); delete noUsage.message.usage;
    check('line: no usage, no request', M.requestFromLine(JSON.stringify(noUsage)) === null);
    const noId = JSON.parse(asst('m1', 'r1', NOW)); delete noId.message.id;
    check('line: no message id, no request', M.requestFromLine(JSON.stringify(noId)) === null);
    const noTime = JSON.parse(asst('m1', 'r1', NOW)); noTime.timestamp = 'yesterday';
    check('line: no readable time, no request', M.requestFromLine(JSON.stringify(noTime)) === null);
    const odd = JSON.parse(asst('m1', 'r1', NOW, { i: 5 })); odd.message.usage.output_tokens = 'many'; odd.message.usage.cache_read_input_tokens = -4;
    check('line: a field that is not a positive number adds nothing', M.requestFromLine(JSON.stringify(odd))?.n === 5);
  });

  // ── (b) the scanner
  const root = join(tmp, 'projects');
  const projA = join(root, '-Users-x-projA');
  const projB = join(root, '-Users-x-projB');
  const s1 = join(projA, 's1.jsonl');
  const sub = join(projA, 's1', 'subagents', 'agent-1.jsonl');
  const old = join(projB, 'old.jsonl');
  const sumOf = (scanner) => { let s = 0; for (const r of scanner.requests()) s += r.n; return s; };
  const countOf = (scanner) => [...scanner.requests()].length;
  await section('scanner', async () => {
    mkdirSync(dirname(sub), { recursive: true });
    mkdirSync(projB, { recursive: true });
    const partial = asst('mC', 'rC', NOW - 50, { o: 1000 });
    writeFileSync(s1, [
      asst('mA', 'rA', NOW - 300, { i: 1, r: 99 }),         // 100
      asst('mA', 'rA', NOW - 299, { i: 1, r: 99 }),         // the same request again
      asst('mA', 'rA', NOW - 298, { i: 1, r: 99 }),
      userQuoting(NOW - 290),
      '{"type":"assistant","message":{"usage": {broken',
      asst('mB', 'rB', NOW - 200, { w: 20, o: 10 }),        // 30
      asst('mOld', 'rOld', NOW - 9 * DAY, { i: 7 }),        // before the floor
    ].join('\n') + '\n' + partial);                         // no newline yet
    writeFileSync(sub, asst('mD', 'rD', NOW - 100, { r: 5000 }) + '\n');
    writeFileSync(old, asst('mE', 'rE', NOW - 9 * DAY, { i: 70000 }) + '\n');
    setMtime(old, NOW - 9 * DAY);

    const sc = new M.TokenScanner();
    const floor = NOW - 8 * DAY;
    let st = await sc.scan(root, floor);
    check('scanner: a duplicate request counts once, the subagent file counts, bad and quoting lines and old ones do not', sumOf(sc) === 100 + 30 + 5000 && countOf(sc) === 3, { sum: sumOf(sc), n: countOf(sc) });
    check('scanner: a file not modified since the floor is not read', st.files === 2 && st.filesRead === 2, st);
    check('scanner: the partial last line is not taken yet', ![...sc.requests()].some((r) => r.n === 1000));

    // Incremental: finish the partial line and add one more; only the new bytes are read.
    const partialBytes = Buffer.byteLength(partial);
    const added = '\n' + asst('mF', 'rF', NOW - 40, { i: 2 }) + '\n';
    appendFileSync(s1, added);
    st = await sc.scan(root, floor);
    check('scanner: a second scan reads only the open line and what was appended', st.bytes === partialBytes + Buffer.byteLength(added) && st.filesRead === 1, { bytes: st.bytes, want: partialBytes + Buffer.byteLength(added), filesRead: st.filesRead });
    check('scanner: the finished line and the new one count', sumOf(sc) === 5130 + 1000 + 2, sumOf(sc));
    st = await sc.scan(root, floor);
    check('scanner: an unchanged tree reads nothing', st.bytes === 0 && st.filesRead === 0 && st.files === 2, st);

    // A repeat of a request with more tokens (a later write of the same message) raises it.
    appendFileSync(sub, asst('mD', 'rD', NOW - 99, { r: 5000, o: 25 }) + '\n');
    await sc.scan(root, floor);
    check('scanner: a repeat with more tokens raises the request to the larger figure, once', sumOf(sc) === 6132 + 25 && countOf(sc) === 5, { sum: sumOf(sc), n: countOf(sc) });
    appendFileSync(sub, asst('mD', 'rD', NOW - 98, { r: 10 }) + '\n');
    await sc.scan(root, floor);
    check('scanner: a repeat with fewer tokens leaves it', sumOf(sc) === 6157, sumOf(sc));

    // Truncated in place (same inode, smaller): read from the start, nothing counted twice.
    const inoBefore = statSync(s1).ino;
    writeFileSync(s1, asst('mA', 'rA', NOW - 300, { i: 1, r: 99 }) + '\n' + asst('mG', 'rG', NOW - 30, { o: 3 }) + '\n');
    check('scanner (setup): truncated in place keeps the inode', statSync(s1).ino === inoBefore);
    st = await sc.scan(root, floor);
    check('scanner: a truncated file is read from the start; its old requests are not counted again', sumOf(sc) === 6157 + 3 && st.bytes === statSync(s1).size, { sum: sumOf(sc), bytes: st.bytes });

    // Replaced by rename (new inode, larger): read from the start.
    const t = `${s1}.tmp`;
    writeFileSync(t, asst('mA', 'rA', NOW - 300, { i: 1, r: 99 }) + '\n' + asst('mG', 'rG', NOW - 30, { o: 3 }) + '\n' + asst('mH', 'rH', NOW - 20, { i: 4 }) + '\n' + 'x'.repeat(5000) + '\n');
    renameSync(t, s1);
    st = await sc.scan(root, floor);
    check('scanner: a file replaced by rename is read whole; only its new request counts', sumOf(sc) === 6160 + 4 && st.bytes === statSync(s1).size, { sum: sumOf(sc), bytes: st.bytes });

    // A truncation to a size still above the offset but with a new inode is the same case; one in place
    // that shrank to nothing and grew again past the old offset can't be told from an append (documented).

    // The floor moves later: earlier requests are dropped.
    await sc.scan(root, NOW - 150);
    check('scanner: a later floor drops requests before it', sumOf(sc) === 5025 + 1000 + 2 + 3 + 4 && [...sc.requests()].every((r) => r.t >= NOW - 150), sumOf(sc));
    // ... and back earlier: start over, so what was dropped counts again.
    st = await sc.scan(root, floor);
    // (Starting over counts what the files hold now: the requests the truncation and the replacement
    // removed (mB, mC, mF) are gone with them.)
    check('scanner: an earlier floor starts over and reads every file whole', sumOf(sc) === 100 + 3 + 4 + 5025 && st.bytes === statSync(s1).size + statSync(sub).size, { sum: sumOf(sc), bytes: st.bytes });

    // A deleted file's requests stay counted (they happened); its state is forgotten.
    rmSync(sub);
    st = await sc.scan(root, floor);
    check('scanner: a deleted transcript leaves its requests counted and is no longer listed', sumOf(sc) === 5132 && st.files === 1, { sum: sumOf(sc), files: st.files });

    const none = await new M.TokenScanner().scan(join(tmp, 'no-such-dir'), floor);
    check('scanner: a missing root is no files, not an error', none.files === 0 && none.requests === 0, none);

    // A very long line (a tool result) between requests: read across chunk joins, the requests around it count.
    const longFile = join(projA, 'long.jsonl');
    const big = JSON.stringify({ type: 'user', message: { content: 'y'.repeat(9 * 1024 * 1024) } });
    writeFileSync(longFile, asst('mL1', 'rL1', NOW - 10, { i: 11 }) + '\n' + big + '\n' + asst('mL2', 'rL2', NOW - 9, { i: 13 }) + '\n');
    const sc2 = new M.TokenScanner();
    await sc2.scan(root, floor);
    check('scanner: requests either side of a 9 MB line (over two read chunks) both count', [...sc2.requests()].filter((r) => r.n === 11 || r.n === 13).length === 2);
    rmSync(longFile);
  });

  // ── (c) crediting
  await section('credit', async () => {
    const T = 1_795_000_000;
    const sw = [[T, 'aaaa1111'], [T + 1000, 'bbbb2222'], [T + 2000, 'aaaa1111']];
    check('credit: the login live at a time is the last switch at or before it', M.liveAt(sw, T - 1) === null && M.liveAt(sw, T) === 'aaaa1111' && M.liveAt(sw, T + 999) === 'aaaa1111' && M.liveAt(sw, T + 1000) === 'bbbb2222' && M.liveAt(sw, T + 5000) === 'aaaa1111');
    const reqs = [
      { t: T - 10, n: 1 },       // before the first switch: no one
      { t: T + 10, n: 10 },      // A
      { t: T + 1000, n: 100 },   // B (at the switch)
      { t: T + 1500, n: 1000 },  // B
      { t: T + 2500, n: 10000 }, // A again
      { t: T + 9000, n: 100000 },// A, at its window's end: not this week
    ];
    const windows = [{ id: 'aaaa1111', start: T - 100, end: T + 9000 }, { id: 'bbbb2222', start: T + 1200, end: T + 50000 }, { id: 'cccc3333', start: T, end: T + 9000 }];
    const totals = M.creditTokens(reqs, sw, windows);
    check('credit: each request goes to the login live at its time, within that login\'s window', totals.get('aaaa1111') === 10010 && totals.get('bbbb2222') === 1000, Object.fromEntries(totals));
    check('credit: a login never live counts 0, and no login outside the windows appears', totals.get('cccc3333') === 0 && totals.size === 3);
    check('credit: no switches, nothing credited', M.creditTokens(reqs, [], windows).get('aaaa1111') === 0);
    const a = M.weekTokens(10010, windows[0], sw);
    check('credit: a week that began before the first switch is partial, from the first switch', a.complete === false && a.since === T && a.resetsAt === T + 9000, a);
    const b = M.weekTokens(1000, windows[1], sw);
    check('credit: a week that began after the first switch is complete', b.complete === true && b.since === null, b);
    const c = M.weekTokens(0, windows[2], sw);
    check('credit: a week that began at the first switch is complete', c.complete === true);
    check('credit: no switches is partial with no since', M.weekTokens(0, windows[2], []).complete === false && M.weekTokens(0, windows[2], []).since === null);
    const now = T + 3 * DAY;
    check('credit: the floor is the latest of 8 days back, the first switch and the earliest week start', M.scanFloor(sw, windows, now) === T && M.scanFloor(sw, [windows[1]], now) === T + 1200 && M.scanFloor([[T - 20 * DAY, 'x']], [{ id: 'x', start: T - 20 * DAY, end: T }], now) === now - 8 * DAY);
    check('credit: no switches or no windows, no floor (nothing to read)', M.scanFloor([], windows, now) === null && M.scanFloor(sw, [], now) === null);
    const full = { tokens: 2_912_345_678, complete: true, since: null, resetsAt: T };
    check('credit: the estimate is tokens ÷ percent × 100, to 2 significant figures', M.weekEstimate(full, 63, 63) === 4_600_000_000, M.weekEstimate(full, 63, 63));
    check('credit: no estimate under 5% shown, for a partial count, or for no tokens',
      M.weekEstimate(full, 4.4, 4) === null && M.weekEstimate({ ...full, complete: false, since: T }, 63, 63) === null && M.weekEstimate({ ...full, tokens: 0 }, 63, 63) === null);
    check('credit: an estimate from 5% shown (4.6 rounds to 5)', M.weekEstimate(full, 4.6, 5) !== null);
  });

  // ── (d) the words
  await section('format', async () => {
    const f = M.formatTokens;
    const cases = [[640, '640'], [412_345, '412k'], [999_499, '999k'], [999_500, '1M'], [412_345_678, '412M'], [999_499_999, '999M'], [999_500_000, '1.0 bn'], [2_912_345_678, '2.9 bn'], [12_340_000_000, '12.3 bn']];
    const bad = cases.filter(([n, want]) => f(n) !== want).map(([n, want]) => [n, want, f(n)]);
    check('format: k under 1M, M under 1 bn with no decimals, "N.N bn" from 1 bn', bad.length === 0, bad);
    check('format: the exact count has thousands separators', M.exactTokens(2_912_345_678) === '2,912,345,678', M.exactTokens(2_912_345_678));
    // 28 Nov 2026 12:00 local is a Saturday; 24 Nov 20:22 a Tuesday.
    const sat = new Date(2026, 10, 28, 12, 0).getTime() / 1000;
    const tue = new Date(2026, 10, 24, 20, 22).getTime() / 1000;
    const week = { pct: 63, resetsAt: sat, readAt: null, passed: false };
    const full = { tokens: 2_912_345_678, complete: true, since: null, resetsAt: sat };
    check('format: complete with an estimate', M.weekSubLine(week, full) === '2.9 bn of ~4.6 bn · resets Sat 12:00', M.weekSubLine(week, full));
    check('format: complete with no estimate (under 5%)', M.weekSubLine({ ...week, pct: 3 }, { ...full, tokens: 1_234_000_000 }) === '1.2 bn · resets Sat 12:00', M.weekSubLine({ ...week, pct: 3 }, { ...full, tokens: 1_234_000_000 }));
    const part = { tokens: 412_345_678, complete: false, since: tue, resetsAt: sat };
    check('format: partial', M.weekSubLine(week, part) === '≥ 412M since Tue 20:22 · resets Sat 12:00', M.weekSubLine(week, part));
    check('format: a passed week shows no tokens', M.weekSubLine({ ...week, pct: 0, passed: true }, full) === 'reset Sat 12:00');
    check('format: a count for another week shows nothing', M.weekSubLine(week, { ...full, resetsAt: sat - 7 * DAY }) === 'resets Sat 12:00');
    check('format: no count, the reset alone', M.weekSubLine(week, null) === 'resets Sat 12:00');
    check('format: a full week keeps "back" after the tokens', M.weekSubLine({ ...week, pct: 100 }, full) === '2.9 bn of ~2.9 bn · back Sat 12:00', M.weekSubLine({ ...week, pct: 100 }, full));
    const d = M.tokenDetail(full, 63);
    check('format: the detail gives the exact count and how it was counted', d.includes('2,912,345,678 tokens') && d.includes('since the week began') && d.includes('cached re-reads included') && d.includes('~4,600,000,000'), d);
    const dp = M.tokenDetail(part, 63);
    check('format: a partial detail says "at least" and since when', dp.startsWith('at least 412,345,678 tokens') && dp.includes('since Tue 20:22') && dp.includes('cached re-reads included'), dp);
  });

  // ── (e) the real worker through the host
  await section('worker', async () => {
    const floor = NOW - 8 * DAY;
    const sw = [[NOW - 7 * DAY, 'aaaa1111'], [NOW - 120, 'bbbb2222']];
    const windows = [{ id: 'aaaa1111', start: NOW - 6 * DAY, end: NOW + DAY }, { id: 'bbbb2222', start: NOW - 5 * DAY, end: NOW + 2 * DAY }];
    const direct = new M.TokenScanner();
    await direct.scan(root, floor);
    const want = M.creditTokens(direct.requests(), sw, windows);
    const host = new M.TokenScanHost(workerPath);
    try {
      const r1 = await host.scan({ root, floor, switches: sw, windows });
      check('worker: answers ok with the scanner\'s credited totals', r1.ok && JSON.stringify(r1.totals) === JSON.stringify([...want]), { r1, want: [...want] });
      check('worker: totals split across the switch (A before, B after)', want.get('aaaa1111') > 0 && want.get('bbbb2222') > 0, [...want]);
      const r2 = await host.scan({ root, floor, switches: sw, windows });
      check('worker: keeps its state, so a second scan reads nothing', r2.ok && r2.bytes === 0 && r2.filesRead === 0, r2);
      const r3 = await host.scan({ root: join(tmp, 'missing'), floor, switches: sw, windows });
      check('worker: a root that has gone answers ok with no files, and the requests already counted stay', r3.ok && r3.files === 0 && JSON.stringify(r3.totals) === JSON.stringify([...want]), r3);
    } finally {
      host.stop();
    }
    let refused = false;
    try { await host.scan({ root, floor, switches: sw, windows }); } catch (err) { refused = err?.code === 'STOPPED'; }
    check('worker: a stopped host refuses further scans', refused);
    const badHost = new M.TokenScanHost(join(tmp, 'no-worker.cjs'));
    let failedStart = false;
    try { await badHost.scan({ root, floor, switches: sw, windows }); } catch (err) { failedStart = err?.code === 'ENOENT'; }
    check('worker: a missing worker script rejects the scan with ENOENT', failedStart);
    badHost.stop();
  });

  // ── (f) main's IPC module with the worker
  await section('ipc', async () => {
    writeFileSync(join(tmp, 'electron-stub.mjs'), `
      const g = (globalThis.__electronStub ??= { handlers: new Map(), windows: [] });
      export const ipcMain = { handle: (ch, fn) => { g.handlers.set(ch, fn); } };
      export const BrowserWindow = { getAllWindows: () => g.windows };
    `);
    const ipcBundle = await build({
      stdin: { resolveDir: repo, loader: 'ts', contents: `export * from './src/main/plan-usage-ipc'; export { IPC } from './src/shared/constants';` },
      bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
      alias: { electron: join(tmp, 'electron-stub.mjs') },
    });
    writeFileSync(join(tmp, 'ipc.mjs'), ipcBundle.outputFiles[0].text);
    const stub = (globalThis.__electronStub ??= { handlers: new Map(), windows: [] });
    const sent = [];
    stub.windows = [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (ch, data) => sent.push({ ch, data }) } }];

    const logs = [];
    const realInfo = console.info, realWarn = console.warn;
    const realSI = globalThis.setInterval, realCI = globalThis.clearInterval;
    console.info = (...a) => logs.push(['info', ...a]);
    console.warn = (...a) => logs.push(['warn', ...a]);
    globalThis.setInterval = () => ({ unref() {} });
    globalThis.clearInterval = () => {};
    const envBefore = { f: process.env.PATTON_PLAN_USAGE_FILE, p: process.env.PATTON_CLAUDE_PROJECTS_DIR };
    const proot = join(tmp, 'ipc-projects');
    const file = join(tmp, 'ipc-accounts.json');
    let I = null;
    try {
      mkdirSync(join(proot, 'p'), { recursive: true });
      process.env.PATTON_PLAN_USAGE_FILE = file;
      process.env.PATTON_CLAUDE_PROJECTS_DIR = proot;
      const firstSwitch = NOW - 3 * DAY;
      const resetA = NOW + 2 * DAY;      // A's week began 5 days ago: before the first switch (partial)
      const resetB = NOW + 5 * DAY;      // B's week began 2 days ago: after it (complete)
      const accounts = {
        version: 1, updated: NOW, live: { account: 'bbbb2222', since: NOW - DAY },
        accounts: {
          aaaa1111: { email: 'a@example.com', last_live: NOW - DAY, seven_day: { used_percentage: 40, resets_at: resetA, read_at: NOW } },
          bbbb2222: { email: 'b@example.com', last_live: NOW, seven_day: { used_percentage: 50, resets_at: resetB, read_at: NOW } },
          cccc3333: { email: 'c@example.com', last_live: NOW - 9 * DAY, seven_day: { used_percentage: 10, resets_at: NOW - 60, read_at: NOW - 8 * DAY } },
        },
        switches: [[firstSwitch, 'aaaa1111'], [NOW - DAY, 'bbbb2222']],
      };
      writeFileSync(file, JSON.stringify(accounts));
      const tx = join(proot, 'p', 'x.jsonl');
      writeFileSync(tx, [
        asst('m0', 'r0', firstSwitch - 60, { i: 999 }),               // before the first switch: no one
        asst('m1', 'r1', NOW - 2 * DAY, { i: 2_000_000 }),             // A
        asst('m2', 'r2', NOW - 3600, { r: 300_000_000 }),              // B, after B's week began
        asst('m2', 'r2', NOW - 3599, { r: 300_000_000 }),              // the same request
      ].join('\n') + '\n');

      const mod = await import(pathToFileURL(join(tmp, 'ipc.mjs')).href);
      I = mod;
      I.setTokenWorkerScript(workerPath);
      I.registerPlanUsageHandlers();
      await I.pollPlanUsageOnce();
      await I.scanTokensOnce();
      const pushes = () => sent.filter((x) => x.ch === I.IPC.PLAN_USAGE_CHANGED);
      const tokenLogs = () => logs.filter((l) => l[1] === '[USAGE] tokens');
      const last = () => pushes().at(-1)?.data;
      const acct = (id) => last()?.accounts.find((a) => a.id === id);
      check('ipc: the push carries B\'s complete count (its week began after the first switch), deduped', acct('bbbb2222')?.weekTokens?.tokens === 300_000_000 && acct('bbbb2222').weekTokens.complete === true, acct('bbbb2222')?.weekTokens);
      check('ipc: ... and A\'s partial count since the first switch (the request before it uncredited)', acct('aaaa1111')?.weekTokens?.tokens === 2_000_000 && acct('aaaa1111').weekTokens.complete === false && acct('aaaa1111').weekTokens.since === firstSwitch, acct('aaaa1111')?.weekTokens);
      check('ipc: a passed week gets no count', acct('cccc3333')?.weekTokens === null);
      check('ipc: one "[USAGE] tokens" line, with totals in millions, files and ms', tokenLogs().length === 1 && tokenLogs()[0][2]?.totalsM?.bbbb2222 === 300 && tokenLogs()[0][2]?.files === 1 && typeof tokenLogs()[0][2]?.ms === 'number', tokenLogs());
      check('ipc: no "[USAGE] read" line for the token count alone (one for the first reading)', logs.filter((l) => l[1] === '[USAGE] read').length === 1);
      const get = stub.handlers.get(I.IPC.PLAN_USAGE_GET);
      const got = await get();
      check('ipc: the get answers the reading with its counts', got?.accounts.find((a) => a.id === 'bbbb2222')?.weekTokens?.tokens === 300_000_000);

      let marks = { pushes: pushes().length, logs: tokenLogs().length };
      await I.scanTokensOnce();
      check('ipc: an unchanged scan pushes nothing and logs nothing', pushes().length === marks.pushes && tokenLogs().length === marks.logs, [marks, pushes().length, tokenLogs().length]);

      appendFileSync(tx, asst('m3', 'r3', NOW - 5, { o: 1_000 }) + '\n');
      await I.scanTokensOnce();
      check('ipc: a new request is one push and one log line', pushes().length === marks.pushes + 1 && tokenLogs().length === marks.logs + 1 && acct('bbbb2222').weekTokens.tokens === 300_001_000, [pushes().length, tokenLogs().length, acct('bbbb2222')?.weekTokens]);

      // A scan error: logged once over two failing scans, and the last counts stay.
      if (process.getuid?.() !== 0) {
        chmodSync(proot, 0o000);
        marks = { pushes: pushes().length, logs: logs.length };
        await I.scanTokensOnce();
        await I.scanTokensOnce();
        chmodSync(proot, 0o755);
        const fails = logs.filter((l) => l[1] === '[USAGE] tokens scan failed');
        check('ipc: an unreadable transcripts folder is logged once over two scans, with its code', fails.length === 1 && fails[0][2]?.error === 'EACCES', fails);
        check('ipc: ... and the last counts stay (no push)', pushes().length === marks.pushes && acct('bbbb2222').weekTokens.tokens === 300_001_000);
        await I.scanTokensOnce();
        check('ipc: once readable again the count carries on unchanged (no push)', pushes().length === marks.pushes);
      } else console.log('skip ipc: unreadable folder (running as root)');

      // The file's switches change: the next poll scans at once (no minute's wait).
      accounts.switches.push([NOW - 10, 'aaaa1111']);
      accounts.updated = NOW + 1;
      writeFileSync(`${file}.tmp`, JSON.stringify(accounts));
      renameSync(`${file}.tmp`, file);
      await I.pollPlanUsageOnce();
      await I.scanTokensOnce(); // waits for the scan the poll started, then runs one more
      check('ipc: a change of switches re-credits (the last request now A\'s)', acct('aaaa1111')?.weekTokens?.tokens === 2_001_000 && acct('bbbb2222')?.weekTokens?.tokens === 300_000_000, [acct('aaaa1111')?.weekTokens, acct('bbbb2222')?.weekTokens]);

      I.stopPlanUsagePoll();
      marks = { pushes: pushes().length, logs: logs.length };
      appendFileSync(tx, asst('m4', 'r4', NOW - 4, { o: 7 }) + '\n');
      await I.scanTokensOnce();
      check('ipc: after stop no scan runs (no push, no log)', pushes().length === marks.pushes && logs.length === marks.logs);
    } finally {
      try { chmodSync(proot, 0o755); } catch { /* */ }
      I?.stopPlanUsagePoll?.();
      console.info = realInfo; console.warn = realWarn;
      globalThis.setInterval = realSI; globalThis.clearInterval = realCI;
      if (envBefore.f === undefined) delete process.env.PATTON_PLAN_USAGE_FILE; else process.env.PATTON_PLAN_USAGE_FILE = envBefore.f;
      if (envBefore.p === undefined) delete process.env.PATTON_CLAUDE_PROJECTS_DIR; else process.env.PATTON_CLAUDE_PROJECTS_DIR = envBefore.p;
    }
  });

  // ── (g) wiring
  await section('wiring', async () => {
    const forge = readFileSync(join(repo, 'forge.config.ts'), 'utf8');
    check('wiring: Forge builds the worker as a main-side entry', /entry: 'src\/main\/token-scan-worker\.ts',\s*config: 'vite\.main\.config\.ts',\s*target: 'main'/.test(forge));
    const ipc = readFileSync(join(repo, 'src/main/plan-usage-ipc.ts'), 'utf8');
    check('wiring: main loads it from beside its own bundle', ipc.includes("TOKEN_WORKER_FILE = 'token-scan-worker.cjs'") && ipc.includes('join(__dirname, TOKEN_WORKER_FILE)'));
    check('wiring: rescanned every 60 s', ipc.includes('TOKEN_SCAN_MS = 60 * 1000'));
    check('wiring: stop ends the worker', /stopPlanUsagePoll[\s\S]*?tokenHost\?\.stop\(\)/.test(ipc));
    const requires = [...workerBundle.outputFiles[0].text.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    check('wiring: the worker needs only Node built-ins (it runs by eval, with no node_modules)', requires.length > 0 && requires.every((r) => r.startsWith('node:') || ['fs', 'path', 'worker_threads'].includes(r)), requires);
  });

  if (process.env.TOKEN_SCAN_PROBE === '1') {
    const real = join(homedir(), '.claude', 'projects');
    const sc = new M.TokenScanner();
    const t0 = performance.now();
    const st = await sc.scan(real, NOW - 8 * DAY);
    const ms = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const st2 = await sc.scan(real, NOW - 8 * DAY);
    const ms2 = Math.round(performance.now() - t1);
    let total = 0; for (const r of sc.requests()) total += r.n;
    console.log('probe: real ~/.claude/projects, first scan', { ms, files: st.files, filesRead: st.filesRead, mb: Math.round(st.bytes / 1e6), requests: st.requests, skipped: st.skipped, tokensM: Math.round(total / 1e6), heapMb: Math.round(process.memoryUsage().heapUsed / 1e6) });
    console.log('probe: second (incremental) scan', { ms: ms2, filesRead: st2.filesRead, kb: Math.round(st2.bytes / 1e3) });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
