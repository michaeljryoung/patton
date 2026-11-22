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
 * whole words and out to the symbols the selection began and ended on (a
 * `#`, `}`, `- `, an em dash), and is rendered as plain text and HTML. Inside
 * fenced code the code is copied as written, the first line's indentation
 * included.
 *
 * Falls back (the caller copies the drawn text) when the selection is under
 * two words, is found in no reply (a selection across two replies, or over
 * tool output, is one), is found more than once with different originals,
 * has a row of tool output (`⎿`) or of his prompt (`❯`), or when the copy
 * would carry less than he selected ('inexact').
 */
import { parseMarkdown, renderHtml, renderPlain, type MarkdownDoc } from './markdown-doc';

export interface OriginalCopy {
  text: string;
  html: string;
}

export type MatchResult =
  | { ok: true; copy: OriginalCopy; msgsSearched: number }
  | { ok: false; reason: 'short' | 'not found' | 'ambiguous' | 'inexact' | 'not reply'; msgsSearched: number };

const KEEP = /[\p{L}\p{N}]/u;
/** Drawn decoration at a line's start: indent, quote bar, reply and result
 *  glyphs, box drawing, a list bullet, and a numbered item's number (Claude
 *  Code renumbers lists, so the number is not compared on either side). */
const LINE_DECORATION = /^[\s▎▍▌│┃|⏺●⎿•·◦▪>*+\-─-╿]*(?:\d{1,9}[.)](?=\s))?/u;
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

/** The parsed reply, or null if it can't be parsed (it is then skipped, not every lookup). */
function prepare(text: string): Prepared | null {
  const hit = cache.get(text);
  if (hit) return hit;
  let doc: MarkdownDoc;
  try { doc = parseMarkdown(text); } catch { return null; }
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

const SPACE = /\s/;
/** Characters Claude Code draws that are no part of the reply's text. */
const DRAWN_DECORATION = /[\s▎▍▌│┃|⏺●⎿•·◦▪>*+\-─-╿]/u;
/** Box drawing (table borders), drawn anywhere in a row. */
const BOX = /[─-╿]/u;

/**
 * Offsets in `selection` of its first compared character and just past its
 * last, the same characters `normaliseSelection` keeps; null if none.
 */
function selectionContent(selection: string): { first: number; end: number } | null {
  let off = 0;
  let first = -1;
  let end = -1;
  for (const line of selection.split('\n')) {
    const deco = LINE_DECORATION.exec(line)?.[0].length ?? 0;
    let o = off + deco;
    for (const ch of line.slice(deco)) {
      if (KEEP.test(ch)) {
        if (first < 0) first = o;
        end = o + ch.length;
      }
      o += ch.length;
    }
    off += line.length + 1;
  }
  return first < 0 ? null : { first, end };
}

/** True if `s` holds only drawn decoration (a list number included). */
function decorationOnly(s: string): boolean {
  const rest = s.replace(/\d{1,9}[.)](?=\s|$)/g, '');
  for (const ch of rest) if (!DRAWN_DECORATION.test(ch)) return false;
  return true;
}

/**
 * Walks the selection's characters before its first compared one (`head`)
 * back through the visible text from `a`, whitespace aside, so a leading
 * `#`, `//`, `- `, `}` or em dash he selected is copied too. A line break in
 * the visible text must be one in the selection as well (a drawn wrap may be
 * a space in the reply, never the other way). Returns the new start and the
 * part of `head` left unmatched.
 */
function extendBack(v: string, a: number, head: string): { a: number; rest: string } {
  let i = head.length;
  let j = a;
  for (;;) {
    let selBreak = false;
    while (i > 0 && SPACE.test(head[i - 1])) { if (head[i - 1] === '\n') selBreak = true; i--; }
    if (i === 0) break;
    let k = j;
    let visBreak = false;
    while (k > 0 && SPACE.test(v[k - 1])) { if (v[k - 1] === '\n') visBreak = true; k--; }
    if (k === 0 || v[k - 1] !== head[i - 1] || (visBreak && !selBreak)) break;
    i--;
    j = k - 1;
  }
  return { a: j, rest: head.slice(0, i) };
}

