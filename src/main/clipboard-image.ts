// Clipboard image support for Patton's paste handling.
//   clipboard:readImage — small thumbnail (<=160px) of the clipboard image, or null
//   clipboard:saveImage — full-size PNG saved under userData/pastes, returns its path
import { app, clipboard, ipcMain, nativeImage } from 'electron';
import type { NativeImage } from 'electron';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC } from '../shared/constants';
import type { ClipboardImageThumb } from '../shared/types';

const THUMB_MAX_PX = 160;
const KEEP_NEWEST = 30;

function pastesDir(): string {
  return join(app.getPath('userData'), 'pastes');
}

/** Keep only the newest KEEP_NEWEST pasted PNGs. */
function prunePastes(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(KEEP_NEWEST)) {
      unlinkSync(join(dir, old.f));
    }
  } catch (err) {
    console.warn('[PASTE] prune failed', err);
  }
}

/**
 * Electron 44 removed the synchronous clipboard.readImage(); clipboard.read()
 * (async, W3C-style) is what is left. Take the first image/* entry, preferring PNG.
 */
async function readClipboardImage(): Promise<NativeImage | null> {
  try {
    const items = await clipboard.read();
    for (const item of items) {
      const type = item.types.includes('image/png')
        ? 'image/png'
        : item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = (await item.getType(type)) as Blob;
      const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      if (!image.isEmpty()) return image;
    }
  } catch (err) {
    console.warn('[PASTE] clipboard read failed', err);
  }
  return null;
}

export function registerClipboardImageHandlers(): void {
  ipcMain.handle(IPC.CLIPBOARD_READ_IMAGE, async (): Promise<ClipboardImageThumb | null> => {
    const image = await readClipboardImage();
    if (!image) return null;
    const { width, height } = image.getSize();
    if (!width || !height) return null;
    const scale = Math.min(1, THUMB_MAX_PX / Math.max(width, height));
    const thumb = scale < 1
      ? image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'good',
      })
      : image;
    console.info('[PASTE] readImage', { width, height });
    return { dataUrl: thumb.toDataURL(), width, height };
  });

  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, async (): Promise<string | null> => {
    const image = await readClipboardImage();
    if (!image) return null;
    try {
      const dir = pastesDir();
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(dir, `${stamp}.png`);
      writeFileSync(file, image.toPNG());
      prunePastes(dir);
      console.info('[PASTE] saveImage', { file });
      return file;
    } catch (err) {
      console.error('[PASTE] saveImage failed', err);
      return null;
    }
  });
}
