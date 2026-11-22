/**
 * The review tab's view (docs/review-tab.md): a Word file laid out by
 * LibreOffice (main's review-layout.ts) and drawn page by page by pdf.js on
 * Patton's own canvases, with pdf.js's text layer over each page so text can
 * be selected. A toolbar of visible buttons (he won't remember shortcuts):
 * Print, Send to Drive, Open in Word, Send comments to Claude. A side panel
 * lists the file's Word comments and adds one on the selected text, saved
 * into the .docx by main.
 *
 * Document text reaches the DOM only through pdf.js's text layer (textContent)
 * and the comment list (textContent, never innerHTML). The renderer holds only
 * the opaque doc id main gave; every action goes back through it.
 *
 * Highlights: the text each comment is anchored on is marked on its page (a
 * layer of boxes under the transparent text layer, measured from a DOM Range
 * over the text layer's own spans). Clicking a comment in the panel scrolls
 * its page to it; clicking a highlight selects its comment (hit-tested by
 * point, since the text layer above takes the clicks for selection).
 *
 * Memory: only pages within a screen of the view keep a canvas and text
 * layer (freeSlot); the rest are drawn again when they come near. A hidden
 * tab keeps what it drew.
 *
 * Print (R6): each page is drawn again at PRINT_DPI, one at a time on one
 * reused canvas, and kept only as a JPEG blob behind an <img> (blob: URL,
 * never decoded ahead), one per sheet at the page's own size (@page), in a
 * print-only container; everything else is hidden under @media print; then
 * window.print(). A 100-page file grows the app by about 60 MB to print, not
 * 1.1 GB as when every page was decoded ahead as a PNG (check-review-tab.cjs
 * samples every process through printToPDF). The check proves the page count
 * and that every printed page carries its image.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { REVIEW_COMMENT_MAX, REVIEW_QUOTE_MAX, type ReviewApi, type ReviewComment, type ReviewDocInfo } from '../../shared/review';
import { keyOf, matchesOf, textKey } from '../../shared/review-text';
import { announce } from '../services/announcer';
import { rlog } from '../services/renderer-logger';
import { loadPdfjs, openPdf, type OpenedPdf } from '../services/review-pdf';
import { reviewMessage } from '../services/review-message';
import { snapToInk } from '../services/review-ink';
import type { ConfirmOptions } from './confirm-dialog';

/** A `data:<type>;base64,…` URL's bytes as a Blob of that type. */
function dataUrlBlob(dataUrl: string): Blob {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: dataUrl.slice(5, dataUrl.indexOf(';')) });
}

/** Resolution pages are drawn at for printing. */
export const PRINT_DPI = 200;
/** JPEG quality of a printed page's image. */
const PRINT_JPEG_QUALITY = 0.95;
/** CSS px per PDF point at 100% (96 / 72). */
const PX_PER_PT = 96 / 72;
/** The largest zoom pages are drawn at on screen (their real size). */
const MAX_SCALE = PX_PER_PT;
/** Space around the pages column. */
const PAGES_GUTTER = 48;

export interface ReviewViewDeps {
  info: ReviewDocInfo;
  api: ReviewApi;
  /** Paste this message into the Claude session the document opened from.
   *  Resolves null when sent, else why not (shown in the view). */
  sendToClaude(message: string): Promise<string | null>;
  /** Patton's in-app confirm (components/confirm-dialog.ts). */
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** A Google Doc was made: add it to the session bar's Links. */
  onDriveLink(link: string, name: string): void;
  /** Open a web link through main (the Google Doc). */
  openLink(url: string): void;
}

interface PageSlot {
  index: number;
  el: HTMLElement;
  /** Width and height in PDF points. */
  wPt: number;
  hPt: number;
  drawnScale: number;
  drawing: Promise<void> | null;
}

