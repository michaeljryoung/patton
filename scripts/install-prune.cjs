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
    // ENOTDIR (a parent is a file) is unreachable in the install flow, because
    // ditto exits 1 on a file/directory mismatch before this runs; it stays as
    // a cheap guard for the helper used on other trees.
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

/** Longest a matched command line is printed in a warning. */
const MAX_MATCH_LENGTH = 200;

/**
 * Is a process running out of dest? Returns '' when none, else a short
 * description of what matched ("pid 123 /…/Contents/MacOS/Patton …").
 * The pattern is anchored to the start of the command line, so a process that
 * merely mentions a path under dest in its arguments does not count.
 * Throws if pgrep itself fails.
 */
function isRunningFrom(dest) {
  const pattern = '^' + `${dest}/Contents/`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    // No shell: a shell's own command line would match the pattern.
    const out = execFileSync('pgrep', ['-lf', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    const shown = lines.slice(0, 3).map((l) => `pid ${l.length > MAX_MATCH_LENGTH ? `${l.slice(0, MAX_MATCH_LENGTH)}…` : l}`);
    const more = lines.length > 3 ? ` (+${lines.length - 3} more)` : '';
    return (shown.join('; ') || 'a process') + more;
  } catch (err) {
    if (err.status === 1) return ''; // pgrep: no match
    throw err;
  }
}

/** Remove one stale path: a link or file is unlinked, an empty directory rmdir'd. */
function removeOne(full) {
  if (fs.lstatSync(full).isDirectory()) fs.rmdirSync(full);
  else fs.unlinkSync(full);
}

/** Files a usable build always has; a source without them is partial or missing. */
const REQUIRED_SOURCE_FILES = ['Contents/MacOS/Patton', 'Contents/Resources/app.asar'];

/**
 * Remove (or, with Patton running, only list) what dest has and source doesn't.
 * Returns { stale, removed, failed, running, skipped }. A failing is-running
 * check counts as running, the safe side. A source lacking requiredFiles is
 * not pruned against (it would empty dest). A path that cannot be removed is
 * warned about and the rest carry on; nothing here throws for those.
 */
function pruneStale(source, dest, options = {}) {
  const isRunning = options.isRunning || isRunningFrom;
  const log = options.log || console.log;
  const warn = options.warn || console.warn;
  const requiredFiles = options.requiredFiles || REQUIRED_SOURCE_FILES;

  const missing = requiredFiles.filter((rel) => lstatOrNull(path.join(source, rel)) === null);
  if (missing.length > 0) {
    warn(`Skipping the stale-file prune: the new build at ${source} lacks ${missing.join(', ')}, so it cannot be trusted as the reference.`);
    return { stale: [], removed: [], failed: [], running: false, skipped: true };
  }

  const stale = findStalePaths(source, dest);
  if (stale.length === 0) return { stale, removed: [], failed: [], running: false, skipped: false };

  let running;
  let matched = '';
  try {
    running = isRunning(dest);
    if (typeof running === 'string') { matched = running; running = running !== ''; }
  } catch (err) {
    running = true;
    matched = `the check itself failed: ${err.message}`;
    warn(`Could not tell whether Patton is running from ${dest} (${err.message}); treating it as running.`);
  }

  if (running) {
    warn(
      `\n⚠️  ${stale.length} path(s) in ${dest} are not in the new build, and Patton is running from it, ` +
      'so none were removed (a running app may lazily load one of them). ' +
      (matched ? `Matched: ${matched}. ` : '') +
      'They can break the code signature. Quit Patton and rerun `npm run install-app`:',
    );
    for (const rel of stale) warn(`   ${rel}`);
    return { stale, removed: [], failed: [], running: true, skipped: false };
  }

  const removed = [];
  const failed = [];
  for (let i = stale.length - 1; i >= 0; i--) { // children before their parents
    try {
      removeOne(path.join(dest, stale[i]));
      removed.push(stale[i]);
      log(`🧹 Removed stale ${stale[i]}`);
    } catch (err) {
      failed.push(stale[i]);
      warn(`⚠️  Could not remove stale ${path.join(dest, stale[i])}: ${err.message}`);
    }
  }
  return { stale, removed, failed, running: false, skipped: false };
}

/** The codesign arguments for verifying a bundle. */
function codesignArgs(target) {
  return ['--verify', '--deep', '--strict', target];
}

/** Run codesign's verify on dest. Returns true when it verifies. Never throws. */
function verifySignature(dest, options = {}) {
  const log = options.log || console.log;
  const warn = options.warn || console.warn;
  const exec = options.exec || execFileSync;
  try {
    exec('codesign', codesignArgs(dest), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    log(`✅ codesign --verify --deep --strict passed for ${dest}`);
    return true;
  } catch (err) {
    const output = `${err.stderr || ''}${err.stdout || ''}`.trim() || err.message;
    warn(`\n❌ ${dest} FAILED codesign --verify --deep --strict. The installed app's signature is broken:\n${output}`);
    return false;
  }
}

/**
 * What postPackage calls after the ditto: prune, then verify. Neither may fail
 * the build (Forge does not catch hook errors), so anything either throws is
 * reported as a warning and swallowed.
 */
function pruneAndVerify(source, dest, options = {}) {
  const warn = options.warn || console.warn;
  try {
    pruneStale(source, dest, options);
  } catch (err) {
    warn(`⚠️  Stale-file prune of ${dest} failed unexpectedly: ${err && err.message ? err.message : err}`);
  }
  try {
    verifySignature(dest, options);
  } catch (err) {
    warn(`⚠️  Signature check of ${dest} failed unexpectedly: ${err && err.message ? err.message : err}`);
  }
}

module.exports = { findStalePaths, isRunningFrom, pruneStale, codesignArgs, verifySignature, pruneAndVerify };
