// Plain-node check of shortTabName (src/renderer/services/tab-name.ts): the
// 15-character cap on a tab's automatic name (12 Nov, Michael: "it should
// always default to 10 to 15 characters max").
// Run: node scripts/check-tab-name.mjs
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  entryPoints: [join(repo, 'src/renderer/services/tab-name.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
const { shortTabName, TAB_NAME_MAX } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const len = (s) => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)).length;
const is = (input, want) => check(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, shortTabName(input) === want, shortTabName(input));

check('the cap is 15', TAB_NAME_MAX === 15);
// Michael's screenshot
is('Repeated permission prompts', 'Repeated permi…');
is('Calendly personal Gmail account', 'Calendly perso…');
// whole titles that fit are untouched
is('patton', 'patton');
is('exactly 15 char', 'exactly 15 char');
is('sixteen chars ok', 'sixteen chars…');
is('', '');
is('   ', '');
is('  padded  ', 'padded');
// whole words, when they leave at least 10 characters
is('Fixing the flaky tests now', 'Fixing the…');   // "Fixing the" = 10 chars, then +" flaky" > 14
is('Refactor tab strip layout', 'Refactor tab…');   // "Refactor tab" = 12
is('Debug login flow today', 'Debug login…');       // 'Debug login' = 11
is('Fix the bug in parser now', 'Fix the bug in…'); // 'Fix the bug in' = 14 + … = 15
// fewer than 10 from whole words: cut at 14
is('Fix everythingelse is more', 'Fix everything…');
is('Go refactoringeverything', 'Go refactoring…');
// a single long word
is('supercalifragilisticexpialidocious', 'supercalifragi…');
// trailing punctuation and spaces are trimmed before the ellipsis
is('Fix the bug. Then the other one', 'Fix the bug…');
is('Update README, then deploy it', 'Update README…');
is('abcdefghijklm nopqrstuvwxyz', 'abcdefghijklm…');
is('abcdefghijkl, mnopqr', 'abcdefghijkl…');
// internal runs of whitespace collapse
is('Fixing    the     flaky tests now', 'Fixing the…');
// code points: a surrogate pair is never cut in half
const emoji = '😀'.repeat(20);
is(emoji, '😀'.repeat(14) + '…');
is('Fix ' + '🚀'.repeat(12), 'Fix ' + '🚀'.repeat(10) + '…');
is('日本語のタイトルがとても長いときの表示です', '日本語のタイトルがとても長い…');
const family = '👨‍👩‍👧‍👦';
is(family.repeat(20), family.repeat(14) + '…');
// every result is at most 15 characters, and never ends in a lone surrogate
const samples = ['x'.repeat(100), emoji, '🚀 '.repeat(30), 'A B C D E F G H I J K L M N O P', 'ab cd ef gh ij kl mn op qr', '日本語 日本語 日本語 日本語 日本語', 'a, b, c, d, e, f, g, h, i, j, k'];
const bad = samples.filter((t) => { const r = shortTabName(t); return len(r) > 15 || /[\uD800-\uDBFF]$/u.test(r.replace(/…$/u, '')) || /^[\uDC00-\uDFFF]/u.test(r); });
check('every sample is at most 15 characters and no surrogate is split', bad.length === 0, bad);
check('a result never ends with a space before the ellipsis', samples.every((t) => !/\s…$/u.test(shortTabName(t))));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
