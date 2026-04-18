import { app, BrowserWindow, crashReporter, dialog, globalShortcut } from 'electron';
import started from 'electron-squirrel-startup';
import { PtyManager } from './pty-manager';
import { registerIpcHandlers } from './ipc-handlers';
import { createWindow } from './window-manager';
import { buildMenu } from './menu';
import { getSettings } from './store';
import { installFileLogger } from './logger';

if (started) {
  app.quit();
}

// Install BEFORE anything else logs. Packaged-app Dock/Finder launches route
// stderr to /dev/null, so without a file logger all the hardening signals
// (render-process-gone, child-process-gone, safeStorage migration, circuit
// breaker, etc.) would have nowhere to land. stderr is preserved for terminal
// launches. Log file: ~/Library/Application Support/Patton/logs/main.log
installFileLogger();

// Local-only crash dumps (no upload) for post-mortem diagnosis.
// Lands under app.getPath('crashDumps') — e.g. ~/Library/Application Support/Patton/Crashpad/completed/
crashReporter.start({
  productName: 'Patton',
  companyName: 'Patton',
  submitURL: '',
  uploadToServer: false,
  compress: true,
});

// Allow Web Audio API to play without user gesture (desktop app, not a web page).
// Without this, AudioContext stays suspended when triggered by IPC events (e.g. bell).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Log GPU/utility process deaths. The GPU process is often the real root cause
// of xterm.js WebGL renderer crashes — logging it separately distinguishes
// renderer bugs from GPU-stack failures. Electron restarts the GPU process on
// its own; the renderer handler in window-manager.ts catches any knock-on death.
app.on('child-process-gone', (_event, details) => {
  console.error(
    'Child process gone:',
    details.type,
    'reason:', details.reason,
    'exitCode:', details.exitCode,
    details.name ? `name: ${details.name}` : ''
  );
});

// Last-resort main-process error handlers. Without these, an unexpected throw
// in main code tears the whole app down silently with no log line. Log, show
// a minimal dialog, then quit — it's better to exit cleanly than to limp on
// with the main process in an unknown state.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException in main process:', err);
  try {
    dialog.showErrorBox('Patton — fatal error', `An unexpected error crashed the main process:\n\n${err?.stack || err?.message || String(err)}\n\nPatton will now quit.`);
  } catch { /* dialog may not be available */ }
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection in main process:', reason);
  // Don't quit — promise rejections are usually recoverable and quitting here
  // would be too aggressive. Log and let the reproducer surface via other paths.
});

const ptyManager = new PtyManager();

app.on('ready', () => {
  try {
    // Apply shell integration setting before any PTYs are created
    const settings = getSettings();
    ptyManager.shellIntegrationEnabled = settings.shellIntegration !== false;

    registerIpcHandlers(ptyManager);
    buildMenu(ptyManager);
    createWindow(ptyManager);
    const hotkey = settings.globalHotkey || 'Control+`';
    try {
      const registered = globalShortcut.register(hotkey, () => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length === 0) {
          createWindow(ptyManager);
          return;
        }
        // Use focused window, or fall back to most recent
        const win = BrowserWindow.getFocusedWindow() || windows[0];
        if (win.isFocused()) {
          win.hide();
        } else {
          win.show();
          win.focus();
        }
      });
      if (!registered) {
        console.warn('Failed to register global hotkey — already in use:', hotkey);
      }
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
  // Always quit when all windows close — terminal apps don't stay in dock windowless
  app.quit();
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
