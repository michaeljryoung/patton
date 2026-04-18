import { app } from 'electron';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';

// File-based logger for the main process.
//
// Electron main-process `console.error`/`console.warn` calls go to stderr,
// which a packaged-app Dock/Finder launch routes to /dev/null. Without a
// persistent log, the session-20 hardening (render-process-gone handler,
// child-process-gone, unresponsive, safeStorage migration, crash circuit
// breaker, …) is invisible — its signals have nowhere to land.
//
// This module tees every console call to ~/Library/Application Support/
// Patton/logs/main.log with a 5MB-size-based rotation (keeps 3 files).
// stderr writes are preserved so `npm start` / terminal launches still see
// the output live.

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB per rotation
let stream: WriteStream | null = null;
let logPath = '';
let installed = false;

function rotateIfNeeded(): void {
  try {
    if (!logPath || !existsSync(logPath)) return;
    const { size } = statSync(logPath);
    if (size < MAX_LOG_SIZE) return;
    const old2 = `${logPath}.2`;
    const old1 = `${logPath}.1`;
    if (existsSync(old2)) unlinkSync(old2);
    if (existsSync(old1)) renameSync(old1, old2);
    renameSync(logPath, old1);
  } catch {
    // Rotation is best-effort — don't crash the app on a log file issue.
  }
}

function ensureStream(): WriteStream | null {
  if (stream) return stream;
  try {
    const dir = join(app.getPath('userData'), 'logs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    logPath = join(dir, 'main.log');
    rotateIfNeeded();
    stream = createWriteStream(logPath, { flags: 'a' });
    // If the stream errors (disk full, permission, etc.) drop it so we
    // fall back cleanly to stderr-only for subsequent writes.
    stream.on('error', () => { stream = null; });
    return stream;
  } catch {
    return null;
  }
}

function format(level: string, args: unknown[]): string {
  const ts = new Date().toISOString();
  const msg = args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
  return `${ts} [${level}] ${msg}\n`;
}

export function installFileLogger(): void {
  if (installed) return;
  installed = true;

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  const origInfo = console.info.bind(console);
  const origLog = console.log.bind(console);

  const tee = (level: string, args: unknown[]): void => {
    const s = ensureStream();
    if (!s) return;
    try { s.write(format(level, args)); } catch { /* stream died */ }
  };

  console.error = (...args: unknown[]) => { origError(...args); tee('ERROR', args); };
  console.warn = (...args: unknown[]) => { origWarn(...args); tee('WARN', args); };
  console.info = (...args: unknown[]) => { origInfo(...args); tee('INFO', args); };
  console.log = (...args: unknown[]) => { origLog(...args); tee('LOG', args); };

  // Eagerly create the log file + write a startup line so the file exists
  // even on a completely clean session (no warnings, no errors). Without
  // this, the file only materializes when something logs — and the health
  // script has no way to distinguish "logger not installed" from "nothing
  // interesting happened". The startup line itself is useful telemetry:
  // every launch gets a timestamp.
  const versions = [
    `electron ${process.versions.electron}`,
    `node ${process.versions.node}`,
    `chrome ${process.versions.chrome}`,
  ].join(', ');
  const productVersion = (() => {
    try { return app.getVersion(); } catch { return '?'; }
  })();
  tee('INFO', [`Patton main process started (v${productVersion}, ${versions})`]);
}

export function getLogPath(): string {
  if (logPath) return logPath;
  try {
    return join(app.getPath('userData'), 'logs', 'main.log');
  } catch {
    return '';
  }
}
