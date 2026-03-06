import { TerminalView } from './terminal-view';
import { EditorInput } from './editor-input';
import { SearchOverlay } from './search-overlay';
import { HistorySearch } from './history-search';
import { PasteDialog } from './paste-dialog';
import { ContextMenu } from './context-menu';
import { ModeDetector } from '../services/mode-detector';
import { HistoryManager } from '../services/history-manager';
import { PATTON_QUOTES } from '../../shared/constants';
import type { InputMode } from '../../shared/types';

let paneIdCounter = 0;

export interface PaneCallbacks {
  onFocus: (pane: Pane) => void;
  onTitleChange: (pane: Pane) => void;
  onCommandDone?: () => void;
}

export class Pane {
  readonly id: string;
  readonly element: HTMLElement;
  private terminalContainer: HTMLElement;
  private editorContainer: HTMLElement;
  terminalView: TerminalView;
  editorInput: EditorInput;
  searchOverlay: SearchOverlay;
  historySearch: HistorySearch;
  modeDetector: ModeDetector | null = null;
  historyManager: HistoryManager;
  ptyId: number | null = null;
  title = 'Terminal';
  private mode: InputMode = 'editor';
  private disposables: (() => void)[] = [];
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: PaneCallbacks;
  private ptyExited = false;
  private pasteDialog: PasteDialog;
  private contextMenu: ContextMenu;

  constructor(callbacks: PaneCallbacks) {
    this.id = `pane-${++paneIdCounter}`;
    this.callbacks = callbacks;
    this.historyManager = new HistoryManager();

    // Create DOM structure
    this.element = document.createElement('div');
    this.element.className = 'pane';
    this.element.id = this.id;

    // Focus on click
    const focusHandler = () => this.callbacks.onFocus(this);
    this.element.addEventListener('mousedown', focusHandler);
    this.disposables.push(() => this.element.removeEventListener('mousedown', focusHandler));

    this.terminalContainer = document.createElement('div');
    this.terminalContainer.className = 'terminal-container';
    this.element.appendChild(this.terminalContainer);

    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'editor-container';
    this.element.appendChild(this.editorContainer);

    // Create terminal view
    this.terminalView = new TerminalView(this.terminalContainer);

    // Create editor input
    this.editorInput = new EditorInput(this.editorContainer, {
      onSubmit: (command) => this.handleSubmit(command),
      onInterrupt: () => this.handleInterrupt(),
      onHistoryUp: () => this.historyManager.up(this.editorInput.getValue()),
      onHistoryDown: () => this.historyManager.down(),
      onTab: () => this.handleTab(),
      onEscape: () => this.handleEscape(),
    });

    // Create search overlay
    this.searchOverlay = new SearchOverlay(
      this.terminalContainer,
      this.terminalView.searchAddon,
    );

    // Create history search (Ctrl+R)
    this.historySearch = new HistorySearch(this.element, {
      onSelect: (command) => {
        this.editorInput.setValue(command);
        this.editorInput.focus();
      },
      onCancel: () => {
        this.editorInput.focus();
      },
    });

    this.pasteDialog = new PasteDialog(this.element);
    this.contextMenu = new ContextMenu();
  }

