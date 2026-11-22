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
import { keyOf, matchesOf, textKey } from '../shared/review-text';
import { entryText, setEntryText, type ZipEntry } from './docx-zip';

export { keyOf, matchesOf, textKey };

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const COMMENTS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
/** Strict OOXML (ISO 29500 strict) names the same relationships under purl.oclc.org. */
const STRICT_REL_BASE = 'http://purl.oclc.org/ooxml/officeDocument/relationships/';
const STRICT_COMMENTS_REL = `${STRICT_REL_BASE}comments`;
const COMMENTS_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const OFFICE_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const STRICT_OFFICE_DOC_REL = `${STRICT_REL_BASE}officeDocument`;

/** One `<w:t>` or `<w:delText>` element of the body, with where its text sits in the XML. */
interface TextSpan {
  /** Index of `<w:t…>` in the XML, and the open tag's length. */
  tagStart: number;
  tagLen: number;
  /** `t`, or `delText` for text inside a tracked deletion. */
  tag: 't' | 'delText';
  /** The text content's start and end in the XML. */
  contentStart: number;
  contentEnd: number;
  /** The run's open tag (`<w:r …>`) and properties (`<w:rPr>…</w:rPr>`, with
   *  any nested `w:rPrChange`, or ''). */
  runOpen: string;
  runProps: string;
  /** Where the outermost tracked deletion or move holding the run ends (just
   *  past its end tag), -1 when the run is in none. A comment's reference run
   *  goes there, never inside it: accepting the deletion would delete the
   *  comment with it. */
  deletionEnd: number;
  /** Index of the text box (`w:txbxContent`) holding it, -1 in the body. */
  story: number;
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntity(ent: string): string {
  if (ent.startsWith('#x') || ent.startsWith('#X')) return String.fromCodePoint(parseInt(ent.slice(2), 16) || 0xfffd);
  if (ent.startsWith('#')) return String.fromCodePoint(parseInt(ent.slice(1), 10) || 0xfffd);
  return ENTITIES[ent] ?? '';
}

const TAG = /<(\/?)([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const TAG_INNER = new RegExp(TAG.source, 'g');

/** End (just past `</w:rPr>`) of the rPr opening at `at`, counting the rPr
 *  nested in `w:rPrChange` (a tracked formatting change); -1 if never closed. */
function rPrEnd(xml: string, at: number): number {
  let depth = 0;
  TAG_INNER.lastIndex = at;
  for (let m = TAG_INNER.exec(xml); m; m = TAG_INNER.exec(xml)) {
    if (m[2] !== 'w:' || m[3] !== 'rPr' || m[5] === '/') continue;
    if (m[1] === '/') {
      depth--;
      if (depth === 0) return m.index + m[0].length;
    } else depth++;
  }
  return -1;
}

interface OpenRun { open: string; props: string; start: number; sawProps: boolean }

/** Every body `<w:t>` and `<w:delText>` in document order, and the key built
 *  from them. Deleted text is in the key because LibreOffice's PDF shows a
 *  tracked deletion (struck through), so he can select across one. Text in
 *  `mc:Fallback` (a second copy of a text box) is skipped. Runs nest (a text
 *  box sits in a drawing inside a run), so they are kept on a stack. */
export function bodyText(xml: string): BodyText {
  const spans: TextSpan[] = [];
  const keyChars: KeyChar[] = [];
  let key = '';
  let fallbackDepth = 0;
  const runs: OpenRun[] = [];
  /** Spans waiting for the end of the outermost deletion or move they sit in. */
  const deletion: { depth: number; spans: number[] } = { depth: 0, spans: [] };
  const stories: number[] = [];
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
      if (closing) runs.pop();
      else if (!selfClosing) runs.push({ open: m[0], props: '', start: m.index, sawProps: false });
      continue;
    }
    if (local === 'del' || local === 'moveFrom') {
      if (selfClosing) continue;
      if (!closing) { deletion.depth++; continue; }
      deletion.depth = Math.max(0, deletion.depth - 1);
      if (deletion.depth === 0) {
        for (const i of deletion.spans) spans[i].deletionEnd = m.index + m[0].length;
        deletion.spans = [];
      }
      continue;
    }
    if (local === 'txbxContent') {
      if (selfClosing) continue;
      if (closing) stories.pop(); else stories.push(m.index);
      continue;
    }
    const run = runs[runs.length - 1];
    if (local === 'rPr' && !closing && run && !run.sawProps) {
      run.sawProps = true;
      // Only the run's own properties: the rPr right inside the run, whole.
      if (xml.slice(run.start + run.open.length, m.index).trim() === '') {
        if (selfClosing) run.props = m[0];
        else {
          const end = rPrEnd(xml, m.index);
          if (end !== -1) { run.props = xml.slice(m.index, end); TAG.lastIndex = end; }
        }
      }
      continue;
    }
    if ((local === 't' || local === 'delText') && !closing && !selfClosing && run && fallbackDepth === 0) {
      const contentStart = m.index + m[0].length;
      const contentEnd = xml.indexOf(`</w:${local}>`, contentStart);
      if (contentEnd === -1) break;
      const spanIndex = spans.length;
      spans.push({
        tagStart: m.index, tagLen: m[0].length, tag: local, contentStart, contentEnd,
        runOpen: run.open, runProps: run.props, deletionEnd: -1, story: stories.length ? stories[stories.length - 1] : -1,
      });
      if (deletion.depth > 0) deletion.spans.push(spanIndex);
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

function relTarget(rel: string): string | null {
  const t = /\bTarget="([^"]+)"/.exec(rel)?.[1];
  return t === undefined ? null : unescapeXml(t);
}

function relIsOf(rel: string, types: string[]): boolean {
  const type = /\bType="([^"]+)"/.exec(rel)?.[1];
  return type !== undefined && types.includes(type);
}

