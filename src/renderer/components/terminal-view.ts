import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { DEFAULTS } from '../../shared/constants';
import type { ITheme } from '@xterm/xterm';

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1e1e1e',
  cursor: '#1e1e1e',
  cursorAccent: '#ffffff',
  selectionBackground: '#b5d5ff',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#008000',
  yellow: '#6b6b00',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#007688',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#008000',
  brightYellow: '#6b6b00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#007688',
  brightWhite: '#717171',
};

const DARK_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  selectionForeground: '#d4d4d4',
  black: '#000000',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#d7ba7d',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#d7ba7d',
  brightBlue: '#9cdcfe',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#e5e5e5',
};

function getTheme() {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return DARK_THEME;
  }
  return LIGHT_THEME;
}

/** Convert #RRGGBB to xterm's rgb:RRRR/GGGG/BBBB query-response format */
function hexToXtermRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = h.substring(0, 2);
  const g = h.substring(2, 4);
  const b = h.substring(4, 6);
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

export type PromptState = 'prompt' | 'command' | 'idle';

export class TerminalView {
  readonly terminal: Terminal;
  readonly fitAddon: FitAddon;
  readonly searchAddon: SearchAddon;
  private container: HTMLElement;
  private ptyId: number | null = null;
  private disposed = false;
  private mediaQuery: MediaQueryList;
  private themeHandler: () => void;
  private copyOnSelectEnabled = false;
  private customTheme: ITheme | null = null;
  private promptListeners: ((state: PromptState) => void)[] = [];
  private osc9Listeners: (() => void)[] = [];

  constructor(container: HTMLElement) {
    this.container = container;

    this.terminal = new Terminal({
      fontSize: DEFAULTS.FONT_SIZE,
      fontFamily: DEFAULTS.FONT_FAMILY,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: DEFAULTS.SCROLLBACK,
      allowProposedApi: true,
      minimumContrastRatio: 4.5,
      theme: getTheme(),
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();

    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(new WebLinksAddon((event, uri) => {
      // Double-click to open (matches Claude Code chat). Single clicks fall
      // through to xterm's selection behavior so users can drag-select text
      // that happens to contain a URL.
      if (event.detail !== 2) return;
      // Security: Only allow http/https links via main process shell.openExternal
      try {
        const url = new URL(uri);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          window.patton.openExternal(uri).catch(() => {});
        }
      } catch {
        // Invalid URL, ignore
      }
    }));

    // Lazy-load image addon after first paint to avoid blocking startup
    let imageAddonLoaded = false;
    requestAnimationFrame(() => {
      if (!imageAddonLoaded && !this.disposed) {
        import('@xterm/addon-image').then(({ ImageAddon }) => {
          if (this.disposed) return;
          imageAddonLoaded = true;
          this.terminal.loadAddon(new ImageAddon({
            enableSizeReports: true,
            sixelSupport: true,
            sixelScrolling: true,
            sixelPaletteLimit: 4096,
            iipSupport: true,
            storageLimit: 128,
            pixelLimit: 16777216,
          }));
        }).catch(() => { /* Image addon not available */ });
      }
    });

    // Copy-on-select: auto-copy to clipboard when text is selected
    this.terminal.onSelectionChange(() => {
      if (!this.copyOnSelectEnabled) return;
      const sel = this.terminal.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
      }
    });

    // Listen for system theme changes (only applies when no custom theme is active)
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.themeHandler = () => {
      if (!this.customTheme) {
        this.terminal.options.theme = getTheme();
      }
    };
    this.mediaQuery.addEventListener('change', this.themeHandler);

    // OSC 10/11: Respond to foreground/background color queries.
    // CLI tools (Claude Code, vim, etc.) send \e]10;? or \e]11;? to detect
    // the terminal's color scheme and choose readable text colors.
    // Without this, apps assume dark background and render white text — invisible on light themes.
    //
    // Debounce responses per PTY: a chatty process could query OSC 10/11
    // rapidly, and our response creates a renderer→PTY write loop. 100ms
    // between responses prevents any degenerate amplification.
    const OSC_QUERY_DEBOUNCE_MS = 100;
    let lastOsc10ResponseMs = 0;
    let lastOsc11ResponseMs = 0;
    this.terminal.parser.registerOscHandler(10, (data) => {
      if (data === '?' && this.ptyId !== null) {
        const now = Date.now();
        if (now - lastOsc10ResponseMs < OSC_QUERY_DEBOUNCE_MS) return true;
        lastOsc10ResponseMs = now;
        const theme = this.customTheme || getTheme();
        const fg = theme.foreground || '#d4d4d4';
        window.patton.pty.write(this.ptyId, `\x1b]10;${hexToXtermRgb(fg)}\x1b\\`);
      }
      return true;
    });
    this.terminal.parser.registerOscHandler(11, (data) => {
      if (data === '?' && this.ptyId !== null) {
        const now = Date.now();
        if (now - lastOsc11ResponseMs < OSC_QUERY_DEBOUNCE_MS) return true;
        lastOsc11ResponseMs = now;
        const theme = this.customTheme || getTheme();
        const bg = theme.background || '#1e1e1e';
        window.patton.pty.write(this.ptyId, `\x1b]11;${hexToXtermRgb(bg)}\x1b\\`);
      }
      return true;
    });

    // OSC 9: de-facto terminal notification escape (iTerm, macOS Terminal,
    // Alacritty, etc. — emitted by many CLI tools to request user attention).
    // Collapse any OSC 9 payload into a single "attention wanted" signal —
    // sub-codes (iTerm progress, dismissals) are not distinguished here.
    this.terminal.parser.registerOscHandler(9, () => {
      for (const cb of this.osc9Listeners) cb();
      return true;
    });

    // Register OSC 133 handler for shell integration (prompt detection)
    // Sub-commands: A = prompt start, B = prompt ready, C = pre-execution, D = finished
    this.terminal.parser.registerOscHandler(133, (data) => {
      const cmd = data.charAt(0);
      switch (cmd) {
        case 'A': // Prompt start
        case 'B': // Prompt ready (user can type)
          this.notifyPromptState('prompt');
          break;
        case 'C': // Command execution starting
          this.notifyPromptState('command');
          break;
        case 'D': // Command finished
          this.notifyPromptState('idle');
          break;
      }
      return true; // handled
    });
  }

