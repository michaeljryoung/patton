import { app, safeStorage } from 'electron';
import ElectronStore from 'electron-store';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { DEFAULTS } from '../shared/constants';
import { ALLOWED_SHELLS } from './pty-manager';
import type { HistoryEntry, AppSettings, WindowState, SessionState } from '../shared/types';

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
}

const defaults: StoreSchema = {
  history: [],
  settings: {
    fontSize: DEFAULTS.FONT_SIZE,
    fontFamily: DEFAULTS.FONT_FAMILY,
    scrollback: DEFAULTS.SCROLLBACK,
    shell: DEFAULTS.SHELL,
    notificationSound: DEFAULTS.NOTIFICATION_SOUND,
    notificationSoundType: DEFAULTS.NOTIFICATION_SOUND_TYPE,
    copyOnSelect: false,
    globalHotkey: 'Control+`',
    theme: 'system',
    startupCommand: DEFAULTS.STARTUP_COMMAND,
    opacity: 1.0,
    restoreSession: false,
    shellIntegration: true,
    renderer: DEFAULTS.RENDERER,
  },
  windowState: {
    width: 900,
    height: 600,
    isMaximized: false,
  },
  session: null,
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

  if (partial.notificationSound !== undefined) {
    validated.notificationSound = !!partial.notificationSound;
  }

  if (partial.notificationSoundType !== undefined) {
    const t = String(partial.notificationSoundType);
    if (['chime', 'bugle', 'bullet'].includes(t)) {
      validated.notificationSoundType = t;
    }
  }

  if (partial.copyOnSelect !== undefined) {
    validated.copyOnSelect = !!partial.copyOnSelect;
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

  getStore().set('session', session);
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
