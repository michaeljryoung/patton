// Check of the Claude bar reader (services/claude-bar.ts, docs/compose-box.md
// D8 and D13): real Claude Code v2.1.321 pty recordings
// (scripts/fixtures/claude-bar-screens.json, 100x30) are fed chunk by chunk
// through the real @xterm/xterm Terminal under jsdom, and the reader's verdict
// is asserted at every step mark against the fixture's `expected`; over the
// `turn` recording at least 22 of the 26 chunks after `turn-sent` must find the
// bar; then synthetic edge lines (dim hint, caret on a typed letter, a rule
// carrying a label, a lone `❯`, wrapped input).
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-claude-bar.mjs
// CLAUDE_BAR_STUB=1 swaps the reader for one that never finds the bar (to show
// the check fails without it).
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.self = dom.window;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
// xterm's canvas probe warns "getContext not implemented" under jsdom: harmless.
const origError = console.error;
console.error = (...a) => { if (!String(a[0]).includes('getContext')) origError(...a); };
const { Terminal } = createRequire(join(repo, 'noop.js'))('@xterm/xterm');

const bundle = await build({
  stdin: {
    contents: process.env.CLAUDE_BAR_STUB
      ? `export const readClaudeBar = (b) => ({ found: false, why: 'no-glyph', row: b.baseY + b.cursorY });
         export const claudeBarVerdict = (r) => (!r.found ? 'none' : r.empty ? 'empty' : 'holds-text');`
      : `export { readClaudeBar, claudeBarVerdict } from './src/renderer/services/claude-bar';`,
    resolveDir: repo, loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
});
const { readClaudeBar, claudeBarVerdict } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

const fixture = JSON.parse(readFileSync(join(repo, 'scripts/fixtures/claude-bar-screens.json'), 'utf8'));
const { cols, rows } = fixture;

const newTerm = () => new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
const write = (term, data) => new Promise((res) => term.write(data, res));
const read = (term) => readClaudeBar(term.buffer.active);
const rowText = (term, abs) => (term.buffer.active.getLine(abs)?.translateToString(true) ?? '').slice(0, 60);

// --- The recordings, mark by mark ---
for (const [name, events] of Object.entries(fixture.recordings)) {
  const term = newTerm();
  const expected = fixture.expected[name] ?? {};
  let afterTurnSent = null; // counts for the `turn` recording
  let foundAfter = 0;
  for (const e of events) {
    if (e.mark) {
      if (e.mark === 'turn-sent') afterTurnSent = 0;
      const want = expected[e.mark];
      if (want === undefined) continue;
      const r = read(term);
      const got = claudeBarVerdict(r);
      check(`${name}/${e.mark}: ${want}`, got === want, { got, why: r.why, row: rowText(term, r.row) });
      if (r.found) {
        const b = term.buffer.active;
        check(`${name}/${e.mark}: row is the cursor's absolute row`, r.row === b.baseY + b.cursorY, r.row);
      }
      continue;
    }
    await write(term, Buffer.from(e.b, 'base64'));
    if (afterTurnSent !== null) {
      afterTurnSent++;
      if (read(term).found) foundAfter++;
    }
  }
  if (name === 'turn') {
    check(`turn: 26 chunks after turn-sent`, afterTurnSent === 26, afterTurnSent);
    check(`turn: bar found after at least 22 of 26 chunks (found ${foundAfter})`, foundAfter >= 22, foundAfter);
  }
  term.dispose();
}

// --- Synthetic edge lines ---
const RULE = '─'.repeat(cols);
const CSI = '\x1b[';
const at = (row, col) => `${CSI}${row};${col}H`; // 1-based
async function screen(lines, cursorRow, cursorCol) {
  const term = newTerm();
  await write(term, `${CSI}2J${CSI}H` + lines.map((l, i) => at(i + 1, 1) + l).join('') + at(cursorRow, cursorCol));
  return term;
}
const syn = async (label, lines, cRow, cCol, want, wantWhy) => {
  const term = await screen(lines, cRow, cCol);
  const r = read(term);
  check(`synthetic ${label}: ${want}${wantWhy ? ' (' + wantWhy + ')' : ''}`,
    claudeBarVerdict(r) === want && (!wantWhy || r.why === wantWhy), { got: claudeBarVerdict(r), why: r.why });
  term.dispose();
};
const DIM = `${CSI}2m`, INV = `${CSI}7m`, OFF = `${CSI}0m`, GREY = `${CSI}38;2;153;153;153m`;

await syn('empty bar, caret on a blank cell', ['', RULE, `❯ ${INV} ${OFF}`, RULE], 3, 3, 'empty');
await syn('empty bar, no caret drawn', ['', RULE, '❯ ', RULE], 3, 3, 'empty');
await syn('dim hint, inverse caret on its first letter',
  ['', RULE, `${GREY}❯${OFF} ${INV}P${OFF}${DIM}ress up to edit queued messages${OFF}`, RULE], 3, 3, 'empty');
await syn('dim hint with no caret', ['', RULE, `❯ ${DIM}Try "fix lint errors"${OFF}`, RULE], 3, 3, 'empty');
await syn('caret on a typed letter, typed text after', ['', RULE, `❯ ${INV}h${OFF}ello`, RULE], 3, 3, 'holds-text');
await syn('caret alone on a single typed letter', ['', RULE, `❯ ${INV}h${OFF}`, RULE], 3, 3, 'holds-text');
await syn('typed text then caret', ['', RULE, `❯ hello${INV} ${OFF}`, RULE], 3, 8, 'holds-text');
await syn('a slash', ['', RULE, `❯ /${INV} ${OFF}`, RULE], 3, 4, 'holds-text');
await syn('dim hint after typed text', ['', RULE, `❯ hi ${DIM}hint${OFF}`, RULE], 3, 3, 'holds-text');
await syn('a rule carrying a label above', ['', `${'─'.repeat(40)} History 3/3 ${'─'.repeat(47)}`, '❯ ', RULE],
  3, 3, 'none', 'no-rule-above');
await syn('a rule carrying a label below', ['', RULE, '❯ ', `${'─'.repeat(10)} label`], 3, 3, 'none', 'no-rule-below');
await syn('a lone ❯ with no rules', ['', 'some output', '❯ ', 'more output'], 3, 3, 'none', 'no-rule-above');
await syn('a lone ❯ on the first row', ['❯ ', RULE], 1, 3, 'none', 'no-rule-above');
await syn('question dialog row ❯ 1.', ['Which one?', '', '❯ 1. Yes', '  2. No'], 3, 3, 'none', 'no-rule-above');
await syn('cursor off the glyph line', ['', RULE, '❯ ', RULE, 'footer'], 5, 1, 'none', 'no-glyph');
// Wrapped input: the input runs past the right edge, so the cursor's row is
// the continuation and does not start with `❯`.
{
  const term = newTerm();
  await write(term, `${CSI}2J${CSI}H\r\n${RULE}\r\n❯ ${'word '.repeat(25)}tail\r\n${RULE}`);
  await write(term, at(4, 30));
  const r = read(term);
  check('synthetic wrapped input: none (no-glyph)', claudeBarVerdict(r) === 'none' && r.why === 'no-glyph',
    { got: claudeBarVerdict(r), why: r.why, row: rowText(term, r.row) });
  term.dispose();
}
// A bar scrolled into the scrollback: the row is absolute (baseY + cursorY).
{
  const term = newTerm();
  await write(term, Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\r\n') + `\r\n${RULE}\r\n❯ `);
  await write(term, `\r\n${RULE}${CSI}A\r${CSI}2C`);
  const b = term.buffer.active;
  const r = read(term);
  check('synthetic bar after scrollback: found, row absolute',
    r.found && r.empty && r.row === b.baseY + b.cursorY && b.baseY > 0, { r, baseY: b.baseY, cursorY: b.cursorY });
  term.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
