import ptyModule from 'node-pty';
import type { IPty } from 'node-pty';

// Handle CJS/ESM interop for externalized module
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS/ESM interop requires runtime check
const pty = ((ptyModule as any).default || ptyModule) as typeof ptyModule;
import { BrowserWindow } from 'electron';
import { DEFAULTS, IPC } from '../shared/constants';
import type { PtyCreateOptions } from '../shared/types';

// --- Security: Environment variable allowlist ---
const SAFE_ENV_KEYS = new Set([
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE',
  'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'DISPLAY', 'SSH_AUTH_SOCK',
  'EDITOR', 'VISUAL', 'PAGER', 'TERM_PROGRAM',
  // Dev toolchains
  'NVM_DIR', 'NVM_BIN', 'NVM_INC',
  'PYENV_ROOT', 'PYENV_SHELL',
  'VOLTA_HOME',
  'GOPATH', 'GOROOT', 'GOBIN',
  'CARGO_HOME', 'RUSTUP_HOME',
  'JAVA_HOME', 'MAVEN_HOME', 'GRADLE_HOME',
  'RBENV_ROOT', 'GEM_HOME', 'GEM_PATH',
  'BUN_INSTALL', 'DENO_INSTALL',
  'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY',
  'FZF_DEFAULT_COMMAND', 'FZF_DEFAULT_OPTS',
  'DOCKER_HOST',
  'GPG_TTY',
]);

function getSafeEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) {
      safe[key] = process.env[key]!;
    }
  }
  safe.TERM = 'xterm-256color';
  safe.COLORTERM = 'truecolor';
  return safe;
}

// --- Security: Shell path allowlist ---
const ALLOWED_SHELLS = new Set([
  '/bin/bash', '/bin/zsh', '/bin/sh', '/bin/dash', '/bin/csh', '/bin/tcsh', '/bin/fish',
  '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/sh', '/usr/bin/fish',
  '/usr/local/bin/bash', '/usr/local/bin/zsh', '/usr/local/bin/fish',
  '/opt/homebrew/bin/bash', '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/fish',
]);

function validateShell(shell: string): string {
  if (ALLOWED_SHELLS.has(shell)) return shell;
  const fallback = process.env.SHELL || DEFAULTS.SHELL;
  if (ALLOWED_SHELLS.has(fallback)) return fallback;
  return DEFAULTS.SHELL;
}

interface PtyInstance {
  process: IPty;
  buffer: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  window: BrowserWindow;
}

export class PtyManager {
  private static readonly MAX_PTY_PER_WINDOW = 50;
  private instances = new Map<number, PtyInstance>();
  private nextId = 1;
  private countByWindow = new Map<number, number>();

  create(window: BrowserWindow, opts?: PtyCreateOptions): number {
    // --- Security: Rate limit PTY creation ---
    const winId = window.id;
    const current = this.countByWindow.get(winId) || 0;
    if (current >= PtyManager.MAX_PTY_PER_WINDOW) {
      console.warn('[SECURITY] PTY rate limit exceeded (MAX_PTY_PER_WINDOW)', { winId, current });
      throw new Error('Too many terminals open in this window');
    }

    const id = this.nextId++;
    const shell = validateShell(opts?.shell || process.env.SHELL || DEFAULTS.SHELL);
    const cwd = (opts?.cwd && typeof opts.cwd === 'string' && opts.cwd.startsWith('/'))
      ? opts.cwd
      : (process.env.HOME || '/');

    const proc = pty.spawn(shell, ['--login'], {
      name: 'xterm-256color',
      cols: opts?.cols || DEFAULTS.COLS,
      rows: opts?.rows || DEFAULTS.ROWS,
      cwd,
      env: getSafeEnv(),
    });

    const instance: PtyInstance = {
      process: proc,
      buffer: '',
      flushTimer: null,
      window,
    };

    this.instances.set(id, instance);
    this.countByWindow.set(winId, current + 1);

    proc.onData((data: string) => {
      instance.buffer += data;
      // Flush immediately if buffer exceeds 256KB to prevent unbounded memory growth
      const shouldFlushNow = instance.buffer.length > 256 * 1024;
      if (shouldFlushNow && instance.flushTimer) {
        clearTimeout(instance.flushTimer);
        instance.flushTimer = null;
      }
      if (!instance.flushTimer) {
        instance.flushTimer = setTimeout(() => {
          if (instance.buffer.length > 0 && !window.isDestroyed()) {
            window.webContents.send(IPC.PTY_DATA, id, instance.buffer);
            instance.buffer = '';
          }
          instance.flushTimer = null;
        }, shouldFlushNow ? 0 : DEFAULTS.WRITE_COALESCE_MS);
      }
    });

    proc.onExit(({ exitCode }) => {
      const deleted = this.instances.delete(id);
      if (!deleted) return; // already cleaned up by destroy()

      // Flush any remaining buffered data before sending exit
      if (instance.flushTimer) clearTimeout(instance.flushTimer);
      instance.flushTimer = null;
      if (instance.buffer.length > 0 && !window.isDestroyed()) {
        window.webContents.send(IPC.PTY_DATA, id, instance.buffer);
        instance.buffer = '';
      }

      if (!window.isDestroyed()) {
        window.webContents.send(IPC.PTY_EXIT, id, exitCode);
      }
      const c = this.countByWindow.get(winId) ?? 1;
      this.countByWindow.set(winId, Math.max(0, c - 1));
    });

    return id;
  }

  // --- Security: Ownership validation ---
  validateOwnership(id: number, window: BrowserWindow): boolean {
    const instance = this.instances.get(id);
    return !!instance && instance.window === window;
  }

  write(id: number, data: string): void {
    const instance = this.instances.get(id);
    if (instance) {
      instance.process.write(data);
    }
  }

  resize(id: number, cols: number, rows: number): void {
    const instance = this.instances.get(id);
    if (instance) {
      instance.process.resize(
        Math.max(1, Math.min(cols, 500)),
        Math.max(1, Math.min(rows, 200)),
      );
    }
  }

  destroy(id: number): void {
    const instance = this.instances.get(id);
    if (instance) {
      if (instance.flushTimer) clearTimeout(instance.flushTimer);
      instance.process.kill();
      this.instances.delete(id);
      // Fix counter leak: decrement when explicitly destroyed
      const winId = instance.window.id;
      const c = this.countByWindow.get(winId) || 1;
      this.countByWindow.set(winId, Math.max(0, c - 1));
    }
  }

  getProcessName(id: number): string {
    const instance = this.instances.get(id);
    if (!instance) return '';
    try {
      // node-pty's process property isn't in the IPty type but exists at runtime
      const name = (instance.process as unknown as { process: string | undefined }).process;
      // node-pty returns undefined when it can't identify the foreground process
      // (e.g. fzf, some child processes). Signal this distinctly from "no PTY".
      if (name === undefined) return '__unknown__';
      return name || '';
    } catch {
      return '';
    }
  }

  /** Scan descendant processes (children + grandchildren) for interactive program names */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- API compatibility
  getDescendantNames(id: number): string[] {
    // Mode detection uses foreground process polling instead
    return [];
  }

  destroyByWindow(window: BrowserWindow): void {
    for (const [id, instance] of this.instances) {
      if (instance.window === window) {
        this.destroy(id);
      }
    }
    this.countByWindow.delete(window.id);
  }

  destroyAll(): void {
    const ids = [...this.instances.keys()];
    for (const id of ids) this.destroy(id);
  }
}
