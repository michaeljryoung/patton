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
      onEscape: () => this.terminalView.focus(),
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

    // Listen for title changes via xterm.js OSC sequences (no process polling needed)
    this.terminalView.onTitleChange((title) => {
      if (title) {
        this.title = title;
        this.callbacks.onTitleChange(this);
      }
    });

    // Wire terminal data → PTY
    // Always forward xterm.js data to PTY regardless of mode.
    // In editor mode, CodeMirror captures keyboard input (not xterm.js),
    // so the only data xterm.js generates are terminal protocol responses
    // (e.g. cursor position DSR replies) which must reach the PTY or
    // programs like fzf --height will block waiting for the response.
    const passthroughDispose = this.terminalView.onPassthroughData((data) => {
      if (this.ptyId !== null) {
        window.patton.pty.write(this.ptyId, data);
      }
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

    // Focus editor in editor mode (deferred to ensure it wins over xterm's internal focus grab)
    requestAnimationFrame(() => this.editorInput.focus());
  }

  private handleSubmit(command: string): void {
    if (this.ptyId === null) return;
    window.patton.pty.write(this.ptyId, command + '\n');
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

  private setMode(mode: InputMode): void {
    this.mode = mode;
    // Editor bar is always visible — it's the primary input in both modes.
    // In passthrough, TUI apps render in the terminal; the editor stays as a
    // compose area so the user keeps CodeMirror editing for Claude Code, etc.
    this.editorInput.show();
    this.editorContainer.classList.toggle('passthrough', mode === 'passthrough');
    if (mode === 'passthrough') {
      this.terminalView.focus();
    } else {
      this.editorInput.focus();
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
