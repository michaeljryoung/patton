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
      this.setMode('passthrough');
      return;
    }

    // Secondary: recent TUI escape sequences (cursor hide, mouse enable) within last 2s
    if (Date.now() - this.lastTuiSignal < 2000) {
      this.setMode('passthrough');
      return;
    }

    // Tertiary: check foreground process name
    if (this.getProcessName) {
      try {
        const raw = await this.getProcessName();
        // Normalize: strip path and leading dash (login shells)
        const baseName = raw.replace(/^-/, '').split('/').pop() || '';

        if (baseName) {
          // Learn the shell name from the first successful poll
          if (!this.shellName) {
            this.shellName = baseName;
          }

          // If foreground process differs from shell, an interactive program is running
          if (baseName !== this.shellName) {
            this.setMode('passthrough');
            return;
          }
        }
      } catch {
        // Process query failed, fall through to default
      }
    }

    this.setMode('editor');
  }

  /** Check PTY output for TUI escape sequences (cursor hide, mouse enable, etc.) */
  checkData(data: string): void {
    if (this.disposed) return;
    if (this.manualOverride) return;

    // TUI-enter signals: cursor hide, mouse tracking enable
    const enterSignals = ['\x1b[?25l', '\x1b[?1000h', '\x1b[?1002h', '\x1b[?1003h'];
    // TUI-exit signals: cursor show, mouse tracking disable
    const exitSignals = ['\x1b[?25h', '\x1b[?1000l', '\x1b[?1002l', '\x1b[?1003l'];

    let lastEnterIdx = -1;
    let lastExitIdx = -1;

    for (const sig of enterSignals) {
      const idx = data.lastIndexOf(sig);
      if (idx > lastEnterIdx) lastEnterIdx = idx;
    }
    for (const sig of exitSignals) {
      const idx = data.lastIndexOf(sig);
      if (idx > lastExitIdx) lastExitIdx = idx;
    }

    const hasEnter = lastEnterIdx !== -1;
    const hasExit = lastExitIdx !== -1;

    if (hasEnter && hasExit) {
      // Both present — whichever comes last wins
      if (lastExitIdx > lastEnterIdx) {
        this.lastTuiSignal = 0;
      } else {
        this.lastTuiSignal = Date.now();
        if (this.mode !== 'passthrough') {
          this.setMode('passthrough');
        }
      }
    } else if (hasEnter) {
      this.lastTuiSignal = Date.now();
      if (this.mode !== 'passthrough') {
        this.setMode('passthrough');
      }
    } else if (hasExit) {
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
