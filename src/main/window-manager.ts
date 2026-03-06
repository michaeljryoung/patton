import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import * as store from './store';
import type { PtyManager } from './pty-manager';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

export function createWindow(ptyManager?: PtyManager): BrowserWindow {
  const savedState = store.getWindowState();

  const window = new BrowserWindow({
    width: savedState.width,
    height: savedState.height,
    x: savedState.x,
    y: savedState.y,
    minWidth: 400,
    minHeight: 300,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Validate window position is on a visible display
  if (savedState.x !== undefined && savedState.y !== undefined) {
    const bounds = { x: savedState.x, y: savedState.y, width: savedState.width, height: savedState.height };
    const display = screen.getDisplayMatching(bounds);
    const { x: dx, y: dy, width: dw, height: dh } = display.bounds;
    if (
      savedState.x < dx || savedState.y < dy ||
      savedState.x >= dx + dw || savedState.y >= dy + dh
    ) {
      window.center();
    }
  }

  if (savedState.isMaximized) {
    window.maximize();
  }

  // --- Security: Content Security Policy ---
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${MAIN_WINDOW_VITE_DEV_SERVER_URL ? ' ws://localhost:*' : ''}; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'`,
        ],
      },
    });
  });

  // --- Security: Block navigation to external URLs ---
  // In production, only allow navigation to the app's own file:// path (not arbitrary file:// URLs)
  const appFileOrigin = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? undefined
    : `file://${path.join(__dirname, '..')}`;
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = [
      MAIN_WINDOW_VITE_DEV_SERVER_URL,
      appFileOrigin,
    ].filter(Boolean);
    if (!allowed.some(origin => url.startsWith(origin as string))) {
      event.preventDefault();
    }
  });

  // --- Security: Block new window creation ---
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  // Save window state (debounced for resize/move, immediate on close)
  const saveState = () => {
    if (window.isDestroyed()) return;
    const bounds = window.getBounds();
    store.setWindowState({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: window.isMaximized(),
    });
  };

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 500);
  };

  window.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveState();
    ptyManager?.destroyByWindow(window);
  });
  window.on('resize', debouncedSave);
  window.on('move', debouncedSave);

  return window;
}