/** A pending comment: the selected text and which match of it he chose. */
interface Selected {
  quote: string;
  occurrence: number;
  /** The layout's version the text was selected on (main refuses a stale one). */
  version: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A button named by its visible text (what voice control hears him say);
 *  the longer `hint` is its tooltip and accessible description. */
function button(className: string, label: string, hint?: string): HTMLButtonElement {
  const b = el('button', `review-btn ${className}`, label);
  b.type = 'button';
  if (hint) {
    b.title = hint;
    b.setAttribute('aria-description', hint);
  }
  return b;
}

/** The comments already sent to Claude, by file (its shown path), for this
 *  run of Patton: a file opened again in another tab sends only what is new.
 *  A comment is known by its content, since Word may renumber the ids. */
const sentToClaude = new Map<string, Set<string>>();

function commentKey(c: ReviewComment): string {
  return [c.author, c.date, c.text, c.quote].join('\u0000');
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

export class ReviewView {
  readonly element: HTMLElement;
  private readonly deps: ReviewViewDeps;
  private readonly statusEl: HTMLElement;
  /** What the status line says once nothing is in progress: the page count of the last layout. */
  private layoutStatus = '';
  private readonly noteEl: HTMLElement;
  private readonly linkEl: HTMLButtonElement;
  private readonly pagesEl: HTMLElement;
  private readonly printBtn: HTMLButtonElement;
  private readonly driveBtn: HTMLButtonElement;
  private readonly wordBtn: HTMLButtonElement;
  private readonly claudeBtn: HTMLButtonElement;
  private readonly selectedEl: HTMLElement;
  private readonly commentInput: HTMLTextAreaElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly countEl: HTMLElement;
  private readonly listEl: HTMLOListElement;

  private pdf: OpenedPdf | null = null;
  private slots: PageSlot[] = [];
  /** The quote key of each page's text (pdf.js text content), in page order. */
  private pageKeys: string[] = [];
  private allKey = '';
  private comments: ReviewComment[] = [];
  private selected: Selected | null = null;
  /** The `version` of the layout on screen (main's mtime:size of the file it laid out). */
  private layoutVersion = '';
  private loadSeq = 0;
  private scale = 1;
  private disposed = false;
  private busy = new Set<string>();
  private driveLink: string | null = null;
  private observer: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private printCleanup: (() => void) | null = null;
  /** Bytes of page images the last Print holds until its cleanup (logged with `[REVIEW] print`). */
  printHeldBytes = 0;
  private offChanged: (() => void) | null = null;
  /** The note came from a layout failure, so a good re-layout clears it;
   *  other notes (a refused send) stay until replaced. */
  private noteFromLayout = false;
  /** The comment selected in the panel or by its highlight. */
  private activeComment: string | null = null;
  private hoverFrame = 0;
  private readonly onPagesClick = (e: MouseEvent): void => this.clickPages(e);
  private readonly onPagesMove = (e: MouseEvent): void => this.hoverPages(e);
  private readonly onSelectionEnd = (): void => this.captureSelection();

  constructor(deps: ReviewViewDeps) {
    this.deps = deps;
    const { info } = deps;
    const root = el('div', 'review');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', `Review of ${info.name}`);
    root.tabIndex = -1;
    this.element = root;

    // --- toolbar
    const head = el('div', 'review-head');
    const titles = el('div', 'review-titles');
    const title = el('h2', 'review-title', info.name);
    const path = el('span', 'review-path', info.shownPath);
    path.title = info.shownPath;
    titles.append(title, path);
    const bar = el('div', 'review-actions');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Document actions');
    this.printBtn = button('review-print-btn', 'Print', 'Print the document as laid out');
    this.driveBtn = button('review-drive-btn', 'Send to Drive', 'Send to Google Drive as a Google Doc');
    this.wordBtn = button('review-word-btn', 'Open in Word', 'Open the file in Word');
    this.claudeBtn = button('review-claude-btn', 'Send comments to Claude');
    bar.append(this.printBtn, this.driveBtn, this.wordBtn, this.claudeBtn);
    head.append(titles, bar);

    const msgs = el('div', 'review-msgs');
    this.statusEl = el('span', 'review-status');
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');
    this.linkEl = button('review-doc-link', 'Open the Google Doc', 'Open the Google Doc in the browser');
    this.linkEl.hidden = true;
    this.noteEl = el('span', 'review-note');
    this.noteEl.setAttribute('role', 'alert');
    this.noteEl.hidden = true;
    msgs.append(this.statusEl, this.linkEl, this.noteEl);

    // --- pages and comments
    const body = el('div', 'review-body');
    this.pagesEl = el('div', 'review-pages');
    this.pagesEl.setAttribute('aria-label', 'Pages');
    this.pagesEl.setAttribute('role', 'document');
    this.pagesEl.tabIndex = 0;

    const side = el('aside', 'review-side');
    side.setAttribute('aria-label', 'Comments');
    const sideHead = el('h3', 'review-side-title', 'Comments ');
    this.countEl = el('span', 'review-count', '0');
    sideHead.append(this.countEl);
    const form = el('div', 'review-add');
    this.selectedEl = el('p', 'review-selected', 'Select text on a page to comment on it.');
    this.selectedEl.id = `review-selected-${info.docId}`;
    this.commentInput = el('textarea', 'review-input');
    this.commentInput.rows = 3;
    this.commentInput.maxLength = REVIEW_COMMENT_MAX;
    this.commentInput.placeholder = 'Your comment';
    this.commentInput.setAttribute('aria-label', 'Comment on the selected text');
    this.commentInput.setAttribute('aria-describedby', this.selectedEl.id);
    this.addBtn = button('review-add-btn', 'Add comment', 'Add the comment to the selected text');
    form.append(this.selectedEl, this.commentInput, this.addBtn);
    this.listEl = el('ol', 'review-comments');
    this.listEl.setAttribute('aria-label', 'Comments in the file');
    side.append(sideHead, form, this.listEl);
    body.append(this.pagesEl, side);

    root.append(head, msgs, body);

    this.printBtn.addEventListener('click', () => { void this.print(); });
    this.driveBtn.addEventListener('click', () => { void this.sendToDrive(); });
    this.wordBtn.addEventListener('click', () => { void this.openInWord(); });
    this.claudeBtn.addEventListener('click', () => { void this.sendToClaude(); });
    this.addBtn.addEventListener('click', () => { void this.addComment(); });
    this.linkEl.addEventListener('click', () => { if (this.driveLink) this.deps.openLink(this.driveLink); });
    this.commentInput.addEventListener('input', () => this.refreshButtons());
    // On the document: a drag that starts on a page may end anywhere.
    document.addEventListener('mouseup', this.onSelectionEnd);
    this.pagesEl.addEventListener('keyup', this.onSelectionEnd);
    this.pagesEl.addEventListener('click', this.onPagesClick);
    this.pagesEl.addEventListener('mousemove', this.onPagesMove);

    this.offChanged = deps.api.onChanged((docId) => {
      if (docId !== info.docId || this.disposed) return;
      // Word (or Claude) may have added or removed comments too: read once the
      // new layout is in (a file that went away keeps the list it had).
      void this.load('changed').then((ok) => { if (ok) void this.loadComments(); });
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => this.refit(), 100);
      });
      this.resizeObserver.observe(this.pagesEl);
    }
    this.refreshButtons();
    void this.load('open');
    void this.loadComments();
  }

