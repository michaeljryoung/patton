/**
 * Synthesizes and plays a short notification sound using the Web Audio API.
 * No external audio files needed. The calm ones (soft, marimba, pop) are
 * sines under 400 ms with a soft attack, a low peak and a 2 kHz low-pass;
 * 'classic' is the two-tone ding that played before the choice existed.
 */
import {
  DEFAULTS,
  NOTIFICATION_SOUND_NAMES,
  NOTIFICATION_VOLUME_MAX,
  notificationVolumeOf,
  resolveNotificationSound,
  type NotificationSoundName,
} from '../../shared/constants';
import type { AppSettings } from '../../shared/types';
import { rlog } from './renderer-logger';

export type SoundType = NotificationSoundName;

/** Where the limiter starts to bend: 0.708 of full scale, -3 dB. */
export const LIMITER_START = 0.7079;
/** The loudest signal the limiter's curve covers: the volume's top, as a gain. */
export const LIMITER_RANGE = NOTIFICATION_VOLUME_MAX / 100;

/**
 * A transparent peak limiter as a WaveShaper curve over [-range, range]
 * (stored as [-1, 1], so the graph scales by 1/range before it and by range
 * after it). Up to `start` the output equals the input, exactly: a sound
 * boosted above 100% but peaking under the knee passes untouched. Above it
 * the output bends smoothly (tanh, same slope at the join) toward 1.0 and
 * never passes it, so a 400% sound is rounded off, not clipped flat. The
 * graph only contains the limiter above 100%, so nothing at 100% or below
 * goes through it. `points` must be odd, so the middle point is exactly 0
 * (silence stays silent); an even count throws.
 * (A DynamicsCompressorNode was not used: Chrome adds an automatic makeup
 * gain to it, which would change today's quiet sounds.)
 */
export function softLimitCurve(points = 8193, range = LIMITER_RANGE, start = LIMITER_START): Float32Array {
  if (!Number.isInteger(points) || points < 3 || points % 2 === 0) {
    throw new RangeError(`softLimitCurve needs an odd point count of 3 or more, got ${points}`);
  }
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = ((i / (points - 1)) * 2 - 1) * range;
    const a = Math.abs(x);
    const y = a <= start ? a : start + (1 - start) * Math.tanh((a - start) / (1 - start));
    curve[i] = (Math.sign(x) * y) / range;
  }
  return curve;
}
const LIMITER_CURVE = softLimitCurve();

