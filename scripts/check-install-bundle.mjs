// Headless check of the local install's stale-file pruning (S46): after
// `ditto` overwrites /Applications/Patton.app, files the new build no longer
// ships must go (they break the code signature), unless Patton is running from
// the bundle, in which case they are only listed. Drives the REAL helper
// (scripts/install-prune.cjs) on temp source and dest trees; the running-check,
// codesign and lsregister are injected, and nothing outside the temp trees is touched.
// Run: node scripts/check-install-bundle.mjs   (no extra dependencies)
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const {
  findStalePaths, isRunningFrom, pruneStale, codesignArgs, verifySignature, refreshIcon, LSREGISTER, pruneAndVerify,
} = createRequire(import.meta.url)(join(here, 'install-prune.cjs'));

const SCRATCH = mkdtempSync(join(tmpdir(), 'patton-install-bundle-'));

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
  const res = pruneStale(c.source, c.dest, { requiredFiles: [], isRunning: () => false, log: (m) => out.log(m), warn: (m) => out.warn(m) });
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
  const res = pruneStale(c.source, c.dest, { requiredFiles: [], isRunning: () => false, log: (m) => out.log(m), warn: (m) => out.warn(m) });
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
  pruneStale(c.source, c.dest, { requiredFiles: [], isRunning: () => false, log: (m) => out.log(m), warn: (m) => out.warn(m) });
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
  const res = pruneStale(c.source, c.dest, { requiredFiles: [], isRunning: () => true, log: (m) => out.log(m), warn: (m) => out.warn(m) });
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
    requiredFiles: [],
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
  const res = pruneStale(c.source, c.dest, { requiredFiles: [], isRunning: () => { asked = true; return false; }, log: (m) => out.log(m), warn: (m) => out.warn(m) });
  check('identical: no stale paths, nothing removed', res.stale.length === 0 && res.removed.length === 0, res);
  check('identical: tree unchanged, nothing printed', JSON.stringify(listTree(c.dest)) === JSON.stringify(before) && out.lines.length === 0 && out.warnings.length === 0);
  check('identical: the running-check is not even asked', asked === false);
}

// 7. Files only in source (new in the build) are not touched or created by pruning.
{
  const c = makeCase('newfile');
  put(c.source, 'new-in-build.txt');
  put(c.dest, 'old.txt');
  pruneStale(c.source, c.dest, { requiredFiles: [], isRunning: () => false, log: () => {}, warn: () => {} });
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
  pruneStale(c.source, c.dest, { requiredFiles: [], isRunning: () => false, log: () => {}, warn: () => {} });
  check('outside dest: sibling folder and external folder unchanged',
    JSON.stringify(listTree(join(c.root, 'sibling'))) === JSON.stringify(siblingBefore) &&
    JSON.stringify(listTree(c.outside)) === JSON.stringify(outsideBefore));
}

// 9. Signature verification: success is one line, failure is loud with codesign's output, neither throws.
{
  const okOut = quiet();
  const okRes = verifySignature('/x/Patton.app', { exec: () => '', log: (m) => okOut.log(m), warn: (m) => okOut.warn(m) });
  check('codesign ok: returns true, one confirmation line, no warning',
    okRes === true && okOut.lines.length === 1 && okOut.warnings.length === 0, okOut);
  const badOut = quiet();
  const badRes = verifySignature('/x/Patton.app', {
    exec: () => { const e = new Error('Command failed'); e.stderr = 'a sealed resource is missing or invalid'; throw e; },
    log: (m) => badOut.log(m), warn: (m) => badOut.warn(m),
  });
  check('codesign failure: returns false without throwing', badRes === false);
  check('codesign failure: loud warning carries codesign output, no confirmation line',
    badOut.warnings.length === 1 && badOut.warnings[0].includes('FAILED') &&
    badOut.warnings[0].includes('a sealed resource is missing or invalid') && badOut.lines.length === 0, badOut);
}

