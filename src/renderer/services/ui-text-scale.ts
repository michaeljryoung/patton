import { uiTextScaleOf } from '../../shared/constants';
import { rlog } from './renderer-logger';

/**
 * Interface Text Size. One custom property, `--ui-scale`, on :root; main.css
 * multiplies its text tokens (--ui, --head, --title) and every other interface
 * font-size by it. The terminal keeps its own Font Size and never reads it.
 */
let applied: number | null = null;
const listeners = new Set<() => void>();

/** Call `cb` after every real change of the scale (not the first apply's repeats). */
export function onUiTextScaleApplied(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Apply a saved value (anything not allowed becomes 1) and log when it changes. */
export function applyUiTextScale(value: unknown, why: 'startup' | 'change'): void {
  const scale = uiTextScaleOf(value);
  if (scale === applied) return;
  applied = scale;
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  rlog('info', `[SETTINGS] uiTextScale ${scale}`, { why });
  for (const cb of listeners) cb();
}
