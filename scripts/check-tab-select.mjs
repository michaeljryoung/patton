// Check of multi-select on the tab strip (S63, 24 Nov 2026, docs/tab-select.md
// D2). Michael: "ability to select multiple tabs at once for putting in groups
// or moving at once - shift and click and selects from first to last ... cmd
// click to select individually then be able to move or group as whole, or
// colour as whole, rename shouldnt apply to whole bunch"; look S1 on the
// try-out page (docs/mocks/tryout-s63-tabs.html), whose section 3 is the spec.
// Drives the REAL TabManager and TabBar (jsdom): clicks, ⌘ and ⇧, Esc from the
// strip, the page and a terminal, the empty strip, every menu action on a
// 4-tab selection spanning a group, a multi-tab drag, pruning, rename of one
// tab, and the pure block helpers in tab-groups.ts.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-tab-select.mjs
import { checker, setUpTabManager, tick } from './tab-manager-harness.mjs';

const { check, section, finish } = checker();
const { w, doc, logs, makeWindow, tabGroups: G } = await setUpTabManager({ tags: ['TAB', 'GROUP'] });

// --- helpers ---
const idOf = (tm, name) => tm.getTabs().find((t) => t.title === name)?.id;
const nameOf = (tm, id) => tm.getTabs().find((t) => t.id === id)?.title;
const tabEl = (tm, name) => tm.bar.querySelector(`.tab-bar-tab[data-tab-id="${idOf(tm, name)}"]`);
const chipEl = (tm, groupId) => tm.bar.querySelector(`.tab-bar-group-chip[data-group-id="${groupId}"]`);
/** The strip as text: each tab's name, @group name when grouped, #flag when flagged. */
const order = (tm) => {
  const gname = new Map(tm.getTabGroups().map((g) => [g.id, g.name || '?']));
  const groupOfTab = new Map(tm.getTabGroups().flatMap((g) => g.tabIds.map((id) => [id, g.id])));
  return tm.getTabs().map((t) => t.title + (groupOfTab.has(t.id) ? `@${gname.get(groupOfTab.get(t.id))}` : '') + (t.flag ? `#${t.flag}` : '')).join(' ');
};
const selected = (tm) => tm.tabBar.selectedIds().map((id) => nameOf(tm, id)).join(' ');
const multiShown = (tm) => [...tm.bar.querySelectorAll('.tab-bar-tab.multi')].map((el) => nameOf(tm, el.dataset.tabId)).join(' ');
const activeName = (tm) => tm.getActiveTab()?.title;
/** Every group's tabs one unbroken run, and no repair logged since `mark`. */
function runsSound(tm, label, mark) {
  const ids = tm.getTabs().map((t) => t.id);
  const bad = [];
  for (const g of tm.getTabGroups()) {
    const at = g.tabIds.map((id) => ids.indexOf(id));
    if (at[at.length - 1] - at[0] !== at.length - 1) bad.push(g.name || g.id);
  }
  const repairs = logs.slice(mark).filter((l) => l.msg === '[GROUP] broken run repaired').length;
  check(`${label}: every group one unbroken run, none repaired`, bad.length === 0 && repairs === 0, { bad, repairs, order: order(tm) });
}
const fire = (el, type, init = {}) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, screenX: 50, screenY: 50, ...init }));
/** A click that doesn't move the window, with the keys held (meta, shift). */
function click(el, keys = {}) {
  fire(el, 'mousedown', { metaKey: !!keys.meta, shiftKey: !!keys.shift });
  fire(doc, 'mouseup');
}
/** A press that moves past the 5 px threshold (a window drag). */
function dragWindow(el) {
  fire(el, 'mousedown');
  fire(doc, 'mousemove', { screenX: 70, screenY: 50 });
  fire(doc, 'mouseup', { screenX: 70, screenY: 50 });
}
const clickTab = (tm, name, keys) => click(tabEl(tm, name).querySelector('.tab-bar-tab-title'), keys);
const selLogs = (mark) => logs.slice(mark).filter((l) => l.msg === '[TAB] selection');
const menuItemsNow = () => [...doc.querySelectorAll('.context-menu-overlay.visible .context-menu-item')];
const labelOf = (item) => item.querySelector('span')?.textContent ?? '';
const closeMenus = () => {
  for (const o of doc.querySelectorAll('.context-menu-overlay.visible')) o.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};
