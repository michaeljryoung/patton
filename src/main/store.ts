import { app, safeStorage } from 'electron';
import ElectronStore from 'electron-store';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { DEFAULTS, isNotificationSoundName } from '../shared/constants';
import { ALLOWED_SHELLS } from './pty-manager';
import { cleanProjectName, type ProjectNameTarget } from './projects';
import { sanitiseSessionGroups } from './session-groups';
import type { HistoryEntry, AppSettings, WindowState, SessionState, Bookmark } from '../shared/types';
import { driveAccountValid, driveFolderValid } from '../shared/drive-settings';

// Keychain-protected random encryption key for electron-store.
// The key itself is 32 random bytes, stored in userData/key.enc encrypted by
// the OS keychain via safeStorage. Unlike the previous deterministic
// SHA-256(homedir + ':' + username) scheme — which any same-user process could
// reconstruct in milliseconds — this key requires Keychain access to read.
function getEncryptionKey(): string {
  const keyPath = join(app.getPath('userData'), 'key.enc');

  // Load existing keychain-protected key if available
  if (existsSync(keyPath) && safeStorage.isEncryptionAvailable()) {
    try {
      const decrypted = safeStorage.decryptString(readFileSync(keyPath));
      if (decrypted && decrypted.length === 64) return decrypted;
    } catch {
      // Keychain read failed or key corrupt — fall through to regenerate
    }
  }

  // Generate and persist a new random key
  const newKey = randomBytes(32).toString('hex');
  if (safeStorage.isEncryptionAvailable()) {
    try {
      writeFileSync(keyPath, safeStorage.encryptString(newKey), { mode: 0o600 });
      return newKey;
    } catch (err) {
      console.warn('[SECURITY] safeStorage persist failed, falling back to legacy key:', err);
    }
  }
  // Fallback for environments without a keyring (Linux without GNOME keyring,
  // etc.) — same weak scheme as before, but at least it still works.
  return getLegacyEncryptionKey();
}

// Previous deterministic scheme. Kept solely for one-shot migration of
// existing config.json files encrypted with it.
function getLegacyEncryptionKey(): string {
  let username: string;
  try {
    username = userInfo().username;
  } catch {
    username = process.env.USER || 'unknown';
  }
  const home = homedir() || '/unknown';
  const raw = `${home}:${username}`;
  return createHash('sha256').update(raw).digest('hex');
}

// --- Security: Auto-expire history entries older than 90 days ---
const HISTORY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// electron-store exports default as .default when externalized by Vite
const Store = ((ElectronStore as unknown as Record<string, unknown>).default || ElectronStore) as typeof ElectronStore;

interface StoreSchema {
  history: HistoryEntry[];
  settings: AppSettings;
  windowState: WindowState;
  session: SessionState | null;
  notes: string;
  projectNames: Record<string, string>;
  bookmarks: Bookmark[]; // bookmarks sidebar
  /** Page titles (main/page-titles.ts): artifact id → { title, at }. */
  pageTitles: Record<string, { title: string; at: number }>;
  /** Backfill misses: artifact id → when it was last searched for. */
  pageTitleMisses: Record<string, number>;
}

const defaults: StoreSchema = {
  history: [],
  settings: {
    fontSize: DEFAULTS.FONT_SIZE,
    fontFamily: DEFAULTS.FONT_FAMILY,
    uiTextScale: DEFAULTS.UI_TEXT_SCALE,
    scrollback: DEFAULTS.SCROLLBACK,
    shell: DEFAULTS.SHELL,
    notificationSoundName: DEFAULTS.NOTIFICATION_SOUND_NAME,
    notificationSoundVolume: DEFAULTS.NOTIFICATION_SOUND_VOLUME,
    copyOnSelect: false,
    globalHotkey: 'Control+`',
    theme: 'system',
    startupCommand: DEFAULTS.STARTUP_COMMAND,
    opacity: 1.0,
    restoreSession: false,
    shellIntegration: true,
    renderer: DEFAULTS.RENDERER,
    composeBox: DEFAULTS.COMPOSE_BOX,
    composeOverBar: DEFAULTS.COMPOSE_OVER_BAR,
    confirmMultilinePaste: DEFAULTS.CONFIRM_MULTILINE_PASTE,
    programStatus: DEFAULTS.PROGRAM_STATUS,
    checkpointNudgePct: DEFAULTS.CHECKPOINT_NUDGE_PCT,
    projectBoard: DEFAULTS.PROJECT_BOARD,
    reviewTab: true,
    driveFolder: 'Patton',
    driveAccount: '',
    projectListFile: DEFAULTS.PROJECT_LIST_FILE,
    boardWakeCommand: DEFAULTS.BOARD_WAKE_COMMAND,
  },
  windowState: {
    width: 900,
    height: 600,
    isMaximized: false,
  },
  session: null,
  notes: '',
  projectNames: {},
  bookmarks: [], // bookmarks sidebar
  pageTitles: {},
  pageTitleMisses: {},
};

