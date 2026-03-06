import { app, BrowserWindow, dialog } from 'electron';
import started from 'electron-squirrel-startup';
import { PtyManager } from './pty-manager';
import { registerIpcHandlers } from './ipc-handlers';
import { createWindow } from './window-manager';
import { buildMenu } from './menu';

if (started) {
  app.quit();
}

const ptyManager = new PtyManager();

app.on('ready', () => {
  try {
    registerIpcHandlers(ptyManager);
    buildMenu(ptyManager);
    createWindow(ptyManager);
  } catch (err) {
    console.error('Fatal error during app startup:', err);
    dialog.showErrorBox('Patton', `Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(ptyManager);
  }
});

app.on('before-quit', () => {
  try {
    ptyManager.destroyAll();
  } catch (err) {
    console.error('[SECURITY] PTY cleanup failed', err);
  }
});