function tabMenu(tm, name) {
  closeMenus();
  tabEl(tm, name).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }));
  return menuItemsNow();
}
function pick(tm, name, label) {
  const item = tabMenu(tm, name).find((i) => labelOf(i) === label);
  if (!item) throw new Error(`no menu item "${label}" on ${name}: ${menuItemsNow().map(labelOf).join(' | ')}`);
  item.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
}
const escKey = (target) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
function makeDt() {
  return {
    data: {}, images: [],
    setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k] ?? ''; },
    setDragImage(el) { this.images.push(el.textContent); },
    effectAllowed: '', dropEffect: '',
  };
}
const dragEv = (type, dt) => { const e = new w.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'dataTransfer', { value: dt }); return e; };

/** A B [C D]=Research E F [G]=Other, B active; then B ⇧-click E: B C D E selected. */
async function fourSpanningGroup() {
  const tm = await makeWindow(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  const research = tm.addTabToNewGroup(idOf(tm, 'C'));
  tm.addTabToGroup(idOf(tm, 'D'), research);
  tm.renameGroup(research, 'Research');
  const other = tm.addTabToNewGroup(idOf(tm, 'G'));
  tm.renameGroup(other, 'Other');
  clickTab(tm, 'B');
  clickTab(tm, 'E', { shift: true });
  return { tm, research, other };
}

// ── 1. Clicks: plain, ⌘, ⇧, the log, the look ──
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C', 'D', 'E', 'F']);
  check('the tablist says it is multi-selectable', tm.bar.querySelector('.tab-bar-tabs')?.getAttribute('aria-multiselectable') === 'true');
  clickTab(tm, 'B');
  check('plain click opens the tab, and it alone is selected', activeName(tm) === 'B' && selected(tm) === 'B', { active: activeName(tm), sel: selected(tm) });
  let mark = logs.length;
  clickTab(tm, 'D', { meta: true });
  check('⌘-click adds a tab without opening it', activeName(tm) === 'B' && selected(tm) === 'B D', { active: activeName(tm), sel: selected(tm) });
  check('the added tab is drawn .multi, the active tab is not', multiShown(tm) === 'D' && !tabEl(tm, 'B').classList.contains('multi'), multiShown(tm));
  check('a selected tab reads aria-selected true and ", selected" in its label',
    tabEl(tm, 'D').getAttribute('aria-selected') === 'true' && tabEl(tm, 'D').getAttribute('aria-label').includes(', selected') && tabEl(tm, 'C').getAttribute('aria-selected') === 'false',
    tabEl(tm, 'D').getAttribute('aria-label'));
  check('[TAB] selection logged with the count, active included', selLogs(mark).length === 1 && selLogs(mark)[0].data?.count === 2, selLogs(mark));
  mark = logs.length;
  clickTab(tm, 'B', { meta: true });
  check('⌘-click on the active tab changes nothing (it always counts)', selected(tm) === 'B D' && activeName(tm) === 'B');
  tm.renameTab(idOf(tm, 'F'), 'F'); // a redraw with nothing new
  check('no [TAB] selection line when the selection did not change', selLogs(mark).length === 0, selLogs(mark));
  clickTab(tm, 'D', { meta: true });
  check('⌘-click on a selected tab takes it out', selected(tm) === 'B' && multiShown(tm) === '');
  // ⇧ from the anchor (D, the last ⌘-clicked tab, as on the page) to E, plus the active tab.
  clickTab(tm, 'E', { shift: true });
  check('⇧-click selects from the anchor (last ⌘-clicked) to it, the active tab kept, nothing opened', selected(tm) === 'B D E' && activeName(tm) === 'B', selected(tm));
  clickTab(tm, 'A', { shift: true });
  check('⇧-click again counts from the same anchor (the range replaces the last)', selected(tm) === 'A B C D', selected(tm));
  clickTab(tm, 'B');
  clickTab(tm, 'E', { shift: true });
  check('after a plain click the anchor is that tab: ⇧ selects B to E in strip order', selected(tm) === 'B C D E' && activeName(tm) === 'B', selected(tm));
  clickTab(tm, 'D', { meta: true });
  clickTab(tm, 'F', { shift: true });
  check('⌘-click moves the anchor: ⇧ then counts from it, the active tab kept', selected(tm) === 'B D E F' && activeName(tm) === 'B', selected(tm));
  dragWindow(tabEl(tm, 'C').querySelector('.tab-bar-tab-title'));
  check('a press that drags the window selects nothing and opens nothing', selected(tm) === 'B D E F' && activeName(tm) === 'B');
  clickTab(tm, 'C');
  check('plain click on another tab: it alone, opened', selected(tm) === 'C' && activeName(tm) === 'C', selected(tm));
  clickTab(tm, 'E', { meta: true });
  clickTab(tm, 'C');
  check('plain click on the active tab clears the extras', selected(tm) === 'C' && multiShown(tm) === '', selected(tm));
  clickTab(tm, 'E', { meta: true });
  tm.switchToId(idOf(tm, 'A'));
  check('a change of active tab by another route (⌘1, palette) clears it', selected(tm) === 'A' && multiShown(tm) === '', selected(tm));
  clickTab(tm, 'E', { meta: true });
  tm.switchToId(idOf(tm, 'E'));
  check('switching to a selected tab by another route also clears', selected(tm) === 'E', selected(tm));
});

