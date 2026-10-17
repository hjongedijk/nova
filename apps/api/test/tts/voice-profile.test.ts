import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TtsService } from "../../src/tts/tts.service.js";
import { VoiceProfileStore } from "../../src/tts/voice-profile.store.js";

const dirs: string[] = [];
const store = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-voice-"));
  dirs.push(dir);
  return {
    dir,
    store: new VoiceProfileStore({
      dataFile: (name: string) => path.join(dir, name),
    } as never),
  };
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("VoiceProfileStore", () => {
  it("defaults to the server voice with the standard prosody", () => {
    expect(store().store.get()).toEqual({ rate: -3, pitch: -2 });
  });
  it("saves a valid voice, clamps prosody and writes the file privately", () => {
    const { dir, store: s } = store();
    expect(
      s.set({ voice: "nl-NL-ColetteNeural", rate: 99, pitch: -99 }),
    ).toEqual({ voice: "nl-NL-ColetteNeural", rate: 10, pitch: -5 });
    expect(fs.statSync(path.join(dir, "voice-profile.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(s.get().voice).toBe("nl-NL-ColetteNeural");
  });
  it("drops an invalid voice id instead of storing it", () => {
    expect(store().store.set({ voice: "../../etc/passwd", rate: 1 })).toEqual({
      rate: 1,
      pitch: -2,
    });
  });
});

describe("TtsService.speakProfile", () => {
  it("speaks with the saved voice and prosody, and Piper only when asked", async () => {
    const { store: s } = store();
    s.set({ voice: "nl-NL-ColetteNeural", rate: 4, pitch: 1 });
    const service = new TtsService(s);
    const calls: unknown[][] = [];
    service.speak = (async (...args: unknown[]) => {
      calls.push(args);
      return {
        audio: Buffer.alloc(0),
        cached: false,
        contentType: "audio/mpeg",
      };
    }) as never;
    await service.speakProfile("Hallo");
    expect(calls[0]).toEqual([
      "Hallo",
      "nl-NL-ColetteNeural",
      { rate: 4, pitch: 1 },
    ]);
    await service.speakProfile("Hallo", { piper: true });
    expect(calls[1]?.[1]).toBe("jarvis-en-GB-piper");
  });
});
