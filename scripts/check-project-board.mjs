// Check of the project board's main-process module (src/main/project-board.ts).
// Run: node scripts/check-project-board.mjs
// Bundles the REAL module with esbuild (electron and node-pty stubbed), points
// HOME at a fresh temp folder, and drives it over fixture folders and list
// files: parsing, nesting, names, last-session times, layout validation,
// adding rows, and a round trip through the `cc` launcher's own parser when
// the launcher is installed (~/Projects/claude-launcher/launcher.sh).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const realHome = homedir();
const launcher = join(realHome, 'Projects', 'claude-launcher', 'launcher.sh');

const stubs = [
  [/^electron$/, 'module.exports = { app: { getPath: () => "/nonexistent" }, BrowserWindow: class {}, nativeTheme: {} };'],
  [/^node-pty$/, 'module.exports = { spawn: () => { throw new Error("no pty in checks"); } };'],
];

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    passed++;
    console.log('ok  ', name);
  } else {
    failed++;
    console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail));
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const root = join(dirname(process.argv[1]), '..');
  const work = mkdtempSync(join(tmpdir(), 'board-check-'));
  const out = join(work, 'board.cjs');
  await build({
    entryPoints: [join(root, 'src/main/project-board.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        for (const [filter] of stubs) b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
          for (const [filter, contents] of stubs) if (filter.test(args.path)) return { contents, loader: 'js' };
          return null;
        });
      },
    }],
  });

  // A fake home: the module reads homedir() (which follows $HOME) at call time.
  const home = join(work, 'home');
  mkdirSync(home);
  process.env.HOME = home;
  const quietLogs = [];
  console.info = (...a) => quietLogs.push(a);
  console.warn = (...a) => quietLogs.push(a);
  const m = createRequire(import.meta.url)(out);

  const P = join(home, 'Projects');
  const dir = (...parts) => {
    const p = join(P, ...parts);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

  // ── Fixture folders ──
  const alpha = dir('alpha');
  git(alpha, 'init', '-q');
  git(alpha, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(alpha, 'worktree', 'add', '-q', join(alpha, '.worktrees', 'feat'));
  const alphaDocs = dir('alpha', 'docs-site');
  const alphaDeep = dir('alpha', 'docs-site', 'deep');
  const beta = dir('beta');
  git(beta, 'init', '-q');
  git(beta, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const betaWt = join(P, 'beta-wt');
  git(beta, 'worktree', 'add', '-q', betaWt);
  const gamma = dir('gamma');
  // A hand-made `.git` file pointing into a repo that never registered it.
  const fakeWt = dir('fake-wt');
  writeFileSync(join(fakeWt, '.git'), `gitdir: ${join(beta, '.git', 'worktrees', 'nope')}\n`);
  const dotted = dir('my.app v2');

  // ── Parsing ──
  const listText = [
    '# Active Projects',
    '',
    '| Project | Path |',
    '|---------|------|',
    '| Alpha | [`~/Projects/alpha`](file://' + alpha + ') |',
    '| Alpha — Feat worktree | `~/Projects/alpha/.worktrees/feat` |',
    '| Alpha: Docs | [`~/Projects/alpha/docs-site`](file://' + alphaDocs + ') — notes with `code` after |',
    '| Deep Thing | `~/Projects/alpha/docs-site/deep` (annotation) |',
    '| Beta | `~/Projects/beta` |',
    '| Beta - wt | `~/Projects/beta-wt` |',
    '| Gamma | `' + gamma + '` |',
    '| Fake | `~/Projects/fake-wt` |',
    '| Gone | `~/Projects/gone` |',
    '| Dotted | `~/Projects/my.app v2` |',
    '| Outside | `/etc` |',
    '| Up | `~/Projects/../x` |',
    '',
    'Notes below the table. Not a row.',
    '- a list item',
    '',
  ].join('\n');
  const rows = m.parseProjectList(listText, home);
  check('parse: 12 rows (header, separator and notes skipped)', rows.length === 12, rows.length);
  check('parse: link form', same(rows[0], { name: 'Alpha', path: alpha }), rows[0]);
  check('parse: link form with annotation', same(rows[2], { name: 'Alpha: Docs', path: alphaDocs }), rows[2]);
  check('parse: plain form with annotation', same(rows[3], { name: 'Deep Thing', path: alphaDeep }), rows[3]);
  check('parse: absolute path', rows[6].path === gamma, rows[6]);
  check('parse: unterminated last line is not read (as the launcher)', m.parseProjectList('| A | `/tmp/a` |', home).length === 0);

  // The launcher's parser, on the same text: same names and paths.
  const launcherRows = (file) => {
    const outText = execFileSync('zsh', ['-c', `source "${launcher}"; CC_PROJECTS_FILE="$1"; _cc_parse_projects`, '--', file],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    return outText.split('\n').filter(Boolean).sort();
  };
  const listFile = join(home, '.claude', 'projects.md');
  mkdirSync(dirname(listFile), { recursive: true });
  writeFileSync(listFile, listText);
  const haveLauncher = existsSync(launcher);
  if (haveLauncher) {
    const ours = rows.map((r) => `${r.name}|${r.path}`).sort();
    const theirs = launcherRows(listFile);
    check('parse: matches the launcher\'s _cc_parse_projects', same(ours, theirs), { ours, theirs });
  } else {
    console.log('skip  launcher parser comparisons: no launcher at ~/Projects/claude-launcher/launcher.sh');
  }

  // ── Nesting, names, sessions ──
  const sessions = join(home, '.claude', 'projects');
  mkdirSync(join(sessions, m.claudeSlug(alpha)), { recursive: true });
  const when = new Date('2026-01-02T03:04:05Z');
  utimesSync(join(sessions, m.claudeSlug(alpha)), when, when);
  mkdirSync(join(sessions, m.claudeSlug(dotted)), { recursive: true });
  check('slug: every non-alphanumeric becomes -', m.claudeSlug('/Users/a/my.app v2_x') === '-Users-a-my-app-v2-x');
  check('slug: dot and space folder found', readdirSync(sessions).includes(m.claudeSlug(dotted)) && m.lastSessionAt(dotted, home) > 0);

  const userData = join(work, 'userData');
  mkdirSync(userData);
  const sources = { listSetting: '', userDataDir: userData };
  const board = m.loadBoard(sources);
  const byName = Object.fromEntries(board.projects.map((p) => [p.name, p]));
  check('load: list found, shown with ~', board.listFound && board.listFile === '~/.claude/projects.md', board.listFile);
  check('load: unsafe and outside rows dropped', !byName.Outside && !byName.Up);
  check('load: top-level projects in list order',
    same(board.projects.map((p) => p.name), ['Alpha', 'Beta', 'Gamma', 'Fake', 'Gone', 'Dotted']), board.projects.map((p) => p.name));
  const a = byName.Alpha;
  check('nest: Alpha holds its worktree, folder and deeper folder',
    same(a.subProjects.map((s) => [s.displayName, s.kind]), [['Feat', 'worktree'], ['Docs', 'folder'], ['Deep Thing', 'folder']]),
    a.subProjects.map((s) => [s.displayName, s.kind]));
  check('nest: the worktree sub-project is its folder', a.subProjects[0].path === join(alpha, '.worktrees', 'feat'));
  check('nest: worktree outside its repo folder sits in the repo tile',
    same(byName.Beta.subProjects.map((s) => [s.displayName, s.kind, s.path]), [['wt', 'worktree', betaWt]]), byName.Beta.subProjects);
  check('nest: a .git file the repo never registered is not a worktree', byName.Fake && byName.Fake.subProjects.length === 0);
  check('missing folder flagged', byName.Gone.missing === true && !a.missing);
  check('lastSessionAt from the session folder mtime', a.lastSessionAt === when.getTime(), a.lastSessionAt);
  check('lastSessionAt absent without a session folder', byName.Beta.lastSessionAt === undefined);
  check('display name: parent prefix with each separator',
    m.subProjectDisplayName('Alpha — X', 'Alpha') === 'X' && m.subProjectDisplayName('Alpha – X', 'Alpha') === 'X'
    && m.subProjectDisplayName('Alpha - X', 'Alpha') === 'X' && m.subProjectDisplayName('Alpha: X', 'Alpha') === 'X');
  check('display name: trailing worktree, any case', m.subProjectDisplayName('Side WORKTREE', 'Alpha') === 'Side');
  check('display name: otherwise the full name', m.subProjectDisplayName('Other', 'Alpha') === 'Other'
    && m.subProjectDisplayName('Alpha', 'Alpha') === 'Alpha');

  // ── Layout validation ──
  const long = 'N'.repeat(70);
  const v = m.validateLayout({
    version: 1,
    themes: [
      { id: 'one', name: long, tint: 'neon', projects: [alpha, '/not/listed/anywhere', 'relative/path', alpha] },
      { id: 'one', name: 'Duplicate id', tint: 'sand', projects: [] },
      { id: 'Bad Id', name: 'x', tint: 'sand', projects: [] },
      { id: 'two', name: '  Line\nbreak  ', tint: 'teal', projects: [beta] },
    ],
    tiles: { [alpha]: { wide: true, note: 'n'.repeat(120) }, 'rel': { wide: true }, [beta]: { wide: 'yes' } },
  });
  check('layout: bad tint becomes none', v.themes[0].tint === 'none');
  check('layout: long name cut to 40', v.themes[0].name.length === 40);
  check('layout: unknown paths kept, relative and repeated paths dropped',
    same(v.themes[0].projects, [alpha, '/not/listed/anywhere']), v.themes[0].projects);
  check('layout: duplicate and bad ids dropped', same(v.themes.map((t) => t.id), ['one', 'two']));
  check('layout: name made one line', v.themes[1].name === 'Line break', v.themes[1].name);
  check('layout: note cut to 80, bad tile entries dropped',
    v.tiles[alpha].note.length === 80 && v.tiles[alpha].wide === true && !v.tiles.rel && !v.tiles[beta]);
  const many = { version: 1, themes: Array.from({ length: 70 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, tint: 'sand', projects: [] })), tiles: {} };
  check('layout: at most 60 themes', m.validateLayout(many).themes.length === 60);
  const manyPaths = { version: 1, themes: [{ id: 'a', name: 'A', tint: 'sand', projects: Array.from({ length: 2500 }, (_, i) => `/p/${i}`) }], tiles: {} };
  check('layout: at most 2000 paths', m.validateLayout(manyPaths).themes[0].projects.length === 2000);
  check('layout: wrong version or shape refused', m.validateLayout({ version: 2, themes: [] }) === null
    && m.validateLayout([]) === null && m.validateLayout(null) === null);

  // ── Layout file ──
  check('layout file: missing = empty', same(m.readLayout(userData), m.emptyLayout()));
  const stored = m.saveLayout(userData, { version: 1, themes: [{ id: 'work', name: 'Work', tint: 'sand', projects: [gamma, alpha] }], tiles: {} });
  const onDisk = JSON.parse(readFileSync(join(userData, 'project-board.json'), 'utf8'));
  check('layout file: saved as plain JSON in the documented format', same(onDisk, stored) && onDisk.version === 1 && onDisk.themes[0].tint === 'sand');
  check('layout file: no temp files left', readdirSync(userData).every((f) => !f.endsWith('.tmp')), readdirSync(userData));
  const boardThemed = m.loadBoard(sources);
  check('load: layout returned with the projects', same(boardThemed.layout.themes[0].projects, [gamma, alpha]));
  writeFileSync(join(userData, 'project-board.json'), '{ not json');
  check('layout file: corrupt reads as empty', same(m.readLayout(userData), m.emptyLayout()));
  check('layout file: corrupt copied to .bad', readFileSync(join(userData, 'project-board.json.bad'), 'utf8') === '{ not json');
  m.saveLayout(userData, stored);
  check('layout file: .bad kept after the next save', existsSync(join(userData, 'project-board.json.bad')));

  // ── Adding a project ──
  const delta = dir('delta');
  const epsilon = dir('eps (two)');
  const before = readFileSync(listFile, 'utf8');
  let res = m.addProject(sources, { path: delta, name: 'Delta', themeId: 'work' });
  let after = readFileSync(listFile, 'utf8');
  const linkRow = `| Delta | [\`~/Projects/delta\`](file://${delta}) |`;
  check('add: no error', !res.error, res.error);
  check('add: link form when the file uses links', after.includes(linkRow + '\n'), after.split('\n').find((l) => l.includes('Delta')));
  check('add: inserted after the last table row, before the notes',
    after.split('\n').indexOf(linkRow) === before.split('\n').indexOf('| Up | `~/Projects/../x` |') + 1);
  check('add: every other byte preserved', after.replace(linkRow + '\n', '') === before);
  check('add: placed at the end of its theme', same(res.layout.themes[0].projects, [gamma, alpha, delta]), res.layout.themes[0].projects);
  check('add: shown in the returned board', res.projects.some((p) => p.path === delta && p.name === 'Delta'));
  res = m.addProject(sources, { path: epsilon, name: 'Eps' });
  after = readFileSync(listFile, 'utf8');
  check('add: ( and ) percent-encoded in the link', after.includes('](file://' + epsilon.replace('(', '%28').replace(')', '%29').replace(' ', '%20') + ') |'),
    after.split('\n').find((l) => l.includes('Eps')));

  const refusals = [
    ['name with |', { path: dir('r1'), name: 'A | B' }],
    ['name with a backtick', { path: dir('r2'), name: 'A `B`' }],
    ['name with ---', { path: dir('r3'), name: 'A --- B' }],
    ['name with [', { path: dir('r4'), name: 'A [B]' }],
    ['name with a line break', { path: dir('r5'), name: 'A\nB' }],
    ['empty name', { path: dir('r6'), name: '   ' }],
    ['name over 60', { path: dir('r7'), name: 'x'.repeat(61) }],
    ['path with |', { path: dir('we|ird'), name: 'Weird' }],
    ['path with a backtick', { path: dir('we`ird'), name: 'Weird' }],
    ['path with ---', { path: dir('a---b'), name: 'Weird' }],
    ['duplicate folder', { path: alpha, name: 'Alpha again' }],
    ['duplicate folder, other spelling', { path: alpha + '/', name: 'Alpha again' }],
    ['not a directory', { path: (writeFileSync(join(P, 'file.txt'), 'x'), join(P, 'file.txt')), name: 'File' }],
    ['missing folder', { path: join(P, 'nope'), name: 'Nope' }],
    ['relative path', { path: 'Projects/alpha', name: 'Rel' }],
    ['traversal', { path: P + '/../Projects/zeta', name: 'Up' }],
    ['outside the allowed folders', { path: '/etc', name: 'Etc' }],
    ['not an object', 'nope'],
  ];
  const beforeRefusals = readFileSync(listFile, 'utf8');
  for (const [label, req] of refusals) {
    const r = m.addProject(sources, req);
    check(`add refused: ${label}`, typeof r.error === 'string' && r.error.length > 0, r.error);
  }
  check('add refused: list file untouched by refusals', readFileSync(listFile, 'utf8') === beforeRefusals);

  // Plain form; a table that ends the file without a newline.
  const plainFile = join(work, 'plain.md');
  const plainText = '| Project | Path |\n|---|---|\n| Gamma | `' + gamma + '` |';
  writeFileSync(plainFile, plainText);
  const plainSources = { listSetting: plainFile, userDataDir: userData };
  res = m.addProject(plainSources, { path: delta, name: 'Delta' });
  const plainAfter = readFileSync(plainFile, 'utf8');
  check('add: plain form when no row has a link', plainAfter === plainText + '\n| Delta | `~/Projects/delta` |\n', plainAfter);
  check('add: setting path to another list file', res.listFile === plainFile && res.projects.length === 2);
  check('add: refused when the list file is absent',
    typeof m.addProject({ listSetting: join(work, 'none.md'), userDataDir: userData }, { path: delta, name: 'D' }).error === 'string');
  check('load: absent list file → listFound false', m.loadBoard({ listSetting: join(work, 'none.md'), userDataDir: userData }).listFound === false);
  check('load: unsafe list setting → listFound false', m.loadBoard({ listSetting: 'relative.md', userDataDir: userData }).listFound === false);

  // Round trip through the launcher's parser: new rows come back, old rows unchanged.
  if (haveLauncher) {
    writeFileSync(listFile, listText);
    const beforeRows = launcherRows(listFile);
    m.addProject(sources, { path: delta, name: 'Delta' });
    m.addProject(sources, { path: epsilon, name: 'Eps (two)' });
    const afterRows = launcherRows(listFile);
    check('round trip: launcher reads the new rows',
      afterRows.includes(`Delta|${delta}`) && afterRows.includes(`Eps (two)|${epsilon}`), afterRows);
    check('round trip: every old row unchanged', beforeRows.every((r) => afterRows.includes(r)) && afterRows.length === beforeRows.length + 2);
    const plainRows = launcherRows(plainFile);
    check('round trip: plain-form file', same(plainRows, [`Delta|${delta}`, `Gamma|${gamma}`].sort()), plainRows);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
