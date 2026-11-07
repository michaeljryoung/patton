import { TabManager } from '../services/tab-manager';
import { KeybindingManager } from '../services/keybinding-manager';
import { NotificationSound } from '../services/notification-sound';
import { getThemeById } from '../services/themes';
import { announce } from '../services/announcer';
import { SettingsPanel } from './settings-panel';
import { CommandPalette, type PaletteAction } from './command-palette';
import { QuickTerminal } from './quick-terminal';
import { NotesPanel } from './notes-panel';
import { BookmarksPanel } from './bookmarks-panel';
import { Onboarding } from './onboarding';
import { DEFAULTS } from '../../shared/constants';
import { setConfirmMultilinePaste } from '../services/paste-confirm';
import { setProgramStatusEnabled } from '../services/program-status-switch';
import { paletteShortcuts, displayKeys } from '../../shared/shortcuts';
import { parseSessionAction, sessionPaletteActions } from '../services/session-palette';
import { rlog } from '../services/renderer-logger';
import { loadSystemFonts } from '../services/system-fonts';
import type { OpenProjectHost } from '../services/open-project';
import { ProjectBoards } from '../services/project-boards';

export class App {
  private tabManager: TabManager;
  private keybindingManager: KeybindingManager;
  private settingsPanel: SettingsPanel;
  private commandPalette: CommandPalette;
  private quickTerminal: QuickTerminal;
  private notesPanel: NotesPanel;
  private bookmarksPanel: BookmarksPanel;
  private projectBoards: ProjectBoards;
  private notificationSound: NotificationSound;
  private fontSize: number = DEFAULTS.FONT_SIZE;
  private fontSizeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposables: (() => void)[] = [];

