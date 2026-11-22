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
import { grepFailure, runBackfill } from './page-title-backfill';
import { PageTitleBook } from './page-titles';
import { RateLimiter } from './rate-limiter';
import { claudeHome } from './session-link';
import * as store from './store';

/** The backfill waits this long after launch, so it never competes with start-up. */
const BACKFILL_DELAY_MS = 60 * 1000;

let backfillTimer: ReturnType<typeof setTimeout> | null = null;
const backfillAbort = new AbortController();

/** On quit: no backfill starts, and a running grep is killed (it would outlive the app). */
export function stopPageTitleBackfill(): void {
  if (backfillTimer) clearTimeout(backfillTimer);
  backfillTimer = null;
  backfillAbort.abort();
}

/** The artifact ids the bookmarks use (their titles are never evicted). */
function bookmarkedIds(): string[] {
  const ids: string[] = [];
  for (const b of store.getBookmarks()) {
    if (b.kind !== 'artifact') continue;
    const id = artifactIdOf(b.url);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

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
    keep: () => new Set(bookmarkedIds()),
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

  backfillTimer = setTimeout(() => {
    backfillTimer = null;
    let ids: string[];
    try {
      ids = bookmarkedIds();
    } catch (err) {
      console.warn('[TITLE] backfill failed', { stage: 'bookmarks', ...grepFailure(err) });
      return;
    }
    // Logs carry counts and error codes only: an error's message can hold every path and id.
    runBackfill(book, ids, { projectsDir: join(claudeHome(), 'projects'), signal: backfillAbort.signal })
      .catch((err) => console.warn('[TITLE] backfill failed', { stage: 'run', ...grepFailure(err) }));
  }, BACKFILL_DELAY_MS);
  backfillTimer.unref?.();

  return book;
}
