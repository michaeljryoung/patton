import { ipcMain, BrowserWindow, dialog, Notification, shell, app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { IPC } from '../shared/constants';
import { PtyManager } from './pty-manager';
import * as store from './store';
import type { PtyCreateOptions, RenderSnapshot, SessionState } from '../shared/types';

// --- Security: Sliding-window rate limiter (ring buffer, O(1) operations) ---
class RateLimiter {
  private readonly ring: number[];
  private head = 0;
  private count = 0;
  private readonly maxCalls: number;
  private readonly windowMs: number;

  constructor(maxCallsPerSecond: number) {
    this.maxCalls = maxCallsPerSecond;
    this.windowMs = 1000;
    this.ring = new Array(maxCallsPerSecond);
  }

  allow(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    // Evict expired timestamps from the front of the ring
    while (this.count > 0 && this.ring[this.head] <= cutoff) {
      this.head = (this.head + 1) % this.maxCalls;
      this.count--;
    }
    if (this.count >= this.maxCalls) {
      return false;
    }
    const tail = (this.head + this.count) % this.maxCalls;
    this.ring[tail] = now;
    this.count++;
    return true;
  }
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

  ipcMain.handle(IPC.PTY_CREATE, (event, opts?: PtyCreateOptions) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('No window found');
    return ptyManager.create(window, opts);
  });

  ipcMain.on(IPC.PTY_WRITE, (event, id: number, data: string) => {
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
            if ('shellIntegration' in rest) {
              ptyManager.shellIntegrationEnabled = !!rest.shellIntegration;
            }
          }
          return;
        }
      }
    }

    store.setSettings(settings);
    // Propagate shell integration toggle to pty manager (affects new PTYs only)
    if ('shellIntegration' in settings) {
      ptyManager.shellIntegrationEnabled = !!settings.shellIntegration;
    }
  });

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

  // --- Open file in editor ---
  // Priority cascade:
  //   1. VS Code's app-bundle CLI — works even if the user never ran
  //      "Shell Command: Install 'code' command in PATH" inside VS Code.
  //   2. `code` on $PATH — catches Cursor/Codium/forks that expose a `code` shim.
  //   3. shell.openPath() — macOS default app for the file type. Loses line/col
  //      but at least opens something instead of silently failing.
  // Resolved once at handler-install time; cheap to re-check per-click if needed.
  const VSCODE_APP_CODE = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  const editorBin = existsSync(VSCODE_APP_CODE) ? VSCODE_APP_CODE : 'code';
  ipcMain.handle(IPC.APP_OPEN_IN_EDITOR, (_event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.length > 1000) return;
    // Security: validate strict path:line:col format (no shell metacharacters, no traversal)
    if (!/^[/a-zA-Z0-9._\-@]+(?::[0-9]+(?::[0-9]+)?)?$/.test(filePath)) return;
    // Security: reject directory traversal
    if (/(?:^|\/)\.\.(?:\/|$)/.test(filePath)) return;
    // Security: must start with / (absolute path required from renderer)
    if (!filePath.startsWith('/')) return;
    execFile(editorBin, ['--goto', filePath], { timeout: 5000 }, (err) => {
      if (!err) return;
      // Editor CLI missing or errored — fall back to the system default opener.
      // shell.openPath doesn't understand `:line:col`, so strip it.
      const pathOnly = filePath.replace(/:\d+(?::\d+)?$/, '');
      shell.openPath(pathOnly).then((errorMsg) => {
        if (errorMsg) console.warn('shell.openPath fallback failed:', errorMsg, { pathOnly });
      }, () => {});
    });
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
  ipcMain.on(IPC.APP_NOTIFY, (event, title: string, body: string, tabId: string) => {
    if (typeof title !== 'string' || typeof body !== 'string') return;
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

    notif.show();
  });

  // --- Open external URL (for terminal link clicks) ---
  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, (_event, url: string) => {
    if (typeof url !== 'string' || url.length > 2048) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url).catch(() => {});
      }
    } catch {
      // Invalid URL, ignore
    }
  });

  // --- Programmatic window drag (tab bar uses this instead of -webkit-app-region) ---
  ipcMain.on(IPC.WINDOW_MOVE_BY, (event, dx: number, dy: number) => {
    if (typeof dx !== 'number' || typeof dy !== 'number') return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      const [x, y] = win.getPosition();
      win.setPosition(Math.round(x + dx), Math.round(y + dy));
    }
  });
}
