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
  private captureHandler: (e: KeyboardEvent) => void;

  constructor(container: HTMLElement, callbacks: EditorInputCallbacks, fontSize?: number) {
    this.container = container;
    this.callbacks = callbacks;

    container.setAttribute('role', 'textbox');
    container.setAttribute('aria-label', 'Command input');

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'editor-textarea';
    this.textarea.placeholder = 'Type here, Enter sends';
    this.textarea.rows = 1;
    this.textarea.spellcheck = false;
    this.textarea.autocomplete = 'off';
    if (fontSize) {
      this.textarea.style.fontSize = fontSize + 'px';
    }
    container.appendChild(this.textarea);

    // Auto-resize textarea to content
    this.textarea.addEventListener('input', () => this.autoResize());

    // PRIMARY: window-level capture handler for Enter.
    // Fires FIRST in the entire event chain — before the event reaches
    // any element. This guarantees Enter submits regardless of what
    // else might intercept it (xterm.js, Electron, other listeners).
    this.captureHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey
          && document.activeElement === this.textarea) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const text = this.textarea.value;
        // DEBUG: show submit in window title (remove after fix confirmed)
        document.title = `[SENT] ${text.substring(0, 20)} @${Date.now() % 10000}`;
        this.callbacks.onSubmit(text);
        this.clear();
        container.classList.add('submitting');
        setTimeout(() => container.classList.remove('submitting'), 250);
      }
    };
    window.addEventListener('keydown', this.captureHandler, true);

    // SECONDARY: textarea-level handler for non-Enter keys
    this.textarea.addEventListener('keydown', (e) => {
      // Enter is handled by the capture handler above
      if (e.key === 'Enter') return;

      if (e.key === 'ArrowUp' && this.textarea.selectionStart === 0) {
        const prev = this.callbacks.onHistoryUp();
        if (prev !== null) {
          this.setValue(prev);
          e.preventDefault();
        }
        return;
      }

      if (e.key === 'ArrowDown' && this.textarea.selectionStart === this.textarea.value.length) {
        const next = this.callbacks.onHistoryDown();
        if (next !== null) {
          this.setValue(next);
          e.preventDefault();
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

  show(): void {
    this.container.classList.remove('hidden');
  }

  hide(): void {
    this.container.classList.add('hidden');
  }

  setFontSize(size: number): void {
    this.textarea.style.fontSize = size + 'px';
  }

  dispose(): void {
    window.removeEventListener('keydown', this.captureHandler, true);
    this.textarea.remove();
  }
}