/** A relationship target as a part name in the zip: relative to `baseDir`
 *  unless it starts with `/`, `.` and `..` resolved, %-escapes decoded. Null
 *  for an external target or one that climbs out of the package. */
export function resolvePart(baseDir: string, target: string): string | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(target.split('#')[0]); } catch { return null; }
  const joined = decoded.startsWith('/') ? decoded.slice(1) : baseDir + decoded;
  const out: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

/** The main document part's name (from `_rels/.rels`, else word/document.xml). */
export function documentPartName(entries: ZipEntry[]): string {
  const rels = entryText(entries, '_rels/.rels') ?? '';
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!relIsOf(m[0], [OFFICE_DOC_REL, STRICT_OFFICE_DOC_REL])) continue;
    const target = relTarget(m[0]);
    const part = target === null ? null : resolvePart('', target);
    if (part) return part;
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

/** The comments part named by the document's relationships (transitional or
 *  strict): its name, 'none' when there is no such relationship, or 'odd' when
 *  there is one Patton can't follow (external, or climbing out of the zip). */
function commentsPartName(entries: ZipEntry[], docPart: string): string | 'none' | 'odd' {
  const rels = entryText(entries, relsNameFor(docPart)) ?? '';
  let found: string | 'none' | 'odd' = 'none';
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!relIsOf(m[0], [COMMENTS_REL, STRICT_COMMENTS_REL])) continue;
    if (/\bTargetMode="External"/.test(m[0])) { found = 'odd'; continue; }
    const target = relTarget(m[0]);
    const part = target === null ? null : resolvePart(dirOf(docPart), target);
    if (part) return part;
    found = 'odd';
  }
  return found;
}

export interface DocComment {
  id: string;
  author: string;
  date: string;
  text: string;
  /** The text the comment is anchored on, '' when the file doesn't say. */
  quote: string;
  /** Which match of the quote's key in the body (0-based) it is anchored on:
   *  the renderer highlights the same match in the PDF's text (R7). */
  occurrence: number;
}

