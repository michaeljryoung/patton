// Check of the working mark on the tab strip (S63, 24 Nov 2026). Michael picked
// "W1 · Still dot" on the try-out page (docs/mocks/tryout-s63-tabs.html): a
// Claude tab whose session is mid-turn shows a small still grey dot in the mark
// slot, only when no other mark applies (a flag, the checkpoint circle, the
// green needs-you dot and the parked ring keep priority), on the active tab too.
// Part 1 drives the REAL TabBar through update(); part 2 the REAL TabManager,
// Tab and Pane, the state arriving as the bytes Claude Code writes (OSC 7501
// records, window titles) through a fake PTY.
// Part 3: split panes, closing the working pane, Claude leaving mid-turn, a Stop
// over a still-working root (the ring, not the dot), a non-Claude program's
// `working`, and one redraw per change.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-tab-working-mark.mjs
import { checker, setUpTabManager, until } from './tab-manager-harness.mjs';

const { check, section, finish } = checker();
const { w, emit, feed, logs, makeWindow } = await setUpTabManager({ tags: ['TAB', 'GROUP'] });

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
  // The strip draws what the Tab holds; the Tab holds the green dot and the circle
  // on the selected tab only while its window is behind (check-green-selected.mjs).
  draw([{ id: 'x', title: 'one', active: true, working: true, awaitingInput: true, checkpointDone: true }]);
  check('W1: on the active tab, a held green dot or circle outranks it as on any tab', marks('x').join() === 'checkpoint-done', marks('x'));
  draw([{ id: 'x', title: 'one', active: true, working: true, flag: 'red' }]);
  check('W1: on the active tab a flag still outranks it', marks('x').join() === 'flag-red', marks('x'));
  draw(base({ working: true, flag: 'green' }));
  check('W1: the tab label with a flag names the flag only', el('y').getAttribute('aria-label') === 'two, flagged green', el('y').getAttribute('aria-label'));
  // A folded group's chip shows the grey dot too, lowest of its ranks (D1).
  draw([{ id: 'x', title: 'one', active: true }, { id: 'y', title: 'two', active: false, groupId: 'g', working: true }], [{ id: 'g', name: 'G', folded: true }]);
  const chipMarks = () => [...tm.bar.querySelector('.tab-bar-group-chip').querySelectorAll('.tab-bar-tab-indicator')].map((d) => d.className.replace('tab-bar-tab-indicator', '').trim() || 'needs-you');
  check('W1: a folded chip shows the grey dot for a working tab inside', chipMarks().join() === 'working', chipMarks());
  check('W1: ...and its label says so', /1 Claude working/.test(tm.bar.querySelector('.tab-bar-group-chip').getAttribute('aria-label') ?? ''), tm.bar.querySelector('.tab-bar-group-chip').getAttribute('aria-label'));
  draw([{ id: 'x', title: 'one', active: true }, { id: 'y', title: 'two', active: false, groupId: 'g', working: true }, { id: 'z', title: 'three', active: false, groupId: 'g', parked: { tasks: 1, crons: 0 } }], [{ id: 'g', name: 'G', folded: true }]);
  check('W1: a hidden parked tab outranks a hidden working one on the chip', chipMarks().join() === 'parked', chipMarks());
  draw([{ id: 'x', title: 'one', active: true }, { id: 'y', title: 'two', active: false, groupId: 'g', working: true }, { id: 'z', title: 'three', active: false, groupId: 'g', flag: 'red' }], [{ id: 'g', name: 'G', folded: true }]);
  check('W1: a hidden flag outranks a hidden working tab on the chip', chipMarks().join() === 'flag-red', chipMarks());
  draw([{ id: 'x', title: 'one', active: true }, { id: 'y', title: 'two', active: false, groupId: 'g', working: true }, { id: 'z', title: 'three', active: false, groupId: 'g', awaitingInput: true }], [{ id: 'g', name: 'G', folded: true }]);
  check('W1: a hidden needs-you dot outranks a hidden working tab on the chip', chipMarks().join() === 'needs-you', chipMarks());
  // The hover list under a folded chip: one row per hidden tab, the dot beside each.
  draw([{ id: 'x', title: 'one', active: true }, { id: 'y', title: 'two', active: false, groupId: 'g', working: true }, { id: 'z', title: 'three', active: false, groupId: 'g' }], [{ id: 'g', name: 'G', folded: true }]);
  tm.bar.querySelector('.tab-bar-group-chip').dispatchEvent(new w.MouseEvent('mouseenter', { bubbles: true }));
  await until(() => !!tm.bar.querySelector('.tab-bar-group-list'), 1000);
  const rowDot = (id) => tm.bar.querySelector(`.tab-bar-group-list-row[data-tab-id="${id}"] .tab-bar-tab-indicator.working`);
  check('W1: the hover list shows the grey dot on the working tab\'s row only', !!rowDot('y') && !rowDot('z'), !!tm.bar.querySelector('.tab-bar-group-list'));
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

