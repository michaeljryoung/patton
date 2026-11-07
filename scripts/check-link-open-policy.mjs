// Check of src/main/link-open-policy.ts: what a double-clicked file link may do.
// Run: node scripts/check-link-open-policy.mjs [fixture-dir]
// Builds fixture files (an .app folder, executables, every risky type…) in
// fixture-dir (default: a fresh temp folder) and judges them the way main does
// (realpath → stat → decideFileOpen). Nothing is ever opened or executed.
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

async function main() {
  const root = join(dirname(process.argv[1]), '..');
  const out = join(mkdtempSync(join(tmpdir(), 'link-open-policy-')), 'policy.mjs');
  await build({
    entryPoints: [join(root, 'src/main/link-open-policy.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
  });
  const m = await import(pathToFileURL(out).href);
  let failed = 0;
  const check = (name, ok) => { if (!ok) { failed++; console.log('FAIL', name); } else console.log('ok  ', name); };

  const dir = process.argv[2] || mkdtempSync(join(tmpdir(), 'link-fixtures-'));
  if (existsSync(join(dir, 'fx'))) rmSync(join(dir, 'fx'), { recursive: true });
  const fx = join(dir, 'fx');
  mkdirSync(fx, { recursive: true });
  const file = (name, mode = 0o644, body = 'x\n') => {
    const p = join(fx, name);
    writeFileSync(p, body);
    chmodSync(p, mode);
    return p;
  };

  // Same steps as planFileLink in ipc-handlers.ts, minus Electron.
  const decide = (path, editorAvailable) => {
    const parsed = m.parseLinkPath(path);
    if (!parsed) return 'refused';
    const real = realpathSync(parsed.path);
    const st = statSync(real);
    return m.decideFileOpen({ ext: m.extensionOf(real), isFile: st.isFile(), mode: st.mode, editorAvailable }).action;
  };

  // A fake .app bundle (a folder; never launched).
  mkdirSync(join(fx, 'Evil.app/Contents/MacOS'), { recursive: true });
  file('Evil.app/Contents/MacOS/Evil', 0o755, '#!/bin/sh\nexit 0\n');
  symlinkSync(join(fx, 'Evil.app'), join(fx, 'notes.txt'));          // symlink named .txt → .app
  const cmd = file('run.command', 0o644, '#!/bin/sh\nexit 0\n');
  symlinkSync(cmd, join(fx, 'readme.md'));                              // symlink named .md → .command
  mkdirSync(join(fx, 'a folder'));

  const risky = ['app', 'command', 'tool', 'terminal', 'pkg', 'mpkg', 'dmg', 'jar', 'workflow', 'mobileconfig',
    'scpt', 'applescript', 'action', 'webloc', 'inetloc', 'fileloc'];
  for (const ext of risky) {
    if (ext === 'app') continue; // the folder above
    file(`f.${ext}`);
  }
  for (const editor of [false, true]) {
    const tag = editor ? ' (editor)' : '';
    for (const ext of risky) {
      const p = ext === 'app' ? join(fx, 'Evil.app') : join(fx, `f.${ext}`);
      check(`.${ext} revealed${tag}`, decide(p, editor) === 'reveal');
    }
    check(`symlink notes.txt → .app revealed${tag}`, decide(join(fx, 'notes.txt'), editor) === 'reveal');
    check(`symlink readme.md → .command revealed${tag}`, decide(join(fx, 'readme.md'), editor) === 'reveal');
    check(`directory revealed${tag}`, decide(join(fx, 'a folder'), editor) === 'reveal');
    check(`extension-less executable revealed${tag}`, decide(file('tool-noext', 0o755, '#!/bin/sh\nexit 0\n'), editor) === 'reveal');
    check(`extension-less plain file revealed${tag}`, decide(file('LICENSE'), editor) === 'reveal');
    check(`unknown .xyz revealed${tag}`, decide(file('f.xyz'), editor) === 'reveal');
  }

  // View-only types open without an editor; with one, text goes to the editor.
  for (const ext of ['txt', 'md', 'png', 'pdf', 'html', 'json', 'csv', 'log']) {
    check(`.${ext} opens (no editor)`, decide(file(`v.${ext}`), false) === 'open');
  }
  check('.md → editor when one exists', decide(join(fx, 'v.md'), true) === 'editor');
  check('executable .md revealed (no editor)', decide(file('x.md', 0o755), false) === 'reveal');
  check('executable .txt revealed (no editor, group x only)', decide(file('g.txt', 0o654), false) === 'reveal');

  // Code files whose default app may run them: editor, or reveal without one.
  for (const ext of ['py', 'sh', 'zsh', 'rb', 'pl', 'js', 'ts']) {
    const p = file(`c.${ext}`);
    check(`.${ext} → editor`, decide(p, true) === 'editor');
    check(`.${ext} revealed (no editor)`, decide(p, false) === 'reveal');
  }
  check('executable .sh → editor (shown as text)', decide(file('build.sh', 0o755), true) === 'editor');
  check('executable .sh revealed (no editor)', decide(join(fx, 'build.sh'), false) === 'reveal');

  // Names main used to refuse.
  check('name with spaces opens', decide(file('My Doc.md'), false) === 'open');
  check('name with ( ) , \' + opens', decide(file("notes (v2), Bob's+1.txt"), false) === 'open');
  check('U+202F screenshot name opens', decide(file('Screenshot 2026-11-07 at 10.00.00\u202FAM.png'), false) === 'open');
  check('accented name opens', decide(file('résumé.pdf'), false) === 'open');

  // parseLinkPath validation.
  const p = m.parseLinkPath;
  check('suffix split', (r => r && r.path === '/a/b.ts' && r.suffix === ':12:3')(p('/a/b.ts:12:3')));
  check('relative refused', p('a/b.ts') === null);
  check('traversal refused', p('/a/../etc/passwd') === null);
  check('NUL refused', p('/a/b\u0000.txt') === null);
  check('newline refused', p('/a/b\n.txt') === null);
  check('DEL refused', p('/a/b\u007f.txt') === null);
  check('C1 control refused', p('/a/b\u009b.txt') === null);
  check('RTL override refused', p('/a/gpj.\u202Eexe.txt') === null);
  check('root refused', p('/') === null);
  check('too long refused', p('/' + 'a'.repeat(1001)) === null);
  check('U+202F allowed', p('/a/Shot\u202FAM.png') !== null);
  check('quotes and $ allowed (no shell)', p("/a/it's $HOME;`x`.txt") !== null);

  check('extensionOf dotfile', m.extensionOf('/a/.env') === '');
  check('extensionOf upper', m.extensionOf('/a/B.PNG') === 'png');
  check('extensionOf dir dot', m.extensionOf('/a.b/c') === '');

  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
