// Check that a name set from a tab in a linked git worktree names THAT worktree
// (13 Nov: right-click -> "Set Default Tab Name for Project..." on the
// next-venture-lifesci tab, typed "LifeSci", and it was filed against the parent
// repo next-venture, so every tab in the repo and its other worktree changed).
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-worktree-name.mjs
//
// Main half: bundles the REAL ipc-handlers (electron and node-pty stubbed, the
// PROJECT_NAME_SET handler captured from ipcMain.handle), the REAL store
// (electron-store writing under a temp folder) and the REAL resolveProject over a
// temp repo with two linked worktrees. HOME is a temp folder; Patton's own
// settings are never touched.
// Renderer half: bundles the REAL project-names and tab-bar in jsdom.
// A source assertion at the end checks tab-manager / tab / bookmarks wiring.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

// ---- fixtures: a repo with two linked worktrees, a plain folder, a loose repo ----
const work = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-name-check-')));
const home = join(work, 'home');
const userData = join(work, 'userData');
mkdirSync(home);
mkdirSync(userData);
process.env.HOME = home;
const projects = join(home, 'Projects');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
const nv = join(projects, 'next-venture');
mkdirSync(nv, { recursive: true });
git(nv, 'init', '-q');
writeFileSync(join(nv, 'a.txt'), 'a');
git(nv, 'add', '.');
git(nv, 'commit', '-q', '-m', 'init');
const lifesci = join(projects, 'next-venture-lifesci');
const defence = join(projects, 'next-venture-defence');
git(nv, 'worktree', 'add', '-q', lifesci, '-b', 'lifesci');
git(nv, 'worktree', 'add', '-q', defence, '-b', 'defence');
mkdirSync(join(lifesci, 'sub'));
const loose = join(projects, 'loose-folder');
mkdirSync(join(loose, 'inner'), { recursive: true });
const outside = join(home, 'elsewhere', 'deep'); // not under ~/Projects, not in a repo
mkdirSync(outside, { recursive: true });

