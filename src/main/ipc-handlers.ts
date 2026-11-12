import { ipcMain, BrowserWindow, dialog, Notification, shell, app, systemPreferences } from 'electron';
import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import { IPC, uiTextScaleOf } from '../shared/constants';
import { PtyManager } from './pty-manager';
import { isSafeAbsolutePath, resolveProject, setRegisteredProjects } from './projects';
import { registeredProjects, setProjectListSetting } from './registered-projects';
import { getHookStatus, installHook, refreshInstalledScript, removeHook, type ClaudeHookPaths } from './claude-hook';
import { getResourcesPath } from './resources-path';
import * as store from './store';
import { registerClipboardImageHandlers } from './clipboard-image';
import { getSystemFonts } from './system-fonts';
import { RateLimiter } from './rate-limiter';
import { titleBarActionFor } from './title-bar-action';
import { closePreconfirmations } from './close-preconfirm';
import { closeSenderWindow } from './close-window';
import { closeConfirmations } from './close-confirm';
import { PauseAllCoordinator, type PauseAllWindow } from './pause-all';
import { UnsentInputTracker } from './unsent-input';
import { readStashKeyVerdict } from './stash-key';
import { broadcastUiTextScale, isOnlyWindow } from './window-manager';
import { decideFileOpen, extensionOf, parseLinkPath, type OpenDecision } from './link-open-policy';
import { annotateBookmarks, validateBookmarks } from './bookmarks'; // bookmarks sidebar
import { AdditionLog, addProject, loadBoard, saveLayout, type BoardSources } from './project-board';
import type { BoardPayload, PtyCreateOptions, RenderSnapshot, SessionState } from '../shared/types';

/** Open an http(s) URL in the default browser. Anything else — other schemes
 *  can launch local apps — is refused and returns false. */
function openWebUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // not a URL
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // The normalised form (punycode host, `\` read as `/`) is what the hover
  // shows and what we open; the raw string could be read differently.
  shell.openExternal(parsed.href).catch(() => {});
  return true;
}

// --- File links: validate, resolve, decide (decision rules: link-open-policy.ts) ---

const VSCODE_APP_CODE = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';

/** The code editor CLI, looked up per click (cheap): VS Code's app-bundle CLI
 *  (works without "Install 'code' command in PATH"), else a `code` shim on
 *  $PATH (Cursor, Codium…). Null when neither exists. */
function findEditor(): string | null {
  if (existsSync(VSCODE_APP_CODE)) return VSCODE_APP_CODE;
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir.startsWith('/')) continue; // never a cwd-relative PATH entry
    const candidate = join(dir, 'code');
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return null;
}

/** A path as it may appear in the log: `~/…` inside home, else only its name. */
function pathForLog(path: string): string {
  const home = homedir();
  if (path === home || path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return basename(path);
}

type FileLinkPlan =
  | { kind: 'refused'; reason: string }
  | { kind: 'missing'; path: string }
  | { kind: 'file'; real: string; suffix: string; ext: string; decision: OpenDecision; editor: string | null };

/** Validate a file-link path from the renderer and decide what to do with it.
 *  `~/…` is expanded here (only main knows home). Symlinks are resolved first,
 *  so a link named `notes.txt` that points at an `.app` is judged as the app. */
function planFileLink(rawPath: unknown): FileLinkPlan {
  if (typeof rawPath !== 'string') return { kind: 'refused', reason: 'not a string' };
  const expanded = rawPath.startsWith('~/') ? homedir() + rawPath.slice(1) : rawPath;
  const parsed = parseLinkPath(expanded);
  if (!parsed) return { kind: 'refused', reason: 'path failed validation' };
  let real: string;
  let facts: { isFile: boolean; mode: number };
  try {
    real = realpathSync(parsed.path);
    const st = statSync(real);
    facts = { isFile: st.isFile(), mode: st.mode };
  } catch {
    return { kind: 'missing', path: parsed.path };
  }
  const editor = findEditor();
  const ext = extensionOf(real);
  const decision = decideFileOpen({ ext, ...facts, editorAvailable: editor !== null });
  return { kind: 'file', real, suffix: parsed.suffix, ext, decision, editor };
}

function reveal(real: string, ext: string, reason: string): void {
  console.info('[LINK] revealed instead of opened', { ext: ext || '(none)', reason, path: pathForLog(real) });
  shell.showItemInFolder(real);
}

function openWithDefaultApp(real: string): void {
  shell.openPath(real).then((errorMsg) => {
    if (errorMsg) console.warn('[LINK] openPath failed', { error: errorMsg, path: pathForLog(real) });
  }, () => {});
}

function carryOut(plan: Extract<FileLinkPlan, { kind: 'file' }>): void {
  const { real, suffix, ext, decision, editor } = plan;
  if (decision.action === 'reveal') {
    reveal(real, ext, decision.reason);
    return;
  }
  if (decision.action === 'open') {
    openWithDefaultApp(real);
    return;
  }
  // decision.action is 'editor' here; with no editor found, reveal (never open).
  if (editor === null) {
    reveal(real, ext, 'no editor found');
    return;
  }
  // execFile passes the path as one argv entry; no shell sees it. The path
  // starts with "/", so it can't be read as an option.
  execFile(editor, ['--goto', real + suffix], { timeout: 5000 }, (err) => {
    if (!err) return;
    // The editor failed: decide again as if there were none, on the file as it
    // is now (code files are then revealed, never handed to their default app).
    // A file that can't be read any more is revealed.
    let fallback: OpenDecision = { action: 'reveal', reason: 'editor failed and file unreadable' };
    try {
      const st = statSync(real);
      fallback = decideFileOpen({ ext, isFile: st.isFile(), mode: st.mode, editorAvailable: false });
    } catch { /* keep the reveal */ }
    console.warn('[LINK] editor failed', { error: err.message, fallback: fallback.action });
    if (fallback.action === 'open') openWithDefaultApp(real);
    else reveal(real, ext, fallback.action === 'reveal' ? fallback.reason : 'editor failed');
  });
}

// --- Security: Helper to validate PTY ownership ---
function requireOwnership(
  ptyManager: PtyManager,
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  id: number,
): void {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !ptyManager.validateOwnership(id, window)) {
    throw new Error('PTY access denied');
  }
}

