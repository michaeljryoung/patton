import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '../shared/constants';
import { PtyManager } from './pty-manager';
import * as store from './store';
import type { PtyCreateOptions } from '../shared/types';

// --- Security: Sliding-window rate limiter ---
class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxCalls: number;
  private readonly windowMs: number;

  constructor(maxCallsPerSecond: number) {
    this.maxCalls = maxCallsPerSecond;
    this.windowMs = 1000;
  }

  allow(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    // Remove timestamps outside the window
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxCalls) {
      return false;
    }
    this.timestamps.push(now);
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
    requireOwnership(ptyManager, event, id);
    return ptyManager.getProcessName(id);
  });

  ipcMain.handle(IPC.PTY_GET_DESCENDANTS, (event, id: number) => {
    requireOwnership(ptyManager, event, id);
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
}
