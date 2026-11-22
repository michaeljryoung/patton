// Headless check of the session bar's per-pane state (docs/session-bar.md, D3–D6;
// map node bar_model): src/renderer/services/session-bar-model.ts and its cron
// reader, services/cron-next.ts. Pure: no DOM.
// Covers: 7501 children, feed task-start/-end and the Stop hook's taskList merged into
// one row per id; the hook's reconcile (a missing id ends, an unknown one is added, a
// 7501-reported one stays); ended rows linger 30 s; ages and the over-an-hour flag;
// cron next-fire in local time and an unparseable schedule shown as itself; wake-ups;
// failures from task-end failed/killed and the 7501 root `error`, kept until dismissed,
// at most 10; link keys (the same URL twice is one row moved up; `Plan.docx` then
// `Plan v2.docx` is one row), at most 8 newest first; the stop-list adapter.
// Run: node scripts/check-session-bar-model.mjs
//   SB_SRC_ROOT=<folder holding src/>  check another source tree (to prove the check bites)
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = process.env.SB_SRC_ROOT ? resolve(process.env.SB_SRC_ROOT) : repo;
const dir = mkdtempSync(join(tmpdir(), 'sbmodel-'));
const out = join(dir, 'model.mjs');
let M;
try {
  const res = await build({
    stdin: {
      resolveDir: srcRoot, loader: 'ts',
      contents: `export * from './src/renderer/services/session-bar-model';
                 export { nextCronFire, parseCron } from './src/renderer/services/cron-next';`,
    },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    nodePaths: [join(repo, 'node_modules')],
  });
  writeFileSync(out, res.outputFiles[0].text);
  M = await import(pathToFileURL(out).href);
} catch (err) {
  console.log(`not ok the model bundles: ${String(err.message || err).split('\n')[0]}`);
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`ok ${name}`); }
  else { failed++; console.log(`not ok ${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`); }
}
const rec = (state, title = null, msg = null) => ({ state, kind: null, progress: null, app: 'claude-code', title, msg });
const T0 = new Date(2026, 10, 22, 10, 0, 0).getTime();
const S = 1000;
const MIN = 60 * S;

// ── 1. Running: the three sources merge by id ──
{
  const m = new M.SessionBarModel();
  let changes = 0;
  m.onChange(() => changes++);
  m.applyProgramRecords(rec('working'), [{ id: 'a1', record: rec('working', 'Map what Patton can show') }], T0);
  let v = m.view(T0 + 40 * S);
  check('7501 child: one Agent row with its title', v.running.length === 1 && v.running[0].kind === 'Agent' && v.running[0].description === 'Map what Patton can show', v.running);
  check('7501 child: age 40 s', v.running[0].age === '40 s', v.running[0].age);
  check('a change is announced', changes >= 1, changes);
  m.applyFeed({ type: 'task-start', id: 'b7', kind: 'shell', description: 'gh run watch 4501', command: 'gh run watch 4501 --exit-status', at: T0 + 10 * S }, T0 + 10 * S);
  m.applyFeed({ type: 'task-start', id: 'a1', kind: 'workflow', description: 'Map flow', at: T0 + 5 * S }, T0 + 12 * S);
  v = m.view(T0 + 60 * S);
  check('feed start for a 7501 id: still one row, the feed\'s kind', v.running.filter((r) => r.id === 'a1').length === 1 && v.running.find((r) => r.id === 'a1').kind === 'Workflow', v.running);
  check('feed shell: Shell row, command in the tooltip', v.running.some((r) => r.id === 'b7' && r.kind === 'Shell' && r.tooltip.includes('--exit-status')), v.running);
  check('oldest first', v.running.map((r) => r.id).join() === 'a1,b7', v.running.map((r) => r.id));
  check('live count 2', v.liveCount === 2, v.liveCount);
  // Hook reconcile: b7 missing ends; c3 unknown is added; a1 still in 7501 stays.
  m.applyStop({ tasks: 1, taskList: [{ id: 'c3', type: 'monitor', d: 'main.log for [COMPOSE] room' }], cronList: null, transcriptPath: null }, T0 + 2 * MIN);
  v = m.view(T0 + 2 * MIN);
  const b7 = v.running.find((r) => r.id === 'b7');
  check('reconcile: an id missing from the list ends (struck, "done")', b7 && b7.ended && b7.endLabel === 'done', b7);
  check('reconcile: an unknown listed id is added from the list (Monitor)', v.running.some((r) => r.id === 'c3' && r.kind === 'Monitor' && r.description === 'main.log for [COMPOSE] room' && !r.ended), v.running);
  check('reconcile: an id 7501 still reports stays running', v.running.some((r) => r.id === 'a1' && !r.ended), v.running);
  check('reconcile: no list (an older hook) ends nothing', (() => {
    m.applyStop({ tasks: 1, taskList: null, cronList: null, transcriptPath: null }, T0 + 2 * MIN);
    return m.view(T0 + 2 * MIN).running.find((r) => r.id === 'c3' && !r.ended);
  })());
  // Linger
  check('ended row lingers at 29 s', m.view(T0 + 2 * MIN + 29 * S).running.some((r) => r.id === 'b7'));
  check('ended row gone at 30 s', !m.view(T0 + 2 * MIN + 30 * S).running.some((r) => r.id === 'b7'));
  // 7501 clear ends a child
  m.applyProgramRecords(rec('working'), [], T0 + 3 * MIN);
  v = m.view(T0 + 3 * MIN);
  check('a child cleared from 7501 ends', v.running.some((r) => r.id === 'a1' && r.ended), v.running);
  // Feed task-end ends a row
  m.applyFeed({ type: 'task-end', id: 'c3', status: 'completed', at: T0 + 3 * MIN }, T0 + 3 * MIN);
  check('feed task-end completed: ended, no failure', m.view(T0 + 3 * MIN).running.some((r) => r.id === 'c3' && r.ended) && m.view(T0 + 3 * MIN).failures.length === 0);
}

