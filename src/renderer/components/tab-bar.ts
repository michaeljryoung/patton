export interface TabBarCallbacks {
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onReorder: (fromId: string, toId: string) => void;
  onSettings: () => void;
  onRename: (id: string, name: string) => void;
}

interface TabHeaderInfo {
  id: string;
  title: string;
  active: boolean;
}

export class TabBar {
  private container: HTMLElement;
  private tabsContainer: HTMLElement;
  private callbacks: TabBarCallbacks;
  private draggedId: string | null = null;

  constructor(container: HTMLElement, callbacks: TabBarCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.container.className = 'tab-bar';
    // --- Accessibility ---
    this.container.setAttribute('role', 'toolbar');
    this.container.setAttribute('aria-label', 'Tab bar');

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'tab-bar-settings';
    settingsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.title = 'Settings (Cmd+,)';
    settingsBtn.addEventListener('click', () => this.callbacks.onSettings());
    this.container.appendChild(settingsBtn);

    this.tabsContainer = document.createElement('div');
    this.tabsContainer.className = 'tab-bar-tabs';
    this.tabsContainer.setAttribute('role', 'tablist');
    this.container.appendChild(this.tabsContainer);

    const newBtn = document.createElement('button');
    newBtn.className = 'tab-bar-new';
    newBtn.textContent = '+';
    newBtn.setAttribute('aria-label', 'New Tab');
    newBtn.title = 'New Tab (Cmd+T)';
    newBtn.addEventListener('click', () => this.callbacks.onNew());
    this.container.appendChild(newBtn);
  }

  update(tabs: TabHeaderInfo[]): void {
    this.tabsContainer.innerHTML = '';
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = `tab-bar-tab${tab.active ? ' active' : ''}`;
      el.dataset.tabId = tab.id;

      // --- Accessibility ---
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', tab.active ? 'true' : 'false');
      el.setAttribute('tabindex', tab.active ? '0' : '-1');
      el.setAttribute('aria-label', tab.title);

      // --- Drag-to-reorder ---
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        this.draggedId = tab.id;
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', tab.id);
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        this.draggedId = null;
        el.classList.remove('dragging');
        // Clean up all drag-over states
        this.tabsContainer.querySelectorAll('.drag-over').forEach(
          el => el.classList.remove('drag-over'),
        );
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        // Highlight drop target
        this.tabsContainer.querySelectorAll('.drag-over').forEach(
          el => el.classList.remove('drag-over'),
        );
        if (this.draggedId && this.draggedId !== tab.id) {
          el.classList.add('drag-over');
        }
      });
      el.addEventListener('dragleave', () => {
        el.classList.remove('drag-over');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drag-over');
        const fromId = e.dataTransfer!.getData('text/plain');
        if (fromId && fromId !== tab.id) {
          this.callbacks.onReorder(fromId, tab.id);
        }
      });

      const titleSpan = document.createElement('span');
      titleSpan.className = 'tab-bar-tab-title';
      titleSpan.textContent = tab.title;
      el.appendChild(titleSpan);

      // Double-click to rename
      titleSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.startRename(el, titleSpan, tab.id);
      });

      if (tabs.length > 1) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-bar-tab-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.setAttribute('aria-label', `Close ${tab.title}`);
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.callbacks.onClose(tab.id);
        });
        el.appendChild(closeBtn);
      }

      // Click to select
      el.addEventListener('click', () => {
        this.callbacks.onSelect(tab.id);
      });

      // --- Middle-click to close ---
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          if (tabs.length > 1) {
            this.callbacks.onClose(tab.id);
          }
        }
      });

      this.tabsContainer.appendChild(el);
    }
  }

  private startRename(tabEl: HTMLElement, titleSpan: HTMLElement, tabId: string): void {
    const input = document.createElement('input');
    input.className = 'tab-bar-tab-rename';
    input.type = 'text';
    input.value = titleSpan.textContent || '';
    input.maxLength = 100;
    input.setAttribute('aria-label', 'Rename tab');

    let committed = false;

    const commit = () => {
      if (committed) return;
      committed = true;
      const name = input.value.trim();
      if (name && name !== titleSpan.textContent) {
        this.callbacks.onRename(tabId, name);
      }
      input.replaceWith(titleSpan);
    };

    const cancel = () => {
      if (committed) return;
      committed = true;
      input.replaceWith(titleSpan);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      e.stopPropagation();
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());

    titleSpan.replaceWith(input);
    input.select();
    input.focus();
  }

  dispose(): void {
    this.container.innerHTML = '';
  }
}
