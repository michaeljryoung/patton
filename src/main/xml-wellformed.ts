/**
 * An XML 1.0 well-formedness test for the parts Patton rewrites in a .docx
 * (docs/review-tab.md R10). Electron's main process has no XML parser, and a
 * part that isn't well-formed makes Word refuse the whole file, so before his
 * file is replaced every changed part goes through this.
 *
 * It checks what a conforming parser rejects for the markup Office writes: one
 * root element; every start tag closed by the same name, properly nested;
 * attributes quoted, not repeated, with no `<` in a value; `&` only as a known
 * entity or a character reference to an allowed character; comments, CDATA,
 * processing instructions and the declaration closed; no characters XML 1.0
 * forbids; no text outside the root. A DOCTYPE is refused (Office never writes
 * one, and it is how entity expansion attacks start).
 */

const NAME_START = /[A-Za-z_:\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\uD800-\uDFFF]/;
// eslint-disable-next-line no-misleading-character-class -- XML's NameChar ranges, combining marks included
const NAME_CHAR = /[.0-9\u00B7\u0300-\u036F\u203F-\u2040A-Za-z_:\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\uD800-\uDFFF-]/;
// eslint-disable-next-line no-control-regex -- finding them is the point
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;
const PREDEFINED = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

export interface WellFormed { ok: true }
export interface NotWellFormed { ok: false; at: number; why: string }

function allowedCodePoint(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff)
    || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

/** Every `&` in `text` (from `offset`) starts a valid reference. */
function badReference(text: string): number {
  for (let i = text.indexOf('&'); i !== -1; i = text.indexOf('&', i + 1)) {
    const semi = text.indexOf(';', i);
    if (semi === -1) return i;
    const ref = text.slice(i + 1, semi);
    if (PREDEFINED.has(ref)) continue;
    let cp = NaN;
    if (/^#x[0-9a-fA-F]+$/.test(ref)) cp = parseInt(ref.slice(2), 16);
    else if (/^#[0-9]+$/.test(ref)) cp = parseInt(ref.slice(1), 10);
    if (!Number.isFinite(cp) || !allowedCodePoint(cp)) return i;
  }
  return -1;
}

function lonePairs(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = text.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return i;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return i;
  }
  return -1;
}

function readName(xml: string, i: number): number {
  if (i >= xml.length || !NAME_START.test(xml[i])) return i;
  let j = i + 1;
  while (j < xml.length && NAME_CHAR.test(xml[j])) j++;
  return j;
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

export function checkWellFormed(xml: string): WellFormed | NotWellFormed {
  const fail = (at: number, why: string): NotWellFormed => ({ ok: false, at, why });
  const forbidden = FORBIDDEN.exec(xml);
  if (forbidden) return fail(forbidden.index, 'a character XML forbids');
  const lone = lonePairs(xml);
  if (lone !== -1) return fail(lone, 'a broken surrogate pair');
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: string[] = [];
  let rootSeen = false;
  let first = true;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt === -1 ? xml.length : lt;
    if (textEnd > i) {
      const text = xml.slice(i, textEnd);
      if (stack.length === 0 && text.trim() !== '') return fail(i, 'text outside the root element');
      if (text.includes(']]>')) return fail(i + text.indexOf(']]>'), '"]]>" in text');
      const bad = badReference(text);
      if (bad !== -1) return fail(i + bad, 'a bad entity reference');
    }
    if (lt === -1) break;
    i = lt;
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      if (end === -1) return fail(i, 'an unclosed processing instruction');
      const target = xml.slice(i + 2, readName(xml, i + 2));
      if (!target) return fail(i, 'a processing instruction without a name');
      if (target.toLowerCase() === 'xml' && !(first && i === (xml.charCodeAt(0) === 0xfeff ? 1 : 0))) {
        return fail(i, 'an XML declaration not at the start');
      }
      i = end + 2;
    } else if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end === -1) return fail(i, 'an unclosed comment');
      if (xml.slice(i + 4, end).includes('--')) return fail(i, '"--" inside a comment');
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) return fail(i, 'CDATA outside the root element');
      const end = xml.indexOf(']]>', i + 9);
      if (end === -1) return fail(i, 'an unclosed CDATA section');
      i = end + 3;
    } else if (xml.startsWith('<!', i)) {
      return fail(i, 'a DOCTYPE or other declaration');
    } else if (xml[i + 1] === '/') {
      const nameEnd = readName(xml, i + 2);
      const name = xml.slice(i + 2, nameEnd);
      let j = nameEnd;
      while (isSpace(xml[j])) j++;
      if (!name || xml[j] !== '>') return fail(i, 'a malformed end tag');
      const open = stack.pop();
      if (open !== name) return fail(i, open ? `</${name}> closes <${open}>` : `</${name}> with nothing open`);
      i = j + 1;
    } else {
      const nameEnd = readName(xml, i + 1);
      const name = xml.slice(i + 1, nameEnd);
      if (!name) return fail(i, 'a "<" that starts no tag');
      if (stack.length === 0 && rootSeen) return fail(i, 'a second root element');
      let j = nameEnd;
      const seen = new Set<string>();
      for (;;) {
        const hadSpace = isSpace(xml[j]);
        while (isSpace(xml[j])) j++;
        if (xml[j] === '>' || xml.startsWith('/>', j)) break;
        if (j >= xml.length) return fail(i, `an unclosed <${name}>`);
        if (!hadSpace) return fail(j, 'no space before an attribute');
        const attrEnd = readName(xml, j);
        const attr = xml.slice(j, attrEnd);
        if (!attr) return fail(j, `a malformed attribute in <${name}>`);
        if (seen.has(attr)) return fail(j, `attribute ${attr} repeated`);
        seen.add(attr);
        j = attrEnd;
        while (isSpace(xml[j])) j++;
        if (xml[j] !== '=') return fail(j, `attribute ${attr} without a value`);
        j++;
        while (isSpace(xml[j])) j++;
        const quote = xml[j];
        if (quote !== '"' && quote !== "'") return fail(j, `attribute ${attr} not quoted`);
        const close = xml.indexOf(quote, j + 1);
        if (close === -1) return fail(j, `attribute ${attr} not closed`);
        const value = xml.slice(j + 1, close);
        if (value.includes('<')) return fail(j, `"<" in attribute ${attr}`);
        const bad = badReference(value);
        if (bad !== -1) return fail(j + 1 + bad, `a bad entity reference in attribute ${attr}`);
        j = close + 1;
      }
      rootSeen = true;
      if (xml[j] === '>') { stack.push(name); i = j + 1; } else i = j + 2;
    }
    first = false;
  }
  if (stack.length) return fail(xml.length, `<${stack[stack.length - 1]}> never closed`);
  if (!rootSeen) return fail(0, 'no root element');
  return { ok: true };
}
