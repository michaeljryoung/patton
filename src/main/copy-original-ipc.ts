/**
 * IPC for copying Claude's original text (copy-original.ts). A window may copy
 * only through its own PTYs. 'refused' means nothing was written: the renderer
 * then copies the drawn text itself, so a refused call never loses a copy.
 */
import { BrowserWindow, clipboard, ClipboardItem, ipcMain } from 'electron';
import { IPC } from '../shared/constants';
import type { CopySelectionResult } from '../shared/types';
import { CopyOriginal } from './copy-original';
import type { PtyManager } from './pty-manager';
import { RateLimiter } from './rate-limiter';
import type { SessionFeed } from './session-feed';
import { TranscriptTexts } from './transcript-texts';

const MAX_SELECTION_CHARS = 1_000_000;

export function registerCopyOriginalHandlers(ptyManager: PtyManager, feed: SessionFeed): void {
  const texts = new TranscriptTexts();
  const copier = new CopyOriginal({
    transcriptFor: (ptyId) => feed.transcriptFor(ptyId),
    recentTexts: (path) => texts.recent(path),
    clipboard: {
      writeText: (text) => clipboard.writeText(text),
      write: (data) => clipboard.write([new ClipboardItem({ 'text/plain': data.text, 'text/html': data.html })]),
      readText: () => clipboard.readText(),
    },
  });
  // A copy is one keypress; copy-on-select upgrades are debounced in the pane.
  const limiter = new RateLimiter(20);

  ipcMain.handle(IPC.CLIPBOARD_COPY_SELECTION, async (event, ptyId: unknown, text: unknown, mode: unknown): Promise<CopySelectionResult> => {
    if (typeof ptyId !== 'number' || !Number.isInteger(ptyId) || ptyId <= 0
      || typeof text !== 'string' || text.length === 0 || text.length > MAX_SELECTION_CHARS
      || (mode !== 'copy' && mode !== 'upgrade')) {
      console.warn('[SECURITY] CLIPBOARD_COPY_SELECTION type validation failed', { ptyId: typeof ptyId, text: typeof text, mode: typeof mode });
      return 'refused';
    }
    if (!limiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.CLIPBOARD_COPY_SELECTION });
      return 'refused';
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !ptyManager.validateOwnership(ptyId, win)) {
      console.warn('[SECURITY] PTY ownership check failed', { channel: IPC.CLIPBOARD_COPY_SELECTION, id: ptyId });
      return 'refused';
    }
    try {
      return await copier.copy(ptyId, text, mode);
    } catch (err) {
      console.warn('[COPY] fallback', { pty: ptyId, reason: `error ${(err as Error).name}` });
      return 'refused';
    }
  });
}