  focus(): void {
    this.pagesEl.focus({ preventScroll: true });
  }

  /** Pages laid out now (0 until the first layout lands). */
  get pageCount(): number {
    return this.slots.length;
  }

  // ------------------------------------------------------------ layout

  /** Lay the file out and show it; true once its pages show. */
  private async load(why: 'open' | 'changed'): Promise<boolean> {
    const seq = ++this.loadSeq;
    this.busy.add('layout');
    this.refreshButtons();
    this.setStatus(why === 'open' ? 'Laying out…' : 'The file changed: laying it out again…');
    const reply = await this.deps.api.layout(this.deps.info.docId);
    if (seq !== this.loadSeq || this.disposed) return false;
    this.busy.delete('layout');
    if (reply.ok === false) {
      this.refreshButtons();
      this.setStatus(this.slots.length > 0 ? this.layoutStatus : '');
      this.showNote(reply.message, true);
      rlog('warn', '[REVIEW] layout refused', { why: reply.why });
      return false;
    }
    let opened: OpenedPdf;
    try {
      opened = await openPdf(reply.pdf);
    } catch (err) {
      if (seq !== this.loadSeq || this.disposed) return false;
      this.refreshButtons();
      this.setStatus('');
      this.showNote('The laid-out pages could not be read.', true);
      rlog('error', '[REVIEW] pdf open failed', { error: String(err) });
      return false;
    }
    if (seq !== this.loadSeq || this.disposed) { void opened.destroy(); return false; }
    const old = this.pdf;
    this.pdf = opened;
    this.layoutVersion = reply.version;
    const scrollTop = this.pagesEl.scrollTop;
    await this.buildPages(opened.doc);
    if (seq !== this.loadSeq || this.disposed) return false;
    this.pagesEl.scrollTop = scrollTop;
    if (old) void old.destroy();
    if (this.noteFromLayout) this.hideNote();
    const n = this.slots.length;
    this.layoutStatus = `${n} page${n === 1 ? '' : 's'}${reply.cached ? '' : `, laid out in ${(reply.ms / 1000).toFixed(1)} s`}`;
    this.setStatus(this.layoutStatus);
    rlog('info', '[REVIEW] shown', { pages: n, cached: reply.cached, mode: opened.mode, why });
    this.refreshButtons();
    return true;
  }

  private fitScale(wPt: number): number {
    const avail = this.pagesEl.clientWidth - PAGES_GUTTER;
    if (!(avail > 0)) return MAX_SCALE;
    return Math.max(0.5, Math.min(MAX_SCALE, avail / wPt));
  }