// ── 2. Ages and the hour flag ──
{
  check('formatAge 40 s', M.formatAge(40 * S) === '40 s');
  check('formatAge 6 min', M.formatAge(6 * MIN + 30 * S) === '6 min');
  check('formatAge 3 h 34', M.formatAge(3 * 60 * MIN + 34 * MIN) === '3 h 34', M.formatAge(3 * 60 * MIN + 34 * MIN));
  check('formatAge 1 h 05', M.formatAge(65 * MIN) === '1 h 05', M.formatAge(65 * MIN));
  const m = new M.SessionBarModel();
  m.applyFeed({ type: 'task-start', id: 'm1', kind: 'monitor', description: 'tail', at: T0 }, T0);
  check('59 min: not long', m.view(T0 + 59 * MIN).running[0].long === false);
  check('60 min: long', m.view(T0 + 60 * MIN).running[0].long === true);
}

// ── 3. Scheduled: cron next-fire, unparseable, wake-ups ──
{
  const now = new Date(2026, 10, 22, 11, 21, 30).getTime();
  const at = (h, mi, d = 22) => new Date(2026, 10, d, h, mi, 0, 0).getTime();
  check('cron */20 * * * * from 11:21:30 → 11:40', M.nextCronFire('*/20 * * * *', now) === at(11, 40), new Date(M.nextCronFire('*/20 * * * *', now)).toString());
  check('cron 0 9 * * * → tomorrow 09:00', M.nextCronFire('0 9 * * *', now) === at(9, 0, 23));
  check('cron 30 11 * * * → 11:30 today', M.nextCronFire('30 11 * * *', now) === at(11, 30));
  // 22 Nov 2026 is a Sunday; next Monday is the 23rd.
  check('cron 0 8 * * MON → Mon 23 Nov 08:00', M.nextCronFire('0 8 * * MON', now) === at(8, 0, 23));
  check('cron 0 8 * * 1-5 → Mon 23 Nov 08:00', M.nextCronFire('0 8 * * 1-5', now) === at(8, 0, 23));
  check('cron 7 = Sunday: 0 12 * * 7 → today 12:00', M.nextCronFire('0 12 * * 7', now) === at(12, 0));
  check('cron dom+dow either: 0 0 1 * 1 → Mon 23 Nov', M.nextCronFire('0 0 1 * 1', now) === at(0, 0, 23));
  check('cron 0 0 29 2 * → 29 Feb 2028', M.nextCronFire('0 0 29 2 *', now) === new Date(2028, 1, 29, 0, 0).getTime());
  check('cron unparseable → null', M.nextCronFire('every 20 minutes', now) === null && M.nextCronFire('61 * * * *', now) === null && M.nextCronFire('* * * *', now) === null);
  const m = new M.SessionBarModel();
  m.applyStop({ tasks: 0, taskList: null, transcriptPath: null, cronList: [
    { id: 'k1', s: '*/20 * * * *', r: true, p: '/loop 20m check the release' },
    { id: 'k2', s: 'whenever', r: true, p: 'x'.repeat(100) },
  ] }, now);
  let v = m.view(now);
  const loop = v.scheduled.find((r) => r.key === 'cron:k1');
  check('cron row: Loop, prompt, next fire 11:40', loop && loop.kind === 'Loop' && loop.when === '11:40' && loop.prompt === '/loop 20m check the release', loop);
  const bad = v.scheduled.find((r) => r.key === 'cron:k2');
  check('unparseable schedule: shows the expression', bad && bad.when === 'whenever' && bad.nextFire === null, bad);
  check('prompt cut to 60 characters', bad && Array.from(bad.prompt).length === 60, bad && bad.prompt.length);
  check('parseable before unparseable', v.scheduled[0].key === 'cron:k1');
  m.applyFeed({ type: 'wake', fireAt: at(11, 30), prompt: 'check CI', at: now }, now);
  v = m.view(now);
  check('wake-up: a Wake row at 11:30, first', v.scheduled[0].kind === 'Wake' && v.scheduled[0].when === '11:30', v.scheduled);
  check('wake-up: gone once its time passes', !m.view(at(11, 30) + 1).scheduled.some((r) => r.kind === 'Wake'));
  m.applyFeed({ type: 'wake', fireAt: at(12, 5), prompt: 'one-off', at: now }, now);
  m.applyStop({ tasks: 0, taskList: null, transcriptPath: null, cronList: [{ id: 'k3', s: '5 12 22 11 *', r: false, p: 'one-off' }] }, now);
  v = m.view(now);
  check('a wake-up the cron list also carries is one row', v.scheduled.filter((r) => r.prompt === 'one-off').length === 1, v.scheduled);
}

