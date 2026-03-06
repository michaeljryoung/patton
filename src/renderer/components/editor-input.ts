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
  private debugBanner: HTMLElement;

  constructor(container: HTMLElement, callbacks: EditorInputCallbacks, fontSize?: number) {
    this.container = container;
    this.callbacks = callbacks;

    container.setAttribute('role', 'textbox');
    container.setAttribute('aria-label', 'Command input');

    // DEBUG: visible banner above textarea showing event flow
    this.debugBanner = document.createElement('div');
    this.debugBanner.style.cssText = 'background:#222;color:#0f0;font-size:11px;font-family:monospace;padding:2px 8px;white-space:nowrap;overflow:hidden;';
    this.debugBanner.textContent = 'DEBUG: waiting for keypress...';
    container.appendChild(this.debugBanner);

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'editor-textarea';
    this.textarea.placeholder = 'Editor v3 (Enter=send)';
    this.textarea.rows = 1;
    this.textarea.spellcheck = false;
    this.textarea.autocomplete = 'off';
    if (fontSize) {
      this.textarea.style.fontSize = fontSize + 'px';
    }
    container.appendChild(this.textarea);

    // --- LAYER 1: keydown ---
    this.textarea.addEventListener('keydown', (e) => {
      this.shiftHeld = e.shiftKey;
      this.debugBanner.textContent = `KEYDOWN: key=${e.key} shift=${e.shiftKey} code=${e.code}`;
      this.debugBanner.style.color = '#0f0';

      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.enterHandledByKeydown = true;
        setTimeout(() => { this.enterHandledByKeydown = false; }, 100);
        this.debugBanner.textContent = `KEYDOWN-SUBMIT: "${this.textarea.value.substring(0, 30)}"`;
        this.debugBanner.style.color = '#ff0';
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

    // --- LAYER 2: beforeinput ---
    this.textarea.addEventListener('beforeinput', (e) => {
      this.debugBanner.textContent = `BEFOREINPUT: type=${e.inputType} handled=${this.enterHandledByKeydown} shift=${this.shiftHeld}`;
      if (e.inputType === 'insertLineBreak' && !this.enterHandledByKeydown && !this.shiftHeld) {
        e.preventDefault();
        this.debugBanner.textContent = `BEFOREINPUT-SUBMIT: "${this.textarea.value.substring(0, 30)}"`;
        this.debugBanner.style.color = '#f80';
        this.doSubmit();
      }
    });

    // --- LAYER 3: input event (nuclear fallback) ---
    this.textarea.addEventListener('input', () => {
      if (this.textarea.value.includes('\n')) {
        const text = this.textarea.value.replace(/\n+/g, '');
        this.debugBanner.textContent = `INPUT-FALLBACK-SUBMIT: "${text.substring(0, 30)}"`;
        this.debugBanner.style.color = '#f00';
        if (text || this.textarea.value.trim() === '\n') {
          this.callbacks.onSubmit(text);
        }
        this.clear();
        return;
      }
      this.autoResize();
    });

    // --- Visual focus indicator ---
    this.textarea.addEventListener('focus', () => {
      this.container.style.outline = '2px solid #00ff00';
    });
    this.textarea.addEventListener('blur', () => {
      this.container.style.outline = '';
      this.debugBanner.textContent = `BLUR: focus went to ${document.activeElement?.tagName}.${(document.activeElement as HTMLElement)?.className?.substring(0, 30)}`;
      this.debugBanner.style.color = '#f00';
    });
  }

  private doSubmit(): void {
    const text = this.textarea.value;
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
    this.debugBanner.remove();
  }
}
