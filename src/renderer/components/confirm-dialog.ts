import { trapFocus } from '../services/focus-trap';
import { announce } from '../services/announcer';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Which button gets keyboard focus when the dialog opens. 'cancel' (the
   * default) makes a bare Enter cancel; 'confirm' makes a bare Enter confirm.
   */
  defaultFocus?: 'cancel' | 'confirm';
  /**
   * When true, `confirmByShortcut()` confirms this dialog while it is open —
   * the tab-close dialog uses it so a second ⌘W confirms the first.
   */
  shortcutConfirms?: boolean;
}

/** How the last dialog was answered (for logging). */
export type ConfirmAnswer = 'button' | 'enter' | 'cmd-w' | 'escape' | 'superseded';

/**
 * Generic yes/no confirmation modal. Mirrors PasteDialog's structure (themed
 * overlay, focus trap, ARIA) but is content-agnostic. Two focus modes, chosen
 * per call with `defaultFocus`:
 *
 * - 'cancel' (the default; bookmarks panel, project board): keyboard focus
 *   starts on Cancel so a stray Enter/Escape dismisses without performing the
 *   action — the protective convention the native ⌘Q quit-confirm already
 *   uses. ←/→ move between the buttons and Enter activates the focused one, so
 *   confirming is → then Enter — two deliberate keystrokes — while a
 *   reflexive bare Enter still cancels.
 * - 'confirm' (the tab/pane close prompt): focus starts on the confirm button,
 *   so Enter confirms, and with `shortcutConfirms` a second press of the
 *   shortcut that opened the dialog (⌘W, via `confirmByShortcut()`) confirms
 *   it too — ⌘W twice closes. Escape and Cancel still cancel.
 *
 * The focused button carries a visible ring (see `.confirm-dialog-footer
 * button` in settings.css); without it the arrow keys would move an invisible
 * selection. `lastAnswer` records how the most recent dialog was answered.
 */
export class ConfirmDialog {
  private overlay: HTMLElement;
  private resolve: ((ok: boolean) => void) | null = null;
  private disposables: (() => void)[] = [];
  private releaseFocusTrap: (() => void) | null = null;
  private shortcutConfirms = false;
  /** How the most recent dialog was answered; null before the first. */
  lastAnswer: ConfirmAnswer | null = null;

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
    const cancelHandler = () => this.finish(false, 'button');
    const confirmHandler = () => this.finish(true, 'button');
    cancelBtn.addEventListener('click', cancelHandler);
    confirmBtn.addEventListener('click', confirmHandler);
    this.disposables.push(
      () => cancelBtn.removeEventListener('click', cancelHandler),
      () => confirmBtn.removeEventListener('click', confirmHandler),
    );

    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.finish(false, 'escape');
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
        this.finish(true, 'enter');
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
    this.finish(false, 'superseded');
    this.shortcutConfirms = opts.shortcutConfirms === true;

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
    // trapFocus lands on Cancel (first in DOM order); move on for confirm mode.
    // The trap already captured the terminal as the element to restore.
    if (opts.defaultFocus === 'confirm') {
      (this.overlay.querySelector('.confirm-dialog-confirm') as HTMLElement).focus();
    }

    return new Promise<boolean>((resolve) => {
      this.resolve = resolve;
    });
  }

  /**
   * Confirm the open dialog from a global shortcut (⌘W). Returns true when it
   * did, so the caller knows not to treat the shortcut as a fresh close.
   */
  confirmByShortcut(): boolean {
    if (!this.resolve || !this.shortcutConfirms) return false;
    this.finish(true, 'cmd-w');
    return true;
  }

  private finish(result: boolean, answer: ConfirmAnswer): void {
    if (!this.resolve) return;
    this.lastAnswer = answer;
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
