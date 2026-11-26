// Check of the notification sound choice: Off / Soft chime / Marimba / Gentle
// pop / Classic (+ the old Bugle and Bullet), the volume, the Preview button
// and the default for settings saved before the choice existed.
//
// Three parts, each on the REAL code:
//  1. the settings store (src/main/store.ts, bundled with electron-store
//     stubbed as a Map): the name and volume persist, bad values are refused;
//  2. NotificationSound (src/renderer/services/notification-sound.ts) in jsdom
//     with a recording AudioContext: which tones each choice makes, their
//     length, level and pitch, Off plays nothing, the volume is the master
//     gain, the 2 s cooldown, the [SOUND] log line;
//  3. the REAL SettingsPanel: its select and slider save through
//     window.patton.settings.set, its Preview button plays the selected sound,
//     and a settings object saved before the choice shows the new default.
//
// Run: JSDOM_DIR=<folder whose node_modules has jsdom> node scripts/check-notification-sound.mjs
// Against another tree (e.g. a worktree of main, to prove the checks fail there):
//   SOUND_SRC_ROOT=<that worktree> JSDOM_DIR=... node scripts/check-notification-sound.mjs
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.SOUND_SRC_ROOT ? resolve(process.env.SOUND_SRC_ROOT) : here;
const work = mkdtempSync(join(tmpdir(), 'sound-check-'));

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
// A group that throws (an API the tree under test lacks) fails, never aborts the run.
const group = async (name, fn) => {
  try { await fn(); } catch (err) { failed++; console.log('FAIL', name, 'threw:', String(err?.message ?? err)); }
};

// ---------- 1. the store ----------
const storeStubs = [
  [/^electron$/, 'module.exports = { app: { getPath: () => "/nonexistent" }, safeStorage: { isEncryptionAvailable: () => false } };'],
  [/^node-pty$/, 'module.exports = { spawn: () => { throw new Error("no pty in checks"); } };'],
  [/^electron-store$/, 'class S { constructor(o) { this.m = new Map(Object.entries(JSON.parse(JSON.stringify(o.defaults)))); globalThis.__store = this.m; } get(k, d) { return this.m.has(k) ? this.m.get(k) : d; } set(k, v) { this.m.set(k, v); } get store() { return Object.fromEntries(this.m); } }\nmodule.exports = S; module.exports.default = S;'],
];
const storeOut = join(work, 'store.cjs');
await build({
  entryPoints: [join(repo, 'src/main/store.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: storeOut, logLevel: 'silent',
  plugins: [{
    name: 'stubs',
    setup(b) {
      for (const [re] of storeStubs) b.onResolve({ filter: re }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: storeStubs.find(([re]) => re.test(a.path))[1], loader: 'js' }));
    },
  }],
});
const store = createRequire(import.meta.url)(storeOut);

await group('store', async () => {
  const S = () => store.getSettings();
  check('a fresh store defaults to the low marimba', S().notificationSoundName === 'marimba', S().notificationSoundName);
  check('a fresh store defaults to full volume', S().notificationSoundVolume === 100, S().notificationSoundVolume);
  for (const n of ['off', 'soft', 'marimba', 'pop', 'classic', 'bugle', 'bullet']) {
    store.setSettings({ notificationSoundName: n });
    check(`the name ${n} persists`, S().notificationSoundName === n, S().notificationSoundName);
  }
  store.setSettings({ notificationSoundName: 'marimba' });
  for (const bad of ['chime', 'LOUD', '', 3, null, {}]) {
    store.setSettings({ notificationSoundName: bad });
    check(`refused name ${JSON.stringify(bad)}: marimba stays`, S().notificationSoundName === 'marimba', S().notificationSoundName);
  }
  for (const v of [0, 35, 100, 42.4, 250, 300, 400]) {
    store.setSettings({ notificationSoundVolume: v });
    check(`volume ${v} persists (whole number)`, S().notificationSoundVolume === Math.round(v), S().notificationSoundVolume);
  }
  store.setSettings({ notificationSoundVolume: 35 });
  for (const bad of [-1, 401, 1000, NaN, Infinity, '50', null, {}]) {
    store.setSettings({ notificationSoundVolume: bad });
    check(`refused volume ${String(bad)}: 35 stays`, S().notificationSoundVolume === 35, S().notificationSoundVolume);
  }
});

