// Check that a project registered in the project list lying inside a git repo
// is its own project (a standalone), not the repo's: src/main/projects.ts
// resolveProject + src/main/registered-projects.ts, and the open-project step
// that decides "go to an existing session" or "new tab".
// Run: node scripts/check-sub-project.mjs
// Bundles the REAL modules with esbuild (electron and node-pty stubbed), points
// HOME at a fresh temp folder with fixture repos, a linked git worktree and a
// project list, and never opens a window or touches Patton's settings.
// A source assertion at the end checks the production wiring in ipc-handlers.ts.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

const stubs = [
  [/^electron$/, 'module.exports = { app: { getPath: () => "/nonexistent" }, BrowserWindow: class {}, nativeTheme: {} };'],
  [/^node-pty$/, 'module.exports = { spawn: () => { throw new Error("no pty in checks"); } };'],
];
const stubPlugin = {
  name: 'stubs',
  setup(b) {
    for (const [filter] of stubs) b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      for (const [filter, contents] of stubs) if (filter.test(args.path)) return { contents, loader: 'js' };
      return null;
    });
  },
};

async function main() {
  const repo = join(dirname(process.argv[1]), '..');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'sub-project-check-')));
  const home = join(work, 'home');
  mkdirSync(home);
  process.env.HOME = home;
  const logs = [];
  console.info = (...a) => logs.push(a);
  console.warn = (...a) => logs.push(a);

  await build({
    stdin: {
      contents: "export * from './src/main/projects'; export * from './src/main/registered-projects';",
      resolveDir: repo, loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'main.mjs'), logLevel: 'error', plugins: [stubPlugin],
  });
  const m = await import(pathToFileURL(join(work, 'main.mjs')).href);

  // Fixtures: ~/Projects/pf is a git repo holding the registered sub-projects
  // stocks-and-shares and em (not repos of their own) and an unregistered
  // folder `other`; ~/Projects/pf-old is a sibling repo whose name starts like
  // pf; ~/Projects/loose is not a repo; ~/Projects/real/deep is a sub-project
  // of the repo ~/Projects/real reached through the symlink ~/Projects/link.
  const projects = join(home, 'Projects');
  const pf = join(projects, 'pf');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
  mkdirSync(join(pf, 'stocks-and-shares', 'scripts', 'deep'), { recursive: true });
  mkdirSync(join(pf, 'em'), { recursive: true });
  mkdirSync(join(pf, 'other', 'x'), { recursive: true });
  git(pf, 'init', '-q');
  writeFileSync(join(pf, 'a.txt'), 'a');
  git(pf, 'add', '.');
  git(pf, 'commit', '-q', '-m', 'init');
  const wt = join(work, 'pf-worktree');
  git(pf, 'worktree', 'add', '-q', wt, '-b', 'feat');
  mkdirSync(join(projects, 'loose', 'sub'), { recursive: true });
  const pfOld = join(projects, 'pf-old');
  mkdirSync(join(pfOld, 'stocks-and-shares'), { recursive: true });
  git(pfOld, 'init', '-q');
  const realRepo = join(projects, 'real');
  mkdirSync(join(realRepo, 'deep', 'x'), { recursive: true });
  git(realRepo, 'init', '-q');
  symlinkSync(realRepo, join(projects, 'link'));
  const stocks = join(pf, 'stocks-and-shares');
  const em = join(pf, 'em');
  symlinkSync(em, join(pf, 'em-link'));

  const listFile = join(home, '.claude', 'projects.md');
  mkdirSync(dirname(listFile), { recursive: true });
  const writeList = (rows) => writeFileSync(listFile, ['| Project | Path |', '|---|---|', ...rows, ''].join('\n'));
  writeList([
    '| Personal Finances | `~/Projects/pf` |',
    '| Personal Finances — Stocks and Shares | `~/Projects/pf/stocks-and-shares` |',
    '| Personal Finances — Em | [`~/Projects/pf/em`](file:///x) |',
    '| Gone | `~/Projects/pf/not-there` |',
    '| Loose | `~/Projects/loose` |',
  ]);
  const root = (cwd) => m.resolveProject(cwd)?.root ?? null;

  // Before the source is wired: today's behaviour.
  check('no source set: sub-project folder resolves to the repo', root(stocks) === pf, root(stocks));

  const wire = (setting = '') => { m.setProjectListSetting(setting); m.setRegisteredProjects(() => m.registeredProjects()); };
  const wireRows = (rows) => m.setRegisteredProjects(() => rows.map((r) => m.toRegisteredProject(r)).filter(Boolean));
  wire();
  check('sub-project folder resolves to the sub-project', root(stocks) === stocks, root(stocks));
  check('its project name comes from the sub-project folder', m.resolveProject(stocks)?.defaultName === 'shares');
  check('a deeper folder inside it resolves to the sub-project', root(join(stocks, 'scripts', 'deep')) === stocks);
  check('the second sub-project (link-form row) resolves to itself', root(em) === em, root(em));
  check('the parent folder still resolves to the parent', root(pf) === pf, root(pf));
  check('an unregistered subfolder of the repo resolves to the repo', root(join(pf, 'other', 'x')) === pf);
  check('a registered row that does not exist changes nothing', root(join(pf, 'not-there')) === pf);
  check('a not-yet-existing folder under a sub-project still resolves to it', root(join(stocks, 'new-folder')) === stocks);
  check('a non-repo project under ~/Projects is unchanged', root(join(projects, 'loose', 'sub')) === join(projects, 'loose'));
  check('a folder outside every repo and Projects is still no project', root(work) === null);
  check('a sibling whose name starts like a sub-project is not inside it',
    (mkdirSync(join(pf, 'stocks-and-shares-old')), root(join(pf, 'stocks-and-shares-old')) === pf));

  const wtInfo = m.resolveProject(wt);
  check('a linked worktree of the repo still belongs to the repo, with its worktree',
    wtInfo?.root === pf && wtInfo?.worktree?.name === 'pf-worktree', wtInfo);
  const wtSub = m.resolveProject(join(wt, 'stocks-and-shares'));
  check('a folder inside the worktree resolves as before (the repo, with its worktree)', wtSub?.root === pf && !!wtSub?.worktree, wtSub);

  const overrideLogs = logs.filter((l) => l[0] === '[PROJECTS] Registered sub-project overrides the repo root');
  const before = overrideLogs.length;
  root(stocks); root(stocks);
  check('the override is logged once per path', logs.filter((l) => l[0] === '[PROJECTS] Registered sub-project overrides the repo root').length === before, { before });
  check('the log line names the cwd, the repo and the project',
    overrideLogs.some((l) => l[1]?.cwd === stocks && l[1]?.repo === pf && l[1]?.project === stocks), overrideLogs.map((l) => l[1]));

  wireRows([join(pf, 'em-link')]);
  check('a registered symlink to a folder inside the repo: real paths compared, the root is the path as listed',
    root(em) === join(pf, 'em-link') && root(join(pf, 'em-link', 'x')) === join(pf, 'em-link'), [root(em), root(join(pf, 'em-link', 'x'))]);
  wire();

  // Repo-level sibling prefix: a registered row in `pf-old` is not inside `pf`, nor `pf` inside it.
  const oldSub = join(pfOld, 'stocks-and-shares');
  check('a sibling repo whose name starts like the parent is its own repo', root(oldSub) === pfOld, root(oldSub));
  wireRows([join(pf, 'stocks-and-shares')]);
  check('a sub-project row in pf does not capture the pf-old sibling', root(oldSub) === pfOld && root(stocks) === stocks);
  wireRows([oldSub]);
  check('a row in pf-old does not capture pf or its sub-project', root(stocks) === pf && root(oldSub) === oldSub, [root(stocks), root(oldSub)]);
  wire();

  // Case: the volume is case-insensitive, so a row typed in another case still names the folder.
  const caseInsensitive = (() => { try { statSync(join(pf, 'STOCKS-AND-SHARES')); return true; } catch { return false; } })();
  if (caseInsensitive) {
    wireRows([join(pf, 'STOCKS-and-Shares')]);
    check('a row typed in a different case still registers the sub-project (root as listed)', root(stocks) === join(pf, 'STOCKS-and-Shares'), root(stocks));
    wire();
    check('a cwd typed in a different case resolves to the sub-project as listed',
      root(join(pf, 'Stocks-And-Shares', 'scripts')) === stocks, root(join(pf, 'Stocks-And-Shares', 'scripts')));
    wire();
  } else console.log('skip  case-insensitivity checks (this volume is case-sensitive)');

  // Symlinked ancestor: the repo is reached through a link, the row through the real path (and the reverse).
  const realDeep = join(realRepo, 'deep');
  wireRows([realDeep]);
  check('a cwd under a symlinked ancestor resolves to the registered sub-project', root(join(projects, 'link', 'deep', 'x')) === realDeep, root(join(projects, 'link', 'deep', 'x')));
  wireRows([join(projects, 'link', 'deep')]);
  check('a row under a symlinked ancestor matches a cwd under the real path', root(join(realDeep, 'x')) === join(projects, 'link', 'deep'), root(join(realDeep, 'x')));
  wire();

  // The list is re-read when the file changes, not on every call.
  writeList(['| Personal Finances | `~/Projects/pf` |']);
  utimesSync(listFile, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  check('a list without the sub-project: the repo again, after the file changed', root(stocks) === pf, root(stocks));
  writeList(['| Personal Finances | `~/Projects/pf` |', '| S | `~/Projects/pf/stocks-and-shares` |']);
  utimesSync(listFile, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
  check('the sub-project row added back is picked up', root(stocks) === stocks, root(stocks));

  // Same size, mtime put back: ctime and inode still change, so the rewrite is seen.
  const swapList = (text, how) => {
    const mtime = statSync(listFile).mtime;
    const tmp = `${listFile}.new`;
    writeFileSync(tmp, text);
    utimesSync(tmp, mtime, mtime);
    if (how === 'rename') renameSync(tmp, listFile);
    else { copyFileSync(tmp, listFile); rmSync(tmp); utimesSync(listFile, mtime, mtime); }
  };
  const sameSize = (rows) => ['| Project | Path |', '|---|---|', ...rows, ''].join('\n');
  const rowsA = ['| P | `~/Projects/pf` |', '| S | `~/Projects/pf/stocks-and-shares` |'];
  const rowsB = ['| P | `~/Projects/pf` |', '| S | `~/Projects/pf/stocks-and-sharez` |'];
  mkdirSync(join(pf, 'stocks-and-sharez'), { recursive: true });
  swapList(sameSize(rowsA), 'copy');
  check('(setup) list names the sub-project', root(stocks) === stocks);
  const sub2 = join(pf, 'stocks-and-sharez');
  const statBefore = statSync(listFile);
  swapList(sameSize(rowsB), 'rename');
  const statAfter = statSync(listFile);
  check('(setup) the replacement keeps the size and the mtime', statAfter.size === statBefore.size && statAfter.mtimeMs === statBefore.mtimeMs, [statBefore.size, statAfter.size, statBefore.mtimeMs, statAfter.mtimeMs]);
  check('a same-size, same-mtime rename-replace is picked up (inode/ctime in the key)', root(stocks) === pf && root(sub2) === sub2, [root(stocks), root(sub2)]);
  swapList(sameSize(rowsA), 'copy');
  check('a same-size, same-mtime in-place rewrite is picked up (ctime in the key)', root(stocks) === stocks && root(sub2) === pf, [root(stocks), root(sub2)]);
  rmSync(join(pf, 'stocks-and-sharez'), { recursive: true });

  // A setting naming another list file; a missing, directory or unreadable list.
  rmSync(listFile);
  check('missing list file: the old result', root(stocks) === pf, root(stocks));
  mkdirSync(listFile);
  check('list path is a folder: the old result', root(stocks) === pf, root(stocks));
  rmSync(listFile, { recursive: true });
  m.setRegisteredProjects(() => { throw new Error('boom'); });
  check('a failing source: the old result', root(stocks) === pf, root(stocks));
  root(stocks); root(stocks);
  check('a failing source warns once, not on every call', logs.filter((l) => String(l[0]).includes('Registered project list unavailable')).length === 1);
  wire(join(work, 'nowhere', 'list.md'));
  check('a setting naming a missing file: the old result', root(stocks) === pf);
  wireRows(['relative/path', '/x/../y', `${stocks}`]);
  check('unsafe registered paths are skipped, a good one still counts', root(stocks) === stocks);

  // A setting naming a second, existing list file decides which list is read
  // (so `cache.file === file` matters), and a change of setting switches at once.
  const list2 = join(work, 'other-list.md');
  writeFileSync(list2, ['| Project | Path |', '|---|---|', '| Em | `~/Projects/pf/em` |', ''].join('\n'));
  writeList(['| P | `~/Projects/pf` |', '| S | `~/Projects/pf/stocks-and-shares` |']);
  wire();
  check('default list: stocks-and-shares registered, em not', root(stocks) === stocks && root(em) === pf, [root(stocks), root(em)]);
  wire(list2);
  check('setting names a second list: its rows apply, the default list\'s do not', root(em) === em && root(stocks) === pf, [root(em), root(stocks)]);
  m.setProjectListSetting('~/.claude/projects.md');
  check('the tilde form of the default list switches back', root(stocks) === stocks && root(em) === pf);
  wire();

  // Problems with the list are logged once per file and reason, not per call.
  const problemLogs = () => logs.filter((l) => l[0] === '[PROJECTS] Registered project list gives no projects');
  const p0 = problemLogs().length;
  wire(join(work, 'absent.md'));
  root(stocks); root(stocks); root(stocks);
  check('an unreadable list is logged once', problemLogs().length === p0 + 1 && problemLogs().at(-1)[1].reason === 'unreadable', problemLogs().slice(p0).map((l) => l[1]));
  const big = join(work, 'big.md');
  writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
  wire(big);
  root(stocks); root(stocks);
  check('an oversize list is logged once', problemLogs().length === p0 + 2 && problemLogs().at(-1)[1].reason === 'too large', problemLogs().slice(p0).map((l) => l[1]));
  const empty = join(work, 'empty.md');
  writeFileSync(empty, '| Project | Path |\n|---|---|\n| Gone | `~/Projects/nowhere` |\n');
  wire(empty);
  root(stocks); root(stocks);
  check('a list with no usable rows is logged once', problemLogs().length === p0 + 3 && problemLogs().at(-1)[1].reason === 'no usable rows', problemLogs().slice(p0).map((l) => l[1]));
  wire();

  // The lookup does not stat or realpath each row: with 300 rows, each lookup stays fast.
  const manyRows = Array.from({ length: 300 }, (_, i) => `| P${i} | \`~/Projects/pf/em\` |`);
  writeList(['| P | `~/Projects/pf` |', ...manyRows]);
  root(stocks);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) root(stocks);
  const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  check('a warm lookup with 300 rows is well under the 4 ms the settings store cost', perCallMs < 1, perCallMs);

  // --- openProject: a session in the sub-project is not an open session of the parent ---
  m.setRegisteredProjects(null);
  const oldProject = m.resolveProject(join(stocks, 'scripts'));
  wireRows([stocks, em]);
  const newProject = m.resolveProject(join(stocks, 'scripts'));
  await build({
    entryPoints: [join(repo, 'src/renderer/services/open-project.ts')],
    bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'open.mjs'), logLevel: 'error',
  });
  globalThis.window = { patton: { settings: { get: async () => ({ startupCommand: '' }) } } };
  const op = await import(pathToFileURL(join(work, 'open.mjs')).href);

  const session = (project, cwd) => ({
    tabId: 't1', paneId: 'p1', tabIndex: 1, paneCount: 1, project, projectName: 'x', worktree: null, cwd,
    tabTitle: 'x', hasCustomTitle: false, paneTitle: '', state: 'idle', awaitingSince: null,
  });
  const makeHost = (sessions) => {
    const calls = { went: [], created: [] };
    const tab = { id: 't1', project: sessions[0]?.project ?? null, panes: sessions.map((s) => ({ getCwd: () => s.cwd })) };
    return {
      calls,
      host: {
        getTabs: () => (sessions.length ? [tab] : []), getActiveTab: () => null, switchToTab: () => {},
        createTab: async (cwd) => { calls.created.push(cwd); return { id: 'new', project: null, panes: [] }; },
        listSessions: () => sessions,
        goToSession: (t, p) => { calls.went.push([t, p]); return true; },
        focusTerminal: () => {},
      },
    };
  };
  const cwd = join(stocks, 'scripts');
  const before1 = makeHost([session(oldProject, cwd)]);
  const r1 = await op.openProject(before1.host, pf, '[T]', 'Personal Finances');
  check('control (old root): the parent opens onto the sub-project session', r1.action === 'went to existing session', r1.action);
  const after1 = makeHost([session(newProject, cwd)]);
  const r2 = await op.openProject(after1.host, pf, '[T]', 'Personal Finances');
  check('sub-project session present: opening the parent makes a new tab', r2.action === 'new tab' && after1.calls.created[0] === pf && after1.calls.went.length === 0, r2.action);
  const r3 = await op.openProject(makeHost([session(newProject, cwd)]).host, stocks, '[T]', 'Stocks');
  check('opening the sub-project still goes to its own session', r3.action === 'went to existing session', r3.action);
  const r4 = await op.openProject(makeHost([session(m.resolveProject(pf), pf)]).host, stocks, '[T]', 'Stocks');
  check('a parent session present: opening the sub-project makes a new tab', r4.action === 'new tab', r4.action);

  // --- Production wiring (source assertions, as check-pty-respawn.mjs does for its handlers) ---
  const ipc = readFileSync(join(repo, 'src/main/ipc-handlers.ts'), 'utf8');
  const afterSaved = ipc.slice(ipc.indexOf('function afterSettingsSaved'), ipc.indexOf('// --- Notes scratchpad'));
  check('wiring: handlers register the registered-project source', ipc.includes('setRegisteredProjects(() => registeredProjects())'));
  check('wiring: the list-file setting is set once when the handlers register',
    /setProjectListSetting\(store\.getSettings\(\)\.projectListFile\);\s*\n\s*setRegisteredProjects\(/.test(ipc));
  check('wiring: a saved projectListFile updates it (afterSettingsSaved)',
    /'projectListFile' in saved/.test(afterSaved) && /setProjectListSetting\(store\.getSettings\(\)\.projectListFile\)/.test(afterSaved));
  check('wiring: a lookup never reads the settings store (no getSettings inside the source callback)',
    !/setRegisteredProjects\(\(\) => [^\n]*getSettings/.test(ipc));

  rmSync(work, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
