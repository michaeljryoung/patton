import { ipcMain, BrowserWindow, dialog, Notification } from 'electron';
import { execFile } from 'node:child_process';
import { IPC } from '../shared/constants';
import { PtyManager } from './pty-manager';
import * as store from './store';
import type { PtyCreateOptions, SessionState } from '../shared/types';

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
      if (!ptyWriteLimiter.allow()) {
        console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.PTY_WRITE });
        return;
      }
      requireOwnership(ptyManager, event, id);
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

  ipcMain.handle(IPC.PTY_GET_DESCENDANTS, (event, id: number) => {
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      console.warn('[SECURITY] PTY_GET_DESCENDANTS type validation failed', { id });
      return [];
    }
    try {
      requireOwnership(ptyManager, event, id);
    } catch {
      console.warn('[SECURITY] PTY ownership check failed', { channel: IPC.PTY_GET_DESCENDANTS, id });
      return [];
    }
    return ptyManager.getDescendantNames(id);
  });

  ipcMain.handle(IPC.HISTORY_GET, () => {
    return store.getHistory();
  });

  ipcMain.handle(IPC.HISTORY_ADD, (_event, command: string) => {
    if (typeof command !== 'string' || command.length > 10000) {
      console.warn('[SECURITY] HISTORY_ADD type validation failed', { type: typeof command });
      return;
    }
    store.addHistory(command);
  });

  ipcMain.handle(IPC.HISTORY_CLEAR, () => {
    store.clearHistory();
  });

  ipcMain.handle(IPC.SETTINGS_GET, () => {
    return store.getSettings();
  });

  ipcMain.handle(IPC.SETTINGS_SET, (_event, settings: Record<string, unknown>) => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      console.warn('[SECURITY] SETTINGS_SET type validation failed', { type: typeof settings });
      return;
    }
    if (!settingsSetLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.SETTINGS_SET });
      return;
    }
    store.setSettings(settings);
  });

  // --- Session restore ---
  ipcMain.handle(IPC.SESSION_GET, () => {
    return store.getSession();
  });

  ipcMain.handle(IPC.SESSION_SET, (_event, session: SessionState | null) => {
    store.setSession(session);
  });

  // --- Open file in editor (VS Code) ---
  ipcMain.handle(IPC.APP_OPEN_IN_EDITOR, (_event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.length > 1000) return;
    // Security: validate strict path:line:col format (no shell metacharacters, no traversal)
    if (!/^[/a-zA-Z0-9._\-@]+(?::[0-9]+(?::[0-9]+)?)?$/.test(filePath)) return;
    // Security: reject directory traversal
    if (/(?:^|\/)\.\.(?:\/|$)/.test(filePath)) return;
    // Security: must start with / (absolute path required from renderer)
    if (!filePath.startsWith('/')) return;
    execFile('code', ['--goto', filePath], { timeout: 5000 }, (err) => {
      if (err) console.warn('Failed to open in editor:', err.message);
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

  // --- Native notification ---
  // Store references to prevent GC (known Electron bug)
  const activeNotifications: Set<Notification> = new Set();
  ipcMain.on(IPC.APP_NOTIFY, (event, title: string, body: string, tabId: string) => {
    if (typeof title !== 'string' || typeof body !== 'string') return;
    if (!Notification.isSupported()) return;

    // Security: capture window reference NOW, not in the click handler
    // (event.sender/webContents may be destroyed by the time notification is clicked)
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    const notif = new Notification({ title, body, silent: true });
    activeNotifications.add(notif);

    notif.on('click', () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        if (tabId && !win.webContents.isDestroyed()) {
          win.webContents.send(IPC.APP_SWITCH_TAB + ':id', tabId);
        }
      }
      activeNotifications.delete(notif);
    });

    notif.on('close', () => {
      activeNotifications.delete(notif);
    });

    notif.show();
  });
}
