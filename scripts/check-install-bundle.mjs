// Headless check of the local install's stale-file pruning (S46): after
// `ditto` overwrites /Applications/Patton.app, files the new build no longer
// ships must go (they break the code signature), unless Patton is running from
// the bundle, in which case they are only listed. Drives the REAL helper
// (scripts/install-prune.cjs) on temp source and dest trees; the running-check
// and codesign are injected, and nothing outside the temp trees is touched.
// Run: node scripts/check-install-bundle.mjs   (no extra dependencies)
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const { findStalePaths, pruneStale, verifySignature } = createRequire(import.meta.url)(join(here, 'install-prune.cjs'));

const SCRATCH = '/private/tmp/claude-501/-Users-sparelaptop-Projects-betterterm/c7721603-046f-404c-b263-c94a8eb39cc8/scratchpad/builder-install-prune';
mkdirSync(SCRATCH, { recursive: true });

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

/** A fresh case folder with source/, dest/ and outside/ (for symlink targets). */
function makeCase(name) {
  const root = mkdtempSync(join(SCRATCH, `${name}-`));
  const dirs = { root, source: join(root, 'source'), dest: join(root, 'dest'), outside: join(root, 'outside') };
  for (const d of [dirs.source, dirs.dest, dirs.outside]) mkdirSync(d);
  return dirs;
}
function put(base, rel, content = 'x') {
  const full = join(base, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
/** Every path under base (symlinks not followed), relative, sorted. */
function listTree(base) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      out.push(relative(base, full));
      if (lstatSync(full).isDirectory()) walk(full);
    }
  };
  walk(base);
  return out;
}
const quiet = () => ({ lines: [], warnings: [], log(m) { this.lines.push(m); }, warn(m) { this.warnings.push(m); } });
const FW = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries';

// The real case: both trees share the new build's files; dest also holds the two dylibs.
function realisticCase(name) {
  const c = makeCase(name);
  for (const base of [c.source, c.dest]) {
    put(base, 'Contents/MacOS/Patton', 'bin');
    put(base, 'Contents/Resources/app.asar', 'asar');
    put(base, `${FW}/libffmpeg.dylib`, 'ff');
  }
  put(c.dest, `${FW}/libEGL.dylib`, 'egl');
  put(c.dest, `${FW}/libGLESv2.dylib`, 'gles');
  return c;
}

// 1. Extras removed when Patton is not running; everything else left alone.
{
  const c = realisticCase('removed');
  const before = listTree(c.source);
  const out = quiet();
  const res = pruneStale(c.source, c.dest, { isRunning: () => false, log: (m) => out.log(m), warn: (m) => out.warn(m) });
  check('not running: both extra dylibs removed',
    !existsSync(join(c.dest, FW, 'libEGL.dylib')) && !existsSync(join(c.dest, FW, 'libGLESv2.dylib')));
  check('not running: dest now matches source exactly', JSON.stringify(listTree(c.dest)) === JSON.stringify(before), listTree(c.dest));
  check('not running: shared files keep their content', readFileSync(join(c.dest, FW, 'libffmpeg.dylib'), 'utf8') === 'ff');
  check('not running: result lists the two removed paths',
    res.removed.length === 2 && res.removed.includes(`${FW}/libEGL.dylib`) && res.removed.includes(`${FW}/libGLESv2.dylib`), res);
  check('not running: each removed path logged relative to dest',
    out.lines.some((l) => l.includes(`${FW}/libEGL.dylib`) && !l.includes(c.dest)) &&
    out.lines.some((l) => l.includes(`${FW}/libGLESv2.dylib`) && !l.includes(c.dest)), out.lines);
  check('not running: no warning printed', out.warnings.length === 0, out.warnings);
  check('not running: source tree untouched', JSON.stringify(listTree(c.source)) === JSON.stringify(before));
}

