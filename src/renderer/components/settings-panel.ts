import type { AppSettings } from '../../shared/types';
import { DEFAULTS } from '../../shared/constants';

export class SettingsPanel {
  private overlay: HTMLElement;
  private visible = false;
  private onSettingsChanged: (settings: Partial<AppSettings>) => void;
  private cachedSettings: AppSettings | null = null;
  private disposables: (() => void)[] = [];

  constructor(container: HTMLElement, onSettingsChanged: (settings: Partial<AppSettings>) => void) {
    this.onSettingsChanged = onSettingsChanged;

    this.overlay = document.createElement('div');
    this.overlay.className = 'settings-overlay';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
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
          <div class="settings-group">
            <label class="settings-label" for="setting-theme">Color Theme</label>
            <select class="settings-input" id="setting-theme">
              <option value="system">System (Auto)</option>
              <option value="dracula">Dracula</option>
              <option value="nord">Nord</option>
              <option value="solarized-dark">Solarized Dark</option>
              <option value="one-dark">One Dark</option>
              <option value="monokai">Monokai</option>
              <option value="tokyo-night">Tokyo Night</option>
              <option value="catppuccin-mocha">Catppuccin Mocha</option>
              <option value="catppuccin-latte">Catppuccin Latte</option>
              <option value="gruvbox-dark">Gruvbox Dark</option>
              <option value="gruvbox-light">Gruvbox Light</option>
              <option value="rose-pine">Rosé Pine</option>
              <option value="rose-pine-dawn">Rosé Pine Dawn</option>
              <option value="kanagawa">Kanagawa</option>
              <option value="github-dark">GitHub Dark</option>
              <option value="github-light">GitHub Light</option>
              <option value="everforest-dark">Everforest Dark</option>
              <option value="horizon">Horizon</option>
              <option value="ayu-dark">Ayu Dark</option>
              <option value="ayu-light">Ayu Light</option>
            </select>
          </div>
          <div class="settings-group settings-group-toggle">
            <label class="settings-label" for="setting-notification-sound">Notification Sound</label>
            <label class="settings-toggle">
              <input type="checkbox" id="setting-notification-sound" />
              <span class="settings-toggle-slider"></span>
            </label>
            <span class="settings-hint">Play a sound when a command finishes</span>
          </div>
          <div class="settings-group">
            <label class="settings-label" for="setting-notification-sound-type">Notification Sound Type</label>
            <select class="settings-input" id="setting-notification-sound-type">
              <option value="chime">Chime</option>
              <option value="bugle">Bugle</option>
              <option value="bullet">Bullet</option>
            </select>
          </div>
          <div class="settings-group settings-group-toggle">
            <label class="settings-label" for="setting-copy-on-select">Copy on Select</label>
            <label class="settings-toggle">
              <input type="checkbox" id="setting-copy-on-select" />
              <span class="settings-toggle-slider"></span>
            </label>
            <span class="settings-hint">Auto-copy selected text to clipboard</span>
          </div>
          <div class="settings-group">
            <label class="settings-label" for="setting-opacity">Window Opacity</label>
            <div class="settings-range-row">
              <input class="settings-range" id="setting-opacity" type="range" min="30" max="100" step="5" />
              <span class="settings-range-value" id="setting-opacity-value">100%</span>
            </div>
            <span class="settings-hint">Make the window semi-transparent to see content behind it</span>
          </div>
          <div class="settings-group">
            <label class="settings-label" for="setting-startup-command">Startup Command</label>
            <input class="settings-input" id="setting-startup-command" type="text" placeholder="e.g., claude" />
            <span class="settings-hint">Run this command when Patton launches (fresh tabs only)</span>
          </div>
          <div class="settings-group settings-group-toggle">
            <label class="settings-label" for="setting-restore-session">Restore Session</label>
            <label class="settings-toggle">
              <input type="checkbox" id="setting-restore-session" />
              <span class="settings-toggle-slider"></span>
            </label>
            <span class="settings-hint">Reopen tabs from your last session on launch</span>
          </div>
          <div class="settings-group settings-group-toggle">
            <label class="settings-label" for="setting-shell-integration">Shell Integration</label>
            <label class="settings-toggle">
              <input type="checkbox" id="setting-shell-integration" />
              <span class="settings-toggle-slider"></span>
            </label>
            <span class="settings-hint">Inject OSC 133 markers for prompt detection (new tabs only)</span>
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
              <kbd>\u2318\u21E7\u23CE</kbd><span>Zoom split</span>
              <kbd>\u2318\u21E7T</kbd><span>Reopen closed tab</span>
              <kbd>\u2318\u21E7P</kbd><span>Command palette</span>
              <kbd>\u2318\u21E7\u2191\u2193</kbd><span>Jump between prompts</span>
              <kbd>\u2318E</kbd><span>Compose panel</span>
              <kbd>\u2303R</kbd><span>History search</span>
            </div>
          </div>
        </div>
      </div>
    `;

    container.appendChild(this.overlay);

    // Helper to register and track event listeners for cleanup
    const listen = <K extends keyof HTMLElementEventMap>(el: HTMLElement, event: K, handler: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(event, handler);
      this.disposables.push(() => el.removeEventListener(event, handler));
    };

    // Close handlers
    listen(this.overlay.querySelector('.settings-close') as HTMLElement, 'click', () => this.hide());
    listen(this.overlay.querySelector('.settings-backdrop') as HTMLElement, 'click', () => this.hide());

    // Escape key
    listen(this.overlay, 'keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });

    // Save on change
    const fontSizeInput = this.overlay.querySelector('#setting-font-size') as HTMLInputElement;
    const fontFamilyInput = this.overlay.querySelector('#setting-font-family') as HTMLSelectElement;
    const scrollbackInput = this.overlay.querySelector('#setting-scrollback') as HTMLInputElement;
    const shellInput = this.overlay.querySelector('#setting-shell') as HTMLInputElement;

    listen(fontSizeInput, 'change', () => {
      const val = parseInt(fontSizeInput.value, 10);
      if (val >= 8 && val <= 72) {
        this.saveAndNotify({ fontSize: val });
      }
    });

    listen(fontFamilyInput, 'change', () => {
      this.saveAndNotify({ fontFamily: fontFamilyInput.value });
    });

    const themeInput = this.overlay.querySelector('#setting-theme') as HTMLSelectElement;
    listen(themeInput, 'change', () => {
      this.saveAndNotify({ theme: themeInput.value });
    });

    listen(scrollbackInput, 'change', () => {
      const val = parseInt(scrollbackInput.value, 10);
      if (val >= 100 && val <= 100000) {
        this.saveAndNotify({ scrollback: val });
      }
    });

    listen(shellInput, 'change', () => {
      if (shellInput.value.startsWith('/')) {
        this.saveAndNotify({ shell: shellInput.value });
      }
    });

    const notifInput = this.overlay.querySelector('#setting-notification-sound') as HTMLInputElement;
    listen(notifInput, 'change', () => {
      this.saveAndNotify({ notificationSound: notifInput.checked });
    });

    const copyOnSelectInput = this.overlay.querySelector('#setting-copy-on-select') as HTMLInputElement;
    listen(copyOnSelectInput, 'change', () => {
      this.saveAndNotify({ copyOnSelect: copyOnSelectInput.checked });
    });

    const soundTypeInput = this.overlay.querySelector('#setting-notification-sound-type') as HTMLSelectElement;
    listen(soundTypeInput, 'change', () => {
      this.saveAndNotify({ notificationSoundType: soundTypeInput.value });
    });

    const opacityInput = this.overlay.querySelector('#setting-opacity') as HTMLInputElement;
    const opacityValue = this.overlay.querySelector('#setting-opacity-value') as HTMLSpanElement;
    listen(opacityInput, 'input', () => {
      const pct = parseInt(opacityInput.value, 10);
      opacityValue.textContent = `${pct}%`;
      const opacity = pct / 100;
      window.patton.setOpacity(opacity);
      this.saveAndNotify({ opacity });
    });

    const startupCommandInput = this.overlay.querySelector('#setting-startup-command') as HTMLInputElement;
    listen(startupCommandInput, 'change', () => {
      this.saveAndNotify({ startupCommand: startupCommandInput.value });
    });

    const restoreSessionInput = this.overlay.querySelector('#setting-restore-session') as HTMLInputElement;
    listen(restoreSessionInput, 'change', () => {
      this.saveAndNotify({ restoreSession: restoreSessionInput.checked });
    });

    const shellIntegrationInput = this.overlay.querySelector('#setting-shell-integration') as HTMLInputElement;
    listen(shellIntegrationInput, 'change', () => {
      this.saveAndNotify({ shellIntegration: shellIntegrationInput.checked });
    });
  }

  private saveAndNotify(settings: Partial<AppSettings>): void {
    window.patton.settings.set(settings).catch(console.error);
    if (this.cachedSettings) {
      Object.assign(this.cachedSettings, settings);
    }
    this.onSettingsChanged(settings);
  }

  /** Pre-load settings into cache so show() is instant. Call from App.init(). */
  loadSettings(settings: AppSettings): void {
    this.cachedSettings = { ...settings };
  }

  show(): void {
    // Use cached settings for instant open — no IPC on the critical path
    if (this.cachedSettings) {
      this.populateValues(this.cachedSettings);
    }
    this.visible = true;
    this.overlay.classList.add('visible');
    (this.overlay.querySelector('#setting-font-size') as HTMLInputElement).focus();
  }

  private populateValues(settings: AppSettings): void {
    (this.overlay.querySelector('#setting-font-size') as HTMLInputElement).value = String(settings.fontSize);
    (this.overlay.querySelector('#setting-scrollback') as HTMLInputElement).value = String(settings.scrollback);
    (this.overlay.querySelector('#setting-shell') as HTMLInputElement).value = settings.shell;

    (this.overlay.querySelector('#setting-notification-sound') as HTMLInputElement).checked = settings.notificationSound !== false;
    (this.overlay.querySelector('#setting-notification-sound-type') as HTMLSelectElement).value = settings.notificationSoundType || 'chime';
    (this.overlay.querySelector('#setting-copy-on-select') as HTMLInputElement).checked = settings.copyOnSelect === true;
    (this.overlay.querySelector('#setting-startup-command') as HTMLInputElement).value = settings.startupCommand || '';
    (this.overlay.querySelector('#setting-restore-session') as HTMLInputElement).checked = settings.restoreSession !== false;
    (this.overlay.querySelector('#setting-shell-integration') as HTMLInputElement).checked = settings.shellIntegration !== false;

    (this.overlay.querySelector('#setting-theme') as HTMLSelectElement).value = settings.theme || 'system';

    const opacityPct = Math.round((settings.opacity ?? 1.0) * 100);
    (this.overlay.querySelector('#setting-opacity') as HTMLInputElement).value = String(opacityPct);
    (this.overlay.querySelector('#setting-opacity-value') as HTMLSpanElement).textContent = `${opacityPct}%`;

    const select = this.overlay.querySelector('#setting-font-family') as HTMLSelectElement;
    const options = Array.from(select.options);
    const match = options.find(o => o.value === settings.fontFamily);
    if (match) {
      select.value = match.value;
    }
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
      this.show();
    }
  }

  dispose(): void {
    for (const d of this.disposables) d();
    this.overlay.remove();
  }
}
