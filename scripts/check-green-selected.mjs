// Check of the green dot and the red checkpoint circle on the SELECTED tab
// (S66, 25 Nov 2026). A finished Defence turn "didn't flash green" because the
// tab was the selected one, where the dot is skipped by design; Michael agreed
// ("ok") that the selected tab goes green too when Patton isn't the window in
// front (another app, or another Patton window), and that mark clears when its
// window comes back to the front. While its window is in front the selected
// tab stays as before (no mark: he is looking at it). Nothing is retroactive:
// losing focus raises nothing by itself, and a tab that isn't selected is
// unaffected by window focus (it clears only when selected).
// Drives the REAL TabManager, Tab, TabBar and Pane in jsdom; document.hasFocus()
// is switched through the harness's `windowFocus`, the window's own `focus`
// event is dispatched for the return.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-green-selected.mjs
import { checker, setUpTabManager, until, tick } from './tab-manager-harness.mjs';

const { check, section, finish } = checker();
const { w, doc, emit, logs, makeWindow, windowFocus } = await setUpTabManager({ tags: ['DOT', 'CKPT', 'TAB'] });

const root = (state) => `\x1b]7501;state=${state}:app=claude-code\x07`;
const T0 = Math.floor(Date.now() / 1000) + 1000;
const stop = (cpd) => `\x1b]777;patton;stop;tasks=0;crons=0;ctx=50000;since=20000;cpt=${cpd};cpd=${cpd}\x07`;
// The return clears after WINDOW_FOCUS_SETTLE_MS (a notification click focuses, then switches tabs).
const SETTLE = 250;
const focusEvent = () => { windowFocus.inFront = true; w.dispatchEvent(new w.Event('focus')); };
const focusWindow = async () => { focusEvent(); await tick(SETTLE + 60); };
const blurWindow = () => { windowFocus.inFront = false; w.dispatchEvent(new w.Event('blur')); };
const count = (msg, pred = () => true) => logs.filter((l) => l.msg === msg && pred(l.data ?? {})).length;

const endTurns = async (panes) => {
  // Only these panes' signals count: an earlier section's delayed one must not end the wait early.
  const ids = new Set(panes.map((p) => p.id));
  const mine = () => count('[DOT] Needs-you signal', (d) => ids.has(d.pane));
  const n = mine();
  for (const p of panes) { emit(p.ptyId, root('working')); emit(p.ptyId, root('done')); }
  await until(() => mine() >= n + panes.length, 8000);
  await tick(20);
};

function view(tm) {
  const el = (tab) => tm.bar.querySelector(`.tab-bar-tab[data-tab-id="${tab.id}"]`);
  const marks = (tab) => [...el(tab).querySelectorAll('.tab-bar-tab-indicator')].map((d) => d.className.replace('tab-bar-tab-indicator', '').trim() || 'needs-you');
  // A turn that ends: working, then done; waits for the Needs-you signal (after the stop settles).
  const turnEnds = async (tab) => {
    for (const p of tab.panes) p.lastCommandDoneMs = 0; // the per-pane 5 s debounce
    await endTurns(tab.panes);
  };
  return { el, marks, turnEnds };
}

