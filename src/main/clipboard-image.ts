// Clipboard image support for Patton's paste handling.
//   clipboard:readImage — reads the clipboard image ONCE and returns a small
//   thumbnail (<=160px); with save=true it also writes the original bytes
//   under userData/pastes and returns the file's path.
import { app, clipboard, ipcMain, nativeImage } from 'electron';
import type { NativeImage } from 'electron';
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC } from '../shared/constants';
import type { ClipboardImageThumb } from '../shared/types';
import { RateLimiter } from './rate-limiter';

const THUMB_MAX_PX = 160;
const KEEP_NEWEST = 30;

interface ClipboardImage {
  image: NativeImage;
  /** The clipboard's own bytes, written to disk unchanged (no re-encode). */
  bytes: Buffer;
  ext: 'png' | 'jpg';
}

function pastesDir(): string {
  return join(app.getPath('userData'), 'pastes');
}

/** Keep only the newest KEEP_NEWEST pasted images. One unreadable entry
 *  (a dangling symlink, say) must not stop the rest being pruned. */
function prunePastes(dir: string): void {
  try {
    const files: { f: string; t: number }[] = [];
    for (const f of readdirSync(dir)) {
      if (!/\.(png|jpg)$/.test(f)) continue;
      try {
        files.push({ f, t: statSync(join(dir, f)).mtimeMs });
      } catch (err) {
        console.warn('[PASTE] prune: skipping', f, String(err));
      }
    }
    files.sort((a, b) => b.t - a.t);
    for (const old of files.slice(KEEP_NEWEST)) {
      try {
        unlinkSync(join(dir, old.f));
      } catch (err) {
        console.warn('[PASTE] prune: could not remove', old.f, String(err));
      }
    }
  } catch (err) {
    console.warn('[PASTE] prune failed', err);
  }
}

/** PNG first, then JPEG (the two formats createFromBuffer decodes), then the rest. */
function typeRank(t: string): number {
  if (t === 'image/png') return 0;
  if (t === 'image/jpeg') return 1;
  return 2;
}

/**
 * Electron 44 removed the synchronous clipboard.readImage(); clipboard.read()
 * (async, W3C-style) is what is left. Try each image/* entry in turn until one decodes.
 */
async function readClipboardImage(): Promise<ClipboardImage | null> {
  try {
    const items = await clipboard.read();
    for (const item of items) {
      const types = item.types.filter((t) => t.startsWith('image/')).sort((a, b) => typeRank(a) - typeRank(b));
      for (const type of types) {
        try {
          const blob = (await item.getType(type)) as Blob;
          const bytes = Buffer.from(await blob.arrayBuffer());
          const image = nativeImage.createFromBuffer(bytes);
          if (!image.isEmpty()) {
            if (type === 'image/png') return { image, bytes, ext: 'png' };
            if (type === 'image/jpeg') return { image, bytes, ext: 'jpg' };
            return { image, bytes: image.toPNG(), ext: 'png' }; // other formats: PNG is what Claude Code reads
          }
          console.warn('[PASTE] clipboard image did not decode', { type, bytes: bytes.length });
        } catch (err) {
          console.warn('[PASTE] clipboard image type failed', { type, error: String(err) });
        }
      }
    }
  } catch (err) {
    console.warn('[PASTE] clipboard read failed', err);
  }
  return null;
}

function saveBytes(found: ClipboardImage): string | null {
  try {
    const dir = pastesDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // mkdir leaves an existing folder's mode alone
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `${stamp}.${found.ext}`);
    writeFileSync(file, found.bytes, { mode: 0o600 });
    prunePastes(dir);
    console.info('[PASTE] saveImage', { file });
    return file;
  } catch (err) {
    console.error('[PASTE] saveImage failed', err);
    return null;
  }
}

export function registerClipboardImageHandlers(): void {
  const readImageLimiter = new RateLimiter(5);
  ipcMain.handle(IPC.CLIPBOARD_READ_IMAGE, async (_event, save: unknown): Promise<ClipboardImageThumb | null> => {
    if (!readImageLimiter.allow()) {
      console.warn('[SECURITY] Rate limit exceeded', { channel: IPC.CLIPBOARD_READ_IMAGE });
      return null;
    }
    const found = await readClipboardImage();
    if (!found) return null;
    const { width, height } = found.image.getSize();
    if (!width || !height) return null;
    const scale = Math.min(1, THUMB_MAX_PX / Math.max(width, height));
    const thumb = scale < 1
      ? found.image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'good',
      })
      : found.image;
    console.info('[PASTE] readImage', { width, height, save: save === true });
    const result: ClipboardImageThumb = { dataUrl: thumb.toDataURL(), width, height };
    if (save === true) {
      const path = saveBytes(found);
      if (!path) return null;
      result.path = path;
    }
    return result;
  });
}
