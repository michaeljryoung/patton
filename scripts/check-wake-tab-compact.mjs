// Check of the compact wake tab (24 Nov 2026, Michael: "can we set wake so it
// always shrinks unlike other standard tabs ... always just this size even if
// other tabs open"). Drives the REAL TabBar in jsdom, fed tabs through
// update(tabs, groups): a tab whose header says `wake` gets the `wake-compact`
// class, grouped or not, and loses it when wake ends; other tabs and a group's
// chip never get it; `[TAB] wake compact` is logged once per change, never on a
// plain redraw. Also checks `isWakeTab` (what TabManager feeds the strip) and
// the stylesheet rule the class turns on (jsdom does no layout, so the rule's
// text is read: no grow, no shrink, a capped label, padding that never depends
// on the close button). Then drives the REAL TabManager (fake PTYs, wake by an
// OSC title) for what the strip alone can't show: WAKE on an unfocused split
// pane, a custom-titled tab, a restored tab moved first, Reopen Closed Tab of a
// tab that ran wake not coming back compact, and wake ending clearing it.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-wake-tab-compact.mjs
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
const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const bundle = await build({
  stdin: {
    contents: `export { TabBar } from './src/renderer/components/tab-bar';
export { isWakeTab, WAKE_TITLE } from './src/renderer/services/board-wake';`,
    resolveDir: repo, loader: 'ts',
  },
  bundle: true, format: 'iife', globalName: 'TB', platform: 'browser', write: false,
  loader: { '.css': 'empty' }, logLevel: 'silent',
});

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

const dom = new JSDOM('<!doctype html><div id="bar"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const doc = w.document;
const logs = [];
w.patton = {
  titleBarDoubleClick: () => {}, moveWindowBy: () => {}, onUiTextScale: () => () => {},
  log: { send: (lvl, args) => logs.push({ lvl, tag: String(args[0]), data: args[1] }) },
};
w.Element.prototype.scrollIntoView = () => {};
w.eval(bundle.outputFiles[0].text);

const noop = () => {};
const bar = new w.TB.TabBar(doc.getElementById('bar'), {
  onSelect: noop, onClose: noop, onNew: noop, onReorder: noop, onSettings: noop,
  onSetFlag: noop, onRename: noop, onRenameProject: noop,
  onNewGroup: () => 'gnew', onAddToGroup: noop, onRemoveFromGroup: noop, onRenameGroup: noop,
  onToggleGroup: noop, onNewTabInGroup: noop, onUngroup: noop, onCloseGroup: noop,
});

const tabEl = (id) => doc.querySelector(`.tab-bar-tab[data-tab-id="${id}"]`);
const compact = (id) => !!tabEl(id)?.classList.contains('wake-compact');
const wakeLogs = () => logs.filter((l) => l.tag === '[TAB] wake compact');
const plain = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `tab ${i}`, active: i === 0 }));

// --- isWakeTab: what TabManager.updateTabBar sends as `wake` ---
const { isWakeTab, WAKE_TITLE } = w.TB;
check('isWakeTab: a pane titled exactly WAKE', isWakeTab({ panes: [{ title: 'zsh' }, { title: WAKE_TITLE }] }) === true);
check('isWakeTab: no such pane', isWakeTab({ panes: [{ title: 'zsh' }] }) === false);
check('isWakeTab: "WAKE 1" or "wake" is not wake', isWakeTab({ panes: [{ title: 'WAKE 1' }, { title: 'wake' }] }) === false);

// --- ungrouped: a wake tab plus two normal tabs ---
const ungrouped = (wake) => [{ id: 'w', title: 'WAKE', active: false, wake, autoFlag: wake ? 'yellow' : null }, ...plain(2)];
bar.update(ungrouped(true), []);
check('ungrouped wake tab is compact', compact('w'));
check('normal tabs are not compact', !compact('t0') && !compact('t1'));
check('one "on" log line', wakeLogs().length === 1 && wakeLogs()[0].data?.tabId === 'w' && wakeLogs()[0].data?.on === true, wakeLogs());
check('the compact tab keeps its role, aria-label and close button',
  tabEl('w').getAttribute('role') === 'tab' && !!tabEl('w').getAttribute('aria-label') && !!tabEl('w').querySelector('.tab-bar-tab-close'));
bar.update(ungrouped(true), []);
bar.update(ungrouped(true).map((t) => (t.id === 't1' ? { ...t, title: 'renamed' } : t)), []);
check('redraws while compact log nothing more', wakeLogs().length === 1, wakeLogs());

