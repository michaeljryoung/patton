import { stripPasteControls } from '../services/paste-sanitize';
import { rlog } from '../services/renderer-logger';

export interface EditorInputCallbacks {
  /** Send the box's text. Return false to refuse: the draft stays in the box. */
  onSubmit: (command: string) => boolean | void;
  onInterrupt: () => void;
  onHistoryUp: () => string | null;
  onHistoryDown: () => string | null;
  onTab: () => void;
  onEscape?: () => void;
  /** Paste with no text on the clipboard — it may hold an image. */
  onImagePaste?: () => void;
  /**
   * A key pressed while the box is empty. Return true when the owner has
   * handled it (compose-first forwards it to the program in the terminal);
   * the box then does nothing else with it.
   */
  onEmptyBoxKey?: (e: KeyboardEvent) => boolean;
  /** Tallest the textarea may grow, in px (default 200). Read on every resize. */
  getMaxHeight?: () => number;
  /** ⌘C with nothing selected in the box: text to copy instead (the pane's
   *  terminal selection), or '' to let the copy run as usual. */
  getCopyFallback?: () => string;
}

export const DEFAULT_COMPOSE_PLACEHOLDER = 'Enter to send, Shift+Enter for newline, Esc to dismiss';

/** The box stepped aside: a short label in Send's place, and the full words
 *  as its title and for the live region. */
export interface EditorAside {
  label: string;
  title: string;
}

export class EditorInput {
  private textarea: HTMLTextAreaElement;
  private sendButton: HTMLButtonElement;
  // Send's slot: Send, the aside label and a hidden sizer share one grid
  // cell, so the slot is one width whichever shows and the textarea never
  // reflows when the box steps aside.
  private sendSlot: HTMLElement;
  private asideLabel: HTMLElement;
  private slotSizer: HTMLElement;
  // Announces the aside words; visually hidden, out of the layout.
  private liveRegion: HTMLElement;
  private aside: EditorAside | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private field: HTMLElement;
  private container: HTMLElement;
  private callbacks: EditorInputCallbacks;
  private disposables: (() => void)[] = [];

