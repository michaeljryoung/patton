/**
 * Word comments in a .docx (docs/review-tab.md R7). Pure: works on the zip's
 * entries (docx-zip.ts), no fs, no Electron, so
 * scripts/check-review-comments.mjs drives it headlessly and LibreOffice
 * re-opens what it writes.
 *
 * Anchoring: the review tab shows LibreOffice's PDF of the file, so what he
 * selects is PDF text. It is matched to the document's own text with all
 * whitespace removed and both sides NFKC-normalised (ligatures, wide forms),
 * soft hyphens and zero-width characters dropped. `occurrence` says which match
 * he chose: the renderer counts the matches of the same key in the PDF's text
 * before his selection. Headers, footers and margin comments appear in the
 * PDF but not in the body, so a count past the body's last match takes the
 * last one, never fails.
 *
 * Writing: the run holding the first selected character and the one holding
 * the last are split where the selection starts and ends (each half keeps the
 * run's own properties), and `w:commentRangeStart`, `w:commentRangeEnd` and a
 * `w:commentReference` run go between the halves. The comment goes in
 * `word/comments.xml`, created with its relationship and content type when the
 * file has none. Nothing here reads or writes markup it did not find: other
 * parts stay byte for byte (docx-zip.ts).
 */
import { entryText, setEntryText, type ZipEntry } from './docx-zip';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const COMMENTS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const COMMENTS_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const OFFICE_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

/** One `<w:t>` element of the body, with where its text sits in the XML. */
interface TextSpan {
  /** Index of `<w:t…>` in the XML, and the open tag's length. */
  tagStart: number;
  tagLen: number;
  /** The text content's start and end in the XML. */
  contentStart: number;
  contentEnd: number;
  /** The run's open tag (`<w:r …>`) and properties (`<w:rPr>…</w:rPr>` or ''). */
  runOpen: string;
  runProps: string;
}

/** One matchable character of the body: which span, and the XML offset (in
 *  the span's content) where the source character starts and ends. */
interface KeyChar {
  span: number;
  from: number;
  to: number;
}

export interface BodyText {
  spans: TextSpan[];
  /** The matching key: body text, whitespace removed, normalised. */
  key: string;
  /** key[i] came from keyChars[i]. */
  keyChars: KeyChar[];
}

const DROP = /[\s\u00ad\u200b-\u200f\u2060\ufeff]/u;

/** Normalise one source character into its key characters ('' to drop). */
export function keyOf(ch: string): string {
  if (DROP.test(ch)) return '';
  return ch.normalize('NFKC').replace(/[\s\u00ad\u200b-\u200f\u2060\ufeff]/gu, '');
}

