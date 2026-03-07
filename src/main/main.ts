import { app, BrowserWindow, dialog, globalShortcut } from 'electron';
import started from 'electron-squirrel-startup';
import { PtyManager } from './pty-manager';
import { registerIpcHandlers } from './ipc-handlers';
import { createWindow } from './window-manager';
import { buildMenu } from './menu';
import { getSettings } from './store';

if (started) {
  app.quit();
}

// Allow Web Audio API to play without user gesture (desktop app, not a web page).
// Without this, AudioContext stays suspended when triggered by IPC events (e.g. bell).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ptyManager = new PtyManager();

app.on('ready', () => {
  try {
    registerIpcHandlers(ptyManager);
    buildMenu(ptyManager);
    createWindow(ptyManager);

    // Register global hotkey to toggle window visibility
    const settings = getSettings();
    const hotkey = settings.globalHotkey || 'Control+`';
    try {
      globalShortcut.register(hotkey, () => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length === 0) {
          createWindow(ptyManager);
          return;
        }
        const win = windows[0];
        if (win.isFocused()) {
          win.hide();
        } else {
          win.show();
          win.focus();
        }
      });
    } catch (err) {
      console.warn('Failed to register global hotkey:', err);
    }
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
  globalShortcut.unregisterAll();
  try {
    ptyManager.destroyAll();
  } catch (err) {
    console.error('[SECURITY] PTY cleanup failed', err);
  }
});
