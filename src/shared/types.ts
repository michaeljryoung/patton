import type { BoardTint, NotificationSoundType } from './constants';

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
  /** True only for the pane that runs the startup command (the Claude tab).
   *  Main then exports FORCE_HYPERLINK=1, which Claude Code needs to print
   *  OSC 8 links (it ignores TERM_PROGRAM). Other shells don't get it: tools
   *  using `supports-hyperlinks` honour it even when piped, putting escape
   *  bytes into logs and JSON. Only a literal `true` counts. */
  hyperlinks?: boolean;
}

/** Outcome of a file link: open with its default app, open in the code
 *  editor, reveal in Finder, no such file, refused by validation, or unknown
 *  (rate-limited). */
export type FileLinkAction = 'open' | 'editor' | 'reveal' | 'missing' | 'refused' | 'unknown';

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
  /** Interface Text Size: a factor on the chrome's text, one of
   *  DEFAULTS.UI_TEXT_SCALES. Absent in settings saved before it existed, so
   *  read it through `uiTextScaleOf`. */
  uiTextScale?: number;
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
  /** Answer Claude Code's OSC 7501 probe so it reports its own status.
   *  Absent in settings saved before it existed, so read it as `!== false`
   *  (on by default). */
  programStatus: boolean;
  /** The checkpoint clock turns amber at this % of the context window used
   *  since the last /checkpoint. Absent in settings saved before it existed,
   *  so read it as `?? DEFAULTS.CHECKPOINT_NUDGE_PCT`. */
  checkpointNudgePct: number;
  /** Show the project board in new tabs the user opens (when the project list
   *  file exists). Absent in settings saved before it existed, so read it as
   *  `!== false` (on by default). */
  projectBoard: boolean;
  /** The Markdown project list the board reads (the `cc` launcher's format).
   *  Empty means ~/.claude/projects.md. Absent in older settings: read `|| ''`. */
  projectListFile: string;
  /** The command the project board's Wake button types into a new tab.
   *  Empty hides the button. Absent in older settings: read it as
   *  `typeof x === 'string' ? x : DEFAULTS.BOARD_WAKE_COMMAND` (wakeCommandOf). */
  boardWakeCommand: string;
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
  /** Set when the folder is a linked git worktree: `root` is then its MAIN
   *  repository, and this names the worktree (its folder's name) and its path. */
  worktree?: { name: string; path: string };
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

// --- Project board ---
/** A theme on the project board: a named area with a faint tint. `projects`
 *  holds absolute folder paths in display order; paths not in the current list
 *  stay stored but aren't shown. Validated in main/project-board.ts. */
export interface BoardTheme {
  id: string;
  name: string;
  tint: BoardTint;
  projects: string[];
}

/** Per-tile options, keyed by the project's absolute path. */
export interface BoardTileOptions {
  wide?: boolean;
  note?: string;
}

/** The board's saved arrangement (userData/project-board.json, plain JSON). */
export interface BoardLayout {
  version: 1;
  themes: BoardTheme[];
  tiles: Record<string, BoardTileOptions>;
}

/** A worktree of, or a folder inside, a listed project, shown in its tile. */
export interface BoardSubProject {
  path: string;
  /** The row's name in the list. */
  name: string;
  /** The name without the parent's name or a trailing " worktree". */
  displayName: string;
  kind: 'worktree' | 'folder';
  missing?: boolean;
  /** When a Claude session last ran there (ms), if one ever did. */
  lastSessionAt?: number;
}

/** A top-level project from the list file. */
export interface BoardProject {
  path: string;
  name: string;
  /** The folder is not a directory (moved or deleted). */
  missing?: boolean;
  lastSessionAt?: number;
  subProjects: BoardSubProject[];
}

