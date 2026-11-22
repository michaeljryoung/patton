// Headless check of the renderer's parse of the Stop hook's lists (session bar,
// docs/session-bar.md D10): `tl`, `cl` and `tp` on the OSC 777 `patton;stop`
// message, through services/patton-osc.ts and services/hook-lists.ts. Strict
// base64, UTF-8 and JSON; shape checks; control characters refuse the entry;
// caps; and nothing malformed ever throws or costs the stop verdict. The last
// cases run the real hook (resources/claude-code-stop-hook.sh) and parse what
// it prints, so the two ends stay in step.
// Run: node scripts/check-hook-lists.mjs
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'hooklists-')), 'patton-osc.mjs');
const res = await build({
  entryPoints: [join(repo, 'src/renderer/services/patton-osc.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false,
});
writeFileSync(out, res.outputFiles[0].text);
const { parsePattonOsc } = await import(pathToFileURL(out).href);

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`ok ${name}`);
  else { failed++; console.log(`FAIL ${name} ${detail}`); }
}
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8').toString('base64');
const stop = (tail = '') => parsePattonOsc(`patton;stop;tasks=2;crons=1${tail}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- A good message ---
const tl = [{ id: 'a1', type: 'subagent', d: 'fix the build' }, { id: 'b2', type: 'shell', d: 'npm test' }];
const cl = [{ id: 'c1', s: '*/5 * * * *', r: true, p: 'check CI' }];
let m = stop(`;ctx=5;since=3;tp=${b64('/Users/x/.claude/projects/p/s.jsonl')};tl=${b64(tl)};cl=${b64(cl)}`);
check('good message: verdict', m && m.kind === 'stop' && m.tasks === 2 && m.crons === 1);
check('good message: task list', same(m.taskList, tl), JSON.stringify(m.taskList));
check('good message: cron list', same(m.cronList, cl), JSON.stringify(m.cronList));
check('good message: transcript path', m.transcriptPath === '/Users/x/.claude/projects/p/s.jsonl');
check('good message: context reading still read', m.context && m.context.ctxTokens === 5 && m.context.sinceTokens === 3);
check('empty lists are [] (present), not absent', same(stop(`;tl=${b64('[]')};cl=${b64('[]')}`).taskList, []) && same(stop(`;cl=${b64('[]')}`).cronList, []));

// --- Old messages: no extra keys at all ---
m = stop('');
check('no list fields: no extra keys', same(Object.keys(m), ['kind', 'tasks', 'crons', 'context']), Object.keys(m).join());
check('no list fields on a ctx message', same(Object.keys(parsePattonOsc('patton;ctx;ctx=5;since=3')), ['kind', 'context']));

// --- Whole fields that are unreadable are dropped; the verdict survives ---
const bad = {
  'not base64 (bad alphabet)': 'W3t7!!',
  'unpadded base64': b64(tl).replace(/=+$/, '') + 'x',
  'base64 with a missing pad': b64('[]').replace(/=+$/, ''),
  'invalid UTF-8': Buffer.from([0x5b, 0xff, 0xfe, 0x5d]).toString('base64'),
  'not JSON': b64('not json'),
  'a JSON object, not an array': b64({ id: 'a' }),
  'a JSON string': b64('"x"'),
  'null': b64('null'),
  'empty value': '',
  'over 4096 encoded': b64('[' + '1,'.repeat(3000) + '1]'),
};
for (const [why, value] of Object.entries(bad)) {
  const x = stop(`;ctx=5;since=3;tl=${value};cl=${value}`);
  check(`unreadable field (${why}): dropped, verdict and context kept`,
    x && x.kind === 'stop' && x.tasks === 2 && x.taskList === undefined && x.cronList === undefined && x.context && x.context.ctxTokens === 5,
    JSON.stringify(x));
}

// --- One bad entry costs only itself ---
const mixed = [
  { id: 'ok1', type: 'shell', d: 'fine' },
  { id: '', type: 'shell', d: 'empty id' },
  { type: 'shell', d: 'no id' },
  { id: 5, type: 'shell', d: 'numeric id' },
  { id: 'notype', d: 'no type' },
  { id: 'nod', type: 'shell' },
  { id: 'ctl', type: 'shell', d: 'line\nbreak' },
  { id: 'ctl2', type: 'shell', d: 'bell\x07' },
  { id: 'c1', type: 'shell', d: 'c1 \u0085 next line' },
  { id: 'ctlid\n', type: 'shell', d: 'x' },
  { id: 'toolong', type: 'shell', d: 'x'.repeat(81) },
  { id: 'ok1', type: 'shell', d: 'duplicate id' },
  'a string', 7, null, [],
  { id: 'ok2', type: 'subagent', d: '' },
];
let list = stop(`;tl=${b64(mixed)}`).taskList;
check('mixed list: only the valid entries remain', same(list.map((t) => t.id), ['ok1', 'ok2']), JSON.stringify(list));
check('mixed list: the first of a duplicate id wins', list[0].d === 'fine');
check('a control character in a description refuses the entry (not just cleans it)', !list.some((t) => /line|bell|next/.test(t.d)));

const cronMix = [
  { id: 'c1', s: '* * * * *', r: true, p: 'ok' },
  { id: 'c2', s: '* * * * *', r: 'yes', p: 'r not boolean' },
  { id: 'c3', s: '', r: true, p: 'empty schedule' },
  { id: 'c4', s: '* * * * *', r: false, p: 'new\nline' },
  { id: 'c5', s: 's'.repeat(101), r: false, p: 'long schedule' },
  { id: 'c6', s: '0 9 * * 1', r: false, p: '' },
  { s: '* * * * *', r: true, p: 'no id' },
];
list = stop(`;cl=${b64(cronMix)}`).cronList;
check('cron list: only the valid entries remain', same(list.map((c) => c.id), ['c1', 'c6']), JSON.stringify(list));
check('cron list: r stays a boolean', list[0].r === true && list[1].r === false);

// --- Free text: invisible formatting and direction overrides go; white space collapses ---
list = stop(`;tl=${b64([{ id: 'v', type: 'shell', d: 'a‮b​c   d⁦e' }])}`).taskList;
check('direction overrides, zero-width and isolates stripped; spaces collapsed', list[0].d === 'abc de', JSON.stringify(list));
check('an id with an invisible character is refused', stop(`;tl=${b64([{ id: 'a​b', type: 'shell', d: 'x' }])}`).taskList.length === 0);
check('unicode text survives', stop(`;tl=${b64([{ id: 'u', type: 'shell', d: 'naïve résumé 😀 — ok' }])}`).taskList[0].d === 'naïve résumé 😀 — ok');
check('80 emoji (code points) are accepted, 81 refused',
  stop(`;tl=${b64([{ id: 'e', type: 's', d: '😀'.repeat(80) }])}`).taskList.length === 1 &&
  stop(`;tl=${b64([{ id: 'e', type: 's', d: '😀'.repeat(81) }])}`).taskList.length === 0);

// --- Caps ---
const many = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, type: 's', d: '' }));
list = stop(`;tl=${b64(many.slice(0, 80))}`).taskList;
check('at most 64 tasks are read', list.length === 64 && list[63].id === 't63', String(list.length));
const manyCrons = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, s: '* * * * *', r: true, p: '' }));
check('at most 32 crons are read', stop(`;cl=${b64(manyCrons)}`).cronList.length === 32);
check('an id of 128 characters is accepted, 129 refused',
  stop(`;tl=${b64([{ id: 'i'.repeat(128), type: 's', d: '' }])}`).taskList.length === 1 &&
  stop(`;tl=${b64([{ id: 'i'.repeat(129), type: 's', d: '' }])}`).taskList.length === 0);
check('a type of 33 characters is refused', stop(`;tl=${b64([{ id: 'a', type: 't'.repeat(33), d: '' }])}`).taskList.length === 0);

// --- Transcript path ---
const tp = (v) => stop(`;tp=${b64(v)}`).transcriptPath;
check('tp: absolute path accepted', tp('/a/b c/d.jsonl') === '/a/b c/d.jsonl');
check('tp: relative path refused', tp('a/b.jsonl') === undefined);
check('tp: control character refused', tp('/a/b\n.jsonl') === undefined && tp('/a\u0000b') === undefined);
check('tp: invisible character refused', tp('/a/‮b.jsonl') === undefined);
check('tp: over 1024 characters refused', tp('/' + 'a'.repeat(1024)) === undefined);
check('tp: 1024 characters accepted', tp('/' + 'a'.repeat(1023)).length === 1024);
check('tp: invalid base64 refused', stop(';tp=%%%').transcriptPath === undefined);
check('tp: empty refused', stop(';tp=').transcriptPath === undefined);

// --- First of a repeated key; unknown fields; never throws ---
check('a repeated tl: the first counts', stop(`;tl=${b64([{ id: 'one', type: 's', d: '' }])};tl=${b64([{ id: 'two', type: 's', d: '' }])}`).taskList[0].id === 'one');
check('a repeated tl: a bad first does not block a good second', stop(`;tl=!!;tl=${b64([{ id: 'two', type: 's', d: '' }])}`).taskList[0].id === 'two');
check('unknown fields around the lists are ignored', stop(`;zz=1;tl=${b64(tl)};future=abc;cl=${b64(cl)}`).cronList.length === 1);
let threw = null;
const junk = ['', ';', ';tl', ';tl=', ';tl==', ';tl=====', `;tl=${'A'.repeat(5000)}`, `;cl=${'/'.repeat(4000)}`, ';tp=////', ';tl=W10', ';tl=W10==', ';tp=' + 'A'.repeat(3000),
  ';tl=' + b64('[{"id":"a","type":"s","d":{"x":1}}]'), ';tl=' + b64('[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]'), ';cl=' + b64('[{"id":"a","s":"x","r":true,"p":123}]'),
  ';tl=' + b64('[{"id":"a","type":"s","d":"\ud800"}]')];
for (const j of junk) { try { stop(j); } catch (e) { threw = `${j.slice(0, 30)}: ${e}`; } }
check('garbage in the list fields never throws', threw === null, threw ?? '');

// --- The real hook, end to end ---
const hook = join(repo, 'resources/claude-code-stop-hook.sh');
function runHook(input, parser) {
  const env = { ...process.env };
  if (parser) env.PATTON_HOOK_PARSER = parser; else delete env.PATTON_HOOK_PARSER;
  const o = execFileSync(hook, { input: JSON.stringify(input), env, encoding: 'utf8' });
  return o ? JSON.parse(o).terminalSequence : '';
}
const toParse = (seq) => parsePattonOsc(seq.slice('\u001b]777;'.length, -1));
for (const parser of ['', 'osascript']) {
  const tag = parser || 'jq';
  const input = {
    session_id: 's', transcript_path: '/Users/x/.claude/projects/p/s.jsonl', hook_event_name: 'Stop',
    background_tasks: [
      { id: 'a1', type: 'subagent', status: 'running', description: 'say "hi" naïve 😀\nsecond line' },
      { id: 'm1', type: 'memory import', status: 'running', description: 'ambient' },
    ],
    session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check CI' }],
  };
  const seq = runHook(input, parser);
  const r = seq ? toParse(seq) : null;
  check(`hook -> parser (${tag}): verdict`, r && r.kind === 'stop' && r.tasks === 1 && r.crons === 1, seq.slice(0, 80));
  check(`hook -> parser (${tag}): task list, newline cleaned`, r && same(r.taskList, [{ id: 'a1', type: 'subagent', d: 'say "hi" naïve 😀 second line' }]), JSON.stringify(r && r.taskList));
  check(`hook -> parser (${tag}): cron list`, r && same(r.cronList, [{ id: 'c1', s: '*/5 * * * *', r: true, p: 'check CI' }]));
  check(`hook -> parser (${tag}): transcript path`, r && r.transcriptPath === '/Users/x/.claude/projects/p/s.jsonl');
  const big = { ...input, background_tasks: Array.from({ length: 40 }, (_, i) => ({ id: `task-${i}`, type: 'subagent', status: 'running', description: 'naïve résumé 😀 ' + 'long description '.repeat(8) })), session_crons: [] };
  const seq40 = runHook(big, parser);
  const r40 = seq40 ? toParse(seq40) : null;
  check(`hook -> parser (${tag}): 40 tasks fit under 3500 bytes`, Buffer.byteLength(seq40) <= 3500 && Buffer.byteLength(seq40) > 0, String(Buffer.byteLength(seq40)));
  check(`hook -> parser (${tag}): 40 tasks keep all 40 ids, tasks=40`, r40 && r40.tasks === 40 && r40.taskList.length === 40 && r40.taskList[39].id === 'task-39');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall hook-list checks passed');
process.exit(failed ? 1 : 0);
