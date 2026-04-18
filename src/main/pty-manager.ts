import ptyModule from 'node-pty';
import type { IPty } from 'node-pty';

// Handle CJS/ESM interop for externalized module
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS/ESM interop requires runtime check
const pty = ((ptyModule as any).default || ptyModule) as typeof ptyModule;
import { app, BrowserWindow, nativeTheme } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULTS, IPC } from '../shared/constants';
import type { PtyCreateOptions } from '../shared/types';

// --- Security: Environment variable allowlist ---
// Only these env vars are forwarded to spawned PTYs. Adding an entry is a
// deliberate decision: each additional forwarded var is information the PTY
// can read or act on. Bias toward inclusion only when (a) a common developer
// tool meaningfully breaks without it, and (b) the value is not a secret.
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
  // Added to cover common dev toolchains that silently broke without them:
  'CONDA_PREFIX', 'CONDA_DEFAULT_ENV',
  'VIRTUAL_ENV', 'VIRTUAL_ENV_PROMPT', 'POETRY_HOME', 'PIPX_HOME', 'PIPX_BIN_DIR',
  'KUBECONFIG',
  'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_HOME',
  'DOTNET_ROOT',
  'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
  'GCLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS',
  'NODE_OPTIONS',
  'GH_TOKEN_FILE', 'GIT_CONFIG_GLOBAL',
  'SSH_AGENT_PID',
]);

/** Resolve the resources directory (works in both dev and packaged mode) */
function getResourcesPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources');
  }
  return join(app.getAppPath(), 'resources');
}

function getSafeEnv(shellIntegration = true, isDark?: boolean): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) {
      safe[key] = process.env[key]!;
    }
  }
  safe.TERM = 'xterm-256color';
  safe.COLORTERM = 'truecolor';
  safe.TERM_PROGRAM = 'Patton';

  // Tell CLI apps about the terminal's color scheme so they choose
  // readable text colors. Prefer the renderer's knowledge (accounts for
  // custom themes); fall back to the system appearance.
  const dark = isDark ?? nativeTheme.shouldUseDarkColors;
  safe.COLORFGBG = dark ? '15;0' : '0;15';

  if (shellIntegration) {
    safe.PATTON_SHELL_INTEGRATION = '1';
    safe.PATTON_SHELL_INTEGRATION_DIR = getResourcesPath();
  }
  return safe;
}

// --- Security: Shell path allowlist ---
// Exported so store.ts can validate settings against the same set — otherwise
// the user could save a shell path that passes the store's regex check but
// silently falls back to the default at spawn time.
export const ALLOWED_SHELLS = new Set([
  '/bin/bash', '/bin/zsh', '/bin/sh', '/bin/dash', '/bin/csh', '/bin/tcsh', '/bin/fish',
  '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/sh', '/usr/bin/fish',
  '/usr/local/bin/bash', '/usr/local/bin/zsh', '/usr/local/bin/fish',
  '/opt/homebrew/bin/bash', '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/fish',
]);

// --- Security: CWD path validation ---
const ALLOWED_CWD_PREFIXES = ['/Users', '/home', '/tmp', '/var/folders'];

