import { app, BrowserWindow } from 'electron';
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
  registerIpcHandlers(ptyManager);
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  ptyManager.destroyAll();
});
