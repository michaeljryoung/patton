export interface PtyCreateOptions {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface HistoryEntry {
  command: string;
  timestamp: number;
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface AppSettings {
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  shell: string;
  notificationSound: boolean;
  notificationSoundType: string;
  copyOnSelect: boolean;
  globalHotkey: string;
  theme: string;
  startupCommand: string;
  opacity: number;
  restoreSession: boolean;
  shellIntegration: boolean;
}

export interface SessionPaneState {
  cwd: string;
}

export interface SessionSplitState {
  type: 'split';
  direction: 'vertical' | 'horizontal';
  ratio: number;
  children: [SessionTreeNode, SessionTreeNode];
}

export type SessionTreeNode = SessionPaneState | SessionSplitState;

export interface SessionTabState {
  title?: string;
  customTitle?: boolean;
  tree: SessionTreeNode;
  focusedPaneIndex: number;
}

export interface SessionState {
  tabs: SessionTabState[];
  activeTabIndex: number;
}

export interface PattonAPI {
  pty: {
    create: (opts?: PtyCreateOptions) => Promise<number>;
    write: (id: number, data: string) => void;
    resize: (id: number, cols: number, rows: number) => void;
    destroy: (id: number) => void;
    getProcess: (id: number) => Promise<string>;
    getDescendants: (id: number) => Promise<string[]>;
    getCwd: (id: number) => Promise<string>;
    onData: (callback: (id: number, data: string) => void) => () => void;
    onExit: (callback: (id: number, code: number) => void) => () => void;
    onTitle: (callback: (id: number, title: string) => void) => () => void;
  };
  history: {
    get: () => Promise<HistoryEntry[]>;
    add: (command: string) => Promise<void>;
    clear: () => Promise<void>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    set: (settings: Partial<AppSettings>) => Promise<void>;
  };
  session: {
    get: () => Promise<SessionState | null>;
    set: (session: SessionState | null) => Promise<void>;
  };
  editor: {
    openFile: (filePath: string) => Promise<void>;
  };
  terminal: {
    saveOutput: (content: string, defaultName: string) => Promise<string | null>;
  };
  app: {
    onSettings: (callback: () => void) => () => void;
    onNewTab: (callback: () => void) => () => void;
    onCloseTab: (callback: () => void) => () => void;
    onNextTab: (callback: () => void) => () => void;
    onPrevTab: (callback: () => void) => () => void;
    onSwitchTab: (callback: (index: number) => void) => () => void;
    onClear: (callback: () => void) => () => void;
    onSearch: (callback: () => void) => () => void;
    onFontSizeUp: (callback: () => void) => () => void;
    onFontSizeDown: (callback: () => void) => () => void;
    onSplitVertical: (callback: () => void) => () => void;
    onSplitHorizontal: (callback: () => void) => () => void;
    onFocusPaneUp: (callback: () => void) => () => void;
    onFocusPaneDown: (callback: () => void) => () => void;
    onFocusPaneLeft: (callback: () => void) => () => void;
    onFocusPaneRight: (callback: () => void) => () => void;
    onSaveTerminal: (callback: () => void) => () => void;
    onBroadcastInput: (callback: () => void) => () => void;
    onSwitchTabById: (callback: (id: string) => void) => () => void;
    onSplitZoom: (callback: () => void) => () => void;
    onUndoClose: (callback: () => void) => () => void;
    onCommandPalette: (callback: () => void) => () => void;
    onPromptJumpUp: (callback: () => void) => () => void;
    onPromptJumpDown: (callback: () => void) => () => void;
    onQuickTerminal: (callback: () => void) => () => void;
  };
  notify: (title: string, body: string, tabId: string) => void;
  setOpacity: (opacity: number) => void;
}

declare global {
  interface Window {
    patton: PattonAPI;
  }
}
