// Check of page titles in main (main/page-title-read.ts, page-titles.ts,
// page-title-backfill.ts, the publish reading in transcript-parser.ts): the
// safe title reader, live learning from a transcript's Artifact publish, and
// the once-per-launch backfill over a fake ~/.claude/projects with the real
// `nice grep`. Every file and transcript here is made up in a temp folder.
// Run: node scripts/check-page-titles.mjs
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
};

const dir = mkdtempSync(join(tmpdir(), 'check-page-titles-'));
try {
  const res = await build({
    stdin: {
      resolveDir: repo, loader: 'ts',
      contents: `export * from './src/main/page-title-read';
                 export * from './src/main/page-titles';
                 export * from './src/main/page-title-backfill';
                 export { TranscriptParser } from './src/main/transcript-parser';`,
    },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  });
  writeFileSync(join(dir, 'm.mjs'), res.outputFiles[0].text);
  const M = await import(pathToFileURL(join(dir, 'm.mjs')).href);
  const pages = join(dir, 'pages');
  mkdirSync(pages);
  const page = (name, body) => { const p = join(pages, name); writeFileSync(p, body); return p; };

  // ── 1. the title reader
  {
    const t = async (p) => M.readPageTitle(p);
    let r = await t(page('ent.html', '<html><head><title>Nevis &amp; Road &lt;walk&gt; &quot;x&quot; &#39;a&apos; &#8212; &#x2014;</title>'));
    check('entities decoded', r.title === 'Nevis & Road <walk> "x" \'a\' — —', r);
    r = await t(page('ws.htm', '<TITLE lang="en">\n  A\tB\u0007  C ‮ </TITLE>'));
    check('.htm, any case, attributes; controls stripped and whitespace collapsed', r.title === 'A B C', r);
    r = await t(page('long.html', `<title>${'w'.repeat(100)}</title>`));
    check('capped at 80 characters with a trailing …', r.title.length === 80 && r.title.endsWith('…'), r.title.length);
    r = await t(page('none.html', '<html><body>no title here</body></html>'));
    check('no title: empty, reason no-title', r.title === '' && r.reason === 'no-title', r);
    r = await t(page('empty.html', '<title>  &#0; </title>'));
    check('an empty title is no title', r.title === '' && r.reason === 'no-title', r);
    r = await t(page('notes.md', '<title>Secret</title>'));
    check('a .md file is refused', r.title === '' && r.reason === 'not-html', r);
    r = await t(page('notes.txt', '<title>Secret</title>'));
    check('a .txt file is refused', r.title === '' && r.reason === 'not-html', r);
    mkdirSync(join(pages, 'dir.html'));
    r = await t(join(pages, 'dir.html'));
    check('a directory is refused', r.title === '' && r.reason === 'not-a-file', r);
    r = await t('pages/ent.html');
    check('a relative path is refused', r.title === '' && r.reason === 'not-absolute', r);
    r = await t(join(pages, 'gone.html'));
    check('a missing file says missing', r.title === '' && r.reason === 'missing', r);
    r = await t(join(pages, 'ent.html\0x'));
    check('a path with NUL is refused', r.reason === 'not-absolute', r);
    r = await t(page('late.html', ' '.repeat(8192) + '<title>Too late</title>'));
    check('a title after byte 8192 is not found', r.title === '' && r.reason === 'no-title', r);
    r = await t(page('edge.html', ' '.repeat(8192 - '<title>Just in</title>'.length) + '<title>Just in</title>'));
    check('a title ending at byte 8192 is found', r.title === 'Just in', r);
    execFileSync('/usr/bin/mkfifo', [join(pages, 'fifo.html')]);
    const t0 = Date.now();
    r = await t(join(pages, 'fifo.html'));
    check('a FIFO is refused without hanging', r.reason === 'not-a-file' && Date.now() - t0 < 2000, r);
  }

  // ── fixture transcript lines (the real shapes, made-up content)
  const ID = 'a51aee6f-70d0-4e0f-ada9-8b6aeb2b4221';
  const ID2 = '503c49fd-8ae5-4501-be32-fe371f388337';
  const ID3 = '0d1e2f3a-4b5c-6d7e-8f90-a1b2c3d4e5f6';
  const walk = page('walkround-external.html', '<!doctype html><html><head><meta charset="utf-8"><title>Nevis Road walk-round</title></head><body></body></html>');
  const bare = page('bare.html', '<html><body>none</body></html>');
  let seq = 0;
  const toolUse = (name, input) => {
    const id = `toolu_${++seq}`;
    return { id, line: JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'assistant', timestamp: '2026-11-22T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }) };
  };
  const result = (useId, text, asString = false) => JSON.stringify({
    parentUuid: 'p', isSidechain: false, type: 'user', timestamp: '2026-11-22T10:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: asString ? text : [{ type: 'text', text }] }] },
  });
  const published = (path, id, v = 1) => `Published ${path} at https://claude.ai/code/artifact/${id} (Version ${v}, private)`;
  const publishLines = (path, id, inputTitle, v = 1) => {
    const u = toolUse('Artifact', { file_path: path, description: 'a page', ...(inputTitle ? { title: inputTitle } : {}) });
    return [u.line, result(u.id, published(path, id, v))];
  };

  const memStore = () => {
    const s = { titles: undefined, misses: undefined };
    return { s, store: { getTitles: () => s.titles, setTitles: (v) => { s.titles = v; }, getMisses: () => s.misses, setMisses: (v) => { s.misses = v; } } };
  };

  // ── 2. live learning
  {
    const pubs = [];
    const parser = new M.TranscriptParser({ home: dir, onPublish: (p) => pubs.push(p) });
    const [u1, r1] = publishLines(walk, ID, 'Claude title');
    const [u2, r2] = publishLines(bare, ID2, 'Given by Claude');
    const q = toolUse('Bash', { command: 'cat log' });
    const quoted = result(q.id, published(walk, ID3));
    const events = parser.push([u1, r1, r1, u2, r2, q.line, quoted].join('\n') + '\n');
    check('a publish is recognised once, though its line is written twice', pubs.filter((p) => p.id === ID).length === 1, pubs);
    check('the publish carries the result\'s path and the call\'s title', pubs[0]?.path === walk && pubs[0]?.inputTitle === 'Claude title', pubs[0]);
    check('a Bash result quoting a publish is not one', !pubs.some((p) => p.id === ID3), pubs);
    check('publishes are not sent to the session bar', events.length === 0, events);
    const logs = []; const changes = [];
    const { s, store } = memStore();
    const book = new M.PageTitleBook({ store, onChange: (t) => changes.push(t), log: (m, d) => logs.push([m, d]) });
    for (const p of pubs) await book.learnPublish(p);
    check('the HTML <title> wins over input.title', book.titles()[ID] === 'Nevis Road walk-round', book.titles());
    check('no <title> in the file: input.title is used', book.titles()[ID2] === 'Given by Claude', book.titles());
    check('each learned title is pushed to the windows', changes.length === 2 && changes[1][ID] === 'Nevis Road walk-round', changes);
    check('stored as { title, at } at the top level', s.titles?.[ID]?.title === 'Nevis Road walk-round' && typeof s.titles[ID].at === 'number', s.titles);
    check('learned is logged with id start, source and length', logs.some(([m, d]) => m === '[TITLE] learned' && d.id === 'a51aee6f' && d.source === 'live' && d.chars === 21), logs);
    const again = await book.learnPublish(pubs[0]);
    check('the same title again changes nothing', again === false && changes.length === 2, changes.length);
    await book.learnPublish({ id: ID3, path: join(pages, 'notes.md'), inputTitle: '', at: 0 });
    check('a refused read is logged with its reason, and nothing learned', logs.some(([m, d]) => m === '[TITLE] read refused' && d.reason === 'not-html') && !book.has(ID3), logs);
    check('logs never carry a title or a path', !/Nevis|Given by|walkround|\/pages\//.test(JSON.stringify(logs)), logs);
    const parser2 = new M.TranscriptParser({ home: dir, onPublish: (p) => pubs.push(p) });
    const asString = result('toolu_none', published(walk, ID2, 2), true);
    const before = pubs.length;
    parser2.push(asString + '\n');
    check('a string result whose call was never seen still counts (the tail starts mid-file)', pubs.length === before + 1 && pubs.at(-1).path === walk, pubs.at(-1));
    {
      const got = [];
      new M.TranscriptParser({ home: dir, onPublish: (p) => got.push(p) })
        .push(result('t', 'Published /x.html at https://claude.ai/code/artifact/short (Version 1)', true) + '\n');
      check('a malformed id in a publish is dropped', got.length === 0, got);
    }
    {
      const junk = (titles, misses) => new M.PageTitleBook({ store: { getTitles: () => titles, setTitles() {}, getMisses: () => misses, setMisses() {} }, log() {} });
      check('a store holding junk reads as empty', Object.keys(junk([1], 'x').titles()).length === 0
        && Object.keys(junk({ 'bad id': { title: 'x', at: 1 }, [ID]: { title: 7 } }, undefined).titles()).length === 0
        && junk(undefined, { [ID]: 'soon' }).missedRecently(ID) === false);
    }
    let now = 1000;
    const { s: s2, store: store2 } = memStore();
    const big = new M.PageTitleBook({ store: store2, log() {}, now: () => now++ });
    for (let i = 0; i < 501; i++) big.learn(`id-${String(i).padStart(8, '0')}`, `T${i}`, 'live');
    check('the newest 500 titles are kept', Object.keys(s2.titles).length === 500 && !('id-00000000' in s2.titles) && 'id-00000500' in s2.titles, Object.keys(s2.titles).length);
  }

  // ── 3. the backfill
  {
    const projects = join(dir, 'home', '.claude', 'projects');
    const a = join(projects, '-Users-m-Projects-a');
    const b = join(projects, '-Users-m-Projects-b');
    mkdirSync(join(b, 'sess', 'subagents'), { recursive: true });
    mkdirSync(a, { recursive: true });
    const oldPage = page('old.html', '<title>Old title</title>');
    const firstPage = page('first.html', '<title>First title</title>');
    const write = (p, lines, mtime) => { writeFileSync(p, lines.join('\n') + '\n'); utimesSync(p, mtime, mtime); };
    const T = 1_790_000_000;
    write(join(a, 'old.jsonl'), [...publishLines(oldPage, ID, '')], T - 1000);
    write(join(b, 'new.jsonl'), [...publishLines(firstPage, ID, ''), JSON.stringify({ type: 'api-request-blob', x: 1 }), ...publishLines(walk, ID, '', 2)], T);
    write(join(b, 'sess', 'subagents', 'agent-1.jsonl'), [...publishLines(walk, ID2, 'From a subagent')], T + 10);
    write(join(b, 'notes.txt'), [published(walk, ID2)], T + 20);
    const listed = await M.listTranscripts(projects);
    check('listing: top-level *.jsonl only, newest first', listed.length === 2 && listed[0].endsWith('/new.jsonl') && listed[1].endsWith('/old.jsonl'), listed);

    const calls = [];
    const run = async (file, args) => { calls.push([file, args]); return M.runGrep(file, args); };
    let now = Date.UTC(2026, 10, 22);
    const logs = [];
    const { s, store } = memStore();
    const book = new M.PageTitleBook({ store, log: (m, d) => logs.push([m, d]), now: () => now });
    const ids = [ID, ID2, ID3, 'bad id; echo pwned', '-e', 'short', '--include=x-1234567', ID];
    const r1 = await M.runBackfill(book, ids, { projectsDir: projects, run, log: (m, d) => logs.push([m, d]), now: () => now });
    check('one grep, run under nice', calls.length === 1 && calls[0][0] === '/usr/bin/nice' && calls[0][1].slice(0, 6).join(' ') === '-n 10 /usr/bin/grep -l -s -F', calls.map((c) => c[1].slice(0, 6)));
    const gArgs = calls[0][1];
    const dash = gArgs.indexOf('--');
    const eIds = [];
    for (let i = 6; i < dash; i += 2) if (gArgs[i] === '-e') eIds.push(gArgs[i + 1]);
    check('only well-formed ids reach grep, each once, as -e patterns', JSON.stringify(eIds) === JSON.stringify([ID, ID2, ID3]) && dash === 6 + 2 * 3, gArgs.slice(0, dash));
    check('no malformed id reaches grep at all', !gArgs.some((x) => /bad id|short|include/.test(x)), gArgs);
    check('files follow --, and no subfolder file is passed', gArgs[dash + 1]?.endsWith('/new.jsonl') && gArgs.length === dash + 3 && !gArgs.some((x) => x.includes('subagents')), gArgs.slice(dash));
    check('the newest file\'s last publish wins', book.titles()[ID] === 'Nevis Road walk-round', book.titles());
    check('a page published only in a subfolder transcript is missed', !book.has(ID2), book.titles());
    check('result: 3 ids, 1 found, 2 missed', r1.ids === 3 && r1.found === 1 && r1.missed === 2, r1);
    check('the misses are recorded with when they were searched', s.misses?.[ID2] === now && s.misses?.[ID3] === now && !(ID in (s.misses ?? {})), s.misses);
    check('backfill is logged with counts only', logs.some(([m, d]) => m === '[TITLE] backfill' && d.ids === 3 && d.found === 1 && d.missed === 2 && typeof d.ms === 'number') && logs.some(([m, d]) => m === '[TITLE] learned' && d.source === 'backfill'), logs);
    check('backfill logs carry no title or path', !/Nevis|walkround|\/pages\/|\.jsonl/.test(JSON.stringify(logs)), logs);

    now += 24 * 3600 * 1000;
    calls.length = 0;
    const r2 = await M.runBackfill(book, ids, { projectsDir: projects, run, log() {}, now: () => now });
    check('within 7 days nothing is searched again (no grep at all)', r2.ids === 0 && calls.length === 0, { r2, calls: calls.length });

    now += 7 * 24 * 3600 * 1000;
    const r3 = await M.runBackfill(book, ids, { projectsDir: projects, run, log() {}, now: () => now });
    check('after 7 days a miss is searched again (the found one is not)', r3.ids === 2 && calls.length === 1, { r3, calls: calls.length });

    const none = await M.grepFiles(['ffffffff-none'], listed, M.runGrep);
    check('grep finding nothing (exit 1) is no error', Array.isArray(none) && none.length === 0, none);
    calls.length = 0;
    const empty = await M.runBackfill(book, [], { projectsDir: join(dir, 'nowhere'), run, log() {}, now: () => now });
    check('no ids: nothing runs', empty.ids === 0 && calls.length === 0);
  }

  // ── 4. wiring, by source
  {
    const src = (p) => readFileSync(join(repo, p), 'utf8');
    check('the live feed hands each publish to page titles', /onPublish: \(p\) => this\.deps\.onPagePublished\?\.\(p\)/.test(src('src/main/session-feed.ts')));
    const ipc = src('src/main/ipc-handlers.ts');
    check('ipc-handlers wires the feed to learnPublish', /registerSessionFeedHandlers\(ptyManager, \(p\) => \{\s*pageTitles\.learnPublish\(p\)/.test(ipc));
    const pt = src('src/main/page-titles-ipc.ts');
    check('the backfill is scheduled once, 60 s after launch', /BACKFILL_DELAY_MS = 60 \* 1000/.test(pt) && (pt.match(/setTimeout\(/g) ?? []).length === 1);
    check('the getter is rate-limited and answers null when refused', /getLimiter\.allow\(\)[\s\S]{0,200}return null/.test(pt));
    check('the parser reuses the shared artifact URL pattern', /re: ARTIFACT_URL/.test(src('src/main/transcript-parser.ts')));
    check('the backfill never runs a shell', !/shell:\s*true|\bexec\(|spawn\(/.test(src('src/main/page-title-backfill.ts')));
    check('the reader never uses readFile', !/readFile/.test(src('src/main/page-title-read.ts')));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
