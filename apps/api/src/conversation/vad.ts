import { rms, STT_RATE } from "./audio.js";

export interface SegmenterOptions {
  frameMs: number;
  /** Absolute floor for "this is speech", in PCM RMS units. */
  minSpeechRms: number;
  /** Speech must exceed the tracked noise floor by this factor. */
  noiseFactor: number;
  /** Consecutive voiced frames that start an utterance. */
  startFrames: number;
  /** Consecutive voiced frames needed to interrupt NOVA while she speaks (echo protection). */
  bargeInFrames: number;
  /** Silence that ends an utterance. */
  endSilenceMs: number;
  /** Audio kept from before the detected start so the first word is not clipped. */
  preRollMs: number;
  /** Shorter voiced stretches are noise (a cough, a click) and are dropped. */
  minVoicedMs: number;
  maxUtteranceMs: number;
}

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  frameMs: 20,
  minSpeechRms: 450,
  noiseFactor: 3,
  startFrames: 4,
  bargeInFrames: 15,
  endSilenceMs: 800,
  preRollMs: 300,
  minVoicedMs: 240,
  maxUtteranceMs: 25_000,
};

export interface SegmenterEvents {
  /** The caller started talking (after startFrames). `whileSpeaking` frames needed bargeInFrames. */
  onSpeechStart(): void;
  onUtterance(samples: Int16Array, voicedMs: number): void;
}

/**
 * Energy based voice-activity detection that cuts a continuous 16 kHz stream into utterances.
 * Deterministic: time is counted in frames, so tests need no clock. While `suppress` is set (NOVA is
 * speaking) a longer burst of speech is required before it counts, which keeps NOVA's own voice
 * leaking back through the line from interrupting her.
 */
export class UtteranceSegmenter {
  private readonly frame: number;
  private pending = new Int16Array(0);
  private readonly preRoll: Int16Array[] = [];
  private utterance: Int16Array[] = [];
  private inSpeech = false;
  private voicedRun = 0;
  private silentFrames = 0;
  private voicedFrames = 0;
  private total = 0;
  private noise = 150;
  /** Raised by the session while NOVA talks. */
  suppress = false;

  constructor(
    private readonly events: SegmenterEvents,
    private readonly options: SegmenterOptions = DEFAULT_SEGMENTER,
    rate = STT_RATE,
  ) {
    this.frame = Math.round((rate * options.frameMs) / 1000);
  }

  get speaking(): boolean {
    return this.inSpeech;
  }

  /** Forget an unfinished utterance (the call state changed). */
  reset(): void {
    this.pending = new Int16Array(0);
    this.preRoll.length = 0;
    this.utterance = [];
    this.inSpeech = false;
    this.voicedRun = 0;
    this.silentFrames = 0;
    this.voicedFrames = 0;
  }

  push(samples: Int16Array): void {
    let data = samples;
    if (this.pending.length) {
      data = new Int16Array(this.pending.length + samples.length);
      data.set(this.pending);
      data.set(samples, this.pending.length);
    }
    let offset = 0;
    while (data.length - offset >= this.frame) {
      this.process(data.subarray(offset, offset + this.frame));
      offset += this.frame;
    }
    this.pending = data.slice(offset);
  }

  private process(frame: Int16Array): void {
    const o = this.options;
    const level = rms(frame);
    const threshold = Math.max(o.minSpeechRms, this.noise * o.noiseFactor);
    const voiced = level >= threshold;
    this.total++;
    if (!voiced && !this.inSpeech)
      this.noise = Math.min(1500, this.noise * 0.95 + level * 0.05);
    const copy = frame.slice();

    if (!this.inSpeech) {
      this.preRoll.push(copy);
      const keep = Math.ceil(o.preRollMs / o.frameMs);
      while (this.preRoll.length > keep) this.preRoll.shift();
      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      const needed = this.suppress ? o.bargeInFrames : o.startFrames;
      if (this.voicedRun >= needed) {
        this.inSpeech = true;
        this.utterance = [...this.preRoll];
        this.preRoll.length = 0;
        this.silentFrames = 0;
        this.voicedFrames = this.voicedRun;
        this.events.onSpeechStart();
      }
      return;
    }

    this.utterance.push(copy);
    if (voiced) {
      this.voicedFrames++;
      this.silentFrames = 0;
    } else this.silentFrames++;
    const length = this.utterance.length * o.frameMs;
    if (
      this.silentFrames * o.frameMs >= o.endSilenceMs ||
      length >= o.maxUtteranceMs
    )
      this.finish();
  }

  private finish(): void {
    const o = this.options;
    const frames = this.utterance;
    const voicedMs = this.voicedFrames * o.frameMs;
    // Drop most of the trailing silence, keep a little so the last word ends naturally.
    const trim = Math.max(0, this.silentFrames - Math.ceil(200 / o.frameMs));
    const kept = frames.slice(0, frames.length - trim);
    this.inSpeech = false;
    this.voicedRun = 0;
    this.silentFrames = 0;
    this.voicedFrames = 0;
    this.utterance = [];
    if (voicedMs < o.minVoicedMs) return;
    const out = new Int16Array(kept.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of kept) {
      out.set(f, at);
      at += f.length;
    }
    this.events.onUtterance(out, voicedMs);
  }
}
