// Check of the session bar's transcript parser (src/main/transcript-parser.ts,
// docs/session-bar.md D6, D9) over scripts/fixtures/session-feed-lines.jsonl:
// made-up content in the line shapes read from real transcripts on this Mac.
// Every expectation is an exact event, so an empty parser fails them all.
// Run: node scripts/check-session-feed.mjs   (no extra dependencies)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
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
    entryPoints: [join(repo, 'src/main/transcript-parser.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
  });
  const { TranscriptParser, cleanText } = createRequire(import.meta.url)(out);
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

  // --- untrusted text
  const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
  const strings = events.flatMap((e) => Object.values(e).filter((v) => typeof v === 'string'));
  check('no control or bidi characters in any sent string', strings.length > 20 && !strings.some((s) => CONTROL.test(s)), strings.length);
  same('cleanText strips controls and caps labels at 120',
    [cleanText('a\u0007b‮c', 120), cleanText('x'.repeat(300), 120).length], ['a b c', 120]);
  check('only the contract fields are sent', events.every((e) => {
    const allowed = {
      'task-start': ['type', 'id', 'kind', 'description', 'command', 'at'],
      'task-end': ['type', 'id', 'status', 'exitCode', 'summary', 'at'],
      link: ['type', 'url', 'path', 'label', 'at'],
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
