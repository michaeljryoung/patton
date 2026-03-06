import { DEFAULTS } from '../../shared/constants';
import type { InputMode } from '../../shared/types';

type ModeChangeCallback = (mode: InputMode) => void;

export class ModeDetector {
  private mode: InputMode = 'editor';
  private manualOverride: InputMode | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isAlternateBuffer: () => boolean;
  private getProcessName: (() => Promise<string>) | null = null;
  private shellName: string | null = null;
  private listeners: ModeChangeCallback[] = [];
  private disposed = false;
  private lastTuiSignal = 0;
  private polling = false;
  // Hysteresis: require multiple consecutive editor-polls before leaving passthrough.
  // Prevents flapping when programs like Claude Code briefly spawn shell subprocesses.
  private static readonly EDITOR_POLL_THRESHOLD = 3;
  private consecutiveEditorPolls = 0;

  constructor(
    isAlternateBuffer: () => boolean,
    getProcessName?: () => Promise<string>,
  ) {
    this.isAlternateBuffer = isAlternateBuffer;
    this.getProcessName = getProcessName || null;
    this.startPolling();
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      if (this.disposed || this.manualOverride || this.polling) return;
      this.polling = true;
      try {
        await this.detect();
      } finally {
        this.polling = false;
      }
    }, DEFAULTS.PROCESS_POLL_MS);
  }

  async detect(): Promise<void> {
    if (this.disposed) return;
    if (this.manualOverride) return;

    // Primary: check alternate buffer
    const isAlt = this.isAlternateBuffer();
    if (isAlt) {
      this.consecutiveEditorPolls = 0;
      this.setMode('passthrough');
      return;
    }

    // Secondary: recent TUI escape sequences (cursor hide, mouse enable) within last 2s
    if (Date.now() - this.lastTuiSignal < 2000) {
      this.consecutiveEditorPolls = 0;
      this.setMode('passthrough');
      return;
    }

    // Tertiary: check foreground process name
    if (this.getProcessName) {
      try {
        const raw = await this.getProcessName();

        // '__unknown__' means node-pty can't identify the foreground process
        // (happens with fzf, some child processes). If we already know the shell,
        // this means a different process took over — switch to passthrough.
        if (raw === '__unknown__' && this.shellName) {
          this.consecutiveEditorPolls = 0;
          this.setMode('passthrough');
          return;
        }

        // Normalize: strip path and leading dash (login shells)
        const baseName = raw.replace(/^-/, '').split('/').pop() || '';

        if (baseName) {
          // Learn the shell name from the first successful poll
          if (!this.shellName) {
            this.shellName = baseName;
          }

          // If foreground process differs from shell, an interactive program is running
          if (baseName !== this.shellName) {
            this.consecutiveEditorPolls = 0;
            this.setMode('passthrough');
            return;
          }
        }
      } catch {
        // Process query failed, fall through to default
      }
    }

    // Hysteresis: when in passthrough, require multiple consecutive polls
    // showing the shell before switching back to editor. This prevents
    // flapping when programs like Claude Code briefly spawn subprocesses
    // that look like the shell.
    if (this.mode === 'passthrough') {
      this.consecutiveEditorPolls++;
      if (this.consecutiveEditorPolls < ModeDetector.EDITOR_POLL_THRESHOLD) {
        return; // Stay in passthrough until threshold reached
      }
    }

    this.consecutiveEditorPolls = 0;
    this.setMode('editor');
  }

  /** Check PTY output for TUI escape sequences (cursor hide, mouse enable, etc.) */
  checkData(data: string): void {
    if (this.disposed) return;
    if (this.manualOverride) return;

    // Track each signal pair independently — cursor show should NOT
    // override mouse enable since they are different features.
    // e.g. fzf --height sends mouse enable then cursor show in the same chunk.
    const signalPairs = [
      { enter: '\x1b[?25l', exit: '\x1b[?25h' },   // cursor hide/show
      { enter: '\x1b[?1000h', exit: '\x1b[?1000l' }, // basic mouse tracking
      { enter: '\x1b[?1002h', exit: '\x1b[?1002l' }, // button-event mouse
      { enter: '\x1b[?1003h', exit: '\x1b[?1003l' }, // any-event mouse
    ];

    let anyPairEntered = false;
    let anyExitSeen = false;

    for (const { enter, exit } of signalPairs) {
      const lastEnter = data.lastIndexOf(enter);
      const lastExit = data.lastIndexOf(exit);

      // This pair is "entered" if its enter signal comes after its exit (or no exit)
      if (lastEnter !== -1 && lastEnter > lastExit) {
        anyPairEntered = true;
      }
      if (lastExit !== -1 && lastExit > lastEnter) {
        anyExitSeen = true;
      }
    }

    if (anyPairEntered) {
      this.lastTuiSignal = Date.now();
      if (this.mode !== 'passthrough') {
        this.setMode('passthrough');
      }
    } else if (anyExitSeen) {
      this.lastTuiSignal = 0;
    }
  }

  checkBuffer(): void {
    if (this.disposed) return;
    if (this.manualOverride) return;
    const isAlt = this.isAlternateBuffer();
    if (isAlt && this.mode !== 'passthrough') {
      this.setMode('passthrough');
    } else if (!isAlt && this.mode !== 'editor') {
      // Defer to polling for non-alt check (process may still be interactive)
    }
  }

  toggle(): void {
    if (this.disposed) return;
    if (this.manualOverride) {
      // Clear override
      this.manualOverride = null;
      this.detect();
    } else {
      const newMode = this.mode === 'editor' ? 'passthrough' : 'editor';
      this.manualOverride = newMode;
      this.setMode(newMode);
    }
  }

  private setMode(mode: InputMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    for (const cb of this.listeners) {
      cb(mode);
    }
  }

  onModeChange(callback: ModeChangeCallback): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  getMode(): InputMode {
    return this.mode;
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.listeners = [];
  }
}