export function registerIpcHandlers(ptyManager: PtyManager): void {
  const ptyWriteLimiter = new RateLimiter(5000);
  const settingsSetLimiter = new RateLimiter(10);
  // Notes saves are debounced client-side; a low cap still absorbs bursts.
  const notesSetLimiter = new RateLimiter(20);

  ipcMain.handle(IPC.PTY_CREATE, (event, opts?: PtyCreateOptions) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('No window found');
    return ptyManager.create(window, opts);
  });

  // --- board-in-place: replace the sender's own PTY with a fresh one ---
  // The project board opens a project in the board's tab by swapping its
  // shell. Only the sender's own PTY, at most 5 a second; the options go
  // through the same validation as PTY_CREATE (cwd, shell, projectDir).
  const ptyRespawnLimiter = new RateLimiter(5);
  ipcMain.handle(IPC.PTY_RESPAWN, (event, id: number, opts?: PtyCreateOptions) => {
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      console.warn('[SECURITY] PTY_RESPAWN type validation failed', { id });
      throw new Error('Invalid PTY id');
    }
    if (opts !== undefined && (typeof opts !== 'object' || opts === null)) {
      console.warn('[SECURITY] PTY_RESPAWN type validation failed', { optsType: typeof opts });
      throw new Error('Invalid options');
    }
    if (!ptyRespawnLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.PTY_RESPAWN });
      throw new Error('Rate limited');
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('No window found');
    return ptyManager.respawn(window, id, opts);
  });
  // --- end board-in-place ---

  // Unsent input per PTY (unsent-input.ts): every write passes here, so this
  // is the one place that sees all of it. Pause all and the checkpoint clock
  // read it to stash a draft before typing their word.
  const unsentInput = new UnsentInputTracker();
  ipcMain.handle(IPC.PTY_INPUT_STATE, (event, ids: unknown) => {
    if (!Array.isArray(ids) || ids.length > 1000) {
      console.warn('[SECURITY] PTY_INPUT_STATE type validation failed', { isArray: Array.isArray(ids) });
      return [];
    }
    // No rate limit: one call per press (Gotchas: a refused answer loses data).
    return ids.map((id: unknown) => {
      if (typeof id !== 'number' || !Number.isFinite(id)) return null;
      try {
        requireOwnership(ptyManager, event, id);
      } catch {
        return null;
      }
      return unsentInput.state(id);
    });
  });

  ipcMain.on(IPC.PTY_WRITE, (event, id: number, data: string, origin?: unknown) => {
    try {
      if (typeof id !== 'number' || !Number.isFinite(id)) {
        console.warn('[SECURITY] PTY_WRITE type validation failed', { id });
        return;
      }
      if (typeof data !== 'string') {
        console.warn('[SECURITY] PTY_WRITE type validation failed', { dataType: typeof data });
        return;
      }
      // Cap data size to prevent memory abuse (1MB is generous for any paste/input)
      if (data.length > 1024 * 1024) {
        console.warn('[SECURITY] PTY_WRITE data size limit exceeded', { size: data.length });
        return;
      }
      // Ownership check BEFORE rate limit to prevent rate limit consumption by unauthorized callers
      requireOwnership(ptyManager, event, id);
      if (!ptyWriteLimiter.allow()) {
        console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.PTY_WRITE });
        return;
      }
      ptyManager.write(id, data);
      // Patton's own startup command is not the user's input (note() skips it).
      unsentInput.note(id, data, origin === 'startup' || origin === 'patton' || origin === 'at-prompt' ? origin : undefined);
    } catch {
      console.warn('[SECURITY] PTY ownership check failed', { channel: IPC.PTY_WRITE, id });
    }
  });

  ipcMain.on(IPC.PTY_RESIZE, (event, id: number, cols: number, rows: number) => {
    try {
      if (typeof id !== 'number' || !Number.isFinite(id)) {
        console.warn('[SECURITY] PTY_RESIZE type validation failed', { id });
        return;
      }
      if (typeof cols !== 'number' || !Number.isFinite(cols)) {
        console.warn('[SECURITY] PTY_RESIZE type validation failed', { cols });
        return;
      }
      if (typeof rows !== 'number' || !Number.isFinite(rows)) {
        console.warn('[SECURITY] PTY_RESIZE type validation failed', { rows });
        return;
      }
      requireOwnership(ptyManager, event, id);
      ptyManager.resize(id, cols, rows);
    } catch {
      console.warn('[SECURITY] PTY ownership check failed', { channel: IPC.PTY_RESIZE, id });
    }
  });

  ipcMain.on(IPC.PTY_DESTROY, (event, id: number) => {
    try {
      if (typeof id !== 'number' || !Number.isFinite(id)) {
        console.warn('[SECURITY] PTY_DESTROY type validation failed', { id });
        return;
      }
      requireOwnership(ptyManager, event, id);
      ptyManager.destroy(id);
      unsentInput.forget(id);
    } catch {
      console.warn('[SECURITY] PTY ownership check failed', { channel: IPC.PTY_DESTROY, id });
    }
  });

  ipcMain.handle(IPC.PTY_GET_PROCESS, (event, id: number) => {
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      console.warn('[SECURITY] PTY_GET_PROCESS type validation failed', { id });
      return '';
    }
    try {
      requireOwnership(ptyManager, event, id);
    } catch {
      console.warn('[SECURITY] PTY ownership check failed', { channel: IPC.PTY_GET_PROCESS, id });
      return '';
    }
    return ptyManager.getProcessName(id);
  });

  // The shell a PTY really runs: the renderer asks for what it wants, but
  // main may fall back to $SHELL, and the Claude button types csh-family
  // shells a different line.
  ipcMain.handle(IPC.PTY_GET_SHELL, (event, id: number) => {
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      console.warn('[SECURITY] PTY_GET_SHELL type validation failed', { id });
      return '';
    }
    try {
      requireOwnership(ptyManager, event, id);
    } catch {
      console.warn('[SECURITY] PTY ownership check failed', { channel: IPC.PTY_GET_SHELL, id });
      return '';
    }
    return ptyManager.getShell(id);
  });

  ipcMain.handle(IPC.HISTORY_GET, () => {
    return store.getHistory();
  });

  const historyAddLimiter = new RateLimiter(20);
  ipcMain.handle(IPC.HISTORY_ADD, (_event, command: string) => {
    if (typeof command !== 'string' || command.length > 10000) {
      console.warn('[SECURITY] HISTORY_ADD type validation failed', { type: typeof command });
      return;
    }
    if (!historyAddLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.HISTORY_ADD });
      return;
    }
    // Strip C0/C1 control chars and ESC — when a stored history entry is later
    // written back to the PTY, an embedded escape sequence would be interpreted
    // as a terminal command. This matches the safePaste policy elsewhere.
    // Allow tab and newline explicitly since multi-line commands are legitimate.
    // eslint-disable-next-line no-control-regex -- intentional: stripping control chars
    const sanitized = command.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
    if (!sanitized) return;
    store.addHistory(sanitized);
  });

  ipcMain.handle(IPC.HISTORY_CLEAR, () => {
    store.clearHistory();
  });

  ipcMain.handle(IPC.SETTINGS_GET, () => {
    return store.getSettings();
  });

  ipcMain.handle(IPC.SETTINGS_SET, async (event, settings: Record<string, unknown>) => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      console.warn('[SECURITY] SETTINGS_SET type validation failed', { type: typeof settings });
      return;
    }
    if (!settingsSetLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.SETTINGS_SET });
      return;
    }

    // Confirm startupCommand changes: a malicious process with same-user
    // access could otherwise silently persist a command that runs on every
    // new terminal (reverse shell, credential harvester, etc.). A modal
    // dialog gives the user a chance to notice.
    if ('startupCommand' in settings && typeof settings.startupCommand === 'string') {
      const current = store.getSettings().startupCommand || '';
      const proposed = settings.startupCommand;
      if (proposed !== current && proposed.trim().length > 0) {
        const win = BrowserWindow.fromWebContents(event.sender);
        const { response } = await dialog.showMessageBox(win ?? undefined as unknown as BrowserWindow, {
          type: 'warning',
          buttons: ['Cancel', 'Apply'],
          defaultId: 0,
          cancelId: 0,
          title: 'Confirm startup command',
          message: 'Apply new startup command?',
          detail: `This command will run in every new terminal:\n\n  ${proposed}\n\nOnly apply commands you recognize — a stray startup command can be a persistent code-execution vector.`,
        });
        if (response !== 1) {
          // User cancelled — drop just the startupCommand but keep other changes
          const { startupCommand: _dropped, ...rest } = settings;
          void _dropped;
          if (Object.keys(rest).length > 0) {
            store.setSettings(rest);
            afterSettingsSaved(rest);
          }
          return;
        }
      }
    }

    store.setSettings(settings);
    afterSettingsSaved(settings);
  });

  /** What a saved settings change must reach beyond the store. */
  function afterSettingsSaved(saved: Record<string, unknown>): void {
    // Propagate shell integration toggle to pty manager (affects new PTYs only)
    if ('shellIntegration' in saved) {
      ptyManager.shellIntegrationEnabled = !!saved.shellIntegration;
    }
    // Interface Text Size: every window re-scales its chrome now. Read back
    // from the store, so a refused value broadcasts the value actually kept.
    if ('uiTextScale' in saved) {
      broadcastUiTextScale(uiTextScaleOf(store.getSettings().uiTextScale));
    }
    // The project list's file, which resolveProject reads without touching the
    // settings store. Read back, so a refused value leaves the kept one.
    if ('projectListFile' in saved) {
      setProjectListSetting(store.getSettings().projectListFile);
    }
  }

  // --- Notes scratchpad ---
  ipcMain.handle(IPC.NOTES_GET, () => {
    return store.getNotes();
  });

  ipcMain.handle(IPC.NOTES_SET, (_event, content: unknown) => {
    if (typeof content !== 'string') {
      console.warn('[SECURITY] NOTES_SET type validation failed', { type: typeof content });
      return;
    }
    if (!notesSetLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.NOTES_SET });
      return;
    }
    store.setNotes(content);
  });

  // --- Project names ---
  // A tab is named after the project its folder belongs to (see projects.ts).
  // Renaming a project updates its tabs in every window.
  // A lookup is a handful of existsSync and realpath calls, so the cap is generous: restoring
  // a full session (100 tabs, the session cap) looks up every tab at once, and
  // now every pane too (up to 5 per tab).
  // Failures throw rather than return null, so the renderer can tell "couldn't
  // check" (keep the current name) from "not in a project".
  // A registered sub-project (a row of the project list inside a repo) is its
  // own project, not the repo's: resolveProject reads the list through this.
  // The list-file setting is held in registered-projects.ts (set here, and by
  // afterSettingsSaved when it changes), so a lookup is a stat of the list file
  // and string comparison, not a read and decrypt of the settings store.
  setProjectListSetting(store.getSettings().projectListFile);
  setRegisteredProjects(() => registeredProjects());
  const projectResolveLimiter = new RateLimiter(100);
  ipcMain.handle(IPC.PROJECT_RESOLVE, (_event, cwd: unknown) => {
    if (!isSafeAbsolutePath(cwd)) {
      console.warn('[SECURITY] PROJECT_RESOLVE path validation failed', { type: typeof cwd });
      throw new Error('Invalid path');
    }
    if (!projectResolveLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.PROJECT_RESOLVE });
      throw new Error('Rate limit exceeded');
    }
    return resolveProject(cwd);
  });

  ipcMain.handle(IPC.PROJECT_NAMES_GET, () => {
    return store.getProjectNames();
  });

  const projectNameSetLimiter = new RateLimiter(5);
  ipcMain.handle(IPC.PROJECT_NAME_SET, (_event, root: unknown, name: unknown) => {
    // Bound the raw name before any processing; the rename box itself caps at 60.
    if (!isSafeAbsolutePath(root) || typeof name !== 'string' || name.length > 1000) {
      console.warn('[SECURITY] PROJECT_NAME_SET validation failed', { rootType: typeof root, nameType: typeof name });
      return;
    }
    if (!projectNameSetLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.PROJECT_NAME_SET });
      return;
    }
    // Names are only ever stored against a real project root, never an arbitrary path.
    const project = resolveProject(root);
    if (!project || project.root !== root) {
      console.warn('[SECURITY] PROJECT_NAME_SET rejected — not a project root', { root });
      return;
    }
    const names = store.setProjectName(project, name);
    console.info('[PROJECTS] Project renamed', { root, name: names[root] ?? `${project.defaultName} (automatic)` });
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.PROJECT_NAMES_CHANGED, names);
    }
  });

  // --- Bookmarks ---
  // The sidebar sends its whole list on every change (add, rename, move,
  // remove). Main validates each entry, stores what passes, and broadcasts the
  // stored list so every window's sidebar shows the same bookmarks.
  ipcMain.handle(IPC.BOOKMARKS_GET, () => {
    return annotateBookmarks(store.getBookmarks());
  });

  const bookmarksSetLimiter = new RateLimiter(10);
  ipcMain.handle(IPC.BOOKMARKS_SET, async (_event, list: unknown) => {
    if (!bookmarksSetLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.BOOKMARKS_SET });
      return annotateBookmarks(store.getBookmarks());
    }
    const kept = validateBookmarks(list, store.getBookmarks());
    if (kept === null) return annotateBookmarks(store.getBookmarks()); // not a list: keep what is stored
    store.setBookmarks(kept);
    console.info('[BOOKMARKS] Saved', { count: kept.length });
    const shown = await annotateBookmarks(kept);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.BOOKMARKS_CHANGED, shown);
    }
    return shown;
  });
  // --- end bookmarks ---

  // --- Project board ---
  // The board in new tabs reads the project list (cc's Markdown table) and its
  // own arrangement; main validates every save. The renderer debounces layout
  // saves, and a refused save answers null so it can try again.
  const boardSources = (): BoardSources => ({
    listSetting: store.getSettings().projectListFile,
    userDataDir: app.getPath('userData'),
  });
  // Projects added while the app runs: every payload carries the count, and a
  // layout save from a board that hadn't seen an add keeps that tile's theme.
  const boardAdditions = new AdditionLog();
  // loadBoard takes the add count before it reads the list, so it never
  // claims an add the list it read may lack.
  const boardPayload = (): Promise<BoardPayload> => loadBoard(boardSources(), boardAdditions);
  const boardGetLimiter = new RateLimiter(10);
  ipcMain.handle(IPC.BOARD_GET, () => {
    if (!boardGetLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.BOARD_GET });
      throw new Error('Rate limit exceeded');
    }
    return boardPayload();
  });

  const boardLayoutLimiter = new RateLimiter(10);
  ipcMain.handle(IPC.BOARD_SET_LAYOUT, (event, layout: unknown, generation: unknown) => {
    if (!boardLayoutLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.BOARD_SET_LAYOUT });
      return null;
    }
    let stored;
    try {
      stored = saveLayout(app.getPath('userData'), layout, boardAdditions.addedSince(generation));
    } catch (err) {
      console.warn('[BOARD] Layout save failed', { err: String(err) });
      return null;
    }
    if (!stored) return null;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.BOARD_CHANGED, stored);
    }
    return stored;
  });

  const boardPickLimiter = new RateLimiter(2);
  ipcMain.handle(IPC.BOARD_PICK_FOLDER, async (event) => {
    if (!boardPickLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.BOARD_PICK_FOLDER });
      return null;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Add a project',
      buttonLabel: 'Choose',
      defaultPath: homedir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  const boardAddLimiter = new RateLimiter(2);
  ipcMain.handle(IPC.BOARD_ADD_PROJECT, async (_event, request: unknown): Promise<BoardPayload> => {
    if (!boardAddLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.BOARD_ADD_PROJECT });
      return { ...(await boardPayload()), error: 'too many requests; try again' };
    }
    const { added, ...payload } = await addProject(boardSources(), request, boardAdditions);
    if (!added) return payload;
    // Every board in every window gets the new list (and the new tile's theme).
    let windows = 0;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.BOARD_LIST_CHANGED, payload);
        windows++;
      }
    }
    console.info('[BOARD] New list sent to every window', { windows, generation: payload.generation });
    return payload;
  });
  // --- end project board ---

  // --- Session restore ---
  ipcMain.handle(IPC.SESSION_GET, () => {
    return store.getSession();
  });

  ipcMain.handle(IPC.SESSION_SET, (_event, session: SessionState | null) => {
    // Type guard: allow null or valid object with tabs array
    if (session !== null) {
      if (!session || typeof session !== 'object' || !Array.isArray(session.tabs)) {
        console.warn('[SECURITY] SESSION_SET type validation failed', { type: typeof session });
        return;
      }
    }
    store.setSession(session);
  });

  // --- Open a file link (bare path, markdown link or OSC 8 file://) ---
  // Every file link the renderer finds comes here. A link's target is
  // untrusted (anything printed to the terminal), so what a double-click may
  // do is decided here, on the resolved file: see link-open-policy.ts.
  //   editor → the code editor CLI (argv, no shell) at :line:col
  //   open   → shell.openPath, only for view-only types (text, images, PDF, HTML)
  //   reveal → shell.showItemInFolder: bundles, executables, installers,
  //            .webloc and friends, unknown types, code files with no editor
  ipcMain.handle(IPC.APP_OPEN_IN_EDITOR, (_event, rawPath: unknown, webFallback?: unknown) => {
    const plan = planFileLink(rawPath);
    if (plan.kind === 'refused') {
      console.warn('[LINK] file link refused', { reason: plan.reason });
      return;
    }
    if (plan.kind === 'missing') {
      // A web address printed without its scheme ("civitai.com") arrives as a
      // cwd-relative path that doesn't exist. The renderer offers the address
      // it looks like; use it only when there really is no such file.
      if (typeof webFallback === 'string' && openWebUrl(webFallback)) {
        console.info('[LINK] No such file, opened as a web address', { url: webFallback });
      } else {
        console.info('[LINK] No such file', { path: pathForLog(plan.path) });
      }
      return;
    }
    carryOut(plan);
  });

  // What a double-click on this file link would do, for the hover tooltip.
  const linkActionLimiter = new RateLimiter(30);
  ipcMain.handle(IPC.APP_LINK_ACTION, (_event, rawPath: unknown) => {
    if (!linkActionLimiter.allow()) return 'unknown';
    const plan = planFileLink(rawPath);
    return plan.kind === 'file' ? plan.decision.action : plan.kind;
  });

  // --- Save terminal output to file ---
  ipcMain.handle(IPC.APP_SAVE_TERMINAL, async (event, content: string, defaultName: string) => {
    if (typeof content !== 'string' || typeof defaultName !== 'string') return null;
    // Security: cap content size at 100MB to prevent memory exhaustion
    if (content.length > 100 * 1024 * 1024) return null;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return null;
    const result = await dialog.showSaveDialog(window, {
      defaultPath: defaultName,
      filters: [
        { name: 'Text Files', extensions: ['txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(result.filePath, content, 'utf-8');
      return result.filePath;
    } catch (err) {
      console.warn('Failed to save terminal output:', (err as Error).message);
      return null;
    }
  });

  // --- Save renderer diagnostic snapshot ---
  // Lands at ~/Library/Application Support/Patton/logs/render-snapshots/<timestamp>.json
  // when the user invokes Reset Renderer or Capture Renderer State. Auto-snapshot on
  // resetRenderer() captures state at the moment of corruption (before the flush).
  // Manual capture lets the user grab a clean baseline or a known-bad state on demand.
  // Cleanup keeps the last 50 files; the directory is bounded to ~2-3 MB worst case.
  const SNAPSHOT_KEEP = 50;
  const snapshotLimiter = new RateLimiter(5);
  ipcMain.handle(IPC.DIAGNOSTICS_SAVE_SNAPSHOT, async (_event, data: RenderSnapshot) => {
    if (!data || typeof data !== 'object') return null;
    if (!snapshotLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.DIAGNOSTICS_SAVE_SNAPSHOT });
      return null;
    }
    // Bound the payload — scrollbackTail is the only large field
    if (typeof data.scrollbackTail === 'string' && data.scrollbackTail.length > 200_000) {
      data.scrollbackTail = data.scrollbackTail.slice(-200_000);
    }
    try {
      const dir = join(app.getPath('userData'), 'logs', 'render-snapshots');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const reasonSlug = (typeof data.reason === 'string' ? data.reason : 'snapshot').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
      const filePath = join(dir, `${stamp}-${reasonSlug || 'snapshot'}.json`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
      // Best-effort cleanup: keep newest SNAPSHOT_KEEP, drop the rest
      try {
        const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
        const stale = files.slice(0, Math.max(0, files.length - SNAPSHOT_KEEP));
        for (const f of stale) {
          try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
        }
      } catch { /* cleanup is best-effort */ }
      console.info('[RENDER] snapshot saved', { filePath, reason: data.reason });
      return filePath;
    } catch (err) {
      console.warn('Failed to save render snapshot:', (err as Error).message);
      return null;
    }
  });

  // --- Get PTY working directory ---
  const getCwdLimiter = new RateLimiter(10); // lsof is expensive; cap at 10/s
  ipcMain.handle(IPC.PTY_GET_CWD, (event, id: number) => {
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      return '';
    }
    if (!getCwdLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.PTY_GET_CWD });
      return '';
    }
    try {
      requireOwnership(ptyManager, event, id);
    } catch {
      return '';
    }
    return ptyManager.getCwd(id);
  });

  // --- Set window opacity ---
  ipcMain.on(IPC.APP_SET_OPACITY, (event, opacity: number) => {
    if (typeof opacity !== 'number' || !Number.isFinite(opacity)) return;
    const clamped = Math.max(0.3, Math.min(1.0, opacity));
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) {
      window.setOpacity(clamped);
    }
  });

  // --- Native notification ---
  // Store references to prevent GC (known Electron bug), cap at 50 to bound memory
  const activeNotifications: Set<Notification> = new Set();
  const MAX_ACTIVE_NOTIFICATIONS = 50;
  // macOS refuses every notification from a self-signed build; after the first
  // refusal stop asking for the rest of this run (the dot and sound are
  // separate renderer-side signals and are unaffected).
  let notificationsRefused = false;
  ipcMain.on(IPC.APP_NOTIFY, (event, title: string, body: string, tabId: string) => {
    if (typeof title !== 'string' || typeof body !== 'string') return;
    if (notificationsRefused) return;
    if (!Notification.isSupported()) return;
    // Length caps: prevent a runaway tab title or command output from
    // creating multi-KB OS notifications. macOS truncates but still renders
    // the full string to the notification DB.
    const safeTitle = title.slice(0, 200);
    const safeBody = body.slice(0, 500);
    // tabId must be a bounded opaque string — it round-trips back via
    // APP_SWITCH_TAB_BY_ID and should not contain control chars or be huge.
    const safeTabId = typeof tabId === 'string' && tabId.length > 0 && tabId.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(tabId)
      ? tabId
      : '';

    // Security: capture window reference NOW, not in the click handler
    // (event.sender/webContents may be destroyed by the time notification is clicked)
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    // Evict oldest if at capacity
    if (activeNotifications.size >= MAX_ACTIVE_NOTIFICATIONS) {
      const oldest = activeNotifications.values().next().value;
      if (oldest) activeNotifications.delete(oldest);
    }
    const notif = new Notification({ title: safeTitle, body: safeBody, silent: true });
    activeNotifications.add(notif);

    notif.on('click', () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        if (safeTabId && !win.webContents.isDestroyed()) {
          win.webContents.send(IPC.APP_SWITCH_TAB_BY_ID, safeTabId);
        }
      }
      activeNotifications.delete(notif);
    });

    notif.on('close', () => {
      activeNotifications.delete(notif);
    });

    // Since Electron 42, macOS notifications go through UNNotification, which
    // needs a code-signed app — Patton's signature is self-signed. Log any
    // refusal so a missing notification is diagnosable from main.log.
    notif.on('failed', (_e, error) => {
      // Latch only on macOS's refusal; any other failure may be momentary.
      if (/not allowed/i.test(String(error))) {
        if (!notificationsRefused) {
          notificationsRefused = true;
          console.warn('[NOTIFY] Notification not allowed; skipping further attempts this run', { error });
        }
      } else {
        console.warn('[NOTIFY] Notification not shown', { error });
      }
      activeNotifications.delete(notif);
    });

    notif.show();
  });

  // --- Open external URL (for terminal link clicks) ---
  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, (_event, url: string) => {
    openWebUrl(url);
  });

  // --- System fonts: SF Mono from the Mac's own Terminal.app (fixed paths, read once) ---
  ipcMain.handle(IPC.FONTS_GET_SYSTEM, () => getSystemFonts());

  // --- Host name (tells local file:// hyperlinks from remote ones) ---
  ipcMain.handle(IPC.APP_GET_HOSTNAME, () => hostname());

  // --- Renderer log forwarding ---
  // Bridges renderer-process console calls into main.log via the file logger.
  // Without this, [RENDER] lines (atlas flushes, WebGL context loss, etc.)
  // only appear in DevTools — invisible in packaged-app launches and absent
  // from the health-script log scan. Bound at 50/s/window so a chatty pane
  // can't flood the log; payload sanitized to keep individual entries small.
  const rendererLogLimiter = new RateLimiter(50);
  ipcMain.on(IPC.LOG_RENDERER, (_event, level: unknown, args: unknown) => {
    if (level !== 'info' && level !== 'warn' && level !== 'error') return;
    if (!Array.isArray(args)) return;
    if (!rendererLogLimiter.allow()) return;
    const safe = args.slice(0, 10).map((a) => {
      if (typeof a === 'string' && a.length > 4000) return a.slice(0, 4000) + '\u2026';
      return a;
    });
    const fn = level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    fn('[RENDERER]', ...safe);
  });

  // --- Programmatic window drag (the tab strip's empty space and its blank spacer use this instead of -webkit-app-region) ---
  ipcMain.on(IPC.WINDOW_MOVE_BY, (event, dx: number, dy: number) => {
    if (typeof dx !== 'number' || typeof dy !== 'number') return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      const [x, y] = win.getPosition();
      win.setPosition(Math.round(x + dx), Math.round(y + dy));
    }
  });

  // --- Double-click on the strip's empty space: the Mac's title-bar action ---
  // Acts only on the SENDER's window. Reads the user's "Double-click a window's
  // title bar to" setting (AppleActionOnDoubleClick) so Minimize / None are honoured.
  const titleBarDoubleClickLimiter = new RateLimiter(10);
  ipcMain.on(IPC.WINDOW_TITLE_BAR_DOUBLE_CLICK, (event) => {
    if (!titleBarDoubleClickLimiter.allow()) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    // Full screen has no title bar to act on: zoom would drop the window out of it.
    if (win.isFullScreen()) {
      console.info('[WINDOW] title-bar double-click', { action: 'none (full screen)' });
      return;
    }
    let pref: string | undefined;
    let legacyMinimize: boolean | undefined;
    if (process.platform === 'darwin') {
      try {
        pref = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string');
      } catch {
        pref = undefined;
      }
      try {
        legacyMinimize = systemPreferences.getUserDefault('AppleMiniaturizeOnDoubleClick', 'boolean');
      } catch {
        legacyMinimize = undefined;
      }
    }
    const action = titleBarActionFor(pref, process.platform, legacyMinimize);
    console.info('[WINDOW] title-bar double-click', { pref, legacyMinimize, action });
    if (action === 'minimize') win.minimize();
    else if (action === 'zoom') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });

  // --- ⌘W on the last tab: the in-app "Quit Patton?" dialog (tab-manager.ts) ---
  // All three act only on the SENDER's own window: a renderer can learn about,
  // pre-confirm and request the close of its own window and no other. The pre-confirm is
  // one-shot and expires (close-preconfirm.ts), so it can't disarm the guard
  // for a later red-button click or ⌘Q. One call per user action, so a
  // refusal past the limit is rare; the renderer then falls back to the page's
  // window.close(), and the 'closed' safety net in window-manager.ts ends the
  // shells.
  const closeGuardLimiter = new RateLimiter(10);
  ipcMain.handle(IPC.WINDOW_CLOSE_INFO, (event) => {
    if (!closeGuardLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.WINDOW_CLOSE_INFO });
      return null;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return null;
    return { isLastWindow: isOnlyWindow(), liveShells: ptyManager.liveCountForWindow(win) };
  });
  ipcMain.handle(IPC.WINDOW_PRECONFIRM_CLOSE, (event) => {
    if (!closeGuardLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.WINDOW_PRECONFIRM_CLOSE });
      return false;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    closePreconfirmations.mark(win.id);
    console.info('[CLOSE] window close confirmed in the app', { windowId: win.id });
    return true;
  });
  // The renderer closes its window through here, never with the page's
  // window.close(), which skips the 'close' event (close-window.ts).
  ipcMain.handle(IPC.WINDOW_CLOSE, (event) => {
    if (!closeGuardLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.WINDOW_CLOSE });
      return false;
    }
    return closeSenderWindow(event.sender) !== null;
  });

  // --- in-app quit / close confirmations (v1.19; close-confirm.ts) ---
  // Main asks (WINDOW_CONFIRM_REQUEST); the renderer acks once the dialog is on
  // screen and later answers. No rate limiter on purpose: both calls must match
  // a pending request id that main made up (random), only from that request's
  // own window, so they cannot be used to flood or to skip a dialog, and a
  // refusal would leave the request hanging (gotcha: limiters refuse silently).
  ipcMain.handle(IPC.WINDOW_CONFIRM_ACK, (event, requestId: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || typeof requestId !== 'string') return false;
    return closeConfirmations.ack(win.id, requestId);
  });
  ipcMain.handle(IPC.WINDOW_CONFIRM_ANSWER, (event, requestId: unknown, ok: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || typeof requestId !== 'string') return false;
    return closeConfirmations.answer(win.id, requestId, ok === true);
  });
  // --- end in-app quit / close confirmations ---

  // --- Pause all (tab strip button; logic in pause-all.ts) ---
  // A press asks every window to type `pause` into its own Claude panes. The
  // renderer never names the word or the panes over IPC: each renderer picks
  // its panes, and the report is checked against the press's random request id and the windows
  // asked. One press at a time (a second is refused while one runs); the
  // limiter only stops a flood. The renderer shows "try again" on null.
  const pauseAll = new PauseAllCoordinator((): PauseAllWindow[] => BrowserWindow.getAllWindows().map((win) => ({
    id: win.id,
    alive: () => !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed(),
    send: (channel, payload) => win.webContents.send(channel, payload),
    onClosed: (cb) => {
      win.once('closed', cb);
      return () => { if (!win.isDestroyed()) win.removeListener('closed', cb); };
    },
  })));
  const pauseAllPressLimiter = new RateLimiter(5);
  ipcMain.handle(IPC.PAUSE_ALL_PRESS, async () => {
    if (!pauseAllPressLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.PAUSE_ALL_PRESS });
      return null;
    }
    return pauseAll.press();
  });
  // No limiter on these: a report must match a press, and the stash key is
  // read once per press.
  ipcMain.handle(IPC.PAUSE_ALL_REPORT, (event, requestId: unknown, report: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    return pauseAll.report(win.id, requestId, report);
  });
  ipcMain.handle(IPC.PAUSE_ALL_STASH_KEY, () => {
    const verdict = readStashKeyVerdict(join(homedir(), '.claude', 'keybindings.json'));
    if ('why' in verdict) console.info('[PAUSE-ALL] stash key not usable', { why: verdict.why });
    return verdict;
  });
  // --- end Pause all ---

  // --- Claude Code Stop hook (Settings → Claude Code; logic in claude-hook.ts) ---
  // Install and remove throw with a readable message (e.g. settings.json won't
  // parse); the rejection reaches the Settings panel, which shows it.
  const claudeHookPaths = (): ClaudeHookPaths => ({
    bundledScript: join(getResourcesPath(), 'claude-code-stop-hook.sh'),
    installedScript: join(app.getPath('userData'), 'hooks', 'claude-code-stop-hook.sh'),
    settingsFile: join(homedir(), '.claude', 'settings.json'),
  });
  // An installed hook gets this build's script at startup, not only when
  // Settings is next opened (a changed protocol must reach Claude Code at once).
  // Packaged builds only: a dev run shares the userData folder with the
  // installed app and would overwrite its hook with the working tree's.
  // The same goes for the refresh each Settings open makes through the status call.
  if (app.isPackaged) refreshInstalledScript(claudeHookPaths());
  ipcMain.handle(IPC.CLAUDE_HOOK_STATUS, () => getHookStatus(claudeHookPaths(), app.isPackaged));
  ipcMain.handle(IPC.CLAUDE_HOOK_INSTALL, () => {
    try {
      return installHook(claudeHookPaths());
    } catch (err) {
      console.warn('[HOOK] Install failed', { error: (err as Error).message });
      throw err;
    }
  });
  ipcMain.handle(IPC.CLAUDE_HOOK_REMOVE, () => {
    try {
      return removeHook(claudeHookPaths());
    } catch (err) {
      console.warn('[HOOK] Remove failed', { error: (err as Error).message });
      throw err;
    }
  });
  // --- end Claude Code Stop hook ---
  // --- image paste ---
  registerClipboardImageHandlers();
  // --- end image paste ---
}
