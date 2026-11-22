/**
 * pdf.js for the review tab (docs/review-tab.md R5). Loaded on first use, so
 * a window that never opens a Word file never parses it.
 *
 * The worker is bundled as a `?url` asset beside the renderer (script-src
 * 'self' allows it, from Vite's dev server and from the packaged asar alike).
 * pdf.js falls back to running its worker code on the main thread if the
 * Worker can't start; which one ran is logged once per window as
 * `[REVIEW] pdf worker {mode}` so a packaged build that lost its worker shows
 * in main.log, not only as a slower page.
 */
// eslint-disable-next-line import/no-unresolved -- a Vite `?url` asset import, resolved by Vite, not Node
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { rlog } from './renderer-logger';

type Pdfjs = typeof import('pdfjs-dist');

let lib: Promise<Pdfjs> | null = null;
let modeLogged = false;

/** pdf.js, with its worker set (once). */
export function loadPdfjs(): Promise<Pdfjs> {
  if (!lib) {
    lib = import('pdfjs-dist').then((m) => {
      m.GlobalWorkerOptions.workerSrc = workerUrl;
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
  const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: false, isOffscreenCanvasSupported: false, disableWorkerRendering: true });
  const doc = await task.promise;
  // `_worker` is pdf.js's own field on the loading task (6.5): its port is the
  // Web Worker, or a loopback port when it fell back to the main thread.
  const port = (task as unknown as { _worker?: { port?: unknown } })._worker?.port;
  const mode = typeof Worker !== 'undefined' && port instanceof Worker ? 'worker' : 'main-thread';
  if (!modeLogged) {
    modeLogged = true;
    rlog(mode === 'worker' ? 'info' : 'warn', '[REVIEW] pdf worker', { mode });
  }
  return { doc, mode, destroy: () => task.destroy() };
}
