export const IPC = {
  PTY_CREATE: 'pty:create',
  PTY_DATA: 'pty:data',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_DESTROY: 'pty:destroy',
  PTY_GET_PROCESS: 'pty:get-process',
  PTY_GET_SHELL: 'pty:get-shell',
  PTY_EXIT: 'pty:exit',
  PTY_TITLE: 'pty:title',

  HISTORY_GET: 'history:get',
  HISTORY_ADD: 'history:add',
  HISTORY_CLEAR: 'history:clear',

  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  NOTES_GET: 'notes:get',
  NOTES_SET: 'notes:set',

  PROJECT_RESOLVE: 'project:resolve',
  PROJECT_NAMES_GET: 'project:names-get',
  PROJECT_NAME_SET: 'project:name-set',
  PROJECT_NAMES_CHANGED: 'project:names-changed',

  // --- Bookmarks (left sidebar of projects + artifact links) ---
  BOOKMARKS_GET: 'bookmarks:get',
  BOOKMARKS_SET: 'bookmarks:set',
  BOOKMARKS_CHANGED: 'bookmarks:changed',
  APP_TOGGLE_BOOKMARKS: 'app:toggle-bookmarks',
  // --- end bookmarks ---

  SETTINGS_UI_TEXT_SCALE: 'settings:ui-text-scale',
  APP_SETTINGS: 'app:settings',
  APP_TOGGLE_NOTES: 'app:toggle-notes',
  APP_NEW_TAB: 'app:new-tab',
  APP_CLOSE_TAB: 'app:close-tab',
  APP_NEXT_TAB: 'app:next-tab',
  APP_PREV_TAB: 'app:prev-tab',
  APP_SWITCH_TAB: 'app:switch-tab',
  APP_CLEAR: 'app:clear',
  APP_SEARCH: 'app:search',
  APP_FONT_SIZE_UP: 'app:font-size-up',
  APP_FONT_SIZE_DOWN: 'app:font-size-down',
  APP_SPLIT_VERTICAL: 'app:split-vertical',
  APP_SPLIT_HORIZONTAL: 'app:split-horizontal',
  APP_FOCUS_PANE_UP: 'app:focus-pane-up',
  APP_FOCUS_PANE_DOWN: 'app:focus-pane-down',
  APP_FOCUS_PANE_LEFT: 'app:focus-pane-left',
  APP_FOCUS_PANE_RIGHT: 'app:focus-pane-right',

  SESSION_GET: 'session:get',
  SESSION_SET: 'session:set',
  PTY_GET_CWD: 'pty:get-cwd',
  // board-in-place: swap a pane's shell for a fresh one (see PtyManager.respawn)
  PTY_RESPAWN: 'pty:respawn',

  APP_OPEN_IN_EDITOR: 'app:open-in-editor',
  APP_LINK_ACTION: 'app:link-action',
  APP_SAVE_TERMINAL: 'app:save-terminal',
  APP_BROADCAST_INPUT: 'app:broadcast-input',
  APP_NOTIFY: 'app:notify',

  APP_SPLIT_ZOOM: 'app:split-zoom',
  APP_UNDO_CLOSE: 'app:undo-close',
  APP_COMMAND_PALETTE: 'app:command-palette',
  APP_PROMPT_JUMP_UP: 'app:prompt-jump-up',
  APP_PROMPT_JUMP_DOWN: 'app:prompt-jump-down',
  APP_QUICK_TERMINAL: 'app:quick-terminal',
  APP_SET_OPACITY: 'app:set-opacity',
  APP_SAVE_TERMINAL_MENU: 'app:save-terminal-menu',
  APP_SWITCH_TAB_BY_ID: 'app:switch-tab-by-id',
  APP_OPEN_EXTERNAL: 'app:open-external',
  APP_GET_HOSTNAME: 'app:get-hostname',
  WINDOW_MOVE_BY: 'window:move-by',
  // Last-tab close: what closing this window means, and the in-app dialog's
  // one-shot "already confirmed" for main's close guard (close-preconfirm.ts).
  WINDOW_CLOSE_INFO: 'window:close-info',
  WINDOW_PRECONFIRM_CLOSE: 'window:preconfirm-close',
  // Close the sender's own window from main: BrowserWindow.close() emits
  // 'close' (the guard runs), the page's window.close() does not.
  WINDOW_CLOSE: 'window:close',
  // --- in-app quit / close confirmations (v1.19; main/close-confirm.ts) ---
  // Main asks the renderer to show "Quit Patton?" / "Close this window?" instead
  // of a native box (⌘W can answer an in-app dialog, not an NSAlert).
  WINDOW_CONFIRM_REQUEST: 'window:confirm-request', // main → renderer { requestId, kind, terminals }
  WINDOW_CONFIRM_DISMISS: 'window:confirm-dismiss', // main → renderer { requestId }
  WINDOW_CONFIRM_ACK: 'window:confirm-ack', // renderer → main: the dialog is on screen
  WINDOW_CONFIRM_ANSWER: 'window:confirm-answer', // renderer → main: the user's answer
  // --- end in-app quit / close confirmations ---

  DIAGNOSTICS_SAVE_SNAPSHOT: 'diagnostics:save-snapshot',

  LOG_RENDERER: 'log:renderer',

  // --- Claude Code Stop hook (Settings → Claude Code) ---
  CLAUDE_HOOK_STATUS: 'claude:hookStatus',
  CLAUDE_HOOK_INSTALL: 'claude:installHook',
  CLAUDE_HOOK_REMOVE: 'claude:removeHook',
  // --- end Claude Code Stop hook ---
  // --- image paste ---
  CLIPBOARD_READ_IMAGE: 'clipboard:readImage',
  // --- end image paste ---
  // --- Project board (new empty tabs) ---
  BOARD_GET: 'board:get',
  BOARD_SET_LAYOUT: 'board:set-layout',
  BOARD_PICK_FOLDER: 'board:pick-folder',
  BOARD_ADD_PROJECT: 'board:add-project',
  BOARD_CHANGED: 'board:changed',
  BOARD_LIST_CHANGED: 'board:list-changed',
  // --- end project board ---
  // --- System fonts (SF Mono from Terminal.app) ---
  FONTS_GET_SYSTEM: 'fonts:getSystem',
  // --- end system fonts ---
} as const;

