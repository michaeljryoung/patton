/**
 * What the bookmarks bar shows for a row: the name alone, with the full path or
 * address kept for the tooltip and the accessible name. A second line appears
 * only when two rows in a group carry the same name, and then it is the
 * smallest thing that tells them apart: a project's parent folder name, or the
 * start of an artifact's id. Pure: no DOM.
 */

import type { Bookmark } from '../../shared/types';

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** The last path segment of an address, which for an artifact link is its id. */
function lastSegment(url: string): string {
  try {
    return segments(new URL(url).pathname).pop() ?? '';
  } catch {
    return '';
  }
}

/** The name a new artifact bookmark gets when the form's name box is empty:
 *  "claude.ai" for every one told them apart in no way, so an artifact link
 *  is named by the start of its id ("Artifact 8bf5f5bc"), any other link by its host. */
export function defaultArtifactLabel(url: string): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    return url;
  }
  const id = lastSegment(url);
  let isArtifact = false;
  try {
    isArtifact = /\/artifacts?\//.test(new URL(url).pathname);
  } catch {
    // keep false
  }
  return isArtifact && id ? `Artifact ${id.slice(0, 8)}` : host;
}

/** The text that tells a row from another of the same name, or '' when its name is unique in `group`. */
export function disambiguator(bookmark: Bookmark, group: readonly Bookmark[]): string {
  const twin = group.some((b) => b.id !== bookmark.id && b.label === bookmark.label);
  if (!twin) return '';
  if (bookmark.kind === 'project') {
    const parts = segments(bookmark.path ?? '');
    return parts.length >= 2 ? parts[parts.length - 2] : '';
  }
  const id = lastSegment(bookmark.url ?? '');
  if (id) return id.slice(0, 8);
  try {
    return new URL(bookmark.url ?? '').host;
  } catch {
    return '';
  }
}

/** The tooltip and the accessible name's detail: the full folder or address. */
export function fullTarget(bookmark: Bookmark): string {
  return bookmark.kind === 'project' ? (bookmark.displayPath ?? bookmark.path ?? '') : (bookmark.url ?? '');
}
