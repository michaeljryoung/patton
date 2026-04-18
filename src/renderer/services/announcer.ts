/**
 * Global aria-live announcer for screen readers.
 *
 * Creates two visually-hidden live regions (polite and assertive) and exposes
 * announce() to push short messages to AT. Polite waits for the current
 * utterance to finish; assertive interrupts. Messages are auto-cleared after
 * 1s so repeated identical strings still get announced (AT ignores duplicates
 * on the same node if the text doesn't change).
 */

let politeRegion: HTMLElement | null = null;
let assertiveRegion: HTMLElement | null = null;

function ensureRegions(): void {
  if (politeRegion && assertiveRegion) return;

  const makeRegion = (priority: 'polite' | 'assertive'): HTMLElement => {
    const el = document.createElement('div');
    el.setAttribute('aria-live', priority);
    el.setAttribute('aria-atomic', 'true');
    el.setAttribute('role', 'status');
    // Visually hidden but readable by AT
    el.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
    document.body.appendChild(el);
    return el;
  };

  politeRegion = makeRegion('polite');
  assertiveRegion = makeRegion('assertive');
}

export function announce(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
  if (!message) return;
  ensureRegions();
  const region = priority === 'assertive' ? assertiveRegion! : politeRegion!;
  // Clear first so that repeat announcements with identical text still fire.
  region.textContent = '';
  // requestAnimationFrame ensures the clear is flushed before the new text.
  requestAnimationFrame(() => {
    region.textContent = message;
  });
  // Clear after a second so stale content isn't read on unrelated navigation.
  setTimeout(() => {
    if (region.textContent === message) region.textContent = '';
  }, 1000);
}