// 10. The REAL running-check against real processes. A copy of /bin/sleep (re-signed
//     ad hoc, or macOS kills the copy) sits at <dest>/Contents/MacOS/Patton and is
//     started by absolute path, so its argv[0] is under dest, like Patton's. Only
//     PIDs started here are ever signalled.
{
  const c = makeCase('realrun');
  const exe = join(c.dest, 'Contents/MacOS/Patton');
  mkdirSync(dirname(exe), { recursive: true });
  copyFileSync('/bin/sleep', exe);
  chmodSync(exe, 0o755);
  execFileSync('codesign', ['-f', '-s', '-', exe], { stdio: 'ignore' });
  const started = [];
  // detached: its own process group, so a shell and its sleep go together (kill(-pid)).
  const startAndWait = async (cmd, args) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    started.push(child);
    await new Promise((r) => setTimeout(r, 400));
    return child;
  };
  try {
    check('real check: nothing running from dest yet -> falsy', !isRunningFrom(c.dest));

    // argv only MENTIONS the path (a shell running ls on it): must not count.
    const mention = await startAndWait('/bin/sh', ['-c', `sleep 20 ; ls -l ${c.dest}/Contents/Resources/app.asar`]);
    check('real check: a process whose argv only mentions a path under dest does not count',
      !isRunningFrom(c.dest), isRunningFrom(c.dest));
    process.kill(-mention.pid);

    // The same for a sibling dir whose name merely contains dest (e.g. ~/Applications/Patton.app).
    const nested = join(c.root, 'home', c.dest);
    mkdirSync(join(nested, 'Contents/MacOS'), { recursive: true });
    const nestedExe = join(nested, 'Contents/MacOS/Patton');
    copyFileSync(exe, nestedExe);
    const nestedChild = await startAndWait(nestedExe, ['20']);
    check('real check: a process running from a path that merely ends with dest does not count',
      !isRunningFrom(c.dest), isRunningFrom(c.dest));
    nestedChild.kill();

    const running = await startAndWait(exe, ['20']);
    const match = isRunningFrom(c.dest);
    check('real check: a process running from dest counts', !!match, match);
    check('real check: the match names the pid and the command',
      typeof match === 'string' && match.includes(`pid ${running.pid} `) && match.includes(exe), match);

    // End to end through pruneStale with the REAL check: nothing removed, the warning names the match.
    put(c.source, 'Contents/MacOS/Patton', 'bin');
    put(c.source, 'Contents/Resources/app.asar', 'asar');
    put(c.dest, 'Contents/Resources/app.asar', 'asar');
    put(c.dest, 'Contents/stale.dylib', 'stale');
    const out = quiet();
    const res = pruneStale(c.source, c.dest, { log: (m) => out.log(m), warn: (m) => out.warn(m) });
    check('real check: prune skips while Patton runs, warning names pid and command',
      res.running === true && existsSync(join(c.dest, 'Contents/stale.dylib')) &&
      out.warnings.join('\n').includes(`pid ${running.pid} `) && out.warnings.join('\n').includes(exe), out.warnings);

    running.kill();
    await new Promise((r) => setTimeout(r, 400));
    check('real check: after the process is killed -> falsy', !isRunningFrom(c.dest), isRunningFrom(c.dest));
    const out2 = quiet();
    const res2 = pruneStale(c.source, c.dest, { log: (m) => out2.log(m), warn: (m) => out2.warn(m) });
    check('real check: prune removes the stale file once nothing runs',
      res2.running === false && !existsSync(join(c.dest, 'Contents/stale.dylib')), res2);
  } finally {
    for (const child of started) { try { process.kill(-child.pid); } catch { /* already gone */ } }
  }
}

// 11. Codesign flags: the command builder and what verifySignature really runs.
{
  const args = codesignArgs('/x/Patton.app');
  check('codesign args: --verify --deep --strict then the target',
    JSON.stringify(args) === JSON.stringify(['--verify', '--deep', '--strict', '/x/Patton.app']), args);
  let call = null;
  verifySignature('/x/Patton.app', { exec: (cmd, a) => { call = { cmd, a }; return ''; }, log: () => {}, warn: () => {} });
  check('codesign call: verifySignature runs codesign with those exact args',
    call !== null && call.cmd === 'codesign' && JSON.stringify(call.a) === JSON.stringify(args), call);
}

// 12. An unremovable path is warned about, the rest are still pruned, and nothing throws.
{
  const c = realisticCase('unremovable');
  put(c.dest, 'locked/stuck.txt', 'stuck');
  put(c.dest, 'other-stale.txt', 'other');
  const lockedDir = join(c.dest, 'locked');
  chmodSync(lockedDir, 0o555); // cannot unlink stuck.txt
  const out = quiet();
  let res;
  let threw = null;
  try {
    res = pruneStale(c.source, c.dest, { isRunning: () => false, log: (m) => out.log(m), warn: (m) => out.warn(m) });
  } catch (err) { threw = err; }
  chmodSync(lockedDir, 0o755);
  const warnText = out.warnings.join('\n');
  check('unremovable: pruneStale does not throw', threw === null, threw && threw.message);
  check('unremovable: the other stale paths are still removed',
    !existsSync(join(c.dest, 'other-stale.txt')) && !existsSync(join(c.dest, FW, 'libEGL.dylib')));
  check('unremovable: the warning names the path and the error',
    warnText.includes(join(lockedDir, 'stuck.txt')) && /EACCES|EPERM|permission/i.test(warnText), warnText);
  check('unremovable: result lists it as failed, not removed',
    res && res.failed.includes('locked/stuck.txt') && !res.removed.includes('locked/stuck.txt'), res);

  // pruneAndVerify swallows whatever escapes, and still runs the signature check.
  const out2 = quiet();
  let verified = false;
  let escaped = null;
  try {
    pruneAndVerify(join(c.root, 'no-such-source'), join(c.root, 'no-such-dest'), {
      requiredFiles: [], isRunning: () => false,
      exec: () => { verified = true; return ''; },
      log: (m) => out2.log(m), warn: (m) => out2.warn(m),
    });
  } catch (err) { escaped = err; }
  check('pruneAndVerify: a throw inside the prune is a warning, not an escape', escaped === null, escaped && escaped.message);
  check('pruneAndVerify: the signature check still runs after a failed prune', verified === true);
  check('pruneAndVerify: the failure is warned about', out2.warnings.some((w) => w.includes('failed unexpectedly')), out2.warnings);
}