// ── The green dot ──
await section(async () => {
  const tm = await makeWindow(['A', 'B']);
  const [tabA, tabB] = tm.getTabs(); // B is selected
  const { marks, turnEnds, el } = view(tm);
  let redraws = 0;
  const realUpdate = tm.tabBar.update.bind(tm.tabBar);
  tm.tabBar.update = (...a) => { redraws++; return realUpdate(...a); };

  // 1. Window in front: the selected tab is skipped, as before.
  windowFocus.inFront = true;
  await turnEnds(tabB);
  check('front: selected tab raises no green', tabB.awaitingInput === false && marks(tabB).length === 0, marks(tabB));
  check('front: logged as skipped, selected tab, window focused', count('[DOT] green skipped', (d) => d.tabId === tabB.id && d.why === 'selected tab' && d.windowFocused === true) >= 1, logs.filter((l) => l.msg.startsWith('[DOT]')).map((l) => [l.msg, l.data]));
  // 5. Nothing retroactive: losing focus raises nothing by itself.
  const raisedBefore = count('[DOT] green raised');
  blurWindow();
  await tick(150);
  check('blur alone raises nothing', tabB.awaitingInput === false && count('[DOT] green raised') === raisedBefore);
  await focusWindow();
  check('focus with nothing up logs no clear', count('[DOT] green cleared', (d) => d.why === 'window focused') === 0);

  // 2. Window behind: the selected tab goes green.
  blurWindow();
  await turnEnds(tabB);
  check('behind: selected tab raises green', tabB.awaitingInput === true);
  check('behind: the strip draws the needs-you dot on the selected tab', marks(tabB).join() === 'needs-you' && /waiting for you/.test(el(tabB).getAttribute('aria-label') ?? ''), [marks(tabB), el(tabB).getAttribute('aria-label')]);
  check('behind: raise log says selectedTab:true, windowFocused:false', count('[DOT] green raised', (d) => d.tabId === tabB.id && d.selectedTab === true && d.windowFocused === false) === 1);

  // 3. Window returns: cleared, logged, drawn.
  const r0 = redraws;
  await focusWindow();
  check('focus: the selected tab\'s green clears', tabB.awaitingInput === false);
  check('focus: logged [DOT] green cleared why "window focused"', count('[DOT] green cleared', (d) => d.tabId === tabB.id && d.why === 'window focused') === 1);
  check('focus: the strip redraws and the dot is gone', redraws > r0 && marks(tabB).length === 0, [redraws - r0, marks(tabB)]);
  await focusWindow();
  check('a second focus logs nothing more', count('[DOT] green cleared', (d) => d.why === 'window focused') === 1);

  // 4. A tab that isn't selected: raised as ever, untouched by window focus, cleared by selecting it.
  blurWindow();
  await turnEnds(tabA);
  check('not selected: raised (selectedTab false)', tabA.awaitingInput === true && count('[DOT] green raised', (d) => d.tabId === tabA.id && d.selectedTab === false) === 1);
  await focusWindow();
  check('not selected: window focus leaves it up', tabA.awaitingInput === true && marks(tabA).join() === 'needs-you');
  tm.switchToId(tabA.id);
  check('not selected: selecting it clears it with why "selected"', tabA.awaitingInput === false && count('[DOT] green cleared', (d) => d.tabId === tabA.id && d.why === 'selected') === 1);

  // Split pane: both waiting panes of the selected tab clear on focus.
  await tabA.splitVertical();
  await until(() => tabA.panes.length === 2 && tabA.panes.every((p) => p.ptyId !== null));
  blurWindow();
  for (const p of tabA.panes) p.lastCommandDoneMs = 0;
  await endTurns(tabA.panes);
  check('split: both panes of the selected tab wait while behind', tabA.panes.every((p) => tabA.awaitingSince(p) !== null), tabA.panes.map((p) => tabA.awaitingSince(p)));
  await focusWindow();
  check('split: window focus clears both', tabA.awaitingInput === false && count('[DOT] green cleared', (d) => d.tabId === tabA.id && d.why === 'window focused') === 2);
});

