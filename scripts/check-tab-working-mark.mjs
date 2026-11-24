// Check of the working mark on the tab strip (S63, 24 Nov 2026). Michael picked
// "W1 · Still dot" on the try-out page (docs/mocks/tryout-s63-tabs.html): a
// Claude tab whose session is mid-turn shows a small still grey dot in the mark
// slot, only when no other mark applies (a flag, the checkpoint circle, the
// green needs-you dot and the parked ring keep priority), on the active tab too.
// Part 1 drives the REAL TabBar through update(); part 2 the REAL TabManager,
// Tab and Pane, the state arriving as the bytes Claude Code writes (OSC 7501
// records, window titles) through a fake PTY.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-tab-working-mark.mjs
import { checker, setUpTabManager, until } from './tab-manager-harness.mjs';

const { check, section, finish } = checker();
const { emit, logs, makeWindow } = await setUpTabManager({ tags: ['TAB', 'GROUP'] });

// ── Part 1: the real TabBar, fed by update() ──
await section(async () => {
  const tm = await makeWindow(['A']);
  const bar = tm.tabBar;
  const draw = (tabs, groups = []) => bar.update(tabs, groups);
  const el = (id) => tm.bar.querySelector(`.tab-bar-tab[data-tab-id="${id}"]`);
  const marks = (id) => [...el(id).querySelectorAll('.tab-bar-tab-indicator')].map((d) => d.className.replace('tab-bar-tab-indicator', '').trim() || 'needs-you');
  const base = (extra) => [{ id: 'x', title: 'one', active: true }, { id: 'y', title: 'two', active: false, ...extra }];
  const cases = [
    ['working alone, inactive', { working: true }, ['working']],
    ['nothing', {}, []],
    ['a manual flag outranks it', { working: true, flag: 'green' }, ['flag-green']],
    ['an automatic flag outranks it', { working: true, autoFlag: 'yellow' }, ['flag-yellow']],
    ['the checkpoint circle outranks it', { working: true, checkpointDone: true }, ['checkpoint-done']],
    ['the green needs-you dot outranks it', { working: true, awaitingInput: true }, ['needs-you']],
    ['the parked ring outranks it', { working: true, parked: { tasks: 1, crons: 0 } }, ['parked']],
  ];
  for (const [name, extra, want] of cases) {
    draw(base(extra));
    check(`W1 priority: ${name}`, JSON.stringify(marks('y')) === JSON.stringify(want), marks('y'));
  }
  draw(base({ working: true }));
  const dot = el('y').querySelector('.tab-bar-tab-indicator.working');
  check('W1: the dot is labelled "Claude working", role img', dot?.getAttribute('aria-label') === 'Claude working' && dot?.getAttribute('role') === 'img');
  check('W1: the tab\'s own label says so', el('y').getAttribute('aria-label') === 'two, Claude working', el('y').getAttribute('aria-label'));
  draw([{ id: 'x', title: 'one', active: true, working: true }]);
  check('W1: shown on the active tab too', marks('x').join() === 'working', marks('x'));
  // On the active tab the green dot and the circle are not drawn, so they don't hide it.
  draw([{ id: 'x', title: 'one', active: true, working: true, awaitingInput: true, checkpointDone: true }]);
  check('W1: on the active tab, an undrawn green dot or circle doesn\'t hide it', marks('x').join() === 'working', marks('x'));
  draw([{ id: 'x', title: 'one', active: true, working: true, flag: 'red' }]);
  check('W1: on the active tab a flag still outranks it', marks('x').join() === 'flag-red', marks('x'));
  draw(base({ working: true, flag: 'green' }));
  check('W1: the tab label with a flag names the flag only', el('y').getAttribute('aria-label') === 'two, flagged green', el('y').getAttribute('aria-label'));
  // A folded group's chip ranks what needs you: a working tab adds nothing to it.
  draw([{ id: 'x', title: 'one', active: true }, { id: 'y', title: 'two', active: false, groupId: 'g', working: true }], [{ id: 'g', name: 'G', folded: true }]);
  const chip = tm.bar.querySelector('.tab-bar-group-chip');
  check('W1: a folded chip shows no mark for a working tab', chip && chip.querySelectorAll('.tab-bar-tab-indicator').length === 0);
  const before = logs.length;
  for (let i = 0; i < 5; i++) draw(base({ working: i % 2 === 0 }));
  check('W1: no log line per redraw', logs.length === before, logs.slice(before));
});

// ── Part 2: the real TabManager, Tab and Pane ──
const root = (state, extra = '') => `\x1b]7501;state=${state}:app=claude-code${extra}\x07`;
await section(async () => {
  const tm = await makeWindow(['A', 'B']);
  const tabA = tm.getTabs()[0];
  const tabB = tm.getTabs()[1];
  const el = (tab) => tm.bar.querySelector(`.tab-bar-tab[data-tab-id="${tab.id}"]`);
  const hasDot = (tab) => !!el(tab)?.querySelector('.tab-bar-tab-indicator.working');
  let redraws = 0;
  const realUpdate = tm.tabBar.update.bind(tm.tabBar);
  tm.tabBar.update = (...a) => { redraws++; return realUpdate(...a); };

  check('real: no dot before Claude runs', !hasDot(tabA) && !hasDot(tabB));
  emit(tabA.ptyId, root('working'));
  check('real: 7501 working on an inactive tab draws the dot', await until(() => hasDot(tabA)));
  check('real: Tab.working reads true', tabA.working === true);
  const r0 = redraws;
  emit(tabA.ptyId, root('working', ':title=Still going'));
  await until(() => false, 80);
  check('real: a second working report doesn\'t redraw for the dot', redraws === r0, { redraws, r0 });
  emit(tabA.ptyId, root('blocked', ':kind=permission'));
  check('real: blocked (asking) takes the grey dot away', await until(() => !hasDot(tabA)));
  emit(tabA.ptyId, root('working'));
  await until(() => hasDot(tabA));
  emit(tabA.ptyId, root('done'));
  check('real: done takes it away', await until(() => !hasDot(tabA)));
  check('real: ...and the turn end raises the green dot in its place', await until(() => !!el(tabA)?.querySelector('.tab-bar-tab-indicator:not(.working):not(.parked):not([class*="flag-"])'), 3000));

  emit(tabB.ptyId, root('working'));
  check('real: the active tab shows it too', await until(() => hasDot(tabB)));
  emit(tabB.ptyId, root('done'));
  emit(tabB.ptyId, root('working', '') + '\x1b]7501;state=working:id=bg1:app=claude-code\x07');
  await until(() => hasDot(tabB));
  emit(tabB.ptyId, root('done'));
  check('real: a turn that ends with background work shows the ring, not the dot', await until(() => !hasDot(tabB) && !!el(tabB)?.querySelector('.tab-bar-tab-indicator.parked'), 3000));
  emit(tabB.ptyId, '\x1b]7501;state=clear\x07');

  // Title path (no 7501): ◐ is mid-turn, ✳ is not.
  const tm2 = await makeWindow(['C', 'D']);
  const tabC = tm2.getTabs()[0];
  const hasDot2 = (tab) => !!tm2.bar.querySelector(`.tab-bar-tab[data-tab-id="${tab.id}"] .tab-bar-tab-indicator.working`);
  emit(tabC.ptyId, '\x1b]2;◐ Fix the bug\x07');
  check('real: title path ◐ draws the dot', await until(() => hasDot2(tabC)));
  emit(tabC.ptyId, '\x1b]2;✳ Fix the bug\x07');
  check('real: title path ✳ takes it away', await until(() => !hasDot2(tabC)));
});

finish();