// ── 4. Failures ──
{
  const m = new M.SessionBarModel();
  m.applyFeed({ type: 'task-start', id: 's1', kind: 'shell', description: 'npm run check', at: T0 }, T0);
  const notes = m.applyFeed({ type: 'task-end', id: 's1', status: 'failed', exitCode: 1, at: T0 + MIN }, T0 + MIN);
  let v = m.view(T0 + MIN);
  check('task-end failed: a failure "npm run check: exit 1" (Shell)', v.failures.length === 1 && v.failures[0].text === 'npm run check: exit 1' && v.failures[0].kind === 'Shell', v.failures);
  check('task-end failed: a failure note for the log', notes.length === 1 && notes[0].note === 'failure' && notes[0].kind === 'Shell', notes);
  check('task-end failed: the row ends "failed"', v.running[0].ended && v.running[0].endLabel === 'failed', v.running[0]);
  m.applyFeed({ type: 'task-end', id: 's1', status: 'failed', exitCode: 1, at: T0 + MIN }, T0 + MIN);
  check('the same task\'s end twice: one failure', m.view(T0 + MIN).failures.length === 1);
  m.applyFeed({ type: 'task-end', id: 'zz', status: 'killed', at: T0 + MIN }, T0 + MIN);
  check('killed, never seen started: a failure', m.view(T0 + MIN).failures.some((f) => f.text.endsWith('killed')));
  m.applyFeed({ type: 'task-end', id: 'st', status: 'stopped', at: T0 + MIN }, T0 + MIN);
  check('stopped: not a failure', m.view(T0 + MIN).failures.length === 2);
  m.applyProgramRecords(rec('error', null, 'API error 529, overloaded'), [], T0 + 2 * MIN);
  m.applyProgramRecords(rec('error', null, 'API error 529, overloaded'), [], T0 + 2 * MIN + 1);
  v = m.view(T0 + 3 * MIN);
  check('7501 root error: one Claude failure with its msg (once per spell)', v.failures.filter((f) => f.kind === 'Claude').length === 1 && v.failures[0].text === 'API error 529, overloaded', v.failures);
  check('failures kept long after (not lingering)', m.view(T0 + 5 * 60 * MIN).failures.length === 3);
  check('dismiss removes one', m.dismissFailure(v.failures[0].key) && m.view(T0).failures.length === 2);
  for (let i = 0; i < 15; i++) m.applyFeed({ type: 'task-end', id: `x${i}`, status: 'failed', exitCode: i, at: T0 + i }, T0 + 10 * MIN);
  v = m.view(T0 + 10 * MIN);
  check('at most 10 failures, the oldest dropped, newest first', v.failures.length === 10 && v.failures[0].text === 'x14: exit 14' && v.failures[9].text === 'x5: exit 5', v.failures.map((f) => f.text));
}

