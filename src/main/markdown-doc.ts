/**
 * A small Markdown reader for copying Claude's replies out of a terminal
 * (`copy-match.ts`). Pure: no Electron, no Node APIs.
 *
 * It parses the subset Claude writes (paragraphs, ATX headings, fenced code,
 * block quotes, bullet and numbered lists, pipe tables, rules; bold, italic,
 * inline code, links and autolinks) into blocks whose inline runs carry their
 * offset in the *visible text*: the characters Claude Code draws for the reply.
 * Read from a pty capture of Claude Code 2.1.x (scripts/fixtures/
 * copy-original-screens.json): marks (`**`, `*`, `_`, backticks, `#`, `>`,
 * fences) are not drawn; a link shows its label only (the URL rides in an OSC 8
 * hyperlink); a bare URL shows as itself; list bullets are drawn `- ` and
 * numbered items are renumbered from the first; a soft line break stays a line
 * break; raw HTML such as `<script>` shows literally.
 *
 * `renderPlain` and `renderHtml` render a span of that visible text back out.
 * The HTML is built from escaped text only: no raw HTML passes through, and a
 * link keeps its href only for http, https and mailto.
 */

export interface Run {
  text: string;
  /** Offset of `text` in the visible text. */
  at: number;
  strong?: boolean;
  em?: boolean;
  code?: boolean;
  href?: string;
  /** A line break inside a paragraph (`text` is "\n"). */
  br?: boolean;
}

interface Span { from: number; to: number }

export type Block =
  | ({ t: 'para'; runs: Run[] } & Span)
  | ({ t: 'heading'; level: number; runs: Run[] } & Span)
  | ({ t: 'code'; runs: Run[] } & Span)
  | ({ t: 'hr' } & Span)
  | ({ t: 'quote'; children: Block[] } & Span)
  | ({ t: 'list'; ordered: boolean; start: number; loose: boolean; items: ListItem[] } & Span)
  | ({ t: 'table'; rows: TableRow[] } & Span);

export interface ListItem extends Span { children: Block[] }
export interface TableRow extends Span { cells: Run[][] }

export interface MarkdownDoc {
  blocks: Block[];
  /** What Claude Code draws, give or take wrapping and decoration. */
  visible: string;
}

type Marks = Pick<Run, 'strong' | 'em' | 'code' | 'href'>;