// ── The red checkpoint circle ──
await section(async () => {
  const tm = await makeWindow(['A', 'B']);
  const [tabA, tabB] = tm.getTabs(); // B selected
  const { marks } = view(tm);
  const pA = tabA.panes[0];
  const pB = tabB.panes[0];
  // The terminal parses writes asynchronously: a turn, then the Stop's reading, awaited via its [CKPT] ctx line.
  const finishes = async (t, cpd) => {
    const n = count('[CKPT] ctx');
    emit(t.ptyId, root('working'));
    emit(t.ptyId, root('done'));
    emit(t.ptyId, stop(cpd));
    await until(() => count('[CKPT] ctx') > n, 3000);
    await tick(20);
  };
  const clearedLogs = (pane, reason) => count('[CKPT] finished mark cleared', (d) => d.pane === pane.id && d.reason === reason);

  // Window in front: never kept on the selected tab, as before.
  windowFocus.inFront = true;
  await finishes(tabB, T0 + 1);
  check('ckpt front: no mark kept on the selected tab', pB.checkpointDone === false && !tabB.checkpointDone && marks(tabB).join() !== 'checkpoint-done');
  check('ckpt front: cleared with reason "active tab"', clearedLogs(pB, 'active tab') === 1);

  // Window behind: raised and kept.
  blurWindow();
  await finishes(tabB, T0 + 2);
  check('ckpt behind: the selected tab keeps the mark', pB.checkpointDone === true && tabB.checkpointDone === true);
  check('ckpt behind: the strip draws the red circle on the selected tab', marks(tabB).join() === 'checkpoint-done', marks(tabB));
  // Return: cleared with the new reason, drawn, and seen (not raised again by the same cpd).
  await focusWindow();
  check('ckpt focus: cleared', pB.checkpointDone === false && tabB.checkpointDone === false);
  check('ckpt focus: logged reason "window focused"', clearedLogs(pB, 'window focused') === 1);
  check('ckpt focus: the strip drops the circle', !marks(tabB).includes('checkpoint-done'), marks(tabB));
  blurWindow();
  await finishes(tabB, T0 + 2);
  check('ckpt focus: the same cpd seen on return does not raise again', pB.checkpointDone === false);
  await finishes(tabB, T0 + 3);
  check('ckpt: a newer cpd raises it again while behind', pB.checkpointDone === true);
  await focusWindow();

  // A tab that isn't selected: untouched by window focus; selecting it clears it.
  blurWindow();
  await finishes(tabA, T0 + 4);
  check('ckpt not selected: raised', pA.checkpointDone === true);
  await focusWindow();
  check('ckpt not selected: window focus leaves it', pA.checkpointDone === true && marks(tabA).includes('checkpoint-done'));
  tm.switchToId(tabA.id);
  check('ckpt not selected: selecting clears it ("selected")', pA.checkpointDone === false && clearedLogs(pA, 'selected') === 1);

  // Nothing retroactive: a mark made in front, then focus lost, is not raised.
  windowFocus.inFront = true;
  await finishes(tabA, T0 + 5);
  blurWindow();
  await tick(100);
  check('ckpt: losing focus raises nothing by itself', pA.checkpointDone === false);
  await focusWindow();
});

