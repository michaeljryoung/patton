import { EditorView, keymap, placeholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
// defaultKeymap deliberately not imported — its Enter handler overrides our submit
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';

export interface EditorInputCallbacks {
  onSubmit: (command: string) => void;
  onInterrupt: () => void;
  onHistoryUp: () => string | null;
  onHistoryDown: () => string | null;
  onTab: () => void;
  onEscape?: () => void;
}

function isDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export class EditorInput {
  private view: EditorView;
  private container: HTMLElement;
  private callbacks: EditorInputCallbacks;
  private fontSizeCompartment = new Compartment();
  private themeCompartment = new Compartment();
  private mediaQuery: MediaQueryList | null = null;
  private themeListener: (() => void) | null = null;
  private _enterHandler: ((e: Event) => void) | null = null;

  constructor(container: HTMLElement, callbacks: EditorInputCallbacks, fontSize?: number) {
    this.container = container;
    this.callbacks = callbacks;

    // --- Accessibility ---
    container.setAttribute('role', 'textbox');
    container.setAttribute('aria-label', 'Command input');
    container.setAttribute('aria-multiline', 'true');

    const baseTheme = EditorView.theme({
      '&': {
        backgroundColor: 'transparent',
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
      },
      '.cm-content': {
        padding: '8px 12px 8px 16px',
        minHeight: '20px',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-line': {
        padding: '0',
      },
    });

    const makeColorTheme = (dark: boolean) => EditorView.theme({
      '.cm-content': { caretColor: dark ? '#d4d4d4' : '#1e1e1e' },
      '&.cm-focused .cm-cursor': { borderLeftColor: dark ? '#d4d4d4' : '#1e1e1e' },
      '.cm-placeholder': { color: dark ? '#666' : '#999' },
    });

    // Listen for system theme changes
    this.mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)') || null;
    this.themeListener = () => {
      this.view.dispatch({
        effects: this.themeCompartment.reconfigure(makeColorTheme(isDark())),
      });
    };
    this.mediaQuery?.addEventListener('change', this.themeListener);

    const submitKeymap = keymap.of([
      {
        key: 'Enter',
        run: () => {
          const text = this.view.state.doc.toString();
          this.callbacks.onSubmit(text);
          this.clear();
          // --- Visual feedback: submit flash ---
          this.container.classList.add('submitting');
          setTimeout(() => this.container.classList.remove('submitting'), 250);
          return true;
        },
      },
      {
        key: 'Shift-Enter',
        run: () => {
          this.view.dispatch({
            changes: {
              from: this.view.state.selection.main.head,
              insert: '\n',
            },
          });
          return true;
        },
      },
      {
        key: 'ArrowUp',
        run: () => {
          const pos = this.view.state.selection.main.head;
          const line = this.view.state.doc.lineAt(pos);
          if (line.number === 1) {
            const prev = this.callbacks.onHistoryUp();
            if (prev !== null) {
              this.setValue(prev);
            }
            return true;
          }
          return false;
        },
      },
      {
        key: 'ArrowDown',
        run: () => {
          const pos = this.view.state.selection.main.head;
          const line = this.view.state.doc.lineAt(pos);
          if (line.number === this.view.state.doc.lines) {
            const next = this.callbacks.onHistoryDown();
            if (next !== null) {
              this.setValue(next);
            }
            return true;
          }
          return false;
        },
      },
      {
        key: 'Ctrl-c',
        run: () => {
          this.callbacks.onInterrupt();
          this.clear();
          return true;
        },
      },
      {
        key: 'Tab',
        run: () => {
          this.callbacks.onTab();
          return true;
        },
      },
      {
        key: 'Escape',
        run: () => {
          this.callbacks.onEscape?.();
          return true;
        },
      },
    ]);

    this.view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          submitKeymap,
          // NOTE: defaultKeymap deliberately removed — its Enter handler
          // (insertNewlineAndIndent) was overriding our submit handler.
          // Shift+Enter for newlines is in submitKeymap above.
          StreamLanguage.define(shell),
          placeholder('Enter=send, Shift+Enter=newline'),
          baseTheme,
          this.fontSizeCompartment.of(
            EditorView.theme({ '&': { fontSize: (fontSize || 14) + 'px' } })
          ),
          this.themeCompartment.of(makeColorTheme(isDark())),
          EditorView.lineWrapping,
        ],
      }),
      parent: container,
    });

    // Catch Enter at the beforeinput level — this is the event that actually
    // causes text insertion. If keydown handlers fail, this catches it.
    this._enterHandler = (e: Event) => {
      const ie = e as InputEvent;
      if (ie.inputType === 'insertParagraph' || ie.inputType === 'insertLineBreak') {
        e.preventDefault();
        e.stopPropagation();
        const text = this.view.state.doc.toString();
        this.callbacks.onSubmit(text);
        this.clear();
        container.classList.add('submitting');
        setTimeout(() => container.classList.remove('submitting'), 250);
      }
    };
    container.addEventListener('beforeinput', this._enterHandler, { capture: true });
  }

  focus(): void {
    this.view.focus();
  }

  clear(): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length },
    });
  }

  setValue(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: text.length },
    });
  }

  getValue(): string {
    return this.view.state.doc.toString();
  }

  show(): void {
    this.container.classList.remove('hidden');
  }

  hide(): void {
    this.container.classList.add('hidden');
  }

  setFontSize(size: number): void {
    this.view.dispatch({
      effects: this.fontSizeCompartment.reconfigure(
        EditorView.theme({ '&': { fontSize: size + 'px' } })
      ),
    });
  }

  dispose(): void {
    if (this.themeListener && this.mediaQuery) {
      this.mediaQuery.removeEventListener('change', this.themeListener);
    }
    if (this._enterHandler) {
      this.container.removeEventListener('beforeinput', this._enterHandler, { capture: true });
    }
    this.view.destroy();
  }
}
