// The Font Family choices in Settings, and which of them actually draw here.
//
// Chromium silently substitutes a fallback for a family that isn't installed,
// so a list of names alone can offer fonts that all look like Menlo. A family
// draws if text set in `'<family>', <generic>` measures differently from the
// generic alone, for either of two different generics.

import { DEFAULTS } from '../../shared/constants';

export interface FontChoice {
  /** The family the choice is named after (first in its stack). */
  family: string;
  /** The saved setting: a CSS font-family stack. Never change an existing one: saved settings match on it. */
  value: string;
}

export const FONT_CHOICES: readonly FontChoice[] = [
  { family: 'SF Mono', value: DEFAULTS.FONT_FAMILY },
  { family: 'Menlo', value: "'Menlo', 'Monaco', 'Courier New', monospace" },
  { family: 'Monaco', value: "'Monaco', 'Courier New', monospace" },
  { family: 'JetBrains Mono', value: "'JetBrains Mono', 'Fira Code', monospace" },
  { family: 'Fira Code', value: "'Fira Code', monospace" },
  { family: 'IBM Plex Mono', value: "'IBM Plex Mono', 'Menlo', monospace" },
  { family: 'Source Code Pro', value: "'Source Code Pro', 'Menlo', monospace" },
  { family: 'Hack', value: "'Hack', 'Menlo', monospace" },
  { family: 'Cascadia Code', value: "'Cascadia Code', 'Menlo', monospace" },
  { family: 'Geist Mono', value: "'Geist Mono', 'Menlo', monospace" },
  { family: 'PT Mono', value: "'PT Mono', 'Menlo', monospace" },
  { family: 'Andale Mono', value: "'Andale Mono', 'Menlo', monospace" },
  { family: 'Courier New', value: "'Courier New', monospace" },
];

const SAMPLE = 'mmmmmmmmmmlli1WW@@ilil0O';

/** A measurer for `fontDraws`: a 2D canvas context. */
export interface TextMeasurer {
  font: string;
  measureText(text: string): { width: number };
}

let sharedCtx: TextMeasurer | null = null;
function defaultMeasurer(): TextMeasurer {
  if (!sharedCtx) {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) throw new Error('no 2d canvas context');
    sharedCtx = ctx;
  }
  return sharedCtx;
}

function widthOf(ctx: TextMeasurer, stack: string): number {
  ctx.font = `40px ${stack}`;
  return ctx.measureText(SAMPLE).width;
}

/** True when `family` is installed or registered and Chromium draws it. */
export function fontDraws(family: string, ctx: TextMeasurer = defaultMeasurer()): boolean {
  const quoted = `'${family.replace(/['"\\]/g, '')}'`;
  for (const generic of ['sans-serif', 'serif']) {
    if (widthOf(ctx, `${quoted}, ${generic}`) !== widthOf(ctx, generic)) return true;
  }
  return false;
}

/** The family a saved stack is named after: its first entry, unquoted. */
export function firstFamily(stack: string): string {
  return (stack.split(',')[0] || '').trim().replace(/^['"]|['"]$/g, '');
}

export interface FontOption {
  value: string;
  label: string;
  available: boolean;
}

/**
 * The options Settings shows: every choice that draws here, plus the saved
 * value when it doesn't (labelled so the select never shows another font
 * in its place).
 */
export function buildFontOptions(saved: string | undefined, draws: (family: string) => boolean): FontOption[] {
  const options: FontOption[] = [];
  let savedListed = false;
  for (const choice of FONT_CHOICES) {
    const available = draws(choice.family);
    const isSaved = choice.value === saved;
    if (!available && !isSaved) continue;
    options.push({ value: choice.value, label: available ? choice.family : `${choice.family} (not on this Mac)`, available });
    if (isSaved) savedListed = true;
  }
  if (saved && !savedListed) {
    const family = firstFamily(saved) || saved;
    const available = draws(family);
    options.push({ value: saved, label: available ? family : `${family} (not on this Mac)`, available });
  }
  return options;
}
