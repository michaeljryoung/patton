// Headless check of the project board's renderer component
// (src/renderer/components/project-board.ts), driving the REAL component in jsdom.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-project-board-ui.mjs
//   (or pass that folder as the first argument). jsdom is not a project
//   dependency: install it in a scratch folder (`npm i jsdom`), never here.
// Bundles the component with esbuild (CSS as empty), evaluates it inside a jsdom
// window with a stub `window.patton.board`, and dispatches real DOM events.
// jsdom does no layout (every rect is 0), so "before/after" in a drag is chosen
// with clientX/clientY of -1 or 1.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  entryPoints: [join(repo, 'src/renderer/components/project-board.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'PB',
  platform: 'browser',
  write: false,
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const code = bundle.outputFiles[0].text;

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
// A promise the board leaves unhandled is a failure, not a crash that hides the rest.
process.on('unhandledRejection', (err) => {
  failed++;
  console.log('FAIL unhandled rejection', String(err));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAVE_WAIT = 380;

// ── Fixture: generic names and temp paths only ──
const NOW = Date.now();
const P = (name) => `/tmp/pb/${name}`;
function fixture() {
  return {
    listFile: '~/tmp/projects.md',
    listFound: true,
    projects: [
      {
        path: P('alpha'), name: 'Alpha', lastSessionAt: NOW - 3 * 60 * 60 * 1000,
        subProjects: [
          { path: P('alpha-wt'), name: 'Alpha feature worktree', displayName: 'feature', kind: 'worktree', lastSessionAt: NOW - 20 * 3600e3 },
          { path: P('alpha/docs'), name: 'Docs', displayName: 'docs', kind: 'folder' },
        ],
      },
      { path: P('beta'), name: 'Beta', lastSessionAt: NOW - 4 * 3600e3, subProjects: [] },
      { path: P('gamma'), name: 'Gamma', lastSessionAt: NOW - 3 * 7 * 24 * 3600e3, subProjects: [] },
      { path: P('zeta'), name: 'Zeta', subProjects: [] },
      { path: P('delta'), name: 'Delta', lastSessionAt: NOW - 2 * 24 * 3600e3 - 1000, subProjects: [] },
      { path: P('epsilon'), name: 'Epsilon', missing: true, subProjects: [] },
    ],
    layout: {
      version: 1,
      themes: [
        { id: 'work', name: 'Work', tint: 'sand', projects: [P('alpha'), P('gone-unknown'), P('beta')] },
        { id: 'home', name: 'Home', tint: 'teal', projects: [P('gamma'), P('zeta')] },
        { id: 'empty', name: 'Empty', tint: 'none', projects: [] },
      ],
      tiles: { [P('gamma')]: { wide: true, note: 'a short note' } },
    },
  };
}

const CLOSED = { isOpen: false, isCurrent: false, open: 0, waiting: 0, parked: 0, working: 0 };

function setup(payload = fixture(), opts = {}) {
  const logs = [];
  const vc = new VirtualConsole();
  for (const level of ['info', 'warn', 'error']) vc.on(level, (...args) => logs.push([level, args.map(String).join(' ')]));
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  if (!win.CSS) win.CSS = {};
  if (!win.CSS.escape) win.CSS.escape = (s) => String(s).replace(/["\\]/g, '\\$&');
  const calls = { open: [], dismiss: 0, setLayout: [], generations: [], pick: 0, add: [] };
  const live = new Map(Object.entries({
    [P('alpha')]: { ...CLOSED, isOpen: true, open: 1, working: 1 },
    [P('beta')]: { ...CLOSED, isOpen: true, open: 1, waiting: 1 },
    [P('gamma')]: { ...CLOSED, isOpen: true, isCurrent: true, open: 1 },
    [P('alpha-wt')]: { ...CLOSED, isOpen: true, open: 1, waiting: 1 },
  }));
  win.patton = {
    board: {
      get: async () => fixture(),
      setLayout: async (layout, generation) => {
        calls.setLayout.push(JSON.parse(JSON.stringify(layout)));
        calls.generations.push(generation);
        if (opts.setLayout) return opts.setLayout(layout, calls.setLayout.length);
        return opts.refuseSave ? null : layout;
      },
      pickFolder: async () => {
        calls.pick++;
        if (opts.pickFolder) return opts.pickFolder();
        return opts.pick ?? null;
      },
      addProject: async (req) => {
        calls.add.push(req);
        return opts.addResult ? opts.addResult(req) : fixture();
      },
      onChanged: () => () => {},
    },
  };
  win.eval(code);
  const host = {
    openProject: (path) => {
      calls.open.push(path);
      return opts.openProject ? opts.openProject(path) : undefined;
    },
    dismiss: () => calls.dismiss++,
    liveState: (path) => live.get(path) ?? CLOSED,
  };
  const board = new win.PB.ProjectBoard(host, payload);
  win.document.body.appendChild(board.element);
  const el = board.element;
  const q = (sel) => el.querySelector(sel);
  const qa = (sel) => Array.from(el.querySelectorAll(sel));
  const tile = (name) => q(`.pb-tile[data-path="${P(name)}"]`);
  const areaIds = () => qa('.pb-area').map((a) => a.dataset.areaId);
  const tilesIn = (id) => qa(`.pb-area[data-area-id="${id}"] .pb-tile`).map((t) => t.dataset.path.replace('/tmp/pb/', ''));
  const metaOf = (name) => tile(name)?.querySelector('.pb-meta');
  const key = (target, k, extra = {}) => target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const click = (target) => target.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const dragEvent = (type, target, x = 0, y = 0) => {
    const e = new win.Event(type, { bubbles: true, cancelable: true });
    const data = {};
    Object.defineProperty(e, 'dataTransfer', {
      value: { effectAllowed: '', dropEffect: '', types: [], setData: (t, v) => { data[t] = v; }, getData: (t) => data[t] ?? '' },
    });
    Object.defineProperty(e, 'clientX', { value: x });
    Object.defineProperty(e, 'clientY', { value: y });
    Object.defineProperty(e, 'relatedTarget', { value: null });
    target.dispatchEvent(e);
    return e;
  };
  const drag = (source, target, x = 0, y = 0) => {
    dragEvent('dragstart', source);
    dragEvent('dragover', target, x, y);
    dragEvent('drop', target, x, y);
    dragEvent('dragend', source);
  };
  const menuItems = () => Array.from(win.document.querySelectorAll('.context-menu-overlay.visible .context-menu-item'));
  const menuLabels = () => menuItems().map((i) => i.textContent);
  const menuClick = (label) => {
    const item = menuItems().find((i) => i.textContent.replace(/^✓ /, '') === label);
    if (!item) throw new Error(`no menu item ${label}; have ${menuLabels().join(', ')}`);
    click(item);
  };
  const contextMenu = (target) => target.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const lastSaved = () => calls.setLayout[calls.setLayout.length - 1];
  const themeOf = (layout, id) => layout.themes.find((t) => t.id === id);
  const announced = () => Array.from(win.document.querySelectorAll('[aria-live]')).map((r) => r.textContent).join(' | ');
  return { win, board, el, q, qa, tile, areaIds, tilesIn, metaOf, key, click, dragEvent, drag, menuLabels, menuClick, contextMenu, calls, live, logs, lastSaved, themeOf, announced };
}

// ── 1. Rendering from the fixture ──
{
  const t = setup();
  check('root is a region labelled Projects', t.el.getAttribute('role') === 'region' && t.el.getAttribute('aria-label') === 'Projects');
  check('count includes sub-projects (6 + 2)', t.q('.pboard-count').textContent === '8', t.q('.pboard-count').textContent);
  check('areas in theme order, Unsorted last', JSON.stringify(t.areaIds()) === JSON.stringify(['work', 'home', 'empty', '__unsorted']), t.areaIds());
  check('Work shows alpha, beta (unknown path not drawn)', JSON.stringify(t.tilesIn('work')) === '["alpha","beta"]', t.tilesIn('work'));
  check('Unsorted holds the unplaced projects', JSON.stringify(t.tilesIn('__unsorted')) === '["delta","epsilon"]', t.tilesIn('__unsorted'));
  check('areas are groups with a heading', t.qa('.pb-area').every((a) => a.getAttribute('role') === 'group' && a.querySelector('h2')?.id === a.getAttribute('aria-labelledby')));
  check('area head: swatch, name, count', t.q('.pb-area[data-area-id="work"] .pb-swatch') && t.q('.pb-area[data-area-id="work"] .pb-area-name').textContent === 'Work' && t.q('.pb-area[data-area-id="work"] .pb-area-count').textContent === '2');
  check('area carries its tint', t.q('.pb-area[data-area-id="home"]').dataset.tint === 'teal' && t.q('.pb-area[data-area-id="__unsorted"]').dataset.tint === 'none');
  check('Unsorted has no menu and does not drag', !t.q('.pb-area[data-area-id="__unsorted"] .pb-area-menu') && !t.q('.pb-area[data-area-id="__unsorted"] .pb-area-head').draggable);
  const alpha = t.tile('alpha');
  check('parent tile with sub-projects is wide', alpha.classList.contains('wide'));
  const chips = Array.from(alpha.querySelectorAll('.pb-chip'));
  check('sub-projects shown as chips inside the parent', chips.length === 2);
  check('worktree chip has the branch glyph', chips[0].textContent.startsWith('⎇ feature'), chips[0].textContent);
  check('folder chip has no glyph', chips[1].textContent.startsWith('docs'), chips[1].textContent);
  check('chip shows its own live state', chips[0].textContent.includes('needs you') && chips[1].textContent.includes('no sessions'), chips.map((c) => c.textContent));
  check('tile option wide makes a tile wide', t.tile('gamma').classList.contains('wide') && !t.tile('beta').classList.contains('wide'));
  check('note shown on the tile', t.tile('gamma').querySelector('.pb-note')?.textContent === 'a short note');
  check('state: working', t.metaOf('alpha').textContent === 'working', t.metaOf('alpha').textContent);
  check('state: needs you with a green dot', t.metaOf('beta').textContent === 'needs you' && t.metaOf('beta').classList.contains('needs') && t.metaOf('beta').querySelector('.pb-dot'));
  check('state: open here with a blue dot', t.metaOf('gamma').textContent === 'open here' && t.metaOf('gamma').classList.contains('is-open') && t.metaOf('gamma').querySelector('.pb-dot'));
  check('current tab project has the ink edge', t.tile('gamma').classList.contains('is-current') && !t.tile('beta').classList.contains('is-current'));
  check('state: age in days', t.metaOf('delta').textContent === '2 d ago', t.metaOf('delta').textContent);
  check('state: no sessions yet', t.metaOf('zeta').textContent === 'no sessions yet', t.metaOf('zeta').textContent);
  check('missing tile is dimmed', t.tile('epsilon').classList.contains('is-missing') && t.tile('epsilon').querySelector('.pb-tile-main').getAttribute('aria-disabled') === 'true');
  const label = t.tile('beta').querySelector('.pb-tile-main').getAttribute('aria-label');
  check('tile label has name, theme and state', label === 'Beta, Work, needs you', label);
  check('tiles are focusable buttons', t.qa('.pb-tile-main').every((b) => b.tagName === 'BUTTON'));
  check('header buttons present', ['+ Theme', '+ Project', 'Plain terminal'].every((s) => t.qa('.pboard-btn').some((b) => b.textContent === s)));
  check('search field labelled', t.q('.pboard-search').placeholder === 'Find a project');

  // Ages in hours and weeks
  const w = t.win.PB.ageText;
  check('age text: hours, weeks, under an hour', w(NOW - 4 * 3600e3, NOW) === '4 h ago' && w(NOW - 21 * 24 * 3600e3, NOW) === '3 wk ago' && w(NOW - 60e3, NOW) === 'under 1 h ago', [w(NOW - 4 * 3600e3, NOW), w(NOW - 21 * 24 * 3600e3, NOW)]);

  // refreshLiveState in place
  const before = t.tile('delta');
  t.live.set(P('delta'), { ...CLOSED, isOpen: true, open: 1, waiting: 2 });
  t.board.refreshLiveState();
  check('refreshLiveState updates the line in place', t.tile('delta') === before && t.metaOf('delta').textContent === 'needs you');

  // Opening
  t.click(t.tile('beta').querySelector('.pb-tile-main'));
  t.key(t.tile('zeta').querySelector('.pb-tile-main'), 'Enter');
  t.click(t.tile('epsilon').querySelector('.pb-tile-main'));
  t.click(t.tile('alpha').querySelector('.pb-chip'));
  check('click and Enter open; missing does not; chip opens the sub-project',
    JSON.stringify(t.calls.open) === JSON.stringify([P('beta'), P('zeta'), P('alpha-wt')]), t.calls.open);
  check('Plain terminal dismisses', (t.click(t.qa('.pboard-btn').find((b) => b.textContent === 'Plain terminal')), t.calls.dismiss === 1));
}

// ── 2. Unsorted only when needed; empty states ──
{
  const p = fixture();
  p.projects = p.projects.filter((x) => ['alpha', 'beta', 'gamma', 'zeta'].includes(x.path.replace('/tmp/pb/', '')));
  const t = setup(p);
  check('no Unsorted area when everything is placed', !t.areaIds().includes('__unsorted'), t.areaIds());

  const nf = setup({ ...fixture(), listFound: false, projects: [] });
  check('list not found: message names the file and the setting',
    nf.q('.pboard-empty')?.textContent === 'No project list at ~/tmp/projects.md. Set one in Settings → Project list file.', nf.q('.pboard-empty')?.textContent);
  const empty = setup({ ...fixture(), projects: [], layout: { version: 1, themes: [], tiles: {} } });
  check('list empty: a message', /empty/.test(empty.q('.pboard-empty')?.textContent ?? ''), empty.q('.pboard-empty')?.textContent);
}

// ── 3. Drag a tile to another area, before a tile; unknown paths keep their place ──
{
  const t = setup();
  const target = t.tile('gamma').querySelector('.pb-name');
  t.dragEvent('dragstart', t.tile('beta'));
  t.dragEvent('dragover', target, 0, -1);
  check('insertion line shown on the target tile (wide: above)', t.tile('gamma').classList.contains('drop-before'));
  t.dragEvent('drop', target, 0, -1);
  t.dragEvent('dragend', t.tile('beta'));
  check('beta drawn first in Home', JSON.stringify(t.tilesIn('home')) === '["beta","gamma","zeta"]', t.tilesIn('home'));
  await sleep(SAVE_WAIT);
  const saved = t.lastSaved();
  check('one save after the drag', t.calls.setLayout.length === 1, t.calls.setLayout.length);
  check('saved Home order', JSON.stringify(t.themeOf(saved, 'home').projects) === JSON.stringify([P('beta'), P('gamma'), P('zeta')]), t.themeOf(saved, 'home').projects);
  check('unknown path kept in place in Work', JSON.stringify(t.themeOf(saved, 'work').projects) === JSON.stringify([P('alpha'), P('gone-unknown')]), t.themeOf(saved, 'work').projects);
  check('drop marks cleared', t.qa('.drop-before, .drop-after, .drop-into').length === 0);

  // Narrow tile, after (clientX 1) within the same area
  t.drag(t.tile('alpha'), t.tile('beta').querySelector('.pb-tile-main'), 1, 0);
  await sleep(SAVE_WAIT);
  check('drag after a narrow tile: Home order', JSON.stringify(t.themeOf(t.lastSaved(), 'home').projects) === JSON.stringify([P('beta'), P('alpha'), P('gamma'), P('zeta')]), t.themeOf(t.lastSaved(), 'home').projects);
  check('Work keeps only the unknown path', JSON.stringify(t.themeOf(t.lastSaved(), 'work').projects) === JSON.stringify([P('gone-unknown')]));

  // Onto an area head: append
  const head = t.q('.pb-area[data-area-id="empty"] .pb-area-head .pb-area-name');
  t.dragEvent('dragstart', t.tile('delta'));
  t.dragEvent('dragover', head);
  check('area head shows the drop-into outline', t.q('.pb-area[data-area-id="empty"]').classList.contains('drop-into'));
  t.dragEvent('drop', head);
  t.dragEvent('dragend', t.tile('delta'));
  t.drag(t.tile('zeta'), t.q('.pb-area[data-area-id="empty"] .pb-area-head'));
  await sleep(SAVE_WAIT);
  check('dropping on a head appends', JSON.stringify(t.themeOf(t.lastSaved(), 'empty').projects) === JSON.stringify([P('delta'), P('zeta')]), t.themeOf(t.lastSaved(), 'empty').projects);

  // Drop on Unsorted: unsorts
  t.drag(t.tile('beta'), t.tile('epsilon').querySelector('.pb-tile-main'), 1, 0);
  await sleep(SAVE_WAIT);
  check('drop on Unsorted removes from every theme', !t.lastSaved().themes.some((th) => th.projects.includes(P('beta'))) && t.tilesIn('__unsorted').includes('beta'));

  // A drag that isn't ours does nothing
  const n = t.calls.setLayout.length;
  const stray = t.dragEvent('dragover', t.tile('gamma'));
  t.dragEvent('drop', t.tile('gamma'));
  check('a foreign drag is not accepted', !stray.defaultPrevented && t.calls.setLayout.length === n);
  check('sub-project chips are not draggable', t.qa('.pb-chip').every((c) => !c.draggable));
}

// ── 4. Area reorder by dragging heads ──
{
  const t = setup();
  t.drag(t.q('.pb-area[data-area-id="home"] .pb-area-head'), t.q('.pb-area[data-area-id="work"] .pb-tiles'), -1, 0);
  check('Home moved before Work', JSON.stringify(t.areaIds()) === JSON.stringify(['home', 'work', 'empty', '__unsorted']), t.areaIds());
  t.drag(t.q('.pb-area[data-area-id="home"] .pb-area-head'), t.q('.pb-area[data-area-id="empty"]'), 1, 0);
  await sleep(SAVE_WAIT);
  check('Home moved after Empty; saved once', JSON.stringify(t.lastSaved().themes.map((th) => th.id)) === '["work","empty","home"]' && t.calls.setLayout.length === 1, [t.lastSaved().themes.map((th) => th.id), t.calls.setLayout.length]);
  const ev = t.dragEvent('dragstart', t.q('.pb-area[data-area-id="work"] .pb-area-head'));
  const over = t.dragEvent('dragover', t.q('.pb-area[data-area-id="__unsorted"]'), 1, 0);
  t.dragEvent('dragend', t.q('.pb-area[data-area-id="work"] .pb-area-head'));
  check('an area cannot drop on Unsorted', ev && !over.defaultPrevented);
}

// ── 5. Debounced save; a refused save is retried once ──
{
  const t = setup();
  const work = t.q('.pb-area[data-area-id="work"] .pb-area-menu');
  t.click(work);
  t.menuClick('Move right');
  t.contextMenu(t.tile('delta'));
  t.menuClick('Move to…');
  t.menuClick('Home');
  t.contextMenu(t.tile('zeta'));
  t.menuClick('Make wide');
  check('nothing saved yet', t.calls.setLayout.length === 0);
  await sleep(SAVE_WAIT);
  check('three changes, one setLayout call', t.calls.setLayout.length === 1, t.calls.setLayout.length);
  const saved = t.lastSaved();
  check('the save carries all three', saved.themes[1].id === 'work' && t.themeOf(saved, 'home').projects.at(-1) === P('delta') && saved.tiles[P('zeta')]?.wide === true, saved);

  const r = setup(fixture(), { refuseSave: true });
  r.contextMenu(r.tile('beta'));
  r.menuClick('Make wide');
  await sleep(SAVE_WAIT + 1100);
  check('refused save retried once, then reported', r.calls.setLayout.length === 2 && r.logs.some(([, m]) => m.includes('[BOARD] save refused')), r.calls.setLayout.length);
}

// ── 6. Tile menu: Move to, wide/narrow, note, earlier/later, keyboard ──
{
  const t = setup();
  t.key(t.tile('beta').querySelector('.pb-tile-main'), 'F10', { shiftKey: true });
  check('Shift+F10 opens the tile menu', t.menuLabels().includes('Move to…') && t.menuLabels().includes('Make wide'), t.menuLabels());
  t.menuClick('Move earlier');
  check('Move earlier', JSON.stringify(t.tilesIn('work')) === '["beta","alpha"]', t.tilesIn('work'));
  t.key(t.tile('beta').querySelector('.pb-tile-main'), 'ContextMenu');
  t.menuClick('Move later');
  check('Move later', JSON.stringify(t.tilesIn('work')) === '["alpha","beta"]', t.tilesIn('work'));
  t.contextMenu(t.tile('alpha'));
  check('a parent with sub-projects offers no wide/narrow', !t.menuLabels().some((l) => /Make (wide|narrow)/.test(l)), t.menuLabels());
  t.menuClick('Move to…');
  check('Move to lists themes, Unsorted and New theme', ['Work', 'Home', 'Empty', 'Unsorted', 'New theme…'].every((l) => t.menuLabels().includes(l)), t.menuLabels());
  t.menuClick('Empty');
  check('Move to puts the tile at the end of the theme', JSON.stringify(t.tilesIn('empty')) === '["alpha"]');
  t.contextMenu(t.tile('gamma'));
  t.menuClick('Make narrow');
  check('Make narrow', !t.tile('gamma').classList.contains('wide'));
  t.contextMenu(t.tile('beta'));
  t.menuClick('Make wide');
  check('Make wide', t.tile('beta').classList.contains('wide'));
  t.contextMenu(t.tile('delta'));
  t.menuClick('Note…');
  const input = t.tile('delta').querySelector('.pb-note-input');
  check('note input is one line, max 80', input && input.maxLength === 80);
  input.value = '  check   the build ';
  t.key(input, 'Enter');
  check('note saved and shown', t.tile('delta').querySelector('.pb-note')?.textContent === 'check the build', t.tile('delta').querySelector('.pb-note')?.textContent);
  t.contextMenu(t.tile('delta'));
  t.menuClick('Note…');
  const input2 = t.tile('delta').querySelector('.pb-note-input');
  input2.value = 'discarded';
  t.key(input2, 'Escape');
  check('Esc cancels a note', t.tile('delta').querySelector('.pb-note')?.textContent === 'check the build');
  t.contextMenu(t.tile('zeta'));
  t.menuClick('Move to…');
  t.menuClick('New theme…');
  const rename = t.q('.pb-rename');
  check('New theme… from Move to opens a name field', !!rename);
  rename.value = 'Later';
  t.key(rename, 'Enter');
  const last = t.qa('.pb-area').filter((a) => a.dataset.areaId !== '__unsorted').at(-1);
  check('the tile moved into the new theme', last.querySelector('.pb-area-name').textContent === 'Later' && JSON.stringify(t.tilesIn(last.dataset.areaId)) === '["zeta"]');
  await sleep(SAVE_WAIT);
  const saved = t.lastSaved();
  check('tile options saved (note, wide, narrow removed)', saved.tiles[P('delta')]?.note === 'check the build' && saved.tiles[P('beta')]?.wide === true && saved.tiles[P('gamma')]?.wide === undefined && saved.tiles[P('gamma')]?.note === 'a short note', saved.tiles);
  check('no sub-project path placed in a theme', !saved.themes.some((th) => th.projects.some((p) => p === P('alpha-wt') || p === P('alpha/docs'))));
}

// ── 7. Area menu: rename, tint, delete ──
{
  const t = setup();
  t.q('.pb-area[data-area-id="home"] .pb-area-name').dispatchEvent(new t.win.MouseEvent('dblclick', { bubbles: true }));
  const input = t.q('.pb-rename');
  check('double-click opens an inline rename', !!input && input.value === 'Home');
  input.value = 'House';
  t.key(input, 'Enter');
  check('rename saved', t.q('.pb-area[data-area-id="home"] .pb-area-name').textContent === 'House');
  t.click(t.q('.pb-area[data-area-id="home"] .pb-area-menu'));
  t.menuClick('Rename…');
  const input2 = t.q('.pb-rename');
  input2.value = 'Nope';
  t.key(input2, 'Escape');
  check('Esc cancels a rename', t.q('.pb-area[data-area-id="home"] .pb-area-name').textContent === 'House');
  t.click(t.q('.pb-area[data-area-id="home"] .pb-area-menu'));
  t.menuClick('Tint…');
  check('Tint menu lists eight tints and None', t.menuLabels().length === 9 && t.menuLabels().includes('None') && t.menuLabels().includes('✓ Teal'), t.menuLabels());
  t.menuClick('Rose');
  check('tint applied', t.q('.pb-area[data-area-id="home"]').dataset.tint === 'rose');
  t.click(t.q('.pb-area[data-area-id="work"] .pb-area-menu'));
  check('Move left disabled on the first theme', t.win.document.querySelector('.context-menu-overlay.visible .context-menu-item.disabled')?.textContent === 'Move left');
  t.menuClick('Delete theme…');
  await sleep(10);
  const dlg = t.win.document.querySelector('.confirm-dialog-overlay.visible');
  check('deleting a theme with projects asks first', !!dlg && /2 projects move to Unsorted/.test(dlg.textContent), dlg?.textContent);
  t.click(dlg.querySelector('.confirm-dialog-confirm'));
  await sleep(10);
  check('theme gone; its projects in Unsorted', !t.areaIds().includes('work') && ['alpha', 'beta'].every((n) => t.tilesIn('__unsorted').includes(n)), [t.areaIds(), t.tilesIn('__unsorted')]);
  t.click(t.q('.pb-area[data-area-id="empty"] .pb-area-menu'));
  t.menuClick('Delete theme…');
  await sleep(10);
  check('an empty theme is deleted without asking', !t.areaIds().includes('empty') && !t.win.document.querySelector('.confirm-dialog-overlay.visible'));
  await sleep(SAVE_WAIT);
  const saved = t.lastSaved();
  check('saved after rename, tint and deletes', JSON.stringify(saved.themes.map((th) => [th.id, th.name, th.tint])) === JSON.stringify([['home', 'House', 'rose']]), saved.themes);
}

// ── 8. + Theme ──
{
  const t = setup();
  t.click(t.qa('.pboard-btn').find((b) => b.textContent === '+ Theme'));
  const input = t.q('.pb-rename');
  check('+ Theme opens a name field on a new last area', !!input && t.areaIds().at(-2).startsWith('theme-') && t.win.document.activeElement === input, t.areaIds());
  input.value = 'Reading';
  t.key(input, 'Enter');
  await sleep(SAVE_WAIT);
  const theme = t.lastSaved().themes.at(-1);
  check('new theme: id pattern, name, next unused tint', /^[a-z0-9-]{1,40}$/.test(theme.id) && theme.id.startsWith('theme-') && theme.name === 'Reading' && theme.tint === 'slate' && theme.projects.length === 0, theme);
  t.click(t.qa('.pboard-btn').find((b) => b.textContent === '+ Theme'));
  t.key(t.q('.pb-rename'), 'Escape');
  check('Esc on a new theme removes it', t.qa('.pb-area').length === 5, t.areaIds());
}

// ── 9. Search ──
{
  const t = setup();
  const s = t.q('.pboard-search');
  const visible = () => t.qa('.pb-tile').filter((li) => !li.hidden && !li.closest('.pb-area').hidden).map((li) => li.dataset.path.replace('/tmp/pb/', ''));
  s.value = 'gam';
  s.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  check('search filters by project name', JSON.stringify(visible()) === '["gamma"]', visible());
  t.key(s, 'Enter');
  check('Enter opens the first match', t.calls.open.at(-1) === P('gamma'));
  s.value = 'work';
  s.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  check('search by theme name', JSON.stringify(visible()) === '["alpha","beta"]', visible());
  s.value = 'feature';
  s.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  check('search by sub-project name shows the parent', JSON.stringify(visible()) === '["alpha"]', visible());
  t.key(s, 'Enter');
  check('Enter on a sub-project match opens the sub-project', t.calls.open.at(-1) === P('alpha-wt'), t.calls.open);
  t.key(s, 'Escape');
  check('Esc clears the search', s.value === '' && visible().length === 6 && t.calls.dismiss === 0);
  t.key(s, 'Escape');
  check('Esc on an empty search dismisses', t.calls.dismiss === 1);
  t.board.focus();
  check('focus() focuses the search field', t.win.document.activeElement === s);
}

// ── 10. setPayload and setLayout held during a drag or a form ──
{
  const t = setup();
  const p2 = fixture();
  p2.projects.push({ path: P('omega'), name: 'Omega', subProjects: [] });
  t.dragEvent('dragstart', t.tile('beta'));
  t.board.setPayload(p2);
  check('setPayload held during a drag', !t.tile('omega') && t.tile('beta').classList.contains('is-dragging'));
  t.dragEvent('dragend', t.tile('beta'));
  check('applied when the drag ends', !!t.tile('omega') && t.q('.pboard-count').textContent === '9');

  const l2 = fixture().layout;
  l2.themes = [l2.themes[1], l2.themes[0]];
  t.dragEvent('dragstart', t.q('.pb-area[data-area-id="work"] .pb-area-head'));
  t.board.setLayout(l2);
  check('setLayout held during a drag', t.areaIds()[0] === 'work');
  t.board.element.dispatchEvent(new t.win.MouseEvent('mousedown', { bubbles: true }));
  check('a new press ends a stuck drag and applies it', t.areaIds()[0] === 'home', t.areaIds());

  t.contextMenu(t.tile('zeta'));
  t.menuClick('Note…');
  t.board.setPayload(fixture());
  check('setPayload held while a note is open', !!t.tile('omega'));
  t.key(t.tile('zeta').querySelector('.pb-note-input'), 'Escape');
  check('applied when the note closes', !t.tile('omega'));
}

// ── 11. + Project ──
{
  const added = (req) => {
    const p = fixture();
    p.projects.push({ path: req.path, name: req.name, subProjects: [] });
    p.layout.themes.find((th) => th.id === req.themeId)?.projects.push(req.path);
    return p;
  };
  const t = setup(fixture(), { pick: P('new-one'), addResult: added });
  t.click(t.qa('.pboard-btn').find((b) => b.textContent === '+ Project'));
  await sleep(10);
  const form = t.q('.pboard-add');
  check('pickFolder called, form shown', t.calls.pick === 1 && !!form && !t.q('.pboard-form').hidden);
  check('name prefilled from the folder; theme defaults to the first', t.q('.pboard-add-name').value === 'new-one' && t.q('.pboard-add-select').value === 'work', [t.q('.pboard-add-name').value, t.q('.pboard-add-select')?.value]);
  t.q('.pboard-add-name').value = 'New One';
  t.q('.pboard-add-select').value = 'home';
  t.board.setPayload(fixture());
  form.dispatchEvent(new t.win.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(20);
  check('addProject called with path, name, theme', JSON.stringify(t.calls.add[0]) === JSON.stringify({ path: P('new-one'), name: 'New One', themeId: 'home' }), t.calls.add);
  check('success: form closed, tile in its theme', t.q('.pboard-form').hidden && t.tilesIn('home').includes('new-one'), t.tilesIn('home'));

  const e = setup(fixture(), { pick: P('alpha'), addResult: () => ({ ...fixture(), error: 'that folder is already in the list' }) });
  e.click(e.qa('.pboard-btn').find((b) => b.textContent === '+ Project'));
  await sleep(10);
  e.q('.pboard-add').dispatchEvent(new e.win.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(20);
  const err = e.q('.pboard-add-error');
  check('error shown inline in plain words; form stays', !err.hidden && err.textContent === 'Could not add the project: that folder is already in the list.' && !e.q('.pboard-form').hidden, err.textContent);
  check('refusal logged', e.logs.some(([, m]) => m.includes('[BOARD] add refused')));
  e.key(e.q('.pboard-add-name'), 'Escape');
  check('Esc closes the form', e.q('.pboard-form').hidden);

  const c = setup(fixture(), { pick: null });
  c.click(c.qa('.pboard-btn').find((b) => b.textContent === '+ Project'));
  await sleep(10);
  check('a cancelled picker shows no form', c.q('.pboard-form').hidden && c.calls.add.length === 0);

  // A pending change is saved before the add, so main's layout includes it.
  const f = setup(fixture(), { pick: P('new-two'), addResult: added });
  f.contextMenu(f.tile('beta'));
  f.menuClick('Make wide');
  f.click(f.qa('.pboard-btn').find((b) => b.textContent === '+ Project'));
  await sleep(10);
  f.q('.pboard-add').dispatchEvent(new f.win.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(20);
  check('pending save flushed before addProject', f.calls.setLayout.length === 1 && f.calls.add.length === 1);
}

// ── 12. dispose saves what's pending ──
{
  const t = setup();
  t.contextMenu(t.tile('beta'));
  t.menuClick('Make wide');
  t.board.dispose();
  await sleep(10);
  check('dispose saves a pending change and removes the board', t.calls.setLayout.length === 1 && !t.el.isConnected);
}

// ── 13. Review fixes: races, double clicks, failures, IME ──
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const withNewOne = (place = 'home', generation) => {
  const p = fixture();
  p.projects.push({ path: P('new-one'), name: 'New One', subProjects: [] });
  if (place) p.layout.themes.find((th) => th.id === place).projects.push(P('new-one'));
  if (generation !== undefined) p.generation = generation;
  return p;
};
const plusProject = (t) => t.click(t.qa('.pboard-btn').find((b) => b.textContent === '+ Project'));
const submit = (t) => t.q('.pboard-add').dispatchEvent(new t.win.Event('submit', { bubbles: true, cancelable: true }));

// m4: a double click on + Project opens one picker and one form, and the board stays usable.
{
  const picks = [deferred(), deferred()];
  let n = 0;
  const t = setup(fixture(), { pickFolder: () => (picks[n++] ?? { promise: Promise.resolve(null) }).promise });
  plusProject(t);
  plusProject(t);
  picks[0].resolve(P('new-one'));
  picks[1]?.resolve(P('new-two'));
  await sleep(10);
  check('m4: double click opens one picker', t.calls.pick === 1, t.calls.pick);
  check('m4: one form', t.qa('.pboard-add').length === 1);
  t.key(t.q('.pboard-add-name'), 'Escape');
  t.board.setPayload(withNewOne());
  check('m4: after the form closes the board renders again', !!t.tile('new-one'));
  plusProject(t);
  await sleep(10);
  check('m4: + Project works again after the pick', t.calls.pick === 2);
}

// m5: an open that fails is announced.
{
  const t = setup(fixture(), { openProject: () => Promise.reject(new Error('no pty')) });
  t.click(t.tile('beta').querySelector('.pb-tile-main') ?? t.tile('beta'));
  await sleep(40);
  check('m5: a failed open is announced', /Could not open Beta/.test(t.announced()), t.announced());
}

// m9: Enter and Esc that belong to an input method's composition do nothing.
{
  const t = setup();
  t.q('.pboard-search').value = 'bet';
  t.q('.pboard-search').dispatchEvent(new t.win.Event('input', { bubbles: true }));
  t.key(t.q('.pboard-search'), 'Enter', { isComposing: true });
  t.key(t.q('.pboard-search'), 'Escape', { isComposing: true });
  check('m9: composing Enter opens nothing, composing Esc keeps the search', t.calls.open.length === 0 && t.calls.dismiss === 0 && t.q('.pboard-search').value === 'bet');
  t.key(t.q('.pboard-search'), 'Enter');
  check('m9: a plain Enter still opens the match', t.calls.open[0] === P('beta'), t.calls.open);
}

// m2 (renderer): a project added elsewhere keeps its theme on a board with an unsaved change.
{
  const t = setup(fixture());
  t.contextMenu(t.tile('beta'));
  t.menuClick('Make wide');
  t.board.setPayload(withNewOne('home', 4));
  await sleep(SAVE_WAIT);
  const saved = t.lastSaved();
  check('m2: the new tile shows in its theme', t.tilesIn('home').includes('new-one'), t.tilesIn('home'));
  check('m2: the save keeps both our change and the new placement',
    saved.tiles[P('beta')]?.wide === true && t.themeOf(saved, 'home').projects.includes(P('new-one')), saved);
  check('m2: the save carries the add count it has seen', t.calls.generations.at(-1) === 4, t.calls.generations);
}

// m6a: a refused flush before an add, then the retry, keeps the new tile's theme.
{
  const t = setup(fixture(), { pick: P('new-one'), addResult: () => withNewOne('home'), setLayout: (layout, nth) => (nth === 1 ? null : layout) });
  t.contextMenu(t.tile('beta'));
  t.menuClick('Make wide');
  plusProject(t);
  await sleep(10);
  t.q('.pboard-add-select').value = 'home';
  submit(t);
  await sleep(1300);
  const saved = t.lastSaved();
  check('m6a: the retried save has the new tile in its theme', t.calls.setLayout.length >= 2
    && t.themeOf(saved, 'home').projects.includes(P('new-one')) && saved.tiles[P('beta')]?.wide === true, saved);
}

// m6b: Cancel while the add is on its way still shows the added project.
{
  const add = deferred();
  const t = setup(fixture(), { pick: P('new-one'), addResult: () => add.promise });
  plusProject(t);
  await sleep(10);
  submit(t);
  await sleep(5);
  t.key(t.q('.pboard-add-name'), 'Escape');
  add.resolve(withNewOne('home'));
  await sleep(20);
  check('m6b: the tile appears though the form was cancelled', t.tilesIn('home').includes('new-one'), t.tilesIn('home'));
}

// m6c: an echo of an older save, landing while a newer save is on its way, doesn't undo the newer change.
{
  const replies = [];
  const t = setup(fixture(), { setLayout: (layout) => { const d = deferred(); replies.push(() => d.resolve(layout)); return d.promise; } });
  t.contextMenu(t.tile('beta'));
  t.menuClick('Make wide');
  await sleep(SAVE_WAIT);
  const echo1 = t.lastSaved();
  t.contextMenu(t.tile('gamma'));
  t.menuClick('Make narrow');
  await sleep(SAVE_WAIT);
  t.board.setLayout(echo1); // the echo of save 1 arrives; save 2 is still unanswered
  t.contextMenu(t.tile('zeta'));
  t.menuClick('Make wide');
  await sleep(SAVE_WAIT);
  const third = t.lastSaved();
  check('m6c: the third save keeps the second change', t.calls.setLayout.length === 3 && !third.tiles[P('gamma')]?.wide
    && third.tiles[P('zeta')]?.wide === true && third.tiles[P('beta')]?.wide === true, third.tiles);
  for (const r of replies) r();
}

// m6: a tint chosen after the layout was replaced lands on the current theme.
{
  const t = setup();
  t.click(t.q('.pb-area[data-area-id="home"] .pb-area-menu'));
  t.menuClick('Tint…');
  t.board.setLayout(fixture().layout); // another window's save arrives while the menu is open
  t.menuClick('Rose');
  await sleep(SAVE_WAIT);
  check('m6: tint applied to the current layout and saved', t.q('.pb-area[data-area-id="home"]').dataset.tint === 'rose'
    && t.themeOf(t.lastSaved(), 'home').tint === 'rose', t.lastSaved()?.themes);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
