import { trapFocus } from '../services/focus-trap';
import { shortcutKeys } from '../../shared/shortcuts';

export class Onboarding {
  private overlay: HTMLElement;
  private disposables: (() => void)[] = [];
  private releaseFocusTrap: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'onboarding-overlay';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Welcome to Patton');
    this.overlay.innerHTML = `
      <div class="onboarding-panel">
        <h2 class="onboarding-title">Welcome to Patton</h2>
        <p class="onboarding-subtitle">A terminal with a built-in compose panel for drafting commands.</p>
        <div class="onboarding-features">
          <div class="onboarding-feature">
            <span class="onboarding-icon">&#9654;</span>
            <div>
              <strong>Full Terminal</strong>
              <p>Works like any native terminal. Type directly, run vim, ssh, or any TUI app — no mode switching needed.</p>
            </div>
          </div>
          <div class="onboarding-feature">
            <span class="onboarding-icon">&#9998;</span>
            <div>
              <strong>Compose Panel</strong>
              <p>Press <kbd>${shortcutKeys('toggle-compose')}</kbd> to open a text editor for drafting multi-line commands. <kbd>Enter</kbd> sends, <kbd>Esc</kbd> dismisses.</p>
            </div>
          </div>
          <div class="onboarding-feature">
            <span class="onboarding-icon">&#8984;</span>
            <div>
              <strong>Key Shortcuts</strong>
              <p><kbd>${shortcutKeys('split-vertical')}</kbd> split pane &middot; <kbd>${shortcutKeys('new-tab')}</kbd> new tab &middot; <kbd>${shortcutKeys('settings')}</kbd> settings &middot; <kbd>${shortcutKeys('command-palette')}</kbd> command palette</p>
            </div>
          </div>
        </div>
        <button class="onboarding-dismiss">Get Started</button>
      </div>
    `;
    container.appendChild(this.overlay);

    const dismissBtn = this.overlay.querySelector('.onboarding-dismiss') as HTMLElement;
    const clickHandler = () => { this.dismiss(); };
    dismissBtn.addEventListener('click', clickHandler);
    this.disposables.push(() => dismissBtn.removeEventListener('click', clickHandler));

    // Also dismiss on Escape
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') this.dismiss();
    };
    this.overlay.addEventListener('keydown', keydownHandler);
    this.disposables.push(() => this.overlay.removeEventListener('keydown', keydownHandler));
  }

  show(): void {
    this.overlay.classList.add('visible');
    (this.overlay.querySelector('.onboarding-dismiss') as HTMLElement).focus();
    this.releaseFocusTrap = trapFocus(this.overlay);
  }

  private dismiss(): void {
    this.overlay.classList.remove('visible');
    this.releaseFocusTrap?.();
    this.releaseFocusTrap = null;
    // Mark as shown in localStorage (persists across sessions)
    localStorage.setItem('patton-onboarding-shown', '1');
    setTimeout(() => {
      for (const d of this.disposables) d();
      this.overlay.remove();
    }, 200);
  }

  static shouldShow(): boolean {
    return !localStorage.getItem('patton-onboarding-shown');
  }

  dispose(): void {
    for (const d of this.disposables) d();
    this.overlay.remove();
  }
}
