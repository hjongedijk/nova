import { afterEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  level: { level: 0, speaking: false, bands: null as Uint8Array | null },
  spectrum: null as null | {
    analyser: { getByteFrequencyData(data: Uint8Array): void };
    freq: Uint8Array;
  },
}));
vi.mock("#lib/stores/audio-level.svelte.ts", () => ({
  audioLevel: fixture.level,
}));
vi.mock("./audio.ts", () => ({ voiceSpectrum: () => fixture.spectrum }));
import { audioLevel } from "#lib/stores/audio-level.svelte.ts";
import { startVoiceMeter } from "./voice-meter.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  fixture.spectrum = null;
});
function rig() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  const audio = { paused: false, ended: false };
  const stop = startVoiceMeter(audio as HTMLAudioElement);
  function tick(now: number) {
    const entry = frames.entries().next().value!;
    frames.delete(entry[0]);
    entry[1](now);
  }
  return { audio, stop, tick, frames };
}
describe("speech-owned voice meter", () => {
  it("updates actual speech energy without an orb and resets on stop", () => {
    fixture.spectrum = {
      analyser: { getByteFrequencyData: (data) => data.fill(128) },
      freq: new Uint8Array(16),
    };
    const r = rig();
    r.tick(16);
    r.tick(64);
    expect(audioLevel.speaking).toBe(true);
    expect(audioLevel.level).toBeGreaterThan(0.2);
    expect(audioLevel.bands).toBe(fixture.spectrum.freq);
    r.stop();
    expect(audioLevel.level).toBe(0);
    expect(audioLevel.speaking).toBe(false);
    expect(audioLevel.bands).toBeNull();
    expect(r.frames.size).toBe(0);
  });
  it("uses activity fallback only while audio plays and handles pause and end", () => {
    const r = rig();
    r.tick(16);
    expect(audioLevel.level).toBeGreaterThan(0);
    r.audio.paused = true;
    r.tick(80);
    expect(audioLevel.speaking).toBe(false);
    r.audio.paused = false;
    r.audio.ended = true;
    r.tick(160);
    expect(audioLevel.speaking).toBe(false);
    r.stop();
  });
});
