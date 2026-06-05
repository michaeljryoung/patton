import { TabManager } from '../services/tab-manager';
import { KeybindingManager } from '../services/keybinding-manager';
import { NotificationSound } from '../services/notification-sound';
import { getThemeById, applyThemeToCSS, clearThemeCSS } from '../services/themes';
import { announce } from '../services/announcer';
import { SettingsPanel } from './settings-panel';
import { CommandPalette } from './command-palette';
import { QuickTerminal } from './quick-terminal';
import { Onboarding } from './onboarding';
import { DEFAULTS } from '../../shared/constants';

export class App {
  private tabManager: TabManager;
  private keybindingManager: KeybindingManager;
  private settingsPanel: SettingsPanel;
  private commandPalette: CommandPalette;
  private quickTerminal: QuickTerminal;
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
        // Send native notification for background tabs OR when Patton itself
        // doesn't have user focus. NOTE: we use `document.hasFocus()` instead
        // of `document.hidden` because window-manager sets `backgroundThrottling:
        // false` to prevent a WebGL atlas-corruption bug, and that pin keeps
        // visibilityState 'visible' even when Patton is occluded — which would
        // suppress all "app in background" notifications. `hasFocus()` reflects
        // actual user focus and is unaffected by the throttling pin.
        if (!this.tabManager.isActiveTab(tabId) || !document.hasFocus()) {
          window.patton.notify('Patton', `Command finished in ${tabTitle}`, tabId);
        }
      },
    });
    this.keybindingManager = new KeybindingManager(this.tabManager);
    this.settingsPanel = new SettingsPanel(appEl, (settings) => {
      if (settings.fontSize !== undefined) {
        this.fontSize = settings.fontSize;
        this.tabManager.setFontSize(this.fontSize);
        this.quickTerminal.setFontSize(this.fontSize);
      }
      if (settings.fontFamily !== undefined) {
        this.tabManager.setFontFamily(settings.fontFamily);
        this.quickTerminal.setFontFamily(settings.fontFamily);
      }
      if (settings.scrollback !== undefined) {
        this.tabManager.setScrollback(settings.scrollback);
        this.quickTerminal.setScrollback(settings.scrollback);
      }
      if (settings.renderer !== undefined) {
        this.tabManager.setRenderer(settings.renderer);
        this.quickTerminal.setRenderer(settings.renderer);
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
      announce('Settings saved');
    });

    this.commandPalette = new CommandPalette(appEl, (actionId) => {
      this.executeAction(actionId);
    });

    this.quickTerminal = new QuickTerminal(appEl);

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
        if (!tab) return;
        tab.toggleBroadcastInput();
        announce(tab.isBroadcasting ? 'Broadcast input enabled' : 'Broadcast input disabled');
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
    this.tabManager.setRenderer(settings.renderer || 'webgl');
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

    // Apply window opacity
    if (settings.opacity !== undefined && settings.opacity < 1.0) {
      window.patton.setOpacity(settings.opacity);
    }

    // Configure quick terminal
    if (settings.shell) this.quickTerminal.setShell(settings.shell);
    this.quickTerminal.setHistoryManager(this.tabManager['sharedHistory']);
    this.quickTerminal.setFontSize(this.fontSize);
    if (settings.fontFamily) this.quickTerminal.setFontFamily(settings.fontFamily);
    if (settings.scrollback) this.quickTerminal.setScrollback(settings.scrollback);
    this.quickTerminal.setRenderer(settings.renderer || 'webgl');

    // Try to restore previous session (if enabled)
    // Restore previous session if enabled, otherwise start fresh
    const restored = settings.restoreSession !== false
      ? await this.tabManager.restoreSession()
      : false;

    if (!restored) {
      await this.tabManager.createTab();

      // Show onboarding on first run
      if (Onboarding.shouldShow()) {
        const onboarding = new Onboarding(document.getElementById('app')!);
        onboarding.show();
      }
    }

    // Execute startup command in the active tab (restored or fresh).
    // Restore only recovers tab layout + scrollback — all PTYs are fresh shells,
    // so the startup command is always safe to run.
    //
    // Timing: wait for the shell's first prompt signal (OSC 133;B) rather than
    // a fixed 500ms. A slow shell (plugins, slow .zshrc) can exceed 500ms on
    // cold start, making the old code race — the startup command gets swallowed
    // by the not-yet-ready shell. The 500ms fallback covers shells without
    // shell integration (no OSC 133 emit).
    if (settings.startupCommand) {
      const activeTab = this.tabManager.getActiveTab();
      const ptyId = activeTab?.ptyId ?? null;
      if (ptyId !== null && activeTab) {
        const cmd = settings.startupCommand;
        let fired = false;
        const fire = () => {
          if (fired || ptyId === null) return;
          fired = true;
          window.patton.pty.write(ptyId, cmd + '\r');
        };
        const dispose = activeTab.focusedPane.terminalView.onPromptState((state) => {
          if (state === 'prompt' && !fired) {
            fire();
            dispose?.();
          }
        });
        // Fallback if no prompt signal arrives (shell integration disabled,
        // exotic shell, etc.)
        setTimeout(() => {
          if (!fired) {
            fire();
            dispose?.();
          }
        }, 1500);
      }
    }

    // Save session on window unload (app close)
    const beforeUnloadHandler = () => {
      // Synchronous: fire and forget — the main process handles persistence
      this.tabManager.saveSession().catch(() => {});
    };
    window.addEventListener('beforeunload', beforeUnloadHandler);
    this.disposables.push(() => window.removeEventListener('beforeunload', beforeUnloadHandler));

    // Periodic autosave. `beforeunload` alone is fragile — it doesn't fire on
    // renderer crash, and its fire-and-forget async save races process
    // teardown. A 30s background save keeps persisted state within half a
    // minute of reality, which is what crash recovery needs to be useful.
    const AUTOSAVE_INTERVAL_MS = 30_000;
    const autosaveTimer = setInterval(() => {
      this.tabManager.saveSession().catch(() => {});
    }, AUTOSAVE_INTERVAL_MS);
    this.disposables.push(() => clearInterval(autosaveTimer));
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

    // Split zoom: Cmd+Shift+Enter
    this.disposables.push(
      window.patton.app.onSplitZoom(() => {
        this.tabManager.toggleZoom();
      }),
    );

    // Reopen closed tab: Cmd+Shift+T
    this.disposables.push(
      window.patton.app.onUndoClose(() => {
        this.tabManager.reopenClosed().catch(console.error);
      }),
    );

    // Command palette: Cmd+Shift+P
    this.disposables.push(
      window.patton.app.onCommandPalette(() => {
        this.commandPalette.toggle(this.getPaletteActions());
      }),
    );

    // Prompt jumping: Cmd+Shift+Up/Down
    this.disposables.push(
      window.patton.app.onPromptJumpUp(() => {
        this.tabManager.jumpToPrompt('up');
      }),
    );

    this.disposables.push(
      window.patton.app.onPromptJumpDown(() => {
        this.tabManager.jumpToPrompt('down');
      }),
    );

    // Quick terminal
    this.disposables.push(
      window.patton.app.onQuickTerminal(() => {
        this.quickTerminal.toggle().catch(console.error);
      }),
    );
  }

  private getPaletteActions(): { label: string; shortcut?: string; action: string }[] {
    return [
      { label: 'New Tab', shortcut: '\u2318T', action: 'new-tab' },
      { label: 'Close Pane', shortcut: '\u2318W', action: 'close-pane' },
      { label: 'Split Pane Right', shortcut: '\u2318D', action: 'split-vertical' },
      { label: 'Split Pane Down', shortcut: '\u2318\u21E7D', action: 'split-horizontal' },
      { label: 'Zoom Split', shortcut: '\u2318\u21E7\u23CE', action: 'zoom-split' },
      { label: 'Reopen Closed Tab', shortcut: '\u2318\u21E7T', action: 'undo-close' },
      { label: 'Find', shortcut: '\u2318F', action: 'search' },
      { label: 'Clear Terminal', shortcut: '\u2318K', action: 'clear' },
      { label: 'Increase Font Size', shortcut: '\u2318=', action: 'font-up' },
      { label: 'Decrease Font Size', shortcut: '\u2318-', action: 'font-down' },
      { label: 'Next Tab', shortcut: '\u2318\u21E7]', action: 'next-tab' },
      { label: 'Previous Tab', shortcut: '\u2318\u21E7[', action: 'prev-tab' },
      { label: 'Toggle Compose Panel', shortcut: '\u2318E', action: 'toggle-compose' },
      { label: 'History Search', shortcut: '\u2303R', action: 'history-search' },
      { label: 'Jump to Previous Prompt', shortcut: '\u2318\u21E7\u2191', action: 'prompt-up' },
      { label: 'Jump to Next Prompt', shortcut: '\u2318\u21E7\u2193', action: 'prompt-down' },
      { label: 'Broadcast Input', shortcut: '\u2318\u21E7B', action: 'broadcast' },
      { label: 'Quick Terminal', action: 'quick-terminal' },
      { label: 'Save Terminal Output', shortcut: '\u2318S', action: 'save-terminal' },
      { label: 'Reset Renderer', shortcut: '\u2318\u21E7K', action: 'reset-renderer' },
      { label: 'Capture Renderer State', action: 'capture-render-state' },
      { label: this.tabManager.getRenderer() === 'webgl'
          ? 'Switch to Compatibility Renderer (fixes garbled text)'
          : 'Switch to GPU Renderer (fast)',
        action: 'toggle-renderer' },
      { label: 'Settings', shortcut: '\u2318,', action: 'settings' },
    ];
  }

  private executeAction(actionId: string): void {
    const tab = this.tabManager.getActiveTab();
    switch (actionId) {
      case 'new-tab':
        this.tabManager.createTab().catch(console.error);
        break;
      case 'close-pane':
        this.tabManager.closeActivePane().catch(console.error);
        break;
      case 'split-vertical':
        this.tabManager.splitVertical();
        break;
      case 'split-horizontal':
        this.tabManager.splitHorizontal();
        break;
      case 'zoom-split':
        this.tabManager.toggleZoom();
        break;
      case 'undo-close':
        this.tabManager.reopenClosed().catch(console.error);
        break;
      case 'search':
        tab?.searchOverlay.toggle();
        break;
      case 'clear':
        tab?.clear();
        break;
      case 'font-up':
        this.fontSize = Math.min(this.fontSize + 2, DEFAULTS.FONT_SIZE_MAX);
        this.applyFontSize();
        break;
      case 'font-down':
        this.fontSize = Math.max(this.fontSize - 2, DEFAULTS.FONT_SIZE_MIN);
        this.applyFontSize();
        break;
      case 'next-tab':
        this.tabManager.nextTab();
        break;
      case 'prev-tab':
        this.tabManager.prevTab();
        break;
      case 'toggle-compose':
        tab?.toggleCompose();
        break;
      case 'history-search':
        tab?.showHistorySearch();
        break;
      case 'prompt-up':
        this.tabManager.jumpToPrompt('up');
        break;
      case 'prompt-down':
        this.tabManager.jumpToPrompt('down');
        break;
      case 'broadcast':
        tab?.toggleBroadcastInput();
        break;
      case 'quick-terminal':
        this.quickTerminal.toggle().catch(console.error);
        break;
      case 'save-terminal': {
        if (!tab) break;
        const content = tab.getScrollbackContent();
        if (!content) break;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const tabName = tab.title.replace(/[^a-zA-Z0-9-_]/g, '_');
        const defaultName = `patton-${tabName}-${timestamp}.txt`;
        window.patton.terminal.saveOutput(content, defaultName).catch(console.error);
        break;
      }
      case 'reset-renderer':
        // Escape hatch for the "garbled glyphs" render state — force-rebuilds
        // the WebGL texture atlas on the active pane. Auto-snapshot fires inside
        // resetRenderer() so the captured state reflects the bug, not the recovery.
        tab?.focusedPane.terminalView.resetRenderer();
        break;
      case 'capture-render-state':
        // Manual diagnostic snapshot — lands in render-snapshots/. Useful for
        // grabbing a clean baseline or a known-bad state on demand without
        // triggering a full renderer reset.
        tab?.focusedPane.terminalView.captureSnapshot('manual').catch(console.error);
        break;
      case 'toggle-renderer': {
        // Flip the text renderer GPU(WebGL) <-> Compatibility(DOM) across every
        // pane + the quick terminal, then persist. The DOM renderer has no GPU
        // glyph atlas, so it's the escape hatch when WebGL garbles glyphs.
        const next = this.tabManager.getRenderer() === 'webgl' ? 'dom' : 'webgl';
        this.tabManager.setRenderer(next);
        this.quickTerminal.setRenderer(next);
        this.settingsPanel.syncCached({ renderer: next });
        window.patton.settings.set({ renderer: next }).catch(console.error);
        announce(next === 'dom'
          ? 'Switched to Compatibility renderer — no GPU, fixes garbled text'
          : 'Switched to GPU renderer — fast');
        break;
      }
      case 'settings':
        this.settingsPanel.toggle();
        break;
    }
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
    this.commandPalette.dispose();
    this.quickTerminal.dispose();
    this.notificationSound.dispose();
    this.tabManager.dispose();
  }
}
