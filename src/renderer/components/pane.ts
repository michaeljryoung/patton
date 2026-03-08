import { TerminalView } from './terminal-view';
import { EditorInput } from './editor-input';
import { SearchOverlay } from './search-overlay';
import { HistorySearch } from './history-search';
import { PasteDialog } from './paste-dialog';
import { ContextMenu } from './context-menu';
import { ModeDetector } from '../services/mode-detector';
import { HistoryManager } from '../services/history-manager';
import { FileLinkProvider } from '../services/file-link-provider';
import { PATTON_QUOTES } from '../../shared/constants';
import type { InputMode } from '../../shared/types';
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
  modeDetector: ModeDetector | null = null;
  historyManager: HistoryManager;
  ptyId: number | null = null;
  title = 'Terminal';
  private mode: InputMode = 'editor';
  private disposables: (() => void)[] = [];
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: PaneCallbacks;
  private ptyExited = false;
  private _isFocused = false;
  private pasteDialog: PasteDialog;
  private contextMenu: ContextMenu;
  private submitTimer: ReturnType<typeof setTimeout> | null = null;
  private initialCwd: string | undefined;
  private currentCwd = '';
  // Idle detection: fire notification when output burst is followed by silence
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private outputSinceNotify = 0;
  private static readonly IDLE_MS = 3000; // Silence threshold
  private static readonly MIN_OUTPUT = 50; // Minimum chars to count as "activity"

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

    // Register file path link provider (Cmd+click to open in editor)
    const linkDisposable = this.terminalView.terminal.registerLinkProvider(
      new FileLinkProvider(this.terminalView.terminal, () => this.currentCwd),
    );
    this.disposables.push(() => linkDisposable.dispose());

    // Display a random Patton quote
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

    // Set up mode detector before wiring data handler so early PTY output
    // is analysed for TUI signals immediately (not dropped until first poll).
    this.modeDetector = new ModeDetector(
      () => this.terminalView.isAlternateBuffer(),
      () => this.ptyId !== null
        ? window.patton.pty.getProcess(this.ptyId)
        : Promise.resolve(''),
    );

    this.disposables.push(
      this.modeDetector.onModeChange((mode) => this.setMode(mode)),
    );

    // Wire PTY data → terminal (must be registered before any awaits to avoid losing initial output)
    this.disposables.push(
      window.patton.pty.onData((id, data) => {
        if (id === this.ptyId) {
          this.terminalView.write(data);
          this.modeDetector?.checkData(data);
          this.modeDetector?.checkBuffer();
          // Idle detection: track output bursts in passthrough mode.
          // When a TUI program (Claude, etc.) produces output then goes silent,
          // fire the notification so the user knows it finished.
          if (this.mode === 'passthrough') {
            this.outputSinceNotify += data.length;
            if (this.idleTimer) clearTimeout(this.idleTimer);
            this.idleTimer = setTimeout(() => {
              if (this.outputSinceNotify >= Pane.MIN_OUTPUT) {
                this.outputSinceNotify = 0;
                this.callbacks.onCommandDone?.();
              }
            }, Pane.IDLE_MS);
          }
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
      // eslint-disable-next-line no-control-regex -- intentional: match terminal protocol escape sequences
      } else if (/^\x1b\[[\d;]*[Rcn]$/.test(data) || /^\x1b\[[\d;?]*c$/.test(data)) {
        // Always forward terminal protocol responses (DSR cursor position, device attributes)
        // even if the terminal has focus — these are xterm.js internal responses, not user input.
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
      await this.safePaste(raw);
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
              if (text) this.safePaste(text);
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
      if (this._isFocused && this.shouldEditorHaveFocus()) this.editorInput.focus();
    });

    // 2. Redirect when the OS returns focus to the app (screen recording dialog, etc.)
    const windowFocusHandler = () => {
      if (this._isFocused && this.shouldEditorHaveFocus() && !Pane.isOverlayFocused()) {
        requestAnimationFrame(() => this.editorInput.focus());
      }
    };
    window.addEventListener('focus', windowFocusHandler);
    this.disposables.push(() => window.removeEventListener('focus', windowFocusHandler));

    // 3. Safety net: periodic check ensures editor always has focus
    //    Only runs for the focused pane to prevent split panes from fighting.
    //    Skips when an overlay (settings, paste dialog, etc.) has focus.
    const focusPoll = setInterval(() => {
      if (this._isFocused && this.shouldEditorHaveFocus() && !this.editorContainer.contains(document.activeElement) && !Pane.isOverlayFocused()) {
        this.editorInput.focus();
      }
    }, 300);
    this.disposables.push(() => clearInterval(focusPoll));

    // Focus editor on init (deferred to ensure it wins over xterm's internal focus grab)
    requestAnimationFrame(() => this.editorInput.focus());
  }

  private handleSubmit(command: string): void {
    if (this.ptyId === null) return;

    // Broadcast mode: also write to all other panes in the tab
    const broadcast = this.callbacks.onBroadcastWrite;

    // Send text and Enter as separate writes with a small gap.
    // In a real terminal, text arrives character-by-character and Enter
    // arrives separately. Sending them as one bulk string can confuse
    // raw-mode programs' input parsers on subsequent messages.
    if (command) {
      window.patton.pty.write(this.ptyId, command);
      broadcast?.(command);
      if (this.submitTimer) clearTimeout(this.submitTimer);
      this.submitTimer = setTimeout(() => {
        this.submitTimer = null;
        if (this.ptyId !== null) {
          window.patton.pty.write(this.ptyId, '\r');
          broadcast?.('\r');
        }
      }, 10);
    } else {
      window.patton.pty.write(this.ptyId, '\r');
      broadcast?.('\r');
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

  /** Check if an overlay (settings, paste dialog, search, etc.) currently has focus. */
  private static isOverlayFocused(): boolean {
    const active = document.activeElement;
    if (!active) return false;
    return active.closest('[role="dialog"], .search-overlay, .paste-dialog-overlay') !== null;
  }

  private handleEscape(): void {
    if (this.ptyId === null) return;
    if (this.mode === 'passthrough') {
      // Send Escape to the running program (e.g. exit fzf)
      window.patton.pty.write(this.ptyId, '\x1b');
    }
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

  private setMode(mode: InputMode): void {
    const prevMode = this.mode;
    this.mode = mode;
    const isManual = this.modeDetector?.isManualOverride() ?? false;

    // Reset idle detection on mode change
    this.outputSinceNotify = 0;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }

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
    if (this.shouldEditorHaveFocus()) {
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
    // Pause mode detector polling for unfocused panes (saves IPC + lsof)
    this.modeDetector?.setPaused(!focused);
    // Physically disable the unfocused pane's editor textarea so it
    // can't steal keyboard focus. This is the definitive fix for split
    // pane focus fighting — boolean checks in event handlers aren't enough.
    if (focused) {
      this.editorInput.setInteractive(true);
    } else {
      this.editorInput.setInteractive(false);
    }
  }

  getCwd(): string {
    return this.currentCwd;
  }

  clear(): void {
    this.terminalView.clear();
  }

  dispose(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.submitTimer) clearTimeout(this.submitTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
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
