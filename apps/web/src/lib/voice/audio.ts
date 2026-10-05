import { IS_IOS } from "#lib/stores/device.ts";
import { storage } from "#lib/util/storage.ts";

/**
 * The one audio element NOVA speaks through, the shared AudioContext and the analyser of its own voice.
 * Phones only allow sound after a touch, so this one element is unlocked by the first touch (unlock.ts)
 * and reused for every spoken answer.
 */

type AudioWithGraph = HTMLAudioElement & {
  _source?: MediaElementAudioSourceNode;
  _gain?: GainNode;
};

let element: AudioWithGraph | null = null;
export function ttsElement(): AudioWithGraph {
  if (!element) {
    element = new Audio();
    element.preload = "auto";
    element.setAttribute("playsinline", "");
  }
  return element;
}

/** The element that is playing (or about to play) NOVA's voice, null when silent. */
export const playback = { current: null as HTMLAudioElement | null };

type AudioContextCtor = typeof AudioContext;
let audioCtx: AudioContext | null = null;
export function audioContext(): AudioContext {
  if (!audioCtx) {
    const Ctor: AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: AudioContextCtor })
        .webkitAudioContext;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

let analyser: AnalyserNode | null = null;
let freq: Uint8Array<ArrayBuffer> | null = null;
/** The spectrum of NOVA's own voice, or null when there is no analyser (iOS, nothing played yet). */
export function voiceSpectrum(): {
  analyser: AnalyserNode;
  freq: Uint8Array<ArrayBuffer>;
} | null {
  return analyser && freq ? { analyser, freq } : null;
}

/** How loud NOVA speaks on this device (0 to 1), kept in this browser. */
export function outputVolume(): number {
  const value = Number(storage.get("novaVolume", "1"));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/** Through the analyser the element's own volume is not reliable everywhere, so a gain node does it there. */
export function applyVolume(audio: HTMLAudioElement): void {
  const volume = outputVolume();
  const gain = (audio as AudioWithGraph)._gain;
  if (gain) {
    audio.volume = 1;
    gain.gain.value = volume;
  } else audio.volume = volume;
}

export async function attachAnalyser(audio: HTMLAudioElement): Promise<void> {
  // iOS routes the whole page's sound through the analyser and often goes silent; the voice animates without it.
  if (IS_IOS) return;
  const tagged = audio as AudioWithGraph;
  try {
    const ctx = audioContext();
    if (ctx.state !== "running") await ctx.resume();
    if (ctx.state !== "running") return;
    if (!analyser) {
      const node = ctx.createAnalyser();
      node.fftSize = 128;
      node.smoothingTimeConstant = 0.75;
      node.connect(ctx.destination);
      analyser = node;
      freq = new Uint8Array(node.frequencyBinCount);
    }
    if (!tagged._source) {
      tagged._source = ctx.createMediaElementSource(audio);
      tagged._gain = ctx.createGain();
      tagged._source.connect(tagged._gain).connect(analyser);
    }
  } catch (error) {
    console.warn("Audio analysis unavailable:", (error as Error).message);
  }
}
