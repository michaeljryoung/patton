/**
 * The one reading of a claude.ai artifact address (page titles, the session
 * bar's links, bookmarks): `/code/artifact/<id>`, `/artifact/<id>`,
 * `/public/artifacts/<id>`. Pure; shared by main and renderer.
 */

/** A claude.ai artifact URL; group 1 is the id. */
export const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:[a-z]+\/)*artifacts?\/([A-Za-z0-9-]+)/;

/** An id safe to look up, store and hand to grep as a fixed string. */
export const ARTIFACT_ID = /^[A-Za-z0-9-]{8,64}$/;

/** A whole artifact id, as claude.ai gives them (read in this Mac's transcripts,
 *  22 Nov 2026): a lowercase UUID (every page Claude Code publishes, under
 *  `/code/artifact/`), or 22 base58 characters under `/artifact/` (Claude Docs).
 *  Anything else is an address cut short, often a quoted line cut mid-id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE58_22 = /^[1-9A-HJ-NP-Za-km-z]{22}$/;
const DOC_URL = /^https:\/\/claude\.ai\/artifact\//;

/** The artifact id of a claude.ai artifact URL, or null. */
export function artifactIdOf(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  const m = url.match(ARTIFACT_URL);
  return m && ARTIFACT_ID.test(m[1]) ? m[1] : null;
}

/** True for a whole id: a UUID, or (`docAddress`) a 22-character base58 id. */
export function isCompleteArtifactId(id: unknown, docAddress = false): boolean {
  return typeof id === 'string' && (UUID.test(id) || (docAddress && BASE58_22.test(id)));
}

/** The artifact id of a claude.ai artifact URL when the id is whole (the forms
 *  above, a base58 id only under `/artifact/`), else null. Publishes, live and
 *  in the backfill, take only these: a cut id would be a separate page. */
export function completeArtifactIdOf(url: unknown): string | null {
  const id = artifactIdOf(url);
  return id && isCompleteArtifactId(id, DOC_URL.test(url as string)) ? id : null;
}
