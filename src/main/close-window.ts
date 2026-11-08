import { BrowserWindow, type WebContents } from 'electron';

/**
 * Close the window that owns `sender` with BrowserWindow.close(), which emits
 * the 'close' event (main's close guard, pre-confirmation, saveState and PTY
 * teardown all hang off it). The page's own window.close() destroys the window
 * WITHOUT that event (measured on Electron 44.9.3; scripts/check-close-electron.cjs
 * pins it), so renderer close paths must come through here.
 *
 * The close runs on a later tick so the IPC reply returns at once: the guard
 * may block main in a native box, and a slow reply must not make the renderer
 * fall back to window.close() on top of a close the user just cancelled.
 * Returns the window's id, or null when the sender has no live window.
 */
export function closeSenderWindow(sender: WebContents): number | null {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || win.isDestroyed()) return null;
  const windowId = win.id;
  console.info('[CLOSE] window close requested by its renderer', { windowId });
  setImmediate(() => {
    if (!win.isDestroyed()) win.close();
  });
  return windowId;
}
