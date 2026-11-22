// Check of where learned page titles are shown (renderer): artifact bookmarks
// with an automatic name show the page's title, names typed by the user stay, a
// new bookmark with an empty name box is saved with the automatic name (so it
// follows a republish), and the session bar's "Page <id start>" link label
// becomes the title while a markdown label Claude gave stays
// (docs/session-bar.md D6). The real BookmarksPanel runs in jsdom: its rows
// must repaint when titles arrive at start (after a refused first answer, asked
// again) and on every push. Ids named like Object.prototype members are ids.
// Run: JSDOM_DIR=<a folder whose node_modules has jsdom> node scripts/check-page-title-labels.mjs
// TITLES_SRC_ROOT=<another checkout> runs it against that tree.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsdomDir = process.env.JSDOM_DIR || process.argv[2];
if (!jsdomDir) {
  console.error('Set JSDOM_DIR (or pass a folder) where node_modules/jsdom is installed.');
  process.exit(2);
}
const { JSDOM } = createRequire(join(jsdomDir, 'noop.js'))('jsdom');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.TITLES_SRC_ROOT ? resolve(process.env.TITLES_SRC_ROOT) : repo;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
};
if (!existsSync(join(root, 'src/renderer/services/page-titles.ts'))) {
  console.log('FAIL no src/renderer/services/page-titles.ts in this tree');
  process.exit(1);
}

const bundle = await build({
  stdin: {
    resolveDir: root, loader: 'ts',
    contents: `export * as labels from './src/renderer/services/bookmark-labels';
               export * as bar from './src/renderer/services/session-bar-model';
               export * as titles from './src/renderer/services/page-titles';
               export { BookmarksPanel } from './src/renderer/components/bookmarks-panel';`,
  },
  bundle: true, format: 'iife', globalName: 'PT', platform: 'browser', write: false,
  loader: { '.css': 'empty' }, logLevel: 'silent', nodePaths: [join(repo, 'node_modules')],
});

const ID = 'a51aee6f-70d0-4e0f-ada9-8b6aeb2b4221';
const ID2 = '503c49fd-8ae5-4501-be32-fe371f388337';
const URL1 = `https://claude.ai/code/artifact/${ID}`;
const OTHER = `https://claude.ai/code/artifact/${ID2}`;
const TITLE = 'Nevis Road walk-round';
const A = (id, label, url) => ({ id, kind: 'artifact', label, url, addedAt: 1 });