// 2. Nested stale files, an emptied directory, children before parents.
{
  const c = makeCase('nested');
  put(c.source, 'keep/a.txt');
  put(c.dest, 'keep/a.txt');
  put(c.dest, 'keep/old/deep/er/file.bin');
  put(c.dest, 'gone-dir/one.txt');
  mkdirSync(join(c.dest, 'empty-stale-dir'));
  const out = quiet();
  const res = pruneStale(c.source, c.dest, { isRunning: () => false, log: (m) => out.log(m), warn: (m) => out.warn(m) });
  check('nested: dest equals source after pruning', JSON.stringify(listTree(c.dest)) === JSON.stringify(['keep', 'keep/a.txt']), listTree(c.dest));
  check('nested: emptied directories are removed too',
    !existsSync(join(c.dest, 'gone-dir')) && !existsSync(join(c.dest, 'empty-stale-dir')) && !existsSync(join(c.dest, 'keep/old')));
  const order = res.removed;
  check('nested: deepest first (a child is removed before its parent)',
    order.indexOf('keep/old/deep/er/file.bin') < order.indexOf('keep/old/deep/er') &&
    order.indexOf('keep/old/deep/er') < order.indexOf('keep/old/deep') &&
    order.indexOf('keep/old/deep') < order.indexOf('keep/old'), order);
  check('nested: a kept directory with a kept file stays', existsSync(join(c.dest, 'keep/a.txt')));
}

// 3. Symlinks: a stale link to outside is removed as a link; its target is untouched;
//    a link in both trees is kept; a stale link to a directory is not entered.
{
  const c = makeCase('symlink');
  put(c.outside, 'precious/data.txt', 'precious');
  put(c.outside, 'lone.txt', 'lone');
  put(c.source, 'Versions/A/lib.dylib');
  put(c.dest, 'Versions/A/lib.dylib');
  symlinkSync('A', join(c.source, 'Versions/Current'));
  symlinkSync('A', join(c.dest, 'Versions/Current'));
  symlinkSync(join(c.outside, 'precious'), join(c.dest, 'stale-dirlink'));
  symlinkSync(join(c.outside, 'lone.txt'), join(c.dest, 'stale-filelink'));
  symlinkSync(join(c.outside, 'nowhere'), join(c.dest, 'stale-dangling'));
  const found = findStalePaths(c.source, c.dest);
  check('symlink: stale links listed, never entered (no paths below a link)',
    JSON.stringify(found) === JSON.stringify(['stale-dangling', 'stale-dirlink', 'stale-filelink']), found);
  const out = quiet();
  pruneStale(c.source, c.dest, { isRunning: () => false, log: (m) => out.log(m), warn: (m) => out.warn(m) });
  check('symlink: stale links removed',
    ['stale-dirlink', 'stale-filelink', 'stale-dangling'].every((n) => { try { lstatSync(join(c.dest, n)); return false; } catch { return true; } }));
  check('symlink: link target directory and its file untouched',
    readFileSync(join(c.outside, 'precious/data.txt'), 'utf8') === 'precious');
  check('symlink: link target file untouched', readFileSync(join(c.outside, 'lone.txt'), 'utf8') === 'lone');
  check('symlink: a link that exists in both trees is kept as a link',
    lstatSync(join(c.dest, 'Versions/Current')).isSymbolicLink() && readlinkSync(join(c.dest, 'Versions/Current')) === 'A');
}

// 4. Patton running: nothing removed, stale paths listed with the rerun advice.
{
  const c = realisticCase('running');
  const beforeDest = listTree(c.dest);
  const out = quiet();
  const res = pruneStale(c.source, c.dest, { isRunning: () => true, log: (m) => out.log(m), warn: (m) => out.warn(m) });
  check('running: nothing removed', JSON.stringify(listTree(c.dest)) === JSON.stringify(beforeDest));
  check('running: result reports running and the stale paths', res.running === true && res.removed.length === 0 && res.stale.length === 2, res);
  const text = out.warnings.join('\n');
  check('running: warning lists both stale paths', text.includes(`${FW}/libEGL.dylib`) && text.includes(`${FW}/libGLESv2.dylib`), text);
  check('running: warning says to rerun npm run install-app with Patton quit',
    text.includes('npm run install-app') && /quit/i.test(text), text);
  check('running: nothing logged as removed', out.lines.length === 0, out.lines);
}

