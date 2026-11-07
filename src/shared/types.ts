import type { NotificationSoundType } from './constants';

export interface PtyCreateOptions {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  isDark?: boolean;
  /** True when the tab was opened for a project (a bookmark click). Main then
   *  exports PATTON_PROJECT_DIR=<validated cwd> into the shell, unless the cwd
   *  was rejected. Only a literal `true` counts; no path is ever sent. */
  projectDir?: boolean;
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
  notificationSoundType: NotificationSoundType;
  copyOnSelect: boolean;
  globalHotkey: string;
  theme: string;
  startupCommand: string;
  opacity: number;
  restoreSession: boolean;
  shellIntegration: boolean;
  renderer: RendererMode;
  /** Compose-first mode: while Claude Code runs in a pane, keep the compose
   *  panel open and focused. Absent in settings saved before it existed, so
   *  read it as `!== false` (on by default). */
  composeFirst: boolean;
  /** Ask before pasting 3+ lines into the terminal. Absent in settings saved
   *  before it existed, so read it as `=== true` (off by default). */
  confirmMultilinePaste: boolean;
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

/**
 * Manual colour flag a user puts on a tab (right-click → Flag) to track what
 * still needs coming back to. Deliberately independent of the automatic
 * "awaiting input" dot: that one is raised and cleared by shell activity, this
 * one only ever by the user — including surviving tab activation, which is the
 * whole point (reading a tab shouldn't erase your note-to-self about it).
 */
export type TabFlag = 'green' | 'yellow' | 'red';

export interface SessionTabState {
  title?: string;
  customTitle?: boolean;
  flag?: TabFlag;
  tree: SessionTreeNode;
  focusedPaneIndex: number;
}

export interface SessionState {
  tabs: SessionTabState[];
  activeTabIndex: number;
}

/** The project a terminal's folder belongs to, which names its tab. See
 *  main/projects.ts for what counts as a project. */
export interface ProjectInfo {
  /** Absolute path of the project folder; a name the user gives the project is stored under it. */
  root: string;
  /** The automatic name: the last word of the folder name ("fantasy-football" → "football"). */
  defaultName: string;
}

// --- Bookmarks ---
/** A sidebar bookmark: a project folder (opens a tab there) or an https link
 *  to an artifact (opens in the browser). Validated in main/bookmarks.ts. */
export interface Bookmark {
  id: string;
  kind: 'project' | 'artifact';
  label: string;
  /** Project bookmarks: absolute folder path (a project root, or a plain folder). */
  path?: string;
  /** Artifact bookmarks: an https URL. */
  url?: string;
  addedAt: number;
  /** Set by main on what it sends the sidebar (never stored): the project's folder is gone. */
  missing?: boolean;
  /** Set by main, never stored: `path` with the home folder shown as ~. */
  displayPath?: string;
}
// --- end bookmarks ---

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

// --- image paste ---
export interface ClipboardImageThumb {
  /** PNG data URL, downscaled to at most 160 px on the long side */
  dataUrl: string;
  /** Size of the original clipboard image, in pixels */
  width: number;
  height: number;
  /** Only when the caller asked to save: the image file under userData/pastes */
  path?: string;
}
// --- end image paste ---

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
  projects: {
    resolve: (cwd: string) => Promise<ProjectInfo | null>;
    getNames: () => Promise<Record<string, string>>;
    setName: (root: string, name: string) => Promise<void>;
    onNamesChanged: (callback: (names: Record<string, string>) => void) => () => void;
  };
  // --- Bookmarks ---
  bookmarks: {
    get: () => Promise<Bookmark[]>;
    /** Replace the whole list; main validates it and returns what it stored. */
    set: (bookmarks: Bookmark[]) => Promise<Bookmark[]>;
    onChanged: (callback: (bookmarks: Bookmark[]) => void) => () => void;
  };
  // --- end bookmarks ---
  session: {
    get: () => Promise<SessionState | null>;
    set: (session: SessionState | null) => Promise<void>;
  };
  editor: {
    /** Open a file (path, optionally `:line:col`; may start with `~/`). If no
     *  such file exists and `webFallback` is an http(s) URL, open that instead. */
    openFile: (filePath: string, webFallback?: string) => Promise<void>;
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
  // --- Claude Code Stop hook ---
  claudeHook: {
    status: () => Promise<ClaudeHookStatus>;
    /** Resolves with the new status; rejects with a readable message if settings.json can't be edited. */
    install: () => Promise<ClaudeHookStatus>;
    remove: () => Promise<ClaudeHookStatus>;
  };
  // --- end Claude Code Stop hook ---
  // --- image paste ---
  clipboard: {
    /** Reads the clipboard image once; save=true also writes it under userData/pastes and returns `path`. */
    readImage: (save: boolean) => Promise<ClipboardImageThumb | null>;
  };
  // --- end image paste ---
  app: {
    onSettings: (callback: () => void) => () => void;
    onToggleNotes: (callback: () => void) => () => void;
    onToggleBookmarks: (callback: () => void) => () => void; // bookmarks
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

// --- Claude Code Stop hook ---
/** Whether Patton's Stop hook is installed for Claude Code (Settings → Claude Code). */
export interface ClaudeHookStatus {
  /** Script copied AND its entry present in ~/.claude/settings.json. */
  installed: boolean;
  scriptPresent: boolean;
  entryPresent: boolean;
  scriptPath: string;
  /** settings.json couldn't be read or parsed. */
  error?: string;
}
// --- end Claude Code Stop hook ---

declare global {
  interface Window {
    patton: PattonAPI;
  }
}
