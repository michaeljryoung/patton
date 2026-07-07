export interface PtyCreateOptions {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  isDark?: boolean;
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

/** Text renderer backend. `webgl` uses the GPU (fast); `dom` skips the GPU
 *  entirely and so cannot exhibit the WebGL glyph-atlas corruption ("garbled
 *  glyphs"), at a small render-throughput cost. */
export type RendererMode = 'webgl' | 'dom';

export interface AppSettings {
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  shell: string;
  notificationSound: boolean;
  notificationSoundType: 'chime' | 'bugle' | 'bullet';
  copyOnSelect: boolean;
  globalHotkey: string;
  theme: string;
  startupCommand: string;
  opacity: number;
  restoreSession: boolean;
  shellIntegration: boolean;
  renderer: RendererMode;
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

export interface RenderSnapshot {
  reason: string;
  timestamp: string;
  ptyId: number | null;
  gpu: string;
  rendererType: 'webgl' | 'dom';
  customTheme: boolean;
  cols: number;
  rows: number;
  scrollbackLength: number;
  viewportY: number;
  scrollbackTail: string;
}

export interface PattonAPI {
  pty: {
    create: (opts?: PtyCreateOptions) => Promise<number>;
    write: (id: number, data: string) => void;
    resize: (id: number, cols: number, rows: number) => void;
    destroy: (id: number) => void;
    getProcess: (id: number) => Promise<string>;
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
  notes: {
    get: () => Promise<string>;
    set: (content: string) => Promise<void>;
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
  diagnostics: {
    saveSnapshot: (data: RenderSnapshot) => Promise<string | null>;
  };
  log: {
    send: (level: 'info' | 'warn' | 'error', args: unknown[]) => void;
  };
  app: {
    onSettings: (callback: () => void) => () => void;
    onToggleNotes: (callback: () => void) => () => void;
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
  openExternal: (url: string) => Promise<void>;
  moveWindowBy: (dx: number, dy: number) => void;
}

declare global {
  interface Window {
    patton: PattonAPI;
  }
}
