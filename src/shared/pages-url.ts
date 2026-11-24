/**
 * The one reading of a link to Michael's Pages site (session bar D6): since
 * 24 Nov 2026 every page a Claude session makes him is published to
 * `https://mjy-pages.vercel.app/p/<slug>/` (behind Vercel's sign-in) in place
 * of a claude.ai artifact. Pure; shared by main (`transcript-parser.ts`) and
 * the renderer (`session-bar-model.ts`).
 *
 * Only https, only this exact host (`mjy-pages.vercel.app.evil.com` is another
 * host), only a page (`/p/<slug>`, slash optional) or the site root; nothing
 * after it (no query, fragment or deeper path). The address is given back in
 * one form, with the trailing slash, so both spellings are one row in the bar.
 */

export const PAGES_ORIGIN = 'https://mjy-pages.vercel.app';

/** Group 1 is the slug; absent for the site root. */
const PAGES_URL = /^https:\/\/mjy-pages\.vercel\.app(?:\/|\/p\/([a-z0-9-]{1,80})\/?)?$/;

export interface PagesLink {
  /** The address in its one form: `<origin>/p/<slug>/` or `<origin>/`. */
  url: string;
  /** The page's slug; null for the site root. */
  slug: string | null;
}

/** A Pages address (trailing punctuation already stripped), or null. */
export function pagesLinkOf(url: unknown): PagesLink | null {
  if (typeof url !== 'string' || url.length > 200) return null;
  const m = url.match(PAGES_URL);
  if (!m) return null;
  const slug = m[1] ?? null;
  return { url: slug ? `${PAGES_ORIGIN}/p/${slug}/` : `${PAGES_ORIGIN}/`, slug };
}

/** The label a Pages link gets with no markdown text: the slug in words, first
 *  letter capitalised ("patton-icon-studies" → "Patton icon studies"); the
 *  site root (or a slug of only hyphens) reads "Pages home". */
export function pagesLabel(slug: string | null): string {
  const words = (slug ?? '').split('-').filter(Boolean).join(' ');
  if (!words) return 'Pages home';
  return words[0].toUpperCase() + words.slice(1);
}
