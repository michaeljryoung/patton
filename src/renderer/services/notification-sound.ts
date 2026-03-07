/**
 * Synthesizes and plays a short notification ding using the Web Audio API.
 * No external audio files needed.
 */
export type SoundType = 'chime' | 'bugle' | 'bullet';

export class NotificationSound {
  private enabled = true;
  private type: SoundType = 'chime';
  private audioCtx: AudioContext | null = null;
  private lastPlayTime = 0;
  private warmupDone = false;
  private static readonly COOLDOWN_MS = 2000; // Don't ding more than once per 2s

  constructor() {
    // Pre-warm AudioContext on first user interaction so it's ready
    // when a bell fires later (which is NOT a user gesture).
    const warmup = () => {
      if (this.warmupDone) return;
      this.warmupDone = true;
      try {
        if (!this.audioCtx) {
          this.audioCtx = new AudioContext();
        }
        if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(() => {});
        }
      } catch { /* Audio not available */ }
      document.removeEventListener('click', warmup);
      document.removeEventListener('keydown', warmup);
    };
    document.addEventListener('click', warmup);
    document.addEventListener('keydown', warmup);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setType(type: string): void {
    if (type === 'chime' || type === 'bugle' || type === 'bullet') {
      this.type = type;
    }
  }

  getType(): SoundType {
    return this.type;
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

      // If still suspended, try to resume (will work with autoplayPolicy set)
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => this.scheduleSound(ctx)).catch(() => {});
      } else {
        this.scheduleSound(ctx);
      }
    } catch {
      // Audio not available — silently skip
    }
  }

  /** Play a preview of the current sound type (bypasses cooldown). */
  playPreview(): void {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new AudioContext();
      }
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => this.scheduleSound(ctx)).catch(() => {});
      } else {
        this.scheduleSound(ctx);
      }
    } catch { /* Audio not available */ }
  }

  private scheduleSound(ctx: AudioContext): void {
    switch (this.type) {
      case 'bugle':
        this.scheduleBugle(ctx);
        break;
      case 'bullet':
        this.scheduleBullet(ctx);
        break;
      case 'chime':
      default:
        this.scheduleChime(ctx);
        break;
    }
  }

  private scheduleChime(ctx: AudioContext): void {
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
  }

  /** Short brass-like bugle call — descending triplet with sawtooth wave (military theme). */
  private scheduleBugle(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const notes = [
      { freq: 784, start: 0, dur: 0.12 },     // G5
      { freq: 659.25, start: 0.13, dur: 0.12 }, // E5
      { freq: 523.25, start: 0.26, dur: 0.2 },  // C5 (held longer)
    ];
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(note.freq, t + note.start);
      gain.gain.setValueAtTime(0.1, t + note.start);
      gain.gain.exponentialRampToValueAtTime(0.001, t + note.start + note.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t + note.start);
      osc.stop(t + note.start + note.dur);
      osc.onended = () => { gain.disconnect(); };
    }
  }

  /** Bullet crack — sharp white-noise bang followed by a low-frequency whoosh tail. */
  private scheduleBullet(ctx: AudioContext): void {
    const t = ctx.currentTime;

    // Layer 1: Short burst of white noise (the "crack")
    const bufferSize = ctx.sampleRate * 0.08; // 80ms of noise
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.25, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    // Bandpass filter to shape the crack
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(3000, t);
    filter.Q.setValueAtTime(0.8, t);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.start(t);
    noise.stop(t + 0.08);
    noise.onended = () => { noiseGain.disconnect(); filter.disconnect(); };

    // Layer 2: Low-frequency whoosh tail (descending pitch)
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(200, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    oscGain.gain.setValueAtTime(0.12, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.25);
    osc.onended = () => { oscGain.disconnect(); };
  }

  dispose(): void {
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }
}
