// Unit check of src/renderer/services/link-target.ts (the shared link rules).
// Run: node scripts/check-link-target.mjs   (bundles the TS with esbuild)
import { build } from 'esbuild';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'link-target-')), 'link-target.mjs');
await build({
  entryPoints: [join(root, 'src/renderer/services/link-target.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
});
const m = await import(pathToFileURL(out).href);
let failed = 0;
const check = (name, ok) => { if (!ok) { failed++; console.log('FAIL', name); } else console.log('ok  ', name); };
const hosts = m.localHostNames('Michaels-MBP.local');
const r = (u, cwd = '/Users/me/proj') => m.resolveHyperlink(u, cwd, hosts);

check('https ok', r('https://example.com/a?b=1').kind === 'web');
check('http ok', r('http://example.com').kind === 'web');
check('file:/// ok', (x => x.kind === 'file' && x.path === '/Users/me/x')(r('file:///Users/me/x')));
check('file://localhost ok', r('file://localhost/Users/me/x').kind === 'file');
check('file://this-host ok', r('file://michaels-mbp.local/Users/me/x').kind === 'file');
check('file://this-host (no .local) ok', r('file://Michaels-MBP/Users/me/x').kind === 'file');
check('file://otherhost refused', r('file://otherhost/x').kind === 'refused');
check('javascript: refused', r('javascript:alert(1)').kind === 'refused');
check('data: refused', r('data:text/html,<b>x</b>').kind === 'refused');
check('ftp: refused', r('ftp://example.com/x').kind === 'refused');
check('ssh: refused', r('ssh://example.com').kind === 'refused');
check('vscode: refused', r('vscode://file/etc/passwd').kind === 'refused');
check('not a URL refused', r('just words').kind === 'refused');
check('file traversal refused', r('file:///Users/me/../../etc/passwd').kind === 'refused');
check('file encoded traversal refused', r('file:///Users/me/%2e%2e/%2e%2e/etc/passwd').kind === 'refused');
check('file encoded slash traversal refused', r('file:///Users/me/..%2f..%2fetc').kind === 'refused');
check('file bad encoding refused', r('file:///Users/me/%zz').kind === 'refused');
check('file NUL refused', r('file:///Users/me/a%00b').kind === 'refused');
check('file root refused', r('file:///').kind === 'refused');
check('spaces decoded', (x => x.kind === 'file' && x.path === '/Users/me/My Doc.md')(r('file:///Users/me/My%20Doc.md')));
check('file fragment ignored', (x => x.kind === 'file' && x.path === '/Users/me/x.md')(r('file:///Users/me/x.md#L3')));
check('too long refused', r('https://example.com/' + 'a'.repeat(3000)).kind === 'refused');

check('resolveLocalPath relative', m.resolveLocalPath('a/b.ts', '/p') === '/p/a/b.ts');
check('resolveLocalPath ~ untouched', m.resolveLocalPath('~/x.md', '/p') === '~/x.md');
check('resolveLocalPath traversal', m.resolveLocalPath('../x', '/p') === null);

// The 5 Nov main.log failure: "https://www.clearscore.com" read as the path "/www.clearscore.com".
const spans = m.urlSpans('see https://www.clearscore.com/a/b.html and /Users/me/x.ts');
check('urlSpans covers the address', spans.length === 1 && spans[0][0] === 4 && spans[0][1] === 'see https://www.clearscore.com/a/b.html'.length);
check('urlSpans leaves plain paths', m.urlSpans('/Users/me/x.ts:3 and src/a.ts').length === 0);
process.exit(failed ? 1 : 0);
