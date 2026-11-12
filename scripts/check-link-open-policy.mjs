// Check of the link-open policy and its carrying out: what a double-clicked file link may do.
// Run: node scripts/check-link-open-policy.mjs [fixture-dir]
// Builds fixture files (an .app folder, executables, every risky type…) in
// fixture-dir (default: a fresh temp folder) and drives the REAL
// src/main/ipc-handlers.ts (bundled with esbuild) through its
// 'app:open-in-editor' handler, with recorders in place of Electron's `shell`
// and `execFile`. Nothing is ever opened, revealed or executed.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// Recorders. `globalThis.__vscode` makes an editor "exist"; `__editorFails`
// makes it fail; `__onExec(file, args)` runs when the editor is called.
const electronStub = `
const calls = globalThis.__calls;
const generic = () => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : generic()),
  apply: () => generic(), construct: () => generic(),
});
module.exports = {
  ipcMain: { handle: (ch, fn) => calls.handlers.set(ch, fn), on: () => {}, once: () => {}, removeHandler: () => {} },
  shell: {
    openPath: async (p) => { calls.events.push('open'); return ''; },
    openExternal: async (u) => { calls.events.push('web'); },
    showItemInFolder: (p) => { calls.events.push('reveal'); },
  },
  app: { getPath: () => '/nonexistent', getVersion: () => '0', on: () => {} },
  BrowserWindow: generic(), dialog: generic(), Notification: generic(),
};`;
const cpStub = `
const calls = globalThis.__calls;
module.exports = {
  execFile: (file, args, opts, cb) => {
    calls.events.push('editor');
    if (globalThis.__onExec) globalThis.__onExec(file, args);
    const err = globalThis.__editorFails ? new Error('editor failed (simulated)') : null;
    if (typeof cb === 'function') setImmediate(() => cb(err));
  },
};`;
const fsStub = `
const fs = require('fs');
module.exports = Object.assign({}, fs, {
  existsSync: (p) => (typeof p === 'string' && p.includes('Visual Studio Code.app') ? !!globalThis.__vscode : fs.existsSync(p)),
  accessSync: (p, m) => {
    if (typeof p === 'string' && p.endsWith('/code')) throw new Error('ENOENT');
    return fs.accessSync(p, m);
  },
});`;
const mk = (names) => `module.exports = {${names.map((n) => ` ${n}: () => undefined`).join(',')} };`;
const stubs = [
  [/^electron$/, electronStub],
  [/^node:child_process$/, cpStub],
  [/^node:fs$/, fsStub],
  [/^\.\/projects$/, mk(['isSafeAbsolutePath', 'resolveProject', 'setRegisteredProjectPaths'])],
  [/^\.\/claude-hook$/, mk(['getHookStatus', 'installHook', 'removeHook'])],
  [/^\.\/resources-path$/, mk(['getResourcesPath'])],
  [/^\.\/store$/, mk([])],
  [/^\.\/clipboard-image$/, mk(['registerClipboardImageHandlers'])],
  [/^\.\/bookmarks$/, mk(['annotateBookmarks', 'validateBookmarks'])],
  [/^\.\/pty-manager$/, 'module.exports = { PtyManager: class {} };'],
];

