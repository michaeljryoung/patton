import { TabManager } from '../services/tab-manager';
import { KeybindingManager } from '../services/keybinding-manager';
import { NotificationSound } from '../services/notification-sound';
import { SettingsPanel } from './settings-panel';
import { Onboarding } from './onboarding';
import { DEFAULTS } from '../../shared/constants';

export class App {
  private tabManager: TabManager;
  private keybindingManager: KeybindingManager;
  private settingsPanel: SettingsPanel;
  private notificationSound: NotificationSound;
  private fontSize: number = DEFAULTS.FONT_SIZE;
  private disposables: (() => void)[] = [];

  constructor() {
    const tabBarEl = document.getElementById('tab-bar')!;
    const contentEl = document.getElementById('content')!;
    const appEl = document.getElementById('app')!;

    this.notificationSound = new NotificationSound();
    this.tabManager = new TabManager(tabBarEl, contentEl, {
      onSettings: () => this.settingsPanel.toggle(),
      onCommandDone: () => this.notificationSound.play(),
    });
    this.keybindingManager = new KeybindingManager(this.tabManager);
    this.settingsPanel = new SettingsPanel(appEl, (settings) => {
      if (settings.fontSize !== undefined) {
        this.fontSize = settings.fontSize;
        this.tabManager.setFontSize(this.fontSize);
      }
      if (settings.notificationSound !== undefined) {
        this.notificationSound.setEnabled(settings.notificationSound);
      }
    });

    this.registerAppListeners();
    this.registerSettingsShortcut();
  }

  async init(): Promise<void> {
    // Load settings
    const settings = await window.patton.settings.get();
    this.fontSize = settings.fontSize;
    this.tabManager.setFontSize(this.fontSize);
    this.notificationSound.setEnabled(settings.notificationSound !== false);

    // Create initial tab
    await this.tabManager.createTab();

    // Show onboarding on first run
    if (Onboarding.shouldShow()) {
      const onboarding = new Onboarding(document.getElementById('app')!);
      onboarding.show();
    }
  }

  private registerAppListeners(): void {
    this.disposables.push(
      window.patton.app.onNewTab(() => {
        this.tabManager.createTab().catch(console.error);
      }),
    );

    this.disposables.push(
      window.patton.app.onCloseTab(() => {
        this.tabManager.closeActivePane();
      }),
    );

    this.disposables.push(
      window.patton.app.onNextTab(() => {
        this.tabManager.nextTab();
      }),
    );

    this.disposables.push(
      window.patton.app.onPrevTab(() => {
        this.tabManager.prevTab();
      }),
    );

    this.disposables.push(
      window.patton.app.onSwitchTab((index) => {
        this.tabManager.switchToIndex(index);
      }),
    );

    this.disposables.push(
      window.patton.app.onClear(() => {
        const tab = this.tabManager.getActiveTab();
        tab?.clear();
      }),
    );

    this.disposables.push(
      window.patton.app.onSearch(() => {
        const tab = this.tabManager.getActiveTab();
        tab?.searchOverlay.toggle();
      }),
    );

    this.disposables.push(
      window.patton.app.onFontSizeUp(() => {
        this.fontSize = Math.min(this.fontSize + 2, DEFAULTS.FONT_SIZE_MAX);
        this.applyFontSize();
      }),
    );

    this.disposables.push(
      window.patton.app.onFontSizeDown(() => {
        this.fontSize = Math.max(this.fontSize - 2, DEFAULTS.FONT_SIZE_MIN);
        this.applyFontSize();
      }),
    );

    this.disposables.push(
      window.patton.app.onSplitVertical(() => {
        this.tabManager.splitVertical();
      }),
    );

    this.disposables.push(
      window.patton.app.onSplitHorizontal(() => {
        this.tabManager.splitHorizontal();
      }),
    );

    this.disposables.push(
      window.patton.app.onFocusPaneUp(() => {
        this.tabManager.focusPaneInDirection('up');
      }),
    );

    this.disposables.push(
      window.patton.app.onFocusPaneDown(() => {
        this.tabManager.focusPaneInDirection('down');
      }),
    );

    this.disposables.push(
      window.patton.app.onFocusPaneLeft(() => {
        this.tabManager.focusPaneInDirection('left');
      }),
    );

    this.disposables.push(
      window.patton.app.onFocusPaneRight(() => {
        this.tabManager.focusPaneInDirection('right');
      }),
    );
  }

  private applyFontSize(): void {
    // Apply to ALL tabs, not just the active one
    this.tabManager.setFontSize(this.fontSize);
    window.patton.settings.set({ fontSize: this.fontSize }).catch(console.error);
  }

  private registerSettingsShortcut(): void {
    const handler = (e: KeyboardEvent) => {
      // Cmd+, (macOS) or Ctrl+, (other)
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        this.settingsPanel.toggle();
      }
    };
    document.addEventListener('keydown', handler);
    this.disposables.push(() => document.removeEventListener('keydown', handler));
  }

  dispose(): void {
    for (const d of this.disposables) d();
    this.keybindingManager.dispose();
    this.settingsPanel.dispose();
    this.notificationSound.dispose();
    this.tabManager.dispose();
  }
}
