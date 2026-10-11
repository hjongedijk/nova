import { afterEach, describe, expect, it, vi } from "vitest";
import { storage } from "#lib/util/storage.ts";
import { fetchSpeech } from "#lib/api/chat.ts";
import {
  saveTtsProsody,
  saveTtsVoice,
  ttsProsody,
  ttsProsodyForMood,
  ttsVoice,
} from "./voice-preference.ts";

describe("TTS voice preference", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists a reviewed voice and reads it for later speech", () => {
    let saved = "nl-NL-FennaNeural";
    vi.spyOn(storage, "get").mockImplementation(
      (_key, fallback) => saved || fallback,
    );
    vi.spyOn(storage, "set").mockImplementation((_key, value) => {
      saved = value;
    });

    expect(saveTtsVoice("nl-NL-ColetteNeural")).toBe("nl-NL-ColetteNeural");
    expect(ttsVoice()).toBe("nl-NL-ColetteNeural");
  });

  it("falls back to Fenna for an unknown saved or requested voice", () => {
    vi.spyOn(storage, "get").mockReturnValue("unreviewed-voice");
    const save = vi.spyOn(storage, "set");

    expect(ttsVoice()).toBe("nl-NL-FennaNeural");
    expect(saveTtsVoice("unreviewed-voice")).toBe("nl-NL-FennaNeural");
    expect(save).toHaveBeenCalledWith("novaTtsVoice", "nl-NL-FennaNeural");
  });

  it("persists prosody and clamps it to the supported range", () => {
    const values = new Map<string, string>();
    vi.spyOn(storage, "get").mockImplementation(
      (key, fallback) => values.get(key) ?? fallback,
    );
    vi.spyOn(storage, "set").mockImplementation((key, value) =>
      values.set(key, value),
    );

    expect(saveTtsProsody(99, -99)).toEqual({ rate: 10, pitch: -5 });
    expect(ttsProsody()).toEqual({ rate: 10, pitch: -5 });
  });

  it("makes small mood prosody changes without exceeding TTS limits", () => {
    const values = new Map<string, string>([
      ["novaTtsRate", "-3"],
      ["novaTtsPitch", "-2"],
    ]);
    vi.spyOn(storage, "get").mockImplementation(
      (key, fallback) => values.get(key) ?? fallback,
    );
    expect(ttsProsodyForMood("happy")).toEqual({ rate: -1, pitch: -1 });
    expect(ttsProsodyForMood("thoughtful")).toEqual({ rate: -4, pitch: -3 });
    expect(ttsProsodyForMood("concerned")).toEqual({ rate: -5, pitch: -3 });
    expect(ttsProsodyForMood("enthusiastic")).toEqual({ rate: -1, pitch: 0 });
    expect(ttsProsodyForMood("neutral")).toEqual({ rate: -3, pitch: -2 });
    values.set("novaTtsRate", "10");
    values.set("novaTtsPitch", "5");
    expect(ttsProsodyForMood("enthusiastic")).toEqual({ rate: 10, pitch: 5 });
  });

  it("sends the mood-adjusted prosody while preserving the chosen voice", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("audio"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchSpeech("Wat fijn.", undefined, "happy");
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      text: "Wat fijn.",
      voice: "nl-NL-FennaNeural",
      prosody: { rate: -1, pitch: -1 },
    });
  });
});
