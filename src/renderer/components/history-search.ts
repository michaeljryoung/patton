export interface HistorySearchCallbacks {
  onSelect: (command: string) => void;
  onCancel: () => void;
}

export class HistorySearch {
  private overlay: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private entries: string[] = [];
  private filtered: string[] = [];
  private selectedIndex = 0;
  private visible = false;
  private callbacks: HistorySearchCallbacks;

  constructor(container: HTMLElement, callbacks: HistorySearchCallbacks) {
    this.callbacks = callbacks;

    this.overlay = document.createElement('div');
    this.overlay.className = 'history-search';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-label', 'Search command history');

    this.overlay.innerHTML = `
      <div class="history-search-header">
        <span class="history-search-icon">&#x1F50D;</span>
        <input class="history-search-input" type="text" placeholder="Search history (Ctrl+R)..." aria-label="Search history" />
      </div>
      <div class="history-search-list" role="listbox"></div>
    `;

    container.appendChild(this.overlay);

    this.input = this.overlay.querySelector('.history-search-input')!;
    this.list = this.overlay.querySelector('.history-search-list')!;

    this.input.addEventListener('input', () => this.filter());
    this.input.addEventListener('keydown', (e) => this.handleKey(e));
  }

  show(entries: readonly string[]): void {
    this.entries = [...entries].reverse(); // most recent first
    this.visible = true;
    this.overlay.classList.add('visible');
    this.input.value = '';
    this.selectedIndex = 0;
    this.filter();
    this.input.focus();
  }

  hide(): void {
    this.visible = false;
    this.overlay.classList.remove('visible');
    this.input.value = '';
  }

  isVisible(): boolean {
    return this.visible;
  }

  private filter(): void {
    const query = this.input.value.toLowerCase();
    this.filtered = query
      ? this.entries.filter(e => e.toLowerCase().includes(query))
      : this.entries;
    this.selectedIndex = 0;
    this.render();
  }

  private render(): void {
    const maxItems = 12;
    const items = this.filtered.slice(0, maxItems);
    this.list.innerHTML = items.map((entry, i) => {
      const escaped = entry.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const active = i === this.selectedIndex ? 'active' : '';
      return `<div class="history-search-item ${active}" role="option" aria-selected="${i === this.selectedIndex}" data-index="${i}">${escaped}</div>`;
    }).join('');

    if (this.filtered.length === 0) {
      this.list.innerHTML = '<div class="history-search-empty">No matches</div>';
    }

    // Scroll selected into view
    const activeEl = this.list.querySelector('.active');
    activeEl?.scrollIntoView({ block: 'nearest' });

    // Click handler
    this.list.querySelectorAll('.history-search-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-index') || '0', 10);
        this.selectItem(idx);
      });
    });
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.filtered.length - 1);
      this.render();
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.selectItem(this.selectedIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.hide();
      this.callbacks.onCancel();
    }
  }

  private selectItem(index: number): void {
    if (index >= 0 && index < this.filtered.length) {
      this.hide();
      this.callbacks.onSelect(this.filtered[index]);
    }
  }

  dispose(): void {
    this.overlay.remove();
  }
}
