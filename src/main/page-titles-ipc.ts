/**
 * Page titles' IPC and the once-per-launch backfill (main/page-titles.ts).
 * The getter answers the whole map (null when rate-limited, so the renderer
 * keeps what it has); every change is pushed to every window.
 */
import { join } from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import { artifactIdOf } from '../shared/artifact-id';
import { IPC } from '../shared/constants';
import type { PageTitleMap } from '../shared/types';
import { runBackfill } from './page-title-backfill';
import { PageTitleBook } from './page-titles';
import { RateLimiter } from './rate-limiter';
import { claudeHome } from './session-link';
import * as store from './store';

/** The backfill waits this long after launch, so it never competes with start-up. */
const BACKFILL_DELAY_MS = 60 * 1000;

export function registerPageTitleHandlers(): PageTitleBook {
  const book = new PageTitleBook({
    store: {
      getTitles: store.getPageTitles,
      setTitles: store.setPageTitles,
      getMisses: store.getPageTitleMisses,
      setMisses: store.setPageTitleMisses,
    },
    onChange: (titles: PageTitleMap) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC.PAGE_TITLES_CHANGED, titles);
      }
    },
  });

  // Each window asks once at start; changes come by push.
  const getLimiter = new RateLimiter(20);
  ipcMain.handle(IPC.PAGE_TITLES_GET, () => {
    if (!getLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.PAGE_TITLES_GET });
      return null;
    }
    return book.titles();
  });

  const timer = setTimeout(() => {
    const ids: string[] = [];
    for (const b of store.getBookmarks()) {
      if (b.kind !== 'artifact') continue;
      const id = artifactIdOf(b.url);
      if (id) ids.push(id);
    }
    runBackfill(book, ids, { projectsDir: join(claudeHome(), 'projects') })
      .catch((err) => console.warn('[TITLE] backfill failed', { error: (err as Error).message }));
  }, BACKFILL_DELAY_MS);
  timer.unref?.();

  return book;
}
