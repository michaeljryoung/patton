import { BrowserWindow, dialog, nativeTheme, screen } from 'electron';
import path from 'node:path';
import * as store from './store';
import { IPC, UI_TEXT_SCALE_ARG, WINDOW_BG, uiTextScaleOf } from '../shared/constants';
import type { PtyManager } from './pty-manager';
import { closePreconfirmations } from './close-preconfirm';
import { closeConfirmations, isCloseKeyRepeat } from './close-confirm';
import { isQuitConfirmed } from './quit-guard';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

/** True when Patton has exactly one window, so closing it quits Patton
 *  (`window-all-closed` → `app.quit()`). Shared by the close guard and the
 *  renderer's last-tab dialog (`WINDOW_CLOSE_INFO`), so both say the same. */
export function isOnlyWindow(): boolean {
  return BrowserWindow.getAllWindows().length === 1;
}

/** Y of the traffic lights that centres their 12 px in the tab strip, which is
 *  28 px at Interface Text Size 1 (tabs.css --tabh) and grows with it. */
function trafficLightY(scale: number): number {
  return Math.round(14 * scale - 6);
}

/** Tell every window the new Interface Text Size and re-centre its traffic lights. */
export function broadcastUiTextScale(scale: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(IPC.SETTINGS_UI_TEXT_SCALE, scale);
    if (process.platform === 'darwin') win.setWindowButtonPosition({ x: 12, y: trafficLightY(scale) });
  }
}

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
    // Centres the 12 px lights in the renderer's tab strip (tabs.css --tabh).
    trafficLightPosition: { x: 12, y: trafficLightY(uiTextScaleOf(store.getSettings().uiTextScale)) },
    // The chrome's own ground (main.css --bg) so the first paint doesn't flash.
    backgroundColor: nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The preload reads this synchronously, so the renderer sizes its chrome
      // before the first tab bar exists (an IPC read would arrive after it).
      additionalArguments: [`${UI_TEXT_SCALE_ARG}${uiTextScaleOf(store.getSettings().uiTextScale)}`],
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Keep the renderer fully alive when Patton is backgrounded. Chromium's
      // default (true) throttles timers and may suspend the renderer when the
      // app loses focus on macOS — which appears to leave the WebGL texture
      // atlas in a corrupted state on resume (the recurring "garbled glyphs
      // after Cmd+Tab" bug). Setting false keeps the GPU pipeline live, which
      // prevents the corruption rather than just recovering from it. Side
      // effect: visibilityState stays 'visible' even when occluded, so any
      // background-detection logic must use document.hasFocus() / window
      // focus events instead of document.hidden.
      backgroundThrottling: false,
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

  const windowId = window.id;

  /** The native fallback box for closing this window with live shells. True = Close Anyway. */
  const nativeCloseBox = (count: number): boolean => {
    const isLastWindow = isOnlyWindow();
    const terminals = `${count} terminal${count === 1 ? '' : 's'}`;
    const result = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Cancel', 'Close Anyway'],
      defaultId: 0,
      cancelId: 0,
      title: isLastWindow ? 'Close Patton' : 'Close Window',
      message: `${terminals} still running`,
      detail:
        (isLastWindow
          ? 'Closing the last window will end every terminal session and quit Patton. '
          : `Closing this window will end its ${terminals}; your other windows stay open. `) +
        'Transcripts on disk are preserved, but in-memory session state is not.\n\n' +
        'To keep a session alive, cancel and exit it gracefully from inside its tab first.',
    });
    return result !== 0;
  };

  /** The user confirmed closing this window (in the app or natively): record it
   *  for the guard and close through the normal path, which then skips the ask. */
  const closeConfirmed = (how: string) => {
    if (window.isDestroyed()) return;
    console.info('[CLOSE] window close confirmed', { windowId, how });
    closePreconfirmations.mark(windowId);
    window.close();
  };

  // A held ⌘Q or ⌘W must never answer the quit / close dialog: auto-repeat
  // events are stopped here, before the page and the menu accelerators see them.
  let lastRepeatLog = 0;
  window.webContents.on('before-input-event', (event, input) => {
    if (!isCloseKeyRepeat(input)) return;
    event.preventDefault();
    const t = Date.now();
    if (t - lastRepeatLog > 2000) {
      lastRepeatLog = t;
      console.info('[CLOSE] held ⌘Q/⌘W ignored (key repeat)', { windowId });
    }
  });

  window.on('close', (e) => {
    // Guard against silently killing live PTYs by closing a window: the red
    // button or ⌘W on its last tab. On macOS,
    // `window-all-closed` triggers `app.quit()` here (Patton is a terminal
    // app, not something that stays dockside windowless), so closing the
    // final window IS a quit action; the before-quit handler can't catch that
    // path because this handler destroys the window's PTYs first, so it then
    // finds none alive and never asks a second time. ⌘Q asks in before-quit
    // (quit-guard.ts) and destroys every PTY before windows close, so it is
    // never asked twice either: once the user confirmed that quit
    // (isQuitConfirmed) this handler stands down.
    //
    // ⌘W on the last tab has already asked in the app ("Quit Patton?" or
    // "Close this window?"): its renderer records that here (preconfirm IPC),
    // then asks main to close the window (WINDOW_CLOSE → BrowserWindow.close(),
    // which is what emits this event; the page's own window.close() does NOT,
    // measured on Electron 44.9.3), without disposing the tab, so the shells
    // are still alive. A fresh record for THIS window skips the ask once; a
    // stale or absent one leaves the guard as it was (close-preconfirm.ts).
    //
    // v1.19 (S46): the red button (no record) asks IN THE APP too, with the
    // same dialog (Enter / ⌘W confirm, Esc cancels), instead of the native box
    // that ⌘W could not answer. This supersedes the S45 decision "⌘Q and the
    // red button keep the native guard". The close is always prevented first;
    // a confirmation records itself as a pre-confirmation and closes again.
    // The native box remains only when this window cannot show the dialog
    // (hidden, minimized, crashed) or its renderer does not answer in time.
    const preconfirm = closePreconfirmations.take(windowId);
    if (preconfirm === 'confirmed') console.info('[CLOSE] window close pre-confirmed', { windowId });
    if (preconfirm === 'expired') console.info('[CLOSE] window close pre-confirmation expired', { windowId });
    const count = ptyManager?.liveCountForWindow(window) ?? 0;
    if (count > 0 && preconfirm !== 'confirmed' && isQuitConfirmed()) {
      console.info('[CLOSE] window close: the quit was confirmed, not asking again', { windowId, count });
    } else if (count > 0 && preconfirm !== 'confirmed') {
      // A dialog is already open for this window, or a quit dialog is open
      // anywhere: another click or ⌘Q must neither stack a dialog nor skip it.
      if (closeConfirmations.hasPendingFor(windowId) || closeConfirmations.hasPendingQuit()) {
        e.preventDefault();
        console.info('[CLOSE] window close ignored: a confirmation is already open', { windowId });
        return;
      }
      if (closeConfirmations.canAsk(window)) {
        e.preventDefault();
        const kind = isOnlyWindow() ? 'quit' : 'close-window';
        console.info('[CLOSE] window close: asking in the app', { windowId, kind, count });
        void closeConfirmations.ask(window, kind, count).then((result) => {
          if (result === 'confirmed') {
            closeConfirmed('in-app');
          } else if (result === 'unavailable') {
            if (window.isDestroyed()) return;
            // Count again: a crashed renderer's shells are already ended.
            const now = ptyManager?.liveCountForWindow(window) ?? 0;
            if (now <= 0) {
              closeConfirmed('no-shells-left');
              return;
            }
            console.info('[CLOSE] window close: in-app dialog unavailable; native box', { windowId, count: now });
            if (nativeCloseBox(now)) closeConfirmed('native-fallback');
            else console.info('[CLOSE] window close cancelled', { windowId, how: 'native-fallback' });
          } else {
            console.info('[CLOSE] window close not confirmed', { windowId, result });
          }
        });
        return;
      }
      console.info('[CLOSE] window close: window cannot show the in-app dialog; native box', { windowId, count });
      if (!nativeCloseBox(count)) {
        e.preventDefault();
        return;
      }
    }

    if (saveTimer) clearTimeout(saveTimer);
    saveState();
    ptyManager?.destroyByWindow(window);
  });
  // Safety net for a close that skipped the handler above (the page's own
  // window.close(), or any future path): end whatever shells the window still
  // had. By id, because the window is destroyed here. A non-zero count means
  // some path bypassed the guard.
  window.on('closed', () => {
    closePreconfirmations.forget(windowId);
    const leftover = ptyManager?.destroyByWindowId(windowId) ?? 0;
    if (leftover > 0) console.warn('[CLOSE] window closed without its close guard; ended its shells', { windowId, leftover });
  });
  window.on('resize', debouncedSave);
  window.on('move', debouncedSave);

  return window;
}