export class NotificationSound {
  private type: SoundType = DEFAULTS.NOTIFICATION_SOUND_NAME;
  private volume = DEFAULTS.NOTIFICATION_SOUND_VOLUME / 100;
  private lastPreviewTime = 0;
  private audioCtx: AudioContext | null = null;
  private lastPlayTime = 0;
  private warmupDone = false;
  private warmupHandler: (() => void) | null = null;
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
      this.warmupHandler = null;
    };
    this.warmupHandler = warmup;
    document.addEventListener('click', warmup);
    document.addEventListener('keydown', warmup);
  }

  /** Choose the sound; 'off' plays nothing. An unknown name is ignored. */
  setType(type: string): void {
    if (isSoundName(type)) this.type = type;
  }

  /** Take the sound settings from the saved file (`changed` false: the whole
   *  object, old files resolved to the default) or from a change just made in
   *  Settings (`changed` true: only the fields present; a change is heard once,
   *  nothing when Off). */
  applySettings(settings: Partial<AppSettings>, changed: boolean): void {
    if (!changed) {
      this.setType(resolveNotificationSound(settings));
      this.setVolume(notificationVolumeOf(settings.notificationSoundVolume));
      return;
    }
    if (settings.notificationSoundName === undefined && settings.notificationSoundVolume === undefined) return;
    if (settings.notificationSoundName !== undefined) this.setType(settings.notificationSoundName);
    if (settings.notificationSoundVolume !== undefined) this.setVolume(settings.notificationSoundVolume);
    this.playPreview();
  }

  /** Volume as a percent, 0-NOTIFICATION_VOLUME_MAX. */
  setVolume(percent: number): void {
    if (Number.isFinite(percent)) this.volume = Math.min(NOTIFICATION_VOLUME_MAX, Math.max(0, percent)) / 100;
  }

  getType(): SoundType {
    return this.type;
  }

  isEnabled(): boolean {
    return this.type !== 'off';
  }

  play(reason = 'command-done'): void {
    if (this.type === 'off') return;

    // Cooldown: don't spam the sound
    const now = Date.now();
    if (now - this.lastPlayTime < NotificationSound.COOLDOWN_MS) return;
    this.lastPlayTime = now;
    // The 2 s cooldown above is the log's rate limit.
    rlog('info', '[SOUND] played', { sound: this.type, reason, ...this.levelForLog() });

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

  /** Play the chosen sound now (the Preview button, a change of choice or
   *  volume). Bypasses the 2 s cooldown, not the off choice; a 300 ms guard
   *  keeps a held key from piling sounds up. */
  playPreview(): void {
    if (this.type === 'off') return;
    const now = Date.now();
    if (now - this.lastPreviewTime < 300) return;
    this.lastPreviewTime = now;
    rlog('info', '[SOUND] played', { sound: this.type, reason: 'preview', ...this.levelForLog() });
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

  /** The volume as a whole percent, and whether this play builds the limiter. */
  private levelForLog(): { volume: number; limiter: boolean } {
    return { volume: Math.round(this.volume * 100), limiter: this.volume > 1 };
  }

  private scheduleSound(ctx: AudioContext): void {
    // Everything goes through one master gain (the volume setting) and,
    // for the calm sounds, a 2 kHz low-pass that rounds off any edge.
    // At 100% or below master goes straight to the speakers, exactly as
    // before the volume could be boosted (Bullet already peaks near 1.09 at
    // 100%, so a limiter there would change it). Above 100% a limiter (see
    // softLimitCurve) keeps the boosted sound from clipping:
    // master -> /MAX -> shaper -> xMAX -> speakers.
    const master = ctx.createGain();
    master.gain.setValueAtTime(this.volume, ctx.currentTime);
    const created: AudioNode[] = [master];
    if (this.volume > 1) {
      const post = ctx.createGain();
      post.gain.setValueAtTime(LIMITER_RANGE, ctx.currentTime);
      post.connect(ctx.destination);
      const limiter = ctx.createWaveShaper();
      limiter.curve = LIMITER_CURVE;
      limiter.connect(post);
      const pre = ctx.createGain();
      pre.gain.setValueAtTime(1 / LIMITER_RANGE, ctx.currentTime);
      pre.connect(limiter);
      master.connect(pre);
      created.push(pre, limiter, post);
    } else {
      master.connect(ctx.destination);
    }
    const soft = ctx.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.setValueAtTime(2000, ctx.currentTime);
    soft.connect(master);
    created.push(soft);
    setTimeout(() => { for (const n of created) n.disconnect(); }, 1000);

    switch (this.type) {
      case 'soft':
        // C5 with a quiet octave above; 40 ms swell, ~370 ms fade.
        this.tone(ctx, soft, { freq: 523.25, peak: 0.07, attack: 0.04, dur: 0.37 });
        this.tone(ctx, soft, { freq: 1046.5, peak: 0.015, attack: 0.04, dur: 0.25 });
        break;
      case 'marimba':
        // A3 body plus a short overtone at 4x (what makes a bar "wooden").
        this.tone(ctx, soft, { freq: 220, peak: 0.13, attack: 0.008, dur: 0.38 });
        this.tone(ctx, soft, { freq: 880, peak: 0.03, attack: 0.004, dur: 0.1 });
        break;
      case 'pop':
        // A rounded droplet: pitch glides 300 -> 620 Hz in 80 ms, gone by 200 ms.
        this.tone(ctx, soft, { freq: 300, endFreq: 620, glide: 0.08, peak: 0.1, attack: 0.006, dur: 0.2 });
        break;
      case 'bugle':
        this.scheduleBugle(ctx, master);
        break;
      case 'bullet':
        this.scheduleBullet(ctx, master);
        break;
      case 'classic':
      default:
        this.scheduleChime(ctx, master);
        break;
    }
  }

  /** One sine tone: linear swell to `peak` over `attack`, exponential fade to silence at `dur`. */
  private tone(
    ctx: AudioContext,
    out: AudioNode,
    o: { freq: number; peak: number; attack: number; dur: number; endFreq?: number; glide?: number },
  ): void {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.endFreq !== undefined && o.glide) {
      osc.frequency.exponentialRampToValueAtTime(o.endFreq, t + o.glide);
    }
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(o.peak, t + o.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + o.dur);
    osc.onended = () => { gain.disconnect(); };
  }

  private scheduleChime(ctx: AudioContext, out: AudioNode): void {
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
    gain1.connect(out);
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
    gain2.connect(out);
    osc2.start(t + 0.1);
    osc2.stop(t + 0.5);
    osc2.onended = () => { gain2.disconnect(); };
  }

  /** Short brass-like bugle call — descending triplet with sawtooth wave (military theme). */
  private scheduleBugle(ctx: AudioContext, out: AudioNode): void {
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
      gain.connect(out);
      osc.start(t + note.start);
      osc.stop(t + note.start + note.dur);
      osc.onended = () => { gain.disconnect(); };
    }
  }

  /** Bullet crack — sharp white-noise bang followed by a mid-frequency whoosh tail. */
  private scheduleBullet(ctx: AudioContext, out: AudioNode): void {
    const t = ctx.currentTime;

    // Layer 1: Wider burst of white noise (the "crack") — highpass to cut mud
    const bufferSize = Math.floor(ctx.sampleRate * 0.12); // 120ms of noise
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.5, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    // Highpass filter — keeps the crack punchy on laptop speakers
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(800, t);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(out);
    noise.start(t);
    noise.stop(t + 0.12);
    noise.onended = () => { noiseGain.disconnect(); filter.disconnect(); };

    // Layer 2: Mid-frequency whoosh tail (descending pitch, stays audible on laptop speakers)
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.3);
    oscGain.gain.setValueAtTime(0.2, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc.connect(oscGain);
    oscGain.connect(out);
    osc.start(t);
    osc.stop(t + 0.3);
    osc.onended = () => { oscGain.disconnect(); };

    // Layer 3: Transient click for initial attack presence
    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();
    click.type = 'square';
    click.frequency.setValueAtTime(1200, t);
    clickGain.gain.setValueAtTime(0.3, t);
    clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    click.connect(clickGain);
    clickGain.connect(out);
    click.start(t);
    click.stop(t + 0.02);
    click.onended = () => { clickGain.disconnect(); };
  }

  dispose(): void {
    if (this.warmupHandler) {
      document.removeEventListener('click', this.warmupHandler);
      document.removeEventListener('keydown', this.warmupHandler);
      this.warmupHandler = null;
    }
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }
}

function isSoundName(v: string): v is SoundType {
  return (NOTIFICATION_SOUND_NAMES as readonly string[]).includes(v);
}
