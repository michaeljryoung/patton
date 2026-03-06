import type { AppSettings } from '../../shared/types';
import { DEFAULTS } from '../../shared/constants';

export class SettingsPanel {
  private overlay: HTMLElement;
  private visible = false;
  private onSettingsChanged: (settings: Partial<AppSettings>) => void;

  constructor(container: HTMLElement, onSettingsChanged: (settings: Partial<AppSettings>) => void) {
    this.onSettingsChanged = onSettingsChanged;

    this.overlay = document.createElement('div');
    this.overlay.className = 'settings-overlay';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-label', 'Settings');

    this.overlay.innerHTML = `
      <div class="settings-backdrop"></div>
      <div class="settings-panel">
        <div class="settings-header">
          <h2>Settings</h2>
          <button class="settings-close" aria-label="Close settings">&times;</button>
        </div>
        <div class="settings-body">
          <div class="settings-group">
            <label class="settings-label" for="setting-font-size">Font Size</label>
            <input class="settings-input" id="setting-font-size" type="number" min="${DEFAULTS.FONT_SIZE_MIN}" max="${DEFAULTS.FONT_SIZE_MAX}" />
          </div>
          <div class="settings-group">
            <label class="settings-label" for="setting-font-family">Font Family</label>
            <select class="settings-input" id="setting-font-family">
              <option value="'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace">SF Mono</option>
              <option value="'Menlo', 'Monaco', 'Courier New', monospace">Menlo</option>
              <option value="'JetBrains Mono', 'Fira Code', monospace">JetBrains Mono</option>
              <option value="'Fira Code', monospace">Fira Code</option>
              <option value="'Monaco', 'Courier New', monospace">Monaco</option>
              <option value="'Courier New', monospace">Courier New</option>
            </select>
          </div>
          <div class="settings-group">
            <label class="settings-label" for="setting-scrollback">Scrollback Lines</label>
            <input class="settings-input" id="setting-scrollback" type="number" min="100" max="100000" step="1000" />
          </div>
          <div class="settings-group">
            <label class="settings-label" for="setting-shell">Shell Path</label>
            <input class="settings-input" id="setting-shell" type="text" placeholder="/bin/zsh" />
          </div>
          <div class="settings-group settings-group-toggle">
            <label class="settings-label" for="setting-notification-sound">Notification Sound</label>
            <label class="settings-toggle">
              <input type="checkbox" id="setting-notification-sound" />
              <span class="settings-toggle-slider"></span>
            </label>
            <span class="settings-hint">Play a sound when a command finishes</span>
          </div>
          <div class="shortcuts-section">
            <h3 class="shortcuts-title">Keyboard Shortcuts</h3>
            <div class="shortcuts-grid">
              <kbd>\u2318D</kbd><span>Split pane right</span>
              <kbd>\u2318\u21E7D</kbd><span>Split pane down</span>
              <kbd>\u2318\u2325\u2190\u2191\u2193\u2192</kbd><span>Navigate panes</span>
              <kbd>\u2318W</kbd><span>Close pane / tab</span>
              <kbd>\u2318T</kbd><span>New tab</span>
              <kbd>\u2318K</kbd><span>Clear terminal</span>
              <kbd>\u2318F</kbd><span>Find</span>
              <kbd>\u2318,</kbd><span>Settings</span>
              <kbd>\u2303\u21E7P</kbd><span>Toggle passthrough</span>
              <kbd>\u2303R</kbd><span>History search</span>
            </div>
          </div>
        </div>
      </div>
    `;

    container.appendChild(this.overlay);

    // Close handlers
    this.overlay.querySelector('.settings-close')!.addEventListener('click', () => this.hide());
    this.overlay.querySelector('.settings-backdrop')!.addEventListener('click', () => this.hide());

    // Escape key
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });

    // Save on change
    const fontSizeInput = this.overlay.querySelector('#setting-font-size') as HTMLInputElement;
    const fontFamilyInput = this.overlay.querySelector('#setting-font-family') as HTMLSelectElement;
    const scrollbackInput = this.overlay.querySelector('#setting-scrollback') as HTMLInputElement;
    const shellInput = this.overlay.querySelector('#setting-shell') as HTMLInputElement;

    fontSizeInput.addEventListener('change', () => {
      const val = parseInt(fontSizeInput.value);
      if (val >= 8 && val <= 72) {
        this.saveAndNotify({ fontSize: val });
      }
    });

    fontFamilyInput.addEventListener('change', () => {
      this.saveAndNotify({ fontFamily: fontFamilyInput.value });
    });

    scrollbackInput.addEventListener('change', () => {
      const val = parseInt(scrollbackInput.value);
      if (val >= 100 && val <= 100000) {
        this.saveAndNotify({ scrollback: val });
      }
    });

    shellInput.addEventListener('change', () => {
      if (shellInput.value.startsWith('/')) {
        this.saveAndNotify({ shell: shellInput.value });
      }
    });

    const notifInput = this.overlay.querySelector('#setting-notification-sound') as HTMLInputElement;
    notifInput.addEventListener('change', () => {
      this.saveAndNotify({ notificationSound: notifInput.checked });
    });
  }

  private saveAndNotify(settings: Partial<AppSettings>): void {
    window.patton.settings.set(settings).catch(console.error);
    this.onSettingsChanged(settings);
  }

  async show(): Promise<void> {
    // Load current settings
    const settings = await window.patton.settings.get();
    (this.overlay.querySelector('#setting-font-size') as HTMLInputElement).value = String(settings.fontSize);
    (this.overlay.querySelector('#setting-scrollback') as HTMLInputElement).value = String(settings.scrollback);
    (this.overlay.querySelector('#setting-shell') as HTMLInputElement).value = settings.shell;

    (this.overlay.querySelector('#setting-notification-sound') as HTMLInputElement).checked = settings.notificationSound !== false;

    // Match font family to select
    const select = this.overlay.querySelector('#setting-font-family') as HTMLSelectElement;
    const options = Array.from(select.options);
    const match = options.find(o => o.value === settings.fontFamily);
    if (match) {
      select.value = match.value;
    }

    this.visible = true;
    this.overlay.classList.add('visible');
    (this.overlay.querySelector('#setting-font-size') as HTMLInputElement).focus();
  }

  hide(): void {
    this.visible = false;
    this.overlay.classList.remove('visible');
  }

  isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show().catch(console.error);
    }
  }

  dispose(): void {
    this.overlay.remove();
  }
}