// ── 2. Esc: from the strip or the page body, never from a terminal ──
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C']);
  clickTab(tm, 'A');
  clickTab(tm, 'C', { shift: true });
  const term = doc.querySelector('.xterm-helper-textarea') ?? doc.querySelector('.terminal-container textarea');
  check('a terminal textarea exists to send Esc from', !!term);
  if (term) {
    const ev = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    term.dispatchEvent(ev);
    check('Esc in a terminal keeps the selection (it goes to Claude)', selected(tm) === 'A B C', selected(tm));
    check('Esc in a terminal is not prevented by the strip', ev.defaultPrevented === false || !logs.some((l) => l.msg === '[TAB] selection' && l.data?.count === 1));
  }
  escKey(doc.body);
  check('Esc from the page body clears it', selected(tm) === 'A' && multiShown(tm) === '', selected(tm));
  clickTab(tm, 'C', { shift: true });
  escKey(tabEl(tm, 'B'));
  check('Esc from the strip (a focused tab) clears it', selected(tm) === 'A', selected(tm));
  clickTab(tm, 'C', { meta: true });
  // Esc in an open rename box cancels the rename, not the selection.
  tabEl(tm, 'B').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  const box = tm.bar.querySelector('.tab-bar-tab-rename');
  check('a rename box opened by double-click', !!box);
  if (box) escKey(box);
  check('Esc in a rename box keeps the selection', selected(tm) === 'A C', selected(tm));
});

// ── 3. A click on the empty strip or the drag space clears; a window drag doesn't ──
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C']);
  clickTab(tm, 'A');
  clickTab(tm, 'C', { shift: true });
  const strip = tm.bar.querySelector('.tab-bar-tabs');
  dragWindow(strip);
  check('a window drag from the empty strip keeps the selection', selected(tm) === 'A B C', selected(tm));
  click(strip);
  check('a click on the empty strip clears it', selected(tm) === 'A', selected(tm));
  clickTab(tm, 'C', { shift: true });
  const space = tm.bar.querySelector('.tab-bar-drag-space');
  dragWindow(space);
  check('a window drag from the drag space keeps it', selected(tm) === 'A B C');
  click(space);
  check('a click on the drag space clears it', selected(tm) === 'A', selected(tm));
});

