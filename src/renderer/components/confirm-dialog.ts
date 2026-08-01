import { trapFocus } from '../services/focus-trap';
import { announce } from '../services/announcer';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * Generic yes/no confirmation modal. Mirrors PasteDialog's structure (themed
 * overlay, focus trap, ARIA) but is content-agnostic. Defaults keyboard focus
 * to Cancel so a stray Enter/Escape dismisses without performing the action —
 * the protective convention the native ⌘Q quit-confirm already uses.
 *
 * Fully keyboard-drivable: ←/→ move between the buttons and Enter activates the
 * focused one, so confirming is → then Enter — two deliberate keystrokes rather
 * than a reach for the mouse, while a reflexive bare Enter still cancels. The
 * focused button carries a visible ring (see `.confirm-dialog-footer button` in
 * settings.css); without it the arrow keys would move an invisible selection.
 */
export class ConfirmDialog {
  private overlay: HTMLElement;
  private resolve: ((ok: boolean) => void) | null = null;
  private disposables: (() => void)[] = [];
  private releaseFocusTrap: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'confirm-dialog-overlay';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Confirmation');
    this.overlay.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-dialog-title"></div>
        <div class="confirm-dialog-message"></div>
        <div class="confirm-dialog-footer">
          <button class="confirm-dialog-cancel"></button>
          <button class="confirm-dialog-confirm"></button>
        </div>
      </div>
    `;
    container.appendChild(this.overlay);

    const cancelBtn = this.overlay.querySelector('.confirm-dialog-cancel') as HTMLElement;
    const confirmBtn = this.overlay.querySelector('.confirm-dialog-confirm') as HTMLElement;
    const cancelHandler = () => this.finish(false);
    const confirmHandler = () => this.finish(true);
    cancelBtn.addEventListener('click', cancelHandler);
    confirmBtn.addEventListener('click', confirmHandler);
    this.disposables.push(
      () => cancelBtn.removeEventListener('click', cancelHandler),
      () => confirmBtn.removeEventListener('click', confirmHandler),
    );

    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.finish(false);
        return;
      }
      // Left/Right move between the two buttons, so the whole dialog is
      // keyboard-drivable: → then Enter closes, Enter alone still cancels.
      // Explicit per-key targets rather than index maths — there are exactly
      // two buttons and this reads as what it does.
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        (e.key === 'ArrowRight' ? confirmBtn : cancelBtn).focus();
        return;
      }
      // Confirm on Enter only when the focused control is the confirm button,
      // so a reflexive Enter after an accidental close keystroke cancels.
      if (e.key === 'Enter' && (e.target as HTMLElement)?.classList?.contains('confirm-dialog-confirm')) {
        e.stopPropagation();
        this.finish(true);
      }
    };
    this.overlay.addEventListener('keydown', keydownHandler);
    this.disposables.push(() => this.overlay.removeEventListener('keydown', keydownHandler));
  }

  get isOpen(): boolean {
    return this.resolve !== null;
  }

  async confirm(opts: ConfirmOptions): Promise<boolean> {
    // If a prior dialog is still open (rapid repeat keypress), resolve it as
    // cancelled before reusing the overlay.
    this.resolve?.(false);

    (this.overlay.querySelector('.confirm-dialog-title') as HTMLElement).textContent = opts.title;
    (this.overlay.querySelector('.confirm-dialog-message') as HTMLElement).textContent = opts.message;
    (this.overlay.querySelector('.confirm-dialog-cancel') as HTMLElement).textContent = opts.cancelLabel ?? 'Cancel';
    (this.overlay.querySelector('.confirm-dialog-confirm') as HTMLElement).textContent = opts.confirmLabel ?? 'OK';

    this.overlay.classList.add('visible');
    announce(`${opts.title} ${opts.message}`, 'assertive');
    // Let trapFocus capture the real previously-focused element (the xterm
    // textarea) *before* moving focus. Cancel is first in DOM order, so trapFocus
    // lands on it by default — giving us a Cancel-focused dialog AND correct
    // focus restoration to the terminal when it closes.
    this.releaseFocusTrap?.();
    this.releaseFocusTrap = trapFocus(this.overlay);

    return new Promise<boolean>((resolve) => {
      this.resolve = resolve;
    });
  }

  private finish(result: boolean): void {
    this.overlay.classList.remove('visible');
    this.releaseFocusTrap?.();
    this.releaseFocusTrap = null;
    this.resolve?.(result);
    this.resolve = null;
  }

  dispose(): void {
    for (const d of this.disposables) d();
    this.overlay.remove();
  }
}
