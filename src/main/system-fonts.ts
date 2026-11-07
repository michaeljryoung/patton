// Fonts macOS ships but does not expose to apps by family name.
//
// SF Mono is Patton's default terminal font, but macOS keeps it inside
// Terminal.app (and as a hidden system font), so Chromium resolves
// `'SF Mono'` to nothing and falls through to Menlo. Patton reads the Mac's
// own copy at runtime and the renderer registers it with `document.fonts`.
// The files are never copied into the repo or the app bundle (Apple's
// licence), and the paths are fixed here: the renderer never supplies one.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemFontFace, SystemFontFamily } from '../shared/types';

/** Searched in order; the first holding SF-Mono-Regular.otf wins. */
export const SF_MONO_DIRS: readonly string[] = [
  '/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts',
  '/Applications/Utilities/Terminal.app/Contents/Resources/Fonts',
];

const SF_MONO_FACES: readonly { file: string; weight: string; style: SystemFontFace['style'] }[] = [
  { file: 'SF-Mono-Regular.otf', weight: '400', style: 'normal' },
  { file: 'SF-Mono-RegularItalic.otf', weight: '400', style: 'italic' },
  { file: 'SF-Mono-Bold.otf', weight: '700', style: 'normal' },
  { file: 'SF-Mono-BoldItalic.otf', weight: '700', style: 'italic' },
];

/** A font file larger than this is not a font we expect; skip it. */
const MAX_FONT_BYTES = 4 * 1024 * 1024;

/** Reads SF Mono's four faces from the first directory that has them. Never throws. */
export function findSfMono(dirs: readonly string[] = SF_MONO_DIRS): SystemFontFamily | null {
  for (const dir of dirs) {
    if (!existsSync(join(dir, SF_MONO_FACES[0].file))) continue;
    const faces: SystemFontFace[] = [];
    for (const face of SF_MONO_FACES) {
      const path = join(dir, face.file);
      try {
        if (!existsSync(path)) continue;
        const size = statSync(path).size;
        if (size > MAX_FONT_BYTES) {
          console.warn('[FONT] skipped, too large', { path, size });
          continue;
        }
        faces.push({ weight: face.weight, style: face.style, data: new Uint8Array(readFileSync(path)) });
      } catch (err) {
        console.warn('[FONT] could not read', { path, error: String(err) });
      }
    }
    if (faces.length > 0) {
      console.info('[FONT] SF Mono found', {
        dir,
        faces: faces.map(f => `${f.weight}/${f.style}`),
        bytes: faces.reduce((n, f) => n + f.data.byteLength, 0),
      });
      return { family: 'SF Mono', dir, faces };
    }
  }
  console.info('[FONT] SF Mono not on this Mac', { searched: dirs });
  return null;
}

let cached: SystemFontFamily[] | null = null;

/** Every system family Patton registers, read once per run. */
export function getSystemFonts(): SystemFontFamily[] {
  if (cached === null) {
    const sfMono = findSfMono();
    cached = sfMono ? [sfMono] : [];
  }
  return cached;
}