// --- twelve normal tabs: still compact ---
bar.update([{ id: 'w', title: 'WAKE', active: false, wake: true }, ...plain(12)], []);
check('compact with twelve other tabs open', compact('w') && [...Array(12).keys()].every((i) => !compact(`t${i}`)));
check('no log line for more tabs opening', wakeLogs().length === 1, wakeLogs());

// --- wake ends: back to normal sizing, one "off" line ---
bar.update(ungrouped(false), []);
check('wake ended: not compact', !compact('w'));
check('one "off" log line', wakeLogs().length === 2 && wakeLogs()[1].data?.tabId === 'w' && wakeLogs()[1].data?.on === false, wakeLogs());
bar.update(ungrouped(false), []);
check('redraws after wake ended log nothing', wakeLogs().length === 2, wakeLogs());

// --- grouped: the in-group wake tab is compact, the chip unchanged ---
const groupedTabs = (wake) => [
  { id: 'w', title: 'WAKE', active: false, wake, groupId: 'g' },
  { id: 'gm', title: 'mate', active: false, groupId: 'g' },
  ...plain(2),
];
bar.update(groupedTabs(true), [{ id: 'g', name: 'Wake', folded: false }]);
const chipEl = doc.querySelector('.tab-bar-group-chip[data-group-id="g"]');
check('grouped wake tab is compact', compact('w') && tabEl('w').classList.contains('in-group'));
check('its group mate is not compact', !compact('gm'));
check('the group chip is not compact', !!chipEl && !chipEl.classList.contains('wake-compact'));
check('one "on" log line when wake starts in a group', wakeLogs().length === 3 && wakeLogs()[2].data?.on === true, wakeLogs());

// Folded: the tab is off the strip, the chip is drawn as always; unfolding brings it back compact.
bar.update(groupedTabs(true), [{ id: 'g', name: 'Wake', folded: true }]);
check('folded group: wake tab off the strip, chip not compact',
  tabEl('w') === null && !doc.querySelector('.tab-bar-group-chip').classList.contains('wake-compact'));
check('folding logs nothing', wakeLogs().length === 3, wakeLogs());
bar.update(groupedTabs(true), [{ id: 'g', name: 'Wake', folded: false }]);
check('unfolded again: still compact', compact('w'));

bar.update(groupedTabs(false), [{ id: 'g', name: 'Wake', folded: false }]);
check('grouped, wake ended: not compact', !compact('w'));
check('one "off" log line in a group', wakeLogs().length === 4 && wakeLogs()[3].data?.on === false, wakeLogs());

// --- a compact tab that closes just leaves; reopened ids start fresh ---
bar.update(ungrouped(true), []);
bar.update(plain(2), []);
check('closing a compact tab logs no "off" line', wakeLogs().length === 5 && wakeLogs()[4].data?.on === true, wakeLogs());
bar.update(ungrouped(true), []);
check('the same id waking again logs "on" again', wakeLogs().length === 6 && wakeLogs()[5].data?.on === true, wakeLogs());
check('every log line goes through rlog at info', wakeLogs().every((l) => l.lvl === 'info'));

