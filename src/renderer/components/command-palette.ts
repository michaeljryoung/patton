import { trapFocus } from '../services/focus-trap';

export interface PaletteAction {
  label: string;
  shortcut?: string;
  action: string;
}

export class CommandPalette {
  private overlay: HTMLElement;
  private panel: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private visible = false;
  private onAction: (actionId: string) => void;
  private actions: PaletteAction[] = [];
  private filteredActions: PaletteAction[] = [];
  private selectedIndex = 0;
  private disposables: (() => void)[] = [];
  private releaseFocusTrap: (() => void) | null = null;

  constructor(container: HTMLElement, onAction: (actionId: string) => void) {
    this.onAction = onAction;

    this.overlay = document.createElement('div');
    this.overlay.className = 'command-palette-overlay';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Command Palette');

    const backdrop = document.createElement('div');
    backdrop.className = 'command-palette-backdrop';
    const backdropHandler = () => this.hide();
    backdrop.addEventListener('click', backdropHandler);
    this.disposables.push(() => backdrop.removeEventListener('click', backdropHandler));

    this.panel = document.createElement('div');
    this.panel.className = 'command-palette-panel';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'command-palette-input';
    this.input.placeholder = 'Type a command...';
    this.input.setAttribute('aria-label', 'Search commands');
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('spellcheck', 'false');
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-controls', 'command-palette-list');
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-autocomplete', 'list');

    this.list = document.createElement('div');
    this.list.id = 'command-palette-list';
    this.list.className = 'command-palette-list';
    this.list.setAttribute('role', 'listbox');

    this.panel.appendChild(this.input);
    this.panel.appendChild(this.list);
    this.overlay.appendChild(backdrop);
    this.overlay.appendChild(this.panel);
    container.appendChild(this.overlay);

    // Input filtering
    const inputHandler = () => { this.filterAndRender(); };
    this.input.addEventListener('input', inputHandler);
    this.disposables.push(() => this.input.removeEventListener('input', inputHandler));

    // Keyboard navigation
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveSelection(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.executeSelected();
      }
    };
    this.input.addEventListener('keydown', keydownHandler);
    this.disposables.push(() => this.input.removeEventListener('keydown', keydownHandler));

    // Click handling
    const clickHandler = (e: MouseEvent) => {
      const item = (e.target as HTMLElement).closest('.command-palette-item');
      if (item) {
        const index = parseInt(item.getAttribute('data-index') || '0', 10);
        this.executeAction(this.filteredActions[index]);
      }
    };
    this.list.addEventListener('click', clickHandler);
    this.disposables.push(() => this.list.removeEventListener('click', clickHandler));

    // Close on escape from anywhere in the overlay
    const overlayKeydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.hide();
      }
    };
    this.overlay.addEventListener('keydown', overlayKeydownHandler);
    this.disposables.push(() => this.overlay.removeEventListener('keydown', overlayKeydownHandler));
  }

  show(actions: PaletteAction[]): void {
    this.actions = actions;
    this.filteredActions = [...actions];
    this.selectedIndex = 0;
    this.input.value = '';
    this.renderActions();
    this.visible = true;
    this.overlay.classList.add('visible');
    this.input.focus();
    this.releaseFocusTrap = trapFocus(this.overlay);
  }

  hide(): void {
    this.visible = false;
    this.overlay.classList.remove('visible');
    this.input.value = '';
    this.actions = [];
    this.filteredActions = [];
    this.selectedIndex = 0;
    this.releaseFocusTrap?.();
    this.releaseFocusTrap = null;
  }

  toggle(actions: PaletteAction[]): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show(actions);
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  dispose(): void {
    for (const d of this.disposables) d();
    this.overlay.remove();
  }

  private filterAndRender(): void {
    const query = this.input.value.toLowerCase().trim();

    if (!query) {
      this.filteredActions = [...this.actions];
    } else {
      // Fuzzy substring match
      this.filteredActions = this.actions.filter(action =>
        action.label.toLowerCase().includes(query)
      );
    }

    this.selectedIndex = 0;
    this.renderActions();
  }

  private renderActions(): void {
    this.list.innerHTML = '';

    if (this.filteredActions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'command-palette-empty';
      empty.textContent = 'No commands found';
      this.list.appendChild(empty);
      return;
    }

    this.filteredActions.forEach((action, index) => {
      const item = document.createElement('div');
      item.className = 'command-palette-item';
      item.id = `command-palette-item-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('data-index', String(index));

      if (index === this.selectedIndex) {
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
        this.input.setAttribute('aria-activedescendant', item.id);
      } else {
        item.setAttribute('aria-selected', 'false');
      }

      const label = document.createElement('span');
      label.className = 'command-palette-label';
      label.textContent = action.label;

      item.appendChild(label);

      if (action.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'command-palette-shortcut';
        shortcut.textContent = action.shortcut;
        item.appendChild(shortcut);
      }

      this.list.appendChild(item);
    });
  }

  private moveSelection(delta: number): void {
    if (this.filteredActions.length === 0) return;

    this.selectedIndex += delta;

    // Wrap around
    if (this.selectedIndex < 0) {
      this.selectedIndex = this.filteredActions.length - 1;
    } else if (this.selectedIndex >= this.filteredActions.length) {
      this.selectedIndex = 0;
    }

    this.updateSelection();
  }

  private updateSelection(): void {
    const items = this.list.querySelectorAll('.command-palette-item');
    items.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
        item.scrollIntoView({ block: 'nearest' });
        this.input.setAttribute('aria-activedescendant', item.id);
      } else {
        item.classList.remove('selected');
        item.setAttribute('aria-selected', 'false');
      }
    });
  }

  private executeSelected(): void {
    if (this.filteredActions.length === 0) return;
    this.executeAction(this.filteredActions[this.selectedIndex]);
  }

  private executeAction(action: PaletteAction): void {
    this.hide();
    this.onAction(action.action);
  }
}
