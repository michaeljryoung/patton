/**
 * The page titles main has learned (main/page-titles.ts): claude.ai artifact
 * id → the page's own `<title>`. Read once at start and kept current by main's
 * push, so callers look titles up here, never over IPC. Titles come from files
 * a transcript names: show them through textContent only.
 *
 * Pure at import (no `window` use until `startPageTitles`), so the checks
 * bundle the label rules with it under plain Node and set titles directly.
 */
import { artifactIdOf } from '../../shared/artifact-id';
import type { PageTitleMap } from '../../shared/types';
import { rlog } from './renderer-logger';

let titles = new Map<string, string>();
const listeners = new Set<() => void>();
let started = false;

/** If main's first answer is null (rate-limited), ask once more after this (ms). */
export const RETRY_DELAY_MS = 2000;

/** Replace the map (main's answer or push; the checks). Own string entries only. */
export function setPageTitles(map: PageTitleMap | null | undefined): void {
  const next = new Map<string, string>();
  if (map && typeof map === 'object') {
    for (const id of Object.keys(map)) {
      const title: unknown = map[id];
      if (typeof title === 'string' && title) next.set(id, title);
    }
  }
  titles = next;
  // One listener's failure must not stop the others.
  for (const cb of listeners) {
    try {
      cb();
    } catch (err) {
      rlog('warn', '[TITLE] listener failed', { error: (err as Error)?.name ?? 'unknown' });
    }
  }
}

/** The learned title of a claude.ai artifact address, or ''. */
export function pageTitleOf(url: string | null | undefined): string {
  const id = artifactIdOf(url);
  return id ? titles.get(id) ?? '' : '';
}

/** Called after every change; returns the unsubscribe. */
export function onPageTitlesChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Once per window: ask main for the map, then follow its pushes. A null answer
 *  (refused) is asked once more after RETRY_DELAY_MS, unless a push came first. */
export function startPageTitles(): void {
  if (started) return;
  started = true;
  let pushed = false;
  window.patton.pageTitles.onChanged((map) => { pushed = true; setPageTitles(map); });
  const ask = (retry: boolean): void => {
    window.patton.pageTitles.get()
      .then((map) => {
        if (map) {
          if (!pushed) setPageTitles(map);
        } else if (!retry) {
          setTimeout(() => { if (!pushed) ask(true); }, RETRY_DELAY_MS);
        }
        rlog('info', '[TITLE] titles loaded', { count: map ? Object.keys(map).length : null, retry });
      })
      .catch((err) => rlog('warn', '[TITLE] titles load failed', err));
  };
  ask(false);
}