function validateCwd(cwd: string | undefined): string {
  if (!cwd || typeof cwd !== 'string') return homedir() || '/';
  if (!cwd.startsWith('/')) return homedir() || '/';
  // Reject path traversal
  if (/(?:^|\/)\.\.(?:\/|$)/.test(cwd)) return homedir() || '/';
  // Validate against allowed prefixes (HOME always allowed)
  const home = homedir() || '/Users';
  const allowed = [home, ...ALLOWED_CWD_PREFIXES];
  if (!allowed.some(prefix => cwd.startsWith(prefix))) {
    console.warn('[SECURITY] CWD rejected — outside allowed prefixes', { cwd });
    return home;
  }
  // Verify path exists and is a directory
  try {
    const stat = statSync(cwd);
    if (!stat.isDirectory()) {
      console.warn('[SECURITY] CWD rejected — not a directory', { cwd });
      return home;
    }
  } catch {
    console.warn('[SECURITY] CWD rejected — path does not exist', { cwd });
    return home;
  }
  return cwd;
}

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
  shellIntegrationEnabled = true;

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
    const cwd = validateCwd(opts?.cwd);

    const shellBase = shell.split('/').pop() || '';
    const safeEnv = getSafeEnv(this.shellIntegrationEnabled, opts?.isDark);
    let shellArgs: string[] = ['--login'];

    // Inject shell integration via startup mechanisms (not PTY write) to avoid
    // the terminal driver echoing the source command visibly.
    if (this.shellIntegrationEnabled) {
      const resDir = getResourcesPath();
      if (shellBase === 'zsh') {
        const script = join(resDir, 'shell-integration-zsh.zsh');
        if (existsSync(script)) {
          safeEnv.PATTON_ORIG_ZDOTDIR = process.env.ZDOTDIR || '';
          safeEnv.ZDOTDIR = join(resDir, 'patton-zdotdir');
          safeEnv.PATTON_SHELL_INTEGRATION_SCRIPT = script;
        }
      } else if (shellBase === 'bash') {
        const script = join(resDir, 'shell-integration-bash.sh');
        const initScript = join(resDir, 'patton-bash-init.sh');
        if (existsSync(script) && existsSync(initScript)) {
          shellArgs = ['--rcfile', initScript];
          safeEnv.PATTON_SHELL_INTEGRATION_SCRIPT = script;
        }
      }
    }

    const proc = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: opts?.cols || DEFAULTS.COLS,
      rows: opts?.rows || DEFAULTS.ROWS,
      cwd,
      env: safeEnv,
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
      // Graduated write-coalesce backoff. Under heavy load (`yes`, `cat`
      // large file, npm install spam) the default 4ms timer fires as fast
      // as it can, and each flush is a full IPC roundtrip. Letting the
      // buffer grow a bit between flushes trades a few ms of latency for
      // far fewer IPC messages — the user doesn't notice 16-32ms extra on
      // a torrent of output but does notice a choppy frame rate.
      const len = instance.buffer.length;
      let delay: number;
      if (len > 1024 * 1024) {
        // Hard cap: flush now to bound heap.
        delay = 0;
      } else if (len > 256 * 1024) {
        delay = 32;
      } else if (len > 64 * 1024) {
        delay = 16;
      } else {
        delay = DEFAULTS.WRITE_COALESCE_MS;
      }

      // If the buffer has crossed into a larger-delay tier, restart the
      // timer with the new delay. (Don't accidentally delay a pending
      // small-buffer flush that was about to fire.)
      if (delay === 0 && instance.flushTimer) {
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
        }, delay);
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
      const c = this.countByWindow.get(winId) ?? 0;
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
      instance.flushTimer = null;
      // Flush any buffered output to the renderer BEFORE we delete the map
      // entry. Otherwise the renderer misses the final output of the
      // command (error message, exit summary, shell's goodbye) that was
      // sitting in `instance.buffer` waiting for the 4ms coalesce window.
      if (instance.buffer.length > 0 && !instance.window.isDestroyed()) {
        try {
          instance.window.webContents.send(IPC.PTY_DATA, id, instance.buffer);
        } catch {
          // webContents may be gone — ignore
        }
        instance.buffer = '';
      }
      // Clean up map and counter BEFORE kill() — if kill() throws, resources are still freed.
      // Note the delete-to-claim invariant: only the caller that successfully deletes
      // here (or in the onExit handler above) owns final teardown of `instance`.
      this.instances.delete(id);
      const winId = instance.window.id;
      const c = this.countByWindow.get(winId) ?? 0;
      this.countByWindow.set(winId, Math.max(0, c - 1));
      try {
        instance.process.kill();
      } catch {
        // Process already dead or permission error — cleanup already done above
      }
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

  /** Get the current working directory of the PTY's process via lsof */
  getCwd(id: number): Promise<string> {
    const instance = this.instances.get(id);
    if (!instance) return Promise.resolve('');
    try {
      const pid = instance.process.pid;
      return new Promise((resolve) => {
        execFile('lsof', ['-p', String(pid), '-Fn', '-a', '-d', 'cwd'], { timeout: 2000 }, (err, stdout) => {
          if (err || !stdout) { resolve(''); return; }
          // lsof output: lines starting with 'n' contain the path
          const lines = stdout.split('\n');
          for (const line of lines) {
            if (line.startsWith('n/')) {
              const dir = line.slice(1);
              resolve(existsSync(dir) ? dir : '');
              return;
            }
          }
          resolve('');
        });
      });
    } catch {
      return Promise.resolve('');
    }
  }

  destroyByWindow(window: BrowserWindow): void {
    // Collect IDs first to avoid modifying map during iteration
    const idsToDestroy: number[] = [];
    for (const [id, instance] of this.instances) {
      if (instance.window === window) {
        idsToDestroy.push(id);
      }
    }
    for (const id of idsToDestroy) {
      this.destroy(id);
    }
    this.countByWindow.delete(window.id);
  }

  destroyAll(): void {
    const ids = [...this.instances.keys()];
    for (const id of ids) this.destroy(id);
  }
}
