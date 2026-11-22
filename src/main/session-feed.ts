/**
 * The session bar's feed, per pane (docs/session-bar.md D8, D9): finds the
 * Claude session in a pty (session-link.ts), follows its transcript
 * (transcript-tail.ts), parses it (transcript-parser.ts) and sends the
 * events to the pane's window. No Electron import: ipc-handlers wires the
 * IPC and hands in `send`, so the checks drive this file under plain Node.
 *
 * Life of one watch:
 * - unresolved: a resolve now, then every 10 s. A sessions-file match with a
 *   transcript attaches (`how: 'sessions-file'`); failing that, the renderer's
 *   hint (the Stop hook's `tp`) attaches if it passes the same path checks
 *   (`how: 'hook'`), and the 10 s resolve keeps trying to replace it.
 * - attached by the sessions file: once a second, the Claude pid must still be
 *   alive and its sessions file must still name the same `sessionId`; on a
 *   change (`/clear`, resume) it detaches and resolves again at once.
 * - UNWATCH, pty exit and window close stop everything (timers, watcher).
 */
import { promises as fsp } from 'node:fs';
import type { SessionFeedEvent } from '../shared/session-feed';
import { TranscriptParser } from './transcript-parser';
import { TranscriptTail } from './transcript-tail';
import {
  checkTranscriptPath, claudeHome, listProcesses, readSessionsFile, resolveSession,
  transcriptInCwdFolder, type ProcRow,
} from './session-link';

export interface SessionFeedDeps {
  /** The shell pid of a live pty, or null. */
  shellPid: (ptyId: number) => number | null;
  /** Deliver to the pty's window; false when that window is gone. */
  send: (ptyId: number, event: SessionFeedEvent) => boolean;
  /** `~/.claude`, read from HOME on every resolve. */
  claudeHome?: () => string;
  /** `$HOME` for the Downloads links. */
  home?: () => string;
  ps?: () => Promise<ProcRow[]>;
  log?: (msg: string, data: Record<string, unknown>) => void;
  /** How often to retry while unresolved (ms). */
  resolveEveryMs?: number;
  /** How often to check the attached session (ms). */
  checkEveryMs?: number;
}

interface Attached {
  how: 'sessions-file' | 'hook';
  sessionId: string;
  transcriptPath: string;
  claudePid: number | null;
  sessionsFile: string | null;
  sessionsMtime: number;
  tail: TranscriptTail;
}

interface Watch {
  ptyId: number;
  shellPid: number;
  hint: string | null;
  attached: Attached | null;
  /** A session found whose transcript isn't written yet (new, or after /clear). */
  pending: { sessionId: string; cwd: string } | null;
  resolving: boolean;
  stopped: boolean;
  lastResolve: number;
  checking: boolean;
  timer: ReturnType<typeof setInterval>;
  lastError: string;
}

export class SessionFeed {
  private watches = new Map<number, Watch>();
  private readonly resolveEveryMs: number;
  private readonly checkEveryMs: number;
  private readonly log: (msg: string, data: Record<string, unknown>) => void;

  constructor(private readonly deps: SessionFeedDeps) {
    this.resolveEveryMs = deps.resolveEveryMs ?? 10_000;
    this.checkEveryMs = deps.checkEveryMs ?? 1000;
    this.log = deps.log ?? ((msg, data) => console.info(msg, data));
  }

  private claudeHome(): string {
    return this.deps.claudeHome ? this.deps.claudeHome() : claudeHome();
  }

  private home(): string {
    return this.deps.home ? this.deps.home() : (process.env.HOME || '');
  }

  isWatching(ptyId: number): boolean {
    return this.watches.has(ptyId);
  }

  /** Start (or refresh) following the pty's session. False for no such pty. */
  watch(ptyId: number, hint?: string): boolean {
    const shellPid = this.deps.shellPid(ptyId);
    if (shellPid === null) return false;
    let w = this.watches.get(ptyId);
    if (!w) {
      w = {
        ptyId, shellPid, hint: null, attached: null, pending: null, resolving: false, stopped: false,
        lastResolve: 0, checking: false, lastError: '',
        timer: setInterval(() => this.tick(ptyId), this.checkEveryMs),
      };
      this.watches.set(ptyId, w);
    }
    if (typeof hint === 'string') w.hint = hint;
    if (!w.attached || w.attached.how === 'hook') void this.resolve(w);
    return true;
  }

  unwatch(ptyId: number, reason: string): void {
    const w = this.watches.get(ptyId);
    if (!w) return;
    w.stopped = true;
    clearInterval(w.timer);
    this.watches.delete(ptyId);
    this.detach(w, reason, w.attached !== null && reason !== 'window closed');
  }

  stopAll(reason: string): void {
    for (const id of [...this.watches.keys()]) this.unwatch(id, reason);
  }

  private emit(w: Watch, event: SessionFeedEvent): void {
    if (w.stopped && event.type !== 'detached') return;
    if (!this.deps.send(w.ptyId, event) && !w.stopped) this.unwatch(w.ptyId, 'window closed');
  }

