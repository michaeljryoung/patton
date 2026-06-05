import { Pane } from './pane';
import { HistoryManager } from '../services/history-manager';
import { trapFocus } from '../services/focus-trap';

/**
 * Quick Terminal: A drop-down terminal panel that slides from the top of the window.
 * Independent from the tab system — has its own pane and PTY.
 */
export class QuickTerminal {
  private overlay: HTMLElement;
  private panel: HTMLElement;
  private pane: Pane | null = null;
  private visible = false;
  private initialized = false;
  private shell: string | undefined;
  private historyManager: HistoryManager | undefined;
  private onCommandDone: (() => void) | null = null;
  private container: HTMLElement;
  private disposables: (() => void)[] = [];
  private releaseFocusTrap: (() => void) | null = null;
  private renderer: 'webgl' | 'dom' = 'webgl';

  constructor(container: HTMLElement) {
    this.container = container;

    this.overlay = document.createElement('div');
    this.overlay.className = 'quick-terminal-overlay';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Quick terminal');
    this.overlay.setAttribute('aria-hidden', 'true');

    this.panel = document.createElement('div');
    this.panel.className = 'quick-terminal-panel';

    this.overlay.appendChild(this.panel);
    container.appendChild(this.overlay);

    // Close on backdrop click
    const mousedownHandler = (e: MouseEvent) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    };
    this.overlay.addEventListener('mousedown', mousedownHandler);
    this.disposables.push(() => this.overlay.removeEventListener('mousedown', mousedownHandler));

    // Close on Escape
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      }
    };
    this.overlay.addEventListener('keydown', keydownHandler);
    this.disposables.push(() => this.overlay.removeEventListener('keydown', keydownHandler));
  }

  setShell(shell: string): void {
    this.shell = shell;
  }

  setHistoryManager(hm: HistoryManager): void {
    this.historyManager = hm;
  }

  setOnCommandDone(cb: () => void): void {
    this.onCommandDone = cb;
  }

  async toggle(): Promise<void> {
    if (this.visible) {
      this.hide();
    } else {
      await this.show();
    }
  }

  async show(): Promise<void> {
    if (this.visible) return;

    if (!this.initialized) {
      await this.initPane();
      this.initialized = true;
    }

    this.visible = true;
    this.overlay.classList.add('visible');
    this.overlay.setAttribute('aria-hidden', 'false');

    // Animate slide down
    requestAnimationFrame(() => {
      this.panel.classList.add('open');
      // Focus and fit after animation
      setTimeout(() => {
        this.pane?.show();
        this.pane?.focus();
      }, 200);
    });
    this.releaseFocusTrap = trapFocus(this.overlay);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.overlay.setAttribute('aria-hidden', 'true');
    this.releaseFocusTrap?.();
    this.releaseFocusTrap = null;
    this.panel.classList.remove('open');

    // Remove overlay after animation
    setTimeout(() => {
      if (!this.visible) {
        this.overlay.classList.remove('visible');
      }
    }, 200);
  }

  isVisible(): boolean {
    return this.visible;
  }

  private async initPane(): Promise<void> {
    this.pane = new Pane({
      ...(this.shell ? { shell: this.shell } : {}),
      ...(this.historyManager ? { historyManager: this.historyManager } : {}),
      onFocus: () => {},
      onTitleChange: () => {},
      onCommandDone: () => this.onCommandDone?.(),
    });

    this.pane.setRenderer(this.renderer);
    this.panel.appendChild(this.pane.element);
    await this.pane.init();
  }

  setFontSize(size: number): void {
    this.pane?.setFontSize(size);
  }

  setFontFamily(family: string): void {
    this.pane?.setFontFamily(family);
  }

  setScrollback(lines: number): void {
    this.pane?.setScrollback(lines);
  }

  setRenderer(mode: 'webgl' | 'dom'): void {
    this.renderer = mode;
    this.pane?.setRenderer(mode);
  }

  dispose(): void {
    for (const d of this.disposables) d();
    this.pane?.dispose();
    this.overlay.remove();
  }
}
