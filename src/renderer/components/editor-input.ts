export interface EditorInputCallbacks {
  onSubmit: (command: string) => void;
  onInterrupt: () => void;
  onHistoryUp: () => string | null;
  onHistoryDown: () => string | null;
  onTab: () => void;
  onEscape?: () => void;
  onPassthroughInput?: (data: string) => void;
}

export class EditorInput {
  private textarea: HTMLTextAreaElement;
  private container: HTMLElement;
  private callbacks: EditorInputCallbacks;
  private _passthroughMode = false;

  constructor(container: HTMLElement, callbacks: EditorInputCallbacks, fontSize?: number) {
    this.container = container;
    this.callbacks = callbacks;

    container.setAttribute('role', 'textbox');
    container.setAttribute('aria-label', 'Command input');

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'editor-textarea';
    this.textarea.placeholder = 'Enter to send, Shift+Enter for newline';
    this.textarea.rows = 1;
    this.textarea.spellcheck = false;
    this.textarea.autocomplete = 'off';
    if (fontSize) {
      this.textarea.style.fontSize = fontSize + 'px';
    }
    container.appendChild(this.textarea);

    // Auto-resize textarea to content
    this.textarea.addEventListener('input', () => this.autoResize());

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

      if (e.key === 'ArrowUp' && this.textarea.selectionStart === 0) {
        if (this._passthroughMode && !this.textarea.value) {
          this.callbacks.onPassthroughInput?.('\x1b[A');
          e.preventDefault();
          return;
        }
        const prev = this.callbacks.onHistoryUp();
        if (prev !== null) {
          this.setValue(prev);
          e.preventDefault();
        }
        return;
      }

      if (e.key === 'ArrowDown' && this.textarea.selectionStart === this.textarea.value.length) {
        if (this._passthroughMode && !this.textarea.value) {
          this.callbacks.onPassthroughInput?.('\x1b[B');
          e.preventDefault();
          return;
        }
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

  setFontFamily(family: string): void {
    this.textarea.style.fontFamily = family;
  }

  /** Physically enable/disable the textarea to prevent unfocused panes from stealing keyboard focus. */
  setPassthroughMode(enabled: boolean): void {
    this._passthroughMode = enabled;
    this.textarea.placeholder = enabled
      ? 'Type here, Enter to send (arrows → PTY)'
      : 'Enter to send, Shift+Enter for newline';
  }

  setInteractive(interactive: boolean): void {
    if (interactive) {
      this.textarea.removeAttribute('disabled');
      this.textarea.tabIndex = 0;
      this.textarea.style.pointerEvents = '';
    } else {
      this.textarea.setAttribute('disabled', 'true');
      this.textarea.tabIndex = -1;
      this.textarea.style.pointerEvents = 'none';
    }
  }

  dispose(): void {
    this.textarea.remove();
  }
}
