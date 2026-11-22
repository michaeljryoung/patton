/**
 * IPC for the session bar's feed (docs/session-bar.md D8, D9; channel names in
 * shared/session-feed.ts). A window may watch only its own PTYs, as with every
 * other pty handler; events go to the owning window alone.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { SESSION_FEED_IPC, type SessionFeedEvent } from '../shared/session-feed';
import type { PtyManager } from './pty-manager';
import { RateLimiter } from './rate-limiter';
import { SessionFeed } from './session-feed';

function validId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

function hintPath(hint: unknown): string | undefined {
  if (typeof hint !== 'object' || hint === null) return undefined;
  const p = (hint as { transcriptPath?: unknown }).transcriptPath;
  return typeof p === 'string' && p.length <= 4096 ? p : undefined;
}

export function registerSessionFeedHandlers(ptyManager: PtyManager): SessionFeed {
  const feed = new SessionFeed({
    shellPid: (ptyId) => ptyManager.getPid(ptyId),
    send: (ptyId, event: SessionFeedEvent) => {
      const win = ptyManager.getWindow(ptyId);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
      try {
        win.webContents.send(SESSION_FEED_IPC.EVENT, ptyId, event);
        return true;
      } catch {
        return false;
      }
    },
  });

  ptyManager.addExitListener((ptyId) => feed.unwatch(ptyId, 'pty exited'));

  // Each watch runs one `ps`; the renderer calls it at a pane's first Claude
  // report and after a Stop, so 20 a second is far above real use.
  const watchLimiter = new RateLimiter(20);
  ipcMain.handle(SESSION_FEED_IPC.WATCH, (event, ptyId: unknown, hint?: unknown) => {
    if (!validId(ptyId)) {
      console.warn('[SECURITY] SESSION_FEED_WATCH type validation failed', { ptyId: typeof ptyId });
      return false;
    }
    if (!watchLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: SESSION_FEED_IPC.WATCH });
      return false;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !ptyManager.validateOwnership(ptyId, win)) {
      console.warn('[SECURITY] PTY ownership check failed', { channel: SESSION_FEED_IPC.WATCH, id: ptyId });
      return false;
    }
    return feed.watch(ptyId, hintPath(hint));
  });

  ipcMain.handle(SESSION_FEED_IPC.UNWATCH, (event, ptyId: unknown) => {
    if (!validId(ptyId)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !ptyManager.validateOwnership(ptyId, win)) {
      console.warn('[SECURITY] PTY ownership check failed', { channel: SESSION_FEED_IPC.UNWATCH, id: ptyId });
      return;
    }
    feed.unwatch(ptyId, 'unwatch');
  });

  return feed;
}
