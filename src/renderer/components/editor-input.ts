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
  private shiftHeld = false;
  private enterHandledByKeydown = false;

  constructor(container: HTMLElement, callbacks: EditorInputCallbacks, fontSize?: number) {
    this.container = container;
    this.callbacks = callbacks;

    container.setAttribute('role', 'textbox');
    container.setAttribute('aria-label', 'Command input');

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'editor-textarea';
    this.textarea.placeholder = 'Type here — Enter sends';
    this.textarea.rows = 1;
    this.textarea.spellcheck = false;
    this.textarea.autocomplete = 'off';
    if (fontSize) {
      this.textarea.style.fontSize = fontSize + 'px';
    }
    container.appendChild(this.textarea);

    // Auto-resize textarea to content
    this.textarea.addEventListener('input', () => this.autoResize());

    // Track Shift state for distinguishing Enter vs Shift+Enter
    this.textarea.addEventListener('keydown', (e) => {
      this.shiftHeld = e.shiftKey;

      // Try to handle Enter via keydown (works before passthrough mode)
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.enterHandledByKeydown = true;
        setTimeout(() => { this.enterHandledByKeydown = false; }, 100);
        this.doSubmit();
        return;
      }

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

    this.textarea.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.shiftHeld = false;
    });

    // CRITICAL FALLBACK: beforeinput catches Enter even when keydown doesn't fire.
    // When something swallows the keydown event (observed after passthrough mode),
    // the browser still fires beforeinput with inputType='insertLineBreak' before
    // inserting the newline. We intercept it here and submit instead.
    this.textarea.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'insertLineBreak' && !this.enterHandledByKeydown && !this.shiftHeld) {
        e.preventDefault();
        this.doSubmit();
      }
    });
  }

  private doSubmit(): void {
    const text = this.textarea.value;
    // DEBUG: visual confirmation (remove after fix confirmed)
    document.title = `[SENT] ${text.substring(0, 20)} @${Date.now() % 10000}`;
    this.callbacks.onSubmit(text);
    this.clear();
    this.container.classList.add('submitting');
    setTimeout(() => this.container.classList.remove('submitting'), 250);
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
    this.textarea.remove();
  }
}
