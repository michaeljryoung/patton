import { stripPasteControls } from '../services/paste-sanitize';

export interface EditorInputCallbacks {
  onSubmit: (command: string) => void;
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
}

export const DEFAULT_COMPOSE_PLACEHOLDER = 'Enter to send, Shift+Enter for newline, Esc to dismiss';

export class EditorInput {
  private textarea: HTMLTextAreaElement;
  private sendButton: HTMLButtonElement;
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
    this.field.appendChild(this.sendButton);
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

    const keydownHandler = (e: KeyboardEvent) => {
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
        this.callbacks.onSubmit(text);
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

  /** Enter's submit: send the box's text, clear it, flash the bar. */
  private submit(): void {
    const text = this.textarea.value;
    this.callbacks.onSubmit(text);
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

  hasFocus(): boolean {
    return document.activeElement === this.textarea;
  }

  focus(): void {
    this.textarea.focus();
  }

  /** Insert text at the caret (keeps undo history), as if typed. */
  insertText(text: string): void {
    this.textarea.focus();
    document.execCommand('insertText', false, text);
    this.autoResize();
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
    for (const d of this.disposables) d();
    this.field.remove();
  }
}