// 5. A failing running-check counts as running, and says so.
{
  const c = realisticCase('failcheck');
  const beforeDest = listTree(c.dest);
  const out = quiet();
  const res = pruneStale(c.source, c.dest, {
    isRunning: () => { throw new Error('pgrep exploded'); },
    log: (m) => out.log(m), warn: (m) => out.warn(m),
  });
  check('failing check: nothing removed', JSON.stringify(listTree(c.dest)) === JSON.stringify(beforeDest));
  check('failing check: treated as running', res.running === true, res);
  check('failing check: the reason is printed', out.warnings.some((w) => w.includes('pgrep exploded')), out.warnings);
  check('failing check: stale paths still listed', out.warnings.some((w) => w.includes('libEGL.dylib')), out.warnings);
}

// 6. Identical trees: a no-op that never asks whether Patton is running.
{
  const c = makeCase('identical');
  for (const base of [c.source, c.dest]) { put(base, 'a/b.txt'); put(base, 'c.txt'); }
  symlinkSync('c.txt', join(c.source, 'link'));
  symlinkSync('c.txt', join(c.dest, 'link'));
  const before = listTree(c.dest);
  const out = quiet();
  let asked = false;
  const res = pruneStale(c.source, c.dest, { isRunning: () => { asked = true; return false; }, log: (m) => out.log(m), warn: (m) => out.warn(m) });
  check('identical: no stale paths, nothing removed', res.stale.length === 0 && res.removed.length === 0, res);
  check('identical: tree unchanged, nothing printed', JSON.stringify(listTree(c.dest)) === JSON.stringify(before) && out.lines.length === 0 && out.warnings.length === 0);
  check('identical: the running-check is not even asked', asked === false);
}

// 7. Files only in source (new in the build) are not touched or created by pruning.
{
  const c = makeCase('newfile');
  put(c.source, 'new-in-build.txt');
  put(c.dest, 'old.txt');
  pruneStale(c.source, c.dest, { isRunning: () => false, log: () => {}, warn: () => {} });
  check('source-only file is neither created in dest nor removed from source',
    !existsSync(join(c.dest, 'new-in-build.txt')) && existsSync(join(c.source, 'new-in-build.txt')) && !existsSync(join(c.dest, 'old.txt')));
}

// 8. Nothing outside dest is touched: a sibling of dest and its parent survive.
{
  const c = realisticCase('outside');
  put(c.root, 'sibling/keep.txt', 'sib');
  put(c.outside, 'other.txt', 'other');
  const siblingBefore = listTree(join(c.root, 'sibling'));
  const outsideBefore = listTree(c.outside);
  pruneStale(c.source, c.dest, { isRunning: () => false, log: () => {}, warn: () => {} });
  check('outside dest: sibling folder and external folder unchanged',
    JSON.stringify(listTree(join(c.root, 'sibling'))) === JSON.stringify(siblingBefore) &&
    JSON.stringify(listTree(c.outside)) === JSON.stringify(outsideBefore));
}

// 9. Signature verification: success is one line, failure is loud with codesign's output, neither throws.
{
  const okOut = quiet();
  const okRes = verifySignature('/x/Patton.app', { run: () => '', log: (m) => okOut.log(m), warn: (m) => okOut.warn(m) });
  check('codesign ok: returns true, one confirmation line, no warning',
    okRes === true && okOut.lines.length === 1 && okOut.warnings.length === 0, okOut);
  const badOut = quiet();
  const badRes = verifySignature('/x/Patton.app', {
    run: () => { const e = new Error('Command failed'); e.stderr = 'a sealed resource is missing or invalid'; throw e; },
    log: (m) => badOut.log(m), warn: (m) => badOut.warn(m),
  });
  check('codesign failure: returns false without throwing', badRes === false);
  check('codesign failure: loud warning carries codesign output, no confirmation line',
    badOut.warnings.length === 1 && badOut.warnings[0].includes('FAILED') &&
    badOut.warnings[0].includes('a sealed resource is missing or invalid') && badOut.lines.length === 0, badOut);
}

// Tidy the case folders this run made (inside the scratch folder only).
for (const name of readdirSync(SCRATCH)) {
  if (/^(removed|nested|symlink|running|failcheck|identical|newfile|outside)-/.test(name)) {
    rmSync(join(SCRATCH, name), { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
