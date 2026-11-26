// Check of the usage panel (24 Nov 2026, Michael: every Claude login he has
// used, bottom left, with its usage and reset time; layout U1 from
// docs/mocks/usage-panel.html; the week's estimate in tokens, "1.9 of 5.7 bn",
// is drawn in section panel-tokens here, with its tooltip and the rail's, and
// counted, credited and estimated in check-usage-tokens.mjs).
// (a) the pure parser of ~/.claude/plan-usage/accounts.json
//     (src/shared/plan-usage.ts) on missing, garbage and bad input, null and
//     absent windows, a passed window, ordering, name fallback, the 12 cap;
// (b) main's file reader (src/main/plan-usage-file.ts) on a temp folder:
//     missing file, a good file, not JSON, over the size cap, wrong shape, a
//     replacement by rename changing the stat key;
// (c) the REAL UsagePanel in jsdom, alone and mounted by the real
//     BookmarksPanel: hidden with no data, logins in order with the live tag,
//     amber at 85, red with "back" at 100, a passed week at 0% with "reset",
//     the 5-hour line only where present, the minute's re-draw, the rail's bars
//     and tooltip, a refused first answer asked again, a push, text never HTML;
// (d) wiring: channels, preload, registration, the poll stopped on quit;
// (e) main's IPC module BEHAVIOURALLY (bundled with an electron stub, polled by
//     hand on a temp file): one push per content change, none for an unchanged
//     poll, an unreadable or corrupt file keeps the last good reading and is read
//     again, the rate-limited get answers null, stop clears the timer;
// (f) the panel's timers: the minute redraw, a late answer after dispose.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-usage-panel.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Local times, so the expected words hold in any time zone. 28 Nov 2026 is a Saturday.
const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime() / 1000;
const NOW = at(24, 20, 23); // Tue 24 Nov 20:23
const win = (pct, resets, read = NOW) => ({ used_percentage: pct, resets_at: resets, read_at: read });
const fixture = () => ({
  version: 1, updated: NOW,
  live: { account: '38e237e1', since: NOW - 200 },
  accounts: {
    bbbb2222: { email: 'third@example.com', plan: 'Ultra', last_live: NOW - 500, five_hour: win(40, at(24, 22)), seven_day: win(85, at(30, 9), NOW - 500) },
    '38e237e1': { email: 'michaeljrrushworth@gmail.com', plan: 'Ultra', first_seen: NOW - 200, last_live: NOW, five_hour: null, seven_day: win(63, at(28, 12)) },
    aaaa1111: { plan: 'Ultra', last_live: NOW - 900, seven_day: win(100, at(28, 8), at(24, 17, 46)) },
    cccc3333: { email: 'd@example.com', last_live: NOW - 3000, five_hour: win(30, at(24, 7), NOW - 3000), seven_day: win(50, at(24, 8), NOW - 3000) },
  },
  switches: [[NOW - 200, '38e237e1']],
});

