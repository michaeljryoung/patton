// Check of the usage panel (24 Nov 2026, Michael: every Claude login he has
// used, bottom left, with its usage and reset time; layout U1 from
// docs/mocks/usage-panel.html, percent and reset only, no token figure).
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
// (d) wiring: channels, preload, registration, the poll stopped on quit.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-usage-panel.mjs
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
    check('format: levels', M.usageLevel(79.9) === '' && M.usageLevel(80) === 'warn' && M.usageLevel(99) === 'warn' && M.usageLevel(100) === 'full');
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
    check('reader: a folder at the path is no file', (await M.readPlanUsage(dir, NOW)).key === 'none');
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
    check('panel: head "Usage" with the newest reading time', txt(sec, '.usage-head .usage-title') === 'Usage' && txt(sec, '.usage-head .usage-time') === '20:23', sec.querySelector('.usage-head')?.textContent);
    const b = blocks();
    check('panel: four logins in order', JSON.stringify(b.map((x) => x.dataset.account)) === JSON.stringify(['38e237e1', 'bbbb2222', 'aaaa1111', 'cccc3333']), b.map((x) => x.dataset.account));
    check('panel: the live login alone is bold-classed with a "live" tag',
      b[0].classList.contains('live') && txt(b[0], '.usage-tag') === 'live' && b.slice(1).every((x) => !x.classList.contains('live') && !x.querySelector('.usage-tag')));
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
    check('wiring: polled by stat every 10 s', ipc.includes('POLL_MS = 10 * 1000') && ipc.includes('setInterval'));
    const css = read('src/renderer/styles/main.css');
    const rule = (sel) => { const i = css.indexOf(`${sel} {`); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
    check('css: a hairline above the panel', rule('.usage-panel').includes('border-top: 1px solid var(--hairline)'));
    check('css: ink meters, amber and red fills', rule('.usage-meter > i').includes('var(--ink)') && /\.usage-acct\.warn > \.usage-meter > i,[^{]*{\s*background: var\(--amber\)/.test(css) && /\.usage-acct\.full > \.usage-meter > i,[^{]*{\s*background: var\(--red\)/.test(css));
    check('css: amber and red percents use the text tokens', /\.usage-acct\.warn \.usage-pct,[^{]*{\s*color: var\(--amber-text\)/.test(css) && /\.usage-acct\.full \.usage-pct,[^{]*{\s*color: var\(--error-text\)/.test(css));
    check('css: "Usage" wears the shared head style', /\.usage-title,[\s\S]*?text-transform: uppercase/.test(css.slice(css.indexOf('Shared head type'))));
    check('css: sizes follow --ui-scale', rule('.usage-panel').includes('var(--ui-scale)') && rule('.usage-tag').includes('var(--ui-scale)'));
    const block = css.slice(css.indexOf('--- Plan usage'), css.indexOf('/* Drag handle'));
    check('css: no colour literals in the usage styles (tokens only)', !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block));
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
