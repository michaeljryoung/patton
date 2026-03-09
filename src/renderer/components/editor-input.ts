export interface EditorInputCallbacks {
  onSubmit: (command: string) => void;
  onInterrupt: () => void;
  onHistoryUp: () => string | null;
  onHistoryDown: () => string | null;
  onTab: () => void;
  onEscape?: () => void;
}

export class EditorInput {
  private textarea: HTMLTextAreaElement;
  private container: HTMLElement;
  private callbacks: EditorInputCallbacks;

  constructor(container: HTMLElement, callbacks: EditorInputCallbacks, fontSize?: number) {
    this.container = container;
    this.callbacks = callbacks;

    container.setAttribute('role', 'textbox');
    container.setAttribute('aria-label', 'Compose panel');

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'editor-textarea';
    this.textarea.placeholder = 'Enter to send, Shift+Enter for newline, Esc to dismiss';
    this.textarea.rows = 1;
    this.textarea.spellcheck = false;
    this.textarea.autocomplete = 'off';
    if (fontSize) {
      this.textarea.style.fontSize = fontSize + 'px';
    }
    container.appendChild(this.textarea);

    // Auto-resize textarea to content
    this.textarea.addEventListener('input', () => this.autoResize());

    // Intercept paste to bypass macOS IME composition state.
    // Direct textarea.value assignment bypasses Chromium's input state machine,
    // leaving a phantom composition that swallows the next Enter keydown.
    // execCommand('insertText') goes through the proper editing pipeline,
    // correctly terminating any IME composition state.
    this.textarea.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text') || '';
      if (!text) return;
      this.textarea.focus();
      document.execCommand('insertText', false, text);
      this.autoResize();
    });

    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const text = this.textarea.value;
        this.callbacks.onSubmit(text);
        this.clear();
        container.classList.add('submitting');
        setTimeout(() => container.classList.remove('submitting'), 250);
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
    });
  }

  private autoResize(): void {
    this.textarea.style.height = 'auto';
    this.textarea.style.height = Math.min(this.textarea.scrollHeight, 200) + 'px';
  }

  focus(): void {
    this.textarea.focus();
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
    this.textarea.remove();
  }
}
