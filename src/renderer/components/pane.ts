import { TerminalView } from './terminal-view';
import { EditorInput } from './editor-input';
import { SearchOverlay } from './search-overlay';
import { HistorySearch } from './history-search';
import { PasteDialog } from './paste-dialog';
import { ContextMenu } from './context-menu';
import { HistoryManager } from '../services/history-manager';
import { FileLinkProvider } from '../services/file-link-provider';
import { PATTON_QUOTES } from '../../shared/constants';

import type { ITheme } from '@xterm/xterm';

let paneIdCounter = 0;

export interface PaneCallbacks {
  onFocus: (pane: Pane) => void;
  onTitleChange: (pane: Pane) => void;
  onCommandDone?: () => void;
  onBroadcastWrite?: (data: string) => void;
  cwd?: string;
  shell?: string;
  historyManager?: HistoryManager;
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
  historyManager: HistoryManager;
  ptyId: number | null = null;
  title = 'Terminal';
  private disposables: (() => void)[] = [];
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: PaneCallbacks;
  private ptyExited = false;
  private _isFocused = false;
  private pasteDialog: PasteDialog;
  private contextMenu: ContextMenu;
  private initialCwd: string | undefined;
  private currentCwd = '';


  constructor(callbacks: PaneCallbacks) {
    this.id = `pane-${++paneIdCounter}`;
    this.callbacks = callbacks;
    this.initialCwd = callbacks.cwd;
    this.historyManager = callbacks.historyManager || new HistoryManager();

    // Create DOM structure
    this.element = document.createElement('div');
    this.element.className = 'pane';
    this.element.id = this.id;

    // Focus on click
    const focusHandler = () => this.callbacks.onFocus(this);
    this.element.addEventListener('mousedown', focusHandler);
    this.disposables.push(() => this.element.removeEventListener('mousedown', focusHandler));

    // Drag handle for pane swapping (visible only inside split containers via CSS)
    const dragHandle = document.createElement('div');
    dragHandle.className = 'pane-drag-handle';
    dragHandle.setAttribute('aria-label', 'Drag to swap pane');
    dragHandle.textContent = '\u2630'; // ☰ hamburger/grip icon
    this.element.appendChild(dragHandle);
    this.setupDragHandle(dragHandle);

    this.terminalContainer = document.createElement('div');
    this.terminalContainer.className = 'terminal-container';
    this.element.appendChild(this.terminalContainer);

    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'editor-container collapsed';
    this.element.appendChild(this.editorContainer);

    // Create terminal view
    this.terminalView = new TerminalView(this.terminalContainer);

    // Create editor input (compose panel — collapsed by default)
    this.editorInput = new EditorInput(this.editorContainer, {
      onSubmit: (command) => {
        this.handleSubmit(command);
        this.collapseCompose();
      },
      onInterrupt: () => {
        this.handleInterrupt();
        this.collapseCompose();
      },
      onHistoryUp: () => this.historyManager.up(this.editorInput.getValue()),
      onHistoryDown: () => this.historyManager.down(),
      onTab: () => this.handleTab(),
      onEscape: () => this.collapseCompose(),
    });

    // Create search overlay
    this.searchOverlay = new SearchOverlay(
      this.terminalContainer,
      this.terminalView.searchAddon,
    );

    // Create history search (Ctrl+R)
    this.historySearch = new HistorySearch(this.element, {
      onSelect: (command) => {
        this.expandCompose();
        this.editorInput.setValue(command);
        this.editorInput.focus();
      },
      onCancel: () => {
        this.terminalView.focus();
      },
    });

    // Click on collapsed compose bar expands it
    this.editorContainer.addEventListener('click', () => {
      if (this.editorContainer.classList.contains('collapsed')) {
        this.expandCompose();
      }
    });

    this.pasteDialog = new PasteDialog(this.element);
    this.contextMenu = new ContextMenu();
  }