  async init(): Promise<void> {
    // Mount terminal
    this.terminalView.mount();

    // Display a random Patton quote
    const quote = PATTON_QUOTES[Math.floor(Math.random() * PATTON_QUOTES.length)];
    this.terminalView.write(`\r\n  \x1b[1m"\x1b[3m${quote}\x1b[0m\x1b[1m"\x1b[0m\r\n  \x1b[2m— General George S. Patton\x1b[0m\r\n\r\n`);

    // Create PTY
    const dims = this.terminalView.getDimensions();
    try {
      this.ptyId = await window.patton.pty.create({
        cols: dims.cols,
        rows: dims.rows,
      });
      this.terminalView.setPtyId(this.ptyId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.terminalView.write(`\r\n\x1b[31mFailed to create terminal: ${msg}\x1b[0m\r\n`);
      return;
    }

    // Wire PTY data → terminal (must be registered before any awaits to avoid losing initial output)
    this.disposables.push(
      window.patton.pty.onData((id, data) => {
        if (id === this.ptyId) {
          this.terminalView.write(data);
          this.modeDetector?.checkData(data);
          this.modeDetector?.checkBuffer();
        }
      }),
    );

    // Track PTY exit to avoid destroy-after-exit
    this.disposables.push(
      window.patton.pty.onExit((id) => {
        if (id === this.ptyId) {
          this.ptyExited = true;
        }
      }),
    );

    // Load history
    await this.historyManager.load();

    // Set up mode detector
    this.modeDetector = new ModeDetector(
      () => this.terminalView.isAlternateBuffer(),
      () => this.ptyId !== null
        ? window.patton.pty.getProcess(this.ptyId)
        : Promise.resolve(''),
    );

    this.disposables.push(
      this.modeDetector.onModeChange((mode) => this.setMode(mode)),
    );

    // Terminal bell → notification sound
    this.disposables.push(
      this.terminalView.onBell(() => this.callbacks.onCommandDone?.()),
    );

    // Listen for title changes via xterm.js OSC sequences (no process polling needed)
    this.terminalView.onTitleChange((title) => {
      if (title) {
        this.title = title;
        this.callbacks.onTitleChange(this);
      }
    });

    // Wire terminal data → PTY
    // Gate forwarding based on mode to prevent user keystrokes from leaking
    // to the running program when the editor should be the sole input.
    // Terminal protocol responses (DSR cursor position replies, device attributes)
    // are forwarded when the terminal doesn't have DOM focus, since those can
    // only be generated by xterm.js internals, not user typing.
    const passthroughDispose = this.terminalView.onPassthroughData((data) => {
      if (this.ptyId === null) return;

      const isManual = this.modeDetector?.isManualOverride() ?? false;
      if (this.mode === 'passthrough' && isManual) {
        // Manual passthrough (Ctrl+Shift+P): forward everything for vim, etc.
        window.patton.pty.write(this.ptyId, data);
      } else if (!this.terminalView.hasFocus()) {
        // Terminal doesn't have focus: data must be protocol responses (DSR etc.)
        window.patton.pty.write(this.ptyId, data);
      }
      // else: terminal has focus but shouldn't — drop user keyboard input
    });
    if (passthroughDispose) this.disposables.push(passthroughDispose);

    // --- Handle resize with debouncing ---
    const resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.terminalView.fit();
        if (this.ptyId !== null) {
          const dims = this.terminalView.getDimensions();
          window.patton.pty.resize(this.ptyId, dims.cols, dims.rows);
        }
      }, 100);
    });
    resizeObserver.observe(this.terminalContainer);
    this.disposables.push(() => resizeObserver.disconnect());

    // Security: Intercept paste to sanitize and warn on multi-line
    this.terminalContainer.addEventListener('paste', async (e) => {
      if (this.mode !== 'passthrough') return; // Editor handles its own paste
      e.preventDefault();
      const raw = e.clipboardData?.getData('text') || '';
      // Strip dangerous control characters (keep \n, \t, \r, printable)
      // eslint-disable-next-line no-control-regex -- intentional: sanitize pasted control chars
      const sanitized = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
      if (!sanitized) return;

      const lines = sanitized.split('\n');
      if (lines.length >= 3) {
        const confirmed = await this.pasteDialog.confirm(sanitized, lines.length);
        if (!confirmed) return;
      }
      if (this.ptyId !== null) {
        window.patton.pty.write(this.ptyId, sanitized);
      }
    });

    // Right-click context menu
    this.element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hasSelection = !!this.terminalView.terminal.getSelection();
      this.contextMenu.show(e.clientX, e.clientY, [
        ...(hasSelection ? [{
          label: 'Copy',
          shortcut: '\u2318C',
          action: () => {
            const sel = this.terminalView.terminal.getSelection();
            if (sel) navigator.clipboard.writeText(sel);
          },
        }] : []),
        {
          label: 'Paste',
          shortcut: '\u2318V',
          action: () => {
            navigator.clipboard.readText().then(text => {
              if (this.ptyId !== null && text) {
                window.patton.pty.write(this.ptyId, text);
              }
            });
          },
        },
        { separator: true as const },
        {
          label: 'Clear',
          shortcut: '\u2318K',
          action: () => this.terminalView.clear(),
        },
        { separator: true as const },
        {
          label: 'Split Right',
          shortcut: '\u2318D',
          action: () => {
            this.element.dispatchEvent(new CustomEvent('pane-split', { detail: 'vertical', bubbles: true }));
          },
        },
        {
          label: 'Split Down',
          shortcut: '\u2318\u21E7D',
          action: () => {
            this.element.dispatchEvent(new CustomEvent('pane-split', { detail: 'horizontal', bubbles: true }));
          },
        },
      ]);
    });

    // --- Focus protection: editor is the sole keyboard input unless manual passthrough ---
    // Three layers to prevent the terminal from stealing keystrokes:

    // 1. Redirect immediately when terminal container receives focus (clicks, tab, etc.)
    this.terminalContainer.addEventListener('focusin', () => {
      if (this.shouldEditorHaveFocus()) this.editorInput.focus();
    });

    // 2. Redirect when the OS returns focus to the app (screen recording dialog, etc.)
    const windowFocusHandler = () => {
      if (this.shouldEditorHaveFocus()) {
        requestAnimationFrame(() => this.editorInput.focus());
      }
    };
    window.addEventListener('focus', windowFocusHandler);
    this.disposables.push(() => window.removeEventListener('focus', windowFocusHandler));

    // 3. Safety net: periodic check ensures editor always has focus
    const focusPoll = setInterval(() => {
      if (this.shouldEditorHaveFocus() && !this.editorContainer.contains(document.activeElement)) {
        this.editorInput.focus();
      }
    }, 300);
    this.disposables.push(() => clearInterval(focusPoll));

    // Focus editor on init (deferred to ensure it wins over xterm's internal focus grab)
    requestAnimationFrame(() => this.editorInput.focus());
  }

  private handleSubmit(command: string): void {
    if (this.ptyId === null) return;

    // Send text and Enter as separate writes with a small gap.
    // In a real terminal, text arrives character-by-character and Enter
    // arrives separately. Sending them as one bulk string can confuse
    // raw-mode programs' input parsers on subsequent messages.
    if (command) {
      window.patton.pty.write(this.ptyId, command);
      setTimeout(() => {
        if (this.ptyId !== null) {
          window.patton.pty.write(this.ptyId, '\r');
        }
      }, 10);
    } else {
      window.patton.pty.write(this.ptyId, '\r');
    }

    if (command.trim()) {
      this.historyManager.add(command);
    }
    this.historyManager.resetCursor();
  }

  private handleInterrupt(): void {
    if (this.ptyId === null) return;
    window.patton.pty.write(this.ptyId, '\x03');
  }

  private handleTab(): void {
    if (this.ptyId === null) return;
    window.patton.pty.write(this.ptyId, '\t');
  }

  private shouldEditorHaveFocus(): boolean {
    const isManual = this.modeDetector?.isManualOverride() ?? false;
    // Editor should have focus unless user explicitly toggled to manual passthrough
    return !(this.mode === 'passthrough' && isManual);
  }

  private handleEscape(): void {
    if (this.ptyId === null) return;
    if (this.mode === 'passthrough') {
      // Send Escape to the running program (e.g. exit fzf)
      window.patton.pty.write(this.ptyId, '\x1b');
    }
  }

  private setMode(mode: InputMode): void {
    const prevMode = this.mode;
    this.mode = mode;
    const isManual = this.modeDetector?.isManualOverride() ?? false;

    // Notify when a command finishes (passthrough → editor transition)
    if (prevMode === 'passthrough' && mode === 'editor') {
      this.callbacks.onCommandDone?.();
    }

    if (mode === 'passthrough' && isManual) {
      // User explicitly toggled passthrough (Ctrl+Shift+P) — full terminal control
      // for vim, htop, etc. that need direct keystroke access.
      this.editorInput.hide();
      this.editorContainer.classList.remove('passthrough');
      this.terminalView.setKeyboardEnabled(true);
      this.terminalView.focus();
    } else if (mode === 'passthrough') {
      // Auto-detected passthrough — editor is the sole keyboard input.
      // Terminal is display-only; keyboard blocked so clicks on terminal
      // can't steal input. Submit sends text to the running program.
      this.editorInput.show();
      this.editorInput.focus();
      this.editorContainer.classList.add('passthrough');
      this.terminalView.setKeyboardEnabled(false);
    } else {
      // Editor mode — normal shell usage.
      this.editorInput.show();
      this.editorInput.focus();
      this.editorContainer.classList.remove('passthrough');
      this.terminalView.setKeyboardEnabled(false);
    }
  }

  setProcessName(name: string): void {
    this.title = name || 'Terminal';
    this.callbacks.onTitleChange(this);
  }

  getMode(): InputMode {
    return this.mode;
  }

  togglePassthrough(): void {
    this.modeDetector?.toggle();
  }

  showHistorySearch(): void {
    if (this.historySearch.isVisible()) {
      this.historySearch.hide();
      this.editorInput.focus();
    } else {
      this.historySearch.show(this.historyManager.getEntries());
    }
  }

  focus(): void {
    if (this.mode === 'editor') {
      this.editorInput.focus();
    } else {
      this.terminalView.focus();
    }
  }

  show(): void {
    this.element.style.display = 'flex';
    this.terminalView.fit();
  }

  hide(): void {
    this.element.style.display = 'none';
  }

  setFontSize(size: number): void {
    this.terminalView.setFontSize(size);
    this.editorInput.setFontSize(size);
  }

  setFocused(focused: boolean): void {
    this.element.classList.toggle('focused', focused);
  }

  clear(): void {
    this.terminalView.clear();
  }

  dispose(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    for (const d of this.disposables) d();
    if (this.ptyId !== null && !this.ptyExited) {
      window.patton.pty.destroy(this.ptyId);
    }
    this.modeDetector?.dispose();
    this.searchOverlay.dispose();
    this.historySearch.dispose();
    this.pasteDialog.dispose();
    this.contextMenu.dispose();
    this.editorInput.dispose();
    this.terminalView.dispose();
    this.element.remove();
  }
}