  private tick(ptyId: number): void {
    const w = this.watches.get(ptyId);
    if (!w || w.stopped) return;
    const now = Date.now();
    if ((!w.attached || w.attached.how === 'hook') && now - w.lastResolve >= this.resolveEveryMs) {
      void this.resolve(w);
    }
    else if (!w.attached && w.pending) void this.probePending(w);
    if (w.attached?.how === 'sessions-file') void this.checkSession(w);
  }

  /** Once a second while a found session has no transcript: one stat of
   *  where it will appear, and a full resolve the moment it does. */
  private async probePending(w: Watch): Promise<void> {
    const p = w.pending;
    if (!p || w.resolving) return;
    const path = await transcriptInCwdFolder(this.claudeHome(), p.sessionId, p.cwd);
    if (path && !w.stopped && !w.attached && w.pending === p) void this.resolve(w);
  }

  private async resolve(w: Watch): Promise<void> {
    if (w.resolving || w.stopped) return;
    w.resolving = true;
    w.lastResolve = Date.now();
    try {
      const home = this.claudeHome();
      const found = await resolveSession(w.shellPid, home, this.deps.ps ?? listProcesses);
      if (w.stopped) return;
      w.pending = found && !found.transcriptPath ? { sessionId: found.sessionId, cwd: found.cwd } : null;
      if (found && found.transcriptPath) {
        if (w.attached?.transcriptPath === found.transcriptPath) {
          // The hook's path was right: keep the tail, follow the sessions file.
          w.attached.how = 'sessions-file';
          w.attached.claudePid = found.claudePid;
          w.attached.sessionsFile = found.sessionsFile;
          w.attached.sessionsMtime = await mtimeOf(found.sessionsFile);
          return;
        }
        if (w.attached) this.detach(w, 'session changed', true);
        await this.attach(w, {
          how: 'sessions-file', sessionId: found.sessionId, transcriptPath: found.transcriptPath,
          claudePid: found.claudePid, sessionsFile: found.sessionsFile,
        });
        return;
      }
      // A sessions file that names a session not yet written outranks the hint
      // (after /clear the last Stop's `tp` is the old session's).
      if (!found && !w.attached && w.hint) {
        const checked = await checkTranscriptPath(home, w.hint);
        if (w.stopped || w.attached) return;
        if (checked) {
          await this.attach(w, {
            how: 'hook', sessionId: checked.sessionId, transcriptPath: checked.path,
            claudePid: null, sessionsFile: null,
          });
        } else {
          this.feedError(w, 'hint refused');
          w.hint = null;
        }
      }
    } catch {
      this.feedError(w, 'resolve failed');
    } finally {
      w.resolving = false;
    }
  }

  private async attach(
    w: Watch,
    a: Omit<Attached, 'tail' | 'sessionsMtime'>,
  ): Promise<void> {
    const parser = new TranscriptParser({ home: this.home() });
    const tail = new TranscriptTail(a.transcriptPath, {
      onText: (text) => {
        if (w.stopped || w.attached?.tail !== tail) return;
        for (const ev of parser.push(text)) this.emit(w, ev);
      },
      onError: (why) => {
        if (w.stopped || w.attached?.tail !== tail) return;
        if (why === 'transcript gone') {
          this.detach(w, why, true);
          void this.resolve(w);
        } else {
          this.feedError(w, why);
        }
      },
    });
    w.attached = { ...a, tail, sessionsMtime: a.sessionsFile ? await mtimeOf(a.sessionsFile) : 0 };
    if (w.stopped) { tail.stop(); w.attached = null; return; }
    this.log('[BAR] attach', { pty: w.ptyId, how: a.how });
    this.emit(w, { type: 'attached', sessionId: a.sessionId, how: a.how });
    await tail.start();
  }

  private detach(w: Watch, reason: string, tell: boolean): void {
    const a = w.attached;
    if (!a) return;
    a.tail.stop();
    w.attached = null;
    this.log('[BAR] detach', { pty: w.ptyId, reason });
    if (tell) this.deps.send(w.ptyId, { type: 'detached', reason });
  }

  private feedError(w: Watch, why: string): void {
    if (w.lastError === why) return; // once per kind in a row
    w.lastError = why;
    this.log('[BAR] feed error', { pty: w.ptyId, why });
    this.emit(w, { type: 'error', why });
  }

  /** The attached Claude still runs and its sessions file names the same session. */
  private async checkSession(w: Watch): Promise<void> {
    const a = w.attached;
    if (!a || a.how !== 'sessions-file' || !a.sessionsFile || a.claudePid === null || w.checking) return;
    w.checking = true;
    try {
      if (!isAlive(a.claudePid)) {
        this.detach(w, 'claude exited', true);
        w.lastResolve = 0;
        return;
      }
      const mtime = await mtimeOf(a.sessionsFile);
      if (w.attached !== a) return;
      if (mtime === 0) {
        this.detach(w, 'claude exited', true);
        w.lastResolve = 0;
        return;
      }
      if (mtime === a.sessionsMtime) return;
      a.sessionsMtime = mtime;
      const now = await readSessionsFile(this.claudeHome(), a.claudePid);
      if (w.attached !== a) return;
      if (!now || now.sessionId !== a.sessionId) {
        this.detach(w, 'session changed', true);
        w.lastResolve = 0;
        void this.resolve(w);
      }
    } finally {
      w.checking = false;
    }
  }
}

async function mtimeOf(path: string): Promise<number> {
  try {
    return (await fsp.stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