let store: ElectronStore<StoreSchema> | null = null;

function getStore(): ElectronStore<StoreSchema> {
  if (store) return store;

  const encryptionKey = getEncryptionKey();

  // First, attempt migration from the legacy deterministic key. If a config
  // file exists and the new key can't decrypt it but the legacy key can,
  // copy the contents, delete the file, and reinitialize with the new key.
  const configPath = join(app.getPath('userData'), 'config.json');
  if (existsSync(configPath) && encryptionKey !== getLegacyEncryptionKey()) {
    try {
      // Probe: can the new key read the existing file?
      const probe = new Store({ defaults, encryptionKey });
      void probe.store;
    } catch {
      // New key can't — try the legacy key
      try {
        const legacy = new Store({ defaults, encryptionKey: getLegacyEncryptionKey() });
        const snapshot = legacy.store;
        unlinkSync(configPath);
        const fresh = new Store({ defaults, encryptionKey });
        for (const [k, v] of Object.entries(snapshot)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store schema keys are dynamic here
          (fresh as any).set(k, v);
        }
        store = fresh;
        console.log('[SECURITY] Migrated store from legacy encryption key to safeStorage-backed key');
        return store;
      } catch {
        // Legacy key also failed — fall through to normal corruption handling below
      }
    }
  }

  try {
    store = new Store({ defaults, encryptionKey });
  } catch (err) {
    // Only delete store on parse/decrypt errors — not on permission/disk errors
    const errCode = (err as NodeJS.ErrnoException).code;
    const isCorruption = !errCode || errCode === 'ERR_CRYPTO_INVALID_IV' || errCode === 'ERR_OSSL_BAD_DECRYPT';
    if (isCorruption || (err instanceof SyntaxError)) {
      console.warn('[SECURITY] Store corrupted, resetting', err);
      try {
        if (existsSync(configPath)) unlinkSync(configPath);
      } catch {
        // Ignore cleanup errors
      }
      store = new Store({ defaults, encryptionKey });
    } else {
      console.error('[SECURITY] Store init failed (not corruption, not resetting)', err);
      throw err;
    }
  }
  return store;
}

export function getHistory(): HistoryEntry[] {
  const s = getStore();
  const history: HistoryEntry[] = s.get('history', []);
  const cutoff = Date.now() - HISTORY_TTL_MS;
  const filtered = history.filter((h: HistoryEntry) => h.timestamp >= cutoff);
  if (filtered.length !== history.length) {
    s.set('history', filtered);
  }
  return filtered;
}

export function addHistory(command: string): void {
  const s = getStore();
  const history = s.get('history', []);
  // Deduplicate: remove previous identical entry
  const filtered = history.filter((h: HistoryEntry) => h.command !== command);
  filtered.push({ command, timestamp: Date.now() });
  // Cap at max
  if (filtered.length > DEFAULTS.HISTORY_MAX) {
    filtered.splice(0, filtered.length - DEFAULTS.HISTORY_MAX);
  }
  s.set('history', filtered);
}

export function clearHistory(): void {
  getStore().set('history', []);
}

export function getSettings(): AppSettings {
  return getStore().get('settings', defaults.settings);
}

