// Check of the usage panel's token count (24 Nov 2026, Michael: "Ideally, it's
// not just a percent, but a percent and a token count"; the raw count of all
// tokens, read from Claude Code's transcripts and credited to the login live
// at each request by accounts.json's `switches`).
// (a) one transcript line as a request (src/main/token-scan.ts requestFromLine);
// (b) the scanner on a temp projects tree: duplicates counted once (a repeat with
//     more tokens raises it), a partial last line left for the next scan, a
//     subagent's file, bad JSON and a user line that merely quotes the marks, a
//     file older than the floor, a request older than the floor, truncation,
//     replacement and an in-place rewrite (its bytes before the offset changed)
//     read from the start without double counting, a replaced file with the
//     same 256 bytes before the offset, the incremental scan reading only new
//     bytes, the floor moving later (prune) and earlier (start over), a missing
//     root (listed 0), a request in two files (once, at its earliest time), a
//     line over the 32 MB cap (skipped, the lines after it count; one still
//     unterminated is not read again), an unreadable file named once;
// (c) crediting (src/shared/token-credit.ts): the last switch at or before each
//     request, nothing before the first switch, two logins with a switch mid-week,
//     window bounds, complete vs partial, the scan floor, the estimate (complete:
//     tokens ÷ percent; partial: tokens ÷ (percent − p0), from a 5-point rise);
// (c2) seven-day.log (src/shared/seven-day-log.ts, main's reader): bad lines
//     skipped, the reading at since keyed by resets_at alone (a line tagged with
//     the wrong login still counts), none before since, the 2 MB cap, unreadable;
// (d) the words (src/renderer/services/usage-format.ts): k / M / bn, the pair
//     "<used> of <allowance> bn" to 2 figures, the sub line complete, from a rise,
//     with no estimate, used up, passed, for another week (never "≥", "~" or
//     "since"), the detail saying it is an estimate and from what;
// (e) the real worker (bundled here with esbuild as one CommonJS file, not by
//     Forge's Vite; the Vite-built file is also run when .vite/build has one),
//     run with eval through src/main/token-scan-host.ts: same totals as the
//     scanner, state kept, a worker that dies is started again (and told);
// (f) main's IPC module with the worker: counts joined into the push per login
//     with their estimates (a partial one only once seven-day.log gives p0), one
//     "[USAGE] estimate" line per change, the log's problems logged once,
//     one "[USAGE] tokens" line per scan whose rounded totals changed, a scan
//     scheduled by the poll itself when switches or weeks change, a count never
//     shown against another week, no count with no transcripts, a stale count
//     naming its time, errors logged once and the last counts kept, and a
//     separate process that exits on its own after stopPlanUsagePoll;
// (g) wiring: Forge builds the worker beside main, the worker needs only Node.
// TOKEN_SCAN_PROBE=1 also scans this Mac's real ~/.claude/projects once,
// read-only, and prints the time and file count (no assertion).
// Run: node scripts/check-usage-tokens.mjs
import { build } from 'esbuild';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
                 export * from './src/shared/seven-day-log';
                 export { readSevenDayLog, sevenDayLogPath, statSevenDayLog } from './src/main/plan-usage-file';
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
    check('scanner: a missing root is no files, not an error, and lists no transcript', none.files === 0 && none.requests === 0 && none.listed === 0, none);
    const emptyRoot = join(tmp, 'empty-root');
    mkdirSync(emptyRoot);
    check('scanner: a root with no transcript in it lists none', (await new M.TokenScanner().scan(emptyRoot, floor)).listed === 0);
    check('scanner: a root with transcripts lists them, old ones too', (await new M.TokenScanner().scan(root, floor)).listed === 2);

    // Rewritten in place (same inode) so that it ends past the saved offset: the early line is gone and
    // new ones were added in the same pass. Reading on from the old offset would start mid-file.
    {
      const rwRoot = join(tmp, 'rw'); mkdirSync(rwRoot);
      const f = join(rwRoot, 'a.jsonl');
      const L = (i, n) => asst(`rw${i}`, `r${i}`, NOW - 100 + i, { i: n });
      writeFileSync(f, [L(1, 10), L(2, 20), L(3, 30)].join('\n') + '\n');
      const r = new M.TokenScanner(); await r.scan(rwRoot, floor);
      const ino = statSync(f).ino;
      writeFileSync(f, [L(1, 10), L(3, 30), L(4, 40), L(5, 50)].join('\n') + '\n');
      check('scanner (setup): the rewrite keeps the inode and ends past the old offset', statSync(f).ino === ino && statSync(f).size > Buffer.byteLength([L(1, 10), L(2, 20), L(3, 30)].join('\n') + '\n'));
      await r.scan(rwRoot, floor);
      check('scanner: a file rewritten in place is read from the start (its new lines count, none twice)', sumOf(r) === 150 && countOf(r) === 5, { sum: sumOf(r), n: countOf(r) });
    }

    // Replaced by rename with other early content but the same 256 bytes before the saved offset (and
    // the same offset): only the inode tells it from an append.
    {
      const rpRoot = join(tmp, 'rp'); mkdirSync(rpRoot);
      const f = join(rpRoot, 'a.jsonl');
      const common = JSON.stringify({ type: 'assistant', requestId: 'rC', timestamp: iso(NOW - 80), message: { id: 'mC', content: [{ type: 'text', text: 'p'.repeat(600) }], usage: { input_tokens: 5 } } });
      writeFileSync(f, asst('mX', 'rX', NOW - 90, { i: 1000 }) + '\n' + common + '\n');
      const r = new M.TokenScanner(); await r.scan(rpRoot, floor);
      writeFileSync(`${f}.tmp`, asst('mY', 'rY', NOW - 90, { i: 2000 }) + '\n' + common + '\n' + asst('mZ', 'rZ', NOW - 70, { i: 3 }) + '\n');
      renameSync(`${f}.tmp`, f);
      await r.scan(rpRoot, floor);
      check('scanner: a replaced file (new inode) is read whole even when the bytes before the old offset hash the same', sumOf(r) === 1000 + 5 + 2000 + 3, sumOf(r));
    }

    // The same request in two files (a resumed or forked session), stamped differently: once, at its earliest time,
    // whichever file is listed first.
    for (const [late, early] of [['a.jsonl', 'b.jsonl'], ['b.jsonl', 'a.jsonl']]) {
      const dupRoot = join(tmp, `dup-${late}`); mkdirSync(dupRoot);
      writeFileSync(join(dupRoot, late), asst('mDup', 'rDup', NOW - 100, { i: 40 }) + '\n');
      writeFileSync(join(dupRoot, early), asst('mDup', 'rDup', NOW - 500, { i: 40, o: 2 }) + '\n');
      const r = new M.TokenScanner(); await r.scan(dupRoot, floor);
      const got = [...r.requests()];
      check(`scanner: a request in two files counts once, at its earliest time and larger figure (${late} later)`, got.length === 1 && got[0].t === NOW - 500 && got[0].n === 42, got);
    }

    // A file that cannot be read is named once, with its code, however many scans find it so.
    if (process.getuid?.() !== 0) {
      const errRoot = join(tmp, 'err'); mkdirSync(errRoot);
      const bad = join(errRoot, 'bad.jsonl');
      writeFileSync(bad, asst('mBad', 'rBad', NOW - 5, { i: 1 }) + '\n');
      writeFileSync(join(errRoot, 'good.jsonl'), asst('mGood', 'rGood', NOW - 5, { i: 2 }) + '\n');
      chmodSync(bad, 0o000);
      const r = new M.TokenScanner();
      const e1 = await r.scan(errRoot, floor);
      const e2 = await r.scan(errRoot, floor);
      chmodSync(bad, 0o644);
      check('scanner: an unreadable file is skipped, named once with its code, and the others count', e1.skipped === 1 && JSON.stringify(e1.errors) === JSON.stringify([['bad.jsonl', 'EACCES']]) && e2.skipped === 1 && e2.errors.length === 0 && sumOf(r) === 2, { e1, e2 });
      const e3 = await r.scan(errRoot, floor);
      check('scanner: once readable it is read and counts', e3.skipped === 0 && sumOf(r) === 3, { e3, sum: sumOf(r) });
    }

    // A very long line (a tool result) between requests: read across chunk joins, the requests around it count.
    const longFile = join(projA, 'long.jsonl');
    const big = JSON.stringify({ type: 'user', message: { content: 'y'.repeat(9 * 1024 * 1024) } });
    writeFileSync(longFile, asst('mL1', 'rL1', NOW - 10, { i: 11 }) + '\n' + big + '\n' + asst('mL2', 'rL2', NOW - 9, { i: 13 }) + '\n');
    const sc2 = new M.TokenScanner();
    await sc2.scan(root, floor);
    check('scanner: requests either side of a 9 MB line (over two read chunks) both count', [...sc2.requests()].filter((r) => r.n === 11 || r.n === 13).length === 2);
    rmSync(longFile);

    // A line over the 32 MB cap is skipped unread; the requests before and after it count, and it is not read again.
    {
      const capRoot = join(tmp, 'cap'); mkdirSync(capRoot);
      const f = join(capRoot, 'a.jsonl');
      const over = JSON.stringify({ type: 'user', message: { content: 'y'.repeat(M.LINE_CAP_BYTES + 1024 * 1024) } });
      writeFileSync(f, asst('mP1', 'rP1', NOW - 10, { i: 21 }) + '\n' + over + '\n' + asst('mP2', 'rP2', NOW - 9, { i: 23 }) + '\n');
      const r = new M.TokenScanner();
      const a = await r.scan(capRoot, floor);
      check('scanner: a line over the 32 MB cap is skipped, the lines either side of it count', sumOf(r) === 44 && countOf(r) === 2, { sum: sumOf(r), n: countOf(r) });
      check('scanner: ... and the next scan reads none of it again', a.bytes === statSync(f).size && (await r.scan(capRoot, floor)).bytes === 0);
    }
    // One still unterminated (40 MB, growing): not read again from its start; the lines after its newline count.
    {
      const capRoot = join(tmp, 'cap-open'); mkdirSync(capRoot);
      const f = join(capRoot, 'a.jsonl');
      writeFileSync(f, asst('mQ1', 'rQ1', NOW - 10, { i: 31 }) + '\n' + '{"type":"user","message":{"content":"' + 'z'.repeat(40 * 1024 * 1024));
      const r = new M.TokenScanner();
      const a = await r.scan(capRoot, floor);
      const b = await r.scan(capRoot, floor);
      appendFileSync(f, 'z'.repeat(1024 * 1024));
      const c = await r.scan(capRoot, floor);
      appendFileSync(f, '"}}\n' + asst('mQ2', 'rQ2', NOW - 9, { i: 37 }) + '\n');
      const d = await r.scan(capRoot, floor);
      check('scanner: an unterminated line over the cap is read once, then only what is appended to it', a.bytes > 40e6 && b.bytes === 0 && c.bytes === 1024 * 1024 && d.bytes < 1000, [a.bytes, b.bytes, c.bytes, d.bytes]);
      check('scanner: ... and the request after its newline counts', sumOf(r) === 31 + 37 && countOf(r) === 2, { sum: sumOf(r), n: countOf(r) });
    }
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
    const e = M.weekEstimate(full, 63, null);
    check('estimate: complete, allowance = tokens ÷ percent × 100 and used = the count', e?.method === 'complete' && Math.abs(e.allowance - 2_912_345_678 / 0.63) < 1 && e.used === 2_912_345_678 && e.p0 === null, e);
    check('estimate: complete ignores a p0 (the count is the whole week)', M.weekEstimate(full, 63, 40)?.allowance === e?.allowance);
    check('estimate: complete, none under 5% shown or for no tokens', M.weekEstimate(full, 4.4, null) === null && M.weekEstimate({ ...full, tokens: 0 }, 63, null) === null);
    check('estimate: complete from 5% shown (4.6 rounds to 5)', M.weekEstimate(full, 4.6, null) !== null);
    const part = { tokens: 2_064_000_000, complete: false, since: T, resetsAt: T + 4 * DAY };
    const r = M.weekEstimate(part, 97, 61);
    check('estimate: partial with p0, allowance = tokens ÷ (pct − p0) × 100 and used = pct × allowance',
      r?.method === 'rate' && Math.abs(r.allowance - 2_064_000_000 / 0.36) < 1 && Math.abs(r.used - 0.97 * 2_064_000_000 / 0.36) < 1 && r.p0 === 61 && r.pct === 97, r);
    check('estimate: partial with no p0 (no reading at or before since) has none', M.weekEstimate(part, 97, null) === null);
    check('estimate: partial with a rise under 10 points has none, from exactly 10 points it has one (whole-percent readings make 5 up to 20% wrong)', M.weekEstimate(part, 70.9, 61) === null && M.weekEstimate(part, 66, 61) === null && M.weekEstimate(part, 71, 61)?.method === 'rate' && M.ESTIMATE_MIN_RISE === 10 && M.ESTIMATE_MIN_PCT === 5, [M.weekEstimate(part, 70.9, 61), M.weekEstimate(part, 71, 61)]);
    const why = (t, pct, p0) => M.estimateWeek(t, pct, p0).why;
    check('estimate: the reason for none: nothing counted, under 5% (complete), no reading, too little rise; none for an estimate',
      why({ ...part, tokens: 0 }, 97, 61) === 'none-counted' && why({ ...full, tokens: 0 }, 63, null) === 'none-counted' && why(full, 4.4, null) === 'low-pct'
      && why(part, 97, null) === 'no-reading' && why(part, 66, 61) === 'small-rise' && why(full, 63, null) === null && why(part, 97, 61) === null, [why(part, 97, null), why(part, 66, 61)]);
    check('estimate: partial with no tokens has none (a used-up login with nothing counted)', M.weekEstimate({ ...part, tokens: 0 }, 100, 61) === null);
  });

  // ── (c2) the status line's seven-day.log: parser, the reading at since, main's reader
  await section('seven-day', async () => {
    const text = [
      '1795534622 42 1795863600',            // an old line, no id
      '1795537619 46 1795863600 17f8b6e1',   // tagged with the wrong login: still this week's reading
      '1795537628 98 1795849200 17f8b6e1',   // another week
      'garbage',
      '1795548001 61 1795863600 38e237e1',
      '1795548001 x 1795863600',             // a bad percent
      '1795548002 62 1795863600 38e237e1 extra',
      '1795548003 55 1795863600 not-an-id',  // the id column is never used: a malformed one is still a reading
      '-5 10 1795863600',
      '',
      '1795548187 62 1795863600 38e237e1',
      '1795597759 0 1796169600 e80ce726',
    ].join('\n') + '\n';
    const L = M.parseSevenDayLog(text);
    check('log: good lines kept (with or without an id), bad ones skipped and counted, blanks not', L.readings.length === 7 && L.skipped === 4, L);
    const since = 1795548179;
    check('log: the percent at since is the highest reading at or before it, of that week (61, not the 55 or 42 before it)', M.pctAt(L.readings, 1795863600, since) === 61, M.pctAt(L.readings, 1795863600, since));
    check('log: a stale lower reading appended just before since cannot lower it (the highest wins, not the latest)', M.pctAt(M.parseSevenDayLog('100 40 900\n200 61 900\n299 55 900\n').readings, 900, 300) === 61);
    check('log: a reading exactly at since counts, one a second later does not', M.pctAt(M.parseSevenDayLog('100 40 900\n300 61 900\n301 70 900\n').readings, 900, 300) === 61 && M.pctAt(M.parseSevenDayLog('100 40 900\n300 61 900\n').readings, 900, 299) === 40);
    check('log: readings of another resets_at never count, however high', M.pctAt(M.parseSevenDayLog('100 40 900\n200 99 901 aaaaaaaa\n').readings, 900, 300) === 40);
    check('log: a reading tagged with another login\'s id still counts for its week (keyed by resets_at alone)', M.pctAt(L.readings, 1795863600, 1795537620) === 46);
    check('log: another week\'s readings never answer (98% of the week resetting earlier)', M.pctAt(L.readings, 1795849200, since) === 98 && M.pctAt(L.readings, 1795863600, 1795537630) === 46);
    check('log: no reading at or before since gives null', M.pctAt(L.readings, 1796169600, since) === null && M.pctAt(L.readings, 1795863600, 1795534621) === null);
    check('log: a reading at since itself counts', M.pctAt(L.readings, 1795863600, 1795548187) === 62);
    check('log: two readings at one time, the higher answers', M.pctAt(M.parseSevenDayLog('100 5 900\n100 7 900\n').readings, 900, 100) === 7 && M.pctAt(M.parseSevenDayLog('100 7 900\n100 5 900\n').readings, 900, 100) === 7);

    const dir = join(tmp, 'seven-day');
    mkdirSync(dir, { recursive: true });
    const accountsFile = join(dir, 'accounts.json');
    const before = process.env.PATTON_PLAN_USAGE_FILE;
    process.env.PATTON_PLAN_USAGE_FILE = accountsFile;
    try {
      check('reader: seven-day.log sits beside accounts.json', M.sevenDayLogPath() === join(dir, 'seven-day.log'), M.sevenDayLogPath());
    } finally {
      if (before === undefined) delete process.env.PATTON_PLAN_USAGE_FILE; else process.env.PATTON_PLAN_USAGE_FILE = before;
    }
    const logFile = join(dir, 'seven-day.log');
    const missing = await M.readSevenDayLog(logFile);
    check('reader: a missing log gives no readings, problem "missing"', missing.readings.length === 0 && missing.problem === 'missing' && missing.key === 'none', missing);
    writeFileSync(logFile, text);
    const good = await M.readSevenDayLog(logFile);
    check('reader: a good log gives its readings and its stat key', good.readings.length === 7 && good.skipped === 4 && good.problem === null && good.key === await M.statSevenDayLog(logFile), good.key);
    writeFileSync(logFile, Buffer.alloc(M.SEVEN_DAY_LOG_SIZE_CAP + 1, 0x31));
    const big = await M.readSevenDayLog(logFile);
    check('reader: a log over 2 MB is refused whole (no readings, "too-large")', M.SEVEN_DAY_LOG_SIZE_CAP === 2 * 1024 * 1024 && big.readings.length === 0 && big.problem === 'too-large', { problem: big.problem, n: big.readings.length });
    if (process.getuid?.() !== 0) {
      writeFileSync(logFile, text);
      chmodSync(logFile, 0o000);
      const locked = await M.readSevenDayLog(logFile);
      chmodSync(logFile, 0o644);
      check('reader: an unreadable log gives no readings and no key (read again next poll)', locked.readings.length === 0 && locked.problem === 'unreadable' && locked.key === '', locked);
    }
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
    full.estimate = M.weekEstimate(full, 63, null);
    const part = { tokens: 2_064_000_000, complete: false, since: tue, resetsAt: sat };
    const rate = { ...part, estimate: M.weekEstimate(part, 97, 61) };
    const pairs = [[1.9e9, 5.733e9, '1.9 of 5.7 bn'], [412_345_678, 4.6e9, '0.41 of 4.6 bn'], [412e6, 800e6, '410 of 800M'], [5.56e9, 5.733e9, '5.6 of 5.7 bn'], [0, 5e9, '0 of 5.0 bn'], [9.96e9, 9.97e9, '10 of 10 bn'], [12e3, 999_600, '0.012 of 1.0M']];
    const badPairs = pairs.filter(([u, a, want]) => M.tokenPair(u, a) !== want).map(([u, a, want]) => [u, a, want, M.tokenPair(u, a)]);
    check('format: the pair is both figures in the allowance\'s unit, 2 significant figures', badPairs.length === 0, badPairs);
    check('format: a complete count, "<used> of <allowance> bn"', M.weekSubLine(week, full) === '2.9 of 4.6 bn · resets Sat 12:00', M.weekSubLine(week, full));
    check('format: a partial count with p0, used = pct × allowance', M.weekSubLine({ ...week, pct: 97 }, rate) === '5.6 of 5.7 bn · resets Sat 12:00', M.weekSubLine({ ...week, pct: 97 }, rate));
    check('format: no estimate (no p0, a small rise, under 5%), the reset alone', M.weekSubLine(week, part) === 'resets Sat 12:00' && M.weekSubLine(week, { ...part, estimate: null }) === 'resets Sat 12:00', M.weekSubLine(week, part));
    check('format: a used-up login with no tokens reads "back …" alone', M.weekSubLine({ ...week, pct: 100 }, { ...part, tokens: 0, estimate: M.weekEstimate({ ...part, tokens: 0 }, 100, 61) }) === 'back Sat 12:00');
    const lines = [M.weekSubLine(week, full), M.weekSubLine({ ...week, pct: 97 }, rate), M.weekSubLine(week, part), M.weekSubLine({ ...week, pct: 100 }, full)];
    check('format: no sub line holds "≥", "~" or "since"', lines.every((l) => !/[≥~]|since/.test(l)), lines);
    check('format: a passed week shows no tokens', M.weekSubLine({ ...week, pct: 0, passed: true }, full) === 'reset Sat 12:00');
    check('format: a count for another week shows nothing', M.weekSubLine(week, { ...full, resetsAt: sat - 7 * DAY }) === 'resets Sat 12:00');
    check('format: no count, the reset alone', M.weekSubLine(week, null) === 'resets Sat 12:00');
    const full100 = { ...full, estimate: M.weekEstimate(full, 100, null) };
    check('format: a full week keeps "back" after the tokens (the estimate drawn at 100%, as main sends it)', M.weekSubLine({ ...week, pct: 100 }, full100) === '2.9 of 2.9 bn · back Sat 12:00', M.weekSubLine({ ...week, pct: 100 }, full100));
    const d = M.tokenDetail(full);
    check('format: a complete detail says it is an estimate and from what, then what the count is',
      d.startsWith('about 2.9 of 4.6 bn tokens this week, estimated from 2.9 bn counted this week at 63%; the count is what Claude Code recorded while this login was live (from Sat 12:00)') && d.includes('approximate around switches') && d.includes('cached re-reads included'), d);
    const dp = M.tokenDetail(rate);
    check('format: a rate detail gives the count since the first switch and the rise', dp.startsWith('about 5.6 of 5.7 bn tokens this week, estimated from 2.1 bn counted since Tue 20:22 while the week rose from 61% to 97%') && dp.includes('from Tue 20:22, when the record of which login was live began') && dp.includes('approximate around switches'), dp);
    const dd = (t) => M.tokenDetail(t).split('; the count is')[0];
    const tuesday = 'Tue 20:22';
    check('format: no estimate, the hover says why: no reading of this week at the count\'s start',
      dd({ ...part, noEstimate: 'no-reading' }) === `2,064,000,000 tokens counted, but no reading of this week at or before ${tuesday}, so no rise to estimate from`, dd({ ...part, noEstimate: 'no-reading' }));
    check('format: ... too little rise since the count began', dd({ ...part, noEstimate: 'small-rise' }) === `2,064,000,000 tokens counted, but the week has risen under 10 points since ${tuesday}, too little to estimate from`, dd({ ...part, noEstimate: 'small-rise' }));
    check('format: ... under 5% used (complete count)', dd({ ...full, estimate: null, noEstimate: 'low-pct' }) === '2,912,345,678 tokens counted, but under 5% of the week is used, too little to estimate from', dd({ ...full, estimate: null, noEstimate: 'low-pct' }));
    check('format: ... nothing counted since the login record began (partial), or this week (complete)', dd({ ...part, tokens: 0, noEstimate: 'none-counted' }) === `Not used since ${tuesday}, nothing counted` && dd({ ...full, estimate: null, tokens: 0, noEstimate: 'none-counted' }) === 'Not used this week, nothing counted', [dd({ ...part, tokens: 0, noEstimate: 'none-counted' })]);
    check('format: ... and with no reason given, the count and no claim about why', dd(part) === '2,064,000,000 tokens counted, no estimate of the week yet' && !/few/.test(M.tokenDetail(part)), dd(part));
    check('format: a stale count names its time, a fresh one does not', M.tokenDetail({ ...full, countedAt: tue }).endsWith('; tokens counted at 20:22') && !d.includes('counted at'));
    check('format: the sub line is a token part ending in "·" and a reset part, so a wrap falls between them', JSON.stringify(M.weekSubParts(week, full)) === JSON.stringify({ tokens: '2.9 of 4.6 bn ·', reset: 'resets Sat 12:00' }) && M.weekSubParts(week, null).tokens === null && M.weekSubParts(week, part).tokens === null, M.weekSubParts(week, full));
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

    // A worker that dies is dropped, the scan rejected, and the next scan starts one afresh (onStart told).
    const dying = join(tmp, 'dying-worker.cjs');
    writeFileSync(dying, "require('node:worker_threads').parentPort.on('message', () => process.exit(3));");
    const starts = [];
    const dyingHost = new M.TokenScanHost(dying, (n) => starts.push(n));
    const codes = [];
    for (let i = 0; i < 2; i++) {
      try { await dyingHost.scan({ root, floor, switches: sw, windows }); } catch (err) { codes.push(err?.code); }
    }
    dyingHost.stop();
    check('worker: a worker that exits rejects the scan, and the next scan starts another (onStart 1, 2)', codes.join() === 'WORKER_EXIT,WORKER_EXIT' && starts.join() === '1,2', { codes, starts });

    // The Vite-built worker, when a build has put one in .vite/build.
    const built = join(repo, '.vite', 'build', 'token-scan-worker.cjs');
    if (existsSync(built)) {
      const bh = new M.TokenScanHost(built);
      try {
        const rb = await bh.scan({ root, floor, switches: sw, windows });
        check('worker: the Vite-built worker (.vite/build) answers with the scanner\'s totals', rb.ok && JSON.stringify(rb.totals) === JSON.stringify([...want]), rb);
      } finally { bh.stop(); }
    } else console.log('skip worker: no .vite/build/token-scan-worker.cjs (not built here)');
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
      check('ipc: one "[USAGE] tokens" line, with totals in millions, files, bytes, requests, skipped and ms',
        tokenLogs().length === 1 && tokenLogs()[0][2]?.totalsM?.bbbb2222 === 300 && tokenLogs()[0][2]?.files === 1 && typeof tokenLogs()[0][2]?.ms === 'number'
        && tokenLogs()[0][2]?.skipped === 0 && tokenLogs()[0][2]?.requests === 2 && tokenLogs()[0][2]?.bytes === statSync(tx).size, tokenLogs());
      check('ipc: no "[USAGE] read" line for the token count alone (one for the first reading)', logs.filter((l) => l[1] === '[USAGE] read').length === 1);
      const get = stub.handlers.get(I.IPC.PLAN_USAGE_GET);
      const got = await get();
      check('ipc: the get answers the reading with its counts', got?.accounts.find((a) => a.id === 'bbbb2222')?.weekTokens?.tokens === 300_000_000);

      // Estimates: B's complete count is tokens ÷ percent; A's partial count has none until seven-day.log gives
      // A's week's percent at the first switch.
      const estLogs = (id) => logs.filter((l) => l[1] === '[USAGE] estimate' && l[2]?.id === id).map((l) => l[2]);
      const sdWarn = () => logs.filter((l) => l[1] === '[USAGE] seven-day log unusable, no partial estimates');
      const eB = acct('bbbb2222')?.weekTokens?.estimate;
      check('ipc: a complete count carries its estimate (300M at 50%: 300M of 600M)', eB?.method === 'complete' && eB.used === 300_000_000 && Math.abs(eB.allowance - 600_000_000) < 1, eB);
      check('ipc: a partial count with no seven-day.log has no estimate', acct('aaaa1111')?.weekTokens?.estimate === null, acct('aaaa1111')?.weekTokens);
      check('ipc: the missing log is logged once', sdWarn().length === 1 && sdWarn()[0][2]?.reason === 'missing', sdWarn());
      check('ipc: an "[USAGE] estimate" line per change of a login\'s estimate: B none before the first scan, then complete; A none', estLogs('bbbb2222').length === 2 && estLogs('bbbb2222')[0].method === 'none' && JSON.stringify(estLogs('bbbb2222')[1]) === JSON.stringify({ id: 'bbbb2222', method: 'complete', usedB: 0.3, allowanceB: 0.6, dPct: 50 })
        && estLogs('aaaa1111').length === 1 && estLogs('aaaa1111')[0].method === 'none', [estLogs('bbbb2222'), estLogs('aaaa1111')]);
      const sevenDay = join(tmp, 'seven-day.log');
      writeFileSync(sevenDay, [
        `${firstSwitch - 5000} 20 ${resetA}`,
        `${firstSwitch - 100} 30 ${resetA} bbbb2222`,   // tagged with B's id, but A's week: it counts for A
        `${firstSwitch - 50} 99 ${resetB} aaaa1111`,     // tagged with A's id, B's week: never A's p0
        'not a reading',
        `${firstSwitch + 100} 35 ${resetA} aaaa1111`,    // after the first switch: not p0
      ].join('\n') + '\n');
      await I.pollPlanUsageOnce();
      const eA = acct('aaaa1111')?.weekTokens?.estimate;
      check('ipc: with the log, A\'s partial count is a rate from the week\'s percent at the first switch, keyed by resets_at (2M over 40 − 30 points: 8M of 20M)',
        eA?.method === 'rate' && eA.p0 === 30 && Math.abs(eA.allowance - 20_000_000) < 1e-6 && Math.abs(eA.used - 8_000_000) < 1e-6, eA);
      check('ipc: ... one new "[USAGE] estimate" line for A, none for B', estLogs('aaaa1111').length === 2 && JSON.stringify(estLogs('aaaa1111')[1]) === JSON.stringify({ id: 'aaaa1111', method: 'rate', usedB: 0.008, allowanceB: 0.02, dPct: 10 }) && estLogs('bbbb2222').length === 2, estLogs('aaaa1111'));
      check('ipc: the bad line is skipped and logged once', logs.filter((l) => l[1] === '[USAGE] seven-day log lines skipped').length === 1);
      await I.pollPlanUsageOnce();
      check('ipc: an unchanged log is not re-read and logs nothing new', estLogs('aaaa1111').length === 2 && logs.filter((l) => l[1] === '[USAGE] seven-day log lines skipped').length === 1);
      // The log is re-read only when its stat (mtime and size) changes: a same-size rewrite that keeps the mtime is not seen.
      const sdOriginal = readFileSync(sevenDay, 'utf8');
      const sdPinned = NOW - 1000;
      const sdMark = (secs) => utimesSync(sevenDay, secs, secs);
      sdMark(sdPinned);
      await I.pollPlanUsageOnce();
      check('ipc: the stat-keyed read: p0 is still 30 after the log was touched to a pinned time', acct('aaaa1111')?.weekTokens?.estimate?.p0 === 30, acct('aaaa1111')?.weekTokens?.estimate);
      const sdChanged = sdOriginal.replace(`${firstSwitch - 100} 30 `, `${firstSwitch - 100} 31 `);
      writeFileSync(sevenDay, sdChanged);
      sdMark(sdPinned);
      await I.pollPlanUsageOnce();
      await I.pollPlanUsageOnce();
      check('ipc: a log whose mtime and size are unchanged is not read again (a same-size rewrite is not seen: p0 stays 30)', sdChanged.length === sdOriginal.length && statSync(sevenDay).mtimeMs === sdPinned * 1000 && acct('aaaa1111')?.weekTokens?.estimate?.p0 === 30, [acct('aaaa1111')?.weekTokens?.estimate, statSync(sevenDay).mtimeMs]);
      writeFileSync(sevenDay, sdOriginal);
      sdMark(sdPinned + 5);
      await I.pollPlanUsageOnce();
      check('ipc: ... and a changed stat is read again (the original log back, p0 30, no new estimate line)', acct('aaaa1111')?.weekTokens?.estimate?.p0 === 30 && estLogs('aaaa1111').length === 2, estLogs('aaaa1111'));

      // A count that stays while the percent moves keeps its estimate: the percent at the scan is what it is drawn with.
      const bEst = () => JSON.stringify(acct('bbbb2222')?.weekTokens);
      const bBefore = bEst();
      accounts.accounts.bbbb2222.seven_day = { used_percentage: 60, resets_at: resetB, read_at: NOW };
      writeFileSync(`${file}.tmp`, JSON.stringify(accounts));
      renameSync(`${file}.tmp`, file);
      await I.pollPlanUsageOnce();
      await I.pollPlanUsageOnce();
      const bMoved = acct('bbbb2222');
      check('ipc: a frozen count with the percent moving (50 to 60) leaves the estimate unchanged (300M of 600M, not 300M of 500M)',
        bMoved?.week?.pct === 60 && bEst() === bBefore && bMoved.weekTokens.estimate.pct === 50 && Math.abs(bMoved.weekTokens.estimate.allowance - 600_000_000) < 1 && estLogs('bbbb2222').length === 2, [bBefore, bEst()]);
      accounts.accounts.bbbb2222.seven_day = { used_percentage: 50, resets_at: resetB, read_at: NOW };
      writeFileSync(`${file}.tmp`, JSON.stringify(accounts));
      renameSync(`${file}.tmp`, file);
      await I.pollPlanUsageOnce();
      check('ipc: ... and back at 50 it is the same again', acct('bbbb2222')?.week?.pct === 50 && bEst() === bBefore, bEst());

      if (process.getuid?.() !== 0) {
        appendFileSync(sevenDay, `${NOW} 41 ${resetA}\n`);
        chmodSync(sevenDay, 0o000);
        await I.pollPlanUsageOnce();
        await I.pollPlanUsageOnce();
        check('ipc: an unreadable log means no partial estimate, logged once over two polls', acct('aaaa1111')?.weekTokens?.estimate === null && sdWarn().length === 2 && sdWarn()[1][2]?.reason === 'unreadable' && acct('bbbb2222')?.weekTokens?.estimate?.method === 'complete', [sdWarn(), acct('aaaa1111')?.weekTokens]);
        chmodSync(sevenDay, 0o644);
        await I.pollPlanUsageOnce();
        check('ipc: ... and once readable, A\'s estimate is back', acct('aaaa1111')?.weekTokens?.estimate?.p0 === 30 && estLogs('aaaa1111').map((e) => e.method).join() === 'none,rate,none,rate', estLogs('aaaa1111'));
      }

      let marks = { pushes: pushes().length, logs: tokenLogs().length };
      await I.scanTokensOnce();
      check('ipc: an unchanged scan pushes nothing and logs nothing', pushes().length === marks.pushes && tokenLogs().length === marks.logs, [marks, pushes().length, tokenLogs().length]);

      appendFileSync(tx, asst('m3', 'r3', NOW - 5, { o: 1_000 }) + '\n');
      await I.scanTokensOnce();
      check('ipc: a new request moves the count (one push) but not the rounded totals, so no log line', pushes().length === marks.pushes + 1 && tokenLogs().length === marks.logs && acct('bbbb2222').weekTokens.tokens === 300_001_000, [pushes().length, tokenLogs().length, acct('bbbb2222')?.weekTokens]);

      // A request that carries B's total across a million: one log line.
      appendFileSync(tx, asst('m3b', 'r3b', NOW - 1800, { o: 2_000_000 }) + '\n');
      await I.scanTokensOnce();
      check('ipc: a total that crosses a rounded million is one push and one log line', pushes().length === marks.pushes + 2 && tokenLogs().length === marks.logs + 1 && tokenLogs().at(-1)[2]?.totalsM?.bbbb2222 === 302, [pushes().length, tokenLogs().length, tokenLogs().at(-1)]);
      check('ipc: counts that leave the estimate the same to 2 figures (0.30 of 0.60 bn) log no new estimate line', estLogs('bbbb2222').length === 2 && acct('bbbb2222').weekTokens.estimate.used === 302_001_000, estLogs('bbbb2222'));
      marks = { pushes: pushes().length, logs: tokenLogs().length };

      // A transcript that cannot be read is logged once with its file name and code, and the others still count.
      if (process.getuid?.() !== 0) {
        const bad = join(proot, 'p', 'bad.jsonl');
        writeFileSync(bad, asst('mBad', 'rBad', NOW - 20, { i: 0 }) + '\n');
        chmodSync(bad, 0o000);
        await I.scanTokensOnce();
        await I.scanTokensOnce();
        chmodSync(bad, 0o644);
        const rf = logs.filter((l) => l[1] === '[USAGE] tokens read failed');
        check('ipc: an unreadable transcript is logged once over two scans, by file name and code', rf.length === 1 && rf[0][2]?.file === 'bad.jsonl' && rf[0][2]?.code === 'EACCES', rf);
        await I.scanTokensOnce();
        check('ipc: ... and once readable it counts, with no new failure line', logs.filter((l) => l[1] === '[USAGE] tokens read failed').length === 1 && acct('aaaa1111') !== undefined);
        marks = { pushes: pushes().length, logs: tokenLogs().length };
      }

      // A scan error: logged once over two failing scans, and the last counts stay.
      if (process.getuid?.() !== 0) {
        chmodSync(proot, 0o000);
        marks = { pushes: pushes().length, logs: logs.length };
        await I.scanTokensOnce();
        await I.scanTokensOnce();
        const fails = logs.filter((l) => l[1] === '[USAGE] tokens scan failed');
        check('ipc: an unreadable transcripts folder is logged once over two scans, with its code', fails.length === 1 && fails[0][2]?.error === 'EACCES', fails);
        check('ipc: ... and the last counts stay (no push)', pushes().length === marks.pushes && acct('bbbb2222').weekTokens.tokens === 302_001_000);
        // Past 5 minutes of failing scans, the count says when it was counted (the sub line unchanged).
        const realDateNow = Date.now;
        const lateBy = 6 * 60 * 1000;
        const countedAt = Math.floor(realDateNow() / 1000);
        Date.now = () => realDateNow() + lateBy;
        try {
          await I.pollPlanUsageOnce();
          await I.scanTokensOnce();
          const wt = acct('bbbb2222')?.weekTokens;
          check('ipc: counts older than 5 minutes (scans failing) carry the time they were counted', wt?.tokens === 302_001_000 && Math.abs((wt.countedAt ?? 0) - countedAt) <= 5, wt);
        } finally { Date.now = realDateNow; }
        chmodSync(proot, 0o755);
        await I.scanTokensOnce();
        check('ipc: once readable again the count is fresh (no countedAt) and still 302,001,000', acct('bbbb2222')?.weekTokens?.tokens === 302_001_000 && !acct('bbbb2222').weekTokens.countedAt, acct('bbbb2222')?.weekTokens);
      } else console.log('skip ipc: unreadable folder (running as root)');

      // The file's switches change: the next poll scans at once (no minute's wait).
      accounts.switches.push([NOW - 10, 'aaaa1111']);
      accounts.updated = NOW + 1;
      writeFileSync(`${file}.tmp`, JSON.stringify(accounts));
      renameSync(`${file}.tmp`, file);
      await I.pollPlanUsageOnce(); // the poll itself starts the scan; none is called by hand
      const waitFor = async (fn, ms = 10_000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25)); return fn(); };
      const recredited = await waitFor(() => acct('aaaa1111')?.weekTokens?.tokens === 2_001_000 && acct('bbbb2222')?.weekTokens?.tokens === 302_000_000);
      check('ipc: a change of switches makes the poll scan at once, with no minute\'s wait (the last request now A\'s)', recredited, [acct('aaaa1111')?.weekTokens, acct('bbbb2222')?.weekTokens]);

      // A count is shown only against the week it was counted for: B's week moves on, and until a scan
      // counts the new week the old figure is not drawn against it.
      const movedReset = resetB + 2 * DAY;
      accounts.accounts.bbbb2222.seven_day = { used_percentage: 5, resets_at: movedReset, read_at: NOW };
      accounts.updated = NOW + 2;
      writeFileSync(`${file}.tmp`, JSON.stringify(accounts));
      renameSync(`${file}.tmp`, file);
      I.setTokenWorkerScript(null); // no scan: only the join of the old figure with the new week is under test
      await I.pollPlanUsageOnce();
      check('ipc: a count for last week is not joined to the new week (resetsAt must match)', acct('bbbb2222')?.week?.resetsAt === movedReset && acct('bbbb2222').weekTokens === null, acct('bbbb2222'));
      I.setTokenWorkerScript(workerPath);
      await I.scanTokensOnce();
      check('ipc: after the next scan the new week has its own count', acct('bbbb2222')?.weekTokens?.resetsAt === movedReset && acct('bbbb2222').weekTokens.tokens === 0, acct('bbbb2222')?.weekTokens);
      check('ipc: a count of nothing carries its reason (none-counted) with no estimate, and A\'s estimated count has no reason', acct('bbbb2222')?.weekTokens?.estimate === null && acct('bbbb2222').weekTokens.noEstimate === 'none-counted' && acct('aaaa1111')?.weekTokens?.noEstimate === null, [acct('bbbb2222')?.weekTokens, acct('aaaa1111')?.weekTokens]);
      // The next good scan takes the percent as it then is: A at 40 becomes 45 and its rise 15 points (2.001M over 15 points).
      accounts.accounts.aaaa1111.seven_day = { used_percentage: 45, resets_at: resetA, read_at: NOW };
      writeFileSync(`${file}.tmp`, JSON.stringify(accounts));
      renameSync(`${file}.tmp`, file);
      await I.pollPlanUsageOnce();
      check('ipc: a poll alone does not move A\'s estimate (drawn at 40%)', acct('aaaa1111')?.week?.pct === 45 && acct('aaaa1111').weekTokens.estimate?.pct === 40, acct('aaaa1111')?.weekTokens);
      await I.scanTokensOnce();
      const aRe = acct('aaaa1111')?.weekTokens?.estimate;
      check('ipc: ... the next good scan draws it at 45% (a rise of 15 points: allowance = tokens ÷ 15 × 100)', aRe?.pct === 45 && aRe.p0 === 30 && Math.abs(aRe.allowance - 2_001_000 / 0.15) < 1e-3, aRe);

      // No transcripts folder: no count at all (not a 0).
      const keepDir = process.env.PATTON_CLAUDE_PROJECTS_DIR;
      process.env.PATTON_CLAUDE_PROJECTS_DIR = join(tmp, 'no-such-projects');
      await I.scanTokensOnce();
      check('ipc: a missing transcripts folder gives no count for anyone', last().accounts.every((a) => a.weekTokens === null), last().accounts.map((a) => a.weekTokens));
      process.env.PATTON_CLAUDE_PROJECTS_DIR = keepDir;
      await I.scanTokensOnce();
      check('ipc: ... and the count is back when the folder is', acct('aaaa1111')?.weekTokens?.tokens === 2_001_000, acct('aaaa1111')?.weekTokens);

      I.stopPlanUsagePoll();
      marks = { pushes: pushes().length, logs: logs.length };
      appendFileSync(tx, asst('m4', 'r4', NOW - 4, { o: 7 }) + '\n');
      await I.scanTokensOnce();
      check('ipc: after stop no scan runs (no push, no log)', pushes().length === marks.pushes && logs.length === marks.logs);

      // A second copy of the module (fresh state) with a worker that dies at once: the failure is logged, and the
      // next scan's new worker is logged as a restart.
      const dying = join(tmp, 'dying-ipc-worker.cjs');
      writeFileSync(dying, "require('node:worker_threads').parentPort.on('message', () => process.exit(3));");
      const I2 = await import(`${pathToFileURL(join(tmp, 'ipc.mjs')).href}?second`);
      I2.setTokenWorkerScript(dying);
      I2.registerPlanUsageHandlers();
      await I2.pollPlanUsageOnce();
      await I2.scanTokensOnce();
      await I2.scanTokensOnce();
      const restarts = logs.filter((l) => l[1] === '[USAGE] tokens worker restarted');
      check('ipc: a worker that died is started again and the restart is logged', restarts.length >= 1 && restarts[0][2]?.starts === 2 && restarts.every((r, i) => r[2]?.starts === i + 2) && logs.some((l) => l[1] === '[USAGE] tokens scan failed' && l[2]?.error === 'WORKER_EXIT'), { restarts, fails: logs.filter((l) => l[1] === '[USAGE] tokens scan failed') });
      I2.stopPlanUsagePoll();
    } finally {
      try { chmodSync(proot, 0o755); } catch { /* */ }
      I?.stopPlanUsagePoll?.();
      console.info = realInfo; console.warn = realWarn;
      globalThis.setInterval = realSI; globalThis.clearInterval = realCI;
      if (envBefore.f === undefined) delete process.env.PATTON_PLAN_USAGE_FILE; else process.env.PATTON_PLAN_USAGE_FILE = envBefore.f;
      if (envBefore.p === undefined) delete process.env.PATTON_CLAUDE_PROJECTS_DIR; else process.env.PATTON_CLAUDE_PROJECTS_DIR = envBefore.p;
    }
  });

  // ── (f2) no zombie after quit: a separate process starts the worker, calls stopPlanUsagePoll and must exit by itself
  await section('exit', async () => {
    const eroot = join(tmp, 'exit-projects'); mkdirSync(join(eroot, 'p'), { recursive: true });
    writeFileSync(join(eroot, 'p', 'x.jsonl'), asst('mE1', 'rE1', NOW - 100, { i: 12 }) + '\n');
    const efile = join(tmp, 'exit-accounts.json');
    writeFileSync(efile, JSON.stringify({ version: 1, updated: NOW, live: { account: 'aaaa1111', since: NOW - DAY },
      accounts: { aaaa1111: { email: 'a@example.com', last_live: NOW, seven_day: { used_percentage: 10, resets_at: NOW + 3 * DAY, read_at: NOW } } },
      switches: [[NOW - 2 * DAY, 'aaaa1111']] }));
    const script = join(tmp, 'exit-child.mjs');
    writeFileSync(script, `
      import { pathToFileURL } from 'node:url';
      const [ipc, worker] = process.argv.slice(2);
      const I = await import(pathToFileURL(ipc).href);
      I.setTokenWorkerScript(worker);
      I.registerPlanUsageHandlers();
      await I.pollPlanUsageOnce();
      await I.scanTokensOnce();
      console.log('scanned');
      I.stopPlanUsagePoll();
    `);
    const { spawn } = await import('node:child_process');
    const run = (stopMissing) => new Promise((resolve) => {
      const env = { ...process.env, PATTON_PLAN_USAGE_FILE: efile, PATTON_CLAUDE_PROJECTS_DIR: eroot };
      const child = spawn(process.execPath, [script, join(tmp, stopMissing ? 'ipc-nostop.mjs' : 'ipc.mjs'), workerPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const t0 = Date.now();
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, ms: Date.now() - t0, out }); });
    });
    const r = await run(false);
    check('exit: a process that scanned and called stopPlanUsagePoll ends by itself (no process.exit, no zombie worker)', r.code === 0 && r.signal === null && r.out.includes('scanned') && r.out.includes('[USAGE] tokens'), r);
    // The same child against a copy of main's module whose stop leaves the worker running must be seen to hang.
    const ipcText = readFileSync(join(tmp, 'ipc.mjs'), 'utf8');
    check('exit (setup): the module has a worker stop to remove', ipcText.includes('tokenHost?.stop()'));
    writeFileSync(join(tmp, 'ipc-nostop.mjs'), ipcText.replace('tokenHost?.stop()', 'void 0'));
    const hung = await run(true);
    check('exit: without the worker stop the same process does not end by itself (the check can tell)', hung.signal === 'SIGKILL', hung);
  });

  // ── (g) wiring
  await section('wiring', async () => {
    const forge = readFileSync(join(repo, 'forge.config.ts'), 'utf8');
    check('wiring: Forge builds the worker as a main-side entry', /entry: 'src\/main\/token-scan-worker\.ts',\s*config: 'vite\.main\.config\.ts',\s*target: 'main'/.test(forge));
    const ipc = readFileSync(join(repo, 'src/main/plan-usage-ipc.ts'), 'utf8');
    check('wiring: main loads it from beside its own bundle', ipc.includes("TOKEN_WORKER_FILE = 'token-scan-worker.cjs'") && ipc.includes('join(__dirname, TOKEN_WORKER_FILE)'));
    check('wiring: rescanned every 60 s', ipc.includes('TOKEN_SCAN_MS = 60 * 1000'));
    check('wiring: stopPlanUsagePoll stops the token host', /export function stopPlanUsagePoll[\s\S]*?tokenHost\?\.stop\(\)/.test(ipc));
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
