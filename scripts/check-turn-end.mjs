// Checks how a Claude Code turn ends when OSC 7501 and the Stop hook both speak:
// src/renderer/services/turn-end.ts (pure rules), and the real Pane driven
// through them (jsdom, terminal and editor stubbed).
// Run: JSDOM_DIR=<folder whose node_modules has jsdom >= 30> node scripts/check-turn-end.mjs
// Without JSDOM_DIR only the pure rules run (the Pane part is reported as skipped).
import { build } from 'esbuild';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'turn-end-'));
let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

// ── Part 1: the pure rules ──
await build({
  entryPoints: [join(repo, 'src/renderer/services/turn-end.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: join(out, 'turn-end.mjs'), logLevel: 'silent',
});
await build({
  entryPoints: [join(repo, 'src/renderer/services/program-status.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: join(out, 'program-status.mjs'), logLevel: 'silent',
});
const te = await import(pathToFileURL(join(out, 'turn-end.mjs')).href);
const ps = await import(pathToFileURL(join(out, 'program-status.mjs')).href);

const TTL = 40_000;
const rec = (state, extra = {}) => ({ state, kind: null, progress: null, app: 'claude-code', title: null, msg: null, ...extra });
const records = (root, children = {}) => {
  const r = new ps.ProgramStatusRecords();
  r.set('', rec(root.state, root));
  for (const [id, c] of Object.entries(children)) r.set(id, rec(c.state, c));
  return r;
};
const decide = (recs, verdict, doneAt = 1000) =>
  te.turnEndSignal(ps.programSignal(recs), verdict, doneAt, TTL);
const V = (tasks, crons, atMs = 1000) => ({ tasks, crons, atMs });

let d = decide(records({ state: 'done' }), V(2, 0));
check('hook tasks=2, root done, no children -> parked with 2 tasks', d.signal.kind === 'parked' && d.signal.tasks === 2 && d.signal.crons === 0 && d.signal.titles.length === 0 && d.viaHook, d);
d = decide(records({ state: 'done' }), V(0, 0));
check('hook tasks=0 -> needs-you', d.signal.kind === 'needs-you' && !d.viaHook, d);
d = decide(records({ state: 'done' }), null);
check('no verdict -> needs-you', d.signal.kind === 'needs-you', d);
d = decide(records({ state: 'done' }), V(0, 1));
check('crons only -> parked (unchanged)', d.signal.kind === 'parked' && d.signal.tasks === 0 && d.signal.crons === 1, d);
d = decide(records({ state: 'done' }, { t1: { state: 'working', title: 'sleep 90' } }), V(2, 0));
check('working 7501 child -> parked by 7501 (titles win)', d.signal.kind === 'parked' && d.signal.titles[0] === 'sleep 90' && !d.viaHook, d);
d = decide(records({ state: 'blocked', kind: 'permission' }), V(2, 0));
check('blocked root with hook tasks -> still needs-you', d.signal.kind === 'needs-you' && !d.viaHook, d);
d = decide(records({ state: 'error' }), V(2, 0));
check('error with hook tasks -> still needs-you', d.signal.kind === 'needs-you' && !d.viaHook, d);
d = decide(records({ state: 'done' }, { t1: { state: 'blocked' } }), V(2, 0));
check('blocked child with hook tasks -> still needs-you', d.signal.kind === 'needs-you' && !d.viaHook, d);
d = decide(records({ state: 'done' }), V(2, 0, 1000 + TTL + 1));
check('verdict after TTL (late) -> needs-you', d.signal.kind === 'needs-you', d);
d = decide(records({ state: 'done' }), V(2, 0, 1000 - TTL - 1));
check('verdict before TTL (early) -> needs-you', d.signal.kind === 'needs-you', d);
d = decide(records({ state: 'done' }), V(2, 0, 1000 + TTL));
check('verdict exactly at TTL -> parked', d.signal.kind === 'parked', d);
d = te.turnEndSignal(ps.programSignal(records({ state: 'done' })), V(2, 0), null, TTL);
check('no done time yet -> unchanged', d.signal.kind === 'needs-you', d);
d = decide(records({ state: 'done' }), V(2, 0, 1000 + 20_000));
check('hook arriving after the done (20 s) -> parked', d.signal.kind === 'parked', d);

const clr = (v, a, b) => te.verdictAfterRootChange(v, a, b);
check('done -> working clears the verdict', clr(V(2, 0), 'done', 'working').cleared && clr(V(2, 0), 'done', 'working').verdict === null);
check('idle -> working clears', clr(V(2, 0), 'idle', 'working').verdict === null);
check('null -> working clears', clr(V(2, 0), null, 'working').verdict === null);
check('error -> working clears', clr(V(2, 0), 'error', 'working').verdict === null);
check('working -> working keeps (hook speaks mid-turn)', clr(V(2, 0), 'working', 'working').verdict !== null);
check('working -> done keeps', clr(V(2, 0), 'working', 'done').verdict !== null);
check('no verdict: nothing cleared', clr(null, 'done', 'working').cleared === false);

const drn = (v, root, a, b) => te.verdictAfterChildren(v, root, a, b);
check('drain: done root, working children 1 -> 0 drops the verdict', drn(V(1, 0), 'done', 1, 0).cleared && drn(V(1, 0), 'done', 1, 0).verdict === null);
check('drain: children 2 -> 1 keeps', drn(V(1, 0), 'done', 2, 1).verdict !== null);
check('drain: 0 -> 0 keeps (hook-only task, no child records)', drn(V(2, 0), 'done', 0, 0).verdict !== null);
check('drain: 0 -> 1 keeps', drn(V(2, 0), 'done', 0, 1).verdict !== null);
check('drain: root working keeps (hook speaks mid-turn)', drn(V(1, 0), 'working', 1, 0).verdict !== null);
check('drain: no verdict -> nothing cleared', drn(null, 'done', 1, 0).cleared === false);

// Ended turn over a working root (Claude Code 2.1.321 keeps the root working while a subagent runs)
check('ended: stop over working root with a working child marks the turn ended', te.turnEndedOverWork?.('working', 1) === true);
check('ended: stop over working root with no working child does not', te.turnEndedOverWork?.('working', 0) === false);
check('ended: stop over a done root does not (the done path decides)', te.turnEndedOverWork?.('done', 1) === false);
const aft = (...a) => te.turnEndedAfterChange?.(...a);
check('ended: same working root, same children keeps the mark', aft(true, 'working', 'working', 1, 1) === true);
check('ended: working child finished (1 -> 0) ends the mark', aft(true, 'working', 'working', 1, 0) === false);
check('ended: working child added (1 -> 2) ends the mark', aft(true, 'working', 'working', 1, 2) === false);
check('ended: root done ends the mark', aft(true, 'working', 'done', 1, 1) === false);
check('ended: root blocked ends the mark', aft(true, 'working', 'blocked', 1, 1) === false);
check('ended: no mark stays none', aft(false, 'working', 'working', 1, 1) === false);
const es = (sig, ended, v, titles) => te.endedTurnSignal?.(sig, ended, v, titles);
let e = es({ kind: 'working' }, true, V(1, 0), ['agent']);
check('ended: working + mark -> parked, tasks 1, the child title', e?.signal.kind === 'parked' && e.signal.tasks === 1 && e.signal.titles[0] === 'agent' && e.viaStop, e);
e = es({ kind: 'working' }, true, V(3, 1), ['agent']);
check('ended: work is the larger of hook tasks (3) and children (1); crons kept', e?.signal.tasks === 3 && e.signal.crons === 1, e);
e = es({ kind: 'working' }, true, V(0, 0), ['a', 'b']);
check('ended: children (2) outnumber hook tasks (0)', e?.signal.tasks === 2, e);
e = es({ kind: 'working' }, false, V(1, 0), ['agent']);
check('ended: no mark -> working unchanged', e?.signal.kind === 'working' && !e.viaStop, e);
e = es({ kind: 'needs-you', key: 'root:blocked:permission', reason: 'x' }, true, V(1, 0), ['agent']);
check('ended: a needs-you passes through', e?.signal.kind === 'needs-you', e);

// ── Part 2: the real Pane ──
const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.log('skip Pane-level checks: set JSDOM_DIR to a folder whose node_modules has jsdom >= 30');
} else {
  await paneChecks();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

async function paneChecks() {
  const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
  // The terminal, editor and overlays are stubs: any property, call or `new` gives another stub.
  const stubSource = `
    const mk = () => new Proxy(function () {}, {
      get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()),
      apply: () => mk(), construct: () => mk(),
    });
    export const TerminalView = mk(), EditorInput = mk(), SearchOverlay = mk(), HistorySearch = mk(),
      PasteDialog = mk(), ContextMenu = mk(), DEFAULT_COMPOSE_PLACEHOLDER = '';`;
  const stubs = {
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /\/(terminal-view|editor-input|search-overlay|history-search|paste-dialog|context-menu)$/ },
        (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stubSource, loader: 'js' }));
    },
  };
  await build({
    entryPoints: [join(repo, 'src/renderer/components/pane.ts')],
    bundle: true, format: 'cjs', platform: 'node', outfile: join(out, 'pane.cjs'),
    loader: { '.css': 'empty' }, plugins: [stubs], logLevel: 'silent',
  });

  const dom = new JSDOM('<!doctype html><body></body>');
  const deep = () => new Proxy(function () {}, { get: () => deep(), apply: () => deep() });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  dom.window.patton = { log: { send() {} }, pty: deep(), clipboard: deep() };

  // A manual clock: timers and Date.now move only when the check says so.
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const realDateNow = Date.now;
  Date.now = () => now;
  globalThis.setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.setInterval = () => ++seq;
  globalThis.clearInterval = () => {};
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (next === null || t.at < timers.get(next).at)) next = id;
      if (next === null) break;
      const t = timers.get(next);
      timers.delete(next);
      now = Math.max(now, t.at);
      t.fn();
    }
    now = end;
  };

  const logs = [];
  console.info = (...a) => { logs.push(a); };
  const { Pane } = await import(pathToFileURL(join(out, 'pane.cjs')).href);

  const newPane = () => {
    const ev = { alerts: 0, parked: [], status: 0 };
    const pane = new Pane({
      onFocus() {}, onTitleChange() {},
      onCommandDone: () => { ev.alerts++; },
      onParked: (_p, info) => { ev.parked.push(info); },
      onStatusChange: () => { ev.status++; },
    });
    const drive = {
      root: (state, extra = {}) => pane.handleProgramStatus({ type: 'report', id: '', record: rec(state, extra) }),
      child: (id, state, extra = {}) => pane.handleProgramStatus({ type: 'report', id, record: rec(state, extra) }),
      hook: (tasks, crons) => pane.handleHookStop(tasks, crons),
    };
    return { pane, ev, ...drive };
  };
  const parkedLogs = () => logs.filter((l) => l[0] === '[DOT] Parked').map((l) => l[1]);
  const lastParked = (ev) => ev.parked[ev.parked.length - 1] ?? null;

  // A: hook says 2 tasks, 7501 done with no children -> the ring, never the dot
  {
    logs.length = 0;
    const t = newPane();
    t.root('working'); advance(5000);
    t.hook(2, 0); advance(8000);
    t.root('done'); advance(1500 + 10_000);
    check('pane: hook 2 tasks then done -> no alert', t.ev.alerts === 0, t.ev.alerts);
    check('pane: parked with 2 tasks, no titles', lastParked(t.ev)?.tasks === 2 && (lastParked(t.ev).titles ?? []).length === 0, lastParked(t.ev));
    check('pane: activity is parked (dot, tooltip, card, palette read this)', t.pane.claudeState.activity === 'parked' && t.pane.claudeState.parked?.tasks === 2, t.pane.claudeState.activity);
    const pl = parkedLogs();
    check('pane: one [DOT] Parked line, source hook-tasks, tasks and crons', pl.length === 1 && pl[0].source === 'hook-tasks' && pl[0].tasks === 2 && pl[0].crons === 0, pl);
  }
  // B: hook says 0 -> alerts once
  {
    const t = newPane();
    t.root('working'); advance(2000); t.hook(0, 0); advance(2000);
    t.root('done'); advance(1500 + 100);
    check('pane: hook 0 tasks then done -> one alert, not parked', t.ev.alerts === 1 && t.pane.claudeState.parked === null, [t.ev.alerts, t.pane.claudeState.parked]);
  }
  // C: crons only -> ring, as before
  {
    logs.length = 0;
    const t = newPane();
    t.root('working'); advance(2000); t.hook(0, 1); advance(2000);
    t.root('done'); advance(5000);
    check('pane: crons only -> no alert, parked 0 tasks 1 cron', t.ev.alerts === 0 && lastParked(t.ev)?.crons === 1 && lastParked(t.ev)?.tasks === 0, [t.ev.alerts, lastParked(t.ev)]);
    check('pane: crons-only park logs source hook-crons', parkedLogs()[0]?.source === 'hook-crons', parkedLogs());
  }
  // D: a working 7501 child parks with its titles
  {
    const t = newPane();
    t.root('working'); t.hook(2, 0); advance(1000);
    t.child('t1', 'working', { title: 'sleep 90' }); t.root('done'); advance(10_000);
    check('pane: working child parks with its title, no alert', t.ev.alerts === 0 && lastParked(t.ev)?.titles?.[0] === 'sleep 90', [t.ev.alerts, lastParked(t.ev)]);
  }
  // E: blocked root / error / blocked child alert at once despite hook tasks
  for (const [name, setup] of [
    ['blocked root', (t) => t.root('blocked', { kind: 'permission' })],
    ['error', (t) => t.root('error')],
    ['blocked child', (t) => { t.child('t1', 'blocked', { title: 'ask' }); t.root('done'); }],
  ]) {
    const t = newPane();
    t.root('working'); advance(1000); t.hook(2, 0); advance(1000);
    setup(t); advance(1500 + 100);
    check(`pane: ${name} with hook tasks -> alerts, not parked`, t.ev.alerts === 1 && t.pane.claudeState.parked === null, [t.ev.alerts, t.pane.claudeState.parked]);
  }
  // F: a verdict outside the TTL does not park
  {
    const t = newPane();
    t.root('working'); t.hook(2, 0); advance(41_000);
    t.root('done'); advance(1600);
    check('pane: verdict 41 s before the done -> alert', t.ev.alerts === 1 && t.pane.claudeState.parked === null, [t.ev.alerts, t.pane.claudeState.parked]);
  }
  // G: previous turn's verdict must not park the next turn (done -> working -> done, no new hook)
  {
    logs.length = 0;
    const t = newPane();
    t.root('working'); advance(1000); t.hook(2, 0); advance(1000);
    t.root('done'); advance(5000);
    check('pane: turn 1 parked', t.ev.alerts === 0 && lastParked(t.ev)?.tasks === 2);
    advance(10_000);
    t.root('working'); advance(3000); // new turn, interrupted or hook-less
    check('pane: new turn clears the ring', t.pane.claudeState.parked === null);
    check('pane: clearing logs one line', logs.filter((l) => l[0] === '[DOT] Hook verdict cleared: new turn').length === 1, logs.map((l) => l[0]));
    t.root('done'); advance(1600);
    check('pane: turn 2 without a hook verdict -> alert', t.ev.alerts === 1 && t.pane.claudeState.parked === null, [t.ev.alerts, t.pane.claudeState.parked]);
  }
  // G2: a repeated working report keeps the verdict the hook stored mid-turn
  {
    const t = newPane();
    t.root('working'); advance(500); t.hook(2, 0); t.root('working', { msg: 'x' }); advance(500);
    t.root('done'); advance(5000);
    check('pane: repeated working report keeps this turn\'s verdict', t.ev.alerts === 0 && lastParked(t.ev)?.tasks === 2, [t.ev.alerts, lastParked(t.ev)]);
  }
  // H: the hook arrives after the done
  {
    // while the needs-you is still settling: no alert at all
    logs.length = 0;
    const t = newPane();
    t.root('working'); advance(1000); t.root('done'); advance(600);
    t.hook(2, 0); advance(10_000);
    check('pane: hook during the settle -> no alert, parked', t.ev.alerts === 0 && lastParked(t.ev)?.tasks === 2, [t.ev.alerts, lastParked(t.ev)]);
    check('pane: that park is logged hook-tasks', parkedLogs().some((p) => p.source === 'hook-tasks'), parkedLogs());
    // after the dot was raised: the alert already happened; the ring replaces it, no second alert
    const u = newPane();
    u.root('working'); advance(1000); u.root('done'); advance(1600);
    check('pane: dot raised first', u.ev.alerts === 1, u.ev.alerts);
    u.hook(2, 0); advance(1000);
    check('pane: late hook turns a raised needs-you into the ring', lastParked(u.ev)?.tasks === 2 && u.pane.claudeState.activity === 'parked' && u.pane.claudeState.needsYouText === null, [lastParked(u.ev), u.pane.claudeState.activity, u.pane.claudeState.needsYouText]);
    advance(20_000); u.root('done', { msg: 'again' }); advance(10_000);
    check('pane: no second alert after the ring', u.ev.alerts === 1, u.ev.alerts);
  }
  // I: the ring is left when the work comes back and the next turn alerts normally
  {
    const t = newPane();
    t.root('working'); advance(500); t.hook(2, 0); t.root('done'); advance(5000);
    t.root('working'); advance(2000); t.hook(0, 0); advance(500); t.root('done'); advance(1700);
    check('pane: after the ring, a clean turn alerts', t.ev.alerts === 1 && t.pane.claudeState.parked === null, [t.ev.alerts, t.pane.claudeState.parked]);
  }
  // J: DRAIN. A working 7501 child parks the done root; the hook said 1 task. The child finishes and
  // Claude stays silent: the old verdict must not re-park, the drain alerts once (S40).
  for (const [name, waitMs] of [['30 s', 30_000], ['10 min', 10 * 60_000]]) {
    logs.length = 0;
    const t = newPane();
    t.root('working'); advance(1000); t.child('t1', 'working', { title: 'sleep 90' }); t.hook(1, 0); advance(500);
    t.root('done'); advance(waitMs);
    check(`pane: drain ${name}: child working at the done -> parked by 7501, no alert`, t.ev.alerts === 0 && lastParked(t.ev)?.titles?.[0] === 'sleep 90', [t.ev.alerts, lastParked(t.ev)]);
    t.pane.handleProgramStatus({ type: 'clear', id: 't1' }); advance(30_000);
    check(`pane: drain ${name}: child gone, Claude silent -> one alert, not parked`, t.ev.alerts === 1 && t.pane.claudeState.parked === null, [t.ev.alerts, t.pane.claudeState.parked]);
    check(`pane: drain ${name}: the dropped verdict is logged`, logs.filter((l) => l[0] === '[DOT] Hook verdict cleared: working children finished').length === 1, logs.map((l) => l[0]));
    t.root('working'); advance(1000); t.root('done'); advance(1700);
    check(`pane: drain ${name}: the next hook-less turn alerts again`, t.ev.alerts === 2, t.ev.alerts);
  }
  // J2: a child finishing as 'done' (record kept) drains the same way
  {
    const t = newPane();
    t.root('working'); advance(1000); t.child('t1', 'working', { title: 'job' }); t.hook(1, 0); advance(500);
    t.root('done'); advance(5000);
    t.child('t1', 'done', { title: 'job' }); advance(30_000);
    check('pane: drain via child done record -> one alert', t.ev.alerts === 1 && t.pane.claudeState.parked === null, [t.ev.alerts, t.pane.claudeState.parked]);
  }
  // J3: one of two children finishing is not a drain
  {
    const t = newPane();
    t.root('working'); advance(1000); t.child('a', 'working', { title: 'a' }); t.child('b', 'working', { title: 'b' }); t.hook(2, 0); advance(500);
    t.root('done'); advance(5000);
    t.pane.handleProgramStatus({ type: 'clear', id: 'a' }); advance(30_000);
    check('pane: one of two children left -> still parked, no alert', t.ev.alerts === 0 && lastParked(t.ev)?.titles?.[0] === 'b', [t.ev.alerts, lastParked(t.ev)]);
  }
  // K: a later 0 / 0 verdict un-parks the ring; alerts once; repeats and an unchanged needs-you never alert twice
  {
    const t = newPane();
    t.root('working'); advance(1000); t.hook(2, 0); advance(1000); t.root('done'); advance(3000);
    check('pane: K ring up', lastParked(t.ev)?.tasks === 2 && t.ev.alerts === 0, [t.ev.alerts, lastParked(t.ev)]);
    t.hook(0, 0); advance(5000);
    check('pane: later 0 / 0 verdict un-parks and alerts once', t.ev.alerts === 1 && t.pane.claudeState.parked === null, [t.ev.alerts, t.pane.claudeState.parked]);
    t.hook(0, 0); advance(5000);
    check('pane: the same 0 / 0 verdict again -> no second alert', t.ev.alerts === 1, t.ev.alerts);
  }
  {
    const t = newPane();
    t.root('working'); advance(1000); t.root('done'); advance(300);
    t.hook(0, 0); advance(3000);
    check('pane: 0 / 0 verdict mid-settle -> exactly one alert', t.ev.alerts === 1, t.ev.alerts);
    t.hook(0, 0); advance(3000);
    check('pane: 0 / 0 verdict after the alert -> still one', t.ev.alerts === 1, t.ev.alerts);
  }
  // L: clear paths. A bare clear and a full reset each drop the stored verdict, so a straight done after
  // them (inside the TTL) alerts instead of re-parking.
  for (const [name, ev] of [['clear', { type: 'clear', id: '' }], ['reset', { type: 'reset' }]]) {
    const t = newPane();
    t.root('working'); advance(500); t.hook(2, 0); advance(500); t.root('done'); advance(2000);
    check(`pane: ${name} path: ring up first`, lastParked(t.ev)?.tasks === 2, lastParked(t.ev));
    t.pane.handleProgramStatus(ev); advance(200);
    t.root('done'); advance(1700);
    check(`pane: ${name} drops the verdict; a straight done alerts`, t.ev.alerts === 1 && t.pane.claudeState.parked === null, [t.ev.alerts, t.pane.claudeState.parked]);
    // the done after the drop is a fresh done: a verdict arriving for it parks (done time re-stamped)
    t.hook(2, 0); advance(2000);
    check(`pane: ${name}: a verdict for the next done parks it`, t.pane.claudeState.parked?.tasks === 2, t.pane.claudeState.parked);
  }
  // M: a done that follows a blocked prompt is timed from its own done, not an earlier one
  {
    const t = newPane();
    t.root('working'); advance(500); t.root('done'); advance(100); t.root('blocked', { kind: 'permission' }); advance(60_000);
    t.hook(2, 0); advance(100); t.root('done'); advance(2000);
    check('pane: verdict timed from the latest done', lastParked(t.ev)?.tasks === 2, lastParked(t.ev));
  }
  // N: HOUSE (main.log 22 Nov 2026, pane-25), timed as logged. Claude launches a background subagent;
  // the turn ends (Stop hook, 1 task) and 7501 keeps the root working with the child; no done ever
  // comes. At 19:39:06.255 the subagent's notification starts a new turn (child gone, root working).
  const turnEndedLogs = () => logs.filter((l) => l[0] === '[DOT] Turn ended over a working root');
  const newTurnLogs = () => logs.filter((l) => l[0] === '[DOT] Hook verdict cleared: new turn');
  {
    logs.length = 0;
    const t = newPane();
    t.root('working');                                  // 19:37:23.293
    advance(23_621); t.child('a1', 'working', { title: 'Research agent' }); // 19:37:46.914
    advance(4_271); t.hook(1, 0);                       // 19:37:51.185
    advance(100);
    check('house: ring right after the Stop hook', t.pane.claudeState.parked?.tasks === 1 && t.pane.claudeState.activity === 'parked', [t.pane.claudeState.parked, t.pane.claudeState.activity]);
    check('house: the ring lists the subagent', t.pane.claudeState.parked?.titles?.[0] === 'Research agent', t.pane.claudeState.parked);
    check('house: not working while ringed', t.pane.claudeState.working === false, t.pane.claudeState.working);
    check('house: logged once, source hook-root-working', turnEndedLogs().length === 1 && parkedLogs().some((p) => p.source === 'hook-root-working' && p.tasks === 1), [turnEndedLogs(), parkedLogs()]);
    advance(74_970);                                    // 19:39:06.255, the whole wait
    check('house: still the ring just before 19:39:06, no alert', t.pane.claudeState.activity === 'parked' && t.ev.alerts === 0, [t.pane.claudeState.activity, t.ev.alerts]);
    t.child('a1', 'working', { title: 'Research agent', msg: 'still' });  // a same-count child update keeps it
    check('house: a child record update (same count) keeps the ring', t.pane.claudeState.activity === 'parked', t.pane.claudeState.activity);
    t.pane.handleProgramStatus({ type: 'clear', id: 'a1' }); t.root('working'); // 19:39:06.255
    check('house: working after 19:39:06 (the subagent\'s notification turn)', t.pane.claudeState.activity === 'working' && t.pane.claudeState.parked === null && t.pane.claudeState.working === true, [t.pane.claudeState.activity, t.pane.claudeState.parked]);
    check('house: the old verdict is cleared as a new turn', newTurnLogs().length === 1, newTurnLogs());
    advance(20_000); t.hook(0, 0); advance(500); t.root('done'); advance(1700);
    check('house: that next turn ends as needs-you, one alert', t.ev.alerts === 1 && t.pane.claudeState.parked === null, [t.ev.alerts, t.pane.claudeState.parked]);
  }
  // N2: the next turn after the ring ends with shells only (hook 2 tasks, no child): parked by the hook as today
  {
    const t = newPane();
    t.root('working'); advance(1000); t.child('a1', 'working', { title: 'agent' }); advance(1000); t.hook(1, 0); advance(60_000);
    t.pane.handleProgramStatus({ type: 'clear', id: 'a1' }); t.root('working'); advance(10_000);
    t.hook(2, 0); advance(4000);
    check('house next turn: a stop over a working root with no child is only stored', t.pane.claudeState.activity === 'working', t.pane.claudeState.activity);
    t.root('done'); advance(5000);
    check('house next turn: done after the hook -> parked by the hook, no alert', t.ev.alerts === 0 && t.pane.claudeState.parked?.tasks === 2, [t.ev.alerts, t.pane.claudeState.parked]);
  }
  // N3: the subagent's turn ends with it relaunching another: ring again with the new child
  {
    const t = newPane();
    t.root('working'); advance(1000); t.child('a1', 'working', { title: 'agent' }); advance(1000); t.hook(1, 0); advance(30_000);
    t.pane.handleProgramStatus({ type: 'clear', id: 'a1' }); t.root('working'); advance(3000);
    t.child('a2', 'working', { title: 'agent 2' }); advance(2000); t.hook(1, 0); advance(100);
    check('house relaunch: ring again over the new child', t.pane.claudeState.activity === 'parked' && t.pane.claudeState.parked?.titles?.[0] === 'agent 2', t.pane.claudeState.parked);
    t.root('done'); advance(10_000);
    check('house relaunch: a later done with the child working stays parked, no alert', t.pane.claudeState.activity === 'parked' && t.ev.alerts === 0, [t.pane.claudeState.activity, t.ev.alerts]);
  }
  // N4: a blocked root (a permission prompt) during the ring alerts
  {
    const t = newPane();
    t.root('working'); advance(1000); t.child('a1', 'working', { title: 'agent' }); advance(1000); t.hook(1, 0); advance(10_000);
    t.root('blocked', { kind: 'permission' }); advance(4100); // from a ring, the 4 s drain settle, as for any parked pane
    check('house: a permission prompt during the ring alerts', t.ev.alerts === 1 && t.pane.claudeState.parked === null, [t.ev.alerts, t.pane.claudeState.parked]);
  }
  // O: a prompt of his during the ring clears it to working (7501 sends nothing: the root already works)
  for (const via of ['enter', 'compose', 'empty-bar-enter']) {
    logs.length = 0;
    const t = newPane();
    t.pane.claudeBarHoldsText = () => via !== 'empty-bar-enter';
    t.pane.ptyId = 1;
    t.root('working'); advance(1000); t.child('a1', 'working', { title: 'agent' }); advance(1000); t.hook(1, 0); advance(20_000);
    if (via === 'compose') {
      t.pane.queueSubmit('what next?', false, { own: true });
      for (let i = 0; i < 5; i++) await Promise.resolve();
    } else {
      t.pane.noteEnterSent();
    }
    if (via === 'empty-bar-enter') {
      check('prompt: an Enter on an empty bar keeps the ring', t.pane.claudeState.activity === 'parked', t.pane.claudeState.activity);
      continue;
    }
    check(`prompt (${via}): his message clears the ring to working`, t.pane.claudeState.activity === 'working' && t.pane.claudeState.parked === null, [t.pane.claudeState.activity, t.pane.claudeState.parked]);
    check(`prompt (${via}): logged as a new turn`, newTurnLogs().some((l) => l[1].via === (via === 'enter' ? 'enter' : 'compose')), newTurnLogs());
    advance(30_000); t.hook(1, 0); advance(100);
    check(`prompt (${via}): that turn's end (subagent still running) rings again`, t.pane.claudeState.activity === 'parked', t.pane.claudeState.activity);
  }
  // P: GENOME (main.log 22 Nov 2026, pane-9), timed as logged: background shells, no child records,
  // the hook (2 tasks) then a done -> parked by the hook, unchanged.
  {
    logs.length = 0;
    const t = newPane();
    t.root('working');                                  // 19:02:31.691
    advance(40_133); t.hook(2, 0);                      // 19:03:11.824
    advance(100);
    check('genome: no ring before the done (no working child)', t.pane.claudeState.activity === 'working' && turnEndedLogs().length === 0, [t.pane.claudeState.activity, turnEndedLogs()]);
    advance(3_901); t.root('done');                     // 19:03:15.825
    advance(10_000);
    check('genome: parked with 2 tasks, source hook-tasks, no alert', t.ev.alerts === 0 && t.pane.claudeState.parked?.tasks === 2 && parkedLogs().some((p) => p.source === 'hook-tasks'), [t.ev.alerts, t.pane.claudeState.parked, parkedLogs()]);
  }
  Date.now = realDateNow;
}