/** The notification sounds Patton ships; settings outside this list are ignored. */
export const NOTIFICATION_SOUND_TYPES = ['chime', 'bugle', 'bullet'] as const;
export type NotificationSoundType = (typeof NOTIFICATION_SOUND_TYPES)[number];

export function isNotificationSoundType(value: unknown): value is NotificationSoundType {
  return typeof value === 'string' && (NOTIFICATION_SOUND_TYPES as readonly string[]).includes(value);
}

/** The window's ground before the renderer paints. Must equal --bg in main.css
 *  (light :root, dark prefers-color-scheme block). */
export const WINDOW_BG = { light: '#ffffff', dark: '#111214' } as const;

/** Faint area tints a project-board theme may take; 'none' is the plain surface.
 *  Each has a light and a dark value in styles/board.css. */
export const BOARD_TINTS = ['sand', 'slate', 'teal', 'lilac', 'peach', 'olive', 'rose', 'stone', 'none'] as const;
export type BoardTint = (typeof BOARD_TINTS)[number];

export function isBoardTint(value: unknown): value is BoardTint {
  return typeof value === 'string' && (BOARD_TINTS as readonly string[]).includes(value);
}

export const DEFAULTS = {
  SHELL: '/bin/zsh',
  COLS: 80,
  ROWS: 24,
  FONT_SIZE: 14,
  FONT_FAMILY: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
  SCROLLBACK: 10000,
  // DOM ("Compatibility") is the default: it has no GPU glyph atlas, so the
  // garbled-text corruption class is structurally impossible. WebGL ("GPU") is
  // a one-click opt-in (command palette / Settings → Text Renderer) for anyone
  // who wants its perf on huge output bursts. See S29 render saga.
  RENDERER: 'dom',
  HISTORY_MAX: 10000,
  WRITE_COALESCE_MS: 4,
  FONT_SIZE_MIN: 8,
  // Interface Text Size: scales the chrome's text (tabs, board, panels, menus),
  // never the terminal (that is Font Size). Only these values are accepted.
  UI_TEXT_SCALE: 1,
  UI_TEXT_SCALES: [0.9, 1, 1.1, 1.25, 1.5] as readonly number[],
  FONT_SIZE_MAX: 72,
  NOTIFICATION_SOUND: true,
  NOTIFICATION_SOUND_TYPE: 'chime' as const,
  STARTUP_COMMAND: '' as const,
  // Compose-first in Claude Code tabs (Settings, per tab from the palette).
  COMPOSE_FIRST: true,
  // Multi-line paste confirmation: off since Michael's dictation (pasted text)
  // tripped it on every message (2026-11-06).
  CONFIRM_MULTILINE_PASTE: false,
  // Answer Claude Code's OSC 7501 probe (v1.14); off falls back to the title
  // glyph + Stop-hook path of v1.13.
  PROGRAM_STATUS: true,
  // Checkpoint clock (tab strip): amber at this % of the context window used
  // since the session's last /checkpoint, and the setting's allowed range.
  CHECKPOINT_NUDGE_PCT: 20,
  CHECKPOINT_NUDGE_PCT_MIN: 1,
  CHECKPOINT_NUDGE_PCT_MAX: 100,
  MAX_PANES_PER_TAB: 5,
  // Notes scratchpad: max stored characters (a generous ~1 MB cap so a runaway
  // paste can't bloat the encrypted config file) and the panel's default width.
  NOTES_MAX_CHARS: 1_000_000,
  NOTES_PANEL_WIDTH: 360,
  // Project names (right-click a tab → Set Default Tab Name for Project…): the longest name kept,
  // and how many projects' names are stored before new ones are refused.
  PROJECT_NAME_MAX_CHARS: 60,
  PROJECT_NAMES_MAX: 500,
  // --- Bookmarks sidebar: longest label, most entries, default panel width ---
  BOOKMARK_LABEL_MAX_CHARS: 60,
  BOOKMARKS_MAX: 200,
  BOOKMARKS_PANEL_WIDTH: 196,
  BOOKMARKS_PANEL_MIN_WIDTH: 160,
  // --- end bookmarks ---
  // --- Project board: the default project list (cc's), layout limits ---
  PROJECT_BOARD: true,
  PROJECT_LIST_FILE: '' as const,
  // The board's Wake button types this into a new tab ('' hides the button).
  BOARD_WAKE_COMMAND: 'wake',
  BOARD_WAKE_COMMAND_MAX_CHARS: 200,
  BOARD_THEME_NAME_MAX_CHARS: 40,
  BOARD_THEMES_MAX: 60,
  BOARD_PATHS_MAX: 2000,
  BOARD_NOTE_MAX_CHARS: 80,
  BOARD_PROJECT_NAME_MAX_CHARS: 60,
  /** The largest project list file + Project will write to (a list of a few
   *  hundred rows is about 50 KB). */
  BOARD_LIST_MAX_BYTES: 1024 * 1024,
  /** A path stored in the layout (a theme's projects, a tile's options). */
  BOARD_PATH_MAX_CHARS: 1024,
  /** All the layout's paths together, in characters, so the file stays small. */
  BOARD_LAYOUT_PATH_BUDGET: 512 * 1024,
  // --- end project board ---
  // Quick-terminal global hotkey. Configurable via the `globalHotkey` setting;
  // this is the fallback used by main.ts and shown in Settings when unset.
  GLOBAL_HOTKEY: 'Control+`',
} as const;

