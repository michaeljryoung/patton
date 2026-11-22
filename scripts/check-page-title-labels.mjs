// Check of where learned page titles are shown (renderer, no DOM): artifact
// bookmarks with an automatic name show the page's title, names typed by the
// user stay, a new bookmark with an empty name box is saved with the title, and
// the session bar's "Page <id start>" link label becomes the title while a
// markdown label Claude gave stays (docs/session-bar.md D6). Also asserts the
// wiring: the panel and the bar re-render on a title change, the panel's form
// saves through newArtifactLabel, and titles reach the DOM via textContent.
// Run: node scripts/check-page-title-labels.mjs
// TITLES_SRC_ROOT=<another checkout> runs it against that tree (on main, before
// page titles, the display assertions fail: there is no title to show).
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.TITLES_SRC_ROOT ? resolve(process.env.TITLES_SRC_ROOT) : repo;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
};

const hasTitles = existsSync(join(root, 'src/renderer/services/page-titles.ts'));
const dir = mkdtempSync(join(tmpdir(), 'check-page-title-labels-'));
let M;
try {
  const res = await build({
    stdin: {
      resolveDir: root, loader: 'ts',
      contents: `export * as labels from './src/renderer/services/bookmark-labels';
                 export * as bar from './src/renderer/services/session-bar-model';
                 ${hasTitles ? "export * as titles from './src/renderer/services/page-titles';" : ''}`,
    },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    nodePaths: [join(repo, 'node_modules')],
  });
  const out = join(dir, 'm.mjs');
  writeFileSync(out, res.outputFiles[0].text);
  M = await import(pathToFileURL(out).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!hasTitles) console.log('note: no src/renderer/services/page-titles.ts in this tree; titles cannot be set');
const setTitles = (map) => M.titles?.setPageTitles(map);
const { labels, bar } = M;

const ID = 'a51aee6f-70d0-4e0f-ada9-8b6aeb2b4221';
const URL1 = `https://claude.ai/code/artifact/${ID}`;
const OTHER = 'https://claude.ai/code/artifact/503c49fd-8ae5-4501-be32-fe371f388337';
const TITLE = 'Nevis Road walk-round';
const A = (id, label, url) => ({ id, kind: 'artifact', label, url, addedAt: 1 });

// ── bookmarks
setTitles({});
check('no title known: an automatic name shows "Artifact <id start>"', labels.displayLabel(A('x', 'claude.ai', URL1)) === 'Artifact a51aee6f', labels.displayLabel(A('x', 'claude.ai', URL1)));
let changes = 0;
const off = M.titles?.onPageTitlesChanged(() => changes++);
setTitles({ [ID]: TITLE });
check('a title change tells the listeners', changes === 1, changes);
off?.();
check('an old automatic name ("claude.ai") shows the page title', labels.displayLabel(A('x', 'claude.ai', URL1)) === TITLE, labels.displayLabel(A('x', 'claude.ai', URL1)));
check('a new automatic name ("Artifact <id start>") shows the page title', labels.displayLabel(A('x', 'Artifact a51aee6f', URL1)) === TITLE, labels.displayLabel(A('x', 'Artifact a51aee6f', URL1)));
check('a name the user typed is kept', labels.displayLabel(A('x', 'House notes', URL1)) === 'House notes');
check('another page with no title keeps "Artifact <id start>"', labels.displayLabel(A('y', 'claude.ai', OTHER)) === 'Artifact 503c49fd', labels.displayLabel(A('y', 'claude.ai', OTHER)));
check('the tooltip still shows the full address', labels.fullTarget(A('x', 'claude.ai', URL1)) === URL1);
check('/public/artifacts/<id> finds the same title', labels.displayLabel(A('x', 'claude.ai', `https://claude.ai/public/artifacts/${ID}`)) === TITLE);
const newLabel = (url, typed) => (labels.newArtifactLabel ? labels.newArtifactLabel(url, typed) : null);
check('adding with the name box empty saves the title', newLabel(URL1, '  ') === TITLE, newLabel(URL1, '  '));
check('adding with a typed name saves the typed name', newLabel(URL1, ' Mine ') === 'Mine', newLabel(URL1, ' Mine '));
check('adding an untitled page with the box empty saves "Artifact <id start>"', newLabel(OTHER, '') === 'Artifact 503c49fd', newLabel(OTHER, ''));
setTitles({ [ID]: 'x'.repeat(80) });
check('a saved name is capped at the bookmark limit (60)', newLabel(URL1, '')?.length === 60, newLabel(URL1, '')?.length);

// ── session bar links
setTitles({ [ID]: TITLE });
{
  const m = new bar.SessionBarModel();
  m.applyFeed({ type: 'link', url: URL1, label: 'Page a51aee6f', at: 1000, fallback: true }, 1000);
  m.applyFeed({ type: 'link', url: `https://claude.ai/code/artifact/${'0'.repeat(8)}-given`, label: 'The plan', at: 2000 }, 2000);
  m.applyFeed({ type: 'link', url: OTHER, label: 'Page 503c49fd', at: 3000, fallback: true }, 3000);
  const v = m.view(4000).links;
  const lab = (u) => v.find((l) => l.url === u)?.label;
  check('bar: a "Page <id start>" link shows the page title', lab(URL1) === TITLE, v);
  check('bar: a markdown label Claude gave is kept', lab(`https://claude.ai/code/artifact/${'0'.repeat(8)}-given`) === 'The plan', v);
  check('bar: a page with no title keeps "Page <id start>"', lab(OTHER) === 'Page 503c49fd', v);
  setTitles({ [ID]: TITLE, '00000000-given': 'Learned' });
  check('bar: a learned title never replaces a markdown label', m.view(4000).links.find((l) => l.label === 'The plan') !== undefined, m.view(4000).links);
  const m2 = new bar.SessionBarModel();
  m2.applyFeed({ type: 'link', url: URL1, label: 'Nevis notes', at: 1000 }, 1000);
  m2.applyFeed({ type: 'link', url: URL1, label: 'Page a51aee6f', at: 2000, fallback: true }, 2000);
  check('bar: shared again with only the made-up label, the real label stays', m2.view(3000).links[0].label === 'Nevis notes', m2.view(3000).links);
}
setTitles({});

// ── wiring, by source
const src = (p) => readFileSync(join(root, p), 'utf8');
const panel = src('src/renderer/components/bookmarks-panel.ts');
const sb = src('src/renderer/components/session-bar.ts');
const app = src('src/renderer/components/app.ts');
check('the panel re-renders on a title change', /onPageTitlesChanged\(\(\) => this\.render\(\)\)/.test(panel));
check('the panel\'s form saves through newArtifactLabel', /newArtifactLabel\(url, this\.labelInput\.value\)/.test(panel));
// The panel's innerHTML templates are its fixed frame; none interpolates a name.
const templates = [...panel.matchAll(/innerHTML\s*=\s*`([^`]*)`/g)].map((m) => m[1]);
check('the panel sets the row name with textContent', /label\.textContent = displayLabel\(bookmark\)/.test(panel));
check('no innerHTML template in the panel interpolates a name or title', templates.length > 0 && templates.every((t) => !/\$\{[^}]*(?:label|Label|bookmark|title|Title)/.test(t)), templates.length);
check('the bar re-renders its lists on a title change', /onPageTitlesChanged\(\(\) => this\.renderLists\(\)\)/.test(sb));
check('the bar never uses innerHTML', !/innerHTML/.test(sb));
check('the app starts the title feed', /startPageTitles\(\)/.test(app));

console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