async function main() {
  const root = join(dirname(process.argv[1]), '..');
  const work = mkdtempSync(join(tmpdir(), 'link-open-policy-'));
  const out = join(work, 'policy.mjs');
  await build({
    entryPoints: [join(root, 'src/main/link-open-policy.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
  });
  const m = await import(pathToFileURL(out).href);

  globalThis.__calls = { events: [], handlers: new Map() };
  const ipcOut = join(work, 'ipc.cjs');
  await build({
    entryPoints: [join(root, 'src/main/ipc-handlers.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: ipcOut, logLevel: 'error',
    plugins: [{
      name: 'recorders',
      setup(b) {
        for (const [filter] of stubs) b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
          for (const [filter, contents] of stubs) if (filter.test(args.path)) return { contents, loader: 'js', resolveDir: work };
          return null;
        });
      },
    }],
  });
  createRequire(import.meta.url)(ipcOut).registerIpcHandlers({});
  const openHandler = globalThis.__calls.handlers.get('app:open-in-editor');
  if (!openHandler) throw new Error('app:open-in-editor handler not registered');

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

  // What the real handler did with a link: the sinks it reached, in order,
  // e.g. 'open', 'editor', 'reveal', 'editor>reveal' (editor failed), 'none'.
  const tick = () => new Promise((r) => setImmediate(() => setImmediate(r)));
  const act = async (path, editorAvailable, editorFails = false, onExec = undefined) => {
    globalThis.__vscode = editorAvailable;
    globalThis.__editorFails = editorFails;
    globalThis.__onExec = onExec;
    globalThis.__calls.events.length = 0;
    await openHandler({}, path);
    await tick();
    return globalThis.__calls.events.join('>') || 'none';
  };
  const decide = async (path, editorAvailable) => {
    const r = await act(path, editorAvailable);
    return r === 'none' ? 'refused' : r;
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
      check(`.${ext} revealed${tag}`, await decide(p, editor) === 'reveal');
    }
    check(`symlink notes.txt → .app revealed${tag}`, await decide(join(fx, 'notes.txt'), editor) === 'reveal');
    check(`symlink readme.md → .command revealed${tag}`, await decide(join(fx, 'readme.md'), editor) === 'reveal');
    check(`directory revealed${tag}`, await decide(join(fx, 'a folder'), editor) === 'reveal');
    check(`extension-less executable revealed${tag}`, await decide(file('tool-noext', 0o755, '#!/bin/sh\nexit 0\n'), editor) === 'reveal');
    check(`extension-less plain file revealed${tag}`, await decide(file('LICENSE'), editor) === 'reveal');
    check(`unknown .xyz revealed${tag}`, await decide(file('f.xyz'), editor) === 'reveal');
  }

  // View-only types open without an editor; with one, text goes to the editor.
  for (const ext of ['txt', 'md', 'png', 'pdf', 'html', 'json', 'csv', 'log']) {
    check(`.${ext} opens (no editor)`, await decide(file(`v.${ext}`), false) === 'open');
  }
  check('.md → editor when one exists', await decide(join(fx, 'v.md'), true) === 'editor');
  check('executable .md revealed (no editor)', await decide(file('x.md', 0o755), false) === 'reveal');
  check('executable .txt revealed (no editor, group x only)', await decide(file('g.txt', 0o654), false) === 'reveal');

  // Code files whose default app may run them: editor, or reveal without one.
  for (const ext of ['py', 'sh', 'zsh', 'rb', 'pl', 'js', 'ts']) {
    const p = file(`c.${ext}`);
    check(`.${ext} → editor`, await decide(p, true) === 'editor');
    check(`.${ext} revealed (no editor)`, await decide(p, false) === 'reveal');
  }
  check('executable .sh → editor (shown as text)', await decide(file('build.sh', 0o755), true) === 'editor');
  check('executable .sh revealed (no editor)', await decide(join(fx, 'build.sh'), false) === 'reveal');

  // Names main used to refuse.
  check('name with spaces opens', await decide(file('My Doc.md'), false) === 'open');
  check('name with ( ) , \' + opens', await decide(file("notes (v2), Bob's+1.txt"), false) === 'open');
  check('U+202F screenshot name opens', await decide(file('Screenshot 2026-11-07 at 10.00.00\u202FAM.png'), false) === 'open');
  check('accented name opens', await decide(file('résumé.pdf'), false) === 'open');

  // Images, PDF and web pages go to their default viewer even when an editor exists.
  for (const ext of ['png', 'jpg', 'heic', 'pdf', 'html', 'htm', 'svg']) {
    check(`.${ext} opens, not the editor (editor present)`, await decide(file(`w.${ext}`), true) === 'open');
  }
  check('executable .png revealed (editor present)', await decide(file('run.png', 0o755), true) === 'reveal');
  for (const ext of ['txt', 'md', 'json', 'log', 'py']) {
    check(`.${ext} → editor (editor present)`, await decide(file(`t.${ext}`), true) === 'editor');
  }

  // The editor is called with one absolute argv entry; a failing editor falls back safely.
  let argv = null;
  await act(file('argv.md'), true, false, (_f, a) => { argv = a; });
  check('editor argv is --goto <abs path>', argv && argv.length === 2 && argv[0] === '--goto' && argv[1] === realpathSync(join(fx, 'argv.md')));
  check('editor failure: .md falls back to open', await act(file('ef.md'), true, true) === 'editor>open');
  check('editor failure: .py falls back to reveal', await act(file('ef.py'), true, true) === 'editor>reveal');
  check('editor failure: .json open->reveal if the file became executable',
    await act(file('ef2.json'), true, true, (f, a) => chmodSync(a[1], 0o755)) === 'editor>reveal');
  check('editor failure: reveal if the file became a directory',
    await act(file('ef3.md'), true, true, (f, a) => { unlinkSync(a[1]); mkdirSync(a[1]); }) === 'editor>reveal');
  check('editor failure: reveal if the file vanished',
    await act(file('ef4.md'), true, true, (f, a) => unlinkSync(a[1])) === 'editor>reveal');
  check('editor failure: .png never reaches the editor', await act(file('ef.png'), true, true) === 'open');

  // ".." with a :line suffix is refused (the suffix must not hide the segment).
  mkdirSync(join(fx, 'sub'), { recursive: true });
  check('/x/..:12 refused by parseLinkPath', m.parseLinkPath(join(fx, 'sub') + '/..:12') === null);
  check('/x/..:12:3 refused by parseLinkPath', m.parseLinkPath(join(fx, 'sub') + '/..:12:3') === null);
  check('/x/../y:12 refused by parseLinkPath', m.parseLinkPath(join(fx, 'sub') + '/../y.txt:12') === null);
  check('/x/a..b:12 allowed by parseLinkPath', m.parseLinkPath('/x/a..b:12') !== null);
  check('/x/..:12 does nothing in the handler (editor)', await decide(join(fx, 'sub') + '/..:12', true) === 'refused');
  check('/x/..:12 does nothing in the handler (no editor)', await decide(join(fx, 'sub') + '/..:12', false) === 'refused');

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