class Emitter {
  private parts: string[] = [];
  len = 0;
  /** Each leaf block starts on its own line, so words never join across blocks. */
  newLine(): void {
    if (this.len > 0 && !this.endsWithBreak()) this.push('\n');
  }
  push(s: string): void {
    this.parts.push(s);
    this.len += s.length;
  }
  run(text: string, marks: Marks, br = false): Run {
    const r: Run = { text, at: this.len };
    if (marks.strong) r.strong = true;
    if (marks.em) r.em = true;
    if (marks.code) r.code = true;
    if (marks.href !== undefined) r.href = marks.href;
    if (br) r.br = true;
    this.push(text);
    return r;
  }
  private endsWithBreak(): boolean {
    const last = this.parts[this.parts.length - 1];
    return last !== undefined && (last.endsWith('\n') || last.endsWith('\t'));
  }
  text(): string {
    return this.parts.join('');
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_OPEN = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])(?:([ \t]+)(.*))?$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const PUNCT = /[!-/:-@[-`{-~]/;

/**
 * An ATX heading: its level and text, or null. By hand, not one regex: a
 * lazy text before optional closing `#`s backtracks quadratically on a long
 * run of spaces.
 */
function parseHeading(line: string): { level: number; text: string } | null {
  const m = HEADING_OPEN.exec(line);
  if (!m) return null;
  let text = line.slice(m[0].length).trim();
  let k = text.length;
  while (k > 0 && text[k - 1] === '#') k--;
  if (k < text.length && (k === 0 || text[k - 1] === ' ' || text[k - 1] === '\t')) text = text.slice(0, k).trim();
  return { level: m[1].length, text };
}

/** How deep quotes and lists nest, and inline marks inside marks, before the rest reads as plain text. */
const MAX_DEPTH = 32;
/** How far a link's `[label](href)` is looked for: past it, `[` is a character. */
const MAX_LINK_SCAN = 2000;

function blank(line: string): boolean {
  return line.trim() === '';
}

function leadingSpaces(line: string): number {
  let n = 0;
  for (const c of line) {
    if (c === ' ') n++;
    else if (c === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}

/** Drops `n` columns of leading indentation (tabs count to the next stop of 4). */
function dropIndent(line: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    if (line[i] === ' ') col++;
    else if (line[i] === '\t') col += 4 - (col % 4);
    else break;
    i++;
  }
  return line.slice(i);
}

function isTableStart(lines: string[], i: number): boolean {
  const next = lines[i + 1];
  return next !== undefined && lines[i].includes('|') && TABLE_SEP.test(next) && (next.includes('|') || lines[i].trim().startsWith('|'));
}

function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i];
  if (FENCE.test(l) || HEADING_OPEN.test(l) || HR.test(l) || QUOTE.test(l)) return true;
  const m = ITEM.exec(l);
  if (m && m[5] !== undefined && m[5].trim() !== '') return true;
  return isTableStart(lines, i);
}

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** Index just past a closing backtick run of exactly `n`, from `from`; -1 if none. */
function findBacktickClose(s: string, from: number, n: number): number {
  let i = from;
  while (i < s.length) {
    if (s[i] !== '`') { i++; continue; }
    let j = i;
    while (j < s.length && s[j] === '`') j++;
    if (j - i === n) return i;
    i = j;
  }
  return -1;
}

function runLength(s: string, i: number, c: string): number {
  let j = i;
  while (j < s.length && s[j] === c) j++;
  return j - i;
}

const ALNUM = /[\p{L}\p{N}]/u;

/**
 * Where a scan for a closing run found none: a key of the mark and its
 * length, the earliest start from which the scan reached the string's end.
 * A later opener of the same kind would find none either, so it is not
 * scanned again: without this, a reply of unmatched `*a *a *a` is quadratic.
 */
type NoClose = Map<string, number>;

/** A closing delimiter run of exactly `n` of `c` for an opener at `i`, or -1. */
function findEmphasisClose(s: string, i: number, c: string, n: number, noClose: NoClose): number {
  const after = s[i + n];
  if (after === undefined || /\s/.test(after)) return -1;
  if (c === '_' && i > 0 && ALNUM.test(s[i - 1])) return -1;
  const key = c + n;
  const failedFrom = noClose.get(key);
  if (failedFrom !== undefined && i + n >= failedFrom) return -1;
  let j = i + n;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') {
      const k = runLength(s, j, '`');
      const close = findBacktickClose(s, j + k, k);
      j = close >= 0 ? close + k : j + k;
      continue;
    }
    if (ch !== c) { j++; continue; }
    const k = runLength(s, j, c);
    const before = s[j - 1];
    const next = s[j + k];
    const closes = k === n && j > i + n && !/\s/.test(before) && !(c === '_' && next !== undefined && ALNUM.test(next));
    if (closes) return j;
    j += k;
  }
  noClose.set(key, Math.min(failedFrom ?? Infinity, i + n));
  return -1;
}

/** `[label](href)` at `i`: the label, the href and the index past it. */
function parseLink(s: string, i: number, last: { bracket: number; paren: number }): { label: string; href: string; end: number } | null {
  // No `]` or `)` left: no link, and no scan (a reply of unmatched `[a` would be quadratic).
  if (last.bracket < i || last.paren < i) return null;
  let depth = 0;
  let j = i;
  const stop = Math.min(s.length, i + MAX_LINK_SCAN);
  for (; j < stop; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) break; }
  }
  if (j >= stop || s[j + 1] !== '(') return null;
  const label = s.slice(i + 1, j);
  let k = j + 2;
  let parens = 1;
  const hrefStop = Math.min(s.length, k + MAX_LINK_SCAN);
  for (; k < hrefStop; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (c === '(') parens++;
    else if (c === ')') { parens--; if (parens === 0) break; }
    else if (c === '\n') return null;
  }
  if (k >= hrefStop || label.trim() === '') return null;
  let href = s.slice(j + 2, k).trim();
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*')$/.exec(href);
  if (titled) href = titled[1];
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
  return { label, href, end: k + 1 };
}

const AUTOLINK = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i;