// --- the stylesheet: what the class turns on ---
const css = readFileSync(join(repo, 'src/renderer/styles/tabs.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const ruleBody = (selector) => {
  const at = css.indexOf(`${selector} {`);
  return at === -1 ? null : css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
};
const base = css.indexOf('.tab-bar-tab {');
const own = css.indexOf('.tab-bar-tab.wake-compact {');
check('.wake-compact neither grows nor shrinks (flex: 0 0 auto)', /flex:\s*0 0 auto;/.test(ruleBody('.tab-bar-tab.wake-compact') ?? ''), ruleBody('.tab-bar-tab.wake-compact'));
check('.wake-compact comes after the base tab rule', base !== -1 && own > base);
check('its label is capped at 150px x scale', /max-width:\s*calc\(150px \* var\(--ui-scale\)\)/.test(ruleBody('.tab-bar-tab.wake-compact .tab-bar-tab-title') ?? ''));
// The close button exists only with more than one tab open, so padding that
// waited for it would make a lone wake tab narrower and jump when a second opened.
const ownBody = ruleBody('.tab-bar-tab.wake-compact') ?? '';
check('constant width: padding on both sides, unconditional, room for the close button',
  /padding-left:\s*calc\(14px \+ 8px \* var\(--ui-scale\)\)/.test(ownBody) && /padding-right:\s*calc\(14px \+ 8px \* var\(--ui-scale\)\)/.test(ownBody), ownBody);
check('constant width: no .wake-compact rule depends on :has() or the close button',
  !/wake-compact[^{]*:has\(/.test(css) && !/wake-compact[^{]*tab-bar-tab-close/.test(css));
check('no other rule mentions wake-compact', (css.match(/wake-compact/g) ?? []).length === 2);


// --- the real TabManager: fake PTYs, wake by an OSC title ---
const tmBundle = await build({
  stdin: { contents: `export { TabManager } from './src/renderer/services/tab-manager';`, resolveDir: repo, loader: 'ts' },
  bundle: true, format: 'cjs', platform: 'browser', write: false, loader: { '.css': 'empty' }, logLevel: 'silent',
});
const tmDom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'http://localhost/' });
const g = tmDom.window;
for (const key of Object.getOwnPropertyNames(g)) { if (!(key in globalThis)) { try { globalThis[key] = g[key]; } catch { /* read-only */ } } }
for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent']) { if (!(key in globalThis)) globalThis[key] = g[key].bind(g); }
globalThis.window = g; globalThis.document = g.document;
g.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = g.matchMedia;
class FakeResizeObserver { observe() {} unobserve() {} disconnect() {} }
g.ResizeObserver = globalThis.ResizeObserver = FakeResizeObserver;
g.HTMLCanvasElement.prototype.getContext = () => null;
g.Element.prototype.scrollIntoView ||= () => {};

const st = { session: null, dataListeners: [] };
const loose = new Proxy(function () {}, { get: (_t, prop) => (prop === 'then' ? undefined : loose), apply: () => loose });
let nextPty = 1;
const api = {
  pty: {
    create: async () => nextPty++, respawn: async () => nextPty++, write: () => {}, resize: () => {}, destroy: () => {},
    getCwd: async () => '', getShell: async () => '/bin/zsh',
    onData: (cb) => { st.dataListeners.push(cb); return () => {}; }, onExit: () => () => {},
  },
  settings: { get: async () => ({ startupCommand: '' }), set: async () => {} },
  session: { get: async () => st.session, set: async () => {} },
  projects: { getNames: async () => ({}), onNamesChanged: () => () => {}, resolve: async () => null, setName: async () => {} },
  history: { get: async () => [], add: () => {}, clear: () => {} },
  log: { send: () => {} },
  sessionFeed: { watch: async () => true, unwatch: async () => {}, onEvent: () => () => {} },
};
g.patton = new Proxy(api, { get: (t, prop) => (prop in t ? t[prop] : loose) });
console.info = () => {};
// The renderer's own diagnostics (WebGL missing in jsdom) would drown the verdicts.
for (const level of ['log', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => { if (!String(args[0]).startsWith('[RENDER]')) original(...args); };
}

const tmModule = { exports: {} };
new Function('module', 'exports', tmBundle.outputFiles[0].text)(tmModule, tmModule.exports);
const { TabManager } = tmModule.exports;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 1500) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await tick(10); } return fn(); };
const emit = (ptyId, data) => { for (const cb of st.dataListeners) cb(ptyId, data); };
const tmDoc = globalThis.document;
// Tab ids in strip order, `*` marking a compact one.
const order = (barEl) => [...barEl.querySelectorAll('.tab-bar-tab')].map((e) => e.dataset.tabId + (e.classList.contains('wake-compact') ? '*' : ''));
const setTitle = async (pane, title) => { emit(pane.ptyId, `\x1b]0;${title}\x07`); await until(() => pane.title === title); await tick(10); };
const mkTm = () => {
  const barEl = tmDoc.createElement('div'); const content = tmDoc.createElement('div'); tmDoc.body.append(barEl, content);
  return { barEl, tm: new TabManager(barEl, content) };
};

{ // wake in a created tab, then it ends
  const { barEl, tm } = mkTm();
  const a = await tm.createTab(); await tm.createTab(); const c = await tm.createTab();
  tm.switchToId(a.id); await tick(5);
  await setTitle(c.focusedPane, 'WAKE');
  check('TabManager: wake in the 3rd tab: compact and first', order(barEl)[0] === `${c.id}*` && order(barEl).length === 3, order(barEl));
  await setTitle(c.focusedPane, 'Terminal');
  check('TabManager: wake ending clears the class (the tab stays where it is)', order(barEl)[0] === c.id && !order(barEl).some((x) => x.endsWith('*')), order(barEl));
}

