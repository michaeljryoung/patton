// jsdom check of the Settings panel's "Word documents" fields (docs/review-tab.md
// R8, map node rt_drive): the REAL SettingsPanel with window.patton faked.
//  1. an old settings file without the fields: the review tab shows on, the
//     folder and account empty with their defaults as placeholders;
//  2. saved values show as saved;
//  3. typing a folder saves once, after the pause (settings:set allows 10/s),
//     and closing the panel flushes a waiting save;
//  4. a folder with a slash, or an account that isn't an address, shows
//     "not saved" (aria-invalid) and is not sent; fixing it clears that;
//  5. the toggle saves reviewTab; every field has a label.
// Run: JSDOM_DIR=<folder whose node_modules has jsdom> node scripts/check-drive-settings.mjs
// Prints `ok <what>` or `not ok <what>: <detail>`; exit 1 on any failure.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');

let failures = 0;
const check = (what, cond, detail) => {
  if (cond) console.log(`ok ${what}`);
  else { failures++; console.log(`not ok ${what}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, () => ({ path: 'x', namespace: 'empty' }));
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '', loader: 'js' }));
  },
};
const bundle = await build({
  stdin: { contents: `export * as SP from './src/renderer/components/settings-panel';`, resolveDir: repo, loader: 'ts' },
  bundle: true, format: 'iife', globalName: 'DS', platform: 'browser', write: false, plugins: [stubs], logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const patton = {
  setCalls: [],
  settings: { set: (s) => { patton.setCalls.push(s); return Promise.resolve(); }, get: () => Promise.resolve({}) },
  claudeHook: { status: () => Promise.resolve({ installed: false, scriptPresent: false, entryPresent: false, scriptPath: '/x' }) },
  fonts: { getSystem: () => Promise.resolve([]) },
  setOpacity: () => {},
  log: { send: () => {} },
};
w.patton = patton;
w.eval(bundle.outputFiles[0].text);
const { SP } = w.DS;

try {
  const app = w.document.getElementById('app');
  const panel = new SP.SettingsPanel(app, () => {}, () => {});
  const q = (id) => w.document.getElementById(id);
  const base = { fontSize: 14, fontFamily: 'Menlo', scrollback: 10000, shell: '/bin/zsh', copyOnSelect: false, globalHotkey: 'Control+`', theme: 'system', startupCommand: '', opacity: 1, restoreSession: false, shellIntegration: true, renderer: 'dom' };
  const open = (st) => { panel.hide(); panel.loadSettings(st); panel.show(); };
  const type = (el, value) => { el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

  open(base);
  const toggle = q('setting-review-tab');
  const folder = q('setting-drive-folder');
  const account = q('setting-drive-account');
  check('the section has the toggle and both fields', !!toggle && !!folder && !!account && /Word documents/.test(w.document.getElementById('review-settings-title')?.textContent || ''));
  check('every field has a label', [toggle, folder, account].every((el) => w.document.querySelector(`label[for="${el.id}"]`)));
  check('an old file: the review tab shows on', toggle.checked === true);
  check('an old file: folder and account empty, defaults as placeholders', folder.value === '' && account.value === '' && folder.placeholder === 'Patton' && /personal account/.test(account.placeholder), { folder: folder.value, account: account.value });

  open({ ...base, reviewTab: false, driveFolder: 'Reviews', driveAccount: 'me@gmail.com' });
  check('saved values show as saved', toggle.checked === false && folder.value === 'Reviews' && account.value === 'me@gmail.com');

  patton.setCalls.length = 0;
  for (const v of ['R', 'Re', 'Rev', 'Revi', 'Revie', 'Review', 'Reviews 2']) type(folder, v);
  check('typing does not save at each key', patton.setCalls.length === 0, patton.setCalls);
  await sleep(450);
  const folderSaves = patton.setCalls.filter((c) => 'driveFolder' in c);
  check('typing a folder saves once, after the pause, the last value', folderSaves.length === 1 && folderSaves[0].driveFolder === 'Reviews 2', patton.setCalls);

  patton.setCalls.length = 0;
  type(folder, 'Work/Reviews');
  const folderErr = q('setting-drive-folder-error');
  check('a folder with a slash shows "not saved"', !folderErr.hidden && folder.getAttribute('aria-invalid') === 'true');
  await sleep(450);
  check('a folder with a slash is not sent', !patton.setCalls.some((c) => 'driveFolder' in c), patton.setCalls);
  type(folder, 'Work reviews');
  check('fixing it clears "not saved"', folderErr.hidden && folder.getAttribute('aria-invalid') === 'false');

  type(account, 'me at gmail');
  const accountErr = q('setting-drive-account-error');
  check('an account that isn\'t an address shows "not saved"', !accountErr.hidden && account.getAttribute('aria-invalid') === 'true');
  type(account, '');
  check('an empty account is valid (the default)', accountErr.hidden);
  panel.hide();
  const flushed = patton.setCalls.find((c) => 'driveFolder' in c || 'driveAccount' in c);
  check('closing the panel flushes the waiting save', !!flushed && flushed.driveFolder === 'Work reviews' && flushed.driveAccount === '' && !patton.setCalls.some((c) => c.driveAccount === 'me at gmail'), patton.setCalls);

  open(base);
  check('reopening clears a stale "not saved"', q('setting-drive-folder-error').hidden && !folder.hasAttribute('aria-invalid'));
  patton.setCalls.length = 0;
  toggle.checked = false;
  toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
  check('the toggle saves reviewTab', patton.setCalls.some((c) => c.reviewTab === false), patton.setCalls);
  panel.hide();
} catch (err) {
  failures++;
  console.log(`not ok the check ran: ${err && err.stack || err}`);
}
console.log(failures ? `${failures} not ok` : 'all ok');
process.exit(failures ? 1 : 0);
