import { TabManager } from '../services/tab-manager';
import { KeybindingManager } from '../services/keybinding-manager';
import { NotificationSound } from '../services/notification-sound';
import { getThemeById, applyThemeToCSS, clearThemeCSS } from '../services/themes';
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
      onCommandDone: (tabId, tabTitle) => {
        this.notificationSound.play();
        // Send native notification for background tabs
        if (!this.tabManager.isActiveTab(tabId) || document.hidden) {
          window.patton.notify('Patton', `Command finished in ${tabTitle}`, tabId);
        }
      },
    });
    this.keybindingManager = new KeybindingManager(this.tabManager);
    this.settingsPanel = new SettingsPanel(appEl, (settings) => {
      if (settings.fontSize !== undefined) {
        this.fontSize = settings.fontSize;
        this.tabManager.setFontSize(this.fontSize);
      }
      if (settings.fontFamily !== undefined) {
        this.tabManager.setFontFamily(settings.fontFamily);
      }
      if (settings.scrollback !== undefined) {
        this.tabManager.setScrollback(settings.scrollback);
      }
      if (settings.notificationSound !== undefined) {
        this.notificationSound.setEnabled(settings.notificationSound);
      }
      if (settings.notificationSoundType !== undefined) {
        this.notificationSound.setType(settings.notificationSoundType);
        this.notificationSound.playPreview();
      }
      if (settings.copyOnSelect !== undefined) {
        this.tabManager.setCopyOnSelect(settings.copyOnSelect);
      }
      if (settings.theme !== undefined) {
        this.applyTheme(settings.theme);
      }
    });

    this.registerAppListeners();
    this.registerSettingsShortcut();

    // Handle notification clicks → switch to tab
    this.disposables.push(
      window.patton.app.onSwitchTabById((id) => {
        this.tabManager.switchToId(id);
      }),
    );

    // Cmd+Shift+B: Toggle broadcast input
    this.disposables.push(
      window.patton.app.onBroadcastInput(() => {
        const tab = this.tabManager.getActiveTab();
        tab?.toggleBroadcastInput();
      }),
    );

    // Cmd+S: Save terminal output
    this.disposables.push(
      window.patton.app.onSaveTerminal(() => {
        const tab = this.tabManager.getActiveTab();
        if (!tab) return;
        const content = tab.getScrollbackContent();
        if (!content) return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const tabName = tab.title.replace(/[^a-zA-Z0-9-_]/g, '_');
        const defaultName = `patton-${tabName}-${timestamp}.txt`;
        window.patton.terminal.saveOutput(content, defaultName).catch(console.error);
      }),
    );
  }

  async init(): Promise<void> {
    // Load settings and history in parallel (two independent IPC calls)
    const [settings] = await Promise.all([
      window.patton.settings.get(),
      this.tabManager.loadHistory(),
    ]);
    this.fontSize = settings.fontSize;
    this.tabManager.setFontSize(this.fontSize);
    if (settings.fontFamily) {
      this.tabManager.setFontFamily(settings.fontFamily);
    }
    if (settings.scrollback) {
      this.tabManager.setScrollback(settings.scrollback);
    }
    if (settings.shell) {
      this.tabManager.setShell(settings.shell);
    }
    this.notificationSound.setEnabled(settings.notificationSound !== false);
    if (settings.notificationSoundType) {
      this.notificationSound.setType(settings.notificationSoundType);
    }
    this.tabManager.setCopyOnSelect(settings.copyOnSelect === true);
    this.settingsPanel.loadSettings(settings);
    if (settings.theme && settings.theme !== 'system') {
      this.applyTheme(settings.theme);
    }

    // Try to restore previous session
    const restored = await this.tabManager.restoreSession();

    if (!restored) {
      // Create initial tab
      const firstTab = await this.tabManager.createTab();

      // Show onboarding on first run
      if (Onboarding.shouldShow()) {
        const onboarding = new Onboarding(document.getElementById('app')!);
        onboarding.show();
      }

      // Execute startup command on fresh launch (first tab only)
      // Small delay to let the shell initialize before sending input
      if (settings.startupCommand && firstTab.ptyId !== null) {
        const ptyId = firstTab.ptyId;
        const cmd = settings.startupCommand;
        setTimeout(() => {
          window.patton.pty.write(ptyId, cmd + '\r');
        }, 300);
      }
    }

    // Save session on window unload (app close)
    window.addEventListener('beforeunload', () => {
      // Synchronous: fire and forget — the main process handles persistence
      this.tabManager.saveSession().catch(() => {});
    });
  }

  private registerAppListeners(): void {
    this.disposables.push(
      window.patton.app.onSettings(() => {
        this.settingsPanel.toggle();
      }),
    );

    this.disposables.push(
      window.patton.app.onNewTab(() => {
        this.tabManager.createTab().catch(console.error);
      }),
    );

    this.disposables.push(
      window.patton.app.onCloseTab(() => {
        this.tabManager.closeActivePane().catch(console.error);
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

  private applyTheme(themeId: string): void {
    if (themeId === 'system') {
      clearThemeCSS();
      this.tabManager.setTerminalTheme(null);
    } else {
      const theme = getThemeById(themeId);
      if (theme) {
        applyThemeToCSS(theme);
        this.tabManager.setTerminalTheme(theme.terminal);
      }
    }
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