// --- Security: Validate settings before persisting ---
export function setSettings(partial: Partial<AppSettings>): void {
  const validated: Partial<AppSettings> = {};

  if (partial.fontSize !== undefined) {
    const n = Number(partial.fontSize);
    if (!isNaN(n) && n >= 8 && n <= 72) {
      validated.fontSize = n;
    }
  }

  if (partial.uiTextScale !== undefined) {
    // Exactly one of the allowed numbers; a string, NaN or anything else is refused.
    if (typeof partial.uiTextScale === 'number' && DEFAULTS.UI_TEXT_SCALES.includes(partial.uiTextScale)) {
      validated.uiTextScale = partial.uiTextScale;
    }
  }

  if (partial.fontFamily !== undefined) {
    const f = String(partial.fontFamily);
    if (f.length <= 200 && /^[a-zA-Z0-9\s,'"-]+$/.test(f)) {
      validated.fontFamily = f;
    }
  }

  if (partial.scrollback !== undefined) {
    const n = Number(partial.scrollback);
    if (!isNaN(n) && n >= 100 && n <= 100000) {
      validated.scrollback = n;
    }
  }

  if (partial.shell !== undefined) {
    // Validate against the same allowlist pty-manager uses at spawn time.
    // Without this, a path that passes a permissive regex here would silently
    // fall back to the default at spawn — user saves a value they never get.
    const s = String(partial.shell);
    if (ALLOWED_SHELLS.has(s)) {
      validated.shell = s;
    }
  }

  if (partial.notificationSoundName !== undefined) {
    if (isNotificationSoundName(partial.notificationSoundName)) {
      validated.notificationSoundName = partial.notificationSoundName;
    }
  }

  if (partial.notificationSoundVolume !== undefined) {
    const v = partial.notificationSoundVolume;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) {
      validated.notificationSoundVolume = Math.round(v);
    }
  }

  if (partial.copyOnSelect !== undefined) {
    validated.copyOnSelect = !!partial.copyOnSelect;
  }

  if (partial.confirmMultilinePaste !== undefined) {
    validated.confirmMultilinePaste = !!partial.confirmMultilinePaste;
  }

  if (partial.programStatus !== undefined) {
    validated.programStatus = !!partial.programStatus;
  }

  if (partial.checkpointNudgePct !== undefined) {
    // A number only: Number(true) would pass as 1.
    const n = partial.checkpointNudgePct;
    if (typeof n === 'number' && Number.isInteger(n) && n >= DEFAULTS.CHECKPOINT_NUDGE_PCT_MIN && n <= DEFAULTS.CHECKPOINT_NUDGE_PCT_MAX) {
      validated.checkpointNudgePct = n;
    }
  }

  if (partial.projectBoard !== undefined) {
    validated.projectBoard = !!partial.projectBoard;
  }

  if (partial.reviewTab !== undefined) {
    validated.reviewTab = !!partial.reviewTab;
  }

  if (partial.driveFolder !== undefined) {
    // One folder at the top of My Drive: no slash, no control characters.
    const f = String(partial.driveFolder).trim();
    if (driveFolderValid(f)) validated.driveFolder = f;
  }

  if (partial.driveAccount !== undefined) {
    const a = String(partial.driveAccount).trim();
    if (driveAccountValid(a)) validated.driveAccount = a;
  }

  if (partial.projectListFile !== undefined) {
    // One line of printable text; main/project-board.ts decides whether it is
    // a usable path (absolute or ~/…, no traversal) each time it reads it.
    const f = String(partial.projectListFile);
    if (f.length <= 1024 && !/\p{Cc}/u.test(f)) {
      validated.projectListFile = f.trim();
    }
  }

  if (partial.boardWakeCommand !== undefined) {
    // Typed into a shell like the startup command: one line of printable ASCII.
    const c = String(partial.boardWakeCommand).trim();
    if (c.length <= DEFAULTS.BOARD_WAKE_COMMAND_MAX_CHARS && /^[\x20-\x7E]*$/.test(c)) {
      validated.boardWakeCommand = c;
    }
  }

  if (partial.globalHotkey !== undefined) {
    const h = String(partial.globalHotkey);
    if (h.length <= 50 && /^[a-zA-Z0-9+`]+$/.test(h)) {
      validated.globalHotkey = h;
    }
  }

  if (partial.theme !== undefined) {
    const t = String(partial.theme);
    if (t.length <= 50 && /^[a-zA-Z0-9-]+$/.test(t)) {
      validated.theme = t;
    }
  }

  if (partial.startupCommand !== undefined) {
    const s = String(partial.startupCommand);
    if (s.length <= 1000 && /^[\x20-\x7E]*$/.test(s)) {
      validated.startupCommand = s;
    }
  }

  if (partial.restoreSession !== undefined) {
    validated.restoreSession = !!partial.restoreSession;
  }

  if (partial.shellIntegration !== undefined) {
    validated.shellIntegration = !!partial.shellIntegration;
  }

  if (partial.composeBox !== undefined) {
    validated.composeBox = !!partial.composeBox;
  }

  if (partial.composeOverBar !== undefined) {
    validated.composeOverBar = !!partial.composeOverBar;
  }

  if (partial.renderer !== undefined) {
    const r = String(partial.renderer);
    if (r === 'webgl' || r === 'dom') {
      validated.renderer = r;
    }
  }

  if (partial.opacity !== undefined) {
    const n = Number(partial.opacity);
    if (!isNaN(n) && n >= 0.3 && n <= 1.0) {
      validated.opacity = Math.round(n * 100) / 100; // Round to 2 decimal places
    }
  }

  if (Object.keys(validated).length > 0) {
    const s = getStore();
    const current = s.get('settings', defaults.settings);
    s.set('settings', { ...current, ...validated });
  }
}

// --- Notes scratchpad (single per-store document) ---
export function getNotes(): string {
  const n = getStore().get('notes', '');
  return typeof n === 'string' ? n : '';
}

export function setNotes(content: string): void {
  // Coerce + cap: the renderer already caps, but the store is the trust
  // boundary — an oversized payload must never reach the config file.
  const str = typeof content === 'string' ? content : String(content ?? '');
  const capped = str.length > DEFAULTS.NOTES_MAX_CHARS ? str.slice(0, DEFAULTS.NOTES_MAX_CHARS) : str;
  getStore().set('notes', capped);
}

// --- Project names (project root, or a linked worktree's folder → the name its tabs show) ---
export function getProjectNames(): Record<string, string> {
  const names = getStore().get('projectNames', {});
  return names && typeof names === 'object' && !Array.isArray(names) ? names : {};
}

/**
 * Store the name a project's tabs show, or, for a linked worktree, the name
 * that worktree shows alone. An empty name, or (for a project root) the
 * automatic one, removes the entry so the tabs go back to their folder-derived
 * name. The caller has already checked `target` with `projectNameTarget`.
 * Returns the full updated map.
 */
export function setProjectName(target: ProjectNameTarget, rawName: string): Record<string, string> {
  // The store is the trust boundary, so the name is cleaned here, not just in the UI.
  const name = cleanProjectName(rawName);
  const names = { ...getProjectNames() };
  if (!name || name === target.defaultName) {
    delete names[target.key];
  } else {
    if (names[target.key] === undefined && Object.keys(names).length >= DEFAULTS.PROJECT_NAMES_MAX) {
      console.warn('[SECURITY] Project name rejected — name store full', { max: DEFAULTS.PROJECT_NAMES_MAX });
      return names;
    }
    names[target.key] = name;
  }
  getStore().set('projectNames', names);
  return names;
}

// --- Bookmarks (sidebar of projects + artifact links) ---
// The list arrives already validated (main/bookmarks.ts), so these only guard
// the stored shape.
export function getBookmarks(): Bookmark[] {
  const list = getStore().get('bookmarks', []);
  return Array.isArray(list) ? list : [];
}

export function setBookmarks(list: Bookmark[]): void {
  getStore().set('bookmarks', list);
}
// --- end bookmarks ---

// --- Page titles (shapes checked by main/page-titles.ts on read) ---
export function getPageTitles(): unknown {
  return getStore().get('pageTitles', {});
}

export function setPageTitles(titles: Record<string, { title: string; at: number }>): void {
  getStore().set('pageTitles', titles);
}

export function getPageTitleMisses(): unknown {
  return getStore().get('pageTitleMisses', {});
}

export function setPageTitleMisses(misses: Record<string, number>): void {
  getStore().set('pageTitleMisses', misses);
}

export function getWindowState(): WindowState {
  return getStore().get('windowState', defaults.windowState);
}

export function getSession(): SessionState | null {
  return getStore().get('session', null);
}

// --- Security: Deep validation for session tree nodes ---
// Depth alone doesn't bound total leaves: a balanced split tree of depth 10
// has up to 1024 leaves, far exceeding MAX_PTY_PER_WINDOW. Count leaves and
// reject trees that would blow the PTY cap at restore time.
const MAX_LEAVES_PER_TAB = 50; // matches PtyManager.MAX_PTY_PER_WINDOW

function isValidTreeNode(node: unknown, depth = 0, counter: { leaves: number } = { leaves: 0 }): boolean {
  // Guard against deeply nested structures (max 10 levels of splits)
  if (depth > 10) return false;
  if (!node || typeof node !== 'object') return false;

  const obj = node as Record<string, unknown>;

  // Split node
  if (obj.type === 'split') {
    if (obj.direction !== 'vertical' && obj.direction !== 'horizontal') return false;
    if (typeof obj.ratio !== 'number' || obj.ratio < 0 || obj.ratio > 1) return false;
    if (!Array.isArray(obj.children) || obj.children.length !== 2) return false;
    return isValidTreeNode(obj.children[0], depth + 1, counter) && isValidTreeNode(obj.children[1], depth + 1, counter);
  }

  // Pane node (no 'type' property): must have 'cwd' string
  if ('type' in obj) return false; // unknown type
  if (typeof obj.cwd !== 'string' || Buffer.byteLength(obj.cwd, 'utf-8') > 4096) return false;
  counter.leaves++;
  if (counter.leaves > MAX_LEAVES_PER_TAB) return false;
  return true;
}

export function setSession(session: SessionState | null): void {
  if (session === null) {
    getStore().set('session', null);
    return;
  }
  // Basic validation: must have tabs array with at least one tab
  if (!session || !Array.isArray(session.tabs) || session.tabs.length === 0) return;
  if (session.tabs.length > 100) return; // sanity cap
  if (typeof session.activeTabIndex !== 'number' || session.activeTabIndex < 0) return;
  if (session.activeTabIndex >= session.tabs.length) return;

  // Deep-validate each tab's tree
  for (const tab of session.tabs) {
    if (!tab || typeof tab !== 'object') return;
    if (typeof tab.focusedPaneIndex !== 'number' || tab.focusedPaneIndex < 0) return;
    if (tab.title !== undefined && (typeof tab.title !== 'string' || tab.title.length > 500)) return;
    if (!tab.tree || !isValidTreeNode(tab.tree)) return;
  }

  // Tab groups: bad group data is dropped, never the session (session-groups.ts).
  const { session: clean, report } = sanitiseSessionGroups(session);
  if (report.droppedGroups > 0 || report.droppedTabRefs > 0) {
    console.warn('[GROUP] session group data dropped', report);
  }
  getStore().set('session', clean);
}

export function setWindowState(state: WindowState): void {
  const w = Number(state.width);
  const h = Number(state.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 200 || w > 10000 || h < 200 || h > 10000) {
    return;
  }
  if (state.x !== undefined && !Number.isFinite(state.x)) return;
  if (state.y !== undefined && !Number.isFinite(state.y)) return;
  // Construct clean object to prevent arbitrary key pollution from IPC payloads
  const clean: WindowState = { width: w, height: h, isMaximized: !!state.isMaximized };
  if (state.x !== undefined) clean.x = state.x;
  if (state.y !== undefined) clean.y = state.y;
  getStore().set('windowState', clean);
}