{ // wake ends with no title of its own (a custom Wake command): the prompt mark clears it
  const { barEl, tm } = mkTm();
  await tm.createTab(); const b = await tm.createTab();
  emit(b.focusedPane.ptyId, '\x1b]133;D;0\x07\x1b]133;A\x07'); await tick(10);
  await setTitle(b.focusedPane, 'WAKE');
  check('TabManager: wake by title, no prompt yet: compact', order(barEl)[0] === `${b.id}*`, order(barEl));
  emit(b.focusedPane.ptyId, '\x1b]133;D;130\x07\x1b]133;A\x07');
  await until(() => !order(barEl).some((x) => x.endsWith('*')));
  check('TabManager: wake ended by a prompt mark (no OSC title): not compact, raw title no longer WAKE, no yellow flag',
    !order(barEl).some((x) => x.endsWith('*')) && b.focusedPane.title !== 'WAKE' && !isWakeTab(b) && !b.focusedPane.autoFlagged,
    { order: order(barEl), raw: b.focusedPane.title, flag: b.focusedPane.autoFlagged });
}

{ // WAKE on the unfocused pane of a split tab
  const { barEl, tm } = mkTm();
  await tm.createTab(); const b = await tm.createTab();
  tm.switchToId(b.id); await tick(5);
  await tm.splitVertical(); await tick(30);
  const [first, second] = b.panes;
  check('TabManager: split made the new pane the focused one', b.focusedPane === second);
  await setTitle(first, 'WAKE');
  check('TabManager: WAKE on an unfocused split pane: tab compact and first', order(barEl)[0] === `${b.id}*`, order(barEl));
  await setTitle(first, 'Terminal');
  check('TabManager: wake ending on that pane clears it', !order(barEl).some((x) => x.endsWith('*')), order(barEl));
}

{ // a tab with a typed name
  const { barEl, tm } = mkTm();
  await tm.createTab(); const b = await tm.createTab();
  tm.renameTab(b.id, 'my typed name'); await tick(5);
  await setTitle(b.focusedPane, 'WAKE');
  check('TabManager: custom-titled tab with WAKE: compact and first', order(barEl)[0] === `${b.id}*`, order(barEl));
  await setTitle(b.focusedPane, 'Terminal');
  check('TabManager: custom-titled tab, wake ended: normal', !order(barEl).some((x) => x.endsWith('*')), order(barEl));
}

{ // a tab restored from the saved session
  const { barEl, tm } = mkTm();
  st.session = { tabs: [{ tree: { cwd: '/tmp/a' }, focusedPaneIndex: 0 }, { tree: { cwd: '/tmp/b' }, focusedPaneIndex: 0 }, { tree: { cwd: '/tmp/c' }, focusedPaneIndex: 0 }], activeTabIndex: 0 };
  const ok = await tm.restoreSession(false);
  const tabs = tm.getTabs(); await tick(10);
  const c = tabs[2];
  check('TabManager: session restored three tabs', ok === true && tabs.length === 3);
  await setTitle(c.focusedPane, 'WAKE');
  check('TabManager: restored tab running wake: compact and moved first', order(barEl)[0] === `${c.id}*`, order(barEl));
  st.session = null;
}

{ // Reopen Closed Tab of a tab that ran wake
  const { barEl, tm } = mkTm();
  await tm.createTab(); const b = await tm.createTab(); await tm.createTab();
  await setTitle(b.focusedPane, 'WAKE');
  await tm.closeById(b.id); await tick(10);
  await tm.reopenClosed(); await tick(30);
  const re = tm.getActiveTab();
  check('TabManager: reopened tab is not compact and no pane is titled WAKE',
    !order(barEl).some((x) => x.endsWith('*')) && re.focusedPane.title !== 'WAKE' && re.focusedPane.shownTitle !== 'WAKE',
    { order: order(barEl), raw: re.focusedPane.title, shown: re.focusedPane.shownTitle });
  emit(re.focusedPane.ptyId, '\x1b]133;D;0\x07\x1b]133;A\x07'); await tick(30);
  check('TabManager: still not compact after its first prompt', !order(barEl).some((x) => x.endsWith('*')) && re.focusedPane.title !== 'WAKE', { order: order(barEl), raw: re.focusedPane.title });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
