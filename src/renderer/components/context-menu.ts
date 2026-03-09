interface ContextMenuItem {
  label: string;
  shortcut?: string;
  action: () => void;
}

interface ContextMenuSeparator {
  separator: true;
}

type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

export class ContextMenu {
  private overlay: HTMLElement;
  private menu: HTMLElement;
  private disposeListener: (() => void) | null = null;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'context-menu-overlay';

    this.menu = document.createElement('div');
    this.menu.className = 'context-menu';
    this.menu.setAttribute('role', 'menu');
    this.overlay.appendChild(this.menu);

    const dismiss = (e: MouseEvent) => {
      if (!this.menu.contains(e.target as Node)) {
        this.hide();
      }
    };
    this.overlay.addEventListener('mousedown', dismiss);

    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { this.hide(); return; }
      const items = this.menu.querySelectorAll('.context-menu-item');
      if (items.length === 0) return;
      const focused = this.menu.querySelector('.context-menu-item.focused');
      let idx = focused ? Array.from(items).indexOf(focused) : -1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        idx = (idx + 1) % items.length;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        idx = idx <= 0 ? items.length - 1 : idx - 1;
      } else if (e.key === 'Enter' && focused) {
        e.preventDefault();
        (focused as HTMLElement).click();
        return;
      } else {
        return;
      }
      for (const item of items) item.classList.remove('focused');
      items[idx].classList.add('focused');
      (items[idx] as HTMLElement).focus();
    };
    this.overlay.addEventListener('keydown', keyHandler);

    this.disposeListener = () => {
      this.overlay.removeEventListener('mousedown', dismiss);
      this.overlay.removeEventListener('keydown', keyHandler);
    };

    document.body.appendChild(this.overlay);
  }

  show(x: number, y: number, items: ContextMenuEntry[]): void {
    this.menu.innerHTML = '';
    for (const item of items) {
      if ('separator' in item) {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        this.menu.appendChild(sep);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'context-menu-item';
      el.setAttribute('role', 'menuitem');
      el.setAttribute('tabindex', '-1');

      const label = document.createElement('span');
      label.textContent = item.label;
      el.appendChild(label);

      if (item.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'context-menu-shortcut';
        shortcut.textContent = item.shortcut;
        el.appendChild(shortcut);
      }

      el.addEventListener('click', () => {
        this.hide();
        item.action();
      });
      this.menu.appendChild(el);
    }

    // Position (keep on screen)
    this.overlay.classList.add('visible');
    const menuRect = this.menu.getBoundingClientRect();
    const maxX = window.innerWidth - menuRect.width - 4;
    const maxY = window.innerHeight - menuRect.height - 4;
    this.menu.style.left = `${Math.min(x, maxX)}px`;
    this.menu.style.top = `${Math.min(y, maxY)}px`;
  }

  hide(): void {
    this.overlay.classList.remove('visible');
  }

  dispose(): void {
    this.disposeListener?.();
    this.overlay.remove();
  }
}