// ── Review findings (S66): stale marks, selecting while behind, the notification click, sessions, closing, two windows ──
await section(async () => {
  const tm = await makeWindow(['A', 'B', 'C']);
  const [tabA, tabB, tabC] = tm.getTabs(); // C selected
  const { marks, turnEnds } = view(tm);
  const clearedWhy = (tab, why) => count('[DOT] green cleared', (d) => d.tabId === tab.id && d.why === why);

  // 1. A missed `focus` event: the window is in front but the selected tab still holds an entry
  // (another pane's: a pane's own new turn would clear its entry as "work started").
  await tabC.splitVertical();
  await until(() => tabC.panes.length === 2 && tabC.panes.every((p) => p.ptyId !== null));
  const [pC1, pC2] = tabC.panes;
  blurWindow();
  await endTurns([pC1]);
  check('stale: raised while behind', tabC.awaitingSince(pC1) !== null);
  windowFocus.inFront = true; // no focus event delivered
  pC2.lastCommandDoneMs = 0;
  await endTurns([pC2]);
  check('stale: the next raise on the selected tab of a front window drops the stale entry', tabC.awaitingInput === false && marks(tabC).length === 0, marks(tabC));
  check('stale: logged as a clear, why "selected tab in front"', clearedWhy(tabC, 'selected tab in front') === 1);
  // ...and a key press or click proves the window is in front, without any raise.
  blurWindow();
  await turnEnds(tabC);
  windowFocus.inFront = true;
  const c1 = clearedWhy(tabC, 'selected tab in front');
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  check('stale: a key press in a front window clears the selected tab (both panes)', tabC.awaitingInput === false && clearedWhy(tabC, 'selected tab in front') === c1 + 2, clearedWhy(tabC, 'selected tab in front') - c1);
  blurWindow();
  await turnEnds(tabC);
  windowFocus.inFront = true;
  const c2 = clearedWhy(tabC, 'selected tab in front');
  doc.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true }));
  check('stale: a click in a front window clears the selected tab (both panes)', tabC.awaitingInput === false && clearedWhy(tabC, 'selected tab in front') === c2 + 2);
  // Input while the window is behind (hasFocus false) clears nothing.
  blurWindow();
  await turnEnds(tabC);
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  check('stale: input while the window is behind clears nothing', tabC.awaitingInput === true);
  await focusWindow();

  // 2. A tab selected while the window is behind keeps its marks until the window returns.
  blurWindow();
  await turnEnds(tabA);
  tm.switchToId(tabA.id);
  check('select behind: the newly selected tab keeps its green', tabA.awaitingInput === true && marks(tabA).join() === 'needs-you', marks(tabA));
  check('select behind: no "selected" clear logged', clearedWhy(tabA, 'selected') === 0);
  await focusWindow();
  check('select behind: the window\'s return clears it', tabA.awaitingInput === false && clearedWhy(tabA, 'window focused') === 1);

  // 3. A notification click: focus first, then the tab switch. The old selected tab keeps its marks.
  blurWindow();
  await turnEnds(tabA); // A selected, green
  await turnEnds(tabB); // B not selected, green
  focusEvent();
  await tick(60); // inside the settle wait
  tm.switchToId(tabB.id);
  await tick(SETTLE + 60);
  check('click: the tab he lands on is cleared', tabB.awaitingInput === false && clearedWhy(tabB, 'selected') === 1);
  check('click: the tab he left keeps its green (never seen)', tabA.awaitingInput === true && marks(tabA).join() === 'needs-you', marks(tabA));
  tm.switchToId(tabA.id);
  check('click: selecting it later clears it', tabA.awaitingInput === false);

  // A blur inside the settle wait cancels the clear.
  blurWindow();
  await turnEnds(tabA);
  focusEvent();
  await tick(60);
  blurWindow();
  await tick(SETTLE + 60);
  check('blur inside the settle wait: nothing cleared', tabA.awaitingInput === true);
  await focusWindow();
  check('then a real return clears', tabA.awaitingInput === false);

  // The blur event itself cancels the pending clear, and so does a window found behind when it fires.
  blurWindow();
  await turnEnds(tabA);
  focusEvent();
  await tick(60);
  w.dispatchEvent(new w.Event('blur')); // blur event, then back in front with no new focus event
  windowFocus.inFront = true;
  await tick(SETTLE + 60);
  check('blur event inside the settle wait cancels the clear', tabA.awaitingInput === true);
  focusEvent();
  await tick(60);
  windowFocus.inFront = false; // behind again, no blur event delivered
  await tick(SETTLE + 60);
  check('a window found behind when the settle wait ends clears nothing', tabA.awaitingInput === true);
  await focusWindow();
  check('and the next real return clears', tabA.awaitingInput === false);

  // Session counts follow the marks.
  const waiting = () => tm.listSessions().filter((s) => s.awaitingSince !== null).map((s) => s.tabId);
  blurWindow();
  await turnEnds(tabA);
  await turnEnds(tabB);
  const sA = tm.listSessions().find((s) => s.tabId === tabA.id);
  check('sessions: the selected tab\'s pane counts as waiting, with the dot\'s time', sA.awaitingSince === tabA.awaitingSince(tabA.panes[0]) && waiting().includes(tabA.id) && waiting().includes(tabB.id), waiting());
  await focusWindow();
  check('sessions: the return drops the selected tab\'s dot time, the other keeps its own', tabA.awaitingSince(tabA.panes[0]) === null && tabB.awaitingInput === true, [tabA.awaitingSince(tabA.panes[0])]);

  // Closing a marked selected tab (window behind): its marks go with it; the neighbour that is selected keeps its own.
  blurWindow();
  await turnEnds(tabA);
  await turnEnds(tabB);
  const countBefore = tm.getTabs().length;
  await tm.closeActiveTab();
  await tick(50);
  const left = tm.getTabs();
  check('close: the marked tab is gone, the strip has no entry for it', left.length === countBefore - 1 && !tm.bar.querySelector(`.tab-bar-tab[data-tab-id="${tabA.id}"]`), left.map((t) => t.title));
  check('close: no session of it remains', !tm.listSessions().some((s) => s.tabId === tabA.id));
  const sel = tm.getActiveTab();
  check('close: the neighbour that becomes selected while behind keeps its own mark', sel.awaitingInput === true && marks(sel).join() === 'needs-you', [sel.title, marks(sel)]);
  await focusWindow();
  check('close: its return clears the new selected tab', sel.awaitingInput === false);
});