// ---------- 2 and 3. the renderer, in jsdom ----------
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, () => ({ path: 'x', namespace: 'empty' }));
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '', loader: 'js' }));
  },
};
const bundle = await build({
  stdin: {
    contents: `
      export * as K from './src/shared/constants';
      export * as NS from './src/renderer/services/notification-sound';
      export * as SP from './src/renderer/components/settings-panel';
    `,
    resolveDir: repo, loader: 'ts',
  },
  bundle: true, format: 'iife', globalName: 'SND', platform: 'browser', write: false,
  plugins: [stubs], logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;

// A recording AudioContext: every oscillator (type, start/stop, frequency
// automation), every gain's automation, filters, and what reaches destination.
const log = { ctxs: 0, oscs: [], gains: [], filters: [], shapers: [], lines: [] };
class FakeParam {
  constructor(rec) { this.rec = rec; this.rec.events = []; }
  setValueAtTime(v, t) { this.rec.events.push(['set', v, t]); this.value = v; }
  linearRampToValueAtTime(v, t) { this.rec.events.push(['lin', v, t]); }
  exponentialRampToValueAtTime(v, t) { this.rec.events.push(['exp', v, t]); }
}
class FakeNode {
  constructor() { this.to = []; }
  connect(n) { this.to.push(n); return n; }
  disconnect() {}
}
class FakeAudioContext {
  constructor() { log.ctxs++; this.currentTime = 0; this.state = 'running'; this.sampleRate = 44100; this.destination = Object.assign(new FakeNode(), { isDestination: true }); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createOscillator() {
    const n = new FakeNode(); const rec = { kind: 'osc', node: n, type: 'sine', start: null, stop: null };
    n.frequency = new FakeParam(rec); n.rec = rec;
    Object.defineProperty(n, 'type', { get: () => rec.type, set: (v) => { rec.type = v; } });
    n.start = (t) => { rec.start = t; }; n.stop = (t) => { rec.stop = t; };
    log.oscs.push(rec); return n;
  }
  createGain() { const n = new FakeNode(); const rec = { kind: 'gain', node: n }; n.gain = new FakeParam(rec); n.rec = rec; log.gains.push(rec); return n; }
  createBiquadFilter() { const n = new FakeNode(); const rec = { kind: 'filter', node: n, type: 'allpass' }; n.rec = rec; n.frequency = new FakeParam(rec); n.q = new FakeParam({}); Object.defineProperty(n, 'type', { get: () => rec.type, set: (v) => { rec.type = v; } }); log.filters.push(rec); return n; }
  createWaveShaper() { const n = new FakeNode(); n.isShaper = true; n.curve = null; n.oversample = 'none'; log.shapers.push(n); return n; }
  createBuffer(_c, len) { return { getChannelData: () => new Float32Array(len) }; }
  createBufferSource() { const n = new FakeNode(); n.start = () => {}; n.stop = () => {}; return n; }
}
w.AudioContext = FakeAudioContext;
const patton = {
  setCalls: [],
  settings: { set: (s) => { patton.setCalls.push(s); return Promise.resolve(); }, get: () => Promise.resolve({}) },
  claudeHook: { status: () => Promise.resolve({ installed: false, scriptPresent: false, entryPresent: false, scriptPath: '/x' }) },
  fonts: { getSystem: () => Promise.resolve([]) },
  setOpacity: () => {},
  log: { send: (level, args) => { log.lines.push(args); } },
};
w.patton = patton;
w.eval(bundle.outputFiles[0].text);
const { K, NS, SP } = w.SND;
const reset = () => { log.oscs.length = 0; log.gains.length = 0; log.filters.length = 0; log.shapers.length = 0; log.lines.length = 0; };
const soundLines = () => log.lines.filter((a) => a[0] === '[SOUND] played');

// The peak level a tone reaches: its largest ramp target.
const peakOf = (osc) => {
  const g = log.gains.find((x) => x.node.to.length && x.node.rec === x && osc.node.to.includes(x.node));
  return g ? Math.max(...g.events.filter((e) => e[0] !== 'exp' || e[1] > 0.01).map((e) => e[1])) : null;
};
const freqsOf = (osc) => osc.events.filter((e) => e[0] === 'set' || e[0] === 'exp').map((e) => e[1]);
// The master gain is the volume: the gain the 2 kHz low-pass feeds.
const masterOf = () => { const f = log.filters[0]; return log.gains.find((g) => f.node.to.includes(g.node)); };
const nowMs = { t: 1_000_000 };
const realNow = w.Date.now;
w.Date.now = () => nowMs.t;
globalThis.Date = w.Date;

const play = (type, vol = 100, how = 'play') => {
  reset();
  const s = new NS.NotificationSound();
  s.setType(type); s.setVolume(vol);
  nowMs.t += 10_000;
  s[how]();
  return s;
};

await group('calm sounds', async () => {
  for (const name of ['soft', 'marimba', 'pop']) {
    play(name);
    check(`${name}: makes at least one sine tone`, log.oscs.length >= 1 && log.oscs.every((o) => o.type === 'sine'), log.oscs.map((o) => o.type));
    check(`${name}: every tone ends within 400 ms`, log.oscs.every((o) => o.stop <= 0.4 && o.stop > 0), log.oscs.map((o) => o.stop));
    const peaks = log.oscs.map(peakOf);
    check(`${name}: every tone peaks at 0.13 or less`, peaks.every((p) => p !== null && p > 0 && p <= 0.13), peaks);
    const hi = Math.max(...log.oscs.flatMap(freqsOf));
    check(`${name}: no tone above 1.1 kHz, and a 2 kHz low-pass is in the path`, hi <= 1100 && log.filters.some((f) => f.type === 'lowpass' && f.events[0][1] <= 2000), { hi, filters: log.filters.map((f) => f.type) });
    const g = log.gains.find((x) => x.node.to.length && x.events.some((e) => e[0] === 'lin'));
    check(`${name}: a soft attack (a swell of 4 ms or more, not a step)`, g.events.find((e) => e[0] === 'lin')[2] >= 0.004 && g.events[0][1] <= 0.001, g.events);
    check(`${name}: the sound fades out (the tail ramp ends near silence)`, log.gains.filter((x) => x.events.some((e) => e[0] === 'exp')).every((x) => x.events.at(-1)[0] === 'exp' && x.events.at(-1)[1] <= 0.001));
  }
  const key = (n) => { play(n); return JSON.stringify(log.oscs.map((o) => [o.rec?.type ?? o.type, o.start, o.stop, freqsOf(o)])); };
  check('soft, marimba and pop are three different sounds', new Set([key('soft'), key('marimba'), key('pop')]).size === 3);
  play('marimba');
  check('marimba is the low one (its main tone under 300 Hz)', freqsOf(log.oscs[0])[0] < 300, freqsOf(log.oscs[0]));
  play('pop');
  check('pop glides in pitch', new Set(freqsOf(log.oscs[0])).size === 2, freqsOf(log.oscs[0]));
});

await group('classic is the sound of every earlier version', async () => {
  play('classic');
  check('classic: two sine tones at 880 Hz and 1174.66 Hz', log.oscs.length === 2 && freqsOf(log.oscs[0])[0] === 880 && freqsOf(log.oscs[1])[0] === 1174.66, log.oscs.map(freqsOf));
  check('classic: the 0.15 and 0.12 levels are unchanged', JSON.stringify(log.gains.filter((g) => g.events.some((e) => e[1] === 0.15 || e[1] === 0.12)).map((g) => g.events.find((e) => e[1] >= 0.12)[1]).sort()) === '[0.12,0.15]');
  play('bugle');
  check('bugle: three sawtooth notes', log.oscs.length === 3 && log.oscs.every((o) => o.type === 'sawtooth'));
  play('bullet');
  check('bullet: a crack, a tail and a click (one sine, one square)', log.oscs.some((o) => o.type === 'square') && log.oscs.some((o) => o.type === 'sine'));
});

await group('off and the volume', async () => {
  const off = play('off');
  check('off: play() makes no sound and no context', log.oscs.length === 0 && log.gains.length === 0 && soundLines().length === 0, { oscs: log.oscs.length, lines: soundLines().length });
  reset();
  off.playPreview();
  check('off: Preview makes no sound either', log.oscs.length === 0 && soundLines().length === 0);
  for (const [vol, want] of [[100, 1], [50, 0.5], [0, 0]]) {
    play('soft', vol);
    const m = masterOf();
    check(`volume ${vol}%: the master gain is ${want}`, m && m.events[0][1] === want, m?.events);
    check(`volume ${vol}%: every tone goes through the master gain`, log.oscs.every((o) => o.node.to.length === 1));
  }
  const s = new NS.NotificationSound();
  s.setType('soft'); s.setVolume(250);
  reset(); nowMs.t += 10_000; s.play();
  check('250%: the master gain is 2.5', masterOf().events[0][1] === 2.5, masterOf()?.events);
  play('soft', 300);
  check('300%: the master gain is 3.0', masterOf()?.events[0][1] === 3, masterOf()?.events);
  play('soft', 400);
  check('400%: the master gain is 4.0', masterOf()?.events[0][1] === 4, masterOf()?.events);
  check('the cap is one exported constant, 400', K.NOTIFICATION_VOLUME_MAX === 400);
  s.setVolume(401);
  reset(); nowMs.t += 10_000; s.play();
  check('a volume above 400 is held at 400', masterOf().events[0][1] === 4, masterOf()?.events);
  s.setVolume(-5);
  reset(); nowMs.t += 10_000; s.play();
  check('a negative volume is held at 0', masterOf().events[0][1] === 0, masterOf()?.events);
  s.setVolume(NaN); s.setVolume(40);
  check('notificationVolumeOf: 0-400 accepted, 100 reads 100', [0, 100, 250, 300, 400, 42.4].every((v) => K.notificationVolumeOf(v) === Math.round(v)));
  check('notificationVolumeOf: 401, -1, NaN, Infinity, strings and undefined fall back to 100', [401, -1, NaN, Infinity, '300', null, undefined, {}].every((v) => K.notificationVolumeOf(v) === 100), [401, -1, NaN].map((v) => K.notificationVolumeOf(v)));
  s.setType('LOUD');
  check('an unknown sound name is ignored', s.getType() === 'soft', s.getType());
});

await group('the limiter after the master gain', async () => {
  const LS = NS.LIMITER_START, R = NS.LIMITER_RANGE;
  const ALL = ['classic', 'bugle', 'bullet', 'soft', 'marimba', 'pop'];
  for (const name of ALL) {
    for (const vol of [101, 300, 400]) {
      play(name, vol);
      const lim = log.shapers[0];
      const post = lim?.to[0];
      const pre = masterOf()?.node.to[0];
      check(`${name} at ${vol}%: a limiter (waveshaper) is in the graph, master -> 1/${R} -> limiter -> x${R} -> speakers`, log.shapers.length === 1 && pre?.to[0] === lim && post?.to[0]?.isDestination && pre.rec.events[0][1] === 1 / R && post.rec.events[0][1] === R, { shapers: log.shapers.length });
      check(`${name} at ${vol}%: the limiter has a curve`, lim?.curve?.constructor.name === 'Float32Array' && lim.curve.length === 8193);
      check(`${name} at ${vol}%: nothing reaches the speakers except through the limiter`, log.gains.filter((g) => g.node.to.some((n) => n.isDestination)).length === 1 && masterOf().node.to.every((n) => !n.isDestination));
    }
    for (const vol of [100, 50, 1, 0]) {
      play(name, vol);
      const m = masterOf();
      check(`${name} at ${vol}%: no limiter, master connects straight to the speakers`, log.shapers.length === 0 && m.node.to.length === 1 && m.node.to[0].isDestination && log.gains.every((g) => g === m || !g.node.to.some((n) => n.isDestination)), { shapers: log.shapers.length, to: m?.node.to.length });
      check(`${name} at ${vol}%: the graph has no 1/${R} or x${R} gain`, log.gains.every((g) => g.events.every((e) => e[1] !== 1 / R && e[1] !== R)));
    }
  }
  // the curve itself, read as the browser does (linear interpolation over [-R, R])
  const curve = NS.softLimitCurve();
  const at = (x) => { const p = ((Math.max(-R, Math.min(R, x)) / R + 1) / 2) * (curve.length - 1); const i = Math.min(curve.length - 2, Math.floor(p)); return (curve[i] + (curve[i + 1] - curve[i]) * (p - i)) * R; };
  let worstId = 0;
  for (let x = -LS; x <= LS; x += 0.0007) worstId = Math.max(worstId, Math.abs(at(x) - x));
  check('up to -3 dB the limiter changes nothing (largest difference under 1e-6)', worstId < 1e-6, worstId);
  let bounded = true, mono = true, prev = -Infinity;
  for (let x = -R; x <= R; x += 0.001) { const y = at(x); if (Math.abs(y) > 1.0001) bounded = false; if (y < prev - 1e-9) mono = false; prev = y; }
  check('above it the output bends smoothly, rises with the input and never passes full scale', bounded && mono, { bounded, mono });
  check('a loud peak (4.0, 4.37) is rounded to just under full scale, not clipped at the knee', at(4) > 0.97 && at(4) <= 1 && at(0.9) > 0.85 && at(1.5) < 1, [at(0.9), at(1.5), at(4)]);
  // A sound boosted above 100% is untouched by the limiter while its peaks
  // (the plain sum of every tone's peak, an upper bound) stay under the knee.
  // At 100% there is no limiter at all (checked above), so Bullet, whose crack
  // already reaches ~1.1, plays as it always did.
  for (const name of ['classic', 'bugle', 'soft', 'marimba', 'pop']) {
    play(name, 100);
    const sum = log.oscs.map(peakOf).reduce((a, b) => a + b, 0);
    check(`${name} at 100%: peak sum ${sum.toFixed(3)} is under the knee ${LS}`, sum <= LS, sum);
  }
  play('marimba', 400);
  const mp = log.oscs.map(peakOf).reduce((a, b) => a + b, 0) * 4;
  check('marimba at 400% (peak sum x4, 0.64) is still under the knee: untouched', mp <= LS, mp);
});

await group('play and preview', async () => {
  const s = play('pop', 100);
  check('the chosen sound is the one played', soundLines().length === 1 && soundLines()[0][1].sound === 'pop' && soundLines()[0][1].reason === 'command-done', soundLines());
  const before = log.oscs.length;
  nowMs.t += 500; s.play();
  check('a second play within 2 s is skipped (the log is rate-limited too)', log.oscs.length === before && soundLines().length === 1, soundLines().length);
  nowMs.t += 2000; s.play();
  check('after 2 s it plays and logs again', soundLines().length === 2, soundLines().length);
  reset(); nowMs.t += 1000; s.playPreview();
  check('Preview plays the selected sound at once, logged as a preview', log.oscs.length >= 1 && soundLines()[0]?.[1].sound === 'pop' && soundLines()[0][1].reason === 'preview', soundLines());
  reset(); s.playPreview();
  check('a Preview within 300 ms of the last is skipped', log.oscs.length === 0);
  s.setType('marimba'); reset(); nowMs.t += 1000; s.playPreview();
  check('Preview follows a change of choice', soundLines()[0]?.[1].sound === 'marimba', soundLines());
});

await group('settings reach the sound', async () => {
  const s = new NS.NotificationSound();
  nowMs.t += 10_000;
  reset();
  s.applySettings({ notificationSoundName: 'marimba', notificationSoundVolume: 40 }, false);
  check('loading the saved file sets the name and the volume, silently', s.getType() === 'marimba' && log.oscs.length === 0);
  reset(); nowMs.t += 1000; s.play();
  check('and the sound played is that name at that volume', soundLines()[0]?.[1].sound === 'marimba' && masterOf().events[0][1] === 0.4, masterOf()?.events);
  reset(); nowMs.t += 1000;
  s.applySettings({ notificationSoundName: 'pop' }, true);
  check('choosing a sound in Settings plays it once', soundLines().length === 1 && soundLines()[0][1].sound === 'pop', soundLines());
  reset(); nowMs.t += 1000;
  s.applySettings({ notificationSoundName: 'off' }, true);
  check('choosing Off plays nothing', log.oscs.length === 0 && s.getType() === 'off');
  reset(); nowMs.t += 1000;
  s.applySettings({ theme: 'dark' }, true);
  check('an unrelated settings change is not heard', log.oscs.length === 0);
  s.applySettings({ notificationSoundName: 'soft' }, true);
  nowMs.t += 1000; reset();
  s.applySettings({ notificationSoundVolume: 20 }, true);
  check('moving the volume plays the sound once at the new level', soundLines().length === 1 && masterOf().events[0][1] === 0.2, soundLines());
  // an old file
  nowMs.t += 1000; reset();
  s.applySettings({ notificationSound: true, notificationSoundType: 'chime' }, false);
  check('an old file with the default type reads as the low marimba', s.getType() === 'marimba', s.getType());
  s.applySettings({ notificationSound: false, notificationSoundType: 'chime' }, false);
  check('an old file with the sound off stays off', s.getType() === 'off', s.getType());
  s.applySettings({ notificationSound: true, notificationSoundType: 'bugle' }, false);
  check('an old file that chose the bugle keeps it', s.getType() === 'bugle', s.getType());
  s.applySettings({ notificationSound: false, notificationSoundType: 'bugle', notificationSoundName: 'classic' }, false);
  check('a saved name wins over the old flag', s.getType() === 'classic', s.getType());
  s.applySettings({}, false);
  check('a file with none of the fields gets the low marimba', s.getType() === 'marimba' && K.resolveNotificationSound({}) === 'marimba');
  check('the default name is the low marimba at 100%', K.DEFAULTS.NOTIFICATION_SOUND_NAME === 'marimba' && K.DEFAULTS.NOTIFICATION_SOUND_VOLUME === 100);
});

await group('settings panel', async () => {
  const app = w.document.getElementById('app');
  const sound = new NS.NotificationSound();
  const changes = [];
  const panel = new SP.SettingsPanel(app, (s) => { changes.push(s); sound.applySettings(s, true); }, () => sound.playPreview());
  const q = (id) => w.document.getElementById(id);
  const base = { fontSize: 14, fontFamily: 'Menlo', scrollback: 10000, shell: '/bin/zsh', copyOnSelect: false, globalHotkey: 'Control+`', theme: 'system', startupCommand: '', opacity: 1, restoreSession: false, shellIntegration: true, renderer: 'dom' };

  const open = (st) => { panel.hide(); panel.loadSettings(st); panel.show(); };
  open({ ...base, notificationSound: true, notificationSoundType: 'chime' });
  const sel = q('setting-notification-sound-name');
  const prev = q('setting-notification-sound-preview');
  const vol = q('setting-notification-volume');
  check('the setting is there: a select, a Preview button and a volume slider', !!sel && prev?.tagName === 'BUTTON' && vol?.type === 'range', { sel: !!sel, prev: prev?.tagName, vol: vol?.type });
  check('the Preview button is a visible, labelled button', prev?.textContent.trim() === 'Preview' && prev.type === 'button');
  check('the choices are Off, soft chime, low marimba, gentle pop and Classic (and the old two)', JSON.stringify([...sel.options].map((o) => o.value)) === '["off","soft","marimba","pop","classic","bugle","bullet"]', [...sel.options].map((o) => o.value));
  check('an old file shows the new default, low marimba', sel.value === 'marimba' && sel.selectedOptions[0]?.textContent === 'Low marimba', sel.value);
  check('the slider goes up to 400, in steps of 5', vol.max === '400' && vol.min === '0' && vol.step === '5', { max: vol.max, min: vol.min, step: vol.step });
  check('the slider shows 100% by default', vol.value === '100' && q('setting-notification-volume-value').textContent === '100%');

  open({ ...base, notificationSoundName: 'marimba', notificationSoundVolume: 60 });
  check('a saved choice and volume are shown', sel.value === 'marimba' && vol.value === '60' && q('setting-notification-volume-value').textContent === '60%', { v: sel.value, vol: vol.value });
  sound.applySettings({ notificationSoundName: 'marimba', notificationSoundVolume: 60 }, false);

  open({ ...base, notificationSoundName: 'marimba', notificationSoundVolume: 250 });
  check('a saved 250 is shown as 250 and 250%', vol.value === '250' && q('setting-notification-volume-value').textContent === '250%', { vol: vol.value });
  sound.applySettings({ notificationSoundName: 'marimba', notificationSoundVolume: 250 }, false);
  nowMs.t += 10_000; reset(); prev.click();
  check('Preview plays at 250%', soundLines().length === 1 && masterOf()?.events[0][1] === 2.5, masterOf()?.events);
  vol.value = '400'; vol.dispatchEvent(new w.Event('input'));
  check('the label follows the slider to 400%', q('setting-notification-volume-value').textContent === '400%');
  open({ ...base, notificationSoundName: 'marimba', notificationSoundVolume: 60 });
  sound.applySettings({ notificationSoundName: 'marimba', notificationSoundVolume: 60 }, false);

  nowMs.t += 10_000; reset();
  prev.click();
  check('Preview plays the selected sound at the selected volume', soundLines().length === 1 && soundLines()[0][1].sound === 'marimba' && soundLines()[0][1].reason === 'preview' && masterOf()?.events[0][1] === 0.6, { lines: soundLines(), m: masterOf()?.events });

  patton.setCalls.length = 0; changes.length = 0; nowMs.t += 10_000; reset();
  sel.value = 'pop'; sel.dispatchEvent(new w.Event('change'));
  check('choosing a sound saves it through settings:set', patton.setCalls.some((c) => c.notificationSoundName === 'pop'), patton.setCalls);
  check('and plays it', soundLines().length === 1 && soundLines()[0][1].sound === 'pop');
  nowMs.t += 10_000; reset(); prev.click();
  check('Preview then plays the newly chosen sound', soundLines()[0]?.[1].sound === 'pop', soundLines());

  nowMs.t += 10_000; reset();
  sel.value = 'off'; sel.dispatchEvent(new w.Event('change'));
  check('choosing Off saves Off, plays nothing and disables Preview', patton.setCalls.some((c) => c.notificationSoundName === 'off') && log.oscs.length === 0 && prev.disabled === true, { calls: patton.setCalls, dis: prev.disabled });
  nowMs.t += 10_000; reset(); prev.click();
  check('Preview with Off selected plays nothing', log.oscs.length === 0);
  sel.value = 'classic'; sel.dispatchEvent(new w.Event('change'));
  check('choosing a sound again enables Preview', prev.disabled === false);

  // volume: fast drag, one save, debounced
  patton.setCalls.length = 0; changes.length = 0; nowMs.t += 10_000; reset();
  for (const v of ['90', '80', '70', '30']) { vol.value = v; vol.dispatchEvent(new w.Event('input')); }
  check('dragging the volume updates the number only (nothing saved, nothing played)', q('setting-notification-volume-value').textContent === '30%' && patton.setCalls.length === 0 && soundLines().length === 0, { n: q('setting-notification-volume-value').textContent, calls: patton.setCalls.length });
  vol.dispatchEvent(new w.Event('change'));
  check('releasing it plays once at the new level', soundLines().length === 1 && masterOf()?.events[0][1] === 0.3, soundLines());
  // a burst of releases must reach main as one save (settings:set takes 10/s)
  for (const v of ['25', '20', '15', '10']) { vol.value = v; vol.dispatchEvent(new w.Event('change')); }
  check('the volume save waits for a pause (nothing sent yet)', patton.setCalls.length === 0, patton.setCalls);
  await new Promise((r) => setTimeout(r, 450));
  check('and goes as one save of the last value', patton.setCalls.length === 1 && patton.setCalls[0].notificationSoundVolume === 10, patton.setCalls);
  panel.dispose();
});

w.Date.now = realNow;
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