export const PATTON_QUOTES = [
  'A good plan violently executed now is better than a perfect plan executed next week.',
  "If everybody is thinking alike, then somebody isn't thinking.",
  'It is foolish and wrong to mourn the men who died. Rather, we should thank God that such men lived.',
  "Don't tell people how to do things, tell them what to do and let them surprise you with their results.",
  'Better to fight for something than live for nothing.',
  "I don't measure a man's success by how high he climbs but how high he bounces when he hits bottom.",
  'Anyone in any walk of life who is content with mediocrity is untrue to himself and to American tradition.',
  'Do your duty as you see it, and damn the consequences.',
  'A man must know his destiny\u2026 if he does not recognize it, then he is lost. By this I mean, once, twice, or at the very most, three times, fate will reach out and tap a man on the shoulder\u2026 if he has the imagination, he will turn around and fate will point out to him what fork in the road he should take, if he has the guts, he will take it.',
  'Wars may be fought with weapons, but they are won by men. It is the spirit of men who follow and of the man who leads that gains the victory.',
  'When in doubt, ATTACK!',
  'Accept the challenges so that you can feel the exhilaration of victory.',
  'A pint of sweat will save a gallon of blood.',
  "Do not make excuses, whether it's your fault or not.",
  "I don't fear failure. I only fear the slowing up of the engine inside of me which is saying, 'Keep going, someone must be on top, why not you?'",
  'Take calculated risks. That is quite different from being rash.',
  'Nobody ever defended anything successfully, there is only attack and attack and attack some more.',
  'An Army is a team. It lives, sleeps, eats and fights as a team. This individual heroic stuff is pure horse shit.',
  'Always do more than is required of you.',
];


/** The saved Interface Text Size, or 1 when absent (settings saved before it
 *  existed) or not one of DEFAULTS.UI_TEXT_SCALES. */
export function uiTextScaleOf(value: unknown): number {
  return typeof value === 'number' && DEFAULTS.UI_TEXT_SCALES.includes(value) ? value : DEFAULTS.UI_TEXT_SCALE;
}

/** The command-line switch main hands each window's preload (webPreferences.
 *  additionalArguments) so the renderer knows its Interface Text Size
 *  synchronously, before it builds any chrome. */
export const UI_TEXT_SCALE_ARG = '--patton-ui-scale=';

/** The scale carried by that switch in a process argv; 1 when absent or invalid. */
export function uiTextScaleFromArgv(argv: readonly string[]): number {
  const arg = argv.find((a) => a.startsWith(UI_TEXT_SCALE_ARG));
  return uiTextScaleOf(arg === undefined ? undefined : Number(arg.slice(UI_TEXT_SCALE_ARG.length)));
}

/**
 * How long a quit / close-window confirmation must have been on screen before
 * a second ⌘Q (main) or ⌘W (renderer) counts as "yes": a double-tap or a held
 * key is not a decision (S46 review).
 */
export const CONFIRM_SHORTCUT_DWELL_MS = 300;
