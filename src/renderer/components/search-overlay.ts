import type { SearchAddon } from '@xterm/addon-search';

export class SearchOverlay {
  private container: HTMLElement;
  private input: HTMLInputElement;
  private countDisplay: HTMLSpanElement;
  private searchAddon: SearchAddon;
  private visible = false;
  private matchIndex = 0;
  private matchTotal = 0;

  constructor(parent: HTMLElement, searchAddon: SearchAddon) {
    this.searchAddon = searchAddon;

    this.container = document.createElement('div');
    this.container.className = 'search-overlay';
    this.container.setAttribute('role', 'search');
    this.container.setAttribute('aria-label', 'Search terminal');

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'search-input';
    this.input.placeholder = 'Search...';
    this.input.setAttribute('aria-label', 'Search terminal output');

    this.countDisplay = document.createElement('span');
    this.countDisplay.className = 'search-count';
    this.countDisplay.setAttribute('role', 'status');
    this.countDisplay.setAttribute('aria-live', 'polite');

    const closeBtn = document.createElement('button');
    closeBtn.className = 'search-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.setAttribute('aria-label', 'Close search');
    closeBtn.addEventListener('click', () => this.hide());

    this.container.appendChild(this.input);
    this.container.appendChild(this.countDisplay);
    this.container.appendChild(closeBtn);
    parent.appendChild(this.container);

    // Wire up search-on-type result count via the onDidChangeResults callback
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SearchAddon types don't expose onDidChangeResults
      (this.searchAddon as any).onDidChangeResults?.((result: { resultIndex: number; resultCount: number } | undefined) => {
        if (result) {
          this.matchIndex = result.resultIndex + 1;
          this.matchTotal = result.resultCount;
          this.updateCount();
        } else {
          this.matchIndex = 0;
          this.matchTotal = 0;
          this.updateCount();
        }
      });
    } catch {
      // Older xterm SearchAddon without onDidChangeResults
    }

    this.input.addEventListener('input', () => {
      this.search();
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        this.searchAddon.findPrevious(this.input.value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.searchAddon.findNext(this.input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      }
    });
  }

  private search(): void {
    const query = this.input.value;
    if (query) {
      this.searchAddon.findNext(query);
    } else {
      this.searchAddon.clearDecorations();
      this.matchIndex = 0;
      this.matchTotal = 0;
      this.updateCount();
    }
  }

  private updateCount(): void {
    if (this.matchTotal > 0) {
      this.countDisplay.textContent = `${this.matchIndex} of ${this.matchTotal}`;
    } else if (this.input.value) {
      this.countDisplay.textContent = 'No results';
    } else {
      this.countDisplay.textContent = '';
    }
  }

  show(): void {
    this.visible = true;
    this.container.classList.add('visible');
    this.input.focus();
    this.input.select();
  }

  hide(): void {
    this.visible = false;
    this.container.classList.remove('visible');
    this.searchAddon.clearDecorations();
    this.input.value = '';
    this.matchIndex = 0;
    this.matchTotal = 0;
    this.updateCount();
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  dispose(): void {
    this.container.remove();
  }
}