export interface BoardPayload {
  /** The list file in use, with the home folder shown as ~. */
  listFile: string;
  listFound: boolean;
  /** The file holds a project table (header row naming "Project" then
   *  "Path", and its separator row), the only place + Project adds a row. */
  listTable: boolean;
  projects: BoardProject[];
  layout: BoardLayout;
  /** Set by board:add-project when it refused: the reason, in words. */
  error?: string;
  /** How many projects + Project has added since the app started, when this
   *  was read. A layout save sends it back, so main can keep the placement of
   *  a project added after the saving board last read the list. */
  generation?: number;
}

export interface BoardAddRequest {
  path: string;
  name: string;
  themeId?: string;
}
// --- end project board ---

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
    getShell: (id: number) => Promise<string>;
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
    /** Interface Text Size at the moment this window was created, known
     *  synchronously (main passes it to the preload as a command-line switch)
     *  so the renderer can size its chrome before building any of it. */
    uiTextScaleAtLaunch: number;
    get: () => Promise<AppSettings>;
    set: (settings: Partial<AppSettings>) => Promise<void>;
    /** Fires in every window when Interface Text Size is saved. */
    onUiTextScale: (cb: (scale: number) => void) => () => void;
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
  // --- Project board ---
  board: {
    get: () => Promise<BoardPayload>;
    /** Save the arrangement; main validates it and returns what it stored,
     *  or null when it refused (rate limit, not a layout). */
    setLayout: (layout: BoardLayout, generation?: number) => Promise<BoardLayout | null>;
    pickFolder: () => Promise<string | null>;
    /** Add a row to the project list file; the fresh board, with `error` set if refused. */
    addProject: (request: BoardAddRequest) => Promise<BoardPayload>;
    /** Another board saved a new arrangement. */
    onChanged: (callback: (layout: BoardLayout) => void) => () => void;
    /** A project was added (from any window): the fresh board. */
    onListChanged: (callback: (payload: BoardPayload) => void) => () => void;
  };
  // --- end project board ---
  session: {
    get: () => Promise<SessionState | null>;
    set: (session: SessionState | null) => Promise<void>;
  };
  editor: {
    /** Open a file (path, optionally `:line:col`; may start with `~/`). If no
     *  such file exists and `webFallback` is an http(s) URL, open that instead. */
    openFile: (filePath: string, webFallback?: string) => Promise<void>;
    /** What a double-click on this file link would do (main decides; see
     *  main/link-open-policy.ts). For the hover tooltip only. */
    linkAction: (filePath: string) => Promise<FileLinkAction>;
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
  // --- System fonts ---
  fonts: {
    /** Font files macOS ships but doesn't expose by family name (SF Mono), read from fixed paths in main. */
    getSystem: () => Promise<SystemFontFamily[]>;
  };
  // --- end system fonts ---
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
  /** This Mac's host name, to tell `file://<hostname>/…` links from remote ones. */
  getHostname: () => Promise<string>;
  moveWindowBy: (dx: number, dy: number) => void;
  /** ⌘W on the last tab: the in-app dialog asks, then tells main's close guard. */
  closeGuard: {
    /** What closing the caller's window means; null if main can't say. */
    info: () => Promise<WindowCloseInfo | null>;
    /** Record that the caller's own window close was confirmed in the app
     *  (one-shot, expires after a few seconds). False if main refused it. */
    preconfirm: () => Promise<boolean>;
  };
}

/** Answer to `closeGuard.info()`: is this the only window, and how many of
 *  its shells are still running. */
export interface WindowCloseInfo {
  isLastWindow: boolean;
  liveShells: number;
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

/** One face of a font family main read from the Mac's own files (never bundled with Patton). */
export interface SystemFontFace {
  /** CSS font-weight descriptor, e.g. '400' or '700'. */
  weight: string;
  style: 'normal' | 'italic';
  /** The font file's bytes. */
  data: Uint8Array;
}

/** A family to register in the renderer's `document.fonts` under `family`. */
export interface SystemFontFamily {
  family: string;
  /** Where the files were found (for logs). */
  dir: string;
  faces: SystemFontFace[];
}