/** The key of any text (the PDF side uses the same rule). */
export function textKey(text: string): string {
  let out = '';
  for (const ch of text) out += keyOf(ch);
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntity(ent: string): string {
  if (ent.startsWith('#x') || ent.startsWith('#X')) return String.fromCodePoint(parseInt(ent.slice(2), 16) || 0xfffd);
  if (ent.startsWith('#')) return String.fromCodePoint(parseInt(ent.slice(1), 10) || 0xfffd);
  return ENTITIES[ent] ?? '';
}

const TAG = /<(\/?)([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/** Every body `<w:t>` in document order, and the key built from them. Text
 *  in `mc:Fallback` (a second copy of a text box) is skipped. */
export function bodyText(xml: string): BodyText {
  const spans: TextSpan[] = [];
  const keyChars: KeyChar[] = [];
  let key = '';
  let fallbackDepth = 0;
  let runOpen: string | null = null;
  let runProps = '';
  let runStart = -1;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(xml); m; m = TAG.exec(xml)) {
    const closing = m[1] === '/';
    const prefix = m[2] ?? '';
    const local = m[3];
    const selfClosing = m[5] === '/';
    if (prefix === 'mc:' && local === 'Fallback') {
      if (!closing && !selfClosing) fallbackDepth++;
      else if (closing) fallbackDepth = Math.max(0, fallbackDepth - 1);
      continue;
    }
    if (prefix !== 'w:') continue;
    if (local === 'r') {
      if (closing) { runOpen = null; runProps = ''; }
      else if (!selfClosing) { runOpen = m[0]; runProps = ''; runStart = m.index; }
      continue;
    }
    if (local === 'rPr' && !closing && !selfClosing && runOpen !== null && runProps === '') {
      // Only the run's own properties: the first rPr right inside the run.
      if (xml.slice(runStart + runOpen.length, m.index).trim() === '') {
        const end = xml.indexOf('</w:rPr>', m.index);
        if (end !== -1) runProps = xml.slice(m.index, end + '</w:rPr>'.length);
      }
      continue;
    }
    if (local === 't' && !closing && !selfClosing && runOpen !== null && fallbackDepth === 0) {
      const contentStart = m.index + m[0].length;
      const contentEnd = xml.indexOf('</w:t>', contentStart);
      if (contentEnd === -1) break;
      const spanIndex = spans.length;
      spans.push({ tagStart: m.index, tagLen: m[0].length, contentStart, contentEnd, runOpen, runProps });
      let i = contentStart;
      while (i < contentEnd) {
        let ch: string;
        let next: number;
        if (xml[i] === '&') {
          const semi = xml.indexOf(';', i);
          if (semi === -1 || semi > contentEnd) { ch = '&'; next = i + 1; } else { ch = decodeEntity(xml.slice(i + 1, semi)); next = semi + 1; }
        } else {
          const cp = xml.codePointAt(i) ?? 0;
          ch = String.fromCodePoint(cp);
          next = i + ch.length;
        }
        for (const k of keyOf(ch)) {
          key += k;
          keyChars.push({ span: spanIndex, from: i - contentStart, to: next - contentStart });
        }
        i = next;
      }
      TAG.lastIndex = contentEnd;
    }
  }
  return { spans, key, keyChars };
}

/** Start indexes of every match of `needle` in `hay` (overlapping). */
export function matchesOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

export function escapeXml(text: string): string {
  return text
    // Characters XML 1.0 forbids (Word refuses the file with them).
    // eslint-disable-next-line no-control-regex -- removing them is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, ent: string) => decodeEntity(ent));
}

/** The main document part's name (from `_rels/.rels`, else word/document.xml). */
export function documentPartName(entries: ZipEntry[]): string {
  const rels = entryText(entries, '_rels/.rels') ?? '';
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!m[0].includes(`"${OFFICE_DOC_REL}"`)) continue;
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (target) return target.replace(/^\//, '');
  }
  return 'word/document.xml';
}

function relsNameFor(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

function dirOf(part: string): string {
  return part.slice(0, part.lastIndexOf('/') + 1);
}

/** The comments part named by the document's relationships, if any. */
function commentsPartName(entries: ZipEntry[], docPart: string): string | null {
  const rels = entryText(entries, relsNameFor(docPart)) ?? '';
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!m[0].includes(`"${COMMENTS_REL}"`)) continue;
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (!target) continue;
    return target.startsWith('/') ? target.slice(1) : dirOf(docPart) + target;
  }
  return null;
}

export interface DocComment {
  id: string;
  author: string;
  date: string;
  text: string;
  /** The text the comment is anchored on, '' when the file doesn't say. */
  quote: string;
}

/** The text of a run of XML: its `<w:t>` contents, paragraphs on new lines. */
function plainText(xml: string): string {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:p>|<w:tab\/>|<w:br\/>/g;
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else if (m[0] === '</w:p>') out += '\n';
    else out += m[0] === '<w:tab/>' ? '\t' : '\n';
  }
  return out.trim();
}

/** Every comment in the file, with the text it is anchored on. */
export function listComments(entries: ZipEntry[]): DocComment[] {
  const docPart = documentPartName(entries);
  const part = commentsPartName(entries, docPart);
  if (!part) return [];
  const xml = entryText(entries, part);
  if (!xml) return [];
  const doc = entryText(entries, docPart) ?? '';
  const out: DocComment[] = [];
  for (const m of xml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const attr = (name: string): string => unescapeXml(new RegExp(`w:${name}="([^"]*)"`).exec(m[1])?.[1] ?? '');
    const id = attr('id');
    let quote = '';
    const start = doc.search(new RegExp(`<w:commentRangeStart\\b[^>]*w:id="${id.replace(/[^0-9A-Za-z-]/g, '')}"`));
    if (start !== -1) {
      const end = doc.slice(start).search(new RegExp(`<w:commentRangeEnd\\b[^>]*w:id="${id.replace(/[^0-9A-Za-z-]/g, '')}"`));
      if (end !== -1) quote = plainText(doc.slice(start, start + end)).replace(/\s+/g, ' ');
    }
    out.push({ id, author: attr('author'), date: attr('date'), text: plainText(m[2]), quote });
  }
  return out;
}

export interface NewComment {
  /** The selected text, as the PDF gave it. */
  quote: string;
  /** Which match of the quote (0-based), counted in the PDF's text. */
  occurrence: number;
  text: string;
  author: string;
  initials: string;
  date: Date;
}

export type AddCommentResult =
  | { ok: true; id: string; matched: 'exact' | 'last' }
  | { ok: false; reason: 'empty-quote' | 'empty-text' | 'not-found' | 'no-document' };

interface Edit { pos: number; del: number; insert: string }

