// Headless check of the arithmetic behind docs/compose-box.md D15 and D16, no
// DOM: how many whole rows the terminal gives up so a long draft grows down
// (services/compose-room.ts), the bottom padding that gives exactly that many
// up whatever the rounding (services/terminal-fit.ts roomPadding), and the
// range Ctrl-U deletes (services/kill-line.ts). The real layout is
// check-compose-over.cjs's job; the box's keys are check-compose-box.mjs's.
// Run: node scripts/check-compose-room.mjs
//   COMPOSE_SRC_ROOT=<folder holding src/>  bundle another source tree (to prove the check bites)
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.COMPOSE_SRC_ROOT ? resolve(process.env.COMPOSE_SRC_ROOT) : here;

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

let M;
try {
  const out = await build({
    stdin: {
      contents: `
        export { composeRoomRows } from './src/renderer/services/compose-room';
        export { fitGrid, roomPadding } from './src/renderer/services/terminal-fit';
        export { killLineRange } from './src/renderer/services/kill-line';
      `,
      resolveDir: repo, loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
  });
  M = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
} catch (err) {
  console.log('FAIL the D15/D16 modules build', String(err?.message ?? err).split('\n')[0]);
  process.exit(1);
}

// ── D15: k ──
// The recorded screens' geometry at UI scale 1: 16 px rows, a 504 px pane
// (a third is 168 px), a one-line box of 36 px, a seven-line one of 141 px.
const base = { placement: 'over', oneLine: false, neededPx: 141, cellH: 16, paneH: 504, rowsBelowBar: 1 };
const k = (over) => M.composeRoomRows({ ...base, ...over });
check('over, 7-line draft (141 px = 9 rows), one footer row below the bar: k = 9 - 3 - 1 = 5', k({}) === 5, k({}));
check('...with 18 blank rows below the bar instead: it grows over them, k = 0', k({ rowsBelowBar: 18 }) === 0, k({ rowsBelowBar: 18 }));
check('...with exactly enough rows below (6): k = 0', k({ rowsBelowBar: 6 }) === 0, k({ rowsBelowBar: 6 }));
check('...with one row short (5): k = 1', k({ rowsBelowBar: 5 }) === 1, k({ rowsBelowBar: 5 }));
check('dock: the rows below the bar don\'t count, k = 9 - 3 = 6', k({ placement: 'dock', rowsBelowBar: 18 }) === 6,
  k({ placement: 'dock', rowsBelowBar: 18 }));
check('under: k = 0, however long the draft', k({ placement: 'under', rowsBelowBar: 0, neededPx: 400 }) === 0);
check('a one-line draft: k = 0, even taller than three rows in dock',
  k({ oneLine: true, placement: 'dock', neededPx: 60 }) === 0, k({ oneLine: true, placement: 'dock', neededPx: 60 }));
check('a draft that fits three rows (36 px): k = 0 in dock', k({ placement: 'dock', neededPx: 36 }) === 0);
check('within 1 px of three rows (49 px of 48): no extra row', k({ placement: 'dock', neededPx: 49 }) === 0, k({ placement: 'dock', neededPx: 49 }));
check('past it (50 px): one row', k({ placement: 'dock', neededPx: 50 }) === 1, k({ placement: 'dock', neededPx: 50 }));
check('capped at a third of the pane: a 30-line draft (539 px) needs 168 px = 11 rows, k = 11 - 3 - 1 = 7',
  k({ neededPx: 539 }) === 7, k({ neededPx: 539 }));
check('...and the cap holds in dock (k = 8)', k({ placement: 'dock', neededPx: 5000 }) === 8, k({ placement: 'dock', neededPx: 5000 }));
check('no cell height (a hidden pane): k = 0', k({ cellH: 0 }) === 0);
check('a negative count of rows below (a stale bar row) counts as none', k({ rowsBelowBar: -3 }) === 6, k({ rowsBelowBar: -3 }));
// No feedback: after k rows go, Claude redraws its bar k rows higher with the
// same footer below it, so the same facts give the same k.
check('the same facts after the resize (the footer still one row below the bar) give the same k', k({}) === k({ rowsBelowBar: 1 }));

// ── D15: the padding that gives up exactly k rows ──
const fit = (over) => ({
  height: 504, width: 900, padTop: 4, padBottom: 10, padLeft: 4, padRight: 4, borderBox: true,
  innerPadV: 0, innerPadH: 0, scrollbarWidth: 14, cellWidth: 8.4, cellHeight: 16, ...over,
});
let bad = [];
let tried = 0;
for (const cellHeight of [14, 15, 16, 16.5, 17, 17.25, 18.2, 19.5, 21.333333, 24]) {
  for (let height = 120; height <= 1400; height += 7.3) {
    const f = fit({ height, cellHeight });
    const rows0 = M.fitGrid(f).rows;
    for (const given of [1, 2, 3, 5, 9]) {
      if (rows0 - given < 1) continue;
      tried++;
      const pad = M.roomPadding(f, given);
      // Chromium lays padding out in 1/64 px: either rounding must hold.
      for (const p of [pad, Math.floor(pad * 64) / 64, Math.ceil(pad * 64) / 64]) {
        const rows = M.fitGrid({ ...f, padBottom: f.padBottom + p }).rows;
        if (rows !== rows0 - given && bad.length < 5) bad.push({ cellHeight, height, given, rows0, rows, pad: p });
      }
    }
  }
}
check(`roomPadding gives up exactly k rows over ${tried} sizes, cell heights and counts, at either 1/64 px rounding`, bad.length === 0, bad);
check('roomPadding of 0 rows is 0 px', M.roomPadding(fit({}), 0) === 0);
check('roomPadding with no cell size is 0 px', M.roomPadding(fit({ cellHeight: 0 }), 3) === 0);

// ── D16: what Ctrl-U deletes ──
const kill = (v, a, b = a) => M.killLineRange(v, a, b);
const after = (v, r) => (r ? v.slice(0, r.start) + v.slice(r.end) : v);
const cases = [
  ['one line, caret mid-line', 'fix the build', 4, 4, '', 0, 1],
  ['one line, caret at the end', 'fix the build', 13, 13, '', 0, 1],
  ['first of three', 'one\ntwo\nthree', 1, 1, 'two\nthree', 0, 1],
  ['middle of three: the caret starts the line that takes its place', 'one\ntwo\nthree', 5, 5, 'one\nthree', 4, 1],
  ['middle of three, caret at the line\'s start', 'one\ntwo\nthree', 4, 4, 'one\nthree', 4, 1],
  ['last of three: with the break before it, the caret ends the line above', 'one\ntwo\nthree', 13, 13, 'one\ntwo', 7, 1],
  ['an empty middle line', 'one\n\nthree', 4, 4, 'one\nthree', 4, 1],
  ['a trailing empty line', 'one\n', 4, 4, 'one', 3, 1],
  ['a selection across three lines', 'one\ntwo\nthree\nfour', 1, 10, 'four', 0, 3],
  ['a backward selection (end before start)', 'one\ntwo\nthree\nfour', 10, 1, 'four', 0, 3],
  ['a selection ending just after a line break leaves the next line', 'one\ntwo\nthree', 0, 4, 'two\nthree', 0, 1],
  ['a selection of the whole draft', 'one\ntwo', 0, 7, '', 0, 2],
];
for (const [name, v, a, b, want, caretAt, lines] of cases) {
  const r = kill(v, a, b);
  check(`Ctrl-U range: ${name}`, r && after(v, r) === want && r.start === caretAt && r.lines === lines, { r, left: after(v, r), want });
}
check('Ctrl-U range: an empty box gives nothing to delete', kill('', 0) === null, kill('', 0));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
