import { audioContext, outputVolume } from "./audio.ts";

/** A short two-note chime (or one low note): NOVA heard you. */
export function chime(high = true): void {
  try {
    const ctx = audioContext();
    const now = ctx.currentTime;
    const notes: [number, number][] = high
      ? [
          [0, 660],
          [0.11, 990],
        ]
      : [[0, 440]];
    for (const [offset, hz] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.0002, 0.12 * outputVolume()),
        now + offset + 0.02,
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.18);
    }
  } catch {
    /* no audio: the screen still shows it is listening */
  }
}