  private notifyPromptState(state: PromptState): void {
    for (const cb of this.promptListeners) cb(state);
  }

  onPromptState(callback: (state: PromptState) => void): () => void {
    this.promptListeners.push(callback);
    return () => {
      this.promptListeners = this.promptListeners.filter(l => l !== callback);
    };
  }

  mount(): void {
    this.terminal.open(this.container);

    // Try WebGL, fall back to DOM on load failure or runtime context loss.
    // xterm.js fires onContextLoss when the GPU context dies (sleep/wake, display
    // unplug, driver hiccup, Chromium killing idle GPU contexts under pressure).
    // Without this handler, context loss often takes down the renderer process.
    //
    // After fallback, force a full redraw so the DOM renderer has current content
    // (xterm.js can leave stale glyphs if the switch happens mid-frame), and try
    // to re-acquire WebGL after 10s — context-loss is often transient.
    const loadWebgl = (isRetry: boolean) => {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          console.warn('WebGL context lost — disposing addon, falling back to DOM renderer');
          webgl.dispose();
          if (!this.disposed) {
            this.terminal.refresh(0, this.terminal.rows - 1);
            setTimeout(() => {
              if (!this.disposed) loadWebgl(true);
            }, 10_000);
          }
        });
        this.terminal.loadAddon(webgl);
        if (isRetry) console.info('WebGL renderer re-acquired after context loss');
      } catch {
        console.warn('WebGL addon failed to load, using DOM renderer');
      }
    };
    loadWebgl(false);

    this.fit();
  }

  setPtyId(id: number): void {
    this.ptyId = id;
  }

  getPtyId(): number | null {
    return this.ptyId;
  }

  write(data: string): void {
    if (!this.disposed) {
      this.terminal.write(data);
    }
  }

  fit(): void {
    if (!this.disposed) {
      try {
        this.fitAddon.fit();
      } catch {
        // Terminal not yet visible
      }
    }
  }

  getDimensions(): { cols: number; rows: number } {
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  clear(): void {
    this.terminal.clear();
  }

  setFontSize(size: number): void {
    this.terminal.options.fontSize = size;
    this.fit();
  }

  getFontSize(): number {
    return this.terminal.options.fontSize || DEFAULTS.FONT_SIZE;
  }

  focus(): void {
    this.terminal.focus();
  }

  isAlternateBuffer(): boolean {
    return this.terminal.buffer.active.type === 'alternate';
  }

  onTerminalData(callback: (data: string) => void): (() => void) {
    const disposable = this.terminal.onData(callback);
    return () => disposable.dispose();
  }

  onTitleChange(callback: (title: string) => void): (() => void) {
    const disposable = this.terminal.onTitleChange(callback);
    return () => disposable.dispose();
  }

  /** Get all content from the terminal scrollback buffer as plain text */
  getScrollbackContent(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  setCopyOnSelect(enabled: boolean): void {
    this.copyOnSelectEnabled = enabled;
  }

  setCustomTheme(theme: ITheme | null): void {
    this.customTheme = theme;
    if (theme) {
      this.terminal.options.theme = theme;
    } else {
      this.terminal.options.theme = getTheme();
    }
  }

  /** Whether the current terminal background is dark (for COLORFGBG signalling). */
  isDarkBackground(): boolean {
    const theme = this.customTheme || getTheme();
    const bg = theme.background || '#000000';
    const hex = bg.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    // Weighted luminance (ITU-R BT.601)
    return (r * 299 + g * 587 + b * 114) / 1000 < 128;
  }

  setFontFamily(family: string): void {
    this.terminal.options.fontFamily = family;
    this.fit();
  }

  setScrollback(lines: number): void {
    this.terminal.options.scrollback = lines;
  }

  onBell(callback: () => void): (() => void) {
    const disposable = this.terminal.onBell(callback);
    return () => disposable.dispose();
  }

  onOsc9(callback: () => void): () => void {
    this.osc9Listeners.push(callback);
    return () => {
      this.osc9Listeners = this.osc9Listeners.filter(l => l !== callback);
    };
  }

  /** Heuristic prompt detection: lines starting with common prompt patterns */
  private isPromptLine(line: string): boolean {
    const trimmed = line.trimStart();
    if (!trimmed) return false;
    // Common prompt endings: $, %, >, #, ❯, ➜, λ, →
    // Also match user@host:path$ patterns and (venv) prefixes
    return /^(\([^)]+\)\s*)?(\S+[@:]\S+\s*)?[%$#>❯➜λ→]\s*/.test(trimmed) ||
           /^(\([^)]+\)\s*)?[a-zA-Z0-9._-]+\s*[%$#>❯➜λ→]\s/.test(trimmed);
  }

  /** Find prompt lines in the terminal buffer and jump to them */
  jumpToPrompt(direction: 'up' | 'down'): void {
    const buffer = this.terminal.buffer.active;
    const currentViewport = buffer.viewportY;
    if (direction === 'up') {
      // Search upward from current viewport position
      for (let i = currentViewport - 1; i >= 0; i--) {
        const line = buffer.getLine(i);
        if (line && this.isPromptLine(line.translateToString(true))) {
          // Scroll so the prompt line is near the top of viewport
          const scrollTarget = Math.max(0, i - 1);
          this.terminal.scrollToLine(scrollTarget);
          return;
        }
      }
    } else {
      // Search downward from current viewport position
      const startFrom = currentViewport + this.terminal.rows;
      for (let i = startFrom; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line && this.isPromptLine(line.translateToString(true))) {
          const scrollTarget = Math.max(0, i - 1);
          this.terminal.scrollToLine(scrollTarget);
          return;
        }
      }
      // If no prompt found below, scroll to bottom
      this.terminal.scrollToBottom();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.promptListeners = [];
    this.osc9Listeners = [];
    this.mediaQuery.removeEventListener('change', this.themeHandler);
    this.terminal.dispose();
  }
}
