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
  /**
   * With `shortcutConfirms`: the shortcut confirms only once the dialog has been
   * up this many ms. Before that it is swallowed (not a fresh close either).
   * The quit / close-window dialogs main asks for use it so a double-tap is not
   * a decision. Default 0: the tab-close dialog's "⌘W twice, immediately".
   */
  shortcutDwellMs?: number;
}

/**
 * The one open dialog across every ConfirmDialog instance (tab manager,
 * bookmarks, project board). Their overlays share one z-index, so a later
 * instance paints above an earlier one: with two open, the visible dialog
 * could differ from the one holding focus and the answer. A new confirm()
 * therefore cancels (answers false) whatever else is open, so the dialog being
 * answered is always the visible, focused one.
 */
const openSlot: { dialog: ConfirmDialog | null } = { dialog: null };

/** How the last dialog was answered (for logging). */
export type ConfirmAnswer = 'button' | 'enter' | 'cmd-w' | 'escape' | 'superseded' | 'dismissed';

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
  private shortcutDwellMs = 0;
  private shownAt = 0;
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
    // And a dialog open in another instance (it would paint above or below this one).
    if (openSlot.dialog && openSlot.dialog !== this) openSlot.dialog.finish(false, 'superseded');
    openSlot.dialog = this;
    this.shortcutConfirms = opts.shortcutConfirms === true;
    this.shortcutDwellMs = opts.shortcutDwellMs ?? 0;
    this.shownAt = performance.now();

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
   * Handle a global shortcut (⌘W) while this dialog may be open. Returns true
   * when the shortcut was taken here (it confirmed, or it came inside the
   * dialog's dwell and was swallowed), so the caller does not treat it as a
   * fresh close; false when no shortcut-confirming dialog is open.
   */
  confirmByShortcut(): boolean {
    if (!this.resolve || !this.shortcutConfirms) return false;
    if (performance.now() - this.shownAt < this.shortcutDwellMs) return true;
    this.finish(true, 'cmd-w');
    return true;
  }

  /** Take the open dialog down as cancelled, because someone else (main, for a
   *  quit it already has the answer to) is done with it. No-op when none is open. */
  dismiss(): void {
    this.finish(false, 'dismissed');
  }

  private finish(result: boolean, answer: ConfirmAnswer): void {
    if (!this.resolve) return;
    this.lastAnswer = answer;
    if (openSlot.dialog === this) openSlot.dialog = null;
    this.overlay.classList.remove('visible');
    this.releaseFocusTrap?.();
    this.releaseFocusTrap = null;
    this.resolve?.(result);
    this.resolve = null;
  }

  dispose(): void {
    this.finish(false, 'dismissed');
    for (const d of this.disposables) d();
    this.overlay.remove();
  }
}