/** The text of a run of XML: its `<w:t>` contents, paragraphs on new lines. */
function plainText(xml: string): string {
  let out = '';
  const re = /<w:(?:t|delText)(?:\s[^>]*)?>([^<]*)<\/w:(?:t|delText)>|<\/w:p>|<w:tab\/>|<w:br\/>/g;
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
  if (part === 'none' || part === 'odd') return [];
  const xml = entryText(entries, part);
  if (!xml) return [];
  const doc = entryText(entries, docPart) ?? '';
  let body: BodyText | null = null;
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
    let occurrence = 0;
    const quoteKey = textKey(quote);
    if (quoteKey && start !== -1) {
      body ??= bodyText(doc);
      const b = body;
      // The first match whose first character sits after the range's start.
      const matches = matchesOf(b.key, quoteKey);
      const at = matches.findIndex((i) => b.spans[b.keyChars[i].span].contentStart + b.keyChars[i].from >= start);
      occurrence = at === -1 ? Math.max(0, matches.length - 1) : at;
    }
    out.push({ id, author: attr('author'), date: attr('date'), text: plainText(m[2]), quote, occurrence });
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
  | { ok: false; reason: 'empty-quote' | 'empty-text' | 'not-found' | 'no-document' | 'crosses-box' | 'odd-comments' };

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
  // A range must start and end in the same story: one end in a text box and
  // the other in the body is a range Word can't hold.
  if (body.spans[first.span].story !== body.spans[last.span].story) return { ok: false, reason: 'crosses-box' };

  const found = commentsPartName(entries, docPart);
  if (found === 'odd') return { ok: false, reason: 'odd-comments' };
  let commentsPart = found === 'none' ? null : found;
  const commentsXmlBefore = commentsPart ? entryText(entries, commentsPart) ?? '' : '';
  const id = nextCommentId(docXml, commentsXmlBefore);

  // Split a run at a content offset, putting `between` between its halves.
  const edits: Edit[] = [];
  const preserved = new Set<number>();
  const split = (spanIndex: number, offset: number, between: string): void => {
    const span = body.spans[spanIndex];
    if (!preserved.has(spanIndex)) {
      // Both halves may end or start with a space: keep it.
      edits.push({ pos: span.tagStart, del: span.tagLen, insert: `<w:${span.tag} xml:space="preserve">` });
      preserved.add(spanIndex);
    }
    edits.push({
      pos: span.contentStart + offset,
      del: 0,
      insert: `</w:${span.tag}></w:r>${between}${span.runOpen}${span.runProps}<w:${span.tag} xml:space="preserve">`,
    });
  };
  const reference = `<w:r><w:commentReference w:id="${id}"/></w:r>`;
  split(first.span, first.from, `<w:commentRangeStart w:id="${id}"/>`);
  const lastSpan = body.spans[last.span];
  if (lastSpan.deletionEnd === -1) {
    split(last.span, last.to, `<w:commentRangeEnd w:id="${id}"/>${reference}`);
  } else {
    // The range may end inside a tracked deletion; its reference run goes
    // just after the deletion, so accepting the deletion keeps the comment.
    split(last.span, last.to, `<w:commentRangeEnd w:id="${id}"/>`);
    edits.push({ pos: lastSpan.deletionEnd, del: 0, insert: reference });
  }
  setEntryText(entries, docPart, applyEdits(docXml, edits));

  // The document's own WordprocessingML namespace (strict files use purl.oclc.org's).
  const wNs = /<w:document\b[^>]*\bxmlns:w="([^"]+)"/.exec(docXml)?.[1] ?? W_NS;
  const strict = wNs.startsWith('http://purl.oclc.org/');
  if (commentsPart && commentsXmlBefore) {
    const close = commentsXmlBefore.lastIndexOf('</w:comments>');
    const xml = close === -1
      ? commentsXmlBefore.replace(/<w:comments\b([^>]*)\/>/, `<w:comments$1>${commentXml(id, c)}</w:comments>`)
      : commentsXmlBefore.slice(0, close) + commentXml(id, c) + commentsXmlBefore.slice(close);
    setEntryText(entries, commentsPart, xml);
  } else {
    // No comments part, or a relationship naming one that isn't there: make
    // it, at the name the relationship gives when there is one.
    const hadRel = commentsPart !== null;
    commentsPart = commentsPart ?? `${dirOf(docPart)}comments.xml`;
    setEntryText(entries, commentsPart,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${escapeXml(wNs)}">${commentXml(id, c)}</w:comments>`);
    if (!hadRel) {
      const relsName = relsNameFor(docPart);
      const rels = entryText(entries, relsName)
        ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      const ids = new Set([...rels.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]));
      let n = 1;
      while (ids.has(`rId${n}`)) n++;
      const target = commentsPart.slice(dirOf(docPart).length);
      const rel = `<Relationship Id="rId${n}" Type="${strict ? STRICT_COMMENTS_REL : COMMENTS_REL}" Target="${escapeXml(target)}"/>`;
      const closed = rels.includes('</Relationships>')
        ? rels.replace('</Relationships>', `${rel}</Relationships>`)
        : rels.replace(/<Relationships\b([^>]*)\/>/, `<Relationships$1>${rel}</Relationships>`);
      setEntryText(entries, relsName, closed);
    }
  }
  const types = entryText(entries, '[Content_Types].xml');
  if (types !== null && !types.toLowerCase().includes(`partname="/${commentsPart.toLowerCase()}"`)) {
    setEntryText(entries, '[Content_Types].xml',
      types.replace('</Types>', `<Override PartName="/${escapeXml(commentsPart)}" ContentType="${COMMENTS_TYPE}"/></Types>`));
  }
  return { ok: true, id: String(id), matched };
}

/** Initials of a name, for `w:initials` ("Michael Young" → "MY"). */
export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => [...w][0]?.toUpperCase() ?? '').join('').slice(0, 4);
}