function parseInline(s: string, marks: Marks, out: Emitter, runs: Run[], depth = 0): void {
  if (depth > MAX_DEPTH) { if (s) runs.push(out.run(s.replace(/\n/g, ' '), marks)); return; }
  const noClose: NoClose = new Map();
  const last = { bracket: s.lastIndexOf(']'), paren: s.lastIndexOf(')') };
  let buf = '';
  const flush = (): void => {
    if (buf) { runs.push(out.run(buf, marks)); buf = ''; }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '\n') { flush(); runs.push(out.run('\n', marks, true)); i++; continue; }
    if (c === '`') {
      const n = runLength(s, i, '`');
      const close = findBacktickClose(s, i + n, n);
      if (close < 0) { buf += s.slice(i, i + n); i += n; continue; }
      flush();
      let code = s.slice(i + n, close).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
      if (code) runs.push(out.run(code, { ...marks, code: true }));
      i = close + n;
      continue;
    }
    if (c === '[' && !marks.code) {
      const link = parseLink(s, i, last);
      if (link) {
        flush();
        parseInline(link.label, { ...marks, href: link.href }, out, runs, depth + 1);
        i = link.end;
        continue;
      }
    }
    if (c === '<') {
      const m = AUTOLINK.exec(s.slice(i));
      if (m) {
        flush();
        runs.push(out.run(m[1], { ...marks, href: m[1] }));
        i += m[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const len = runLength(s, i, c);
      const n = Math.min(len, 3);
      const close = len <= 3 ? findEmphasisClose(s, i, c, n, noClose) : -1;
      if (close < 0) { buf += s.slice(i, i + len); i += len; continue; }
      flush();
      parseInline(s.slice(i + n, close), {
        ...marks,
        strong: marks.strong || n >= 2,
        em: marks.em || n !== 2,
      }, out, runs, depth + 1);
      i = close + n;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
}

function spanOf<T extends object>(from: number, to: number, b: T): T & Span {
  return { ...b, from, to };
}

function inlineBlock(text: string, out: Emitter): { runs: Run[]; from: number; to: number } {
  out.newLine();
  const from = out.len;
  const runs: Run[] = [];
  parseInline(text, {}, out, runs);
  return { runs, from, to: out.len };
}

/** `probe`: only the top-level blocks are wanted (parseProbe), so nothing nested is parsed. */
function parseBlocks(lines: string[], out: Emitter, depth = 0, probe = false): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const body: string[] = [];
      i++;
      while (i < n) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
        if (close && close[1][0] === mark[0] && close[1].length >= mark.length) { i++; break; }
        body.push(lines[i]);
        i++;
      }
      out.newLine();
      const from = out.len;
      const runs = body.length ? [out.run(body.join('\n'), { code: true })] : [];
      blocks.push(spanOf(from, out.len, { t: 'code' as const, runs }));
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      const b = inlineBlock(heading.text, out);
      blocks.push({ t: 'heading', level: heading.level, ...b });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push(spanOf(out.len, out.len, { t: 'hr' as const }));
      i++;
      continue;
    }

    if (depth < MAX_DEPTH && QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < n) {
        const m = QUOTE.exec(lines[i]);
        if (m) { inner.push(m[1]); i++; continue; }
        const lazy = !blank(lines[i]) && inner.length > 0 && !blank(inner[inner.length - 1]) && !startsBlock(lines, i);
        if (!lazy) break;
        inner.push(lines[i].trim());
        i++;
      }
      const from = out.len;
      const children = probe ? [] : parseBlocks(inner, out, depth + 1);
      blocks.push(spanOf(firstFrom(children, from), out.len, { t: 'quote' as const, children }));
      continue;
    }

    const first = ITEM.exec(line);
    if (depth < MAX_DEPTH && (first && first[5] !== undefined && first[5].trim() !== '' || first && first[5] === undefined && i + 1 < n && leadingSpaces(lines[i + 1]) >= 2)) {
      const [list, next] = parseList(lines, i, out, depth, probe);
      blocks.push(list);
      i = next;
      continue;
    }

    if (isTableStart(lines, i)) {
      const rows: TableRow[] = [];
      const tableFrom = out.len;
      const addRow = (cellsText: string[]): void => {
        out.newLine();
        const rowFrom = out.len;
        const cells: Run[][] = [];
        cellsText.forEach((cell, ci) => {
          if (ci > 0) out.push('\t');
          const runs: Run[] = [];
          parseInline(cell, {}, out, runs);
          cells.push(runs);
        });
        rows.push({ cells, from: rowFrom, to: out.len });
      };
      addRow(splitCells(line));
      i += 2;
      while (i < n && !blank(lines[i]) && lines[i].includes('|')) {
        addRow(splitCells(lines[i]));
        i++;
      }
      blocks.push(spanOf(rows.length ? rows[0].from : tableFrom, out.len, { t: 'table' as const, rows }));
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < n && !blank(lines[i]) && !startsBlock(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    const b = inlineBlock(para.join('\n'), out);
    blocks.push({ t: 'para', ...b });
  }
  return blocks;
}

function firstFrom(children: Block[], fallback: number): number {
  return children.length ? children[0].from : fallback;
}