// ---- main half ----
const sent = [];
const handlers = new Map();
globalThis.__stubs = {
  userData,
  handle: (channel, fn) => handlers.set(channel, fn),
  windows: () => [{ isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } }],
};
const stubSource = `
const s = globalThis.__stubs;
const quiet = new Proxy(function () {}, { get: () => quiet, apply: () => quiet, construct: () => quiet });
module.exports = new Proxy({
  app: { getPath: () => s.userData, getName: () => 'patton', getVersion: () => '0', isPackaged: false, on() {}, whenReady: () => new Promise(() => {}) },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: (c, f) => s.handle(c, f), on() {}, once() {}, removeHandler() {} },
  BrowserWindow: { getAllWindows: () => s.windows(), fromWebContents: () => null, getFocusedWindow: () => null },
  nativeTheme: { shouldUseDarkColors: false, on() {} },
}, { get: (t, k) => (k in t ? t[k] : (k === '__esModule' ? false : quiet)) });
`;
const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^(electron|node-pty)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'node-pty' ? 'module.exports = { spawn() { throw new Error("no pty in checks"); } };' : stubSource,
      loader: 'js',
    }));
  },
};
await build({
  stdin: {
    contents: `export { registerIpcHandlers } from './src/main/ipc-handlers';
export { resolveProject } from './src/main/projects';
export { getProjectNames, setProjectName } from './src/main/store';
export { IPC } from './src/shared/constants';`,
    resolveDir: repo, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'main.mjs'), logLevel: 'error', plugins: [stubPlugin],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const logs = [];
const origInfo = console.info;
const origWarn = console.warn;
console.info = (...a) => logs.push(['info', ...a]);
console.warn = (...a) => logs.push(['warn', ...a]);
const m = await import(pathToFileURL(join(work, 'main.mjs')).href);
m.registerIpcHandlers({});
const setName = handlers.get(m.IPC.PROJECT_NAME_SET);
check('the PROJECT_NAME_SET handler registered', typeof setName === 'function');

// the handler rate-limits at 5 a second: a fake clock moves 1.1 s per call
let clock = Date.now();
Date.now = () => clock;
const rename = (path, name) => { clock += 1100; sent.length = 0; return setName({}, path, name); };
const stored = () => ({ ...m.getProjectNames() });

// the shape of the bug: the worktree resolves to the parent, with a worktree
const wtInfo = m.resolveProject(lifesci);
check('fixture: the worktree resolves to the parent repo with its own worktree', wtInfo?.root === nv && wtInfo?.worktree?.path === lifesci, wtInfo);

await rename(lifesci, 'LifeSci');
check('a rename sent for the worktree is stored under the WORKTREE folder', stored()[lifesci] === 'LifeSci', stored());
check('...the parent repo has no entry', stored()[nv] === undefined, stored());
check('...the other worktree has no entry', stored()[defence] === undefined, stored());
check('...main broadcast the stored names', sent.length === 1 && sent[0][1][lifesci] === 'LifeSci', sent);
const renamedLog = logs.filter((l) => l[1] === '[PROJECTS] Project renamed').pop();
check('...the log line says "worktree" with the folder and the name', renamedLog && renamedLog[2].worktree === lifesci && renamedLog[2].name === 'LifeSci' && !('root' in renamedLog[2]), renamedLog);

await rename(nv, 'Venture');
check('a rename sent for the parent repo still stores under its root', stored()[nv] === 'Venture' && stored()[lifesci] === 'LifeSci', stored());
const rootLog = logs.filter((l) => l[1] === '[PROJECTS] Project renamed').pop();
check('...the log line says "root"', rootLog && rootLog[2].root === nv && !('worktree' in rootLog[2]), rootLog);

const before = stored();
logs.length = 0;
for (const [label, path] of [
  ['a folder inside a worktree', join(lifesci, 'sub')],
  ['a folder inside a plain project', join(loose, 'inner')],
  ['a path that does not exist', join(projects, 'no-such-folder')],
  ['a folder outside every project', outside],
]) {
  await rename(path, 'Sneaky');
  check(`${label} is rejected: nothing stored`, JSON.stringify(stored()) === JSON.stringify(before) && sent.length === 0, stored());
}
check('...each rejection logs the [SECURITY] warning', logs.filter((l) => l[0] === 'warn' && String(l[1]).startsWith('[SECURITY] PROJECT_NAME_SET')).length === 4, logs);

await rename(lifesci, 'x'.repeat(100));
check('a long worktree name is cut at 60 characters', stored()[lifesci] === 'x'.repeat(60), stored()[lifesci]);
await rename(lifesci, '  Life\tSci  ');
check('a worktree name is cleaned (whitespace)', stored()[lifesci] === 'Life Sci', stored()[lifesci]);
await rename(lifesci, 'next-venture-lifesci');
check('a worktree name equal to its folder name is a real name, kept', stored()[lifesci] === 'next-venture-lifesci', stored());
await rename(lifesci, '');
check('an empty name removes the worktree\'s entry and only that', stored()[lifesci] === undefined && stored()[nv] === 'Venture', stored());
await rename(nv, 'venture');
check('a parent name equal to its automatic name removes its entry', stored()[nv] === undefined, stored());

await rename(loose, 'Loose');
check('a plain (non-repo) project folder under ~/Projects is still a nameable root', stored()[loose] === 'Loose', stored());
await rename(loose, '');

// the cap: PROJECT_NAMES_MAX (500) names; an existing key can still change, a new one is refused
for (const k of Object.keys(stored())) await rename(k, '');
for (let i = 0; i < 500; i++) m.setProjectName({ kind: 'root', key: `/filler/${i}`, defaultName: null }, 'n');
check('fixture: 500 names stored', Object.keys(stored()).length === 500);
await rename(lifesci, 'one too many');
check('at the cap a new worktree name is refused', stored()[lifesci] === undefined && Object.keys(stored()).length === 500, Object.keys(stored()).length);
m.setProjectName({ kind: 'root', key: '/filler/0', defaultName: null }, 'changed');
check('at the cap an existing name can still change', stored()['/filler/0'] === 'changed');

// ---- renderer half ----
const bundle = await build({
  stdin: {
    contents: `export * as PN from './src/renderer/services/project-names';
export * as SE from './src/renderer/services/sessions';
export { TabBar } from './src/renderer/components/tab-bar';`,
    resolveDir: repo, loader: 'ts',
  },
  bundle: true, format: 'iife', globalName: 'R', platform: 'browser', write: false,
  loader: { '.css': 'empty' }, logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="bar"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const doc = w.document;
let pushNames = () => {};
let initialNames = {};
w.patton = {
  titleBarDoubleClick: () => {}, moveWindowBy: () => {}, onUiTextScale: () => () => {},
  projects: { getNames: () => Promise.resolve(initialNames), onNamesChanged: (cb) => { pushNames = cb; } },
};
w.Element.prototype.scrollIntoView = () => {};
w.eval(bundle.outputFiles[0].text);
const { PN, SE, TabBar } = w.R;
await PN.startProjectNames();

// What the app does with a project, written through the real functions. The
// fallbacks are the code before this fix, so the check can run against it.
const titleOf = (p) => (PN.projectTitle ? PN.projectTitle(p) : SE.formatProjectTitle(PN.projectName(p), p.worktree));
const fieldsOf = (p) => (PN.projectRenameFields ? PN.projectRenameFields(p) : { name: PN.projectName(p), defaultName: p.defaultName });
const keyOf = (p) => (PN.projectNameKey ? PN.projectNameKey(p) : p.root);
const sessionOf = (p, tabTitle) => {
  const display = PN.projectDisplay ? PN.projectDisplay(p) : { name: PN.projectName(p), worktree: p.worktree ?? null };
  return SE.sessionName({ project: p, projectName: display.name, worktree: display.worktree, hasCustomTitle: false, tabTitle, paneCount: 1, paneTitle: '', cwd: p.root });
};

// the three projects as main resolves them
const parent = m.resolveProject(nv);
const lifesciProject = m.resolveProject(lifesci);
const defenceProject = m.resolveProject(defence);
const names = (o) => { pushNames(o); };

names({});
check('no names: the worktree reads "<parent> ⎇ <folder>"', titleOf(lifesciProject) === 'venture ⎇ next-venture-lifesci', titleOf(lifesciProject));
check('no names: the parent reads its automatic name', titleOf(parent) === 'venture', titleOf(parent));

// the state main now stores after the user names the worktree "LifeSci"
names({ [lifesci]: 'LifeSci' });
check('a named worktree\'s tab title is the name ALONE', titleOf(lifesciProject) === 'LifeSci', titleOf(lifesciProject));
check('the parent repo\'s tab is unaffected', titleOf(parent) === 'venture', titleOf(parent));
check('the sibling worktree is unaffected', titleOf(defenceProject) === 'venture ⎇ next-venture-defence', titleOf(defenceProject));
check('the palette session name is the name alone too', sessionOf(lifesciProject, 'LifeSci') === 'LifeSci', sessionOf(lifesciProject, ''));
check('the palette name for the parent and the sibling is unchanged', sessionOf(parent, '') === 'venture' && sessionOf(defenceProject, '') === 'venture ⎇ next-venture-defence');
check('the palette still finds the named worktree by its folder name', SE.sessionSearchText({ project: lifesciProject, projectName: 'LifeSci', worktree: null, tabTitle: 'LifeSci', paneTitle: '', state: 'idle', awaitingSince: null }, 0).includes('next-venture-lifesci'));
check('the rename box on it prefills its own name, placeholder the automatic title', fieldsOf(lifesciProject).name === 'LifeSci' && fieldsOf(lifesciProject).defaultName === 'venture ⎇ next-venture-lifesci', fieldsOf(lifesciProject));
check('a rename from that tab is filed under the worktree folder', keyOf(lifesciProject) === lifesci, keyOf(lifesciProject));
check('a rename from the parent tab is filed under the root', keyOf(parent) === nv, keyOf(parent));

// a parent name does not leak into a named worktree, and still shows for an unnamed one
names({ [lifesci]: 'LifeSci', [nv]: 'Venture' });
check('with both named: parent "Venture", worktree "LifeSci"', titleOf(parent) === 'Venture' && titleOf(lifesciProject) === 'LifeSci', [titleOf(parent), titleOf(lifesciProject)]);
check('the unnamed sibling reads "Venture ⎇ next-venture-defence"', titleOf(defenceProject) === 'Venture ⎇ next-venture-defence', titleOf(defenceProject));
check('the unnamed sibling\'s box is empty with the automatic title as placeholder', fieldsOf(defenceProject).name === '' && fieldsOf(defenceProject).defaultName === 'Venture ⎇ next-venture-defence', fieldsOf(defenceProject));
check('the parent\'s box holds its name, placeholder its automatic name', fieldsOf(parent).name === 'Venture' && fieldsOf(parent).defaultName === 'venture', fieldsOf(parent));

// the rename box itself, in the real TabBar, fed by those fields
const projectRenames = [];
const bar = new TabBar(doc.getElementById('bar'), {
  onSelect() {}, onClose() {}, onNew() {}, onReorder() {}, onSettings() {}, onCheckpoint() {}, onSetFlag() {},
  onRename() {}, onRenameProject: (id, name) => projectRenames.push([id, name]),
});
const tabsFor = () => [
  { id: 'wt', title: titleOf(lifesciProject), autoTitle: titleOf(lifesciProject), project: fieldsOf(lifesciProject), active: true },
  { id: 'sib', title: titleOf(defenceProject), autoTitle: titleOf(defenceProject), project: fieldsOf(defenceProject), active: false },
];
bar.update(tabsFor());
const fire = (el, type, init = {}) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const openBox = (id) => {
  fire(doc.querySelector(`.tab-bar-tab[data-tab-id="${id}"]`), 'contextmenu', { clientX: 20, clientY: 20 });
  [...doc.querySelectorAll('.context-menu-item')].find((i) => i.textContent.trim().startsWith('Set Default Tab Name')).click();
  return doc.querySelector('.tab-bar-tab-rename');
};
let box = openBox('wt');
check('the real box on the named worktree\'s tab holds "LifeSci"', box?.value === 'LifeSci' && box.placeholder === 'Venture ⎇ next-venture-lifesci', box && [box.value, box.placeholder]);
box.value = '';
key(box, 'Enter');
check('emptying it commits "" (which main turns into removing the worktree\'s entry)', projectRenames.length === 1 && projectRenames[0][1] === '', projectRenames);
box = openBox('sib');
check('the real box on the unnamed sibling is empty, placeholder the automatic title', box?.value === '' && box.placeholder === 'Venture ⎇ next-venture-defence', box && [box.value, box.placeholder]);
key(box, 'Escape');

// clearing restores "<parent> ⎇ <folder>"
names({ [nv]: 'Venture' });
check('clearing the worktree name restores "<parent> ⎇ <folder>"', titleOf(lifesciProject) === 'Venture ⎇ next-venture-lifesci', titleOf(lifesciProject));
check('...and the palette and the box agree with the tab', sessionOf(lifesciProject, '') === titleOf(lifesciProject) && fieldsOf(lifesciProject).name === '', [sessionOf(lifesciProject, ''), fieldsOf(lifesciProject)]);

// ---- wiring (source assertions: TabManager needs xterm and cannot run headless) ----
const src = (p) => readFileSync(join(repo, p), 'utf8');
const tm = src('src/renderer/services/tab-manager.ts');
check('tab-manager files a rename under projectNameKey(project)', /projects\.setName\(projectNameKey\(project\), name\)/.test(tm));
check('tab-manager feeds the palette and the bar through project-names', /worktree: project \? projectDisplay\(project\)\.worktree : null/.test(tm) && /project: t\.project \? projectRenameFields\(t\.project\) : null/.test(tm));
check('tab-manager has no second copy of the rule (no project.worktree / defaultName reads)', !/project\??\.worktree\b/.test(tm) && !/\.defaultName/.test(tm));
check('tab.ts takes its title from project-names, not its own formatting', /projectTitle \} from '\.\.\/services\/project-names'/.test(src('src/renderer/components/tab.ts')) && !/formatProjectTitle/.test(src('src/renderer/components/tab.ts')));
check('the bookmark label uses projectName (the same rule)', /project \? projectName\(project\)/.test(src('src/renderer/components/bookmarks-panel.ts')));
const ipc = src('src/main/ipc-handlers.ts');
check('main gates PROJECT_NAME_SET with projectNameTarget', /projectNameTarget\(root\)/.test(ipc));

console.info = origInfo;
console.warn = origWarn;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
