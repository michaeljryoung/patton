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
    /** Replace this pane's own shell with a new one (same options as create);
     *  resolves to the new PTY id. The old shell is ended by main. */
    respawn: (id: number, opts?: PtyCreateOptions) => Promise<number>;
    /** `origin: 'startup'` marks Patton's own startup-command write, which
     *  main's unsent-input tracker ignores; 'patton' marks Patton's own words
     *  (pause, /checkpoint), tracked but not counted as user input. */
    write: (id: number, data: string, origin?: PtyWriteOrigin) => void;
    /** What main's unsent-input tracker (main/unsent-input.ts) knows of each
     *  PTY's input line, in order; null for a PTY this window doesn't own. */
    inputState: (ids: number[]) => Promise<(UnsentInputState | null)[]>;
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
  /** A double-click on empty tab-strip space: the Mac's title-bar action (zoom, minimize or nothing). */
  titleBarDoubleClick: () => void;
  /** ⌘W on the last tab: the in-app dialog asks, then tells main's close guard. */
  closeGuard: {
    /** What closing the caller's window means; null if main can't say. */
    info: () => Promise<WindowCloseInfo | null>;
    /** Record that the caller's own window close was confirmed in the app
     *  (one-shot, expires after a few seconds). False if main refused it. */
    preconfirm: () => Promise<boolean>;
    /** Ask main to close the caller's own window with BrowserWindow.close(),
     *  so main's close guard runs (the page's window.close() skips it). True
     *  once main has accepted the request; the close itself follows. */
    closeWindow: () => Promise<boolean>;
    // --- in-app quit / close confirmations (v1.19; main/close-confirm.ts) ---
    /** Main asks this window to show "Quit Patton?" / "Close this window?". Returns the unsubscribe. */
    onConfirmRequest: (callback: (request: ConfirmRequest) => void) => () => void;
    /** Main has the answer (a second ⌘Q) or gave up: take the dialog down. */
    onConfirmDismiss: (callback: (requestId: string) => void) => () => void;
    /** The dialog is on screen. False when main no longer wants it (late, unknown). */
    ackConfirm: (requestId: string) => Promise<boolean>;
    /** The user's answer to a request. */
    answerConfirm: (requestId: string, ok: boolean) => Promise<boolean>;
    // --- end in-app quit / close confirmations ---
  };
  /** The tab strip's "Pause all" button (main/pause-all.ts). */
  pauseAll: {
    /** Pause every window's Claude panes by the rules. Null if main refused
     *  (a press already in flight, or the rate limit). */
    press: () => Promise<PauseAllOutcome | null>;
    /** Main asks this window to act on its own panes. Returns the unsubscribe. */
    onRun: (callback: (request: PauseAllRunRequest) => void) => () => void;
    /** This window's answer to a run request. */
    report: (requestId: string, report: PauseAllReport) => Promise<boolean>;
    /** Whether Ctrl+S is still Claude Code's stash key (main/stash-key.ts),
     *  read from ~/.claude/keybindings.json now. */
    stashKey: () => Promise<StashKeyVerdict>;
  };
}

/** Main's unsent-input tracker on one PTY (main/unsent-input.ts). Times are
 *  wall-clock ms (Date.now) in main; the renderer compares them with its own. */
export interface UnsentInputState {
  /** Something may be in the input line: stash it before typing a word.
   *  Same as `length !== 0`. */
  dirty: boolean;
  /** Characters in the input line as far as the tracker can count them;
   *  null when it can't (history recall, a long or multi-line paste, Tab,
   *  an Enter that may have picked an `@` completion). */
  length: number | null;
  /** The last user input (0: none yet). */
  lastInputAt: number;
  /** When the last submitted line that began with `/` (or with something the
   *  tracker can't read) went in; 0 when the last one was plain text. */
  slashSubmitAt: number;
  /** The last Ctrl+S the user typed (0: none since the PTY started). */
  userStashAt: number;
  /** The last Ctrl+S Patton sent, until the user next submits a line (0: none). */
  pattonStashAt: number;
}

/** Who made a PTY write, for main's unsent-input tracker:
 *  - 'startup': Patton's startup command (not tracked);
 *  - 'patton': Patton's own words (Pause all, the checkpoint clock);
 *  - 'at-prompt': the user, while Claude's root is done or idle with nothing
 *    blocked (7501), so a Ctrl+C in it clears Claude's input line;
 *  - undefined: the user, anywhere else. */
export type PtyWriteOrigin = 'startup' | 'patton' | 'at-prompt';

/** Ctrl+S is Claude Code's chat:stash here, or why not. */
export type StashKeyVerdict = { ok: true } | { ok: false; why: string };

// --- Pause all (main/pause-all.ts, renderer/services/pause-all.ts) ---
/** Why a pane got nothing:
 *  - 'waiting': Claude, or one of its background tasks, waits on a permission,
 *    question or login (Enter would answer it).
 *  - 'menu': the last line sent began with `/` and Claude hasn't reported since
 *    (a picker such as /model, where Enter selects).
 *  - 'fresh': a session that has never run a turn.
 *  - 'draft': a draft may be in the input line and Ctrl+S is not the stash key.
 *  - 'stashed': a draft may be in the input line and a stash may already be
 *    held (the user pressed Ctrl+S this session, or Patton did and no line
 *    was submitted since): Ctrl+S would overwrite or pop it.
 *  - 'unclear': Claude's state can't rule out a dialog (title path, or 7501 error).
 *  - 'not-claude', 'no-shell'. */
export type PauseSkipReason =
  | 'waiting' | 'menu' | 'fresh' | 'draft' | 'stashed' | 'unclear' | 'not-claude' | 'no-shell';

export const PAUSE_SKIP_REASONS: readonly PauseSkipReason[] = [
  'waiting', 'menu', 'fresh', 'draft', 'stashed', 'unclear', 'not-claude', 'no-shell',
];

/** A skipped pane named for the summary: its tab's title and why. */
export interface PauseSkipName {
  title: string;
  reason: PauseSkipReason;
}

/** At most this many skipped panes are named, per window and in the summary. */
export const PAUSE_NAMED_MAX = 3;

/** One window's answer: how many panes got the word, and why the rest didn't. */
export interface PauseAllReport {
  sent: number;
  /** Of `sent`, how many were mid-turn (the word queues behind the turn). */
  queued: number;
  skipped: Record<PauseSkipReason, number>;
  /** Up to PAUSE_NAMED_MAX skipped panes by tab title (not plain shells). */
  named: PauseSkipName[];
}

/** Main → renderer: act on this window's panes. */
export interface PauseAllRunRequest {
  requestId: string;
}

/** A press's result across every window. */
export interface PauseAllOutcome extends PauseAllReport {
  /** Windows asked, how many answered in time, and how many closed meanwhile. */
  windows: number;
  answered: number;
  closed: number;
}
// --- end Pause all ---

/** Main → renderer: ask the user before ending shells. 'quit' ends every
 *  window's shells and quits Patton; 'close-window' ends this window's only. */
export interface ConfirmRequest {
  requestId: string;
  kind: 'quit' | 'close-window';
  /** Shells that will end: all windows' for 'quit', this window's for 'close-window'. */
  terminals: number;
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
