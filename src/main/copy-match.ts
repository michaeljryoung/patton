/**
 * Finds Claude's original text for a selection copied out of a Claude tab.
 * Pure: no Electron, no Node APIs.
 *
 * Claude Code draws a reply into the terminal grid: real line breaks at the
 * window's width, a two-space indent, `▎` before quoted lines, `⏺` and `⎿`
 * glyphs, tables in box drawing, and the Markdown already rendered. So both
 * sides are compared as letters and digits only (NFC, lower case): the
 * selection with its decoration dropped, and the reply's visible text
 * (`markdown-doc.ts`). A match maps back to the reply's own span, widened to
 * whole words, and is rendered as plain text and HTML.
 *
 * Falls back (the caller copies the drawn text) when the selection is under
 * two words, is found in no reply (a selection across two replies, or over
 * tool output, is one), or is found more than once with different originals.
 */
import { parseMarkdown, renderHtml, renderPlain, type MarkdownDoc } from './markdown-doc';

export interface OriginalCopy {
  text: string;
  html: string;
}

export type MatchResult =
  | { ok: true; copy: OriginalCopy; msgsSearched: number }
  | { ok: false; reason: 'short' | 'not found' | 'ambiguous'; msgsSearched: number };

const KEEP = /[\p{L}\p{N}]/u;
/** Drawn decoration at a line's start: indent, quote bar, reply and result
 *  glyphs, box drawing, a list bullet, and a numbered item's number (Claude
 *  Code renumbers lists, so the number is not compared on either side). */
const LINE_DECORATION = /^[\s▎▍▌│┃|⏺●⎿•·◦▪>*+\-─-╿]*(?:\d{1,9}[.)](?=\s))?/u;
const TRAIL_DECORATION = /[\s│┃|─-╿]+$/u;
const MAX_CANDIDATES = 20;

interface Normalised {
  /** Letters and digits, NFC, lower case. */
  chars: string;
  /** For each char of `chars`, its offset in the visible text. */
  at: number[];
}

function normalise(visible: string): Normalised {
  let chars = '';
  const at: number[] = [];
  let off = 0;
  for (const ch of visible) {
    if (KEEP.test(ch)) {
      const n = ch.normalize('NFC').toLowerCase();
      for (let k = 0; k < n.length; k++) { chars += n[k]; at.push(off); }
    }
    off += ch.length;
  }
  return { chars, at };
}

/** The selection's letters and digits, its decoration dropped line by line. */
export function normaliseSelection(selection: string): string {
  return selection.split('\n').map((line) => normalise(line.replace(LINE_DECORATION, '').normalize('NFC')).chars).join('');
}

interface Prepared {
  doc: MarkdownDoc;
  norm: Normalised;
}

const cache = new Map<string, Prepared>();
const CACHE_MAX = 400;

function prepare(text: string): Prepared {
  const hit = cache.get(text);
  if (hit) return hit;
  const doc = parseMarkdown(text);
  const p = { doc, norm: normalise(doc.visible) };
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, p);
  return p;
}

function isKeep(ch: string | undefined): boolean {
  return ch !== undefined && KEEP.test(ch);
}

/** The selection's first and last meaningful characters, decoration dropped. */
function edges(selection: string): { lead: string | undefined; trail: string | undefined } {
  const lines = selection.split('\n');
  const firstLine = lines.find((l) => l.replace(LINE_DECORATION, '').trim() !== '') ?? '';
  const lead = firstLine.replace(LINE_DECORATION, '')[0];
  const trimmed = selection.replace(TRAIL_DECORATION, '');
  return { lead, trail: trimmed[trimmed.length - 1] };
}

function wordCount(selection: string): number {
  return selection.split(/\s+/).filter((w) => KEEP.test(w)).length;
}

/**
 * Claude's original text for `selection`, searched in `messages` (the
 * session's recent assistant text blocks, Markdown as Claude wrote it).
 */
export function findOriginal(selection: string, messages: readonly string[]): MatchResult {
  const msgsSearched = messages.length;
  const sel = normaliseSelection(selection);
  if (sel.length < 4 || wordCount(selection) < 2) return { ok: false, reason: 'short', msgsSearched };
  const { lead, trail } = edges(selection);

  const found = new Map<string, OriginalCopy>();
  let candidates = 0;
  for (const text of messages) {
    const { doc, norm } = prepare(text);
    let p = norm.chars.indexOf(sel);
    while (p >= 0) {
      if (++candidates > MAX_CANDIDATES) return { ok: false, reason: 'ambiguous', msgsSearched };
      const end = p + sel.length;
      let a: number;
      let b: number;
      if (p === 0 && end === norm.chars.length) {
        a = 0;
        b = doc.visible.length;
      } else {
        a = norm.at[p];
        b = norm.at[end - 1] + 1;
        const v = doc.visible;
        // Whole words: a part-selected word is completed; punctuation the
        // selection began or ended on is taken up to the next space.
        while (a > 0 && isKeep(v[a - 1])) a--;
        if (!isKeep(lead)) while (a > 0 && !/\s/.test(v[a - 1])) a--;
        while (b < v.length && isKeep(v[b])) b++;
        if (!isKeep(trail)) while (b < v.length && !/\s/.test(v[b])) b++;
      }
      const copy = { text: renderPlain(doc, a, b), html: renderHtml(doc, a, b) };
      found.set(`${copy.text}\u0000${copy.html}`, copy);
      p = norm.chars.indexOf(sel, p + 1);
    }
  }
  if (found.size === 0) return { ok: false, reason: 'not found', msgsSearched };
  if (found.size > 1) return { ok: false, reason: 'ambiguous', msgsSearched };
  const [copy] = found.values();
  return { ok: true, copy, msgsSearched };
}
