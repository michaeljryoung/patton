/**
 * Copying a Claude tab's terminal selection (main/copy-original.ts): main puts
 * Claude's original text on the clipboard, or the drawn text when it finds
 * none. Anything main refuses, or an IPC failure, is copied here as drawn, so
 * a copy is never lost. Panes that aren't Claude tabs never come here.
 */
import { rlog } from './renderer-logger';

type CopyApi = (ptyId: number, text: string, mode: 'copy' | 'upgrade') => Promise<string>;

function api(): CopyApi | null {
  const fn = (window as unknown as { patton?: { clipboard?: { copySelection?: CopyApi } } }).patton?.clipboard?.copySelection;
  return typeof fn === 'function' ? fn : null;
}

/** False without main's copy (an older preload, a test harness): callers keep today's copy. */
export function canCopyOriginal(): boolean {
  return api() !== null;
}

async function writeDrawn(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    rlog('warn', '[COPY] renderer write failed', { error: String(err) });
  }
}

/** ⌘C, Edit ▸ Copy, the context menu: main writes the clipboard. */
export async function copyClaudeSelection(ptyId: number, text: string): Promise<void> {
  if (!text) return;
  const copy = api();
  if (!copy) { await writeDrawn(text); return; }
  let result: unknown = 'refused';
  try {
    result = await copy(ptyId, text, 'copy');
  } catch (err) {
    rlog('warn', '[COPY] fallback', { reason: 'ipc failed', error: String(err) });
  }
  // Anything but main's own answers means main wrote nothing.
  if (result !== 'original' && result !== 'fallback' && result !== 'late') await writeDrawn(text);
}

/** Copy-on-select already wrote the drawn text: main may replace it with the original. */
export async function upgradeClaudeSelection(ptyId: number, text: string): Promise<void> {
  const copy = api();
  if (!copy || !text) return;
  try {
    await copy(ptyId, text, 'upgrade');
  } catch (err) {
    rlog('warn', '[COPY] upgrade failed', { error: String(err) });
  }
}
