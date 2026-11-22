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
import { dirname, join, resolve } from 'node:path';
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

// COMPOSE_SRC_ROOT=<folder holding src/> reads another tree's reader (to prove a check bites on a base).
const srcRoot = process.env.COMPOSE_SRC_ROOT ? resolve(process.env.COMPOSE_SRC_ROOT) : repo;
const bundle = await build({
  stdin: {
    contents: process.env.CLAUDE_BAR_STUB
      ? `export const readClaudeBar = (b) => ({ found: false, why: 'no-glyph', row: b.baseY + b.cursorY });
         export const claudeBarVerdict = (r) => (!r.found ? 'none' : r.empty ? 'empty' : 'holds-text');`
      : `export { readClaudeBar, claudeBarVerdict } from ${JSON.stringify(join(srcRoot, 'src/renderer/services/claude-bar'))};`,
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
// D14: Claude Code's pasted-image placeholders ([Image #N], text colour) are images, not text.
await syn('one image placeholder, caret after it', ['', RULE, `❯ [Image #2] ${INV} ${OFF}`, RULE], 3, 15, 'empty');
await syn('two image placeholders', ['', RULE, `❯ [Image #1] [Image #2] ${INV} ${OFF}`, RULE], 3, 26, 'empty');
await syn('an image placeholder then typed text', ['', RULE, `❯ [Image #2] hello${INV} ${OFF}`, RULE], 3, 20, 'holds-text');
await syn('typed text then an image placeholder', ['', RULE, `❯ see [Image #3]${INV} ${OFF}`, RULE], 3, 19, 'holds-text');
await syn('an image placeholder, then the dim hint on the caret',
  ['', RULE, `❯ [Image #1] ${INV}P${OFF}${DIM}ress up to edit queued messages${OFF}`, RULE], 3, 15, 'empty');
await syn('a wide character before an image placeholder', ['', RULE, `❯ 漢 [Image #1]${INV} ${OFF}`, RULE], 3, 18, 'holds-text');
await syn('a pasted-text placeholder stays text', ['', RULE, `❯ [Pasted text #1 +12 lines]${INV} ${OFF}`, RULE], 3, 31, 'holds-text');
await syn('a malformed image placeholder is text', ['', RULE, `❯ [Image #]${INV} ${OFF}`, RULE], 3, 13, 'holds-text');
// Cost: a reading reuses one cell (xterm's getCell(x, cell)) instead of
// allocating one per column; the verdicts are the same through the wrapper.
for (const [label, line, col, want] of [
  ['an image placeholder and the caret', `❯ [Image #2] ${INV} ${OFF}`, 15, 'empty'],
  ['typed text', `❯ hello${INV} ${OFF}`, 8, 'holds-text'],
]) {
  const term = await screen(['', RULE, line, RULE], 3, col);
  const real = term.buffer.active;
  const cells = new Set();
  let calls = 0, withoutCell = 0;
  const spy = {
    cursorY: real.cursorY, baseY: real.baseY,
    getNullCell: () => real.getNullCell(),
    getLine: (y) => {
      const l = real.getLine(y);
      if (!l) return l;
      return {
        length: l.length,
        translateToString: (t) => l.translateToString(t),
        getCell: (x, cell) => { calls++; if (cell === undefined) withoutCell++; else cells.add(cell); return l.getCell(x, cell); },
      };
    },
  };
  const r = readClaudeBar(spy);
  check(`reused cell, ${label}: ${want} as before`, claudeBarVerdict(r) === want, { got: claudeBarVerdict(r) });
  check(`reused cell, ${label}: every getCell call passes a cell, and it is one cell`,
    calls > 10 && withoutCell === 0 && cells.size === 1, { calls, withoutCell, distinct: cells.size });
  term.dispose();
}
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

// ── D18: the bar's input over several rows, and the Esc-restore plan ──
{
  let er = null;
  try {
    const b = await build({
      stdin: { contents: `export * from ${JSON.stringify(join(srcRoot, 'src/renderer/services/esc-restore'))};`, resolveDir: repo, loader: 'ts' },
      bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
    });
    er = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
  } catch (err) {
    check('D18 services/esc-restore builds', false, String(err?.message ?? err).slice(0, 200));
  }
  if (er) {
    const { readClaudeBarInput, planEscRestore, CLAUDE_CLEAR_INPUT, CLAUDE_BACKSPACE } = er;
    const term = new Terminal({ cols, rows, allowProposedApi: true });
    const rule = '─'.repeat(cols);
    // A two-row bar, cursor on its last row, a footer below.
    await write(term, `\x1b[2J\x1b[H${rule}\r\n❯ first row\r\n  second row\r\n${rule}\r\n  footer\x1b[3;14H`);
    let r = readClaudeBarInput(term.buffer.active);
    check('D18 two-row bar read whole', r.kind === 'text' && r.rows.join('|') === 'first row|second row' && r.images === 0 && !r.pasted, r);
    await write(term, '\x1b[5;3H'); // cursor on the footer (mid-redraw)
    r = readClaudeBarInput(term.buffer.active);
    check('D18 cursor on the footer: none', r.kind === 'none', r);
    await write(term, `\x1b[2J\x1b[H${rule}\r\n❯ [Image #1] look\r\n${rule}\x1b[2;18H`);
    r = readClaudeBarInput(term.buffer.active);
    check('D18 an image placeholder counted', r.kind === 'text' && r.images === 1, r);
    await write(term, `\x1b[2J\x1b[H${rule}\r\n❯ \r\n${rule}\x1b[2;3H`);
    check('D18 an empty bar: empty', readClaudeBarInput(term.buffer.active).kind === 'empty');
    term.dispose();

    const one = (rowsIn, extra = {}) => ({ rows: rowsIn, images: 0, pasted: false, ...extra });
    let p = planEscRestore('hello there', one(['hello there']));
    check('D18 plan: the sent line back -> sent, Ctrl+C', p.source === 'sent' && p.text === 'hello there' && p.keys === CLAUDE_CLEAR_INPUT && !p.keepImages, p);
    p = planEscRestore('a long line that Claude wrapped', one(['a long line that Cla', 'ude wrapped']));
    check('D18 plan: a wrapped row matches without its break', p.source === 'sent', p);
    p = planEscRestore('héllo 👍🏽\nx', one(['[Image #1] héllo 👍🏽', 'x'], { images: 1 }));
    check('D18 plan: with images, Backspace per character of the text (graphemes, the break included), images kept',
      p.source === 'sent' && p.keepImages && p.keys === CLAUDE_BACKSPACE.repeat(9), { keys: p.keys?.length });
    // Integration probe (S61, Claude Code 2.1.321 through a pty): Claude puts the message back trimmed at both ends
    // ("  hello there  " -> "hello there", "line one\nline two\n" -> two rows), so the Backspaces count the trimmed
    // text: one more per leading blank would delete into the [Image #1] before it.
    p = planEscRestore('  look at this \n', one(['[Image #1] look at this'], { images: 1 }));
    check('D18 plan: with images and blanks at the ends, Backspace per character of the trimmed text (images kept), the box gets his copy as sent',
      p.source === 'sent' && p.keepImages && p.keys === CLAUDE_BACKSPACE.repeat(12) && p.text === '  look at this \n', { keys: p.keys?.length, text: p.text });
    const forty = Array.from({ length: 41 }, (_, i) => `line ${i + 1}`).join('\n'); // 40 line breaks
    p = planEscRestore(`intro ${forty}`, one(['intro [Pasted text #1 +40 lines]'], { pasted: true }));
    check('D18 plan: a [Pasted text] placeholder after the start of what was sent, its +40 lines the hidden part\'s 40 breaks -> sent',
      p.source === 'sent' && p.keys === CLAUDE_CLEAR_INPUT, p);
    const ten = Array.from({ length: 10 }, (_, i) => `row ${i}`).join('\n'); // 9 breaks, 11 with its edges
    p = planEscRestore(`see:\n${ten}\nthanks`, one(['see:', '[Pasted text #1 +9 lines]', 'thanks'], { pasted: true }));
    check('D18 plan: text before and after the placeholder, the start and end of what was sent -> sent', p.source === 'sent', p);
    p = planEscRestore(`see:\n${ten}\nthanks`, one(['see:', '[Pasted text #1 +11 lines]', 'thanks'], { pasted: true }));
    check('D18 plan: ...the edges\' breaks counted too (+11) -> sent', p.source === 'sent', p);
    // Review finding 1: a paste he made in Claude's own bar, his send typed after it.
    p = planEscRestore('hello', one(['[Pasted text #1 +39 lines] tail'], { pasted: true }));
    check('D18 plan: a bar starting with his own paste, then other text -> not-readable, no Ctrl+C', p.skip === 'not-readable', p);
    p = planEscRestore('hello', one(['[Pasted text #1 +39 lines] hello'], { pasted: true }));
    check('D18 plan: his own paste, then exactly what was sent -> not-readable (nothing of the send behind the placeholder)', p.skip === 'not-readable', p);
    p = planEscRestore('hello', one(['[Pasted text #1]hello'], { pasted: true }));
    check('D18 plan: his own one-line paste, then what was sent -> not-readable', p.skip === 'not-readable', p);
    p = planEscRestore('intro then a long paste', one(['intro [Pasted text #1 +40 lines]'], { pasted: true }));
    check('D18 plan: the start matches but +40 lines is not the rest\'s 0 breaks -> not-readable', p.skip === 'not-readable', p);
    p = planEscRestore(`a ${forty} b ${forty}`, one(['a [Pasted text #1 +40 lines] b [Pasted text #2 +40 lines]'], { pasted: true }));
    check('D18 plan: two placeholders -> not-readable', p.skip === 'not-readable', p);
    p = planEscRestore(`x ${forty}`, one(['x [Pasted text #1 something else]'], { pasted: true }));
    check('D18 plan: a placeholder not in Claude\'s form -> not-readable', p.skip === 'not-readable', p);
    p = planEscRestore(`x ${forty}`, one(['[Image #1] x [Pasted text #1 +40 lines]'], { images: 1, pasted: true }));
    check('D18 plan: images and a pasted placeholder -> skip', p.skip === 'images-and-paste', p);
    p = planEscRestore('sent', one(['typed in the bar sent']));
    check('D18 plan: one foreign row -> screen, Ctrl+C', p.source === 'screen' && p.text === 'typed in the bar sent' && p.keys === CLAUDE_CLEAR_INPUT, p);
    p = planEscRestore('sent', one(['typed', 'sent']));
    check('D18 plan: foreign rows -> not-readable', p.skip === 'not-readable', p);
    p = planEscRestore('sent', one(['[Image #1] typed sent'], { images: 1 }));
    check('D18 plan: a foreign row with an image -> not-readable (Ctrl+C would drop the image)', p.skip === 'not-readable', p);
    p = planEscRestore('sent', one(['typed [Pasted text #2 +9 lines]'], { pasted: true }));
    check('D18 plan: a foreign row with a pasted placeholder -> not-readable', p.skip === 'not-readable', p);

    const { isEscKey, isTypedInput } = er;
    check('D18 Esc keys: plain and CSI u', isEscKey('\x1b') && isEscKey('\x1b[27u') && !isEscKey('\x1b[A') && !isEscKey('x'));
    const typed = ['a', 'hello', '\r', '\x7f', '\x03', '\x15', '\x1bb', '\x1b[A', '\x1bOB', '\x1b[1;5D', '\x1b[3~', '\x1b[13;2u', '\x1b[200~pasted\x1b[201~'];
    const notTyped = ['\x1b', '\x1b[27u', '\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[<0;10;5M', '\x1b[<0;10;5m', ''];
    check('D18 typed input: text, Enter, Backspace, control, Alt, arrows, editing keys, a paste',
      typed.every(isTypedInput), typed.filter((d) => !isTypedInput(d)).map((d) => JSON.stringify(d)));
    check('D18 not typed: Esc, focus and mouse reports, xterm\'s replies to queries',
      !notTyped.some(isTypedInput), notTyped.filter(isTypedInput).map((d) => JSON.stringify(d)));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