function applyEdits(xml: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.pos - a.pos);
  let out = xml;
  for (const e of sorted) out = out.slice(0, e.pos) + e.insert + out.slice(e.pos + e.del);
  return out;
}

function nextCommentId(docXml: string, commentsXml: string): number {
  let max = -1;
  for (const xml of [docXml, commentsXml]) {
    for (const m of xml.matchAll(/<w:(?:comment|commentRangeStart|commentRangeEnd|commentReference)\b[^>]*\bw:id="(\d+)"/g)) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

function commentXml(id: number, c: NewComment): string {
  const paras = c.text.split(/\r?\n/).map((line) =>
    `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join('');
  const date = c.date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<w:comment w:id="${id}" w:author="${escapeXml(c.author)}" w:date="${date}" w:initials="${escapeXml(c.initials)}">${paras}</w:comment>`;
}

/** Add one comment on the quoted text. Changes `entries` in place only on success. */
export function addComment(entries: ZipEntry[], c: NewComment): AddCommentResult {
  const quoteKey = textKey(c.quote);
  if (!quoteKey) return { ok: false, reason: 'empty-quote' };
  if (!c.text.trim()) return { ok: false, reason: 'empty-text' };
  const docPart = documentPartName(entries);
  const docXml = entryText(entries, docPart);
  if (docXml === null) return { ok: false, reason: 'no-document' };
  const body = bodyText(docXml);
  const matches = matchesOf(body.key, quoteKey);
  if (matches.length === 0) return { ok: false, reason: 'not-found' };
  const want = Math.max(0, Math.floor(c.occurrence));
  const matched = want < matches.length ? 'exact' : 'last';
  const at = matches[Math.min(want, matches.length - 1)];
  const first = body.keyChars[at];
  const last = body.keyChars[at + quoteKey.length - 1];

  let commentsPart = commentsPartName(entries, docPart);
  const commentsXmlBefore = commentsPart ? entryText(entries, commentsPart) ?? '' : '';
  const id = nextCommentId(docXml, commentsXmlBefore);

  // Split a run at a content offset, putting `between` between its halves.
  const edits: Edit[] = [];
  const preserved = new Set<number>();
  const split = (spanIndex: number, offset: number, between: string): void => {
    const span = body.spans[spanIndex];
    if (!preserved.has(spanIndex)) {
      // Both halves may end or start with a space: keep it.
      edits.push({ pos: span.tagStart, del: span.tagLen, insert: '<w:t xml:space="preserve">' });
      preserved.add(spanIndex);
    }
    edits.push({
      pos: span.contentStart + offset,
      del: 0,
      insert: `</w:t></w:r>${between}${span.runOpen}${span.runProps}<w:t xml:space="preserve">`,
    });
  };
  split(first.span, first.from, `<w:commentRangeStart w:id="${id}"/>`);
  split(last.span, last.to,
    `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`);
  setEntryText(entries, docPart, applyEdits(docXml, edits));

  if (commentsPart && commentsXmlBefore) {
    const close = commentsXmlBefore.lastIndexOf('</w:comments>');
    const xml = close === -1
      ? commentsXmlBefore.replace(/<w:comments\b([^>]*)\/>/, `<w:comments$1>${commentXml(id, c)}</w:comments>`)
      : commentsXmlBefore.slice(0, close) + commentXml(id, c) + commentsXmlBefore.slice(close);
    setEntryText(entries, commentsPart, xml);
  } else {
    commentsPart = commentsPart ?? `${dirOf(docPart)}comments.xml`;
    setEntryText(entries, commentsPart,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W_NS}">${commentXml(id, c)}</w:comments>`);
    const relsName = relsNameFor(docPart);
    const rels = entryText(entries, relsName)
      ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    if (!rels.includes(`"${COMMENTS_REL}"`)) {
      const ids = new Set([...rels.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]));
      let n = 1;
      while (ids.has(`rId${n}`)) n++;
      const target = commentsPart.slice(dirOf(docPart).length);
      const rel = `<Relationship Id="rId${n}" Type="${COMMENTS_REL}" Target="${escapeXml(target)}"/>`;
      setEntryText(entries, relsName, rels.replace('</Relationships>', `${rel}</Relationships>`));
    }
  }
  const types = entryText(entries, '[Content_Types].xml');
  if (types !== null && !types.includes(`PartName="/${commentsPart}"`)) {
    setEntryText(entries, '[Content_Types].xml',
      types.replace('</Types>', `<Override PartName="/${escapeXml(commentsPart)}" ContentType="${COMMENTS_TYPE}"/></Types>`));
  }
  return { ok: true, id: String(id), matched };
}

/** Initials of a name, for `w:initials` ("Michael Young" → "MY"). */
export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => [...w][0]?.toUpperCase() ?? '').join('').slice(0, 4);
}
