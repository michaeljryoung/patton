import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import * as store from './store';
import type { PtyManager } from './pty-manager';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

export function createWindow(ptyManager?: PtyManager): BrowserWindow {
  const savedState = store.getWindowState();

  const window = new BrowserWindow({
    show: false, // Defer show until ready-to-show to prevent white flash
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

  // Show window once renderer is painted (avoids white flash)
  window.once('ready-to-show', () => {
    window.show();
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

  // --- Resilience: log and auto-recover from renderer crashes ---
  // Without this, an OOM or GPU-context death leaves the user staring at
  // Chromium's sad-face icon with no log line and no recovery path.
  //
  // Circuit breaker: a deterministic crash cause (e.g. a restored session that
  // triggers the same bug on reload) would produce an infinite reload loop.
  // We cap at MAX_CRASHES within CRASH_WINDOW_MS, and clear the saved session
  // after the second crash so restore-triggered crashes don't keep re-firing.
  //
  // PTY cleanup: window.reload() creates a new renderer but doesn't touch
  // main-process PTYs. Without destroying them first, each reload leaks PTYs
  // (still running, sending PTY_DATA for ids the new renderer doesn't know),
  // eventually hitting MAX_PTY_PER_WINDOW.
  const MAX_CRASHES = 3;
  const CRASH_WINDOW_MS = 30_000;
  const crashTimestamps: number[] = [];
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      'Renderer process gone:',
      details.reason,
      'exitCode:', details.exitCode
    );
    if (details.reason === 'clean-exit' || window.isDestroyed()) return;

    const now = Date.now();
    // Keep only crashes within the window
    while (crashTimestamps.length && now - crashTimestamps[0] > CRASH_WINDOW_MS) {
      crashTimestamps.shift();
    }
    crashTimestamps.push(now);

    // After second crash, clear saved session — if restore is triggering the
    // crash, the third reload with a cleared session should succeed.
    if (crashTimestamps.length >= 2) {
      console.warn('Renderer crashed twice — clearing saved session to break potential restore loop');
      try { store.setSession(null); } catch (err) { console.error('Failed to clear session:', err); }
    }

    if (crashTimestamps.length >= MAX_CRASHES) {
      console.error(`Renderer crashed ${MAX_CRASHES} times in ${CRASH_WINDOW_MS}ms — halting auto-reload`);
      const msg = encodeURIComponent(`Patton's renderer has crashed ${MAX_CRASHES} times in a row. Auto-reload halted to prevent a crash loop. Quit and relaunch the app. Check Console.app or ~/Library/Application Support/Patton/Crashpad/completed/ for crash dumps.`);
      window.loadURL(`data:text/html;charset=utf-8,<!doctype html><html><body style="font-family:-apple-system,sans-serif;padding:2rem;background:%231e1e1e;color:%23d4d4d4;line-height:1.6"><h2>Patton stopped auto-recovering</h2><p>${msg}</p></body></html>`).catch(() => { /* ignore */ });
      return;
    }

    // Destroy orphaned PTYs before reload (new renderer won't know their ids).
    try { ptyManager?.destroyByWindow(window); } catch (err) { console.error('PTY cleanup on reload failed:', err); }
    window.reload();
  });

  // Detect stalls *before* the renderer dies. A hung event loop usually
  // precedes a crash — logging it gives us a breadcrumb.
  window.webContents.on('unresponsive', () => {
    console.error('Renderer unresponsive (event loop stalled)');
  });
  window.webContents.on('responsive', () => {
    console.info('Renderer responsive again');
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL).catch((err) => {
      console.error('Failed to load dev server URL:', err);
    });
  } else {
    window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    ).catch((err) => {
      console.error('Failed to load app file:', err);
    });
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
