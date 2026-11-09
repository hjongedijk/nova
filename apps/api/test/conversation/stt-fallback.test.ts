import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWav, tone } from "../../src/conversation/audio.js";
import { OmniRouteStt } from "../../src/conversation/stt.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";

const LOCAL = "http://speaches:8000/v1";
const wav = encodeWav(tone(16000, 200), 16000);
const routing = { assertFreeModel: vi.fn() } as never;
const cfg = (over: Record<string, unknown> = {}) =>
  ({
    omniKey: "main-key",
    omniUrl: "http://omni/v1",
    omniDatabase: "/unused.sqlite",
    sttModel: "groq/whisper-large-v3-turbo",
    sttMode: "transcriptions",
    sttFreeVerified: true,
    sttKey: "",
    localSttUrl: LOCAL,
    localSttModel: "Systran/faster-whisper-small",
    ...over,
  }) as unknown as NovaConfig;

interface Call {
  url: string;
  auth?: string;
  model: string;
  language: string;
}
function fakeFetch(answers: Record<string, () => Response>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const form = init!.body as FormData;
    calls.push({
      url,
      auth: (init!.headers as Record<string, string>).authorization,
      model: String(form.get("model")),
      language: String(form.get("language")),
    });
    const answer = Object.entries(answers).find(([prefix]) =>
      url.startsWith(prefix),
    );
    if (!answer) throw new TypeError("fetch failed");
    return answer[1]();
  });
  return calls;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.restoreAllMocks());

describe("speech-to-text with a local fallback", () => {
  it("uses only OmniRoute when it answers", async () => {
    const calls = fakeFetch({
      "http://omni/v1": () => json({ text: "Zet het licht aan" }),
    });
    const r = await new OmniRouteStt(cfg(), routing).transcribe(wav, {
      language: "nl",
    });
    expect(r).toEqual({ ok: true, text: "Zet het licht aan" });
    expect(calls.map((c) => c.url)).toEqual([
      "http://omni/v1/audio/transcriptions",
    ]);
    expect(calls[0]).toMatchObject({
      auth: "Bearer main-key",
      model: "groq/whisper-large-v3-turbo",
    });
  });

  it("sends the same multipart to the local model when OmniRoute fails", async () => {
    const calls = fakeFetch({
      "http://omni/v1": () => json({ error: "upstream" }, 503),
      [LOCAL]: () => json({ text: "Zet het licht aan" }),
    });
    const r = await new OmniRouteStt(cfg(), routing).transcribe(wav, {
      language: "nl",
    });
    expect(r).toEqual({ ok: true, text: "Zet het licht aan" });
    expect(calls.map((c) => c.url)).toEqual([
      "http://omni/v1/audio/transcriptions",
      `${LOCAL}/audio/transcriptions`,
    ]);
    // No OmniRoute credentials go to the local service.
    expect(calls[1]).toEqual({
      url: `${LOCAL}/audio/transcriptions`,
      auth: undefined,
      model: "Systran/faster-whisper-small",
      language: "nl",
    });
  });

  it("falls back to the local model when the OmniRoute route is not configured", async () => {
    const calls = fakeFetch({ [LOCAL]: () => json({ text: "Hallo Nova" }) });
    const stt = new OmniRouteStt(
      cfg({ sttModel: "", sttFreeVerified: false }),
      routing,
    );
    expect(stt.unavailable()).toBeNull();
    expect(await stt.transcribe(wav, { language: "en" })).toEqual({
      ok: true,
      text: "Hallo Nova",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${LOCAL}/audio/transcriptions` });
    expect(calls[0]!.language).toBe("en");
  });

  it("reports both failures when OmniRoute and the local model fail", async () => {
    const calls = fakeFetch({
      "http://omni/v1": () => json({}, 500),
      [LOCAL]: () => json({}, 404),
    });
    const r = await new OmniRouteStt(cfg(), routing).transcribe(wav, {
      language: "nl",
    });
    expect(r).toEqual({
      ok: false,
      retry: true,
      error:
        "Spraakherkenning is nu niet beschikbaar. De lokale spraakherkenning werkt ook niet.",
    });
    expect(calls).toHaveLength(2);
  });

  it("does not fall back after the caller hung up, or when the fallback is off", async () => {
    const calls = fakeFetch({ "http://omni/v1": () => json({}, 500) });
    const hangup = new AbortController();
    hangup.abort();
    const r1 = await new OmniRouteStt(cfg(), routing).transcribe(wav, {
      language: "nl",
      signal: hangup.signal,
    });
    expect(r1.ok).toBe(false);
    const off = new OmniRouteStt(cfg({ localSttUrl: "" }), routing);
    const r2 = await off.transcribe(wav, { language: "nl" });
    expect(r2).toMatchObject({ ok: false, retry: true });
    expect(calls.every((c) => c.url.startsWith("http://omni/v1"))).toBe(true);
    expect(
      new OmniRouteStt(
        cfg({ localSttUrl: "", sttFreeVerified: false }),
        routing,
      ).unavailable(),
    ).toMatch(/NOVA_STT_FREE_VERIFIED/);
  });
});

describe("local speech-to-text configuration", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("defaults to the speaches service and the small Whisper model, and can be switched off", () => {
    vi.stubEnv("NOVA_LOCAL_STT_URL", "");
    vi.stubEnv("NOVA_LOCAL_STT_MODEL", "");
    const defaults = new NovaConfig();
    expect(defaults.localSttUrl).toBe(LOCAL);
    expect(defaults.localSttModel).toBe("Systran/faster-whisper-small");
    vi.stubEnv("NOVA_LOCAL_STT_URL", "off");
    expect(new NovaConfig().localSttUrl).toBe("");
    vi.stubEnv("NOVA_LOCAL_STT_URL", "http://127.0.0.1:8000/v1/");
    expect(new NovaConfig().localSttUrl).toBe("http://127.0.0.1:8000/v1");
  });
});