/** `extendBack`'s mirror for the selection's characters after its last compared one. */
function extendForward(v: string, b: number, tail: string): { b: number; rest: string } {
  let i = 0;
  let j = b;
  for (;;) {
    let selBreak = false;
    while (i < tail.length && SPACE.test(tail[i])) { if (tail[i] === '\n') selBreak = true; i++; }
    if (i === tail.length) break;
    let k = j;
    let visBreak = false;
    while (k < v.length && SPACE.test(v[k])) { if (v[k] === '\n') visBreak = true; k++; }
    if (k === v.length || v[k] !== tail[i] || (visBreak && !selBreak)) break;
    i++;
    j = k + 1;
  }
  return { b: j, rest: tail.slice(i) };
}

/**
 * The selection's characters with Claude Code's drawing dropped (each row's
 * leading decoration, table borders), whitespace aside: what a copy must
 * carry, in order.
 */
function selectedContent(selection: string): string {
  let out = '';
  for (const line of selection.split('\n')) {
    for (const ch of line.replace(LINE_DECORATION, '')) {
      if (!SPACE.test(ch) && !BOX.test(ch) && ch !== '│' && ch !== '┃') out += ch;
    }
  }
  return out.normalize('NFC');
}

/** True if every character of `need` appears in `have`, in order (whitespace in `have` aside). */
function carriesAll(have: string, need: string): boolean {
  const h = have.normalize('NFC');
  let i = 0;
  for (let k = 0; k < h.length && i < need.length; k++) {
    if (h[k] === need[i]) i++;
  }
  return i === need.length;
}

/** A selection line that is Claude Code's tool output or his own prompt, never Claude's reply. */
const NOT_REPLY_LINE = /^\s*[⎿❯]/u;

function wordCount(selection: string): number {
  return selection.split(/\s+/).filter((w) => KEEP.test(w)).length;
}

/**
 * Claude's original text for `selection`, searched in `messages` (the
 * session's recent assistant text blocks, Markdown as Claude wrote it).
 */
export function findOriginal(selection: string, messages: readonly string[]): MatchResult {
  const msgsSearched = messages.length;
  if (selection.split('\n').some((l) => NOT_REPLY_LINE.test(l))) return { ok: false, reason: 'not reply', msgsSearched };
  const sel = normaliseSelection(selection);
  if (sel.length < 4 || wordCount(selection) < 2) return { ok: false, reason: 'short', msgsSearched };
  const content = selectionContent(selection);
  if (!content) return { ok: false, reason: 'short', msgsSearched };
  const head = selection.slice(0, content.first);
  const tail = selection.slice(content.end);
  // Whatever the selection began with on its first row, whitespace included:
  // in code, the first line keeps its own indentation.
  const headLine = head.slice(head.lastIndexOf('\n') + 1);
  const need = selectedContent(selection);

  const found = new Map<string, OriginalCopy>();
  let inexact = 0;
  let candidates = 0;
  for (const text of messages) {
    const prepared = prepare(text);
    if (!prepared) continue;
    const { doc, norm } = prepared;
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
        // A character outside the BMP is two code units: take both.
        if (b < v.length && /[\uDC00-\uDFFF]/.test(v[b]) && /[\uD800-\uDBFF]/.test(v[b - 1])) b++;
        // Whole words: a part-selected word is completed.
        while (a > 0 && isKeep(v[a - 1])) a--;
        while (b < v.length && isKeep(v[b])) b++;
        // The symbols he selected at either edge, and the decoration left over.
        const back = extendBack(v, a, head);
        const fwd = extendForward(v, b, tail);
        a = back.a;
        b = fwd.b;
        if (!decorationOnly(back.rest) || !decorationOnly(fwd.rest)) { inexact++; p = norm.chars.indexOf(sel, p + 1); continue; }
        if (headLine !== '') {
          let s0 = a;
          while (s0 > 0 && (v[s0 - 1] === ' ' || v[s0 - 1] === '\t')) s0--;
          if (s0 === 0 || v[s0 - 1] === '\n') a = s0;
        }
      }
      const copy = { text: renderPlain(doc, a, b), html: renderHtml(doc, a, b) };
      // Never less than he selected: every character he selected is in the copy.
      if (!carriesAll(copy.text, need)) { inexact++; p = norm.chars.indexOf(sel, p + 1); continue; }
      found.set(`${copy.text}\u0000${copy.html}`, copy);
      p = norm.chars.indexOf(sel, p + 1);
    }
  }
  if (found.size === 0) return { ok: false, reason: inexact ? 'inexact' : 'not found', msgsSearched };
  if (found.size > 1) return { ok: false, reason: 'ambiguous', msgsSearched };
  const [copy] = found.values();
  return { ok: true, copy, msgsSearched };
}
