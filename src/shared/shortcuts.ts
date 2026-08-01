/**
 * Single source of truth for Patton's keyboard shortcuts.
 *
 * Every surface that displays a shortcut reads from here: the application menu
 * (`main/menu.ts`), the command palette and the Settings grid
 * (`renderer/components/app.ts`, `settings-panel.ts`), the pane context menu
 * (`pane.ts`), and the onboarding card (`onboarding.ts`). Each of those used to
 * keep its own hand-written copy, and they drifted — by S34 the Settings grid
 * was missing eight shortcuts, Toggle Notes (⌃⌘N) among them.
 *
 * To add a shortcut: add one entry below and wire its behaviour. It shows up in
 * the Settings grid automatically, and in the command palette when `palette` is
 * set. No display list anywhere else needs editing.
 */

export interface Shortcut {
  /** Stable id. Doubles as the command-palette action id — see `App.executeAction`. */
  id: string;
  /** Human label. Used by the command palette, the Settings grid, and the menu
   *  (unless `menuLabel` overrides it). */
  label: string;
  /**
   * Electron accelerator, used verbatim by the application menu. Display keys
   * are derived from it, so this is the only place the binding is written down.
   * Omit when the keys need `keys` below, or the command has no binding at all.
   */
  accelerator?: string;
  /**
   * Display keys for bindings a single accelerator can't express — a key range
   * (⌘1–9) or an arrow cluster (⌘⌥←↑↓→). Takes precedence over `accelerator`.
   */
  keys?: string;
  /**
   * The renderer handles this keystroke itself in `keybinding-manager.ts`
   * rather than through a main-process menu item. The accelerator is recorded
   * here for display only — `menu.ts` must not build a menu item from it, or
   * the menu would swallow the key before the renderer sees it.
   */
  rendererOnly?: boolean;
  /** Menu label, where macOS convention differs from `label` ("Preferences…"). */
  menuLabel?: string;
  /** Include in the command palette, using `id` as the action id. */
  palette?: boolean;
  /** Keep out of the Settings grid. For OS-standard bindings (⌘C/⌘V) that are
   *  listed here only so the pane context menu can render their keys — the grid
   *  is meant for Patton's own shortcuts. */
  hideFromSettings?: boolean;
}

/**
 * Ordered registry. Array order is the Settings grid order, so keep related
 * commands together.
 */