const tmp = mkdtempSync(join(tmpdir(), 'check-usage-panel-'));
try {
  // ── bundles: the shared parser and main's reader for Node; the panel for jsdom
  const nodeBundle = await build({
    stdin: {
      resolveDir: repo, loader: 'ts',
      contents: `export * from './src/shared/plan-usage';
                 export { weekEstimate } from './src/shared/token-credit';
                 export * from './src/main/plan-usage-file';
                 export * from './src/renderer/services/usage-format';`,
    },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  });
  writeFileSync(join(tmp, 'm.mjs'), nodeBundle.outputFiles[0].text);
  const M = await import(pathToFileURL(join(tmp, 'm.mjs')).href);

  // ── (a) the parser
  await section('parser', async () => {
    const P = (j, now = NOW) => M.parsePlanUsage(j, now);
    check('parser: undefined, null, a number, a string, an array are no data',
      [undefined, null, 3, 'x', []].every((j) => P(j) === null));
    check('parser: an object without an accounts object is no data',
      P({}) === null && P({ accounts: [] }) === null && P({ accounts: 'x' }) === null);
    check('parser: another version is no data', P({ ...fixture(), version: 2 }) === null);
    check('parser: no version still reads', P({ accounts: {} })?.accounts.length === 0);

    const u = P(fixture());
    check('parser: four logins', u?.accounts.length === 4, u?.accounts.length);
    check('parser: live login first, then by last time live',
      JSON.stringify(u.accounts.map((a) => a.id)) === JSON.stringify(['38e237e1', 'bbbb2222', 'aaaa1111', 'cccc3333']), u.accounts.map((a) => a.id));
    check('parser: liveId and only one live', u.liveId === '38e237e1' && u.accounts.filter((a) => a.live).length === 1 && u.accounts[0].live);
    const [live, third, noMail, old] = u.accounts;
    check('parser: name is the email before @', live.name === 'michaeljrrushworth' && third.name === 'third');
    check('parser: no email names it "Login <first 4 of id>"', noMail.name === 'Login aaaa' && noMail.email === null, noMail);
    check('parser: plan kept, missing plan null', live.plan === 'Ultra' && old.plan === null);
    check('parser: week read', live.week?.pct === 63 && live.week.resetsAt === at(28, 12) && live.week.readAt === NOW && live.week.passed === false, live.week);
    check('parser: a null five_hour is null', live.fiveHour === null);
    check('parser: an absent five_hour is null', noMail.fiveHour === null);
    check('parser: a five_hour window read', third.fiveHour?.pct === 40 && third.fiveHour.resetsAt === at(24, 22));
    check('parser: a passed week shows 0% and passed', old.week?.passed === true && old.week.pct === 0 && old.week.resetsAt === at(24, 8), old.week);
    check('parser: a passed five-hour window is passed too', old.fiveHour?.passed === true && old.fiveHour.pct === 0);

    const bad = fixture();
    bad.accounts['bad!id'] = { email: 'x@y.z', seven_day: win(5, at(28, 1)) };
    bad.accounts.notobj = 'hello';
    bad.accounts.arr = [1, 2];
    bad.accounts.nullish = null;
    bad.accounts.badwin = {
      email: 42, plan: { x: 1 }, last_live: 'yesterday',
      seven_day: { used_percentage: '50', resets_at: at(28, 1) },
      five_hour: { used_percentage: 10, resets_at: 'soon' },
    };
    bad.accounts.over = { email: 'over@x', last_live: NOW - 10000, seven_day: { used_percentage: 140, resets_at: at(29, 1) }, five_hour: { used_percentage: -5, resets_at: at(24, 23), read_at: 'x' } };
    const ub = P(bad);
    const ids = ub.accounts.map((a) => a.id);
    check('parser: bad entries dropped, good ones kept', ids.length === 6 && !ids.includes('bad!id') && !ids.includes('notobj') && !ids.includes('arr') && !ids.includes('nullish'), ids);
    const bw = ub.accounts.find((a) => a.id === 'badwin');
    check('parser: wrong-typed fields read as absent', bw && bw.email === null && bw.plan === null && bw.lastLive === null && bw.week === null && bw.fiveHour === null && bw.name === 'Login badw', bw);
    check('parser: an entry with no last_live sorts after the dated ones', ids[ids.length - 1] === 'badwin', ids);
    const ov = ub.accounts.find((a) => a.id === 'over');
    check('parser: a percent over 100 is 100, under 0 is 0', ov.week.pct === 100 && ov.fiveHour.pct === 0, ov);
    check('parser: a non-number read_at is null', ov.fiveHour.readAt === null);

    const noLive = fixture();
    noLive.live = { account: 'ffffffff' };
    noLive.accounts['38e237e1'].last_live = NOW - 2000;
    const nl = P(noLive);
    check('parser: a live id with no account means no live login', nl.liveId === null && nl.accounts.every((a) => !a.live) && nl.accounts.map((a) => a.id).join() === 'bbbb2222,aaaa1111,38e237e1,cccc3333', nl.accounts.map((a) => a.id));

    const many = { accounts: {} };
    for (let i = 0; i < 20; i++) many.accounts[`id${String(i).padStart(2, '0')}`] = { last_live: 1000 + i, seven_day: win(i, at(28, 1)) };
    many.live = { account: 'id03' };
    const um = P(many);
    check('parser: capped at 12 logins', um.accounts.length === 12 && M.MAX_ACCOUNTS === 12, um.accounts.length);
    check('parser: the cap keeps the live login and the most recent', um.accounts[0].id === 'id03' && um.accounts[1].id === 'id19' && um.accounts[11].id === 'id09', um.accounts.map((a) => a.id));

    const later = M.planUsageAt(u, at(28, 12));
    check('planUsageAt: a reset that has come marks the window passed at 0%', later.accounts[0].week.passed && later.accounts[0].week.pct === 0 && !later.accounts[1].week.passed);
    check('planUsageAt: leaves the input alone', u.accounts[0].week.pct === 63 && !u.accounts[0].week.passed);

    check('format: 99.6 shows 99, 100 shows 100, 12.4 shows 12', M.shownPct(99.6) === 99 && M.shownPct(100) === 100 && M.shownPct(12.4) === 12);
    check('format: levels', M.usageLevel(79.4) === '' && M.usageLevel(80) === 'warn' && M.usageLevel(99) === 'warn' && M.usageLevel(100) === 'full');
    check('format: the colour follows the percent as shown (79.5 shows 80% and is amber; 99.6 shows 99 and is not red)',
      M.shownPct(79.5) === 80 && M.usageLevel(79.5) === 'warn' && M.usageLevel(79.49) === '' && M.usageLevel(99.6) === 'warn' && M.usageLevel(100.2) === 'full');

    // Out-of-range times (finding: 1e15 printed NaN, a millisecond epoch showed a reset 56,000 years away).
    const odd = (extra) => P({ accounts: { aaaa: { email: 'a@x', ...extra } } }).accounts[0];
    check('parser: a resets_at of 1e15 or in milliseconds drops the window', odd({ seven_day: win(50, 1e15) }).week === null && odd({ seven_day: win(50, NOW * 1000) }).week === null && odd({ five_hour: win(50, 1.795e12) }).fiveHour === null);
    check('parser: a resets_at beyond now + 8 days or before now - 30 days drops the window',
      odd({ seven_day: win(50, NOW + 8 * 86400 + 60) }).week === null && odd({ seven_day: win(50, NOW - 30 * 86400 - 60) }).week === null);
    check('parser: a resets_at just inside the range is kept (7 days ahead, 29 days back)',
      odd({ seven_day: win(50, NOW + 7 * 86400) }).week?.passed === false && odd({ seven_day: win(50, NOW - 29 * 86400) }).week?.passed === true);
    check('parser: a resets_at of 0 or a negative one is dropped', odd({ seven_day: win(50, 0) }).week === null && odd({ seven_day: win(50, -5) }).week === null);
    check('parser: a read_at before 2020 or over a day ahead is absent, not NaN',
      odd({ seven_day: win(50, at(28, 1), 5) }).week.readAt === null && odd({ seven_day: win(50, at(28, 1), NOW + 86400 + 60) }).week.readAt === null && odd({ seven_day: win(50, at(28, 1), 1e15) }).week.readAt === null);
    check('parser: a read_at in range is kept', odd({ seven_day: win(50, at(28, 1), NOW - 3600) }).week.readAt === NOW - 3600 && odd({ seven_day: win(50, at(28, 1), NOW + 3600) }).week.readAt === NOW + 3600);

    const protoLive = JSON.parse(`{"live":{"account":"__proto__"},"accounts":{"aaaa1111":{"last_live":5,"seven_day":{"used_percentage":5,"resets_at":${at(28, 1)}}}}}`);
    const pl = P(protoLive);
    check('parser: "__proto__" as the live id is no live login', pl.liveId === null && pl.accounts.every((a) => !a.live), pl.liveId);
    check('parser: "constructor" and "toString" as the live id are no live login too', ['constructor', 'toString', 'hasOwnProperty'].every((id) => P({ ...protoLive, live: { account: id } }).liveId === null));

    const twins = P({ accounts: {
      a1: { email: 'sam@one.com', last_live: 9 }, a2: { email: 'Sam@two.org', last_live: 8 },
      a3: { email: 'kim@one.com', last_live: 7 }, a4: { email: 'sam@one.com', last_live: 6 }, a5: { last_live: 5 },
    } });
    check('parser: equal email local parts show local@domain, only those',
      twins.accounts.map((a) => a.name).join('|') === 'sam@one.com (a1)|Sam@two.org|kim|sam@one.com (a4)|Login a5', twins.accounts.map((a) => a.name));
    // Finding 3: the same email twice, and no-email ids sharing their first 4 characters, still read apart.
    const alike = P({ accounts: {
      'ab12cd': { email: 'sam@one.com', last_live: 9 }, 'ab12ef': { email: 'sam@one.com', last_live: 8 },
      'zz990001': { last_live: 7 }, 'zz990002': { last_live: 6 }, 'q': { email: 'sam@two.org', last_live: 5 },
    } });
    const alikeNames = alike.accounts.map((a) => a.name);
    check('parser: the same email twice is told apart by the first 4 of id, more where those collide',
      alikeNames[0] === 'sam@one.com (ab12c)' && alikeNames[1] === 'sam@one.com (ab12e)' && alikeNames[4] === 'sam@two.org', alikeNames);
    check('parser: no-email logins sharing 4 id characters take as many as it takes',
      alikeNames[2] === 'Login zz990001' && alikeNames[3] === 'Login zz990002' && new Set(alikeNames.map((n) => n.toLowerCase())).size === 5, alikeNames);
    const sameFour = P({ accounts: { 'abcd1': { email: 'sam@one.com', last_live: 2 }, 'abcd2': { email: 'sam@one.com', last_live: 1 } } });
    check('parser: two ids sharing only 4 characters get 5', sameFour.accounts.map((a) => a.name).join('|') === 'sam@one.com (abcd1)|sam@one.com (abcd2)', sameFour.accounts.map((a) => a.name));
    check('parser: distinct local parts stay short', u.accounts.map((a) => a.name).join('|') === 'michaeljrrushworth|third|Login aaaa|d');
    check('format: day and time', M.dayTime(at(28, 12)) === 'Sat 12:00' && M.clockTime(at(24, 9, 5)) === '09:05', [M.dayTime(at(28, 12)), M.clockTime(at(24, 9, 5))]);
  });

  // ── (b) main's file reader
  await section('reader', async () => {
    const dir = join(tmp, 'plan-usage');
    const file = join(dir, 'accounts.json');
    let r = await M.readPlanUsage(file, NOW);
    check('reader: no folder, no file: empty, no problem', r.key === 'none' && r.usage.accounts.length === 0 && r.problem === null, r);
    mkdirSync(dir);
    writeFileSync(file, JSON.stringify(fixture()));
    r = await M.readPlanUsage(file, NOW);
    check('reader: a good file gives four logins', r.usage.accounts.length === 4 && r.problem === null && r.key !== 'none', r.problem);
    const key1 = r.key;
    writeFileSync(join(dir, 'accounts.json.tmp'), JSON.stringify({ ...fixture(), live: { account: 'aaaa1111' }, accounts: { ...fixture().accounts, extra: { seven_day: win(1, at(28, 1)) } } }));
    renameSync(join(dir, 'accounts.json.tmp'), file);
    const st = await M.statPlanUsage(file);
    check('reader: a replacement by rename changes the stat key', st.key !== key1, [st.key, key1]);
    r = await M.readPlanUsage(file, NOW);
    check('reader: the replaced file is read', r.usage.liveId === 'aaaa1111' && r.usage.accounts.length === 5);
    writeFileSync(file, '{"accounts": {');
    check('reader: not JSON is no data, "not-json"', (await M.readPlanUsage(file, NOW)).problem === 'not-json');
    writeFileSync(file, '[1,2]');
    check('reader: the wrong shape is no data, "wrong-shape"', (await M.readPlanUsage(file, NOW)).problem === 'wrong-shape');
    writeFileSync(file, ' '.repeat(M.PLAN_USAGE_SIZE_CAP + 1));
    r = await M.readPlanUsage(file, NOW);
    check('reader: over 256 KB is no data, "too-large"', r.problem === 'too-large' && r.usage.accounts.length === 0 && M.PLAN_USAGE_SIZE_CAP === 256 * 1024);
    // A same-size replacement with the old mtime copied is still a new file (ctime, inode).
    writeFileSync(file, '{"accounts":{"a":{}}}');
    const stA = statSync(file);
    const keyA = (await M.statPlanUsage(file)).key;
    writeFileSync(join(dir, 'same.tmp'), '{"accounts":{"b":{}}}');
    utimesSync(join(dir, 'same.tmp'), stA.atimeMs / 1000, stA.mtimeMs / 1000);
    renameSync(join(dir, 'same.tmp'), file);
    const stB = statSync(file);
    check('reader: the stat key moves for a same-size replacement with the mtime copied',
      stB.size === stA.size && Math.abs(stB.mtimeMs - stA.mtimeMs) < 1 && (await M.statPlanUsage(file)).key !== keyA, [keyA, (await M.statPlanUsage(file)).key]);
    check('reader: a failed read (not-json, unreadable) records no key; a missing or wrong-shape file does',
      M.isFailedRead({ key: '', usage: M.EMPTY_PLAN_USAGE, problem: 'not-json' }) && M.isFailedRead({ key: '', usage: M.EMPTY_PLAN_USAGE, problem: 'unreadable' })
      && !M.isFailedRead({ key: 'k', usage: M.EMPTY_PLAN_USAGE, problem: 'wrong-shape' }) && !M.isFailedRead({ key: 'none', usage: M.EMPTY_PLAN_USAGE, problem: null }));
    writeFileSync(file, '{"accounts": NaN}');
    r = await M.readPlanUsage(file, NOW);
    check('reader: a bare NaN is not JSON and gives no key', r.problem === 'not-json' && r.key === '', r);
    check('reader: a folder at the path is no file', (await M.readPlanUsage(dir, NOW)).key === 'none');
    // Finding 1: any stat error but a missing file is a failed read, never "no file".
    if (process.getuid && process.getuid() !== 0) {
      writeFileSync(file, JSON.stringify(fixture()));
      chmodSync(dir, 0o000);
      try {
        const sf = await M.statPlanUsage(file);
        const rf = await M.readPlanUsage(file, NOW);
        check('reader: a stat that fails with EACCES is a failed stat, not "none"', sf.failed === true && sf.key !== 'none', sf);
        check('reader: ... so the read is "unreadable", records no key and counts as failed',
          rf.problem === 'unreadable' && rf.key === '' && M.isFailedRead(rf) && rf.usage.accounts.length === 0, rf);
      } finally { chmodSync(dir, 0o755); }
    } else console.log('skip reader: EACCES stat (running as root)');
    // The ENOENT branch between the stat and the read: a file renamed away in between is "no data", not "unreadable".
    const realRead = fsp.readFile;
    writeFileSync(file, JSON.stringify(fixture()));
    try {
      fsp.readFile = async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
      const gone = await M.readPlanUsage(file, NOW);
      check('reader: a file gone between the stat and the read is no data (key none, no problem)', gone.key === 'none' && gone.problem === null && !M.isFailedRead(gone), gone);
      fsp.readFile = async () => { throw Object.assign(new Error('io'), { code: 'EIO' }); };
      const io = await M.readPlanUsage(file, NOW);
      check('reader: any other read error is "unreadable"', io.problem === 'unreadable' && io.key === '', io);
      // The second size check: the file grew between the stat (small) and the read.
      fsp.readFile = async () => Buffer.alloc(M.PLAN_USAGE_SIZE_CAP + 1, 32);
      const grew = await M.readPlanUsage(file, NOW);
      check('reader: a file that grew past the cap after the stat is "too-large", not parsed', grew.problem === 'too-large' && grew.usage.accounts.length === 0, grew);
    } finally { fsp.readFile = realRead; }
    const before = process.env.PATTON_PLAN_USAGE_FILE;
    process.env.PATTON_PLAN_USAGE_FILE = file;
    check('reader: PATTON_PLAN_USAGE_FILE overrides the path', M.planUsagePath() === file);
    delete process.env.PATTON_PLAN_USAGE_FILE;
    check('reader: the default path is ~/.claude/plan-usage/accounts.json', M.planUsagePath().endsWith(join('.claude', 'plan-usage', 'accounts.json')));
    if (before !== undefined) process.env.PATTON_PLAN_USAGE_FILE = before;
  });

  // ── (c) the panel in jsdom
  const domBundle = await build({
    stdin: {
      resolveDir: repo, loader: 'ts',
      contents: `export { UsagePanel, RAIL_MAX_BARS } from './src/renderer/components/usage-panel';
                 export { BookmarksPanel } from './src/renderer/components/bookmarks-panel';`,
    },
    bundle: true, format: 'iife', globalName: 'UP', platform: 'browser', write: false,
    loader: { '.css': 'empty' }, logLevel: 'silent', nodePaths: [join(repo, 'node_modules')],
  });
  const dom = new JSDOM('<!doctype html><html><body><nav id="side"><div class="bookmarks-list"></div><div class="bookmarks-resizer"></div></nav><button id="rail" title="Show bookmarks (⌃⌘B)"></button><div id="c"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const doc = w.document;
  const logs = [];
  let answers = [];
  let gets = 0;
  let push = null;
  w.patton = {
    bookmarks: { get: async () => [], set: async (l) => l, onChanged: () => () => {}, refresh: async () => [] },
    pageTitles: { get: async () => ({}), onChanged: () => () => {} },
    planUsage: {
      get: async () => answers[Math.min(gets++, answers.length - 1)] ?? null,
      onChanged: (cb) => { push = cb; return () => { push = null; }; },
    },
    log: { send: (lvl, args) => logs.push({ lvl, tag: String(args[0]), data: args[1] }) },
  };
  w.Element.prototype.scrollIntoView = () => {};
  w.eval(domBundle.outputFiles[0].text);
  const panelLogs = () => logs.filter((l) => l.tag === '[USAGE] panel');
  const parsed = M.parsePlanUsage(fixture(), NOW);

  await section('panel', async () => {
    answers = [M.EMPTY_PLAN_USAGE];
    const side = doc.getElementById('side');
    const rail = doc.getElementById('rail');
    let now = NOW;
    const p = new w.UP.UsagePanel({ parent: side, before: side.querySelector('.bookmarks-resizer'), rail, railTitle: rail.title, now: () => now });
    await sleep(20);
    const sec = side.querySelector('section.usage-panel');
    check('panel: a section labelled "Plan usage", between the list and the resizer',
      sec && sec.getAttribute('aria-label') === 'Plan usage' && sec.previousElementSibling?.classList.contains('bookmarks-list') && sec.nextElementSibling?.classList.contains('bookmarks-resizer'));
    check('panel: hidden with no logins', sec.hidden === true && sec.children.length === 0);
    check('rail: no bars and its plain title with no logins', rail.querySelector('.usage-rail').hidden === true && rail.title === 'Show bookmarks (⌃⌘B)', rail.title);

    p.setUsage(parsed);
    const blocks = () => [...sec.querySelectorAll('.usage-acct')];
    const txt = (b, s) => b.querySelector(s)?.textContent ?? null;
    check('panel: shown with logins', sec.hidden === false);
    check('panel: head "Usage this week" with the newest reading time', txt(sec, '.usage-head .usage-title') === 'Usage this week' && txt(sec, '.usage-head .usage-time') === '20:23', sec.querySelector('.usage-head')?.textContent);
    const b = blocks();
    check('panel: four logins in order', JSON.stringify(b.map((x) => x.dataset.account)) === JSON.stringify(['38e237e1', 'bbbb2222', 'aaaa1111', 'cccc3333']), b.map((x) => x.dataset.account));
    check('panel: the live login alone is bold-classed with a "live" tag',
      b[0].classList.contains('live') && txt(b[0], '.usage-tag') === 'live' && b.slice(1).every((x) => !x.classList.contains('live') && !x.querySelector('.usage-tag')));
    const tagEl = b[0].querySelector('.usage-tag');
    check('panel: the live tag is a sibling of the name, not inside it',
      tagEl && tagEl.parentElement === b[0].querySelector('.usage-acct-top') && !b[0].querySelector('.usage-name .usage-tag') && b[0].querySelector('.usage-name').children.length === 0
      && tagEl.previousElementSibling === b[0].querySelector('.usage-name'));
    check('panel: names', b.map((x) => x.querySelector('.usage-name').firstChild.textContent).join('|') === 'michaeljrrushworth|third|Login aaaa|d');
    check('panel: percents', b.map((x) => txt(x, '.usage-pct')).join('|') === '63%|85%|100%|0%', b.map((x) => txt(x, '.usage-pct')));
    check('panel: 63% is plain ink', !b[0].classList.contains('warn') && !b[0].classList.contains('full'));
    check('panel: 85% is amber', b[1].classList.contains('warn') && !b[1].classList.contains('full'));
    check('panel: 100% is red with "back"', b[2].classList.contains('full') && txt(b[2], '.usage-reset') === 'back Sat 08:00', txt(b[2], '.usage-reset'));
    check('panel: a week under way says "resets"', txt(b[0], '.usage-reset') === 'resets Sat 12:00' && txt(b[1], '.usage-reset') === 'resets Mon 09:00');
    check('panel: a passed week shows 0% and "reset"', txt(b[3], '.usage-reset') === 'reset Tue 08:00' && !b[3].classList.contains('warn'), txt(b[3], '.usage-reset'));
    const fill = (x) => x.querySelector(':scope > .usage-meter > i').style.width;
    check('panel: meter widths follow the week', b.map(fill).join('|') === '63%|85%|100%|0%', b.map(fill));
    check('panel: meters are aria-hidden', [...sec.querySelectorAll('.usage-meter')].every((m) => m.getAttribute('aria-hidden') === 'true'));
    check('panel: the 5-hour line only where a live 5-hour window exists',
      !!b[1].querySelector('.usage-five') && [0, 2, 3].every((i) => !b[i].querySelector('.usage-five')));
    check('panel: the 5-hour line reads "5-hour 40%", a 2 px meter, "22:00"',
      txt(b[1], '.usage-five-pct') === '5-hour 40%' && txt(b[1], '.usage-five-reset') === '22:00' && b[1].querySelector('.usage-five .usage-meter > i').style.width === '40%');
    const label = b[0].getAttribute('aria-label');
    check('panel: each block is a group whose name and tooltip carry the detail',
      b[0].getAttribute('role') === 'group' && label === b[0].title && label.includes('michaeljrrushworth@gmail.com') && label.includes('Ultra') && label.includes('63%') && label.includes('resets Sat 12:00') && label.includes('read 20:23'), label);
    check('panel: the 5-hour figure is in that login\'s detail', b[1].title.includes('5-hour 40%, resets 22:00'), b[1].title);
    check('panel: no token figure anywhere', !/token/i.test(sec.textContent));
    check('panel: one "[USAGE] panel" log line per content change', panelLogs().length === 2 && panelLogs()[1].data?.accounts === 4 && panelLogs()[1].data?.live === '38e237e1', panelLogs());
    p.setUsage(M.parsePlanUsage(fixture(), NOW));
    check('panel: the same content again logs nothing', panelLogs().length === 2);

    const bars = [...rail.querySelectorAll('.usage-rail .usage-rail-bar')];
    check('rail: one bar per login, live first', bars.length === 4 && bars[0].dataset.account === '38e237e1', bars.map((x) => x.dataset.account));
    check('rail: heights follow the week', bars.map((x) => x.querySelector('i').style.height).join('|') === '63%|85%|100%|0%');
    check('rail: same colours', bars[1].classList.contains('warn') && bars[2].classList.contains('full') && !bars[0].classList.contains('warn'));
    check('rail: bars are aria-hidden and the rail stays one button', rail.querySelector('.usage-rail').getAttribute('aria-hidden') === 'true' && rail.querySelectorAll('button').length === 0);
    check('rail: the tooltip carries the figures',
      rail.title === 'Show bookmarks (⌃⌘B) — michaeljrrushworth 63%, third 85%, Login aaaa 100%, d 0%', rail.title);

    // The minute's re-draw: Sat 12:00 passes, the live login's week starts over.
    now = at(28, 12, 1);
    p.render();
    const live = blocks()[0];
    check('re-draw: a reset that passed shows 0% and "reset"', txt(live, '.usage-pct') === '0%' && txt(live, '.usage-reset') === 'reset Sat 12:00', [txt(live, '.usage-pct'), txt(live, '.usage-reset')]);
    check('re-draw: the 5-hour line whose reset passed is gone', !blocks()[1].querySelector('.usage-five'));
    check('re-draw: logs nothing (no new content)', panelLogs().length === 2);

    // Text is text: an email that looks like HTML.
    const evil = fixture();
    evil.accounts['38e237e1'].email = '<img src=x onerror=alert(1)>@x.com';
    p.setUsage(M.parsePlanUsage(evil, NOW));
    check('panel: names are text, never HTML', !sec.querySelector('img') && sec.querySelector('.usage-name').firstChild.textContent === '<img src=x onerror=alert(1)>');

    // Many logins: the rail keeps to its width; the tooltip names all of them.
    const many = { accounts: {} };
    for (let i = 0; i < 9; i++) many.accounts[`id${i}`] = { email: `u${i}@x`, last_live: 100 - i, seven_day: win(10 * i, at(30, 1)) };
    p.setUsage(M.parsePlanUsage(many, NOW));
    check('rail: at most RAIL_MAX_BARS bars', rail.querySelectorAll('.usage-rail-bar').length === w.UP.RAIL_MAX_BARS && w.UP.RAIL_MAX_BARS === 5);
    check('rail: the tooltip still names every login', rail.title.includes('u0 0%') && rail.title.includes('u8 80%'), rail.title);
    check('panel: every login is drawn in the panel', blocks().length === 9);

    p.setUsage(M.EMPTY_PLAN_USAGE);
    check('panel: no logins again hides it and clears the rail', sec.hidden && rail.querySelector('.usage-rail').hidden && rail.title === 'Show bookmarks (⌃⌘B)');
    p.dispose();
    check('dispose: panel and rail bars removed', !side.querySelector('.usage-panel') && !rail.querySelector('.usage-rail'));
  });

  // The week's token count (main/token-scan.ts): drawn before the reset, in full in the tooltip.
  await section('panel-tokens', async () => {
    answers = [M.EMPTY_PLAN_USAGE];
    const side = doc.getElementById('side');
    const rail = doc.getElementById('rail');
    let now = NOW;
    const p = new w.UP.UsagePanel({ parent: side, before: side.querySelector('.bookmarks-resizer'), rail, railTitle: rail.title, now: () => now });
    await sleep(20);
    const sec = side.querySelector('section.usage-panel');
    const withTokens = (tokensFor) => {
      const u = JSON.parse(JSON.stringify(parsed));
      for (const a of u.accounts) a.weekTokens = tokensFor(a) ?? null;
      return u;
    };
    const live = (u) => u.accounts.find((a) => a.id === '38e237e1');
    const tue = at(24, 20, 22);
    // Main joins each count with its estimate (plan-usage-ipc.ts withTokens); here it is made the same way.
    const est = (t, pct, p0 = null) => ({ ...t, estimate: M.weekEstimate(t, pct, p0) });
    const u1 = withTokens((a) => a.id === '38e237e1' ? est({ tokens: 2_912_345_678, complete: true, since: null, resetsAt: a.week.resetsAt }, a.week.pct)
      : a.id === 'bbbb2222' ? est({ tokens: 412_345_678, complete: false, since: tue, resetsAt: a.week.resetsAt }, a.week.pct, 60)
      : a.id === 'aaaa1111' ? est({ tokens: 0, complete: false, since: tue, resetsAt: a.week.resetsAt }, a.week.pct, 61)
      : a.id === 'cccc3333' ? est({ tokens: 5, complete: true, since: null, resetsAt: a.week.resetsAt }, a.week.pct) : null);
    p.setUsage(u1);
    const block = (id) => sec.querySelector(`.usage-acct[data-account="${id}"]`);
    const sub = (id) => block(id)?.querySelector('.usage-reset')?.textContent;
    check('tokens: a complete count, "<used> of <allowance> bn" before the reset', sub('38e237e1') === '2.9 of 4.6 bn · resets Sat 12:00', sub('38e237e1'));
    check('tokens: a partial count from its rise (412M over 85 − 60 points: 1.4 of 1.6 bn)', sub('bbbb2222') === '1.4 of 1.6 bn · resets Mon 09:00', sub('bbbb2222'));
    check('tokens: a used-up login with no tokens keeps the reset alone', sub('aaaa1111') === 'back Sat 08:00', sub('aaaa1111'));
    check('tokens: a passed week shows no count', sub('cccc3333') === 'reset Tue 08:00', sub('cccc3333'));
    const subs = [...sec.querySelectorAll('.usage-reset')].map((x) => x.textContent);
    check('tokens: no sub line holds "≥", "~" or "since"', subs.length === 4 && subs.every((t) => !/[≥~]|since/.test(t)), subs);
    const title = block('38e237e1').title;
    check('tokens: the tooltip and accessible name say the figures are an estimate and from what, then what the count is',
      title.includes('about 2.9 of 4.6 bn tokens this week, estimated from 2.9 bn counted this week at 63%; the count is what Claude Code recorded while this login was live (from Sat 12:00)')
      && title.includes('approximate around switches') && title.includes('cached re-reads included') && block('38e237e1').getAttribute('aria-label') === title, title);
    const partTitle = block('bbbb2222').title;
    check('tokens: a partial tooltip gives the count since the first switch and the week\'s rise', partTitle.includes('about 1.4 of 1.6 bn tokens this week, estimated from 412M counted since Tue 20:22 while the week rose from 60% to 85%') && partTitle.includes('approximate around switches'), partTitle);
    check('tokens: a fresh count names no count time', !title.includes('tokens counted at'), title);
    check('rail: the hidden sidebar\'s tooltip gives each estimate and what it comes from, and none where there is none',
      rail.title.includes('michaeljrrushworth 63% (about 2.9 of 4.6 bn tokens this week, estimated from 2.9 bn counted this week at 63%)')
      && rail.title.includes('third 85% (about 1.4 of 1.6 bn tokens this week, estimated from 412M counted since Tue 20:22 while the week rose from 60% to 85%)')
      && rail.title.includes('Login aaaa 100%, ') && !/Login aaaa 100% \(/.test(rail.title) && rail.title.endsWith('d 0%'), rail.title);
    // Two spans, each unbreakable by CSS, so a narrow sidebar wraps only between them.
    const spans = [...block('38e237e1').querySelectorAll('.usage-reset > span')].map((x) => [x.className, x.textContent]);
    check('tokens: the sub line is a token span and a reset span', JSON.stringify(spans) === JSON.stringify([['usage-tokens', '2.9 of 4.6 bn ·'], ['usage-when', 'resets Sat 12:00']]), spans);
    check('tokens: a login with no estimate has the reset span alone', [...block('aaaa1111').querySelectorAll('.usage-reset > span')].map((x) => x.className).join() === 'usage-when');
    const css = readFileSync(join(repo, 'src/renderer/styles/main.css'), 'utf8');
    check('tokens: both spans are white-space: nowrap in the stylesheet', /\.usage-reset \.usage-tokens,\s*\.usage-reset \.usage-when\s*\{[^}]*white-space:\s*nowrap/.test(css));
    // A count more than 5 minutes old says when it was counted.
    const stale = JSON.parse(JSON.stringify(u1));
    live(stale).weekTokens.countedAt = at(24, 20, 5);
    p.setUsage(stale);
    check('tokens: a stale count names its time in the tooltip, the sub line unchanged', block('38e237e1').title.includes('; tokens counted at 20:05') && sub('38e237e1') === '2.9 of 4.6 bn · resets Sat 12:00', block('38e237e1').title);
    p.setUsage(u1);

    // A new count re-draws; the same count does not touch the DOM.
    const before = sec.querySelector('.usage-acct');
    p.setUsage(JSON.parse(JSON.stringify(u1)));
    check('tokens: the same counts leave the DOM alone', sec.querySelector('.usage-acct') === before);
    const u2 = JSON.parse(JSON.stringify(u1));
    live(u2).weekTokens = est({ ...live(u2).weekTokens, tokens: 3_012_345_678 }, 63);
    p.setUsage(u2);
    check('tokens: a new count re-draws', sub('38e237e1') === '3.0 of 4.8 bn · resets Sat 12:00', sub('38e237e1'));
    const u3 = JSON.parse(JSON.stringify(u2));
    live(u3).weekTokens.resetsAt -= 7 * 86400;
    p.setUsage(u3);
    check('tokens: a count for another week is not shown', sub('38e237e1') === 'resets Sat 12:00', sub('38e237e1'));
    p.setUsage(u2);
    now = at(28, 12, 1); // the live login's week resets
    p.render();
    check('tokens: once the week passes on the clock, its count goes', sub('38e237e1') === 'reset Sat 12:00', sub('38e237e1'));
    check('tokens: usageIdentity leaves token counts out (they have their own log line)', M.usageIdentity(u1) === M.usageIdentity(u2) && M.usageIdentity(u1) === M.usageIdentity(parsed));
    p.dispose();
  });

  // Mounted by the real BookmarksPanel: a refused first answer is asked again; a push re-draws.
  await section('bookmarks', async () => {
    answers = [null, parsed];
    gets = 0;
    const host = { getTabs: () => [], getActiveTab: () => null, switchToTab() {}, createTab: async () => ({}), listSessions: () => [], goToSession: () => false, focusTerminal() {} };
    const bp = new w.UP.BookmarksPanel(doc.getElementById('c'), host);
    await sleep(50);
    const nav = doc.getElementById('bookmarks-panel');
    const sec = nav.querySelector('.usage-panel');
    const rail = doc.getElementById('bookmarks-rail');
    check('bookmarks: the panel sits after the list, before the resizer',
      sec && sec.previousElementSibling?.classList.contains('bookmarks-list') && sec.nextElementSibling?.classList.contains('bookmarks-resizer'));
    check('bookmarks: a refused first answer leaves it hidden', gets === 1 && sec.hidden);
    await sleep(2300);
    check('bookmarks: asked once more, the answer is drawn', gets === 2 && !sec.hidden && sec.querySelectorAll('.usage-acct').length === 4, { gets });
    check('bookmarks: the rail has its bars and figures', rail.querySelectorAll('.usage-rail-bar').length === 4 && rail.title.startsWith('Show bookmarks (') && rail.title.includes(' — michaeljrrushworth 63%'), rail.title);
    const next = fixture();
    next.accounts['38e237e1'].seven_day.used_percentage = 81;
    push(M.parsePlanUsage(next, NOW));
    check('bookmarks: a push re-draws', sec.querySelector('.usage-acct .usage-pct').textContent === '81%' && sec.querySelector('.usage-acct').classList.contains('warn'));
    bp.dispose();
    check('bookmarks: dispose unsubscribes and removes', push === null && !doc.querySelector('.usage-panel'));
  });

  // ── (d) wiring and styles (read as text: jsdom does no layout)
  await section('wiring', async () => {
    const read = (p) => readFileSync(join(repo, p), 'utf8');
    const constants = read('src/shared/constants.ts');
    check('wiring: the two channels', constants.includes("PLAN_USAGE_GET: 'plan-usage:get'") && constants.includes("PLAN_USAGE_CHANGED: 'plan-usage:changed'"));
    const preload = read('src/preload/preload.ts');
    check('wiring: preload exposes get and onChanged', /planUsage:\s*{[\s\S]*?IPC\.PLAN_USAGE_GET[\s\S]*?IPC\.PLAN_USAGE_CHANGED/.test(preload));
    check('wiring: handlers registered', read('src/main/ipc-handlers.ts').includes('registerPlanUsageHandlers();'));
    const main = read('src/main/main.ts');
    check('wiring: the poll stops on quit', /before-quit[\s\S]*stopPlanUsagePoll\(\)/.test(main));
    const ipc = read('src/main/plan-usage-ipc.ts');
    check('wiring: the get is rate-limited and answers null when refused', /getLimiter\.allow\(\)[\s\S]*?return null/.test(ipc));
    check('wiring: a failed read neither records its key nor pushes', /readKey = read\.key;\s*if \(isFailedRead\(read\)\) return;/.test(ipc));
    check('wiring: polled by stat every 10 s', ipc.includes('POLL_MS = 10 * 1000') && ipc.includes('setInterval'));
    const css = read('src/renderer/styles/main.css');
    check('css: the hidden panel is display: none (its display: grid would otherwise show it)', /\.usage-panel\[hidden\]\s*{\s*display:\s*none;?\s*}/.test(css));
    check('css: the panel keeps 4 px off the resize handle, as the bookmarks list does', /\.usage-panel\s*{[^}]*margin-right:\s*4px/.test(css) && /\.bookmarks-list\s*{[^}]*margin-right:\s*4px/.test(css));
    const rule = (sel) => { const i = css.indexOf(`${sel} {`); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
    check('css: the panel yields to the bookmarks (max-height 40%, scrolls) and uses the mock\'s 10 px sides',
      /max-height: 40%/.test(rule('.usage-panel')) && /overflow-y: auto/.test(rule('.usage-panel')) && /var\(--ui-scale\)\) 10px calc/.test(rule('.usage-panel')), rule('.usage-panel'));
    check('css: only the name truncates (the tag and percent do not shrink)',
      /overflow: hidden/.test(rule('.usage-name')) && /min-width: 0/.test(rule('.usage-name')) && /flex-shrink: 0/.test(rule('.usage-tag')) && /flex-shrink: 0/.test(rule('.usage-pct')));
    check('css: a hairline above the panel', rule('.usage-panel').includes('border-top: 1px solid var(--hairline)'));
    check('css: ink meters, amber and red fills', rule('.usage-meter > i').includes('var(--ink)') && /\.usage-acct\.warn > \.usage-meter > i,[^{]*{\s*background: var\(--amber\)/.test(css) && /\.usage-acct\.full > \.usage-meter > i,[^{]*{\s*background: var\(--red\)/.test(css));
    check('css: amber and red percents use the text tokens', /\.usage-acct\.warn \.usage-pct,[^{]*{\s*color: var\(--amber-text\)/.test(css) && /\.usage-acct\.full \.usage-pct,[^{]*{\s*color: var\(--error-text\)/.test(css));
    check('css: "Usage" wears the shared head style', /\.usage-title,[\s\S]*?text-transform: uppercase/.test(css.slice(css.indexOf('Shared head type'))));
    check('css: sizes follow --ui-scale', rule('.usage-panel').includes('var(--ui-scale)') && rule('.usage-tag').includes('var(--ui-scale)'));
    const block = css.slice(css.indexOf('--- Plan usage'), css.indexOf('/* Drag handle'));
    check('css: no colour literals in the usage styles (tokens only)', !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block));
  });
  // ── (e) main's IPC module, behaviourally: bundled with an electron stub, polled by hand
  await section('ipc', async () => {
    writeFileSync(join(tmp, 'electron-stub.mjs'), `
      const g = (globalThis.__electronStub ??= { handlers: new Map(), windows: [] });
      export const ipcMain = { handle: (ch, fn) => { g.handlers.set(ch, fn); } };
      export const BrowserWindow = { getAllWindows: () => g.windows };
    `);
    const ipcBundle = await build({
      stdin: {
        resolveDir: repo, loader: 'ts',
        contents: `export * from './src/main/plan-usage-ipc'; export { IPC } from './src/shared/constants';`,
      },
      bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
      alias: { electron: join(tmp, 'electron-stub.mjs') },
    });
    writeFileSync(join(tmp, 'ipc.mjs'), ipcBundle.outputFiles[0].text);
    const stub = (globalThis.__electronStub ??= { handlers: new Map(), windows: [] });
    let loads = 0;
    const loadFresh = async () => { stub.handlers.clear(); return import(`${pathToFileURL(join(tmp, 'ipc.mjs')).href}?v=${++loads}`); };

    const sent = [];
    const fakeWin = (destroyed = false) => ({ isDestroyed: () => destroyed, webContents: { isDestroyed: () => false, send: (ch, data) => sent.push({ ch, data }) } });
    stub.windows = [fakeWin(), fakeWin(), fakeWin(true)];

    const logsMain = [];
    const realInfo = console.info, realWarn = console.warn;
    console.info = (...a) => logsMain.push(['info', ...a]);
    console.warn = (...a) => logsMain.push(['warn', ...a]);
    const realSI = globalThis.setInterval, realCI = globalThis.clearInterval;
    const realReadFile = fsp.readFile;
    let reads = 0;
    fsp.readFile = (...a) => { reads++; return realReadFile.apply(fsp, a); };
    const timers = { fn: null, ms: null, handle: null, cleared: [] };
    globalThis.setInterval = (fn, ms) => { timers.fn = fn; timers.ms = ms; timers.handle = { unref() {} }; return timers.handle; };
    globalThis.clearInterval = (h) => { timers.cleared.push(h); };
    const dir = join(tmp, 'ipc-usage');
    const file = join(dir, 'accounts.json');
    const before = process.env.PATTON_PLAN_USAGE_FILE;
    process.env.PATTON_PLAN_USAGE_FILE = file;
    const replace = (text, mode) => { const t = `${file}.tmp`; writeFileSync(t, text); if (mode !== undefined) chmodSync(t, mode); renameSync(t, file); };
    try {
      mkdirSync(dir);
      writeFileSync(file, JSON.stringify(fixture()));
      const I = await loadFresh();
      I.registerPlanUsageHandlers();
      await I.pollPlanUsageOnce();
      const get = stub.handlers.get(I.IPC.PLAN_USAGE_GET);
      const pushes = () => sent.filter((x) => x.ch === I.IPC.PLAN_USAGE_CHANGED);
      const marks = () => ({ pushes: pushes().length, logs: logsMain.length, reads });

      check('ipc: the get handler and a 10 s poll timer are registered', typeof get === 'function' && timers.ms === 10000 && timers.fn !== null, timers.ms);
      check('ipc: the first poll pushes once to each live window (not the destroyed one) and logs one "[USAGE] read"',
        pushes().length === 2 && pushes()[0].data.accounts.length === 4 && logsMain.filter((l) => l[1] === '[USAGE] read').length === 1, marks());
      let m = marks();
      await I.pollPlanUsageOnce();
      await I.pollPlanUsageOnce();
      check('ipc: unchanged polls push nothing, log nothing and do not read the file', JSON.stringify(marks()) === JSON.stringify(m), [m, marks()]);

      // A changed file, polled through the real timer callback.
      const next = fixture();
      next.live = { account: 'aaaa1111' };
      replace(JSON.stringify(next));
      m = marks();
      timers.fn();
      await I.pollPlanUsageOnce();
      check('ipc: a changed file pushes once to each window (through the timer callback)', pushes().length === m.pushes + 2 && pushes().at(-1).data.liveId === 'aaaa1111' && marks().reads === m.reads + 1, [m, marks()]);
      const good = (await get()).liveId;
      check('ipc: the get answers the last reading', good === 'aaaa1111', good);

      // Same content, new file (a rewrite): read, but no push and no log.
      replace(JSON.stringify(next));
      m = marks();
      await I.pollPlanUsageOnce();
      check('ipc: a rewrite with the same content is read but pushes and logs nothing', marks().reads === m.reads + 1 && marks().pushes === m.pushes && marks().logs === m.logs, [m, marks()]);

      // Finding 2: the producer re-stamps read_at on every status line: a push so the clock moves, but no log.
      const stamped = JSON.parse(JSON.stringify(next));
      for (const acct of Object.values(stamped.accounts)) for (const k of ['seven_day', 'five_hour']) if (acct[k]) acct[k].read_at += 60;
      replace(JSON.stringify(stamped));
      m = marks();
      const readLogs = () => logsMain.filter((l) => l[1] === '[USAGE] read').length;
      const readLogsBefore = readLogs();
      await I.pollPlanUsageOnce();
      check('ipc: a rewrite that only moves read_at is pushed (the clock moves) but logs no "[USAGE] read"',
        marks().pushes === m.pushes + 2 && readLogs() === readLogsBefore && marks().logs === m.logs, [m, marks()]);
      stamped.accounts.aaaa1111.seven_day.used_percentage = 77;
      replace(JSON.stringify(stamped));
      await I.pollPlanUsageOnce();
      check('ipc: a changed figure does log "[USAGE] read"', readLogs() === readLogsBefore + 1);

      const unreadableWarns = () => logsMain.filter((l) => l[0] === 'warn' && l[1] === '[USAGE] no data' && l[2]?.reason === 'unreadable').length;
      let warnsBefore = 0;
      // Finding 1: the folder unreadable (EACCES on the stat) keeps the reading, never pushes an empty list, reads again.
      if (process.getuid && process.getuid() !== 0) {
        warnsBefore = unreadableWarns();
        chmodSync(dir, 0o000);
        m = marks();
        try {
          await I.pollPlanUsageOnce();
          await I.pollPlanUsageOnce();
          const got = await get();
          check('ipc: an unreadable folder pushes nothing and keeps every login', marks().pushes === m.pushes && got.accounts.length === 4 && got.liveId === 'aaaa1111', [m, marks(), got.accounts.length]);
          check('ipc: ... with one "unreadable" warning', unreadableWarns() === warnsBefore + 1, unreadableWarns() - warnsBefore);
        } finally { chmodSync(dir, 0o755); }
        m = marks();
        await I.pollPlanUsageOnce();
        check('ipc: the mended folder is read again (same content: no push, 4 logins)', marks().reads === m.reads + 1 && marks().pushes === m.pushes && (await get()).accounts.length === 4, [m, marks()]);
      }

      // Unreadable (chmod 000): keeps the reading, reads again each poll, mended on chmod.
      if (process.getuid && process.getuid() !== 0) {
        chmodSync(file, 0o000);
        m = marks();
        await I.pollPlanUsageOnce();
        const afterFirst = marks();
        await I.pollPlanUsageOnce();
        await I.pollPlanUsageOnce();
        const afterThree = marks();
        check('ipc: an unreadable file pushes nothing and the get still answers the last good reading', marks().pushes === m.pushes && (await get()).liveId === 'aaaa1111' && (await get()).accounts.length === 4);
        check('ipc: an unreadable file is tried again on every poll (its key is not remembered)', afterFirst.reads === m.reads + 1 && afterThree.reads === m.reads + 3, [m, afterFirst, afterThree]);
        check('ipc: the "no data" warning is logged once for the unreadable file (after the folder\'s one, which the mend reset)', unreadableWarns() === warnsBefore + 2, [warnsBefore, unreadableWarns()]);
        chmodSync(file, 0o644);
        m = marks();
        await I.pollPlanUsageOnce();
        check('ipc: mended permissions are read again (same content: no push)', marks().reads === m.reads + 1 && marks().pushes === m.pushes && (await get()).liveId === 'aaaa1111', [m, marks()]);
        await I.pollPlanUsageOnce();
        check('ipc: ... and then it is quiet again', marks().reads === m.reads + 1);
      } else {
        console.log('skip ipc: unreadable file (running as root)');
      }

      // Corrupt (a bare NaN, as Python's json.dumps can write): keeps the last good reading.
      replace('{"version": 1, "accounts": {"x": {"seven_day": {"used_percentage": NaN}}}}');
      m = marks();
      await I.pollPlanUsageOnce();
      await I.pollPlanUsageOnce();
      const afterCorrupt = marks();
      const kept = await get();
      check('ipc: a corrupt file pushes nothing and keeps the last good reading', afterCorrupt.pushes === m.pushes && kept.liveId === 'aaaa1111' && kept.accounts.length === 4, [m, marks()]);
      check('ipc: a corrupt file is read again each poll', afterCorrupt.reads === m.reads + 2, [m, afterCorrupt]);
      check('ipc: ... with one "not-json" warning', logsMain.filter((l) => l[0] === 'warn' && l[2]?.reason === 'not-json').length === 1);
      const fixed = fixture();
      fixed.live = { account: 'bbbb2222' };
      replace(JSON.stringify(fixed));
      m = marks();
      await I.pollPlanUsageOnce();
      check('ipc: the repaired file is read and pushed', marks().pushes === m.pushes + 2 && pushes().at(-1).data.liveId === 'bbbb2222', [m, marks()]);

      // Missing file: no data, an empty list.
      unlinkSync(file);
      m = marks();
      await I.pollPlanUsageOnce();
      check('ipc: a missing file pushes an empty list', marks().pushes === m.pushes + 2 && pushes().at(-1).data.accounts.length === 0 && (await get()).accounts.length === 0);

      // Stop clears the timer, and only once.
      const clearedBefore = timers.cleared.length;
      I.stopPlanUsagePoll();
      I.stopPlanUsagePoll();
      check('ipc: stop clears the poll timer once', timers.cleared.length === clearedBefore + 1 && timers.cleared.at(-1) === timers.handle, timers.cleared.length - clearedBefore);

      // Finding 1, from a cold start: the first poll finds the folder unreadable (its failed key is the initial one,
      // so only the failed flag makes it read, warn and answer an empty list rather than skip the poll).
      writeFileSync(file, JSON.stringify(fixture()));
      if (process.getuid && process.getuid() !== 0) {
        const C = await loadFresh();
        const warnsBeforeCold = unreadableWarns();
        const pushesBeforeCold = pushes().length;
        chmodSync(dir, 0o000);
        try {
          C.registerPlanUsageHandlers(); // starts its first poll at once
          await C.pollPlanUsageOnce();
          check('ipc: a cold start on an unreadable folder warns "unreadable" (the poll is not skipped as unchanged)', unreadableWarns() === warnsBeforeCold + 1, unreadableWarns() - warnsBeforeCold);
        } finally { chmodSync(dir, 0o755); }
        await C.pollPlanUsageOnce();
        check('ipc: ... and once mended the file is read and pushed', pushes().length > pushesBeforeCold && (await stub.handlers.get(C.IPC.PLAN_USAGE_GET)()).accounts.length === 4);
        C.stopPlanUsagePoll();
      }

      // Rate limit, in a fresh module instance.
      const R = await loadFresh();
      R.registerPlanUsageHandlers();
      await R.pollPlanUsageOnce();
      const rget = stub.handlers.get(R.IPC.PLAN_USAGE_GET);
      const answers = [];
      for (let i = 0; i < 24; i++) answers.push(await rget());
      check('ipc: the first 20 gets in a second are answered, the rest null',
        answers.slice(0, 20).every((a) => a && a.accounts.length === 4) && answers.slice(20).every((a) => a === null), answers.map((a) => (a ? 1 : 0)).join(''));
      check('ipc: the refusal is logged as a security warning', logsMain.some((l) => l[0] === 'warn' && String(l[1]).startsWith('[SECURITY]')));
      R.stopPlanUsagePoll();
    } finally {
      console.info = realInfo; console.warn = realWarn;
      globalThis.setInterval = realSI; globalThis.clearInterval = realCI;
      fsp.readFile = realReadFile;
      if (before === undefined) delete process.env.PATTON_PLAN_USAGE_FILE; else process.env.PATTON_PLAN_USAGE_FILE = before;
    }
  });

  // ── (g) the second review's panel findings
  await section('panel-review2', async () => {
    const side = doc.getElementById('side');
    const rail = doc.getElementById('rail');
    let now = NOW;
    const p = new w.UP.UsagePanel({ parent: side, before: side.querySelector('.bookmarks-resizer'), rail, railTitle: rail.title, now: () => now });
    await sleep(10);
    const sec = side.querySelector('section.usage-panel');
    p.setUsage(M.parsePlanUsage(fixture(), NOW));

    // Finding 2: a new read_at alone moves the clock, but rebuilds nothing when the drawn text is the same, and logs nothing.
    const first = sec.querySelector('.usage-acct');
    const stampedSame = fixture();
    for (const acct of Object.values(stampedSame.accounts)) for (const k of ['seven_day', 'five_hour']) if (acct[k]) acct[k].read_at += 5; // same minute (20:23)
    const logsN = panelLogs().length;
    let mutations = 0;
    const mo = new w.MutationObserver((list) => { mutations += list.length; });
    mo.observe(side, { childList: true, subtree: true, attributes: true, characterData: true });
    p.setUsage(M.parsePlanUsage(stampedSame, NOW));
    await sleep(5);
    check('review2: a read_at that changes no drawn text leaves the DOM alone (the same nodes, no mutation)', sec.querySelector('.usage-acct') === first && mutations === 0, mutations);
    check('review2: ... and logs no "[USAGE] panel"', panelLogs().length === logsN);
    const stampedMinute = fixture();
    for (const acct of Object.values(stampedMinute.accounts)) for (const k of ['seven_day', 'five_hour']) if (acct[k]) acct[k].read_at += 120;
    p.setUsage(M.parsePlanUsage(stampedMinute, NOW + 120));
    check('review2: a read_at two minutes on moves the clock in the head, still without a log', sec.querySelector('.usage-time').textContent === '20:25' && panelLogs().length === logsN, [sec.querySelector('.usage-time').textContent, panelLogs().length - logsN]);
    const moved = fixture();
    moved.accounts.bbbb2222.seven_day.used_percentage = 50;
    p.setUsage(M.parsePlanUsage(moved, NOW));
    check('review2: a changed figure logs "[USAGE] panel" and redraws', panelLogs().length === logsN + 1 && sec.querySelectorAll('.usage-pct')[1].textContent === '50%');
    mo.disconnect();

    // Finding 6, lastDrawn: the minute's tick on an unchanged panel touches nothing.
    now = NOW + 30;
    const stable = sec.querySelector('.usage-acct');
    const mo2 = new w.MutationObserver((list) => { mutations += list.length; });
    mutations = 0;
    mo2.observe(side, { childList: true, subtree: true, attributes: true, characterData: true });
    p.render();
    p.render();
    await sleep(5);
    mo2.disconnect();
    check('review2: a re-draw that would draw the same leaves the nodes alone (lastDrawn)', sec.querySelector('.usage-acct') === stable && mutations === 0, mutations);

    // Finding 4: a widened name is not repeated by the email in the detail.
    const dup = M.parsePlanUsage({ live: { account: 'ab12cd' }, accounts: {
      'ab12cd': { email: 'sam@one.com', plan: 'Ultra', last_live: 9, seven_day: win(10, at(28, 1)) },
      'ab12ef': { email: 'sam@one.com', last_live: 8, seven_day: win(20, at(28, 1)) },
      'solo': { email: 'kim@one.com', plan: 'Pro', last_live: 7, seven_day: win(30, at(28, 1)) },
    } }, NOW);
    p.setUsage(dup);
    const bl = [...sec.querySelectorAll('.usage-acct')];
    check('review2: two logins with one email read apart on screen', bl[0].querySelector('.usage-name').textContent !== bl[1].querySelector('.usage-name').textContent
      && bl[0].querySelector('.usage-name').textContent === 'sam@one.com (ab12c)', bl.map((b) => b.querySelector('.usage-name').textContent));
    check('review2: a name that holds the email does not repeat it in the detail', bl[0].title.startsWith('sam@one.com (ab12c) (live), Ultra: ') && !/sam@one\.com.*sam@one\.com/.test(bl[1].title.split(':')[0]), [bl[0].title, bl[1].title]);
    check('review2: a short name still shows its email in the detail', bl[2].title.startsWith('kim, kim@one.com, Pro: '), bl[2].title);

    // Finding 7: a login with no window reads "no recent reading", also when its week ended long ago.
    const oldWeek = M.parsePlanUsage({ accounts: {
      stale: { email: 'old@x.com', last_live: 5, seven_day: win(50, NOW - 40 * 86400, NOW - 41 * 86400) },
      fresh: { email: 'new@x.com', last_live: 4 },
    } }, NOW);
    p.setUsage(oldWeek);
    const ob = [...sec.querySelectorAll('.usage-acct')];
    check('review2: a login whose week ended over 30 days ago reads "no recent reading"', ob[0].querySelector('.usage-reset').textContent === 'no recent reading' && ob[0].title.includes('no recent weekly reading'), [ob[0].querySelector('.usage-reset').textContent, ob[0].title]);
    check('review2: a login with no week at all reads the same', ob[1].querySelector('.usage-reset').textContent === 'no recent reading');
    check('review2: nobody says "reading yet" any more', !/reading yet/.test(sec.textContent + ob[0].title));
    p.dispose();
  });

  // ── (f) the panel's timers and late answers
  await section('panel-timers', async () => {
    const side = doc.getElementById('side');
    const rail = doc.getElementById('rail');
    const realSI = w.setInterval, realCI = w.clearInterval, realST = w.setTimeout, realCT = w.clearTimeout;
    const savedApi = w.patton.planUsage;
    const intervals = [];
    const cleared = [];
    const timeouts = [];
    w.setInterval = (fn, ms) => { const h = { fn, ms }; intervals.push(h); return h; };
    w.clearInterval = (h) => { cleared.push(h); };
    w.setTimeout = (fn, ms) => { const h = { fn, ms }; timeouts.push(h); return h; };
    w.clearTimeout = (h) => { cleared.push(h); };
    try {
      // The minute redraw, with no new reading.
      w.patton.planUsage = { get: async () => parsed, onChanged: () => () => {} };
      let now = NOW;
      const p = new w.UP.UsagePanel({ parent: side, before: side.querySelector('.bookmarks-resizer'), rail, railTitle: rail.title, now: () => now });
      await sleep(10);
      const sec = side.querySelector('section.usage-panel');
      const reset0 = sec.querySelector('.usage-acct .usage-reset').textContent;
      check('timers: the panel redraws every 60 s', intervals.length === 1 && intervals[0].ms === 60000, intervals.map((i) => i.ms));
      const logsBefore = panelLogs().length;
      now = at(28, 11, 59);
      intervals[0].fn();
      check('timers: a tick before the reset changes nothing', sec.querySelector('.usage-acct .usage-reset').textContent === reset0 && reset0 === 'resets Sat 12:00');
      now = at(28, 12, 1);
      intervals[0].fn();
      const live = sec.querySelector('.usage-acct');
      check('timers: a reset passing between ticks flips the line to "reset" at 0% with no new reading',
        live.querySelector('.usage-reset').textContent === 'reset Sat 12:00' && live.querySelector('.usage-pct').textContent === '0%' && panelLogs().length === logsBefore, [live.querySelector('.usage-reset').textContent, live.querySelector('.usage-pct').textContent]);
      p.dispose();
      check('timers: dispose clears the minute timer', cleared.includes(intervals[0]));
      now = at(29, 12);
      const kids = sec.children.length;
      intervals[0].fn();
      check('timers: a tick after dispose draws nothing', sec.children.length === kids && !sec.isConnected);

      // Out-of-range times and "__proto__" through the real panel: no NaN, no undefined, no live tag.
      const weird = JSON.parse(`{"live":{"account":"__proto__"},"accounts":{
        "aaaa1111":{"email":"a@x.com","last_live":3,"seven_day":{"used_percentage":50,"resets_at":1e15,"read_at":1e15},"five_hour":{"used_percentage":10,"resets_at":${NOW * 1000}}},
        "bbbb2222":{"email":"b@x.com","last_live":2,"seven_day":{"used_percentage":40,"resets_at":${at(28, 12)},"read_at":7}}}}`);
      const p2 = new w.UP.UsagePanel({ parent: side, before: side.querySelector('.bookmarks-resizer'), rail, railTitle: rail.title, now: () => NOW });
      w.patton.planUsage = savedApi;
      p2.setUsage(M.parsePlanUsage(weird, NOW));
      const sec2 = side.querySelector('section.usage-panel');
      const bw = [...sec2.querySelectorAll('.usage-acct')];
      check('timers: bad times show no window and never NaN or undefined',
        bw.length === 2 && !/NaN|undefined|Invalid/.test(sec2.textContent + sec2.innerHTML + rail.title) && bw[0].querySelector('.usage-pct').textContent === '–' && bw[0].querySelector('.usage-reset').textContent === 'no recent reading' && !bw[0].querySelector('.usage-five'), sec2.textContent);
      check('timers: "__proto__" as the live id marks nobody live', !sec2.querySelector('.usage-tag') && !sec2.querySelector('.usage-acct.live'));
      check('timers: a read_at before 2020 is not shown as a time', !/read /.test(bw[1].title) && !/read /.test(sec2.querySelector('.usage-head')?.textContent ?? ''), bw[1].title);
      p2.dispose();

      // A long name: the tag is not inside the ellipsizing span.
      const long = fixture();
      long.accounts['38e237e1'].email = `${'x'.repeat(120)}@example.com`;
      const p3 = new w.UP.UsagePanel({ parent: side, before: side.querySelector('.bookmarks-resizer'), rail, railTitle: rail.title, now: () => NOW });
      p3.setUsage(M.parsePlanUsage(long, NOW));
      const top = side.querySelector('.usage-acct .usage-acct-top');
      check('timers: a long name keeps its tag as a sibling (only the name can ellipsize)',
        top.children.length === 3 && top.children[0].classList.contains('usage-name') && top.children[0].textContent.length === 120 && top.children[1].classList.contains('usage-tag') && top.children[2].classList.contains('usage-pct'));
      p3.dispose();

      // Late answers after dispose: nothing drawn, logged or scheduled.
      for (const late of ['usage', 'null', 'reject']) {
        let resolve, reject;
        const deferred = new Promise((res, rej) => { resolve = res; reject = rej; });
        w.patton.planUsage = { get: () => deferred, onChanged: () => () => {} };
        const timeoutsBefore = timeouts.length;
        const logsBeforeLate = logs.length;
        const p4 = new w.UP.UsagePanel({ parent: side, before: side.querySelector('.bookmarks-resizer'), rail, railTitle: rail.title, now: () => NOW });
        p4.dispose();
        if (late === 'usage') resolve(parsed); else if (late === 'null') resolve(null); else reject(new Error('late'));
        await sleep(10);
        check(`late: a ${late} answer after dispose draws, logs and schedules nothing`,
          logs.length === logsBeforeLate && timeouts.length === timeoutsBefore && !doc.querySelector('.usage-panel') && !rail.querySelector('.usage-rail'), [logs.length - logsBeforeLate, timeouts.length - timeoutsBefore]);
      }
      // A refused answer before dispose does schedule the retry, which dispose then clears and which does nothing if fired.
      {
        let calls = 0;
        w.patton.planUsage = { get: async () => { calls++; return null; }, onChanged: () => () => {} };
        const p5 = new w.UP.UsagePanel({ parent: side, before: side.querySelector('.bookmarks-resizer'), rail, railTitle: rail.title, now: () => NOW });
        await sleep(10);
        const retry = timeouts.at(-1);
        check('late: a refused first answer schedules one retry after 2 s', calls === 1 && retry.ms === 2000);
        p5.dispose();
        retry.fn();
        await sleep(10);
        check('late: a retry that fires after dispose asks nothing', calls === 1 && cleared.includes(retry), calls);
      }
      // The pushed guard: a push that lands while the first answer is on its way wins over that older answer.
      {
        let resolveGet;
        let pushCb = null;
        w.patton.planUsage = { get: () => new Promise((r) => { resolveGet = r; }), onChanged: (cb) => { pushCb = cb; return () => {}; } };
        const p6 = new w.UP.UsagePanel({ parent: side, before: side.querySelector('.bookmarks-resizer'), rail, railTitle: rail.title, now: () => NOW });
        const newer = fixture();
        newer.accounts['38e237e1'].seven_day.used_percentage = 71;
        pushCb(M.parsePlanUsage(newer, NOW));
        resolveGet(parsed); // the older reading (63%), answered after the push
        await sleep(10);
        check('pushed: a first answer that arrives after a push does not overwrite it', side.querySelector('.usage-acct .usage-pct').textContent === '71%', side.querySelector('.usage-acct .usage-pct')?.textContent);
        p6.dispose();
        // ... and a refused first answer's retry does not fire after a push.
        let asks = 0;
        let pushCb2 = null;
        w.patton.planUsage = { get: async () => { asks++; return null; }, onChanged: (cb) => { pushCb2 = cb; return () => {}; } };
        const p7 = new w.UP.UsagePanel({ parent: side, before: side.querySelector('.bookmarks-resizer'), rail, railTitle: rail.title, now: () => NOW });
        await sleep(10);
        const retry2 = timeouts.at(-1);
        pushCb2(parsed);
        retry2.fn();
        await sleep(10);
        check('pushed: the retry after a refused answer asks nothing once a push has come', asks === 1, asks);
        p7.dispose();
      }
    } finally {
      w.setInterval = realSI; w.clearInterval = realCI; w.setTimeout = realST; w.clearTimeout = realCT;
      w.patton.planUsage = savedApi;
    }
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