// ── 5. Links ──
{
  check('urlKey strips trailing punctuation', M.urlKey('https://claude.ai/code/artifact/abc).') === 'https://claude.ai/code/artifact/abc');
  check('fileKey: Plan.docx = Plan v2.docx = plan-v3.docx = Plan (2).docx', new Set(['/Users/m/Downloads/Plan.docx', '~/Downloads/Plan v2.docx', '~/Downloads/plan-v3.docx', '~/Downloads/Plan (2).docx', '~/Downloads/Plan_v4.docx'].map(M.fileKey)).size === 1);
  check('fileKey keeps the extension', M.fileKey('~/Downloads/Plan.docx') !== M.fileKey('~/Downloads/Plan.pdf'));
  check('kinds: Page, Doc, Sheet, Drive, Release, PR', ['https://claude.ai/code/artifact/08d6e409', 'https://docs.google.com/document/d/1/edit', 'https://docs.google.com/spreadsheets/d/1', 'https://drive.google.com/file/d/1', 'https://github.com/a/b/releases/tag/v1', 'https://github.com/a/b/pull/12'].map(M.linkKindOfUrl).join() === 'Page,Doc,Sheet,Drive,Release,PR');
  const m = new M.SessionBarModel();
  const page = 'https://claude.ai/code/artifact/08d6e409-4c7d';
  let n = m.applyFeed({ type: 'link', url: page, label: 'Patton Session Bar', at: T0 }, T0);
  check('a link: a note for the log', n.length === 1 && n[0].note === 'link' && n[0].kind === 'Page', n);
  m.applyFeed({ type: 'link', url: 'https://github.com/a/b/releases/tag/v1.34.1', label: 'Patton v1.34.1', at: T0 + MIN }, T0 + MIN);
  m.applyFeed({ type: 'link', url: page + '.', label: 'Patton Session Bar', at: T0 + 2 * MIN }, T0 + 2 * MIN);
  let v = m.view(T0 + 2 * MIN);
  check('the same URL twice: one row, moved to the top with the new time', v.links.length === 2 && v.links[0].url === page && v.links[0].at === T0 + 2 * MIN, v.links);
  m.applyFeed({ type: 'link', path: '~/Downloads/Plan.docx', label: 'Plan.docx', at: T0 + 3 * MIN }, T0 + 3 * MIN);
  m.applyFeed({ type: 'link', path: '~/Downloads/Plan v2.docx', label: 'Plan v2.docx', at: T0 + 4 * MIN }, T0 + 4 * MIN);
  v = m.view(T0 + 4 * MIN);
  const files = v.links.filter((l) => l.kind === 'File');
  check('Plan.docx then Plan v2.docx: one row, the newer', files.length === 1 && files[0].label === 'Plan v2.docx' && files[0].path === '~/Downloads/Plan v2.docx', files);
  m.applyFeed({ type: 'link', path: '~/Downloads/Plan.docx', label: 'Plan.docx', at: T0 + MIN }, T0 + 5 * MIN);
  check('an older version arriving late doesn\'t replace the newer', m.view(T0 + 5 * MIN).links.find((l) => l.kind === 'File').label === 'Plan v2.docx');
  check('a Page link without a label: "Page" and the id\'s first 8', (() => {
    const k = new M.SessionBarModel();
    k.applyFeed({ type: 'link', url: 'https://claude.ai/code/artifact/08d6e409-4c7d-4f4e', label: '', at: T0 }, T0);
    return k.view(T0).links[0].label === 'Page 08d6e409';
  })());
  check('a non-https URL is refused', (() => {
    const k = new M.SessionBarModel();
    k.applyFeed({ type: 'link', url: 'javascript:alert(1)', label: 'x', at: T0 }, T0);
    k.applyFeed({ type: 'link', url: 'http://example.com/a', label: 'x', at: T0 }, T0);
    k.applyFeed({ type: 'link', path: 'relative/thing.docx', label: 'x', at: T0 }, T0);
    return k.view(T0).links.length === 0;
  })());
  for (let i = 0; i < 12; i++) m.applyFeed({ type: 'link', url: `https://github.com/a/b/pull/${i}`, label: `PR ${i}`, at: T0 + 10 * MIN + i }, T0 + 20 * MIN);
  v = m.view(T0 + 20 * MIN);
  check('at most 8 links, newest first', v.links.length === 8 && v.links[0].label === 'PR 11' && v.links[7].label === 'PR 4', v.links.map((l) => l.label));
  m.applyFeed({ type: 'attached', sessionId: 's-1', how: 'sessions-file' }, T0);
  m.applyFeed({ type: 'attached', sessionId: 's-2', how: 'sessions-file' }, T0);
  check('a different session (/clear): links go', m.view(T0).links.length === 0);
}