function parseList(lines: string[], start: number, out: Emitter, depth: number, probe: boolean): [Block, number] {
  const head = ITEM.exec(lines[start]);
  if (!head) throw new Error('parseList: no item');
  const ordered = head[3] !== undefined;
  const kind = ordered ? head[2].slice(-1) : head[2];
  const startNum = ordered ? Number(head[3]) : 1;
  const raw: string[][] = [];
  let loose = false;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const m = ITEM.exec(lines[i]);
    if (!m) break;
    const mOrdered = m[3] !== undefined;
    if (mOrdered !== ordered || (mOrdered ? m[2].slice(-1) : m[2]) !== kind) break;
    const markerIndent = m[1].length;
    const gap = m[4] === undefined ? 1 : (leadingSpaces(m[4]) > 4 ? 1 : leadingSpaces(m[4]));
    const indent = markerIndent + m[2].length + gap;
    const content: string[] = [m[5] ?? ''];
    i++;
    let sawBlank = false;
    while (i < n) {
      const l = lines[i];
      if (blank(l)) { content.push(''); sawBlank = true; i++; continue; }
      const lead = leadingSpaces(l);
      if (lead >= indent || (lead > markerIndent && lead >= 2)) {
        content.push(dropIndent(l, Math.min(lead, indent)));
        sawBlank = false;
        i++;
        continue;
      }
      if (sawBlank) break;
      if (startsBlock(lines, i)) break;
      content.push(l.trim());
      i++;
    }
    let trailingBlank = false;
    while (content.length && blank(content[content.length - 1])) { content.pop(); trailingBlank = true; }
    raw.push(content);
    if (trailingBlank && i < n && ITEM.test(lines[i])) {
      const next = ITEM.exec(lines[i]);
      if (next && (next[3] !== undefined) === ordered) loose = true;
    }
  }
  const from = out.len;
  const items: ListItem[] = raw.map((content) => {
    if (probe) return { children: [], from: out.len, to: out.len };
    if (content.some((l, k) => k > 0 && blank(l) && k < content.length - 1)) {
      // A blank line between two paragraphs of one item makes the list loose.
      const paras = parseProbe(content, depth + 1);
      if (paras > 1) loose = true;
    }
    out.newLine();
    const itemFrom = out.len;
    const children = parseBlocks(content, out, depth + 1);
    return { children, from: itemFrom, to: out.len };
  });
  return [{ t: 'list', ordered, start: startNum, loose, items, from: items.length ? items[0].from : from, to: out.len }, i];
}

/** How many top-level blocks `lines` holds, without emitting (for looseness). */
function parseProbe(lines: string[], depth: number): number {
  return parseBlocks(lines, new Emitter(), depth, true).length;
}

export function parseMarkdown(source: string): MarkdownDoc {
  const out = new Emitter();
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = parseBlocks(lines, out);
  return { blocks, visible: out.text() };
}

// --- rendering a span ---

function overlaps(s: Span, a: number, b: number): boolean {
  return s.from < b && s.to > a;
}

function clip(r: Run, a: number, b: number): string {
  const s = Math.max(a, r.at);
  const e = Math.min(b, r.at + r.text.length);
  return e > s ? r.text.slice(s - r.at, e - r.at) : '';
}

