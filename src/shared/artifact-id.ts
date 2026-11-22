/**
 * The one reading of a claude.ai artifact address (page titles, the session
 * bar's links, bookmarks): `/code/artifact/<id>`, `/artifact/<id>`,
 * `/public/artifacts/<id>`. Pure; shared by main and renderer.
 */

/** A claude.ai artifact URL; group 1 is the id. */
export const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:[a-z]+\/)*artifacts?\/([A-Za-z0-9-]+)/;

/** An id safe to look up, store and hand to grep as a fixed string. */
export const ARTIFACT_ID = /^[A-Za-z0-9-]{8,64}$/;

/** The artifact id of a claude.ai artifact URL, or null. */
export function artifactIdOf(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  const m = url.match(ARTIFACT_URL);
  return m && ARTIFACT_ID.test(m[1]) ? m[1] : null;
}