// ── 4. The menu on a 4-tab selection spanning a group ──
await section(async () => {
  const { tm } = await fourSpanningGroup();
  check('set-up: A B C@Research D@Research E F G@Other, B C D E selected',
    order(tm) === 'A B C@Research D@Research E F G@Other' && selected(tm) === 'B C D E' && activeName(tm) === 'B', { order: order(tm), sel: selected(tm) });
  const labels = tabMenu(tm, 'D').map(labelOf);
  const want = ['Add 4 Tabs to New Group', 'Add 2 Tabs to Research', 'Add 4 Tabs to Other', 'Remove 2 Tabs from Group',
    'Flag 4 Tabs: Green', 'Flag 4 Tabs: Yellow', 'Flag 4 Tabs: Red', 'Flag 4 Tabs: None', 'Rename Tab…'];
  check('menu on a selected tab: the page\'s labels, in its order', JSON.stringify(labels) === JSON.stringify(want), labels);
  const rename = menuItemsNow().find((i) => labelOf(i) === 'Rename Tab…');
  check('Rename Tab… carries the note "this tab only"', rename?.querySelector('.context-menu-shortcut')?.textContent === 'this tab only');
  check('no single-tab entries (Move Left, Bookmark) on the selection menu', !labels.includes('Move Left') && !labels.some((l) => l.startsWith('Bookmark')));
  const single = tabMenu(tm, 'A').map(labelOf);
  check('menu on an unselected tab: today\'s single-tab menu', single.includes('Add Tab to New Group') && single.includes('Move Left') && single.includes('Green') && !single.some((l) => /\d Tabs/.test(l)), single);
  closeMenus();
  check('a right-click changes no selection', selected(tm) === 'B C D E');
});
await section(async () => {
  const { tm } = await fourSpanningGroup();
  const mark = logs.length;
  pick(tm, 'C', 'Add 4 Tabs to New Group');
  const groups = tm.getTabGroups();
  check('Add 4 Tabs to New Group: one block where the first was, Research emptied',
    groups.length === 2 && groups[0].tabIds.map((id) => nameOf(tm, id)).join(' ') === 'B C D E' && order(tm).startsWith('A B@? C@? D@? E@? F G@Other'), { order: order(tm) });
  check('…its name box opens on the new chip', !!chipEl(tm, groups[0].id)?.querySelector('.tab-bar-tab-rename'));
  const created = logs.slice(mark).find((l) => l.msg === '[GROUP] created');
  check('…[GROUP] created logged with the count', created?.data?.tabs === 4 && created?.data?.fromGroups === 1, created);
  check('…and the emptied group logged', logs.slice(mark).some((l) => l.msg === '[GROUP] emptied'));
  runsSound(tm, 'new group', mark);
  check('…the selection is kept', selected(tm) === 'B C D E', selected(tm));
});
await section(async () => {
  const { tm } = await fourSpanningGroup();
  const mark = logs.length;
  pick(tm, 'B', 'Add 2 Tabs to Research');
  check('Add 2 Tabs to Research: B and E follow its last tab, in order', order(tm) === 'A C@Research D@Research B@Research E@Research F G@Other', order(tm));
  check('…[GROUP] tabs added with the count', logs.slice(mark).some((l) => l.msg === '[GROUP] tabs added' && l.data?.tabs === 2));
  runsSound(tm, 'add to Research', mark);
});
await section(async () => {
  const { tm } = await fourSpanningGroup();
  const mark = logs.length;
  pick(tm, 'E', 'Add 4 Tabs to Other');
  check('Add 4 Tabs to Other: all four after G, Research emptied', order(tm) === 'A F G@Other B@Other C@Other D@Other E@Other', order(tm));
  runsSound(tm, 'add to Other', mark);
});
await section(async () => {
  const { tm } = await fourSpanningGroup();
  const mark = logs.length;
  pick(tm, 'B', 'Remove 2 Tabs from Group');
  check('Remove 2 Tabs from Group: none left in Research, they stay where they are', order(tm) === 'A B C D E F G@Other', order(tm));
  check('…[GROUP] tabs removed with the count', logs.slice(mark).some((l) => l.msg === '[GROUP] tabs removed' && l.data?.tabs === 2));
  runsSound(tm, 'remove all', mark);
  // Some left: Research = C D E, selection B C D → C D leave, land after E.
  const tm2 = await makeWindow(['A', 'B', 'C', 'D', 'E', 'F']);
  const r = tm2.addTabToNewGroup(idOf(tm2, 'C'));
  tm2.addTabToGroup(idOf(tm2, 'D'), r);
  tm2.addTabToGroup(idOf(tm2, 'E'), r);
  tm2.renameGroup(r, 'R');
  clickTab(tm2, 'B');
  clickTab(tm2, 'D', { shift: true });
  const m2 = logs.length;
  pick(tm2, 'C', 'Remove 2 Tabs from Group');
  check('Remove with tabs left in the group: the block lands just after them', order(tm2) === 'A B E@R C D F', order(tm2));
  runsSound(tm2, 'remove some', m2);
});
await section(async () => {
  const { tm } = await fourSpanningGroup();
  const mark = logs.length;
  pick(tm, 'C', 'Flag 4 Tabs: Green');
  check('Flag 4 Tabs: Green flags every one', order(tm) === 'A B#green C@Research#green D@Research#green E#green F G@Other', order(tm));
  check('…[TAB] flagged together with the count', logs.slice(mark).some((l) => l.msg === '[TAB] flagged together' && l.data?.count === 4 && l.data?.flag === 'green'));
  check('…the menu then ticks Green', tabMenu(tm, 'C').map(labelOf).includes('✓ Flag 4 Tabs: Green'));
  pick(tm, 'C', '✓ Flag 4 Tabs: Green');
  check('…picking it again keeps them green (no toggle on a set)', order(tm).includes('B#green') && order(tm).includes('E#green'));
  pick(tm, 'D', 'Flag 4 Tabs: Yellow');
  check('Flag 4 Tabs: Yellow', ['B', 'C', 'D', 'E'].every((n) => tm.getTabs().find((t) => t.title === n).flag === 'yellow'));
  pick(tm, 'D', 'Flag 4 Tabs: Red');
  check('Flag 4 Tabs: Red', ['B', 'C', 'D', 'E'].every((n) => tm.getTabs().find((t) => t.title === n).flag === 'red'));
  pick(tm, 'E', 'Flag 4 Tabs: None');
  check('Flag 4 Tabs: None clears them all, A F G untouched', tm.getTabs().every((t) => !t.flag), order(tm));
});
await section(async () => {
  const { tm } = await fourSpanningGroup();
  pick(tm, 'D', 'Rename Tab…');
  const box = tm.bar.querySelector('.tab-bar-tab-rename');
  check('Rename Tab… opens one box, on the clicked tab', !!box && box.closest('.tab-bar-tab')?.dataset.tabId === idOf(tm, 'D'));
  if (box) {
    box.value = 'Zed';
    box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }
  await tick();
  check('…and renames that tab only', order(tm) === 'A B C@Research Zed@Research E F G@Other', order(tm));
});