// 13. A missing or partial source bundle must not empty dest.
{
  for (const [label, drop] of [['no binary', 'Contents/MacOS/Patton'], ['no asar', 'Contents/Resources/app.asar'], ['empty source', null]]) {
    const c = realisticCase('partial');
    if (drop) rmSync(join(c.source, drop));
    else rmSync(join(c.source, 'Contents'), { recursive: true, force: true });
    const before = listTree(c.dest);
    const out = quiet();
    const res = pruneStale(c.source, c.dest, { isRunning: () => false, log: (m) => out.log(m), warn: (m) => out.warn(m) });
    check(`partial source (${label}): dest untouched`, JSON.stringify(listTree(c.dest)) === JSON.stringify(before));
    check(`partial source (${label}): skipped with a warning`,
      res.skipped === true && res.removed.length === 0 && out.warnings.length === 1 && out.warnings[0].includes('lacks'), out.warnings);
  }
  const c = realisticCase('partial');
  const res = pruneStale(c.source, c.dest, { isRunning: () => false, log: () => {}, warn: () => {} });
  check('complete source: prune goes ahead', res.skipped === false && res.removed.length === 2, res);
}

// 14. refreshIcon (S67): the bundle's mtime moves to now and lsregister -f runs; never throws, never restarts the Dock.
{
  const OLD = new Date('2026-11-24T16:10:00Z');
  const staleBundle = (name) => {
    const c = makeCase(name);
    utimesSync(c.dest, OLD, OLD);
    return c;
  };
  const c = staleBundle('icon');
  // Sentinel times on the bundle's parent folder and on dest/Contents: the bump must leave both alone.
  const SENTINEL = new Date('2026-01-02T03:04:05Z');
  mkdirSync(join(c.dest, 'Contents'));
  utimesSync(join(c.dest, 'Contents'), SENTINEL, SENTINEL);
  utimesSync(c.root, SENTINEL, SENTINEL);
  const out = quiet();
  const calls = [];
  const t0 = Date.now();
  let threw = null;
  try {
    refreshIcon(c.dest, { exec: (cmd, a, o) => { calls.push({ cmd, a, o }); return ''; }, env: {}, log: (m) => out.log(m), warn: (m) => out.warn(m) });
  } catch (err) { threw = err; }
  const mtime = lstatSync(c.dest).mtimeMs;
  check('refreshIcon: does not throw', threw === null, threw && threw.message);
  check("refreshIcon: the bundle's parent folder keeps its mtime", lstatSync(c.root).mtimeMs === SENTINEL.getTime(), lstatSync(c.root).mtimeMs);
  check('refreshIcon: dest/Contents keeps its mtime', lstatSync(join(c.dest, 'Contents')).mtimeMs === SENTINEL.getTime(), lstatSync(join(c.dest, 'Contents')).mtimeMs);
  check('refreshIcon: passes lsregister a 30 s timeout', calls.length === 1 && calls[0].o && calls[0].o.timeout === 30000, calls);
  check("refreshIcon: the bundle folder's mtime moves to now", mtime >= t0 - 1000 && mtime <= Date.now() + 1000, { mtime, old: OLD.getTime() });
  check('refreshIcon: runs lsregister -f on dest, and only that',
    calls.length === 1 && calls[0].cmd === LSREGISTER && JSON.stringify(calls[0].a) === JSON.stringify(['-f', c.dest]), calls);
  check("refreshIcon: the lsregister path is Launch Services' own tool",
    LSREGISTER === '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', LSREGISTER);
  check('refreshIcon: logs one line and warns nothing', out.lines.length === 1 && out.warnings.length === 0, out);
  // Limit of this check: it sees only commands that go through the injected exec. A Dock
  // restart made any other way (fs, a spawn, osascript) would not show up here.
  check('refreshIcon: never restarts the Dock', calls.every((x) => !/Dock/.test(x.cmd) && !x.a.some((y) => /Dock/.test(y))), calls);

  const c2 = staleBundle('icon-throws');
  const out2 = quiet();
  let threw2 = null;
  try {
    refreshIcon(c2.dest, { exec: () => { throw new Error('lsregister exploded'); }, env: {}, log: (m) => out2.log(m), warn: (m) => out2.warn(m) });
  } catch (err) { threw2 = err; }
  check('refreshIcon: an exec that throws does not throw out', threw2 === null, threw2 && threw2.message);
  check('refreshIcon: a throwing exec gives one warning naming the error',
    out2.warnings.length === 1 && out2.warnings[0].includes('lsregister exploded'), out2.warnings);

  const c3 = makeCase('icon-missing');
  const out3 = quiet();
  let threw3 = null;
  try {
    refreshIcon(join(c3.root, 'no-such-app'), { exec: () => '', env: {}, log: (m) => out3.log(m), warn: (m) => out3.warn(m) });
  } catch (err) { threw3 = err; }
  check('refreshIcon: a missing dest does not throw', threw3 === null, threw3 && threw3.message);
  check('refreshIcon: a missing dest is warned about', out3.warnings.length === 1, out3.warnings);

  // A failed bump (missing dest, or an injected utimes that throws) must not stop lsregister -f.
  for (const [label, extra, dest] of [
    ['a missing dest', {}, join(c3.root, 'no-such-app')],
    ['a utimes that throws EPERM', { utimes: () => { throw new Error('EPERM: operation not permitted'); } }, c3.dest],
  ]) {
    const calls6 = [];
    const out6 = quiet();
    refreshIcon(dest, { exec: (cmd, a) => { calls6.push({ cmd, a }); return ''; }, env: {}, log: (m) => out6.log(m), warn: (m) => out6.warn(m), ...extra });
    check(`refreshIcon: with ${label}, lsregister -f dest still runs`,
      calls6.length === 1 && calls6[0].cmd === LSREGISTER && JSON.stringify(calls6[0].a) === JSON.stringify(['-f', dest]), calls6);
    check(`refreshIcon: with ${label}, the failed bump is one warning`, out6.warnings.length === 1 && /modified time/.test(out6.warnings[0]), out6.warnings);
  }

  // CI has no Dock: skipped entirely with one log line, no exec, no mtime change.
  {
    const c7 = staleBundle('icon-ci');
    const calls7 = [];
    const out7 = quiet();
    refreshIcon(c7.dest, { exec: (cmd, a) => { calls7.push({ cmd, a }); return ''; }, env: { CI: 'true' }, log: (m) => out7.log(m), warn: (m) => out7.warn(m) });
    check('refreshIcon: CI set runs nothing', calls7.length === 0, calls7);
    check('refreshIcon: CI set leaves the mtime alone', lstatSync(c7.dest).mtimeMs === OLD.getTime(), lstatSync(c7.dest).mtimeMs);
    check('refreshIcon: CI set logs one skip line and warns nothing', out7.lines.length === 1 && /CI/.test(out7.lines[0]) && out7.warnings.length === 0, out7);
  }

  // pruneAndVerify calls it, with the injected exec, on a temp tree.
  const c4 = realisticCase('icon-prune');
  utimesSync(c4.dest, OLD, OLD);
  const execCalls = [];
  const out4 = quiet();
  const t4 = Date.now();
  pruneAndVerify(c4.source, c4.dest, {
    isRunning: () => false,
    env: {},
    exec: (cmd, a) => { execCalls.push({ cmd, a }); return ''; },
    log: (m) => out4.log(m), warn: (m) => out4.warn(m),
  });
  check('pruneAndVerify: calls refreshIcon (lsregister -f dest through the injected exec)',
    execCalls.some((x) => x.cmd === LSREGISTER && JSON.stringify(x.a) === JSON.stringify(['-f', c4.dest])), execCalls);
  check('pruneAndVerify: the refresh comes after the signature check',
    execCalls.length === 2 && execCalls[0].cmd === 'codesign' && execCalls[1].cmd === LSREGISTER, execCalls);
  check("pruneAndVerify: the bundle folder's mtime moved to now", lstatSync(c4.dest).mtimeMs >= t4 - 1000);
  const out5 = quiet();
  let threw5 = null;
  try {
    pruneAndVerify(c4.source, c4.dest, {
      isRunning: () => false,
      env: {},
      exec: (cmd) => { if (cmd === LSREGISTER) throw new Error('no lsregister'); return ''; },
      log: (m) => out5.log(m), warn: (m) => out5.warn(m),
    });
  } catch (err) { threw5 = err; }
  check('pruneAndVerify: a failing lsregister is a warning, not an escape',
    threw5 === null && out5.warnings.some((w) => w.includes('no lsregister')), { threw5, w: out5.warnings });
}

// Tidy: the whole temp folder this run made.
rmSync(SCRATCH, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
