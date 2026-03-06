import { app } from 'electron';
import ElectronStore from 'electron-store';
import { createHash } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { DEFAULTS } from '../shared/constants';
import type { HistoryEntry, AppSettings, WindowState } from '../shared/types';

// Machine-binding key for electron-store (obfuscation, not encryption against local attackers)
function getEncryptionKey(): string {
  let username: string;
  try {
    username = userInfo().username;
  } catch {
    username = process.env.USER || 'unknown';
  }
  const raw = `${hostname()}:${username}`;
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
}

const defaults: StoreSchema = {
  history: [],
  settings: {
    fontSize: DEFAULTS.FONT_SIZE,
    fontFamily: DEFAULTS.FONT_FAMILY,
    scrollback: DEFAULTS.SCROLLBACK,
    shell: DEFAULTS.SHELL,
    notificationSound: DEFAULTS.NOTIFICATION_SOUND,
  },
  windowState: {
    width: 900,
    height: 600,
    isMaximized: false,
  },
};

let store: ElectronStore<StoreSchema> | null = null;

function getStore(): ElectronStore<StoreSchema> {
  if (!store) {
    try {
      store = new Store({ defaults, encryptionKey: getEncryptionKey() });
    } catch (err) {
      console.warn('[SECURITY] Store corrupted, resetting', err);
      try {
        // Compute config path directly — don't create a tempStore (it would fail
        // parsing the encrypted file as plain JSON).
        const configPath = join(app.getPath('userData'), 'config.json');
        if (existsSync(configPath)) unlinkSync(configPath);
      } catch {
        // Ignore cleanup errors
      }
      store = new Store({ defaults, encryptionKey: getEncryptionKey() });
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
    // Shell validation handled by pty-manager allowlist; store as-is
    // but only if it looks like a valid path
    const s = String(partial.shell);
    if (/^\/[a-zA-Z0-9/._-]+$/.test(s)) {
      validated.shell = s;
    }
  }

  if (partial.notificationSound !== undefined) {
    validated.notificationSound = !!partial.notificationSound;
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
