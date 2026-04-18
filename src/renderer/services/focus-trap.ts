/**
 * Trap keyboard focus within a container.
 *
 * Tab cycles forward through focusable descendants, Shift+Tab cycles backward.
 * When focus would escape either end, it wraps to the other end. Also moves
 * initial focus to the first focusable child (or the container itself) and
 * restores focus to the previously-active element on release.
 *
 * WCAG 2.4.3 (focus order) and standard modal behavior.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  return Array.from(nodes).filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // Skip elements that are not visible (offsetParent === null for display:none)
    if (el.offsetParent === null && el.tagName !== 'BODY') return false;
    return true;
  });
}

export function trapFocus(container: HTMLElement): () => void {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const focusables = getFocusable(container);
  if (focusables.length > 0) {
    focusables[0].focus();
  } else {
    if (!container.hasAttribute('tabindex')) {
      container.setAttribute('tabindex', '-1');
    }
    container.focus();
  }

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const current = getFocusable(container);
    if (current.length === 0) {
      e.preventDefault();
      return;
    }
    const first = current[0];
    const last = current[current.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !container.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  container.addEventListener('keydown', onKeydown);

  return () => {
    container.removeEventListener('keydown', onKeydown);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      try { previouslyFocused.focus(); } catch { /* element may be gone */ }
    }
  };
}
