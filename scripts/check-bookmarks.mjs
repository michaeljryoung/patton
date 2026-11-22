// Check of the bookmarks bar's two seams that need no window: main's web-open
// (what an artifact bookmark's click becomes in main, and what is logged) and
// the row text rules (name alone; full path or address kept for the tooltip),
// and the row's dot, a status only (no blue dot for a project merely open).
// Run: node scripts/check-bookmarks.mjs
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'check-bookmarks-'));
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
};
try {
  const load = async (entry, out) => {
    await build({ entryPoints: [entry], outfile: join(dir, out), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    return import(pathToFileURL(join(dir, out)).href);
  };
  const web = await load('src/main/web-open.ts', 'web.mjs');
  const labels = await load('src/renderer/services/bookmark-labels.ts', 'labels.mjs');

  const ART = 'https://claude.ai/code/artifact/8bf5f5bc-0dab-4cab-afa2-cd9219a9f1a8';
  const rec = () => { const lines = []; return { lines, info: (m, d) => lines.push(['info', m, d]), warn: (m, d) => lines.push(['warn', m, d]) }; };

  // --- opening: success is logged, and the log never carries the path
  {
    const opened = []; const log = rec();
    const ok = await web.openWebUrl(ART, async (h) => { opened.push(h); }, log);
    check('an artifact link is handed to the browser as is', ok === true && opened[0] === ART, opened);
    check('the hand-off is logged with host and path length', log.lines.length === 1 && log.lines[0][2].host === 'claude.ai' && log.lines[0][2].pathChars > 0, log.lines);
    check('the log line carries no path or id', !JSON.stringify(log.lines).includes('8bf5f5bc'), log.lines);
  }
  // --- a refused address says so (it used to vanish)
  for (const [name, url] of [['javascript:', 'javascript:alert(1)'], ['file:', 'file:///etc/passwd'], ['not a URL', 'claude.ai/x'], ['over 2048 chars', 'https://claude.ai/' + 'a'.repeat(2100)], ['not a string', 42]]) {
    const opened = []; const log = rec();
    const ok = await web.openWebUrl(url, async (h) => { opened.push(h); }, log);
    check(`refused (${name}): false, not opened, logged`, ok === false && opened.length === 0 && log.lines.length === 1 && log.lines[0][0] === 'warn' && log.lines[0][1] === '[LINK] web open refused', log.lines);
  }
  // --- the browser hand-off failing is reported, not swallowed
  {
    const log = rec();
    const ok = await web.openWebUrl(ART, async () => { throw new Error('no application knows how to open the URL'); }, log);
    check('a failed hand-off resolves false and logs the error', ok === false && log.lines[0][1] === '[LINK] web open failed' && /no application/.test(log.lines[0][2].error), log.lines);
    check('the failure line carries no id either', !JSON.stringify(log.lines).includes('8bf5f5bc'), log.lines);
  }

  // --- row text
  const P = (id, label, path) => ({ id, kind: 'project', label, path, displayPath: path.replace('/Users/m', '~'), addedAt: 1 });
  const A = (id, label, url) => ({ id, kind: 'artifact', label, url, addedAt: 1 });
  const proj = [P('a', 'Alpha', '/Users/m/Projects/alpha'), P('b', 'Beta', '/Users/m/Projects/beta'), P('c', 'app', '/Users/m/Projects/lindus/app'), P('d', 'app', '/Users/m/Projects/personal/app')];
  check('a unique name has no second line', labels.disambiguator(proj[0], proj) === '');
  check('two projects of one name differ by parent folder', labels.disambiguator(proj[2], proj) === 'lindus' && labels.disambiguator(proj[3], proj) === 'personal', [labels.disambiguator(proj[2], proj), labels.disambiguator(proj[3], proj)]);
  const arts = [A('x', 'Notes', ART), A('y', 'Notes', 'https://claude.ai/code/artifact/503c49fd-8ae5-4501-be32-fe371f388337'), A('z', 'Notes', 'https://example.com/n')];
  check('two artifacts of one name differ by the id start', labels.disambiguator(arts[0], arts) === '8bf5f5bc' && labels.disambiguator(arts[1], arts) === '503c49fd');
  check('no disambiguator is a path', [...proj, ...arts].every((b) => !labels.disambiguator(b, b.kind === 'project' ? proj : arts).includes('/')));
  check('a new artifact bookmark is named by its id start', labels.defaultArtifactLabel(ART) === 'Artifact 8bf5f5bc', labels.defaultArtifactLabel(ART));
  check('a non-artifact link is named by its host', labels.defaultArtifactLabel('https://example.com/some/page') === 'example.com');
  check('the tooltip target is the full folder or address', labels.fullTarget(proj[0]) === '~/Projects/alpha' && labels.fullTarget(arts[0]) === ART);

  // --- artifact bookmarks saved before id-start naming (named by the bare host)
  {
    const old = A('o', 'claude.ai', ART);
    check('an old artifact bookmark named by the bare host shows as Artifact <id start>', labels.displayLabel(old) === 'Artifact 8bf5f5bc', labels.displayLabel(old));
    check('display does not rewrite the saved name', old.label === 'claude.ai');
    check('a name the user set is kept', labels.displayLabel(A('p', 'Design notes', ART)) === 'Design notes');
    check('a user name that merely contains the host is kept', labels.displayLabel(A('q', 'claude.ai notes', ART)) === 'claude.ai notes');
    check('a non-artifact link named by its host is kept', labels.displayLabel(A('r', 'example.com', 'https://example.com/n')) === 'example.com');
    check('a project named claude.ai is kept', labels.displayLabel(P('s', 'claude.ai', '/Users/m/Projects/claude.ai')) === 'claude.ai');
    check('a new-style name is kept', labels.displayLabel(A('t', 'Artifact 8bf5f5bc', ART)) === 'Artifact 8bf5f5bc');
    const two = [A('u', 'claude.ai', ART), A('v', 'claude.ai', 'https://claude.ai/code/artifact/503c49fd-8ae5-4501-be32-fe371f388337')];
    check('two old bookmarks tell apart by their displayed names, no second line', two.every((b) => labels.disambiguator(b, two) === ''), two.map((b) => labels.displayLabel(b)));
  }
  // --- the row's dot is a status only: no blue dot for a project merely open (his "genome
  // isnt waiting for anything from me but is wrong in bookmark"); bold name, green waiting
  // dot and parked ring stay
  {
    const css = readFileSync('src/renderer/styles/main.css', 'utf8');
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
    const dotRules = rules.filter((r) => r.sel.split(',').some((s) => /\.bookmark-dot\s*$/.test(s.trim())));
    const openDot = dotRules.filter((r) => /is-open|is-current/.test(r.sel) && /background|border|box-shadow/.test(r.body));
    check('a project merely open draws no dot', openDot.length === 0, openDot.map((r) => r.sel));
    const base = dotRules.find((r) => r.sel === '.bookmark-dot');
    check('the dot is empty by default', base && /background:\s*transparent/.test(base.body), base);
    check('a waiting session keeps its green dot', dotRules.some((r) => r.sel === '.bookmark-row.has-waiting .bookmark-dot' && /var\(--prompt-ready\)/.test(r.body)));
    check('a parked session keeps its ring', dotRules.some((r) => r.sel === '.bookmark-row.has-parked .bookmark-dot' && /border:[^;]*var\(--parked\)/.test(r.body)));
    check('an open project keeps its bold name', rules.some((r) => r.sel === '.bookmark-row.is-open .bookmark-label' && /font-weight:\s*600/.test(r.body)));
    const panel = readFileSync('src/renderer/components/bookmarks-panel.ts', 'utf8');
    check('the panel still marks open rows (is-open) and shows their open count', /classList\.toggle\('is-open', isOpen\)/.test(panel) && /countText\(rowState\)/.test(panel));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed === 0 ? 'all ok' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