  constructor(container: HTMLElement, callbacks: EditorInputCallbacks, fontSize?: number) {
    this.container = container;
    this.callbacks = callbacks;

    // A group, not a textbox: it holds the textarea (the textbox) and Send.
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Compose panel');

    this.field = document.createElement('div');
    this.field.className = 'editor-field';
    container.appendChild(this.field);

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'editor-textarea';
    this.textarea.placeholder = DEFAULT_COMPOSE_PLACEHOLDER;
    this.textarea.rows = 1;
    this.textarea.spellcheck = false;
    this.textarea.autocomplete = 'off';
    this.textarea.setAttribute('aria-label', 'Compose');
    if (fontSize) {
      this.textarea.style.fontSize = fontSize + 'px';
    }
    this.field.appendChild(this.textarea);

    // Send: a click does exactly what Enter does in the box.
    this.sendButton = document.createElement('button');
    this.sendButton.type = 'button';
    this.sendButton.className = 'editor-send';
    this.sendButton.textContent = 'Send';
    this.sendButton.setAttribute('aria-label', 'Send');
    this.sendButton.title = 'Send (Enter)';
    this.sendSlot = document.createElement('div');
    this.sendSlot.className = 'editor-send-slot';
    this.sendSlot.appendChild(this.sendButton);
    this.asideLabel = document.createElement('span');
    this.asideLabel.className = 'editor-aside-label';
    this.asideLabel.setAttribute('aria-hidden', 'true'); // the live region speaks for it
    this.sendSlot.appendChild(this.asideLabel);
    this.slotSizer = document.createElement('span');
    this.slotSizer.className = 'editor-send-sizer';
    this.slotSizer.setAttribute('aria-hidden', 'true');
    this.sendSlot.appendChild(this.slotSizer);
    this.field.appendChild(this.sendSlot);
    this.liveRegion = document.createElement('span');
    this.liveRegion.className = 'editor-aside-live';
    this.liveRegion.setAttribute('role', 'status');
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.field.appendChild(this.liveRegion);
    // A mouse click mustn't pull focus out of the box (compose-first keeps it there).
    const sendMouseDown = (e: MouseEvent) => e.preventDefault();
    const sendClick = () => this.sendLikeEnter();
    this.sendButton.addEventListener('mousedown', sendMouseDown);
    this.sendButton.addEventListener('click', sendClick);
    this.disposables.push(() => {
      this.sendButton.removeEventListener('mousedown', sendMouseDown);
      this.sendButton.removeEventListener('click', sendClick);
    });

    // Auto-resize textarea to content
    const inputHandler = () => this.autoResize();
    this.textarea.addEventListener('input', inputHandler);
    this.disposables.push(() => this.textarea.removeEventListener('input', inputHandler));

    // Intercept paste to bypass macOS IME composition state.
    // Direct textarea.value assignment bypasses Chromium's input state machine,
    // leaving a phantom composition that swallows the next Enter keydown.
    // execCommand('insertText') goes through the proper editing pipeline,
    // correctly terminating any IME composition state.
    const pasteHandler = (e: ClipboardEvent) => {
      e.preventDefault();
      const raw = e.clipboardData?.getData('text') || '';
      if (!raw) {
        this.callbacks.onImagePaste?.();
        return;
      }
      // Same strip as a terminal paste: an ESC[201~ in the text would end the
      // bracketed paste that sends a multi-line draft, and run the rest as keys.
      const text = stripPasteControls(raw);
      if (!text) return;
      this.textarea.focus();
      document.execCommand('insertText', false, text);
      this.autoResize();
    };
    this.textarea.addEventListener('paste', pasteHandler as EventListener);
    this.disposables.push(() => this.textarea.removeEventListener('paste', pasteHandler as EventListener));

    // ⌘C with nothing selected in the box copies the owner's fallback (the
    // terminal's selection). Both routes: the key itself, and the copy event
    // the Edit menu's Copy raises.
    const copyFallback = (): string =>
      this.textarea.selectionStart === this.textarea.selectionEnd ? (this.callbacks.getCopyFallback?.() ?? '') : '';
    const copyHandler = (e: ClipboardEvent) => {
      const text = copyFallback();
      if (!text || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    this.textarea.addEventListener('copy', copyHandler);
    this.disposables.push(() => this.textarea.removeEventListener('copy', copyHandler));

    const keydownHandler = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c' && !e.isComposing) {
        const text = copyFallback();
        if (text) {
          e.preventDefault();
          void navigator.clipboard.writeText(text).catch((err) => {
            rlog('warn', '[COMPOSE] copy failed', { error: String(err) });
            this.copyByCommand();
          });
          return;
        }
      }
      // Mid-IME composition the box's value isn't settled yet, so never pass through.
      if (!e.isComposing && this.textarea.value === '' && this.callbacks.onEmptyBoxKey?.(e)) {
        e.preventDefault();
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        this.submit();
        return;
      }

      // Cmd+Enter: also submit (alternative for multi-line)
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const text = this.textarea.value;
        if (this.callbacks.onSubmit(text) === false) return; // refused: the draft stays
        this.clear();
        return;
      }

      if (e.key === 'ArrowUp') {
        if (this.textarea.selectionStart === 0 && this.textarea.value === '') {
          const prev = this.callbacks.onHistoryUp();
          if (prev !== null) {
            this.setValue(prev);
            e.preventDefault();
          }
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        if (this.textarea.selectionStart === this.textarea.value.length && this.textarea.value === '') {
          const next = this.callbacks.onHistoryDown();
          if (next !== null) {
            this.setValue(next);
            e.preventDefault();
          }
        }
        return;
      }

      if (e.key === 'c' && e.ctrlKey) {
        this.callbacks.onInterrupt();
        this.clear();
        e.preventDefault();
        return;
      }

      if (e.key === 'Tab') {
        this.callbacks.onTab();
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape') {
        this.callbacks.onEscape?.();
        e.preventDefault();
        return;
      }
    };
    this.textarea.addEventListener('keydown', keydownHandler);
    this.disposables.push(() => this.textarea.removeEventListener('keydown', keydownHandler));
  }

  /** The clipboard API refused ⌘C's copy: copy through the editing command
   *  instead. It raises a copy event on the box, which copyHandler fills with
   *  the same fallback text (the terminal's selection). */
  private copyByCommand(): void {
    let ok = false;
    try {
      ok = document.activeElement === this.textarea && typeof document.execCommand === 'function'
        && document.execCommand('copy');
    } catch (err) {
      rlog('warn', '[COMPOSE] copy fallback failed', { error: String(err) });
      return;
    }
    rlog(ok ? 'info' : 'warn', '[COMPOSE] copy fallback', { ok });
  }

  /** Enter's submit: send the box's text, clear it, flash the bar. A refused
   *  send leaves the draft and no flash. */
  private submit(): void {
    const text = this.textarea.value;
    if (this.callbacks.onSubmit(text) === false) return;
    this.clear();
    this.container.classList.add('submitting');
    setTimeout(() => this.container.classList.remove('submitting'), 250);
  }