export const SHORTCUTS: Shortcut[] = [
  // ── Tabs & windows ──
  { id: 'new-tab', label: 'New Tab', accelerator: 'CmdOrCtrl+T', palette: true },
  {
    id: 'close-pane',
    label: 'Close Pane or Tab',
    // S33: ⌘W closes the focused pane on a split tab, else the whole tab.
    accelerator: 'CmdOrCtrl+W',
    menuLabel: 'Close Tab',
    palette: true,
  },
  { id: 'undo-close', label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', palette: true },
  { id: 'new-window', label: 'New Window', accelerator: 'CmdOrCtrl+N' },
  { id: 'next-tab', label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', menuLabel: 'Select Next Tab', palette: true },
  { id: 'prev-tab', label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', menuLabel: 'Select Previous Tab', palette: true },
  // Nine menu items (⌘1…⌘9) generated in menu.ts, each suffixed with its
  // number ("Tab 1"); shown as a single row here.
  { id: 'switch-tab', label: 'Switch to Tab', menuLabel: 'Tab', keys: '⌘1–9' },

  // ── Panes & splits ──
  { id: 'split-vertical', label: 'Split Pane Right', accelerator: 'CmdOrCtrl+D', palette: true },
  { id: 'split-horizontal', label: 'Split Pane Down', accelerator: 'CmdOrCtrl+Shift+D', palette: true },
  { id: 'zoom-split', label: 'Zoom Split', accelerator: 'CmdOrCtrl+Shift+Enter', palette: true },
  // Four bindings (⌘⌥ + each arrow) handled in keybinding-manager.ts.
  { id: 'focus-pane', label: 'Navigate Panes', keys: '⌘⌥←↑↓→', rendererOnly: true },

  // ── View ──
  { id: 'search', label: 'Find', accelerator: 'CmdOrCtrl+F', palette: true },
  { id: 'clear', label: 'Clear Terminal', accelerator: 'CmdOrCtrl+K', palette: true },
  { id: 'font-up', label: 'Increase Font Size', accelerator: 'CmdOrCtrl+=', palette: true },
  { id: 'font-down', label: 'Decrease Font Size', accelerator: 'CmdOrCtrl+-', palette: true },
  { id: 'prompt-up', label: 'Jump to Previous Prompt', accelerator: 'CmdOrCtrl+Shift+Up', palette: true },
  { id: 'prompt-down', label: 'Jump to Next Prompt', accelerator: 'CmdOrCtrl+Shift+Down', palette: true },
  { id: 'command-palette', label: 'Command Palette', accelerator: 'CmdOrCtrl+Shift+P' },

  // ── Input & tools ──
  { id: 'toggle-compose', label: 'Toggle Compose Panel', accelerator: 'CmdOrCtrl+E', rendererOnly: true, palette: true },
  { id: 'history-search', label: 'History Search', accelerator: 'Control+R', rendererOnly: true, palette: true },
  { id: 'broadcast', label: 'Broadcast Input', accelerator: 'CmdOrCtrl+Shift+B', palette: true },
  {
    id: 'toggle-notes',
    label: 'Toggle Notes',
    // Ctrl+Cmd+N — deliberately distinct from ⌘N (New Window) and ⌘T (New Tab):
    // a notes scratchpad is separate from opening a shell.
    accelerator: 'Control+Command+N',
    palette: true,
  },
  { id: 'save-terminal', label: 'Save Terminal Output', accelerator: 'CmdOrCtrl+S', menuLabel: 'Save Terminal Output...', palette: true },
  // Keys come from the configurable `globalHotkey` setting, so they are filled
  // in at render time rather than fixed here.
  { id: 'quick-terminal', label: 'Quick Terminal', palette: true },
  { id: 'settings', label: 'Settings', accelerator: 'CmdOrCtrl+,', menuLabel: 'Preferences...', palette: true },

  // ── Renderer ──
  { id: 'reset-renderer', label: 'Reset Renderer', accelerator: 'CmdOrCtrl+Shift+K', rendererOnly: true, palette: true },
  { id: 'capture-render-state', label: 'Capture Renderer State', palette: true },

  // ── OS-standard, listed for the pane context menu only ──
  { id: 'copy', label: 'Copy', accelerator: 'CmdOrCtrl+C', hideFromSettings: true },
  { id: 'paste', label: 'Paste', accelerator: 'CmdOrCtrl+V', hideFromSettings: true },
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

/** Look up a shortcut. Throws on an unknown id so a typo fails at startup
 *  instead of silently rendering a blank menu item or palette row. */
export function shortcut(id: string): Shortcut {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown shortcut id: ${id}`);
  return found;
}

const MODIFIER_GLYPHS: Record<string, string> = {
  cmdorctrl: '⌘', command: '⌘', cmd: '⌘', super: '⌘', meta: '⌘',
  control: '⌃', ctrl: '⌃',
  alt: '⌥', option: '⌥',
  shift: '⇧',
};

/**
 * Patton renders modifiers in the order ⌃ ⌘ ⌥ ⇧ — the order its UI has always
 * used (⌘⇧D, ⌃⌘N, ⌘⌥←). That is not Apple's canonical ⌃⌥⇧⌘; it is kept so the
 * strings users already know don't shuffle when this registry took over.
 */
const MODIFIER_ORDER = ['⌃', '⌘', '⌥', '⇧'];

const KEY_GLYPHS: Record<string, string> = {
  enter: '⏎', return: '⏎',
  up: '↑', down: '↓', left: '←', right: '→',
  space: '␣', tab: '⇥', backspace: '⌫', delete: '⌦',
  escape: '⎋', esc: '⎋',
  plus: '+',
};

/** Convert an Electron accelerator ("CmdOrCtrl+Shift+D") to the macOS glyphs
 *  Patton displays ("⌘⇧D"). */
export function acceleratorToDisplay(accelerator: string): string {
  const modifiers: string[] = [];
  let key = '';

  for (const part of accelerator.split('+')) {
    const glyph = MODIFIER_GLYPHS[part.toLowerCase()];
    if (glyph) {
      if (!modifiers.includes(glyph)) modifiers.push(glyph);
    } else if (part.length > 0) {
      key = KEY_GLYPHS[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part);
    }
  }

  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return modifiers.join('') + key;
}

/** The keys to display for a shortcut — empty string when it has no binding. */
export function displayKeys(s: Shortcut): string {
  if (s.keys) return s.keys;
  return s.accelerator ? acceleratorToDisplay(s.accelerator) : '';
}

/** Display keys by id, for surfaces that show one specific shortcut
 *  (context menu, onboarding card). */
export function shortcutKeys(id: string): string {
  return displayKeys(shortcut(id));
}

/** Entries the command palette lists, in registry order. */
export function paletteShortcuts(): Shortcut[] {
  return SHORTCUTS.filter((s) => s.palette);
}

/** Entries the Settings → Keyboard Shortcuts grid lists: everything that has a
 *  binding, except OS-standard ones. `quick-terminal` is included despite having
 *  no static keys — the grid fills in the live `globalHotkey`. */
export function settingsShortcuts(): Shortcut[] {
  return SHORTCUTS.filter((s) => !s.hideFromSettings && (displayKeys(s) !== '' || s.id === 'quick-terminal'));
}
