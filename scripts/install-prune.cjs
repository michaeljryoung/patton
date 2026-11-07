// Local install helpers for forge.config.ts's postPackage (S46).
// `ditto` overwrites /Applications/Patton.app in place, so files a newer build
// no longer ships linger in the installed bundle and break its code signature
// ("a sealed resource is missing or invalid"). Installing Electron 44.9.3 over
// 44.7.0 left libEGL.dylib and libGLESv2.dylib behind. After the ditto,
// pruneStale() finds every path in the installed bundle that the fresh build
// doesn't have and removes it, unless Patton is running from there, and
// verifySignature() reports whether the result still verifies.
// Plain CommonJS: forge.config.ts imports it and scripts/check-install-bundle.mjs
// drives it with temp trees. dest and the is-running check are parameters.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** lstat that answers null for "not there" (also when a parent is a file). */
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Every path (file, symlink, directory) under dest that is not in source, as
 * paths relative to dest, parents before their children. Symlinks are never
 * followed: a link is compared and listed as a link.
 */
function findStalePaths(source, dest) {
  const stale = [];
  const walk = (rel) => {
    const names = fs.readdirSync(path.join(dest, rel)).sort();
    for (const name of names) {
      const entryRel = path.join(rel, name);
      if (lstatOrNull(path.join(source, entryRel)) === null) stale.push(entryRel);
      // A symlink to a directory is not isDirectory() under lstat, so it is never entered.
      if (fs.lstatSync(path.join(dest, entryRel)).isDirectory()) walk(entryRel);
    }
  };
  walk('');
  return stale;
}

/** Is a process running out of dest? Throws if pgrep itself fails. */
function isRunningFrom(dest) {
  const pattern = `${dest}/Contents/`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    // No shell: a shell's own command line would match the pattern.
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if (err.status === 1) return false; // pgrep: no match
    throw err;
  }
}

/** Remove one stale path: a link or file is unlinked, an empty directory rmdir'd. */
function removeOne(full) {
  if (fs.lstatSync(full).isDirectory()) fs.rmdirSync(full);
  else fs.unlinkSync(full);
}

/**
 * Remove (or, with Patton running, only list) what dest has and source doesn't.
 * Returns { stale, removed, running }. A failing is-running check counts as
 * running, the safe side.
 */
function pruneStale(source, dest, options = {}) {
  const isRunning = options.isRunning || isRunningFrom;
  const log = options.log || console.log;
  const warn = options.warn || console.warn;

  const stale = findStalePaths(source, dest);
  if (stale.length === 0) return { stale, removed: [], running: false };

  let running;
  try {
    running = isRunning(dest);
  } catch (err) {
    running = true;
    warn(`Could not tell whether Patton is running from ${dest} (${err.message}); treating it as running.`);
  }

  if (running) {
    warn(
      `\n⚠️  ${stale.length} path(s) in ${dest} are not in the new build, and Patton is running from it, ` +
      'so none were removed (a running app may lazily load one of them). ' +
      'They can break the code signature. Quit Patton and rerun `npm run install-app`:',
    );
    for (const rel of stale) warn(`   ${rel}`);
    return { stale, removed: [], running: true };
  }

  const removed = [];
  for (let i = stale.length - 1; i >= 0; i--) { // children before their parents
    removeOne(path.join(dest, stale[i]));
    removed.push(stale[i]);
    log(`🧹 Removed stale ${stale[i]}`);
  }
  return { stale, removed, running: false };
}

/** Run codesign's verify on dest. Returns true when it verifies. Never throws. */
function verifySignature(dest, options = {}) {
  const log = options.log || console.log;
  const warn = options.warn || console.warn;
  const run = options.run || ((target) => execFileSync(
    'codesign', ['--verify', '--deep', '--strict', target],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ));
  try {
    run(dest);
    log(`✅ codesign --verify --deep --strict passed for ${dest}`);
    return true;
  } catch (err) {
    const output = `${err.stderr || ''}${err.stdout || ''}`.trim() || err.message;
    warn(`\n❌ ${dest} FAILED codesign --verify --deep --strict. The installed app's signature is broken:\n${output}`);
    return false;
  }
}

module.exports = { findStalePaths, isRunningFrom, pruneStale, verifySignature };