// ── 5. Dragging a selected tab moves the whole selection ──
await section(async () => {
  const { tm } = await fourSpanningGroup();
  const dt = makeDt();
  const grip = tabEl(tm, 'C').querySelector('.tab-bar-tab-grip');
  grip.dispatchEvent(dragEv('dragstart', dt));
  check('drag of a selected tab: all four drawn dragging', [...tm.bar.querySelectorAll('.tab-bar-tab.dragging')].length === 4);
  check('…with a "4 tabs" drag picture', dt.images.join() === '4 tabs', dt.images);
  tabEl(tm, 'D').dispatchEvent(dragEv('dragover', dt));
  check('…a selected tab shows no drop line', !tabEl(tm, 'D').classList.contains('drag-over'));
  tabEl(tm, 'D').dispatchEvent(dragEv('drop', dt));
  check('…a drop on a tab of the selection moves nothing', order(tm) === 'A B C@Research D@Research E F G@Other', order(tm));
  grip.dispatchEvent(dragEv('dragend', dt));
  const mark = logs.length;
  const dt2 = makeDt();
  tabEl(tm, 'C').querySelector('.tab-bar-tab-grip').dispatchEvent(dragEv('dragstart', dt2));
  tabEl(tm, 'G').dispatchEvent(dragEv('drop', dt2));
  check('drop on a grouped tab to the right: after it, in order, all joining its group', order(tm) === 'A F G@Other B@Other C@Other D@Other E@Other', order(tm));
  const moved = logs.slice(mark).find((l) => l.msg === '[TAB] moved together');
  check('…[TAB] moved together {count, to}', moved?.data?.count === 4 && moved?.data?.to === idOf(tm, 'G'), moved);
  check('…[GROUP] tabs moved between groups with the count', logs.slice(mark).some((l) => l.msg === '[GROUP] tabs moved between groups' && l.data?.count === 4));
  runsSound(tm, 'drop on grouped tab', mark);
  check('…the selection is kept', selected(tm) === 'B C D E', selected(tm));
  const m3 = logs.length;
  const dt3 = makeDt();
  tabEl(tm, 'E').querySelector('.tab-bar-tab-grip').dispatchEvent(dragEv('dragstart', dt3));
  tabEl(tm, 'A').dispatchEvent(dragEv('drop', dt3));
  check('drop on an ungrouped tab to the left: before it, out of their groups', order(tm) === 'B C D E A F G@Other', order(tm));
  runsSound(tm, 'drop on ungrouped tab', m3);
});
await section(async () => {
  const { tm, other } = await fourSpanningGroup();
  const mark = logs.length;
  const dt = makeDt();
  tabEl(tm, 'B').querySelector('.tab-bar-tab-grip').dispatchEvent(dragEv('dragstart', dt));
  chipEl(tm, other).dispatchEvent(dragEv('drop', dt));
  check('drop on a group\'s chip adds them all to it', order(tm) === 'A F G@Other B@Other C@Other D@Other E@Other', order(tm));
  runsSound(tm, 'drop on chip', mark);
  // Into the middle of a group's run, the block stays in that group.
  const { tm: t2 } = await fourSpanningGroup();
  const m2 = logs.length;
  const dt2 = makeDt();
  clickTab(t2, 'A');
  clickTab(t2, 'B', { meta: true });
  t2.bar.querySelector(`.tab-bar-tab[data-tab-id="${idOf(t2, 'B')}"] .tab-bar-tab-grip`).dispatchEvent(dragEv('dragstart', dt2));
  tabEl(t2, 'C').dispatchEvent(dragEv('drop', dt2));
  check('A B dropped on Research\'s first tab: after it, inside Research', order(t2) === 'C@Research A@Research B@Research D@Research E F G@Other', order(t2));
  runsSound(t2, 'drop into a run', m2);
});
await section(async () => {
  // An unselected tab's grip drags it alone, as today.
  const { tm } = await fourSpanningGroup();
  const dt = makeDt();
  tabEl(tm, 'F').querySelector('.tab-bar-tab-grip').dispatchEvent(dragEv('dragstart', dt));
  check('an unselected tab drags alone, no "N tabs" picture', tm.bar.querySelectorAll('.tab-bar-tab.dragging').length === 1 && dt.images.length === 0);
  tabEl(tm, 'A').dispatchEvent(dragEv('drop', dt));
  check('…and moves as one tab did before (reorder)', order(tm).startsWith('F A B'), order(tm));
  // A drop from another window (tab ids repeat across windows) is ignored.
  const other = await makeWindow(['X', 'Y', 'Z']);
  const before = order(tm);
  const dtFor = makeDt();
  tabEl(other, 'X').querySelector('.tab-bar-tab-grip'); // its own strip
  dtFor.setData('text/plain', idOf(tm, 'B'));
  tabEl(tm, 'G').dispatchEvent(dragEv('drop', dtFor));
  check('a drop that began in another window moves nothing here', order(tm) === before, order(tm));
});