// ── Part 3: panes, exits, the ring, redraws ──
await section(async () => {
  const tm = await makeWindow(['A', 'B']);
  const tabA = tm.getTabs()[0];
  const tabB = tm.getTabs()[1];
  const el = (tab) => tm.bar.querySelector(`.tab-bar-tab[data-tab-id="${tab.id}"]`);
  const hasDot = (tab) => !!el(tab)?.querySelector('.tab-bar-tab-indicator.working');
  const workLogs = (tab) => logs.filter((l) => l.msg === '[TAB] working' && l.data?.tabId === tab.id).map((l) => l.data.on);
  let redraws = 0;
  const realUpdate = tm.tabBar.update.bind(tm.tabBar);
  tm.tabBar.update = (...a) => { redraws++; return realUpdate(...a); };

  // A non-Claude program sending state=working is no "Claude working" (probe S6).
  emit(tabA.ptyId, '\x1b]7501;state=working:app=other-tool\x07');
  await until(() => false, 80);
  check('S6: a non-Claude program\'s 7501 working draws no dot', !hasDot(tabA) && tabA.working === false, tabA.working);

  // Split: Claude working in the pane that is NOT focused.
  await tabB.splitVertical();
  await until(() => tabB.panes.length === 2 && tabB.panes.every((p) => p.ptyId !== null));
  const [p0, p1] = tabB.panes;
  const unfocused = tabB.focusedPane === p0 ? p1 : p0;
  emit(unfocused.ptyId, root('working'));
  check('split: Claude working in the unfocused pane draws the dot', await until(() => hasDot(tabB)));
  check('split: the log says on:true once', workLogs(tabB).join() === 'true', workLogs(tabB));
  // Closing that pane: the dot goes with it, logged and drawn at once.
  tabB.closePane(unfocused);
  check('pane close: the dot goes at once (no later event needed)', !hasDot(tabB) && tabB.working === false);
  check('pane close: the change is logged at the close itself', workLogs(tabB).join() === 'true,false', workLogs(tabB));
  const r1 = redraws;
  emit(tabB.ptyId, root('working'));
  await until(() => hasDot(tabB));
  emit(tabB.ptyId, root('done'));
  await until(() => !hasDot(tabB));
  check('pane close: afterwards one redraw per change, none doubled', redraws - r1 <= 4, redraws - r1);
  emit(tabB.ptyId, '\x1b]7501;state=clear\x07');

  // Claude leaves mid-turn (a bare state=clear).
  const tm2 = await makeWindow(['C']);
  const tabC = tm2.getTabs()[0];
  const hasDot2 = () => !!tm2.bar.querySelector(`.tab-bar-tab[data-tab-id="${tabC.id}"] .tab-bar-tab-indicator.working`);
  emit(tabC.ptyId, root('working'));
  await until(hasDot2);
  emit(tabC.ptyId, '\x1b]7501;state=clear\x07');
  check('exit mid-turn: Claude leaving takes the dot away', await until(() => !hasDot2()) && tabC.working === false);

  // Stop over a still-working root, the feed attached: the ring, not the dot.
  const tm3 = await makeWindow(['E']);
  const tabE = tm3.getTabs()[0];
  const marksE = () => [...tm3.bar.querySelectorAll(`.tab-bar-tab[data-tab-id="${tabE.id}"] .tab-bar-tab-indicator`)].map((d) => d.className.replace('tab-bar-tab-indicator', '').trim() || 'needs-you');
  emit(tabE.ptyId, root('working'));
  emit(tabE.ptyId, '\x1b]7501;state=working:id=sub1:app=claude-code\x07');
  await until(() => marksE().join() === 'working');
  feed(tabE.ptyId, { type: 'attached', sessionId: 's1', how: 'hook' });
  emit(tabE.ptyId, '\x1b]777;patton;stop;tasks=1;crons=0\x07');
  check('Stop over a working root with the feed: the dot goes (the ring takes over)', await until(() => !marksE().includes('working')), marksE());
  check('...and Tab.working reads false', tabE.working === false);
  check('...and the ring shows', marksE().join() === 'parked' || marksE().length === 1, marksE());

  // The same Stop with NO feed attached: documented limit (D1), the dot stays.
  const tm4 = await makeWindow(['F']);
  const tabF = tm4.getTabs()[0];
  emit(tabF.ptyId, root('working'));
  emit(tabF.ptyId, '\x1b]7501;state=working:id=sub1:app=claude-code\x07');
  await until(() => tabF.working);
  emit(tabF.ptyId, '\x1b]777;patton;stop;tasks=1;crons=0\x07');
  await until(() => false, 150);
  check('Stop over a working root with no feed: the dot stays (D1\'s stated limit)', tabF.working === true);

  // One redraw when a working flip coincides with a title change (Claude start / exit).
  const tm5 = await makeWindow([]);
  const tabG = await tm5.createTab();
  let draws5 = 0;
  const real5 = tm5.tabBar.update.bind(tm5.tabBar);
  tm5.tabBar.update = (...a) => { draws5++; return real5(...a); };
  // A title the shell side set: hidden while no Claude runs ("Terminal"), shown the moment it does.
  emit(tabG.ptyId, '\x1b]2;Fix the bug\x07');
  await until(() => false, 60);
  const d0 = draws5;
  emit(tabG.ptyId, root('working', ''));
  await until(() => tabG.working, 1000);
  await until(() => false, 100);
  const startDraws = draws5 - d0;
  check('start: one redraw for the dot', startDraws === 1, startDraws);
  const d1 = draws5;
  emit(tabG.ptyId, '\x1b]7501;state=clear\x07');
  await until(() => !tabG.working, 1000);
  await until(() => false, 100);
  check('exit: the title changed with the flip (the case is real)', tabG.title === 'Terminal', tabG.title);
  check('exit: one redraw for the title and the dot together', draws5 - d1 === 1, draws5 - d1);
});

finish();
