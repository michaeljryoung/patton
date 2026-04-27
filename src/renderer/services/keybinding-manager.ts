import { TabManager } from './tab-manager';

export class KeybindingManager {
  private tabManager: TabManager;
  private handler: (e: KeyboardEvent) => void;

  constructor(tabManager: TabManager) {
    this.tabManager = tabManager;

    this.handler = (e: KeyboardEvent) => {
      // Cmd+E: Toggle compose panel
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && e.key === 'e') {
        e.preventDefault();
        const tab = this.tabManager.getActiveTab();
        tab?.toggleCompose();
        return;
      }

      // Cmd+Shift+K: Reset Renderer (escape hatch for the WebGL atlas-eviction
      // garbled-glyph state). Direct hotkey instead of palette → 1 keystroke.
      if (e.metaKey && e.shiftKey && !e.ctrlKey && (e.key === 'K' || e.key === 'k')) {
        e.preventDefault();
        const tab = this.tabManager.getActiveTab();
        tab?.focusedPane.terminalView.resetRenderer();
        return;
      }

      // Ctrl+R: History search
      if (e.ctrlKey && !e.shiftKey && e.key === 'r') {
        e.preventDefault();
        const tab = this.tabManager.getActiveTab();
        tab?.showHistorySearch();
        return;
      }

      // Cmd+Option+Arrow: Navigate between panes
      if ((e.metaKey || e.ctrlKey) && e.altKey) {
        switch (e.key) {
          case 'ArrowUp':
            e.preventDefault();
            this.tabManager.focusPaneInDirection('up');
            return;
          case 'ArrowDown':
            e.preventDefault();
            this.tabManager.focusPaneInDirection('down');
            return;
          case 'ArrowLeft':
            e.preventDefault();
            this.tabManager.focusPaneInDirection('left');
            return;
          case 'ArrowRight':
            e.preventDefault();
            this.tabManager.focusPaneInDirection('right');
            return;
        }
      }
    };

    // Capture phase so we intercept before xterm's own keydown handler
    document.addEventListener('keydown', this.handler, true);
  }

  dispose(): void {
    document.removeEventListener('keydown', this.handler, true);
  }
}
