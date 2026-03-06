import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { DEFAULTS } from '../../shared/constants';

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1e1e1e',
  cursor: '#1e1e1e',
  cursorAccent: '#ffffff',
  selectionBackground: '#b5d5ff',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
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

export class TerminalView {
  readonly terminal: Terminal;
  readonly fitAddon: FitAddon;
  readonly searchAddon: SearchAddon;
  private container: HTMLElement;
  private ptyId: number | null = null;
  private disposed = false;
  private mediaQuery: MediaQueryList;
  private themeHandler: () => void;
  private keyboardEnabled = false;

  constructor(container: HTMLElement) {
    this.container = container;

    this.terminal = new Terminal({
      fontSize: DEFAULTS.FONT_SIZE,
      fontFamily: DEFAULTS.FONT_FAMILY,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: DEFAULTS.SCROLLBACK,
      allowProposedApi: true,
      theme: getTheme(),
    });

    // Block keyboard input when disabled (auto-passthrough: editor is sole input)
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (!this.keyboardEnabled) {
        // Allow Cmd/Ctrl+C for copy even when keyboard is disabled
        if ((event.metaKey || event.ctrlKey) && event.key === 'c') return true;
        return false;
      }
      return true;
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();

    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      // Security: Only allow http/https links, block javascript:, data:, etc.
      try {
        const url = new URL(uri);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          window.open(uri);
        }
      } catch {
        // Invalid URL, ignore
      }
    }));

    // Listen for system theme changes
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.themeHandler = () => { this.terminal.options.theme = getTheme(); };
    this.mediaQuery.addEventListener('change', this.themeHandler);
  }

  mount(): void {
    this.terminal.open(this.container);

    // Try WebGL, fall back to canvas
    try {
      this.terminal.loadAddon(new WebglAddon());
    } catch {
      console.warn('WebGL addon failed to load, using canvas renderer');
    }

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

  setKeyboardEnabled(enabled: boolean): void {
    this.keyboardEnabled = enabled;
  }

  isAlternateBuffer(): boolean {
    return this.terminal.buffer.active.type === 'alternate';
  }

  onPassthroughData(callback: (data: string) => void): (() => void) {
    const disposable = this.terminal.onData(callback);
    return () => disposable.dispose();
  }

  onTitleChange(callback: (title: string) => void): (() => void) {
    const disposable = this.terminal.onTitleChange(callback);
    return () => disposable.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.mediaQuery.removeEventListener('change', this.themeHandler);
    this.terminal.dispose();
  }
}
