// Registers the fonts main read from the Mac's own files (SF Mono from
// Terminal.app) in `document.fonts`, so `'SF Mono'` in a font stack draws
// SF Mono instead of falling through to Menlo. Must finish before any
// terminal is created or measured: xterm measures its cell once per
// fontFamily/fontSize change and never again on its own.

import type { SystemFontFamily } from '../../shared/types';
import { rlog } from './renderer-logger';

export interface FontRegistry {
  add(face: FontFace): unknown;
}

/**
 * Adds a family's faces under its name, but only when its Regular face (400,
 * normal) loaded: a family missing it answers every normal-weight request with
 * the nearest weight, so a lone Bold face would make all text bold. A family
 * without a loaded Regular face adds nothing and is logged. A single other face
 * that fails is skipped. Returns the faces added.
 */
export async function registerSystemFonts(
  families: readonly SystemFontFamily[],
  registry: FontRegistry = document.fonts,
): Promise<number> {
  let added = 0;
  for (const family of families) {
    const loaded: { face: FontFace; regular: boolean }[] = [];
    for (const face of family.faces) {
      try {
        const ff = new FontFace(family.family, face.data, { weight: face.weight, style: face.style });
        await ff.load();
        loaded.push({ face: ff, regular: face.weight === '400' && face.style === 'normal' });
      } catch (err) {
        rlog('warn', '[FONT] face failed to load', { family: family.family, weight: face.weight, style: face.style, error: String(err) });
      }
    }
    if (!loaded.some(l => l.regular)) {
      rlog('warn', '[FONT] Regular face did not load; registering none of this family', { family: family.family, loaded: loaded.length });
      continue;
    }
    for (const l of loaded) {
      registry.add(l.face);
      added++;
    }
  }
  return added;
}

/** Asks main for the system fonts and registers them. Never rejects: missing fonts fall back to the stack. */
export async function loadSystemFonts(): Promise<void> {
  try {
    const families = await window.patton.fonts.getSystem();
    if (families.length === 0) {
      rlog('info', '[FONT] no system fonts to register; SF Mono falls back to the next font in the stack');
      return;
    }
    const added = await registerSystemFonts(families);
    rlog('info', '[FONT] registered', {
      families: families.map(f => ({ family: f.family, dir: f.dir, faces: f.faces.length })),
      added,
    });
  } catch (err) {
    rlog('warn', '[FONT] system fonts unavailable; using the fallback stack', { error: String(err) });
  }
}
