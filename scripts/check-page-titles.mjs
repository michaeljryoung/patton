// Check of page titles in main (main/page-title-read.ts, page-titles.ts,
// page-title-backfill.ts, the publish reading in transcript-parser.ts): the
// safe title reader, live learning from a transcript's Artifact publish, and
// the once-per-launch backfill over a fake ~/.claude/projects with the real
// `nice grep` (batches, a failed batch, a quit mid-scan, reused paths, publish
// times from the version id). Every file and transcript here is made up in a
// temp folder.
// Run: node scripts/check-page-titles.mjs
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
const section = async (name, fn) => {
  try { await fn(); } catch (err) { failed++; console.log(`FAIL ${name} threw`, String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ')); }
};
try {
  const res = await build({
    stdin: {
      resolveDir: repo, loader: 'ts',
      contents: `export * from './src/main/page-title-read';
                 export * from './src/main/page-titles';
                 export * from './src/main/page-title-backfill';
                 export { TranscriptParser, publishPath, cleanText } from './src/main/transcript-parser';
                 export * from './src/shared/artifact-id';`,
    },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  });
  writeFileSync(join(dir, 'm.mjs'), res.outputFiles[0].text);
  const M = await import(pathToFileURL(join(dir, 'm.mjs')).href);
  const pages = join(dir, 'pages');
  mkdirSync(pages);
  const page = (name, body) => { const p = join(pages, name); writeFileSync(p, body); return p; };

  // ── 1. the title reader
  await section('reader', async () => {
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
    symlinkSync('/dev/zero', join(pages, 'zero.html'));
    const t1 = Date.now();
    r = await t(join(pages, 'zero.html'));
    check('a symlink to a device is refused without reading it', r.title === '' && r.reason === 'not-a-file' && Date.now() - t1 < 2000, r);
    symlinkSync(join(pages, 'loop-b.html'), join(pages, 'loop-a.html'));
    symlinkSync(join(pages, 'loop-a.html'), join(pages, 'loop-b.html'));
    r = await t(join(pages, 'loop-a.html'));
    check('a symlink loop is refused', r.title === '' && r.reason !== null && r.reason !== 'no-title', r);
    // m10: invisible and bidi format characters go, ZWNJ and ZWJ stay
    r = await t(page('fmt.html', '<title>A\u00adB\u061cC\u180eD\u200bE\u200eF\u202eG\u2060H\u2064I\u2068J\ufeffK\u200cL\u200dM</title>'));
    check('invisible characters removed, bidi marks and controls made spaces; ZWNJ and ZWJ kept', r.title === 'AB CDE F GHI JK\u200cL\u200dM', [...r.title].map((c) => c.codePointAt(0).toString(16)));
    // N8: the rest of the invisible set (CGJ, Khmer inherent vowels, U+206A-206F, tag characters) go; blank fillers are spaces
    r = await t(page('fmt2.html', '<title>A\u034fB\u17b4C\u206aD\u206fE\u{e0041}\u{e007f}F\u3164G\u2800H\u115fI\uffa0J</title>'));
    check('N8: CGJ, Khmer invisibles, U+206A-206F and tag characters removed; Hangul and braille blanks made spaces', r.title === 'ABCDEF G H I J', [...r.title].map((c) => c.codePointAt(0).toString(16)));
    check('N8: a path holding a tag character or a Hangul filler is refused', M.publishPath?.('/a/b\u{e0041}.html') === null && M.publishPath?.('/a/\u3164.html') === null && M.publishPath?.('/a/b.html') === '/a/b.html');
  });

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
  await section('live', async () => {
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
    {
      const got = [];
      const pz = new M.TranscriptParser({ home: dir, onPublish: (p) => got.push(p) });
      const lines = [];
      for (const name of ['mcp__evil__publish', 'Agent', 'Task', 'Skill', 'artifact', 'Artifact2']) {
        const u = toolUse(name, { file_path: walk });
        lines.push(u.line, result(u.id, published(walk, ID3)));
      }
      pz.push(lines.join('\n') + '\n');
      check('only an Artifact call\'s result is a publish (MCP, Agent, Task, Skill, near names refused)', got.length === 0, got.map((g) => g.id));
    }
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
    check('a refused read is logged with its reason and id start, and nothing learned', logs.some(([m, d]) => m === '[TITLE] read refused' && d.reason === 'not-html' && d.id === ID3.slice(0, 8)) && !book.has(ID3), logs);
    for (let i = 0; i < 3; i++) await book.learnPublish({ id: ID3, path: join(pages, 'gone.html'), inputTitle: '', at: 0 });
    check('a missing file is logged once per id per launch', logs.filter(([m, d]) => m === '[TITLE] read refused' && d.reason === 'missing').length === 1, logs.filter(([m]) => m === '[TITLE] read refused'));
    check('logs never carry a title or a path', !/Nevis|Given by|walkround|\/pages\//.test(JSON.stringify(logs)), logs);
    const parser2 = new M.TranscriptParser({ home: dir, onPublish: (p) => pubs.push(p) });
    const asString = result('toolu_none', published(walk, ID2, 2), true);
    const before = pubs.length;
    parser2.push(asString + '\n');
    check('a result whose call was never seen is not a publish (allow-list: Artifact only)', pubs.length === before, pubs.at(-1));
    {
      const got = [];
      const u = toolUse('Artifact', { file_path: walk });
      new M.TranscriptParser({ home: dir, onPublish: (p) => got.push(p) }).push([u.line, result(u.id, published(walk, ID2, 2), true)].join('\n') + '\n');
      check('an Artifact call\'s string result counts', got.length === 1 && got[0].path === walk, got);
    }
    {
      const got = [];
      new M.TranscriptParser({ home: dir, onPublish: (p) => got.push(p) })
        .push([toolUse('Artifact', {}).line.replace(/toolu_\d+/, 't'), result('t', 'Published /x.html at https://claude.ai/code/artifact/short (Version 1)', true)].join('\n') + '\n');
      check('a malformed id in a publish is dropped', got.length === 0, got);
    }
    {
      // N1: an id cut one character short is not a page
      const got = [];
      const u = toolUse('Artifact', { file_path: walk });
      new M.TranscriptParser({ home: dir, onPublish: (p) => got.push(p) }).push([u.line, result(u.id, published(walk, ID.slice(0, 35)))].join('\n') + '\n');
      check('N1 live: a publish whose id is cut short is dropped', got.length === 0, got);
      check('N1: only whole ids: a UUID anywhere, 22 base58 characters only under /artifact/',
        M.completeArtifactIdOf?.(`https://claude.ai/code/artifact/${ID}`) === ID && M.completeArtifactIdOf?.(`https://claude.ai/public/artifacts/${ID}`) === ID
        && M.completeArtifactIdOf?.(`https://claude.ai/code/artifact/${ID.slice(0, 35)}`) === null && M.completeArtifactIdOf?.('https://claude.ai/code/artifact/8ae49267-5d39-448d-8bfd-2') === null
        && M.completeArtifactIdOf?.('https://claude.ai/artifact/1XJ8kteWeFmWkEPRZGGvyJ') === '1XJ8kteWeFmWkEPRZGGvyJ' && M.completeArtifactIdOf?.('https://claude.ai/code/artifact/1XJ8kteWeFmWkEPRZGGvyJ') === null
        && M.completeArtifactIdOf?.('https://claude.ai/artifact/1XJ8kteWeFmWkEPRZGGvyJx') === null && M.completeArtifactIdOf?.(`https://claude.ai/code/artifact/${ID.toUpperCase()}`) === null);
    }
    {
      // N7: the tail replays old lines on attach; an older id of a reused path must not take the file's current title
      const reusedPage = page('reused.html', '<title>Reused now</title>');
      const OLD = 'e0e0e0e0-0000-4000-8000-00000000000a';
      const NEW = 'e0e0e0e0-0000-4000-8000-00000000000b';
      const got = [];
      const ua = toolUse('Artifact', { file_path: reusedPage, title: 'Old given' });
      const ub = toolUse('Artifact', { file_path: reusedPage, title: 'New given' });
      const ra = result(ua.id, published(reusedPage, OLD)).replace('10:00:01.000Z', '09:00:01.000Z');
      new M.TranscriptParser({ home: dir, onPublish: (p) => got.push(p) }).push([ua.line, ra, ub.line, result(ub.id, published(reusedPage, NEW))].join('\n') + '\n');
      const { store: rs } = memStore();
      const rbook = new M.PageTitleBook({ store: rs, log() {} });
      // As the feed does it: each publish handed over at once, not awaited one by one.
      await Promise.all(got.map((p) => rbook.learnPublish(p)));
      check('N7 live: in a replay, the newest id of a path takes the file title; the older keeps its own given title', rbook.titles()[NEW] === 'Reused now' && rbook.titles()[OLD] === 'Old given', rbook.titles());
      const { store: rs2 } = memStore();
      const rbook2 = new M.PageTitleBook({ store: rs2, log() {} });
      rbook2.learn(OLD, 'Learned when it was new', 'live');
      await Promise.all(got.map((p) => rbook2.learnPublish(p)));
      check('N7 live: an older id that already has a title keeps it', rbook2.titles()[OLD] === 'Learned when it was new' && rbook2.titles()[NEW] === 'Reused now', rbook2.titles());
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
    {
      // m9: a title a bookmark uses is never evicted
      let t = 1000;
      const { s: s3, store: store3 } = memStore();
      const kept = new M.PageTitleBook({ store: store3, log() {}, now: () => t++, keep: () => new Set(['id-00000000', 'id-00000001']) });
      for (let i = 0; i < 600; i++) kept.learn(`id-${String(i).padStart(8, '0')}`, `T${i}`, 'live');
      const k = Object.keys(s3.titles);
      check('bookmarked titles survive the cap; the rest keep the newest', k.length === 500 && 'id-00000000' in s3.titles && 'id-00000001' in s3.titles && 'id-00000599' in s3.titles && !('id-00000002' in s3.titles), k.length);
    }
    {
      // m4: ids named like Object.prototype members
      const { s: s4, store: store4 } = memStore();
      const proto = new M.PageTitleBook({ store: store4, log() {} });
      check('nothing learned: "constructor" and "toString" are unknown ids', !proto.has('constructor') && !proto.has('toString') && proto.missedRecently('hasOwnProperty') === false && proto.titles().constructor === undefined);
      proto.learn('constructor', 'Real page', 'live');
      check('an id named "constructor" is stored and looked up as an id', proto.has('constructor') && proto.titles().constructor === 'Real page' && s4.titles.constructor?.title === 'Real page' && !proto.has('toString'), proto.titles());
      s4.misses = JSON.parse('{"__proto__": 5, "valueOf": "x"}');
      check('junk under prototype names in the misses reads as no miss', proto.missedRecently('valueOf') === false && proto.missedRecently('__proto__') === false);
    }
    {
      // m7: one store write and one push for many titles
      let writes = 0; let pushes = 0; let missWrites = 0;
      const { s: s5, store: store5 } = memStore();
      const counted = { ...store5, setTitles: (v) => { writes++; store5.setTitles(v); }, setMisses: (v) => { missWrites++; store5.setMisses(v); } };
      s5.misses = { [ID]: 1, [ID2]: 1 };
      const many = new M.PageTitleBook({ store: counted, onChange: () => pushes++, log() {} });
      const n = many.learnMany ? many.learnMany([[ID, 'One'], [ID2, 'Two'], [ID3, 'Three'], ['bad id', 'x'], [ID, 'One']], 'backfill') : -1;
      check('learnMany: three titles, one titles write, one misses write, one push', n === 3 && writes === 1 && missWrites === 1 && pushes === 1 && Object.keys(s5.misses).length === 0, { n, writes, missWrites, pushes });
      check('learnMany of nothing new writes and pushes nothing', many.learnMany?.([[ID, 'One']], 'backfill') === 0 && writes === 1 && pushes === 1);
    }
    {
      // N2: choosing what to search reads the store once, not once per bookmark
      let reads = 0;
      const { s: s6, store: store6 } = memStore();
      s6.titles = { [ID]: { title: 'Known', at: 1 } };
      s6.misses = { [ID2]: Date.now() };
      const counted = { ...store6, getTitles: () => { reads++; return store6.getTitles(); }, getMisses: () => { reads++; return store6.getMisses(); } };
      const rb6 = new M.PageTitleBook({ store: counted, log() {} });
      const want = Array.from({ length: 30 }, (_, i) => `c0c0c0c0-0000-4000-8000-${String(i).padStart(12, '0')}`);
      const picked = M.idsToSearch(rb6, [ID, ID2, ...want, want[0], 'short']);
      check('N2: 32 bookmarks are sorted with two store reads (titles, misses)', reads === 2 && picked.length === 30 && picked[0] === want[0], { reads, n: picked.length });
    }
  });

  // ── 3. the backfill
  await section('backfill', async () => {
    const projects = join(dir, 'home', '.claude', 'projects');
    const a = join(projects, '-Users-m-Projects-a');
    const b = join(projects, '-Users-m-Projects-b');
    mkdirSync(join(b, 'sess', 'subagents'), { recursive: true });
    mkdirSync(a, { recursive: true });
    const ID4 = '44444444-aaaa-4bbb-8ccc-000000000004';
    const ID5 = '55555555-aaaa-4bbb-8ccc-000000000005';
    const ID6 = '66666666-aaaa-4bbb-8ccc-000000000006';
    const ID7 = '77777777-aaaa-4bbb-8ccc-000000000007';
    const vpub = (path, id, secs, v = 1) => `Published ${path} at https://claude.ai/code/artifact/${id} (Version ${v}, version id ${secs}-1a2b)`;
    const vLines = (path, id, secs, v = 1) => {
      const u = toolUse('Artifact', { file_path: path, description: 'a page' });
      return [u.line, result(u.id, vpub(path, id, secs, v))];
    };
    const oldPage = page('old.html', '<title>Old title</title>');
    const firstPage = page('first.html', '<title>First title</title>');
    const shared = page('shared.html', '<title>Shared now</title>');
    const page6 = page('page6.html', '<title>Six</title>');
    const write = (p, lines, mtime) => { writeFileSync(p, lines.join('\n') + '\n'); utimesSync(p, mtime, mtime); };
    const T = 1_790_000_000;
    // new.jsonl: ID at first.html, then (later) at the walk-round page; ID4 then ID5 at shared.html.
    write(join(b, 'new.jsonl'), [
      ...vLines(firstPage, ID, T - 500), JSON.stringify({ type: 'api-request-blob', x: 1 }), ...vLines(walk, ID, T - 100, 2),
      ...vLines(shared, ID4, T - 800), ...vLines(shared, ID5, T - 200),
    ], T);
    // old.jsonl was resumed later (newest mtime) but its publish of ID is the oldest.
    write(join(a, 'old.jsonl'), [...vLines(oldPage, ID, T - 900), ...vLines(page6, ID7, T - 60)], T + 50);
    // A publish line with no version id: the file's mtime (T - 50) stands in, newer than ID7's T - 60.
    write(join(a, 'nover.jsonl'), [...publishLines(page6, ID6, '')], T - 50);
    write(join(b, 'sess', 'subagents', 'agent-1.jsonl'), [...vLines(walk, ID2, T + 10)], T + 10);
    write(join(b, 'notes.txt'), [vpub(walk, ID2, T + 20)], T + 20);
    const { files: listed, unreadable: unread0 } = await M.listTranscripts(projects);
    check('listing: top-level *.jsonl only, newest first, with mtimes', unread0 === 0 && listed.length === 3 && listed[0].path.endsWith('/old.jsonl') && listed[1].path.endsWith('/new.jsonl') && listed[0].mtime === (T + 50) * 1000, listed);

    const calls = [];
    const run = async (file, args, signal) => { calls.push([file, args]); return M.runGrep(file, args, signal); };
    let now = Date.UTC(2026, 10, 22);
    const logs = [];
    const { s, store } = memStore();
    let titleWrites = 0;
    const book = new M.PageTitleBook({ store: { ...store, setTitles: (v) => { titleWrites++; store.setTitles(v); } }, log: (m, d) => logs.push([m, d]), now: () => now });
    const ids = [ID, ID2, ID3, ID4, ID5, ID6, ID7, 'bad id; echo pwned', '-e', 'short', '--include=x-1234567', ID];
    const r1 = await M.runBackfill(book, ids, { projectsDir: projects, run, log: (m, d) => logs.push([m, d]), now: () => now });
    const head = ['-n', '10', '/usr/bin/grep', '-H', '-o', '-s', '-E', '-e', M.PUBLISH_PATTERN, '--'];
    check('one grep for the one batch, run under nice with the one publish pattern', calls.length === 1 && calls[0][0] === '/usr/bin/nice' && JSON.stringify(calls[0][1].slice(0, head.length)) === JSON.stringify(head), calls.map((c) => c[1].slice(0, 10)));
    const gArgs = calls[0][1];
    check('no id reaches grep at all (the pattern is the same for any number of ids)', !gArgs.some((x) => [ID, ID2, ID3, ID4, ID5, ID6, ID7].some((id) => x.includes(id)) || /bad id|short|include/.test(x)), gArgs);
    check('files follow --, and no subfolder file is passed', gArgs.length === head.length + 3 && !gArgs.some((x) => x.includes('subagents')), gArgs.slice(head.length));
    check('an id\'s newest publish by version time wins, not the newest file', book.titles()[ID] === 'Nevis Road walk-round', book.titles());
    check('a reused path: the newest id gets the file\'s title, the older id gets none', book.titles()[ID5] === 'Shared now' && !book.has(ID4), book.titles());
    check('a line with a version id outranks one without, though the file mtime standing in is later', book.titles()[ID7] === 'Six' && !book.has(ID6), book.titles());
    check('a page published only in a subfolder transcript is missed', !book.has(ID2), book.titles());
    check('result: 7 ids, 3 found, 4 missed, 1 batch, none failed', r1.ids === 7 && r1.found === 3 && r1.missed === 4 && r1.batches === 1 && r1.failed === 0, r1);
    check('the backfill writes the titles once', titleWrites === 1, titleWrites);
    check('the misses are recorded with when they were searched', [ID2, ID3, ID4, ID6].every((id) => s.misses?.[id] === now) && !(ID in (s.misses ?? {})), s.misses);
    check('backfill is logged with counts only', logs.some(([m, d]) => m === '[TITLE] backfill' && d.ids === 7 && d.found === 3 && d.missed === 4 && typeof d.ms === 'number') && logs.some(([m, d]) => m === '[TITLE] learned' && d.source === 'backfill'), logs);
    check('backfill logs carry no title or path', !/Nevis|walkround|Shared|\/pages\/|\.jsonl/.test(JSON.stringify(logs)), logs);

    now += 24 * 3600 * 1000;
    calls.length = 0;
    const r2 = await M.runBackfill(book, ids, { projectsDir: projects, run, log() {}, now: () => now });
    check('within 7 days nothing is searched again (no grep at all)', r2.ids === 0 && calls.length === 0, { r2, calls: calls.length });

    now += 7 * 24 * 3600 * 1000;
    const r3 = await M.runBackfill(book, ids, { projectsDir: projects, run, log() {}, now: () => now });
    check('after 7 days a miss is searched again (the found ones are not)', r3.ids === 4 && calls.length === 1, { r3, calls: calls.length });

    const none = await M.runGrep('/usr/bin/nice', M.grepArgs([join(b, 'notes.txt').replace('notes.txt', 'sess/subagents/agent-1.jsonl').replace('agent-1', 'none')]));
    writeFileSync(join(dir, 'plain.jsonl'), '{"x":1}\n');
    const none2 = await M.runGrep('/usr/bin/nice', M.grepArgs([join(dir, 'plain.jsonl')]));
    check('grep finding nothing (exit 1) is no error', none2.code === 1 && none2.stdout === '' && (none.code === 1 || none.code === 2), [none, none2]);

    {
      const out = M.parseGrepOutput([
        `/f/a.jsonl:"${vpub('/p/x.html', ID, 1795365598)}`,
        `/f/a.jsonl: Published /p/y.html at https://claude.ai/code/artifact/${ID2}`,
        `/f/unknown.jsonl:"${vpub('/p/x.html', ID3, 1)}`,
        '/f/a.jsonl:"Published /p/z.html at https://claude.ai/code/arti',
        '/f/a.jsonl:"Published relative.html at https://claude.ai/code/artifact/' + ID4,
        'junk',
      ].join('\n'), new Map([['/f/a.jsonl', 42]]));
      check('grep output: version id is the publish time (seconds), else the file mtime; junk, unknown files, cut addresses and relative paths dropped',
        out.length === 2 && out[0].id === ID && out[0].at === 1795365598000 && out[0].path === '/p/x.html' && out[0].start === true && out[1].id === ID2 && out[1].at === 42 && out[1].start === false, out);
    }
    {
      const mt = new Map([['/f/a.jsonl', 42]]);
      // N1: the reviewer's real case: a quote cut one character short
      let out = M.parseGrepOutput(`/f/a.jsonl:"Published /p/m.html at https://claude.ai/code/artifact/${ID.slice(0, 35)}\n/f/a.jsonl:nPublished /p/m.html at https://claude.ai/code/artifact/8ae49267-5d39-448d-8bfd-2`, mt);
      check('N1: a publish whose id is cut short is dropped', out.length === 0, out);
      // N5: two publishes in one string, nothing between
      out = M.parseGrepOutput(`/f/a.jsonl:"Published /p/one.html at https://claude.ai/code/artifact/${ID} Published /p/two.html at https://claude.ai/code/artifact/${ID2} (Version 2, version id 1790000000-ab)`, mt);
      check('N5: two publishes in one unescaped string are two, each with its own path', out.length === 2 && out[0].id === ID && out[0].path === '/p/one.html' && out[0].start && out[1].id === ID2 && out[1].path === '/p/two.html' && out[1].at === 1790000000000 && !out[1].start, out);
      out = M.parseGrepOutput('/f/a.jsonl:xPublished /p/q.html at https://claude.ai/code/artifact/' + ID, mt);
      check('a publish after any other character is a quote and is not read', out.length === 0, out);
      // N6: a version time far in the future is not believed; a line starting a result's text is marked
      out = M.parseGrepOutput(`/f/a.jsonl: Published /p/x.html at https://claude.ai/code/artifact/${ID} (Version 1, version id 9999999999-ab)\n/f/a.jsonl:"Published /p/x.html at https://claude.ai/code/artifact/${ID2} (Version 1, version id 1790000000-ab)`, mt, 1795000000000);
      check('N6: a version time a day or more ahead counts as none (mtime, unversioned)', out[0]?.at === 42 && out[0]?.versioned === false && out[0]?.start === false, out[0]);
      check('N6: a line that starts a tool result\'s text is marked as such', out[1]?.start === true && out[1]?.versioned === true && out[1]?.at === 1790000000000, out[1]);
      const pub = (id, at, start, versioned) => ({ id, path: '/p/s.html', at, start, versioned });
      // N4: a tie goes to the later line
      let paths = M.pathsToRead([pub(ID, 42, true, false), pub(ID2, 42, true, false)], new Set([ID, ID2]));
      check('N4: two publishes of a path with the same time: the later line wins', paths.get(ID2) === '/p/s.html' && !paths.has(ID), [...paths]);
      paths = M.pathsToRead([pub(ID, 100, true, false), pub(ID2, 42, true, false)], new Set([ID, ID2]));
      check('with no version ids, the later time wins', paths.get(ID) === '/p/s.html' && !paths.has(ID2), [...paths]);
      paths = M.pathsToRead([pub(ID, 100, true, true), pub(ID2, 9e12, false, true)], new Set([ID, ID2]));
      check('N6: a newer publish quoted inside other text does not shadow one that starts a result', paths.get(ID) === '/p/s.html' && !paths.has(ID2), [...paths]);
      // N9: with transcripts unsearched, a winner counts only if newer than all of them
      paths = M.pathsToRead([pub(ID, 1_000_000_000, true, true)], new Set([ID]), 1_000_000_000 - 3_600_000);
      const paths2 = M.pathsToRead([pub(ID, 1_000_000_000, true, true)], new Set([ID]), 1_000_000_000);
      check('N9: an unsearched transcript older than the winner changes nothing; one as new could hold a newer publish', paths.get(ID) === '/p/s.html' && paths2.size === 0, [[...paths], [...paths2]]);
    }
    {
      // N1 end to end: the real id's publish, and a later transcript quoting it cut short in a Bash result
      const e2e = join(dir, 'e2e', 'projects', '-Users-m-x');
      mkdirSync(e2e, { recursive: true });
      const hero = page('hero.html', '<title>Martello hero</title>');
      const REAL = '57f3db27-890b-4d63-a204-97c9e2aa48c4';
      write(join(e2e, 'pub.jsonl'), vLines(hero, REAL, T - 1000, 10), T - 900);
      const q = toolUse('Bash', { command: 'grep Published x' });
      write(join(e2e, 'quote.jsonl'), [q.line, result(q.id, `log:\nPublished ${hero} at https://claude.ai/code/artifact/${REAL.slice(0, 35)}`)], T);
      const { s: es, store: estore } = memStore();
      const ebook = new M.PageTitleBook({ store: estore, log() {}, now: () => now });
      const re = await M.runBackfill(ebook, [REAL], { projectsDir: join(dir, 'e2e', 'projects'), log() {}, now: () => now });
      check('N1 end to end: a cut quote in a newer transcript does not shadow the real id', ebook.titles()[REAL] === 'Martello hero' && re.found === 1 && re.missed === 0 && es.misses === undefined, { re, t: ebook.titles() });
    }
    {
      // N3: a projects folder that can't be listed, or a folder in it, records no misses
      const { s: ns, store: nstore } = memStore();
      const nbook = new M.PageTitleBook({ store: nstore, log() {}, now: () => now });
      const rn = await M.runBackfill(nbook, [ID2, ID3], { projectsDir: join(dir, 'nowhere-at-all'), log() {}, now: () => now });
      check('N3: an unreadable projects folder records no misses', ns.misses === undefined && rn.unreadable === 1 && rn.batches === 0, { rn, misses: ns.misses });
      const lock = join(dir, 'locked', 'projects');
      mkdirSync(join(lock, '-Users-m-shut'), { recursive: true });
      mkdirSync(join(lock, '-Users-m-open'), { recursive: true });
      write(join(lock, '-Users-m-open', 'o.jsonl'), vLines(walk, ID, T - 10), T - 5);
      execFileSync('/bin/chmod', ['000', join(lock, '-Users-m-shut')]);
      try {
        const { s: ls, store: lstore } = memStore();
        const lbook = new M.PageTitleBook({ store: lstore, log() {}, now: () => now });
        const rl = await M.runBackfill(lbook, [ID, ID3], { projectsDir: lock, log() {}, now: () => now });
        check('N3: a folder that can\'t be listed: no misses, and (its mtimes unknown) nothing learned', ls.misses === undefined && rl.unreadable === 1 && !lbook.has(ID), { rl, misses: ls.misses });
      } finally {
        execFileSync('/bin/chmod', ['755', join(lock, '-Users-m-shut')]);
      }
    }

    // Batches: 450 transcripts give three greps of at most 200 files; the second fails
    // (a timeout kill whose message holds the whole argv), the others' titles are kept.
    const many = join(dir, 'many', 'projects');
    const mp = join(many, '-Users-m-big');
    mkdirSync(mp, { recursive: true });
    const B1 = 'b1b1b1b1-0000-4000-8000-000000000001';
    const B2 = 'b2b2b2b2-0000-4000-8000-000000000002';
    const B3 = 'b3b3b3b3-0000-4000-8000-000000000003';
    const B4 = 'b4b4b4b4-0000-4000-8000-000000000004';
    const bp = [page('b1.html', '<title>Batch one</title>'), page('b2.html', '<title>Batch two</title>'), page('b3.html', '<title>Batch three</title>')];
    for (let i = 0; i < 450; i++) {
      // B4's publish is older than the newest file of the batch that fails (T - 200): a newer one could be there.
      const lines = i === 5 ? vLines(bp[0], B1, T + 1000) : i === 250 ? vLines(bp[1], B2, T) : i === 440 ? vLines(bp[2], B3, T + 1000) : i === 445 ? vLines(bp[0], B4, T - 5000) : ['{"type":"user"}'];
      write(join(mp, `s-${String(i).padStart(4, '0')}-${'x'.repeat(60)}.jsonl`), lines, T - i);
    }
    const sizes = []; let argBytes = 0; let n = 0;
    const failing = async (file, args, signal) => {
      n++;
      const files = args.slice(args.indexOf('--') + 1);
      sizes.push(files.length);
      argBytes = Math.max(argBytes, args.join(' ').length);
      if (n === 2) throw Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), { code: null, killed: true, signal: 'SIGTERM' });
      return M.runGrep(file, args, signal);
    };
    const blogs = [];
    const { s: bs, store: bstore } = memStore();
    const bbook = new M.PageTitleBook({ store: bstore, log: (m, d) => blogs.push([m, d]), now: () => now });
    const rb = await M.runBackfill(bbook, [B1, B2, B3, B4], { projectsDir: many, run: failing, log: (m, d) => blogs.push([m, d]), now: () => now });
    check('450 files: three sequential greps of at most 200 files', JSON.stringify(sizes) === '[200,200,50]' && argBytes < 64 * 1024, { sizes, argBytes });
    check('a failed batch keeps the others\' titles', bbook.titles()[B1] === 'Batch one' && bbook.titles()[B3] === 'Batch three' && !bbook.has(B2) && rb.failed === 1 && rb.batches === 3, { t: bbook.titles(), rb });
    check('no miss is recorded while a batch failed', bs.misses === undefined, bs.misses);
    check('N9: with a batch failed, a publish older than that batch\'s newest file is not trusted', !bbook.has(B4), bbook.titles());
    const fl = blogs.find(([m]) => m === '[TITLE] backfill batch failed');
    check('a failed batch is logged with counts and the error code, never its message', fl && fl[1].batch === 2 && fl[1].files === 200 && fl[1].killed === true && fl[1].signal === 'SIGTERM' && fl[1].code === null
      && !/\.jsonl|\/usr\/bin|b2b2b2b2|Command failed/.test(JSON.stringify(blogs)), blogs);

    // m2: a quit kills the running grep and starts no more batches
    {
      const ac = new AbortController();
      const mark = `7.${process.pid}`;
      const t0 = Date.now();
      const p = M.runGrep('/bin/sleep', [mark], ac.signal);
      setTimeout(() => ac.abort(), 150);
      let err = null;
      try { await p; } catch (e) { err = e; }
      await new Promise((r) => setTimeout(r, 150));
      let alive = true;
      try { execFileSync('/usr/bin/pgrep', ['-f', `/bin/sleep ${mark}`]); } catch { alive = false; }
      check('an abort kills the child at once and fails with ABORT_ERR', err && M.grepFailure(err).code === 'ABORT_ERR' && Date.now() - t0 < 2000 && !alive, { f: err && M.grepFailure(err), alive, ms: Date.now() - t0 });

      const ac2 = new AbortController();
      let runs = 0;
      const quitting = async (file, args, signal) => {
        runs++;
        ac2.abort();
        return M.runGrep(file, args, signal);
      };
      const { s: qs, store: qstore } = memStore();
      const qbook = new M.PageTitleBook({ store: qstore, log() {}, now: () => now });
      const rq = await M.runBackfill(qbook, [B1, B2, B3], { projectsDir: many, run: quitting, signal: ac2.signal, log() {}, now: () => now });
      check('a quit mid-scan: no further batch starts, nothing recorded as missed', runs === 1 && rq.failed >= 1 && qs.misses === undefined, { runs, rq, misses: qs.misses });
    }

    calls.length = 0;
    const empty = await M.runBackfill(book, [], { projectsDir: join(dir, 'nowhere'), run, log() {}, now: () => now });
    check('no ids: nothing runs', empty.ids === 0 && calls.length === 0);
  });

  // ── 4. wiring, by source
  await section('wiring', async () => {
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
    const main = src('src/main/main.ts');
    check('a quit stops the backfill (before-quit, after the guard)', /app\.on\('before-quit'[\s\S]{0,200}guardBeforeQuit[\s\S]{0,300}stopPageTitleBackfill\(\)/.test(main));
    check('the backfill\'s grep takes the quit signal', /signal: backfillAbort\.signal/.test(pt) && /backfillAbort\.abort\(\)/.test(pt));
    check('title failure logs never carry an error message (it holds argv)', !/\.message/.test(pt) && !/\[TITLE\] learn failed', \{ error/.test(ipc));
    check('the bookmarks read in the timer is guarded', /try \{\s*ids = bookmarkedIds\(\);/.test(pt));
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