  async init(): Promise<void> {
    // Mount terminal
    this.terminalView.mount();

    // Register file path link provider (Cmd+click to open in editor)
    const linkDisposable = this.terminalView.terminal.registerLinkProvider(
      new FileLinkProvider(this.terminalView.terminal, () => this.currentCwd),
    );
    this.disposables.push(() => linkDisposable.dispose());

    // Display welcome quote instantly (pre-PTY) so the tab feels responsive
    const quote = PATTON_QUOTES[Math.floor(Math.random() * PATTON_QUOTES.length)];
    this.terminalView.write(`\r\n  \x1b[1m"\x1b[3m${quote}\x1b[0m\x1b[1m"\x1b[0m\r\n  \x1b[2m— General George S. Patton\x1b[0m\r\n\r\n`);

    // Create PTY (shell path passed down from App to avoid per-pane IPC)
    const dims = this.terminalView.getDimensions();
    const shellPath = this.callbacks.shell;
    try {
      this.ptyId = await window.patton.pty.create({
        cols: dims.cols,
        rows: dims.rows,
        ...(this.initialCwd ? { cwd: this.initialCwd } : {}),
        ...(shellPath ? { shell: shellPath } : {}),
      });
      this.terminalView.setPtyId(this.ptyId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.terminalView.write(`\r\n\x1b[31mFailed to create terminal: ${msg}\x1b[0m\r\n`);
      return;
    }

    // Wire PTY data → terminal (unconditional — no mode checking)
    this.disposables.push(
      window.patton.pty.onData((id, data) => {
        if (id === this.ptyId) {
          this.terminalView.write(data);
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

    // Load history (skip if shared instance already loaded)
    if (!this.callbacks.historyManager) {
      await this.historyManager.load();
    }

    // Terminal bell → notification sound
    this.disposables.push(
      this.terminalView.onBell(() => this.callbacks.onCommandDone?.()),
    );

    // Listen for title changes via xterm.js OSC sequences (no process polling needed)
    this.disposables.push(
      this.terminalView.onTitleChange((title) => {
        if (title) {
          this.title = title;
          this.callbacks.onTitleChange(this);
        }
      }),
    );

    // Poll cwd periodically for file link resolution (only when focused)
    this.currentCwd = this.initialCwd || '';
    const cwdPoll = setInterval(async () => {
      if (!this._isFocused) return; // Skip polling for unfocused panes
      if (this.ptyId !== null && !this.ptyExited) {
        try {
          const cwd = await window.patton.pty.getCwd(this.ptyId);
          if (cwd) this.currentCwd = cwd;
        } catch { /* ignore */ }
      }
    }, 2000);
    this.disposables.push(() => clearInterval(cwdPoll));

    // Wire terminal data → PTY (unconditional forwarding)
    const termDataDispose = this.terminalView.onTerminalData((data) => {
      if (this.ptyId !== null) {
        window.patton.pty.write(this.ptyId, data);
      }
    });
    if (termDataDispose) this.disposables.push(termDataDispose);

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
    const pasteHandler = async (e: ClipboardEvent) => {
      e.preventDefault();
      const raw = e.clipboardData?.getData('text') || '';
      await this.safePaste(raw);
    };
    this.terminalContainer.addEventListener('paste', pasteHandler as EventListener);
    this.disposables.push(() => this.terminalContainer.removeEventListener('paste', pasteHandler as EventListener));

    // Right-click context menu
    const contextMenuHandler = (e: MouseEvent) => {
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
              if (text) this.safePaste(text);
            });
          },
        },
        { separator: true as const },
        {
          label: 'Compose',
          shortcut: '\u2318E',
          action: () => this.toggleCompose(),
        },
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
    };
    this.element.addEventListener('contextmenu', contextMenuHandler);
    this.disposables.push(() => this.element.removeEventListener('contextmenu', contextMenuHandler));

    // OSC 133 shell integration: visual feedback on compose bar + command-done notification
    let wasRunning = false;
    this.disposables.push(
      this.terminalView.onPromptState((state) => {
        this.editorContainer.classList.toggle('prompt-ready', state === 'prompt');
        this.editorContainer.classList.toggle('command-running', state === 'command');
        // Fire command-done when transitioning from running → prompt/idle
        if (wasRunning && (state === 'prompt' || state === 'idle')) {
          this.callbacks.onCommandDone?.();
        }
        wasRunning = state === 'command';
      }),
    );

    // Focus terminal on init (terminal is always the primary input)
    requestAnimationFrame(() => this.terminalView.focus());
  }

  private submitQueue: Promise<void> = Promise.resolve();

  private handleSubmit(command: string): void {
    if (this.ptyId === null) return;

    // Broadcast mode: also write to all other panes in the tab
    const broadcast = this.callbacks.onBroadcastWrite;

    // Queue submits sequentially to prevent rapid double-submit from dropping the first Enter.
    // Each submit writes text then Enter with a small gap, and the next submit waits for the previous.
    this.submitQueue = this.submitQueue.then(() => new Promise<void>((resolve) => {
      if (this.ptyId === null) { resolve(); return; }
      if (command) {
        window.patton.pty.write(this.ptyId, command);
        broadcast?.(command);
        setTimeout(() => {
          if (this.ptyId !== null) {
            window.patton.pty.write(this.ptyId, '\r');
            broadcast?.('\r');
          }
          resolve();
        }, 10);
      } else {
        window.patton.pty.write(this.ptyId, '\r');
        broadcast?.('\r');
        resolve();
      }
    }));

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

  /** Check if an overlay (settings, paste dialog, search, etc.) currently has focus. */
  private static isOverlayFocused(): boolean {
    const active = document.activeElement;
    if (!active) return false;
    return active.closest('[role="dialog"], .search-overlay, .paste-dialog-overlay') !== null;
  }

  /** Sanitize pasted text and confirm multi-line pastes before writing to PTY */
  private async safePaste(raw: string): Promise<void> {
    if (this.ptyId === null || !raw) return;
    // Strip dangerous control characters (keep \n, \t, \r, printable)
    // eslint-disable-next-line no-control-regex -- intentional: sanitize pasted control chars
    const sanitized = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    if (!sanitized) return;

    const lines = sanitized.split('\n');
    if (lines.length >= 3) {
      const confirmed = await this.pasteDialog.confirm(sanitized, lines.length);
      if (!confirmed) return;
    }
    window.patton.pty.write(this.ptyId, sanitized);
  }

  // --- Compose panel ---

  isComposeExpanded(): boolean {
    return !this.editorContainer.classList.contains('collapsed');
  }

  expandCompose(): void {
    this.editorContainer.classList.remove('collapsed');
    this.editorInput.focus();
  }

  collapseCompose(): void {
    this.editorContainer.classList.add('collapsed');
    this.terminalView.focus();
  }

  toggleCompose(): void {
    if (this.isComposeExpanded()) {
      this.collapseCompose();
    } else {
      this.expandCompose();
    }
  }

  setProcessName(name: string): void {
    this.title = name || 'Terminal';
    this.callbacks.onTitleChange(this);
  }

  showHistorySearch(): void {
    if (this.historySearch.isVisible()) {
      this.historySearch.hide();
      this.terminalView.focus();
    } else {
      this.historySearch.show(this.historyManager.getEntries());
    }
  }

  focus(): void {
    if (this.isComposeExpanded() && !Pane.isOverlayFocused()) {
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

  setFontFamily(family: string): void {
    this.terminalView.setFontFamily(family);
    this.editorInput.setFontFamily(family);
  }

  setScrollback(lines: number): void {
    this.terminalView.setScrollback(lines);
  }

  setCopyOnSelect(enabled: boolean): void {
    this.terminalView.setCopyOnSelect(enabled);
  }

  getScrollbackContent(): string {
    return this.terminalView.getScrollbackContent();
  }

  setTerminalTheme(theme: ITheme | null): void {
    this.terminalView.setCustomTheme(theme);
  }

  jumpToPrompt(direction: 'up' | 'down'): void {
    this.terminalView.jumpToPrompt(direction);
  }

  private setupDragHandle(handle: HTMLElement): void {
    let dragging = false;
    let overlay: HTMLElement | null = null;

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;

      // Create a floating overlay to indicate dragging
      overlay = document.createElement('div');
      overlay.className = 'pane-drag-overlay';
      overlay.textContent = this.title;
      overlay.style.left = `${e.clientX - 40}px`;
      overlay.style.top = `${e.clientY - 16}px`;
      document.body.appendChild(overlay);

      this.element.classList.add('dragging');
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging || !overlay) return;
      overlay.style.left = `${e.clientX - 40}px`;
      overlay.style.top = `${e.clientY - 16}px`;

      // Highlight the pane under the cursor as a drop target
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const targetPane = target?.closest('.pane');
      // Clear all drop targets, then set the new one
      for (const el of document.querySelectorAll('.pane.drop-target')) {
        if (el !== targetPane || el === this.element) {
          el.classList.remove('drop-target');
        }
      }
      if (targetPane && targetPane !== this.element) {
        targetPane.classList.add('drop-target');
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!dragging) return;
      dragging = false;

      // Clean up overlay
      overlay?.remove();
      overlay = null;
      this.element.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Clear all drop targets
      for (const el of document.querySelectorAll('.pane.drop-target')) {
        el.classList.remove('drop-target');
      }

      // Find the target pane under the cursor
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const targetPane = target?.closest('.pane');
      if (targetPane && targetPane !== this.element && targetPane.id) {
        // Dispatch a custom event on the tab content to signal a swap
        this.element.dispatchEvent(new CustomEvent('pane-swap', {
          bubbles: true,
          detail: { sourceId: this.id, targetId: targetPane.id },
        }));
      }
    };

    handle.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    this.disposables.push(
      () => handle.removeEventListener('mousedown', onMouseDown),
      () => document.removeEventListener('mousemove', onMouseMove),
      () => document.removeEventListener('mouseup', onMouseUp),
    );
  }

  setFocused(focused: boolean): void {
    this._isFocused = focused;
    this.element.classList.toggle('focused', focused);
  }

  getCwd(): string {
    return this.currentCwd;
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
    this.searchOverlay.dispose();
    this.historySearch.dispose();
    this.pasteDialog.dispose();
    this.contextMenu.dispose();
    this.editorInput.dispose();
    this.terminalView.dispose();
    this.element.remove();
  }
}
