import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { DEFAULTS } from '../shared/constants';
import type { Bookmark } from '../shared/types';
import { isSafeAbsolutePath } from './projects';
import { isAllowedCwdPath } from './pty-manager';

/**
 * Validation for the bookmarks sidebar's list. The renderer sends the whole
 * list on every change; main is the trust boundary, so each entry is checked
 * here before it reaches the store: a project bookmark must name an existing
 * directory, an artifact bookmark must be an https URL, labels are one short
 * line. Invalid entries are dropped (and logged) rather than failing the save,
 * so one bad entry can't lose the rest.
 */

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const URL_MAX_CHARS = 2048;

/** Only https: an artifact link opens in the browser, and other schemes can launch local apps. */
export function isHttpsUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > URL_MAX_CHARS) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** One line, no control characters, capped. */
export function cleanBookmarkLabel(raw: string): string {
  return raw
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEFAULTS.BOOKMARK_LABEL_MAX_CHARS);
}

/** Check one entry; returns the cleaned bookmark, or a reason it was refused.
 *  `stored` is the list already in the store: an entry that matches one of its
 *  entries (same id and path) is not re-checked against the disk, so a bookmark
 *  whose folder has since moved survives an unrelated add, rename or move (it
 *  is shown as missing instead — see annotateBookmarks). */
function validateBookmark(raw: unknown, stored: readonly Bookmark[]): Bookmark | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';
  const b = raw as Record<string, unknown>;
  if (typeof b.id !== 'string' || !ID_PATTERN.test(b.id)) return 'bad id';
  if (typeof b.label !== 'string' || b.label.length > 1000) return 'bad label';
  const label = cleanBookmarkLabel(b.label);
  if (!label) return 'empty label';
  const addedAt = typeof b.addedAt === 'number' && Number.isFinite(b.addedAt) ? b.addedAt : Date.now();

  if (b.kind === 'project') {
    if (!isSafeAbsolutePath(b.path)) return 'unsafe path';
    if (typeof b.path !== 'string' || !isAllowedCwdPath(b.path)) return 'path outside the folders a tab can open in';
    const path = b.path;
    const alreadyStored = stored.some((s) => s.kind === 'project' && s.id === b.id && s.path === path);
    if (!alreadyStored && !isDirectory(path)) return 'path is not a directory';
    return { id: b.id, kind: 'project', label, path: b.path, addedAt };
  }
  if (b.kind === 'artifact') {
    if (!isHttpsUrl(b.url)) return 'url is not https';
    return { id: b.id, kind: 'artifact', label, url: b.url, addedAt };
  }
  return 'unknown kind';
}

/** Validate a whole list from the renderer. Returns the entries worth storing,
 *  or null when the payload isn't a list at all (the caller keeps what it has). */
export function validateBookmarks(raw: unknown, stored: readonly Bookmark[]): Bookmark[] | null {
  if (!Array.isArray(raw)) {
    console.warn('[SECURITY] BOOKMARKS_SET rejected — not an array', { type: typeof raw });
    return null;
  }
  const kept: Bookmark[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw.slice(0, DEFAULTS.BOOKMARKS_MAX)) {
    const result = validateBookmark(entry, stored);
    if (typeof result === 'string') {
      console.warn('[BOOKMARKS] Entry dropped', { reason: result });
      continue;
    }
    if (seenIds.has(result.id)) {
      console.warn('[BOOKMARKS] Entry dropped', { reason: 'duplicate id' });
      continue;
    }
    seenIds.add(result.id);
    kept.push(result);
  }
  if (raw.length > DEFAULTS.BOOKMARKS_MAX) {
    console.warn('[BOOKMARKS] List truncated', { received: raw.length, max: DEFAULTS.BOOKMARKS_MAX });
  }
  return kept;
}

/** "/Users/me/Projects/x" → "~/Projects/x", collapsing only the real home folder. */
function tildePath(path: string, home: string): string {
  if (!home || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

/** Copy of the list with display-only fields for the sidebar: `missing: true` on
 *  each project whose folder is gone, and `displayPath` (home shown as ~). Never
 *  stored: validateBookmark rebuilds entries without them. */
export async function annotateBookmarks(list: readonly Bookmark[]): Promise<Bookmark[]> {
  const home = homedir();
  return Promise.all(
    list.map(async (b) => {
      if (b.kind !== 'project' || !b.path) return { ...b };
      const displayPath = tildePath(b.path, home);
      try {
        const info = await stat(b.path);
        return info.isDirectory() ? { ...b, displayPath } : { ...b, displayPath, missing: true };
      } catch {
        return { ...b, displayPath, missing: true };
      }
    }),
  );
}