/** A link's href, kept only for http, https and mailto. */
export function safeHref(href: string | undefined): string | null {
  if (href === undefined) return null;
  const h = href.trim();
  if (!h || /\s/.test(h) || [...h].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return null;
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function plainRuns(runs: Run[], a: number, b: number): string {
  let s = '';
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    const t = clip(r, a, b);
    if (!t) continue;
    s += t;
    // A link whose whole label is copied keeps its address in plain text.
    const href = safeHref(r.href);
    const lastOfLink = href && (k === runs.length - 1 || runs[k + 1].href !== r.href);
    if (lastOfLink) {
      let firstAt = k;
      while (firstAt > 0 && runs[firstAt - 1].href === r.href) firstAt--;
      const label = runs.slice(firstAt, k + 1).map((x) => x.text).join('');
      const whole = a <= runs[firstAt].at && b >= r.at + r.text.length;
      const shown = label.replace(/^mailto:/i, '');
      if (whole && href !== label && href.replace(/^mailto:/i, '') !== shown) s += ` (${href})`;
    }
  }
  return s;
}

function indentRest(text: string, n: number): string {
  if (n === 0) return text;
  const pad = ' '.repeat(n);
  return text.split('\n').map((l, k) => (k === 0 || l === '' ? l : pad + l)).join('\n');
}

function plainBlocks(blocks: Block[], a: number, b: number): string[] {
  const out: string[] = [];
  for (const blk of blocks) {
    if (!overlaps(blk, a, b)) continue;
    switch (blk.t) {
      case 'para':
      case 'heading':
      case 'code':
        out.push(plainRuns(blk.runs, a, b));
        break;
      case 'quote':
        out.push(...plainBlocks(blk.children, a, b));
        break;
      case 'list': {
        const items: string[] = [];
        blk.items.forEach((item, idx) => {
          if (!overlaps(item, a, b)) return;
          const body = plainBlocks(item.children, a, b).join(blk.loose ? '\n\n' : '\n');
          const marker = blk.ordered ? `${blk.start + idx}. ` : '- ';
          items.push(a <= item.from ? marker + indentRest(body, marker.length) : body);
        });
        out.push(items.join(blk.loose ? '\n\n' : '\n'));
        break;
      }
      case 'table': {
        const rows = blk.rows.filter((r) => overlaps(r, a, b))
          .map((r) => r.cells.map((c) => plainRuns(c, a, b)).join('\t'));
        out.push(rows.join('\n'));
        break;
      }
      case 'hr':
        break;
    }
  }
  return out;
}

/** The span [a, b) of the visible text as clean plain text. */
export function renderPlain(doc: MarkdownDoc, a: number, b: number): string {
  return plainBlocks(doc.blocks, a, b).join('\n\n');
}

function htmlRuns(runs: Run[], a: number, b: number): string {
  let s = '';
  for (const r of runs) {
    const t = clip(r, a, b);
    if (!t) continue;
    if (r.br) { s += '<br>'; continue; }
    let h = escapeHtml(t);
    if (r.code) h = `<code>${h}</code>`;
    if (r.em) h = `<em>${h}</em>`;
    if (r.strong) h = `<strong>${h}</strong>`;
    const href = safeHref(r.href);
    if (href) h = `<a href="${escapeHtml(href)}">${h}</a>`;
    s += h;
  }
  return s;
}

function htmlBlocks(blocks: Block[], a: number, b: number, tight = false): string {
  let s = '';
  const included = blocks.map((blk) => overlaps(blk, a, b));
  const firstIn = included.indexOf(true);
  const lastIn = included.lastIndexOf(true);
  blocks.forEach((blk, k) => {
    if (blk.t === 'hr') {
      if (firstIn >= 0 && k > firstIn && k < lastIn) s += '<hr>';
      return;
    }
    if (!included[k]) return;
    switch (blk.t) {
      case 'para':
        s += tight ? htmlRuns(blk.runs, a, b) : `<p>${htmlRuns(blk.runs, a, b)}</p>`;
        break;
      case 'heading':
        s += `<h${blk.level}>${htmlRuns(blk.runs, a, b)}</h${blk.level}>`;
        break;
      case 'code':
        s += `<pre><code>${htmlRuns(blk.runs.map((r) => ({ ...r, code: false })), a, b)}</code></pre>`;
        break;
      case 'quote':
        s += `<blockquote>${htmlBlocks(blk.children, a, b)}</blockquote>`;
        break;
      case 'list': {
        const tag = blk.ordered ? 'ol' : 'ul';
        let firstIdx = blk.items.findIndex((it) => overlaps(it, a, b));
        if (firstIdx < 0) firstIdx = 0;
        const num = blk.start + firstIdx;
        const startAttr = blk.ordered && num !== 1 ? ` start="${num}"` : '';
        const items = blk.items.filter((it) => overlaps(it, a, b))
          .map((it) => `<li>${htmlBlocks(it.children, a, b, !blk.loose)}</li>`).join('');
        s += `<${tag}${startAttr}>${items}</${tag}>`;
        break;
      }
      case 'table': {
        const rows = blk.rows.map((r, ri) => ({ r, ri })).filter(({ r }) => overlaps(r, a, b));
        const cell = (tag: string, runs: Run[]): string => `<${tag}>${htmlRuns(runs, a, b)}</${tag}>`;
        const head = rows.filter(({ ri }) => ri === 0).map(({ r }) => `<thead><tr>${r.cells.map((c) => cell('th', c)).join('')}</tr></thead>`).join('');
        const body = rows.filter(({ ri }) => ri > 0).map(({ r }) => `<tr>${r.cells.map((c) => cell('td', c)).join('')}</tr>`).join('');
        s += `<table>${head}${body ? `<tbody>${body}</tbody>` : ''}</table>`;
        break;
      }
    }
  });
  return s;
}

/** The span [a, b) of the visible text as an HTML fragment, every character escaped. */
export function renderHtml(doc: MarkdownDoc, a: number, b: number): string {
  return `<meta charset="utf-8">${htmlBlocks(doc.blocks, a, b)}`;
}