  constructor() {
    const tabBarEl = document.getElementById('tab-bar')!;
    const contentEl = document.getElementById('content')!;
    const appEl = document.getElementById('app')!;
    const mainEl = document.getElementById('main')!;

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
          window.patton.notify('Patton', `Waiting for you in ${tabTitle}`, tabId);
        }
      },
      // The bookmarks sidebar is created below; these only fire after startup.
      onTabsChanged: () => {
        this.bookmarksPanel?.scheduleRefresh();
        this.projectBoards?.scheduleRefresh();
      },
      onBookmarkProject: (tab) => { this.bookmarksPanel.addProjectFromTab(tab).catch(console.error); },
    });
    this.keybindingManager = new KeybindingManager(this.tabManager);
    this.settingsPanel = new SettingsPanel(appEl, (settings) => {
      if (settings.fontSize !== undefined) {
        this.fontSize = settings.fontSize;
        this.tabManager.setFontSize(this.fontSize);
        this.quickTerminal.setFontSize(this.fontSize);
      }
      if (settings.fontFamily !== undefined) {
        this.applyFontFamily(settings.fontFamily);
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
      if (settings.composeFirst !== undefined) {
        this.tabManager.setComposeFirst(settings.composeFirst);
      }
      if (settings.confirmMultilinePaste !== undefined) {
        setConfirmMultilinePaste(settings.confirmMultilinePaste);
      }
      if (settings.programStatus !== undefined) {
        setProgramStatusEnabled(settings.programStatus);
        rlog('info', '[SETTINGS] programStatus changed', { enabled: settings.programStatus });
      }
      if (settings.checkpointNudgePct !== undefined) {
        this.tabManager.setCheckpointNudgePct(settings.checkpointNudgePct);
      }
      if (settings.boardWakeCommand !== undefined) {
        this.projectBoards?.setWakeCommand(settings.boardWakeCommand);
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

    // Notes scratchpad (Ctrl+Cmd+N): a plain textarea docked beside the
    // terminal. On close, hand focus back to the active terminal pane.
    this.notesPanel = new NotesPanel(mainEl, {
      onClose: () => this.tabManager.getActiveTab()?.focusedPane.focus(),
    });

    // How a project is opened, shared by the bookmarks sidebar and the
    // project board so both go to the same tab or session.
    const projectHost: OpenProjectHost = {
      getTabs: () => this.tabManager.getTabs(),
      getActiveTab: () => this.tabManager.getActiveTab(),
      switchToTab: (id) => this.tabManager.switchToId(id),
      createTab: (cwd, opts) => this.tabManager.createTab(cwd, opts),
      listSessions: () => this.tabManager.listSessions(),
      goToSession: (tabId, paneId) => this.tabManager.goToSession(tabId, paneId),
      focusTerminal: () => this.tabManager.getActiveTab()?.focusedPane.focus(),
    };

    // Bookmarks sidebar (Ctrl+Cmd+B): projects and artifact links, docked left.
    this.bookmarksPanel = new BookmarksPanel(mainEl, projectHost);

    // Project board over new tabs the user opens (TabManager.userNewTab).
    this.projectBoards = new ProjectBoards(this.tabManager, projectHost);

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
    // Load settings, history and the Mac's SF Mono in parallel. The fonts
    // must be registered before the first terminal below is created: xterm
    // measures its cell when fontFamily changes and never re-measures when a
    // font arrives later. No terminal exists before this point (tabs are
    // created further down, the quick terminal on first show).
    const [settings] = await Promise.all([
      window.patton.settings.get(),
      this.tabManager.loadHistory(),
      loadSystemFonts(),
    ]);
    this.fontSize = settings.fontSize;
    this.tabManager.setFontSize(this.fontSize);
    this.applyFontFamily(settings.fontFamily || DEFAULTS.FONT_FAMILY);
    if (settings.scrollback) {
      this.tabManager.setScrollback(settings.scrollback);
    }
    this.tabManager.setRenderer(settings.renderer || 'dom');
    if (settings.shell) {
      this.tabManager.setShell(settings.shell);
    }
    this.notificationSound.setEnabled(settings.notificationSound !== false);
    if (settings.notificationSoundType) {
      this.notificationSound.setType(settings.notificationSoundType);
    }
    this.tabManager.setCopyOnSelect(settings.copyOnSelect === true);
    this.tabManager.setComposeFirst(settings.composeFirst !== false);
    setConfirmMultilinePaste(settings.confirmMultilinePaste === true);
    setProgramStatusEnabled(settings.programStatus !== false);
    rlog('info', '[SETTINGS] programStatus at startup', { enabled: settings.programStatus !== false });
    this.tabManager.setCheckpointNudgePct(settings.checkpointNudgePct ?? DEFAULTS.CHECKPOINT_NUDGE_PCT);
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
    if (settings.scrollback) this.quickTerminal.setScrollback(settings.scrollback);
    this.quickTerminal.setRenderer(settings.renderer || 'dom');

    // Try to restore previous session (if enabled)
    // Restore previous session if enabled, otherwise start fresh
    const restored = settings.restoreSession !== false
      ? await this.tabManager.restoreSession(Boolean(settings.startupCommand))
      : false;

    if (!restored) {
      await this.tabManager.createTab(undefined, { startupCommand: Boolean(settings.startupCommand) });

      // Show onboarding on first run
      if (Onboarding.shouldShow()) {
        const onboarding = new Onboarding(document.getElementById('app')!);
        onboarding.show();
      }
    }

    // The active tab (restored or fresh): an empty one gets the project board,
    // like a new tab; any other gets the startup command. Restore only recovers
    // tab layout + scrollback — all PTYs are fresh shells, so the startup
    // command is always safe to run. Timing lives in startup-command.ts.
    const firstTab = this.tabManager.getActiveTab();
    if (firstTab) {
      this.projectBoards.startLaunchTab(firstTab, settings.startupCommand || '').catch(console.error);
    }
    // Startup is done: bookmark clicks may open tabs now (earlier ones are ignored).
    this.bookmarksPanel.setReady();

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
      this.tabManager.autosaveSession().catch(() => {});
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
      window.patton.app.onToggleNotes(() => {
        this.notesPanel.toggle().catch(console.error);
      }),
    );

    this.disposables.push(
      window.patton.app.onToggleBookmarks(() => {
        this.bookmarksPanel.toggle().catch(console.error);
      }),
    );

    this.disposables.push(
      window.patton.app.onNewTab(() => {
        this.tabManager.userNewTab().catch(console.error);
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

  private getPaletteActions(): PaletteAction[] {
    return [
      // Generated from the shortcuts registry \u2014 adding a `palette: true` entry
      // there is all it takes to list a command here.
      ...paletteShortcuts().map((s) => ({
        label: s.label,
        shortcut: displayKeys(s) || undefined,
        action: s.id,
      })),
      // The one entry whose label depends on runtime state, so it can't come
      // from the static registry.
      { label: this.tabManager.getRenderer() === 'webgl'
          ? 'Switch to Compatibility Renderer (fixes garbled text)'
          : 'Switch to GPU Renderer (fast)',
        action: 'toggle-renderer' },
      // Open sessions, matched only once something is typed; after the
      // commands, so a typed command name still runs on Enter as before.
      ...sessionPaletteActions(this.tabManager.listSessions(), Date.now()),
    ];
  }

  private executeAction(actionId: string): void {
    const session = parseSessionAction(actionId);
    if (session) {
      const { tabId, paneId } = session;
      const ok = this.tabManager.goToSession(tabId, paneId);
      rlog('info', '[PALETTE] go to session', { tabId, paneId, ok });
      if (!ok) announce('That session has closed', 'assertive');
      return;
    }
    const tab = this.tabManager.getActiveTab();
    switch (actionId) {
      case 'new-tab':
        this.tabManager.userNewTab().catch(console.error);
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
      case 'toggle-compose-first':
        tab?.toggleComposeFirst();
        break;
      case 'checkpoint-session':
        this.tabManager.runCheckpoint();
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
      case 'toggle-notes':
        this.notesPanel.toggle().catch(console.error);
        break;
      case 'toggle-bookmarks':
        this.bookmarksPanel.toggle().catch(console.error);
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

  /**
   * One font family for every terminal (tabs and the quick terminal) and the
   * compose box (via Pane). The app's own chrome keeps its `--font-mono` token.
   */
  private applyFontFamily(family: string): void {
    this.tabManager.setFontFamily(family);
    this.quickTerminal.setFontFamily(family);
  }

  private applyTheme(themeId: string): void {
    // A theme colours the terminal only. The chrome keeps its own tokens
    // (main.css) and follows the OS light/dark mode; the theme's `ui` block is
    // no longer written to :root (nothing read it, and its --accent overrode
    // the chrome's, at under 3:1 on white for 13 of 19 themes).
    if (themeId === 'system') {
      this.tabManager.setTerminalTheme(null);
    } else {
      const theme = getThemeById(themeId);
      if (theme) this.tabManager.setTerminalTheme(theme.terminal);
    }
  }

  private applyFontSize(): void {
    // Apply to ALL tabs, not just the active one, and to the quick terminal
    this.tabManager.setFontSize(this.fontSize);
    this.quickTerminal.setFontSize(this.fontSize);
    // Cmd+/- held down repeats ~30/s but settings:set allows 10/s, so a refused
    // save could drop the final size: apply live, save once the zooming stops.
    if (this.fontSizeSaveTimer) clearTimeout(this.fontSizeSaveTimer);
    this.fontSizeSaveTimer = setTimeout(() => {
      this.fontSizeSaveTimer = null;
      window.patton.settings.set({ fontSize: this.fontSize }).catch(console.error);
    }, 250);
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
    this.notesPanel.dispose();
    this.bookmarksPanel.dispose();
    this.projectBoards.dispose();
    this.notificationSound.dispose();
    this.tabManager.dispose();
  }
}
