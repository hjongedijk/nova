import { audioLevel } from "#lib/stores/audio-level.svelte.ts";
import { voiceSpectrum } from "./audio.ts";

/** The speech player owns this meter; changing or hiding an avatar cannot stop it. */
export function startVoiceMeter(audio: HTMLAudioElement): () => void {
  let frame = 0;
  let stopped = false;
  let previous = 0;
  function draw(now: number) {
    if (stopped) return;
    const speaking = !audio.paused && !audio.ended;
    const spectrum = voiceSpectrum();
    let level = 0;
    if (speaking && spectrum) {
      spectrum.analyser.getByteFrequencyData(spectrum.freq);
      for (const value of spectrum.freq) level += value;
      level /= spectrum.freq.length * 255;
    } else if (speaking) {
      // iOS deliberately bypasses Web Audio. This is an activity fallback, not phoneme timing.
      level = 0.28 + 0.18 * Math.sin(now * 0.009) * Math.sin(now * 0.0031);
    }
    const delta = previous ? Math.min(100, now - previous) : 16;
    previous = now;
    audioLevel.level +=
      (level - audioLevel.level) * (1 - Math.exp(-delta / 55));
    audioLevel.speaking = speaking;
    audioLevel.bands = speaking && spectrum ? spectrum.freq : null;
    frame = requestAnimationFrame(draw);
  }
  frame = requestAnimationFrame(draw);
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    audioLevel.level = 0;
    audioLevel.speaking = false;
    audioLevel.bands = null;
  };
}
