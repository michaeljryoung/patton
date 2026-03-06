import { TabManager } from './tab-manager';

export class KeybindingManager {
  private tabManager: TabManager;
  private handler: (e: KeyboardEvent) => void;

  constructor(tabManager: TabManager) {
    this.tabManager = tabManager;

    this.handler = (e: KeyboardEvent) => {
      // Ctrl+Shift+P: Toggle passthrough mode
      if (e.ctrlKey && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        const tab = this.tabManager.getActiveTab();
        tab?.togglePassthrough();
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

    document.addEventListener('keydown', this.handler);
  }

  dispose(): void {
    document.removeEventListener('keydown', this.handler);
  }
}