  private async buildPages(doc: PDFDocumentProxy): Promise<void> {
    this.observer?.disconnect();
    for (const c of this.pagesEl.querySelectorAll('canvas')) { c.width = 0; c.height = 0; }
    this.pagesEl.replaceChildren();
    this.slots = [];
    const keys: string[] = [];
    const pages: PDFPageProxy[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      pages.push(page);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) if ('str' in item) text += item.str;
      keys.push(textKey(text));
    }
    this.pageKeys = keys;
    this.allKey = keys.join('');
    const first = pages[0]?.getViewport({ scale: 1 });
    this.scale = first ? this.fitScale(first.width) : 1;
    for (const page of pages) {
      const vp = page.getViewport({ scale: 1 });
      const slot: PageSlot = { index: page.pageNumber - 1, el: el('div', 'review-page'), wPt: vp.width, hPt: vp.height, drawnScale: 0, drawing: null };
      slot.el.dataset.page = String(slot.index);
      slot.el.setAttribute('role', 'group');
      slot.el.setAttribute('aria-label', `Page ${page.pageNumber} of ${pages.length}`);
      this.sizeSlot(slot);
      this.pagesEl.append(slot.el);
      this.slots.push(slot);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const slot = this.slots.find((s) => s.el === e.target);
          if (!slot) continue;
          if (e.isIntersecting) {
            // Marks are measured from the laid-out text, so a page drawn while
            // the tab was hidden is measured again once it is seen.
            void this.drawSlot(slot).then(() => this.paintMarks(slot));
          } else if (this.pagesEl.clientHeight > 0) {
            // Out of reach of the view: its canvas goes (a page at DPR 2 is
            // ~14 MB; a 100-page file kept every one, ~1.4 GB). A hidden tab
            // (no height) keeps what it has, so switching back shows at once.
            this.freeSlot(slot);
          }
        }
      }, { root: this.pagesEl, rootMargin: '100% 0px' });
      for (const s of this.slots) this.observer.observe(s.el);
    }
    // The first two pages at once: what he sees first, and what a check reads.
    await Promise.all(this.slots.slice(0, 2).map((s) => this.drawSlot(s)));
  }

  private sizeSlot(slot: PageSlot): void {
    slot.el.style.width = `${Math.floor(slot.wPt * this.scale)}px`;
    slot.el.style.height = `${Math.floor(slot.hPt * this.scale)}px`;
  }

  /** Let a page's canvas and text layer go (drawn again when it comes near). */
  private freeSlot(slot: PageSlot): void {
    if (slot.drawnScale === 0 && !slot.el.firstChild) return;
    // Never pull the text out from under a selection he is making or made.
    const sel = document.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.getRangeAt(0).intersectsNode(slot.el)) return;
    slot.drawnScale = 0;
    slot.drawing = null;
    for (const c of slot.el.querySelectorAll('canvas')) { c.width = 0; c.height = 0; }
    slot.el.replaceChildren();
    const pdf = this.pdf;
    if (pdf) void pdf.doc.getPage(slot.index + 1).then((p) => p.cleanup()).catch(() => {});
  }

  /** Pages with a canvas now (a check reads it). */
  get drawnPages(): number {
    return this.slots.filter((s) => s.el.querySelector('canvas')).length;
  }

  /** Draw a page's canvas and text layer at the current scale (once per scale). */
  private drawSlot(slot: PageSlot): Promise<void> {
    if (slot.drawnScale === this.scale) return slot.drawing ?? Promise.resolve();
    const pdf = this.pdf;
    if (!pdf) return Promise.resolve();
    const scale = this.scale;
    slot.drawnScale = scale;
    const run = (async () => {
      const pdfjs = await loadPdfjs();
      const page = await pdf.doc.getPage(slot.index + 1);
      if (this.pdf !== pdf || slot.drawnScale !== scale) return;
      const vp = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const canvas = el('canvas', 'review-canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      await page.render({ canvasContext: ctx, canvas, viewport: vp, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise;
      if (this.pdf !== pdf || slot.drawnScale !== scale) return;
      const layer = el('div', 'textLayer review-text-layer');
      layer.dataset.page = String(slot.index);
      slot.el.style.setProperty('--scale-factor', String(scale));
      slot.el.style.setProperty('--total-scale-factor', String(scale));
      const tl = new pdfjs.TextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport: vp });
      await tl.render();
      if (this.pdf !== pdf || slot.drawnScale !== scale) return;
      slot.el.replaceChildren(canvas, el('div', 'review-marks'), layer);
      this.paintMarks(slot);
    })().catch((err) => {
      slot.drawnScale = 0;
      rlog('error', '[REVIEW] page draw failed', { page: slot.index + 1, error: String(err) });
    });
    slot.drawing = run;
    return run;
  }

  /** The pages column changed width: redraw at the new fit (debounced). */
  private refit(): void {
    if (this.disposed || this.slots.length === 0) return;
    const next = this.fitScale(this.slots[0].wPt);
    if (Math.abs(next - this.scale) / this.scale < 0.02) return;
    this.scale = next;
    for (const s of this.slots) {
      this.sizeSlot(s);
      this.freeSlot(s);
    }
    this.observer?.disconnect();
    for (const s of this.slots) this.observer?.observe(s.el);
    if (!this.observer) for (const s of this.slots) void this.drawSlot(s);
  }

  // ------------------------------------------------------------ comments

  private async loadComments(): Promise<void> {
    const list = await this.deps.api.comments(this.deps.info.docId);
    if (this.disposed) return;
    this.comments = Array.isArray(list) ? list : [];
    this.renderComments();
  }

  private renderComments(): void {
    this.countEl.textContent = String(this.comments.length);
    if (this.activeComment && !this.comments.some((c) => c.id === this.activeComment)) this.activeComment = null;
    const items = this.comments.map((c) => {
      const li = el('li', 'review-comment');
      // One button per comment: its text is its name; it shows the comment's
      // place on the pages.
      const go = el('button', 'review-comment-btn');
      go.type = 'button';
      go.dataset.comment = c.id;
      go.title = 'Show where this comment is on the pages';
      if (c.quote) go.append(el('span', 'review-comment-quote', cut(c.quote, 160)));
      go.append(el('span', 'review-comment-text', c.text));
      const meta = [c.author, shortDate(c.date), this.isSent(c) ? 'sent to Claude' : ''].filter(Boolean).join(' · ');
      if (meta) go.append(el('span', 'review-comment-meta', meta));
      go.addEventListener('click', () => { void this.selectComment(c.id, 'list'); });
      li.append(go);
      return li;
    });
    if (items.length === 0) items.push(el('li', 'review-comment review-comment-none', 'No comments in the file yet.'));
    this.listEl.replaceChildren(...items);
    this.markActive();
    for (const slot of this.slots) this.paintMarks(slot);
    this.refreshButtons();
  }

  // ------------------------------------------------------------ highlights

  /** Where a comment's quote sits in the pages' key: its start and end. */
  private anchorOf(c: ReviewComment): { start: number; end: number } | null {
    const key = textKey(c.quote);
    if (!key || !this.allKey) return null;
    const matches = matchesOf(this.allKey, key);
    if (matches.length === 0) return null;
    const occ = Number.isInteger(c.occurrence) && c.occurrence >= 0 ? c.occurrence : 0;
    const start = matches[Math.min(occ, matches.length - 1)];
    return { start, end: start + key.length };
  }

  /** The page an index of the pages' key falls on. */
  private pageOfKey(at: number): number {
    let pos = 0;
    for (let i = 0; i < this.pageKeys.length; i++) {
      pos += this.pageKeys[i].length;
      if (at < pos) return i;
    }
    return Math.max(0, this.pageKeys.length - 1);
  }

  /** Mark every comment's quote on a drawn page (boxes under the text layer). */
  private paintMarks(slot: PageSlot): void {
    const marks = slot.el.querySelector<HTMLElement>(':scope > .review-marks');
    const layer = slot.el.querySelector<HTMLElement>(':scope > .review-text-layer');
    const canvas = slot.el.querySelector<HTMLCanvasElement>(':scope > canvas.review-canvas');
    if (!marks || !layer || this.disposed) return;
    const pageStart = this.pageKeys.slice(0, slot.index).join('').length;
    const pageEnd = pageStart + (this.pageKeys[slot.index]?.length ?? 0);
    const wanted = this.comments
      .map((c) => ({ c, a: this.anchorOf(c) }))
      .filter((x): x is { c: ReviewComment; a: { start: number; end: number } } => x.a !== null && x.a.start < pageEnd && x.a.end > pageStart);
    if (wanted.length === 0) { marks.replaceChildren(); return; }
    // key[i] of this page came from chars[i] of the text layer's text.
    const chars: { node: Text; from: number; to: number }[] = [];
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const node = n as Text;
      let off = 0;
      for (const ch of node.data) {
        const k = keyOf(ch);
        for (let j = 0; j < k.length; j++) chars.push({ node, from: off, to: off + ch.length });
        off += ch.length;
      }
    }
    const base = slot.el.getBoundingClientRect();
    if (base.width === 0) return; // not laid out (tab hidden): measured when seen
    const boxes: HTMLElement[] = [];
    for (const { c, a } of wanted) {
      const from = Math.max(a.start, pageStart) - pageStart;
      const to = Math.min(a.end, pageEnd) - pageStart;
      const first = chars[from];
      const last = chars[to - 1];
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, first.from);
      range.setEnd(last.node, last.to);
      const rects = [...range.getClientRects()].filter((r) => r.width >= 0.5 && r.height >= 0.5);
      // The quote's own first and last edges sit on the canvas's ink; a line's
      // inner edges are the text layer's and stay. An edge inside a word stays too.
      // (The raw characters beside the quote: the key drops spaces, so the
      // neighbouring key is a letter.)
      const wordEdge = (node: Text, at: number): boolean => at < 0 || at >= node.data.length || /\s/.test(node.data.charAt(at));
      const leftOk = wordEdge(first.node, first.from - 1);
      const rightOk = wordEdge(last.node, last.to);
      rects.forEach((r, i) => {
        let left = r.left - base.left;
        let right = r.right - base.left;
        const top = r.top - base.top;
        if (canvas && (i === 0 || i === rects.length - 1)) {
          const snapped = snapToInk(canvas, { left, right, top, height: r.height }, {
            left: i === 0 && leftOk,
            right: i === rects.length - 1 && rightOk,
          });
          left = snapped.left;
          right = snapped.right;
        }
        const box = el('div', 'review-mark');
        box.dataset.comment = c.id;
        if (c.id === this.activeComment) box.classList.add('review-mark-active');
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.width = `${right - left}px`;
        box.style.height = `${r.height}px`;
        boxes.push(box);
      });
    }
    marks.replaceChildren(...boxes);
  }

  /** Show which comment is selected, in the panel and on the pages. */
  private markActive(): void {
    for (const b of this.listEl.querySelectorAll<HTMLElement>('.review-comment-btn')) {
      const on = b.dataset.comment === this.activeComment;
      b.classList.toggle('review-comment-active', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
    for (const m of this.pagesEl.querySelectorAll<HTMLElement>('.review-mark')) {
      m.classList.toggle('review-mark-active', m.dataset.comment === this.activeComment);
    }
  }

  /** Select a comment: from the panel, scroll its page to it; from its
   *  highlight, bring it into view in the panel. */
  async selectComment(id: string, from: 'list' | 'page'): Promise<void> {
    const c = this.comments.find((x) => x.id === id);
    if (!c || this.disposed) return;
    this.activeComment = id;
    this.markActive();
    if (from === 'page') {
      this.listEl.querySelector<HTMLElement>(`.review-comment-btn[data-comment="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const a = this.anchorOf(c);
    const slot = a ? this.slots[this.pageOfKey(a.start)] : undefined;
    if (!slot) {
      this.setStatus('The text this comment is on was not found on the pages.');
      rlog('info', '[REVIEW] comment not on the pages', { quoteChars: c.quote.length });
      return;
    }
    await this.drawSlot(slot);
    if (this.disposed || this.activeComment !== id) return;
    this.paintMarks(slot);
    const mark = slot.el.querySelector<HTMLElement>(`.review-mark[data-comment="${CSS.escape(id)}"]`);
    const top = slot.el.getBoundingClientRect().top - this.pagesEl.getBoundingClientRect().top + this.pagesEl.scrollTop;
    this.pagesEl.scrollTop = Math.max(0, top + (mark ? mark.offsetTop - 64 : -16));
  }

  /** The comment whose highlight is under a point, if any. */
  private markAt(x: number, y: number): string | null {
    for (const m of this.pagesEl.querySelectorAll<HTMLElement>('.review-mark')) {
      const r = m.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return m.dataset.comment ?? null;
    }
    return null;
  }

  private clickPages(e: MouseEvent): void {
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return; // the end of a text selection, not a click
    const id = this.markAt(e.clientX, e.clientY);
    if (id) { void this.selectComment(id, 'page'); return; }
    if (this.activeComment) { this.activeComment = null; this.markActive(); }
  }

  /** A pointer over a highlight says it can be clicked. */
  private hoverPages(e: MouseEvent): void {
    if (this.hoverFrame) return;
    const { clientX, clientY } = e;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      if (!this.disposed) this.pagesEl.classList.toggle('review-over-mark', this.markAt(clientX, clientY) !== null);
    });
  }

  /** The text layer a node sits in, if any. */
  private layerOf(node: Node | null): HTMLElement | null {
    const e = node && (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement);
    const layer = e?.closest<HTMLElement>('.review-text-layer') ?? null;
    return layer && this.pagesEl.contains(layer) ? layer : null;
  }

  /** Take the page selection as the comment's quote, and count the matches of
   *  its key in the pages' text before it (R7: main picks the same match in
   *  the body, else the last). */
  captureSelection(): void {
    if (this.disposed) return;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const picked = sel.getRangeAt(0);
    // Only a selection that touches these pages is his comment's (the mouse
    // is followed on the whole document: a drag may end past the pages).
    if (!picked.intersectsNode(this.pagesEl)) return;
    const layers = [...this.pagesEl.querySelectorAll<HTMLElement>('.review-text-layer')].filter((l) => picked.intersectsNode(l));
    if (layers.length === 0) {
      this.showNote('Select words on a page to comment on them.');
      return;
    }
    // A selection that starts or ends outside the text (a page's margin, the
    // gap between pages, the panel beside them) is cut to the text it holds.
    const range = picked.cloneRange();
    if (!this.layerOf(range.startContainer)) range.setStart(layers[0], 0);
    if (!this.layerOf(range.endContainer)) {
      const last = layers[layers.length - 1];
      range.setEnd(last, last.childNodes.length);
    }
    const startLayer = this.layerOf(range.startContainer);
    if (!startLayer) return;
    const quote = range.toString();
    const key = textKey(quote);
    if (!key) {
      this.showNote('Select words on a page to comment on them.');
      return;
    }
    if (quote.length > REVIEW_QUOTE_MAX) {
      this.showNote(`Select less text: up to ${REVIEW_QUOTE_MAX.toLocaleString()} characters.`);
      return;
    }
    const page = Number(startLayer.dataset.page);
    const pre = document.createRange();
    pre.setStart(startLayer, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const before = this.pageKeys.slice(0, page).join('').length + textKey(pre.toString()).length;
    const occurrence = matchesOf(this.allKey, key).filter((i) => i < before).length;
    this.selected = { quote, occurrence, version: this.layoutVersion };
    this.selectedEl.textContent = `On “${cut(quote, 120)}”`;
    this.selectedEl.classList.add('review-selected-set');
    this.hideNote();
    this.refreshButtons();
  }

  private async addComment(): Promise<void> {
    const text = this.commentInput.value.trim();
    if (!this.selected) { this.showNote('Select text on a page first.'); return; }
    if (!text) { this.showNote('Write the comment first.'); this.commentInput.focus(); return; }
    this.busy.add('add');
    this.refreshButtons();
    this.setStatus('Saving the comment into the file…');
    const { quote, occurrence, version } = this.selected;
    const reply = await this.deps.api.addComment(this.deps.info.docId, { quote, occurrence, text, version });
    this.busy.delete('add');
    if (this.disposed) return;
    if (reply.ok === false && reply.why === 'changed') {
      // Selected on a layout of an older file: the selection may point at
      // other text now. Keep what he wrote, drop the selection, lay out again.
      rlog('info', '[REVIEW] comment refused: layout outdated');
      this.clearSelection();
      this.showNote(reply.message);
      this.refreshButtons();
      void this.load('changed');
      return;
    }
    if (reply.ok === false) {
      this.setStatus(this.layoutStatus);
      // A file that went away: the next good layout (it came back) clears it.
      this.showNote(reply.message, reply.why === 'missing');
      this.refreshButtons();
      return;
    }
    this.commentInput.value = '';
    this.clearSelection();
    this.hideNote();
    this.setStatus('Comment saved in the file.');
    announce('Comment saved in the file');
    await this.loadComments();
  }

  private clearSelection(): void {
    this.selected = null;
    this.selectedEl.textContent = 'Select text on a page to comment on it.';
    this.selectedEl.classList.remove('review-selected-set');
    document.getSelection()?.removeAllRanges();
  }

  // ------------------------------------------------------------ actions

  private isSent(c: ReviewComment): boolean {
    return sentToClaude.get(this.deps.info.shownPath)?.has(commentKey(c)) === true;
  }

  /** The comments not yet sent to Claude (every author's), in file order. */
  get unsentComments(): ReviewComment[] {
    return this.comments.filter((c) => !this.isSent(c));
  }

  private async sendToClaude(): Promise<void> {
    const toSend = this.unsentComments;
    if (toSend.length === 0) {
      this.showNote(this.comments.length === 0 ? 'There are no comments to send yet.' : 'Every comment here has been sent to Claude already.');
      return;
    }
    this.busy.add('claude');
    this.refreshButtons();
    let why: string | null;
    try {
      why = await this.deps.sendToClaude(reviewMessage(this.deps.info, toSend));
    } catch (err) {
      rlog('error', '[REVIEW] send to Claude failed', { error: String(err) });
      why = 'The comments could not be sent.';
    }
    this.busy.delete('claude');
    if (this.disposed) return;
    this.refreshButtons();
    if (why) {
      this.setStatus('');
      this.showNote(why);
      return;
    }
    let sent = sentToClaude.get(this.deps.info.shownPath);
    if (!sent) { sent = new Set(); sentToClaude.set(this.deps.info.shownPath, sent); }
    for (const c of toSend) sent.add(commentKey(c));
    this.hideNote();
    const n = toSend.length;
    this.setStatus(`Sent ${n} comment${n === 1 ? '' : 's'} to Claude.`);
    rlog('info', '[REVIEW] comments to Claude', { sent: n, earlier: this.comments.length - n });
    this.renderComments();
  }

  private async openInWord(): Promise<void> {
    const ok = await this.deps.api.openInWord(this.deps.info.docId);
    if (this.disposed) return;
    if (ok) { this.hideNote(); this.setStatus('Opened in Word.'); } else this.showNote('The file could not be opened in Word.');
  }

  private async sendToDrive(): Promise<void> {
    const { info } = this.deps;
    this.busy.add('drive');
    this.refreshButtons();
    // Main's full check (path, document properties, text), not the name alone.
    const lindus = await this.deps.api.lindus(info.docId);
    if (this.disposed) return;
    let confirmLindus = false;
    if (lindus.why !== null) {
      confirmLindus = await this.confirmLindus(lindus.why);
      if (!confirmLindus) { this.busy.delete('drive'); this.refreshButtons(); this.setStatus('Not sent to Drive.'); return; }
    }
    this.setStatus('Sending to Drive…');
    let reply = await this.deps.api.sendToDrive(info.docId, { confirmLindus });
    if (reply.ok === false && reply.why === 'confirm-lindus' && !confirmLindus) {
      // The file changed in between and main judges it Lindus now: ask, then send once more.
      if (await this.confirmLindus(null)) reply = await this.deps.api.sendToDrive(info.docId, { confirmLindus: true });
      else { this.busy.delete('drive'); this.refreshButtons(); this.setStatus('Not sent to Drive.'); return; }
    }
    this.busy.delete('drive');
    if (this.disposed) return;
    this.refreshButtons();
    if (reply.ok === false) {
      this.setStatus(this.layoutStatus);
      this.showNote(reply.message, reply.why === 'missing');
      return;
    }
    this.hideNote();
    if (reply.dryRun === true) {
      this.setStatus(`Dry run, nothing sent (as ${reply.account}): ${reply.summary.split('\n').length} requests built.`);
      rlog('info', '[REVIEW] drive dry run shown');
      return;
    }
    this.driveLink = reply.link;
    this.linkEl.hidden = false;
    this.linkEl.title = reply.link;
    this.setStatus(`Sent to Drive as the Google Doc “${reply.name}”.`);
    announce('Sent to Drive as a Google Doc');
    this.deps.onDriveLink(reply.link, reply.name);
  }

  /** `why` is main's reason in his words (`LINDUS_SIGNAL_WORDS`). */
  private confirmLindus(why: string | null): Promise<boolean> {
    const reason = why ? ` (${why})` : '';
    return this.deps.confirm({
      title: 'Send a Lindus document to your personal Drive?',
      message: `${this.deps.info.name} looks like Lindus work${reason}. Send to Drive puts it in your personal Google Drive, not the Lindus one.`,
      confirmLabel: 'Send to my Drive',
      cancelLabel: 'Don’t send',
      defaultFocus: 'cancel',
    });
  }

  // ------------------------------------------------------------ print

  /** Build the print-only pages (images at PRINT_DPI, one sheet each at the
   *  page's own size). Returns the cleanup. */
  async preparePrint(): Promise<() => void> {
    this.printCleanup?.();
    const pdf = this.pdf;
    if (!pdf) throw new Error('nothing laid out');
    const host = el('div', 'review-print');
    host.setAttribute('aria-hidden', 'true');
    const style = el('style');
    const sizes = new Map<string, string>();
    const rules: string[] = [];
    const urls: string[] = [];
    let held = 0;
    // One canvas for every page: drawn, encoded, then drawn over.
    const canvas = el('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    const total = pdf.doc.numPages;
    try {
      for (let i = 1; i <= total; i++) {
        if (this.disposed || this.pdf !== pdf) throw new Error('the layout changed while preparing to print');
        if (total > 10) this.setStatus(`Preparing the pages to print… ${i} of ${total}`);
        const page = await pdf.doc.getPage(i);
        const pt = page.getViewport({ scale: 1 });
        const sizeKey = `${pt.width.toFixed(2)}x${pt.height.toFixed(2)}`;
        let name = sizes.get(sizeKey);
        if (!name) {
          name = `review-sheet-${sizes.size}`;
          sizes.set(sizeKey, name);
          rules.push(`@page ${name} { size: ${pt.width.toFixed(2)}pt ${pt.height.toFixed(2)}pt; margin: 0; }`);
        }
        const vp = page.getViewport({ scale: PRINT_DPI / 72 });
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await page.render({ canvasContext: ctx, canvas, viewport: vp, background: '#ffffff' }).promise;
        page.cleanup();
        // toDataURL, not toBlob: Chromium encodes a toBlob in idle time, which
        // a window in the background may not get (the hidden check waited
        // minutes). The string is dropped as soon as its bytes are a blob.
        // JPEG, not PNG: Chromium's print compositor put the JPEGs in the PDF
        // as they were and grew by 0 MB for 100 pages; for the same pages as
        // PNGs it grew by 600 MB (check-review-tab.cjs). At 200 dpi and 0.95
        // the text prints as the PNG did (compared by eye at 300 dpi).
        const blob = dataUrlBlob(canvas.toDataURL('image/jpeg', PRINT_JPEG_QUALITY));
        held += blob.size;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const img = el('img', 'review-print-page');
        img.alt = '';
        img.decoding = 'async';
        img.style.width = `${pt.width.toFixed(2)}pt`;
        img.style.height = `${pt.height.toFixed(2)}pt`;
        img.style.setProperty('page', name);
        // Loaded (its size known), not decoded: decoding waits for its sheet.
        const loaded = new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error(`page ${i} image did not load`));
        });
        img.src = url;
        await loaded;
        host.append(img);
      }
    } catch (err) {
      for (const url of urls) URL.revokeObjectURL(url);
      throw err;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
    // The first sheet's size for anything unnamed (Chromium's fallback page).
    const firstSize = [...sizes.keys()][0]?.split('x');
    if (firstSize) rules.unshift(`@page { size: ${firstSize[0]}pt ${firstSize[1]}pt; margin: 0; }`);
    this.printHeldBytes = held;
    style.textContent = rules.join('\n');
    style.dataset.review = 'print';
    document.head.append(style);
    document.body.append(host);
    document.documentElement.classList.add('review-printing');
    const cleanup = (): void => {
      host.remove();
      style.remove();
      for (const url of urls) URL.revokeObjectURL(url);
      document.documentElement.classList.remove('review-printing');
      if (this.printCleanup === cleanup) this.printCleanup = null;
    };
    this.printCleanup = cleanup;
    return cleanup;
  }

  private async print(): Promise<void> {
    if (!this.pdf) return;
    this.busy.add('print');
    this.refreshButtons();
    this.setStatus('Preparing the pages to print…');
    let cleanup: () => void;
    try {
      cleanup = await this.preparePrint();
    } catch (err) {
      this.busy.delete('print');
      this.refreshButtons();
      this.setStatus('');
      this.showNote('The pages could not be prepared for printing.');
      rlog('error', '[REVIEW] print prepare failed', { error: String(err) });
      return;
    }
    // The print snapshot is taken from the print-only pages; they go once the
    // dialog is done (afterprint), or at the next Print or when the tab closes.
    window.addEventListener('afterprint', () => cleanup(), { once: true });
    rlog('info', '[REVIEW] print', { pages: this.slots.length, heldMB: Math.round(this.printHeldBytes / 1048576) });
    this.setStatus(this.layoutStatus);
    this.busy.delete('print');
    this.refreshButtons();
    window.print();
  }

  // ------------------------------------------------------------ state

  private refreshButtons(): void {
    const laidOut = this.pdf !== null && this.slots.length > 0;
    this.printBtn.disabled = !laidOut || this.busy.has('print');
    this.driveBtn.disabled = this.busy.has('drive');
    const unsent = this.unsentComments.length;
    this.claudeBtn.textContent = unsent === 0 ? 'Send comments to Claude' : `Send ${unsent} comment${unsent === 1 ? '' : 's'} to Claude`;
    this.claudeBtn.title = unsent === 0 && this.comments.length > 0
      ? 'Every comment here has been sent to Claude'
      : 'Paste the comments not yet sent, each with its author and the text it is on, into the Claude session as one message';
    this.claudeBtn.setAttribute('aria-description', this.claudeBtn.title);
    this.claudeBtn.disabled = unsent === 0 || this.busy.has('claude');
    this.addBtn.disabled = !this.selected || !this.commentInput.value.trim() || this.busy.has('add');
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  private showNote(text: string, fromLayout = false): void {
    this.noteEl.textContent = text;
    this.noteEl.hidden = false;
    this.noteFromLayout = fromLayout;
  }

  private hideNote(): void {
    this.noteEl.textContent = '';
    this.noteEl.hidden = true;
    this.noteFromLayout = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadSeq++;
    this.offChanged?.();
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.printCleanup?.();
    document.removeEventListener('mouseup', this.onSelectionEnd);
    this.pagesEl.removeEventListener('keyup', this.onSelectionEnd);
    this.pagesEl.removeEventListener('click', this.onPagesClick);
    this.pagesEl.removeEventListener('mousemove', this.onPagesMove);
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);
    if (this.pdf) void this.pdf.destroy();
    this.pdf = null;
    void this.deps.api.close(this.deps.info.docId);
  }
}