// Two windows: each window's own selected tab. (One jsdom shares one `focus` event, so a window's
// return is delivered to its tabs directly.)
await section(async () => {
  const tm1 = await makeWindow(['A1', 'B1']);
  const tm2 = await makeWindow(['A2', 'B2']);
  const s1 = tm1.getActiveTab();
  const s2 = tm2.getActiveTab();
  const u2 = tm2.getTabs()[0];
  blurWindow();
  await endTurns(s1.panes);
  await endTurns(s2.panes);
  for (const p of u2.panes) p.lastCommandDoneMs = 0;
  await endTurns(u2.panes);
  check('two windows: both selected tabs and the unselected one wait', s1.awaitingInput && s2.awaitingInput && u2.awaitingInput);
  windowFocus.inFront = true;
  s1.windowFocused(); // window 1 comes to the front
  check('two windows: window 1\'s return clears only its own selected tab', !s1.awaitingInput && s2.awaitingInput && u2.awaitingInput);
  s2.windowFocused();
  check('two windows: window 2\'s return clears its selected tab, not its other tab', !s2.awaitingInput && u2.awaitingInput);
  u2.windowFocused();
  check('windowFocused on a tab that isn\'t selected is a no-op', u2.awaitingInput === true);
});

// The red circle: selecting while behind, and the stale-front case.
await section(async () => {
  const tm = await makeWindow(['A', 'B']);
  const [tabA] = tm.getTabs();
  const { marks } = view(tm);
  const pA = tabA.panes[0];
  const finishes = async (t, cpd) => {
    const n = count('[CKPT] ctx');
    emit(t.ptyId, root('working'));
    emit(t.ptyId, root('done'));
    emit(t.ptyId, stop(cpd));
    await until(() => count('[CKPT] ctx') > n, 3000);
    await tick(20);
  };
  blurWindow();
  await finishes(tabA, T0 + 20);
  check('ckpt select behind: raised on the unselected tab', pA.checkpointDone === true);
  tm.switchToId(tabA.id);
  check('ckpt select behind: kept on selecting it', pA.checkpointDone === true && marks(tabA).includes('checkpoint-done'), marks(tabA));
  await focusWindow();
  check('ckpt select behind: cleared on the window\'s return', pA.checkpointDone === false);
  // A green entry left stale on a front window's selected tab (another pane's, since a pane's own turn clears its entry)
  // goes when a checkpoint mark arrives there.
  await tabA.splitVertical();
  await until(() => tabA.panes.length === 2 && tabA.panes.every((p) => p.ptyId !== null));
  const [p1, p2] = tabA.panes;
  blurWindow();
  await endTurns([p1]);
  check('ckpt stale: green held by one pane while behind', tabA.awaitingSince(p1) !== null);
  windowFocus.inFront = true; // missed focus
  await finishes(p2, T0 + 21);
  check('ckpt stale: a checkpoint mark on a front window\'s selected tab drops the stale green too', tabA.awaitingInput === false && p2.checkpointDone === false && marks(tabA).length === 0, marks(tabA));
  await focusWindow();
});

finish();
