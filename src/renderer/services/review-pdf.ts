/**
 * pdf.js for the review tab (docs/review-tab.md R5). Loaded on first use, so
 * a window that never opens a Word file never parses it.
 *
 * The worker is bundled as a `?url` asset beside the renderer (imported by
 * the renderer's entry, index.ts, and handed in through setPdfWorkerUrl, so
 * the jsdom checks that bundle the components with esbuild never meet a Vite
 * `?url` import) and started by Patton itself (`new Worker(url, { type: 'module' })`), then handed to
 * pdf.js as its port. Left to itself, pdf.js wraps a worker whose page has an
 * opaque origin (the packaged app's file:// page) in a blob: URL, which the
 * window's CSP (worker-src falls back to script-src 'self') refuses, so the
 * packaged app ran pdf.js on the main thread (S61, check-review-tab.cjs with
 * REVIEW_ASAR). If our own Worker can't start, pdf.js's own path (and its
 * main-thread fallback) still opens the file. Which one ran is logged once
 * per window as `[REVIEW] pdf worker {mode}`.
 */
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import { rlog } from './renderer-logger';

type Pdfjs = typeof import('pdfjs-dist');

let workerUrl = '';
let lib: Promise<Pdfjs> | null = null;
let modeLogged = false;
let shared: Promise<PDFWorker | null> | null = null;

/** The worker asset's URL, given once at startup by the renderer's entry. */
export function setPdfWorkerUrl(url: string): void {
  workerUrl = url;
}

/** Start pdf.js's worker from a URL and wait for its first message ("ready").
 *  Null (logged) if it can't start, errors, or says nothing in 10 s. */
export function startPdfWorker(url: string): Promise<Worker | null> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new Worker(url, { type: 'module', name: 'pdfjs' });
    } catch (err) {
      rlog('warn', '[REVIEW] pdf worker did not start', { error: String(err) });
      resolve(null);
      return;
    }
    const finish = (ok: boolean, why?: string): void => {
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      if (ok) { resolve(w); return; }
      w.terminate();
      rlog('warn', '[REVIEW] pdf worker did not start', { error: why });
      resolve(null);
    };
    const onMessage = (e: MessageEvent): void => {
      if ((e.data as { action?: unknown } | null)?.action === 'ready') finish(true);
    };
    const onError = (e: ErrorEvent): void => finish(false, e.message || 'worker error');
    const timer = setTimeout(() => finish(false, 'no ready message in 10 s'), 10000);
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
  });
}

/** One pdf.js worker per window, started by Patton, shared by its documents. */
function sharedWorker(pdfjs: Pdfjs): Promise<PDFWorker | null> {
  if (!shared) {
    shared = (workerUrl ? startPdfWorker(workerUrl) : Promise.resolve(null)).then((port) => (port ? pdfjs.PDFWorker.create({ port }) : null));
  }
  return shared;
}

/** pdf.js, with its worker set (once). */
export function loadPdfjs(): Promise<Pdfjs> {
  if (!lib) {
    lib = import('pdfjs-dist').then((m) => {
      if (workerUrl) m.GlobalWorkerOptions.workerSrc = workerUrl;
      return m;
    });
    lib.catch(() => { lib = null; });
  }
  return lib;
}

export interface OpenedPdf {
  doc: PDFDocumentProxy;
  /** 'worker': pdf.js parses in its Web Worker; 'main-thread': its fallback. */
  mode: 'worker' | 'main-thread';
  destroy(): Promise<void>;
}

/** Open a PDF from bytes (copied: pdf.js takes ownership of what it is given). */
export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  const pdfjs = await loadPdfjs();
  // No XFA forms and no fetching: everything is in the bytes LibreOffice
  // wrote (it embeds the fonts). Pages draw on Patton's own canvases (no
  // offscreen rendering worker), so Print can copy them.
  const worker = await sharedWorker(pdfjs);
  const task = pdfjs.getDocument({
    data: bytes.slice(), enableXfa: false, isOffscreenCanvasSupported: false, disableWorkerRendering: true,
    ...(worker ? { worker } : {}),
  });
  const doc = await task.promise;
  // Our own worker's port, else pdf.js's: `_worker` is its field on the
  // loading task (6.5, set only when pdf.js made the worker), whose port is
  // the Web Worker, or a loopback port when it fell back to the main thread.
  const port = worker ? worker.port : (task as unknown as { _worker?: { port?: unknown } })._worker?.port;
  const mode = typeof Worker !== 'undefined' && port instanceof Worker ? 'worker' : 'main-thread';
  if (!modeLogged) {
    modeLogged = true;
    rlog(mode === 'worker' ? 'info' : 'warn', '[REVIEW] pdf worker', { mode });
  }
  return { doc, mode, destroy: () => task.destroy() };
}
