/**
 * Synthesizes and plays a short notification ding using the Web Audio API.
 * No external audio files needed.
 */
export class NotificationSound {
  private enabled = true;
  private audioCtx: AudioContext | null = null;
  private lastPlayTime = 0;
  private static readonly COOLDOWN_MS = 2000; // Don't ding more than once per 2s

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  play(): void {
    if (!this.enabled) return;

    // Cooldown: don't spam the sound
    const now = Date.now();
    if (now - this.lastPlayTime < NotificationSound.COOLDOWN_MS) return;
    this.lastPlayTime = now;

    try {
      if (!this.audioCtx) {
        this.audioCtx = new AudioContext();
      }

      const ctx = this.audioCtx;

      // Two-tone ding: a pleasant notification chime
      const t = ctx.currentTime;

      // First tone (higher)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(880, t); // A5
      gain1.gain.setValueAtTime(0.15, t);
      gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(t);
      osc1.stop(t + 0.3);
      osc1.onended = () => { gain1.disconnect(); };

      // Second tone (slightly higher, delayed)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(1174.66, t + 0.1); // D6
      gain2.gain.setValueAtTime(0, t);
      gain2.gain.setValueAtTime(0.12, t + 0.1);
      gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(t + 0.1);
      osc2.stop(t + 0.5);
      osc2.onended = () => { gain2.disconnect(); };
    } catch {
      // Audio not available — silently skip
    }
  }

  dispose(): void {
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }
}
