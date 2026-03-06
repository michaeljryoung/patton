export class Onboarding {
  private overlay: HTMLElement;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'onboarding-overlay';
    this.overlay.innerHTML = `
      <div class="onboarding-panel">
        <h2 class="onboarding-title">Welcome to Patton</h2>
        <p class="onboarding-subtitle">A terminal with a built-in text editor for input.</p>
        <div class="onboarding-features">
          <div class="onboarding-feature">
            <span class="onboarding-icon">&#9998;</span>
            <div>
              <strong>Editor Mode</strong>
              <p>Type commands in the editor bar at the bottom. Press <kbd>Enter</kbd> to run, <kbd>Shift+Enter</kbd> for multi-line.</p>
            </div>
          </div>
          <div class="onboarding-feature">
            <span class="onboarding-icon">&#9654;</span>
            <div>
              <strong>Passthrough Mode</strong>
              <p>When you run vim, ssh, or other TUI apps, Patton auto-switches to direct terminal input.</p>
            </div>
          </div>
          <div class="onboarding-feature">
            <span class="onboarding-icon">&#8984;</span>
            <div>
              <strong>Key Shortcuts</strong>
              <p><kbd>\u2318D</kbd> split pane &middot; <kbd>\u2318T</kbd> new tab &middot; <kbd>\u2318,</kbd> settings &middot; <kbd>\u2303\u21E7P</kbd> toggle mode</p>
            </div>
          </div>
        </div>
        <button class="onboarding-dismiss">Get Started</button>
      </div>
    `;
    container.appendChild(this.overlay);

    this.overlay.querySelector('.onboarding-dismiss')!.addEventListener('click', () => {
      this.dismiss();
    });

    // Also dismiss on Escape
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') this.dismiss();
    });
  }

  show(): void {
    this.overlay.classList.add('visible');
    (this.overlay.querySelector('.onboarding-dismiss') as HTMLElement).focus();
  }

  private dismiss(): void {
    this.overlay.classList.remove('visible');
    // Mark as shown in localStorage (persists across sessions)
    localStorage.setItem('patton-onboarding-shown', '1');
    setTimeout(() => this.overlay.remove(), 200);
  }

  static shouldShow(): boolean {
    return !localStorage.getItem('patton-onboarding-shown');
  }

  dispose(): void {
    this.overlay.remove();
  }
}
