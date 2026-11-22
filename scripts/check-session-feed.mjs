// Check of the session bar's transcript parser (src/main/transcript-parser.ts,
// docs/session-bar.md D6, D9) over scripts/fixtures/session-feed-lines.jsonl:
// made-up content in the line shapes read from real transcripts on this Mac.
// Every expectation is an exact event, so an empty parser fails them all.
// Run: node scripts/check-session-feed.mjs   (no extra dependencies)
//   SB_SRC_ROOT=<folder holding src/>  check another source tree (to prove the check bites)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = process.env.SB_SRC_ROOT || repo;
let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
};

const work = mkdtempSync(join(tmpdir(), 'session-feed-'));
try {
  const out = join(work, 'parser.cjs');
  await build({
    entryPoints: [join(srcRoot, 'src/main/transcript-parser.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
  });
  const { TranscriptParser, cleanText, extractLinks, parseNotifications } = createRequire(import.meta.url)(out);
  const HOME = '/Users/tester';
  const text = readFileSync(join(repo, 'scripts/fixtures/session-feed-lines.jsonl'), 'utf8');
  const t = (iso) => Date.parse(iso);

  const parser = new TranscriptParser({ home: HOME, now: () => 0 });
  let events = [];
  let threw = null;
  try { events = parser.push(text); } catch (err) { threw = String(err); }
  check('the fixture parses without throwing', threw === null, threw);

  const of = (type) => events.filter((e) => e.type === type);
  const find = (type, pred) => events.find((e) => e.type === type && pred(e));
  // Key order doesn't matter: compare with keys sorted.
  const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
  const same = (name, actual, expected) =>
    check(name, canon(actual) === canon(expected), { actual, expected });

  // --- task starts
  same('background shell (backgroundTaskId) starts with its description and command',
    find('task-start', (e) => e.id === 'bq7x2k9ab'),
    { type: 'task-start', id: 'bq7x2k9ab', kind: 'shell', description: 'Build the demo app', command: 'npm run build', at: t('2026-11-22T10:00:01.000Z') });
  same('shell moved to the background by its timeout starts (text only), control characters stripped',
    find('task-start', (e) => e.id === 'bt2m4n6pq'),
    { type: 'task-start', id: 'bt2m4n6pq', kind: 'shell', description: 'Run [31m the tests slowly', command: 'make test', at: t('2026-11-22T10:03:00.000Z') });
  const agent = find('task-start', (e) => e.id === 'a1b2c3d4e5f6a7b8c');
  check('background agent starts as an agent, no command', agent?.kind === 'agent' && agent.command === undefined && agent.at === t('2026-11-22T10:04:01.000Z'), agent);
  check('a long description is capped at 200 characters with an ellipsis',
    agent?.description.length === 200 && agent.description.endsWith('…') && agent.description.startsWith('Review the parser'), agent?.description.length);
  same('monitor starts with its description and command',
    find('task-start', (e) => e.id === 'm9k8j7h6g'),
    { type: 'task-start', id: 'm9k8j7h6g', kind: 'monitor', description: 'Watch the deploy log', command: 'tail -f deploy.log', at: t('2026-11-22T10:05:01.000Z') });
  same('workflow starts',
    find('task-start', (e) => e.id === 'w5v4u3t2s'),
    { type: 'task-start', id: 'w5v4u3t2s', kind: 'workflow', description: 'Run the demo workflow', at: t('2026-11-22T10:06:01.000Z') });
  same('exactly the five background starts, in order (a foreground Bash is not one)',
    of('task-start').map((e) => e.id), ['bq7x2k9ab', 'bt2m4n6pq', 'a1b2c3d4e5f6a7b8c', 'm9k8j7h6g', 'w5v4u3t2s']);

  // --- task ends
  same('completed shell ends once, with exit code 0, though its notice is written three times',
    of('task-end').filter((e) => e.id === 'bq7x2k9ab'),
    [{ type: 'task-end', id: 'bq7x2k9ab', status: 'completed', exitCode: 0, summary: 'Background command "Build the demo app" completed (exit code 0)', at: t('2026-11-22T10:07:00.000Z') }]);
  same('failed shell ends from a user line, with exit code 1',
    find('task-end', (e) => e.id === 'bt2m4n6pq'),
    { type: 'task-end', id: 'bt2m4n6pq', status: 'failed', exitCode: 1, summary: 'Background command "Run the tests slowly" failed with exit code 1', at: t('2026-11-22T10:08:00.000Z') });
  same('killed agent ends from a queued_command attachment',
    find('task-end', (e) => e.id === 'a1b2c3d4e5f6a7b8c'),
    { type: 'task-end', id: 'a1b2c3d4e5f6a7b8c', status: 'killed', summary: 'Agent "Review the parser" was stopped by Claude', at: t('2026-11-22T10:09:00.000Z') });
  same('a Monitor event is not an end; its stream ending is',
    of('task-end').filter((e) => e.id === 'm9k8j7h6g').map((e) => [e.status, e.at]),
    [['completed', t('2026-11-22T10:10:00.000Z')]]);
  same('exactly five ends; a subagent\'s shell notice and one inside an api-request-blob line are ignored',
    of('task-end').map((e) => e.id), ['bq7x2k9ab', 'bt2m4n6pq', 'a1b2c3d4e5f6a7b8c', 'm9k8j7h6g', 'w5v4u3t2s']);

  // --- wake-ups
  same('ScheduleWakeup: fireAt = the line time + delaySeconds; a stop call is no wake-up',
    of('wake'),
    [{ type: 'wake', fireAt: t('2026-11-22T10:11:00.000Z') + 270_000, at: t('2026-11-22T10:11:00.000Z'), prompt: 'Check the build' }]);

  // --- links
  const links = of('link').map((e) => [e.url ?? e.path, e.label]);
  same('links from assistant text only, in order, with markdown labels, page ids, file names; v1 and v2 both sent; a link written twice sent twice',
    links, [
      ['https://claude.ai/code/artifact/08d6e409-4c7d-4f4e-8fe1-ceb84b75c586', 'Sketch v3'],
      ['https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit', 'Page 1AbCdEfG'],
      ['https://github.com/demo/repo/pull/42', 'Page 42'],
      ['https://github.com/demo/repo/releases/tag/v1.2.3', 'Page v1.2.3'],
      ['/Users/tester/Downloads/Report v1.docx', 'Report v1.docx'],
      ['/Users/tester/Downloads/Report v2.docx', 'Report v2.docx'],
      ['https://claude.ai/code/artifact/08d6e409-4c7d-4f4e-8fe1-ceb84b75c586', 'Page 08d6e409'],
      ['https://drive.google.com/file/d/1ZyXwVuT/view', 'A label'],
      ['https://docs.google.com/spreadsheets/d/1QqQqQqQ/edit#gid=0', 'the sheet'],
    ]);
  check('each link has exactly one of url / path, and its line time',
    of('link').length > 0 && of('link').every((e) => (e.url === undefined) !== (e.path === undefined) && e.at > 0), of('link').length);

  // --- one event per URL or path within one message; the markdown label wins (D6)
  {
    const U = 'https://claude.ai/code/artifact/bbbbbbbb-2222-4222-8222-222222222222';
    const line = (blocks) => JSON.stringify({ isSidechain: false, type: 'assistant', timestamp: '2026-11-22T11:00:00.000Z', message: { role: 'assistant', content: blocks.map((text) => ({ type: 'text', text })) } }) + '\n';
    const linksOf = (raw) => new TranscriptParser({ home: HOME, now: () => 0 }).push(raw).filter((e) => e.type === 'link');
    same('markdown link then the bare URL in one message: one event, the markdown label',
      linksOf(line([`Here: [Second sketch](${U}) and again ${U}`])).map((e) => [e.url, e.label, e.fallback]), [[U, 'Second sketch', undefined]]);
    same('the bare URL first, the markdown link after: one event, at the first place, the markdown label',
      linksOf(line([`Open ${U} or [Second sketch](${U})`])).map((e) => [e.url, e.label, e.fallback]), [[U, 'Second sketch', undefined]]);
    same('the same across two text blocks of one message',
      linksOf(line([`[Second sketch](${U})`, `${U}`])).map((e) => [e.url, e.label]), [[U, 'Second sketch']]);
    same('a bare URL alone is one event marked as a fallback label',
      linksOf(line([`Open ${U}`])).map((e) => [e.url, e.label, e.fallback]), [[U, 'Page bbbbbbbb', true]]);
    same('a bare path alone is marked as a fallback; one with markdown text is not; the path twice is one event',
      linksOf(line(['~/Downloads/Plan.docx', '[The plan](~/Downloads/Plan.docx) ~/Downloads/Plan.docx'])).map((e) => [e.path, e.label, e.fallback]),
      [['/Users/tester/Downloads/Plan.docx', 'The plan', undefined]]);
    same('two messages each give the link: sent twice (the model merges them)',
      linksOf(line([`[Second sketch](${U})`]) + line([`${U}`])).map((e) => [e.url, e.label, e.fallback]),
      [[U, 'Second sketch', undefined], [U, 'Page bbbbbbbb', true]]);
    same('two different URLs in one message stay two events',
      linksOf(line([`${U} https://github.com/demo/repo/pull/42`])).length, 2);
  }

  // --- untrusted text
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
  const strings = events.flatMap((e) => Object.values(e).filter((v) => typeof v === 'string'));
  check('no control or bidi characters in any sent string', strings.length > 20 && !strings.some((s) => CONTROL.test(s)), strings.length);
  same('cleanText strips controls and caps labels at 120',
    [cleanText('a\u0007b‮c', 120), cleanText('x'.repeat(300), 120).length], ['a b c', 120]);
  check('only the contract fields are sent', events.every((e) => {
    const allowed = {
      'task-start': ['type', 'id', 'kind', 'description', 'command', 'at'],
      'task-end': ['type', 'id', 'status', 'exitCode', 'summary', 'at'],
      link: ['type', 'url', 'path', 'label', 'at', 'fallback'],
      wake: ['type', 'fireAt', 'prompt', 'at'],
    }[e.type];
    return allowed && Object.keys(e).every((k) => allowed.includes(k));
  }), events.map((e) => e.type));

  // --- malformed and partial lines
  check('malformed lines are counted and ignored', parser.badLines === 2, parser.badLines);
  for (const size of [1, 7, 997]) {
    const p = new TranscriptParser({ home: HOME, now: () => 0 });
    const got = [];
    for (let i = 0; i < text.length; i += size) got.push(...p.push(text.slice(i, i + size)));
    same(`fed in ${size}-character chunks, the same events`, got, events);
  }

  // --- pathological text stays fast (review A): each under 50 ms
  const timed = (fn) => { const t0 = process.hrtime.bigint(); let r; try { r = fn(); } catch (err) { r = err; } return { ms: Number(process.hrtime.bigint() - t0) / 1e6, r }; };
  const slow = [
    ['`[a](x` and 32,000 spaces', () => extractLinks('[a](x' + ' '.repeat(32000), HOME, 0)],
    ['`[a](<x` and 32,000 spaces', () => extractLinks('[a](<x' + ' '.repeat(32000), HOME, 0)],
    ['`[a](x` 13,000 times', () => extractLinks('[a](x'.repeat(13000), HOME, 0)],
    ['`](` 40,000 times', () => extractLinks('[' + ']('.repeat(40000), HOME, 0)],
    ['`~/Downloads/` 8,000 times', () => extractLinks('~/Downloads/'.repeat(8000), HOME, 0)],
    ['`~/Downloads/a ` 8,000 times then .pdf', () => extractLinks('~/Downloads/a '.repeat(8000) + 'x.pdf', HOME, 0)],
    ['an unclosed `<task-notification>` 16,000 times', () => parseNotifications('<task-notification>'.repeat(16000), 0)],
    ['a notice with 16,000 unclosed `<summary>`', () => parseNotifications('<task-notification>' + '<summary>'.repeat(16000) + '</task-notification>', 0)],
  ];
  for (const [name, fn] of slow) {
    const { ms } = timed(fn);
    check(`${name} parses in under 50 ms`, ms < 50, `${ms.toFixed(1)} ms`);
  }
  {
    const many = '[x](https://claude.ai/artifact/abcdefgh) https://claude.ai/artifact/zzzzzzzz '.repeat(20000);
    const pl = new TranscriptParser({ home: HOME, now: () => 0 });
    const line = JSON.stringify({ parentUuid: 'a', type: 'assistant', timestamp: '2026-11-22T10:00:00Z', message: { content: [{ type: 'text', text: many }] } }) + '\n';
    const { ms, r } = timed(() => pl.push(line));
    check('1.5 MB of links in one block parses in under 50 ms', ms < 50, `${ms.toFixed(1)} ms`);
    check('one line gives at most 20 link events', Array.isArray(r) && r.filter((e) => e.type === 'link').length <= 20, Array.isArray(r) ? r.length : String(r));
    const distinct = Array.from({ length: 30 }, (_, i) => `https://claude.ai/artifact/page${String(i).padStart(4, '0')}`).join(' ');
    const ev2 = new TranscriptParser({ home: HOME, now: () => 0 }).push(JSON.stringify({ parentUuid: 'a', type: 'assistant', timestamp: '2026-11-22T10:00:00Z', message: { content: [{ type: 'text', text: distinct }] } }) + '\n');
    check('30 distinct links in one line: the first 20 kept, in order', ev2.length === 20 && ev2[0].url.endsWith('page0000') && ev2[19].url.endsWith('page0019'), ev2.length);
  }
  // The linear scans still read what the regexes read.
  same('markdown link with spaces inside the parentheses',
    extractLinks('see [Plan v2]( https://claude.ai/code/artifact/abcd1234 ) now', HOME, 5),
    [{ type: 'link', url: 'https://claude.ai/code/artifact/abcd1234', label: 'Plan v2', at: 5 }]);
  same('markdown link in angle brackets, a file under ~/Downloads',
    extractLinks('[The brief](<~/Downloads/Q3 brief.docx>)', HOME, 5),
    [{ type: 'link', path: `${HOME}/Downloads/Q3 brief.docx`, label: 'The brief', at: 5 }]);
  same('a bare Downloads path with spaces, then one with a space after a slash (refused)',
    extractLinks('Saved ~/Downloads/Lindus/Board pack v3.pdf and ~/Downloads/ x.pdf.', HOME, 5),
    [{ type: 'link', path: `${HOME}/Downloads/Lindus/Board pack v3.pdf`, label: 'Board pack v3.pdf', fallback: true, at: 5 }]);
  same('a full-home Downloads path ends at its extension',
    extractLinks(`open ${HOME}/Downloads/report.xlsx, then`, HOME, 5),
    [{ type: 'link', path: `${HOME}/Downloads/report.xlsx`, label: 'report.xlsx', fallback: true, at: 5 }]);
  same('two notices in one string, the first closed tag of each read',
    parseNotifications('<task-notification><task-id>t1</task-id><status>completed</status></task-notification> x <task-notification><task-id>t2</task-id><status>failed</status><summary>failed with exit code 3</summary></task-notification>', 7),
    [{ type: 'task-end', id: 't1', status: 'completed', at: 7 }, { type: 'task-end', id: 't2', status: 'failed', exitCode: 3, summary: 'failed with exit code 3', at: 7 }]);

  // --- launch sentences only from the tool that launches (review B)
  const startsFrom = (name, input, content, tur) => {
    const pp = new TranscriptParser({ home: HOME, now: () => 0 });
    const lines = [
      { parentUuid: 'a', type: 'assistant', timestamp: '2026-11-22T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'tu1', name, input }] } },
      { parentUuid: 'b', type: 'user', timestamp: '2026-11-22T10:00:01Z', ...(tur ? { toolUseResult: tur } : {}), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content }] } },
    ];
    return pp.push(lines.map((l) => JSON.stringify(l)).join('\n') + '\n').filter((e) => e.type === 'task-start');
  };
  check('a Read result quoting the background sentence starts nothing',
    startsFrom('Read', { file_path: '/x/f.jsonl' }, 'line 12: "Command running in background with ID: b4k2m9x. Output"').length === 0);
  check('a foreground Bash grep quoting it starts nothing',
    startsFrom('Bash', { command: 'grep -n running src/x' }, [{ type: 'text', text: 'x.ts:3: Command running in background with ID: fakeid99.' }]).length === 0);
  check('a foreground Bash whose output starts with the sentence starts nothing',
    startsFrom('Bash', { command: 'cat notes.txt' }, 'Command running in background with ID: fakeid98. Output').length === 0);
  check('a Read result quoting the timeout sentence starts nothing',
    startsFrom('Read', { file_path: '/x' }, 'Command did not complete within its 120s timeout and was moved to the background (ID: bzz11). Output').length === 0);
  check('a Read result opening with the agent sentence starts nothing',
    startsFrom('Read', { file_path: '/x' }, 'Async agent launched successfully. agentId: a1234567').length === 0);
  check('a Bash result opening with the monitor sentence starts nothing',
    startsFrom('Bash', { command: 'cat m' }, 'Monitor started (task m1234567, timeout 60s)').length === 0);
  check('a Bash result opening with the workflow sentence starts nothing',
    startsFrom('Bash', { command: 'cat w' }, 'Workflow launched in background. Task ID: w1234567').length === 0);
  same('a background Bash call with only the result text starts a shell',
    startsFrom('Bash', { command: 'npm test', description: 'Tests', run_in_background: true }, 'Command running in background with ID: b77. Output is being written to: /tmp/b77'),
    [{ type: 'task-start', id: 'b77', kind: 'shell', description: 'Tests', command: 'npm test', at: t('2026-11-22T10:00:01Z') }]);
  same('a foreground Bash moved by its timeout, text only, starts a shell',
    startsFrom('Bash', { command: 'make', description: 'Build' }, 'Command did not complete within its 120s timeout and was moved to the background (ID: b78). Output'),
    [{ type: 'task-start', id: 'b78', kind: 'shell', description: 'Build', command: 'make', at: t('2026-11-22T10:00:01Z') }]);

  // --- a wake-up more than 7 days off is dropped (review J)
  const wakes = (d) => new TranscriptParser({ home: HOME, now: () => 0 }).push(JSON.stringify({ parentUuid: 'a', type: 'assistant', timestamp: '2026-11-22T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'w', name: 'ScheduleWakeup', input: { delaySeconds: d, prompt: 'hi' } }] } }) + '\n').filter((e) => e.type === 'wake');
  check('ScheduleWakeup of 1e12 s gives no wake-up', wakes(1e12).length === 0, wakes(1e12));
  check('ScheduleWakeup of 1e308 s gives no wake-up', wakes(1e308).length === 0, wakes(1e308));
  check('ScheduleWakeup of 7 days + 1 s gives no wake-up', wakes(7 * 86400 + 1).length === 0);
  check('ScheduleWakeup of exactly 7 days is kept', wakes(7 * 86400).length === 1 && wakes(7 * 86400)[0].fireAt === t('2026-11-29T10:00:00Z'), wakes(7 * 86400));
  const lastLineStart = text.lastIndexOf('\n', text.length - 2) + 1;
  const linkLine = text.lastIndexOf('\n', text.indexOf('A\\u0007 label')) + 1;
  const p2 = new TranscriptParser({ home: HOME, now: () => 0 });
  const before = p2.push(text.slice(0, linkLine + 40));
  check('a partial line gives nothing until its newline', before.length > 0 && !before.some((e) => e.label === 'A label'), before.length);
  const after = p2.push(text.slice(linkLine + 40));
  check('the carried-over line parses once completed', after.some((e) => e.label === 'A label'), after.length);
  check('fixture ends with a whole line', lastLineStart < text.length);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`${passed} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