// ── 6. Pruning: closed tabs, tabs hidden in a folded group ──
await section(async () => {
  const { tm, research } = await fourSpanningGroup();
  await tm.closeById(idOf(tm, 'E'));
  check('a closed selected tab leaves the selection', selected(tm) === 'B C D', selected(tm));
  const mark = logs.length;
  tm.foldGroup(research);
  check('tabs hidden in a folded group leave it', selected(tm) === 'B' && multiShown(tm) === '', selected(tm));
  check('…logged once with the new count', selLogs(mark).length === 1 && selLogs(mark)[0].data?.count === 1, selLogs(mark));
  tm.toggleGroupFolded(research, 'click');
  check('unfolding does not bring them back', selected(tm) === 'B');
  // ⇧ across a folded group skips its hidden tabs.
  const t2 = await makeWindow(['A', 'B', 'C', 'D']);
  const g = t2.addTabToNewGroup(idOf(t2, 'B'));
  t2.addTabToGroup(idOf(t2, 'C'), g);
  clickTab(t2, 'A');
  t2.foldGroup(g);
  clickTab(t2, 'D', { shift: true });
  check('⇧ across a folded group selects only the tabs on the strip', selected(t2) === 'A D', selected(t2));
});

// ── 7. The pure block helpers (tab-groups.ts) ──
await section(async () => {
  const gOf = (map) => (x) => map[x] ?? null;
  const groups = { c: 'R', d: 'R', g: 'O' };
  const s = (list) => list.join('');
  check('insertBlock: a place inside another group\'s run moves past its end',
    s(G.insertBlock(['a', 'c', 'd', 'e'], ['x', 'y'], 2, gOf(groups))) === 'acdxye');
  check('insertBlock: items joining that group may sit inside it',
    s(G.insertBlock(['a', 'c', 'd', 'e'], ['x'], 2, gOf({ ...groups, x: 'R' }))) === 'acxde');
  check('insertBlock: an out-of-range place is clamped', s(G.insertBlock(['a', 'b'], ['x'], 9, gOf({}))) === 'abx');
  const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  check('gatherAsNewGroup: the block sits where the first of them was',
    s(G.gatherAsNewGroup(list, ['e', 'b'], gOf({ ...groups, b: 'N', e: 'N' }))) === 'abecdfg');
  check('gatherAsNewGroup: never inside another run (first was mid-run)',
    s(G.gatherAsNewGroup(['a', 'c', 'd', 'k', 'e'], ['d', 'e'], gOf({ c: 'R', k: 'R', d: 'N', e: 'N' }))) === 'ackde');
  check('gatherAsNewGroup: nothing moving leaves the list', s(G.gatherAsNewGroup(list, [], gOf(groups))) === s(list));
  check('gatherAfterGroup: after the group\'s last other tab, in strip order',
    s(G.gatherAfterGroup(list, ['e', 'b'], 'R', gOf({ ...groups, b: 'R', e: 'R' }))) === 'acdbefg');
  check('gatherAfterGroup: a group with no other tab leaves the list',
    s(G.gatherAfterGroup(list, ['b'], 'Z', gOf({ b: 'Z' }))) === s(list));
  check('takeBlockOutOfGroup: some remain → after them',
    s(G.takeBlockOutOfGroup(['a', 'c', 'd', 'k', 'e'], ['c', 'd'], 'R', gOf({ k: 'R' }))) === 'akcde');
  check('takeBlockOutOfGroup: none remain → where they are',
    s(G.takeBlockOutOfGroup(list, ['c', 'd'], 'R', gOf({}))) === s(list));
  check('moveBlockTo: target right of the first moved → after it',
    s(G.moveBlockTo(list, ['b', 'c'], 'e', gOf({}))) === 'adebcfg');
  check('moveBlockTo: target left → before it', s(G.moveBlockTo(list, ['e', 'f'], 'b', gOf({}))) === 'aefbcdg');
  check('moveBlockTo: a target in the block leaves the list', s(G.moveBlockTo(list, ['b', 'c'], 'c', gOf({}))) === s(list));
  check('moveBlockTo: an unknown target leaves the list', s(G.moveBlockTo(list, ['b'], 'zz', gOf({}))) === s(list));
  // Property: for random lists, groups and selections, every helper keeps every run whole.
  let bad = 0;
  let cases = 0;
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let k = 0; k < 3000; k++) {
    const n = 2 + rnd(9);
    const items = Array.from({ length: n }, (_, i) => `t${i}`);
    // Sound start: assign runs.
    const member = {};
    let i = 0;
    while (i < n) {
      const len = 1 + rnd(3);
      const gid = rnd(3) === 0 ? null : `g${i}`;
      for (let j = i; j < Math.min(n, i + len); j++) if (gid) member[items[j]] = gid;
      i += len;
    }
    const moving = items.filter(() => rnd(3) === 0);
    if (moving.length === 0) continue;
    const pickOp = rnd(4);
    const m = { ...member };
    let out;
    if (pickOp === 0) { for (const x of moving) m[x] = 'NEW'; out = G.gatherAsNewGroup(items, moving, gOf(m)); }
    else if (pickOp === 1) {
      const target = items[rnd(n)];
      if (moving.includes(target)) continue;
      for (const x of moving) { if (m[target]) m[x] = m[target]; else delete m[x]; }
      out = G.moveBlockTo(items, moving, target, gOf(m));
    } else if (pickOp === 2) {
      const gid = Object.values(member)[0];
      if (!gid) continue;
      const mv = moving.filter((x) => member[x] !== gid);
      if (mv.length === 0 || !items.some((x) => member[x] === gid && !mv.includes(x))) continue;
      for (const x of mv) m[x] = gid;
      out = G.gatherAfterGroup(items, mv, gid, gOf(m));
    } else {
      const gid = member[moving[0]];
      if (!gid) continue;
      const mv = moving.filter((x) => member[x] === gid);
      for (const x of mv) delete m[x];
      out = G.takeBlockOutOfGroup(items, mv, gid, gOf(m));
    }
    cases++;
    const sameItems = out.length === n && [...out].sort().join() === [...items].sort().join();
    if (!sameItems || !G.runsAreSound(out, gOf(m))) bad++;
  }
  check(`property: ${cases} random block moves keep every item and every run whole`, bad === 0 && cases > 1000, { bad, cases });
});

finish();