// ── 6. Text is untrusted ──
{
  const m = new M.SessionBarModel();
  m.applyFeed({ type: 'task-start', id: 'e1', kind: 'agent', description: 'evil‮\u0007name\nsecond', at: T0 }, T0);
  const d = m.view(T0).running[0].description;
  // eslint-disable-next-line no-control-regex
  check('control and direction characters cleaned from descriptions', !/[\u0000-\u001f‮]/.test(d) && d.includes('evil') && d.includes('second'), d);
}

// ── 7. The stop-list adapter ──
{
  const base = { kind: 'stop', tasks: 1, crons: 1, context: null };
  let l = M.stopListsOf(base);
  check('adapter: no lists on an older hook → null, null, null', l.taskList === null && l.cronList === null && l.transcriptPath === null, l);
  check('adapter: carries the hook\'s task count', l.tasks === 1, l);
  l = M.stopListsOf({ ...base, taskList: [{ id: 't1', type: 'shell', d: 'x' }], cronList: [{ id: 'c', s: '* * * * *', r: true, p: 'p' }], transcriptPath: '/Users/m/.claude/projects/p/s.jsonl' });
  check('adapter: the parsed lists passed through', l.taskList.length === 1 && l.taskList[0].id === 't1' && l.cronList.length === 1 && l.transcriptPath.endsWith('s.jsonl'), l);
  check('adapter: an empty list stays a list (everything ended), not null', Array.isArray(M.stopListsOf({ ...base, tasks: 0, taskList: [] }).taskList));
  check('hook types map to kinds', ['shell', 'subagent', 'monitor', 'workflow', 'teammate', 'cloud session', 'MCP task'].map(M.kindOfHookType).join() === 'Shell,Agent,Monitor,Workflow,Teammate,Cloud,Task');
}

// ── 7b. A cut list (fewer entries than the hook's count) ends nothing ──
{
  const m = new M.SessionBarModel();
  m.applyFeed({ type: 'task-start', id: 's1', kind: 'shell', description: 'npm run check', at: T0 }, T0);
  m.applyFeed({ type: 'task-start', id: 's2', kind: 'shell', description: 'gh run watch', at: T0 }, T0);
  m.applyFeed({ type: 'task-start', id: 's3', kind: 'monitor', description: 'main.log', at: T0 }, T0);
  // The hook counted 4 but listed only s1 and a new s4: s2 and s3 were cut, not ended.
  m.applyStop({ tasks: 4, taskList: [{ id: 's1', type: 'shell', d: 'npm run check' }, { id: 's4', type: 'subagent', d: 'review' }], cronList: null, transcriptPath: null }, T0 + MIN);
  let v = m.view(T0 + MIN);
  check('cut list: ids missing from it are not ended', ['s2', 's3'].every((id) => v.running.some((r) => r.id === id && !r.ended)), v.running);
  check('cut list: a listed unknown id is still added', v.running.some((r) => r.id === 's4' && r.kind === 'Agent' && !r.ended), v.running);
  check('cut list: live count 4', v.liveCount === 4, v.liveCount);
  // The next Stop sends a complete list without s2: now s2 ends.
  m.applyStop({ tasks: 3, taskList: [{ id: 's1', type: 'shell', d: '' }, { id: 's3', type: 'monitor', d: '' }, { id: 's4', type: 'subagent', d: '' }], cronList: null, transcriptPath: null }, T0 + 2 * MIN);
  v = m.view(T0 + 2 * MIN);
  check('complete list: an id missing from it ends', v.running.some((r) => r.id === 's2' && r.ended), v.running);
  check('complete list: listed ids stay running', ['s1', 's3', 's4'].every((id) => v.running.some((r) => r.id === id && !r.ended)), v.running);
  // Complete and empty (tasks=0): everything not in 7501 ends.
  m.applyStop({ tasks: 0, taskList: [], cronList: null, transcriptPath: null }, T0 + 3 * MIN);
  check('complete empty list: every row ends', m.view(T0 + 3 * MIN).liveCount === 0, m.view(T0 + 3 * MIN).running);
}

// ── 8. reset ──
{
  const m = new M.SessionBarModel();
  m.applyFeed({ type: 'task-start', id: 'a', kind: 'agent', description: 'x', at: T0 }, T0);
  m.applyFeed({ type: 'task-end', id: 'b', status: 'failed', at: T0 }, T0);
  m.reset();
  const v = m.view(T0);
  check('reset (Claude left): every section empty', v.running.length === 0 && v.failures.length === 0 && v.links.length === 0 && v.scheduled.length === 0);
}

console.log(`\n${passed} ok, ${failed} not ok`);
process.exit(failed ? 1 : 0);