  /**
   * The Send button: the same path a plain Enter takes in the keydown handler,
   * including an empty box's Enter going to the program (compose-first).
   */
  private sendLikeEnter(): void {
    if (this.textarea.value === '' && this.callbacks.onEmptyBoxKey?.(new KeyboardEvent('keydown', { key: 'Enter' }))) {
      return;
    }
    this.submit();
  }

  private autoResize(): void {
    // In a hidden tab (display:none) scrollHeight is 0, and writing it would
    // leave a zero-height box; Pane.show() redoes this once it's visible.
    if (this.textarea.getClientRects().length === 0) return;
    const cap = this.callbacks.getMaxHeight?.() ?? 200;
    this.textarea.style.height = 'auto';
    const full = this.textarea.scrollHeight;
    this.textarea.style.height = Math.min(full, cap) + 'px';
    // Past the cap the textarea scrolls itself, with a visible scrollbar.
    this.textarea.style.overflowY = full > cap ? 'auto' : 'hidden';
  }

  /** Re-apply the height cap (after the cap or the pane's size changed). */
  refreshSize(): void {
    this.autoResize();
  }

  setPlaceholder(text: string): void {
    this.textarea.placeholder = text;
  }

  setSpellcheck(enabled: boolean): void {
    this.textarea.spellcheck = enabled;
  }

  /** The box's row of controls (textarea, Send's slot): Pane puts the Okay?
   *  button first in it, at the box's left (docs/compose-box.md D11). */
  get fieldElement(): HTMLElement {
    return this.field;
  }

  hasFocus(): boolean {
    return document.activeElement === this.textarea;
  }

  focus(): void {
    this.textarea.focus();
  }

  /** Insert text at the caret (keeps undo history), as if typed. With
   *  `focus: false` the keyboard stays where it is: the text goes in at the
   *  box's caret without the editing command (no undo step). */
  insertText(text: string, opts: { focus?: boolean } = {}): void {
    if (opts.focus === false && document.activeElement !== this.textarea) {
      const { selectionStart, selectionEnd } = this.textarea;
      this.textarea.setRangeText(text, selectionStart, selectionEnd, 'end');
    } else {
      this.textarea.focus();
      document.execCommand('insertText', false, text);
    }
    this.autoResize();
  }

  /** Every label Send's slot may show: the slot takes the widest, so it keeps
   *  one width whichever shows. */
  reserveSlotWidthFor(labels: readonly string[]): void {
    this.slotSizer.replaceChildren(...labels.map((text) => {
      const span = document.createElement('span');
      span.textContent = text;
      return span;
    }));
  }

  /** Step aside (a label in Send's place, the full words announced) or come
   *  back (null). Only the slot's contents change, never its size. */
  setAside(aside: EditorAside | null): void {
    this.clearFlash();
    this.aside = aside;
    this.sendSlot.classList.toggle('aside', aside !== null);
    this.asideLabel.textContent = aside?.label ?? '';
    if (aside) this.asideLabel.title = aside.title;
    else this.asideLabel.removeAttribute('title');
    this.liveRegion.textContent = aside?.title ?? '';
  }

  /** The label reads `text` for `ms` in Send's slot (also before the box is
   *  aside, Send's place taken for the flash only), then the slot and the
   *  live region show the current aside words again, or Send. */
  flashAsideLabel(text: string, ms: number): void {
    this.clearFlash();
    this.asideLabel.textContent = text;
    this.sendSlot.classList.add('aside', 'flash');
    this.liveRegion.textContent = text;
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.clearFlash();
    }, ms);
  }

  /** End a flash: the slot shows what the aside state says (or Send). */
  private clearFlash(): void {
    if (this.flashTimer !== null) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    if (!this.sendSlot.classList.contains('flash')) return;
    this.sendSlot.classList.remove('flash');
    this.sendSlot.classList.toggle('aside', this.aside !== null);
    this.asideLabel.textContent = this.aside?.label ?? '';
    this.liveRegion.textContent = this.aside?.title ?? '';
  }

  clear(): void {
    this.textarea.value = '';
    this.autoResize();
  }

  setValue(text: string): void {
    this.textarea.value = text;
    this.textarea.selectionStart = text.length;
    this.textarea.selectionEnd = text.length;
    this.autoResize();
  }

  getValue(): string {
    return this.textarea.value;
  }

  setFontSize(size: number): void {
    this.textarea.style.fontSize = size + 'px';
  }

  setFontFamily(family: string): void {
    this.textarea.style.fontFamily = family;
  }

  dispose(): void {
    this.clearFlash();
    for (const d of this.disposables) d();
    this.field.remove();
  }
}
