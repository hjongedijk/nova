import { afterEach, describe, expect, it, vi } from "vitest";
import { storage } from "#lib/util/storage.ts";
import { fetchSpeech } from "#lib/api/chat.ts";
import {
  saveTtsProsody,
  saveTtsVoice,
  syncStoredVoiceProfile,
  setServerDefaultVoice,
  ttsLocale,
  ttsProsody,
  ttsProsodyForMood,
  ttsVoice,
  ttsVoiceForLanguage,
  ttsVoiceForSpeech,
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
    expect(save).toHaveBeenCalledWith(
      "novaTtsVoice",
      "nl-NL-FennaNeural",
      "tts-voice",
    );
  });

  it("offers multiple languages and uses the selected language for recognition", () => {
    const values = new Map<string, string>([
      ["novaTtsVoice", "de-DE-KatjaNeural"],
    ]);
    vi.spyOn(storage, "get").mockImplementation(
      (key, fallback) => values.get(key) ?? fallback,
    );
    vi.spyOn(storage, "set").mockImplementation((key, value) =>
      values.set(key, value),
    );

    expect(ttsLocale()).toBe("de-DE");
    expect(saveTtsVoice("en-GB-RyanNeural")).toBe("en-GB-RyanNeural");
    expect(ttsLocale()).toBe("en-GB");
  });

  it("matches the TTS voice to the selected conversation language", () => {
    vi.spyOn(storage, "get").mockReturnValue("nl-NL-FennaNeural");
    expect(ttsVoiceForLanguage("en")).toBe("en-GB-RyanNeural");
    expect(ttsLocale("en")).toBe("en-GB");
    expect(ttsVoiceForLanguage("nl")).toBe("nl-NL-FennaNeural");
  });

  it("uses the API default until this browser explicitly chooses a voice", async () => {
    const values = new Map<string, string>();
    vi.spyOn(storage, "get").mockImplementation(
      (key, fallback) => values.get(key) ?? fallback,
    );
    vi.spyOn(storage, "set").mockImplementation((key, value) => {
      values.set(key, value);
    });
    setServerDefaultVoice("nl-NL-ColetteNeural");
    expect(ttsVoice()).toBe("nl-NL-ColetteNeural");
    expect(ttsVoiceForSpeech("nl")).toBeUndefined();
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchSpeech("Goedemorgen.", undefined, "neutral", "nl");
    expect(
      JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)),
    ).not.toHaveProperty("voice");
    saveTtsVoice("nl-NL-MaartenNeural");
    expect(ttsVoiceForSpeech("nl")).toBe("nl-NL-MaartenNeural");
    setServerDefaultVoice("nl-NL-FennaNeural");
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
    vi.spyOn(storage, "get").mockImplementation((key, fallback) =>
      key === "novaTtsVoice" ? "nl-NL-FennaNeural" : fallback,
    );
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchSpeech("Wat fijn.", undefined, "happy");
    const request = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      text: "Wat fijn.",
      voice: "nl-NL-FennaNeural",
      prosody: { rate: -1, pitch: -1 },
    });
  });

  it("uses a matching voice for English conversation speech", async () => {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchSpeech("Good morning.", undefined, "neutral", "en");
    const request = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      text: "Good morning.",
      voice: "en-GB-RyanNeural",
    });
  });
});

describe("stored voice profile start sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("pushes the stored voice once when the server has another", async () => {
    vi.spyOn(storage, "get").mockImplementation((key, fallback) =>
      key === "novaTtsVoice" ? "nl-NL-MaartenNeural" : fallback,
    );
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response(
            JSON.stringify({
              voice: "nl-NL-MaartenNeural",
              rate: -3,
              pitch: -2,
            }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({ rate: -3, pitch: -2, initialized: false }),
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncStoredVoiceProfile()).resolves.toMatchObject({
      status: "synced",
    });
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body)).voice).toBe(
      "nl-NL-MaartenNeural",
    );
  });
  it("keeps a local edit made while an older profile read is in flight", async () => {
    const values = new Map<string, string>([
      ["novaTtsVoice", "nl-NL-FennaNeural"],
    ]);
    vi.spyOn(storage, "get").mockImplementation(
      (key, fallback) => values.get(key) ?? fallback,
    );
    vi.spyOn(storage, "set").mockImplementation((key, value) => {
      values.set(key, value);
    });
    let resolveRead!: (value: Response) => void;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") return Promise.resolve(new Response("{}"));
        started();
        return new Promise<Response>((resolve) => {
          resolveRead = resolve;
        });
      }),
    );
    const sync = syncStoredVoiceProfile();
    await readStarted;
    saveTtsVoice("nl-NL-MaartenNeural");
    resolveRead(
      new Response(
        JSON.stringify({
          voice: "nl-NL-ColetteNeural",
          rate: 0,
          pitch: 0,
          initialized: true,
        }),
      ),
    );
    await sync;
    expect(ttsVoice()).toBe("nl-NL-MaartenNeural");
  });
  it("loads the shared voice even when nothing is stored locally", async () => {
    vi.spyOn(storage, "get").mockImplementation((_key, fallback) => fallback);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ voice: "nl-NL-ColetteNeural", rate: -1, pitch: 1 }),
        ),
    );
    const save = vi.spyOn(storage, "set");
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncStoredVoiceProfile()).resolves.toMatchObject({
      status: "unchanged",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("novaTtsVoice", "nl-NL-ColetteNeural");
    expect(save).toHaveBeenCalledWith("novaTtsRate", "-1");
    expect(save).toHaveBeenCalledWith("novaTtsPitch", "1");
  });
});
