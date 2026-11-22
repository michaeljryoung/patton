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

let titles: PageTitleMap = {};
const listeners = new Set<() => void>();
let started = false;

/** Replace the map (main's answer or push; the checks). */
export function setPageTitles(map: PageTitleMap): void {
  const next: PageTitleMap = {};
  for (const [id, title] of Object.entries(map ?? {})) {
    if (typeof title === 'string' && title) next[id] = title;
  }
  titles = next;
  for (const cb of listeners) cb();
}

/** The learned title of a claude.ai artifact address, or ''. */
export function pageTitleOf(url: string | null | undefined): string {
  const id = artifactIdOf(url);
  return id ? titles[id] ?? '' : '';
}

/** Called after every change; returns the unsubscribe. */
export function onPageTitlesChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Once per window: ask main for the map, then follow its pushes. */
export function startPageTitles(): void {
  if (started) return;
  started = true;
  window.patton.pageTitles.onChanged((map) => setPageTitles(map));
  window.patton.pageTitles.get()
    .then((map) => {
      if (map) setPageTitles(map);
      rlog('info', '[TITLE] titles loaded', { count: map ? Object.keys(map).length : null });
    })
    .catch((err) => rlog('warn', '[TITLE] titles load failed', err));
}