const dom = new JSDOM('<!doctype html><html><body><div id="c"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const panelBookmarks = [A('b1', 'Artifact a51aee6f', URL1), A('b2', 'claude.ai', OTHER), A('b3', 'House notes', URL1)];
let pushTitles = null;
const answers = [null, { [ID]: TITLE }];
let gets = 0;
w.patton = {
  bookmarks: { get: async () => panelBookmarks, set: async (l) => l, onChanged: () => () => {}, refresh: async () => panelBookmarks },
  pageTitles: { get: async () => answers[Math.min(gets++, answers.length - 1)], onChanged: (cb) => { pushTitles = cb; return () => {}; } },
  log: () => {},
};
w.Element.prototype.scrollIntoView = () => {};
w.localStorage.setItem('patton.bookmarks.open', '1');
w.eval(bundle.outputFiles[0].text);
const { labels, bar, titles: T } = w.PT;
const setTitles = (map) => T.setPageTitles(map);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the real bookmarks panel repaints when titles arrive (M1)
{
  const host = { getTabs: () => [], getActiveTab: () => null, switchToTab() {}, createTab: async () => ({}), listSessions: () => [], goToSession: () => false, focusTerminal() {} };
  new w.PT.BookmarksPanel(w.document.getElementById('c'), host);
  await sleep(50);
  const names = () => [...w.document.querySelectorAll('.bookmark-label')].map((e) => e.textContent);
  check('panel: before any title, automatic names show "Artifact <id start>"', JSON.stringify(names()) === JSON.stringify(['Artifact a51aee6f', 'Artifact 503c49fd', 'House notes']), names());
  T.startPageTitles();
  await sleep(50);
  check('panel: a refused first answer (null) leaves the rows as they were', gets === 1 && names()[0] === 'Artifact a51aee6f', { gets, names: names() });
  await sleep(T.RETRY_DELAY_MS + 200);
  check('panel: main is asked once more, and its answer repaints the rows', gets === 2 && JSON.stringify(names()) === JSON.stringify([TITLE, 'Artifact 503c49fd', 'House notes']), { gets, names: names() });
  pushTitles({ [ID]: TITLE, [ID2]: 'Second page' });
  await sleep(20);
  check('panel: a push naming another page repaints that row', JSON.stringify(names()) === JSON.stringify([TITLE, 'Second page', 'House notes']), names());
  pushTitles({ [ID]: 'Republished name', [ID2]: 'Second page' });
  await sleep(20);
  check('panel: a republished title replaces the old one; a typed name stays', JSON.stringify(names()) === JSON.stringify(['Republished name', 'Second page', 'House notes']), names());
  await sleep(T.RETRY_DELAY_MS + 200);
  check('panel: no further asks after an answer', gets === 2, gets);
}

// ── bookmarks
setTitles({});
check('no title known: an automatic name shows "Artifact <id start>"', labels.displayLabel(A('x', 'claude.ai', URL1)) === 'Artifact a51aee6f', labels.displayLabel(A('x', 'claude.ai', URL1)));
let changes = 0;
const off = T.onPageTitlesChanged(() => changes++);
setTitles({ [ID]: TITLE });
check('a title change tells the listeners', changes === 1, changes);
off();
{
  let after = 0;
  const offBad = T.onPageTitlesChanged(() => { throw new Error('boom'); });
  const offAfter = T.onPageTitlesChanged(() => after++);
  let threw = false;
  try { setTitles({ [ID]: TITLE }); } catch { threw = true; }
  check('a listener that throws does not stop the next one', after === 1 && !threw, { after, threw });
  offBad(); offAfter();
}
check('an old automatic name ("claude.ai") shows the page title', labels.displayLabel(A('x', 'claude.ai', URL1)) === TITLE, labels.displayLabel(A('x', 'claude.ai', URL1)));
check('a new automatic name ("Artifact <id start>") shows the page title', labels.displayLabel(A('x', 'Artifact a51aee6f', URL1)) === TITLE, labels.displayLabel(A('x', 'Artifact a51aee6f', URL1)));
check('a name the user typed is kept', labels.displayLabel(A('x', 'House notes', URL1)) === 'House notes');
check('another page with no title keeps "Artifact <id start>"', labels.displayLabel(A('y', 'claude.ai', OTHER)) === 'Artifact 503c49fd', labels.displayLabel(A('y', 'claude.ai', OTHER)));
check('the tooltip still shows the full address', labels.fullTarget(A('x', 'claude.ai', URL1)) === URL1);
check('/public/artifacts/<id> finds the same title', labels.displayLabel(A('x', 'claude.ai', `https://claude.ai/public/artifacts/${ID}`)) === TITLE);
// m8: the empty name box saves the automatic name, so the row follows a republish
const saved = labels.newArtifactLabel(URL1, '  ');
check('adding with the name box empty saves the automatic name, not the title', saved === 'Artifact a51aee6f', saved);
check('that bookmark shows the title now', labels.displayLabel(A('n', saved, URL1)) === TITLE);
setTitles({ [ID]: 'Renamed page' });
check('and the new title after a republish', labels.displayLabel(A('n', saved, URL1)) === 'Renamed page', labels.displayLabel(A('n', saved, URL1)));
check('adding with a typed name saves the typed name', labels.newArtifactLabel(URL1, ' Mine ') === 'Mine');
check('adding an untitled page with the box empty saves "Artifact <id start>"', labels.newArtifactLabel(OTHER, '') === 'Artifact 503c49fd');
check('a typed name is capped at the bookmark limit (60)', labels.newArtifactLabel(URL1, 'x'.repeat(80)).length === 60);

// m4: ids named like Object.prototype members
setTitles({});
const PROTO = 'https://claude.ai/code/artifact/constructor';
check('no titles: an id named "constructor" has no title', T.pageTitleOf(PROTO) === '' && T.pageTitleOf('https://claude.ai/artifacts/toString') === '', typeof T.pageTitleOf(PROTO));
check('no titles: its bookmark shows "Artifact <id start>" (a string)', labels.displayLabel(A('p', 'claude.ai', PROTO)) === 'Artifact construc', typeof labels.displayLabel(A('p', 'claude.ai', PROTO)));
setTitles(JSON.parse('{"constructor": "Real page", "hasOwnProperty": "Own", "toLocaleString": 7}'));
check('an id named "constructor" looks up its own title; a non-string title is none', T.pageTitleOf(PROTO) === 'Real page' && T.pageTitleOf('https://claude.ai/code/artifact/hasOwnProperty') === 'Own' && T.pageTitleOf('https://claude.ai/code/artifact/toLocaleString') === '', [T.pageTitleOf(PROTO), T.pageTitleOf('https://claude.ai/code/artifact/toLocaleString')]);

// ── session bar links
setTitles({ [ID]: TITLE });
{
  const m = new bar.SessionBarModel();
  m.applyFeed({ type: 'link', url: URL1, label: 'Page a51aee6f', at: 1000, fallback: true }, 1000);
  m.applyFeed({ type: 'link', url: `https://claude.ai/code/artifact/${'0'.repeat(8)}-given`, label: 'The plan', at: 2000 }, 2000);
  m.applyFeed({ type: 'link', url: OTHER, label: 'Page 503c49fd', at: 3000, fallback: true }, 3000);
  m.applyFeed({ type: 'link', url: PROTO, label: 'Page construc', at: 3500, fallback: true }, 3500);
  const v = m.view(4000).links;
  const lab = (u) => v.find((l) => l.url === u)?.label;
  check('bar: a "Page <id start>" link shows the page title', lab(URL1) === TITLE, v);
  check('bar: a markdown label Claude gave is kept', lab(`https://claude.ai/code/artifact/${'0'.repeat(8)}-given`) === 'The plan', v);
  check('bar: a page with no title keeps "Page <id start>"', lab(OTHER) === 'Page 503c49fd', v);
  check('bar: a page id named "constructor" keeps its string label', lab(PROTO) === 'Page construc', typeof lab(PROTO));
  setTitles({ [ID]: TITLE, '00000000-given': 'Learned' });
  check('bar: a learned title never replaces a markdown label', m.view(4000).links.find((l) => l.label === 'The plan') !== undefined, m.view(4000).links);
  const m2 = new bar.SessionBarModel();
  m2.applyFeed({ type: 'link', url: URL1, label: 'Nevis notes', at: 1000 }, 1000);
  m2.applyFeed({ type: 'link', url: URL1, label: 'Page a51aee6f', at: 2000, fallback: true }, 2000);
  check('bar: shared again with only the made-up label, the real label stays', m2.view(3000).links[0].label === 'Nevis notes', m2.view(3000).links);
}
setTitles({});

// ── wiring, by source (the bar's repaint is keyed on its whole view, labels included)
const src = (p) => readFileSync(join(root, p), 'utf8');
const panel = src('src/renderer/components/bookmarks-panel.ts');
const sb = src('src/renderer/components/session-bar.ts');
const app = src('src/renderer/components/app.ts');
check('the panel\'s form saves through newArtifactLabel', /newArtifactLabel\(url, this\.labelInput\.value\)/.test(panel));
const templates = [...panel.matchAll(/innerHTML\s*=\s*`([^`]*)`/g)].map((m) => m[1]);
check('the panel sets the row name with textContent', /label\.textContent = displayLabel\(bookmark\)/.test(panel));
check('no innerHTML template in the panel interpolates a name or title', templates.length > 0 && templates.every((t) => !/\$\{[^}]*(?:label|Label|bookmark|title|Title)/.test(t)), templates.length);
check('the bar re-renders its lists on a title change (by source)', /onPageTitlesChanged\(\(\) => this\.renderLists\(\)\)/.test(sb));
check('the bar never uses innerHTML', !/innerHTML/.test(sb));
check('the app starts the title feed', /startPageTitles\(\)/.test(app));

console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
