// Headless check of the checkpoint clock's text (13 Nov 2026). Michael: "I think
// the relevant stat is what the total context percentage is that's been used."
// The visible text is the TOTAL share of the window; the amber reminder still
// counts growth since the last /checkpoint; the tooltip carries both numbers.
// Run: node scripts/check-checkpoint-clock.mjs
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'ckclock-')), 'clock.mjs');
const res = await build({
  entryPoints: [join(repo, 'src/renderer/services/checkpoint-clock.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false,
});
writeFileSync(out, res.outputFiles[0].text);
const { checkpointView } = await import(pathToFileURL(out).href);

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`ok ${name}`);
  else { failed++; console.log(`FAIL ${name} ${detail}`); }
}
const base = { claudeActive: true, claudeWorking: false, ready: true, ctxTokens: null, sinceTokens: null, checkpointAt: null };
const now = new Date(2026, 10, 13, 15, 0);
const at = Math.floor(new Date(2026, 10, 13, 10, 10).getTime() / 1000);

// 803,000 total, 65,000 since, threshold 20%
let v = checkpointView({ ...base, ctxTokens: 803_000, sinceTokens: 65_000, checkpointAt: at }, 20, now);
check('total shown as text', v.text === '✓ 80%', v.text);
check('no plus sign in text', !v.text.includes('+'), v.text);
check('growth below threshold is not due', v.due === false);
check('label starts with the text', v.label.startsWith('✓ 80% · '), v.label);
check('tooltip has total', v.label.includes('80% of the context window used'), v.label);
check('tooltip has growth and time', v.label.includes('+7% since this session\'s last checkpoint (10:10)'), v.label);
check('not due: no reminder part', !v.label.includes('time for one'), v.label);
check('click part kept', v.label.includes('Click to run /checkpoint'));
check('ready: not blocked', v.blocked === false);

// 300,000 total, 250,000 since: due on growth
v = checkpointView({ ...base, ctxTokens: 300_000, sinceTokens: 250_000, checkpointAt: at }, 20, now);
check('low total, big growth: text is total', v.text === '✓ 30%', v.text);
check('growth at/over threshold is due', v.due === true);
check('due tooltip says why', v.label.includes('+25% since the last checkpoint: time for one'), v.label);
{
  const n = checkpointView({ ...base, ctxTokens: 300_000, sinceTokens: 300_000, checkpointAt: null }, 20);
  check('due with no checkpoint: says so, no "since the last checkpoint"', n.due && n.label.includes('30% used with no checkpoint yet: time for one') && !n.label.includes('since the last checkpoint'), n.label);
}

// High total with no growth never amber
v = checkpointView({ ...base, ctxTokens: 950_000, sinceTokens: 0, checkpointAt: at }, 20, now);
check('high total, no growth: not due', v.text === '✓ 95%' && v.due === false, v.text);

// No reading yet
v = checkpointView({ ...base }, 20, now);
check('no reading: dash', v.text === '✓ —' && v.due === false, v.text);
check('no reading: tooltip', v.label.includes('No context reading yet'), v.label);

// No checkpoint yet
v = checkpointView({ ...base, ctxTokens: 120_000, sinceTokens: 120_000 }, 20, now);
check('no checkpoint: tooltip says so', v.label.includes('No checkpoint in this session yet'), v.label);
check('no checkpoint: tooltip has total', v.label.includes('12% of the context window used'), v.label);
check('no checkpoint: text is total', v.text === '✓ 12%', v.text);

// Blocked states, hidden
v = checkpointView({ ...base, ctxTokens: 100_000, sinceTokens: 10_000, ready: false, claudeWorking: true }, 20, now);
check('working: blocked with note', v.blocked === true && v.label.includes('available when Claude stops'), v.label);
check('no claude: hidden', checkpointView({ ...base, claudeActive: false }, 20, now) === null);
check('null source: hidden', checkpointView(null, 20, now) === null);

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('all passed');
