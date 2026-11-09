import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ApiErrorFilter } from "../../src/core/errors/validation.error.js";
import { TtsController } from "../../src/tts/tts.controller.js";
import {
  TTS_PIPER_MODELS,
  TTS_PIPER_NL_VOICE,
  TTS_PIPER_VOICE,
  TtsService,
  piperVoiceFor,
} from "../../src/tts/tts.service.js";

describe("POST /api/tts", () => {
  let app: INestApplication;
  let calls = 0;
  const voices: string[] = [];
  const prosodies: Array<{ rate: number; pitch: number }> = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TtsController],
      providers: [TtsService],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new ApiErrorFilter());
    app.get(TtsService).engine = async (text, voice, prosody) => {
      calls++;
      voices.push(voice);
      prosodies.push(prosody);
      return Buffer.from(`mp3:${text}`);
    };
    await app.init();
  });
  afterAll(() => app.close());

  it("answers with audio", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/tts")
      .send({ text: "Hallo" })
      .buffer(true)
      .parse((res, done) => {
        const parts: Buffer[] = [];
        res.on("data", (part: Buffer) => parts.push(part));
        res.on("end", () => done(null, Buffer.concat(parts)));
      })
      .expect(200);
    expect(response.headers["content-type"]).toBe("audio/mpeg");
    expect(response.body.toString()).toBe("mp3:Hallo");
  });

  it("keeps the latest sentences, so a repeat does not synthesize again", async () => {
    const before = calls;
    await request(app.getHttpServer())
      .post("/api/tts")
      .send({ text: "Even kijken." });
    const again = await request(app.getHttpServer())
      .post("/api/tts")
      .send({ text: "Even kijken." });
    expect(calls).toBe(before + 1);
    expect(again.headers["x-tts-cache"]).toBe("hit");
  });

  it("uses only the reviewed voice list and separates cached audio by voice", async () => {
    const start = voices.length;
    await request(app.getHttpServer())
      .post("/api/tts")
      .send({ text: "Stemproef", voice: "nl-NL-ColetteNeural" })
      .expect(200);
    await request(app.getHttpServer())
      .post("/api/tts")
      .send({ text: "Stemproef", voice: "unknown" })
      .expect(200);
    expect(voices.slice(start)).toEqual([
      "nl-NL-ColetteNeural",
      "nl-NL-MaartenNeural",
    ]);
  });

  it("bounds prosody, varies it slightly, and separates cached settings", async () => {
    const startCalls = calls;
    const start = prosodies.length;
    await request(app.getHttpServer())
      .post("/api/tts")
      .send({
        text: "Een natuurlijke zin.",
        prosody: { rate: 100, pitch: -100 },
      })
      .expect(200);
    await request(app.getHttpServer())
      .post("/api/tts")
      .send({ text: "Een natuurlijke zin.", prosody: { rate: 5, pitch: 3 } })
      .expect(200);
    expect(calls).toBe(startCalls + 2);
    expect(prosodies[start]?.rate).toBeGreaterThanOrEqual(-10);
    expect(prosodies[start]?.rate).toBeLessThanOrEqual(10);
    expect(prosodies[start]?.pitch).toBeGreaterThanOrEqual(-5);
    expect(prosodies[start]?.pitch).toBeLessThanOrEqual(5);
    expect(prosodies[start + 1]).not.toEqual(prosodies[start]);
  });

  it("varies distinct sentence fragments with the same base prosody deterministically", async () => {
    const startCalls = calls;
    const start = prosodies.length;
    const prosody = { rate: -3, pitch: -2 };
    await request(app.getHttpServer())
      .post("/api/tts")
      .send({ text: "Eerste zin.", prosody })
      .expect(200);
    await request(app.getHttpServer())
      .post("/api/tts")
      .send({ text: "Tweede zin.", prosody })
      .expect(200);

    expect(prosodies.slice(start)).toEqual([
      { rate: -4, pitch: -1 },
      { rate: -2, pitch: -3 },
    ]);
    const repeated = await request(app.getHttpServer())
      .post("/api/tts")
      .send({ text: "Eerste zin.", prosody })
      .expect(200);
    expect(repeated.headers["x-tts-cache"]).toBe("hit");
    expect(calls).toBe(startCalls + 2);
  });

  it("refuses empty and oversized text in Dutch", async () => {
    const empty = await request(app.getHttpServer())
      .post("/api/tts")
      .send({ text: "  " })
      .expect(400);
    expect(empty.body.error).toMatch(/tekst/);
    await request(app.getHttpServer())
      .post("/api/tts")
      .send({ text: "x".repeat(5001) })
      .expect(400);
  });

  it("reports the voice", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/tts/health")
      .expect(200);
    expect(response.body).toMatchObject({
      ok: true,
      voice: "nl-NL-MaartenNeural",
      voices: expect.arrayContaining([
        "nl-NL-FennaNeural",
        "nl-NL-ColetteNeural",
        "nl-BE-DenaNeural",
        "en-US-GuyNeural",
        "en-GB-SoniaNeural",
        "de-DE-KatjaNeural",
        "fr-FR-DeniseNeural",
        "es-ES-ElviraNeural",
        "it-IT-ElsaNeural",
        "pt-BR-FranciscaNeural",
        "ja-JP-NanamiNeural",
      ]),
    });
  });

  it("routes the optional personal voice to local Piper and returns WAV", async () => {
    vi.stubEnv("NOVA_PIPER_TTS_URL", "http://127.0.0.1:5000/synthesize");
    const localFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from("RIFF0000WAVE"), {
        headers: { "content-type": "audio/wav", "content-length": "12" },
      }),
    );
    try {
      const result = await request(app.getHttpServer())
        .post("/api/tts")
        .send({ text: "Personal voice test", voice: "jarvis-en-GB-piper" })
        .buffer(true)
        .parse((res, done) => {
          const parts: Buffer[] = [];
          res.on("data", (part: Buffer) => parts.push(part));
          res.on("end", () => done(null, Buffer.concat(parts)));
        })
        .expect(200);
      expect(result.headers["content-type"]).toBe("audio/wav");
      expect(result.body.toString()).toBe("RIFF0000WAVE");
      expect(
        JSON.parse(String(localFetch.mock.calls[0]?.[1]?.body)),
      ).toMatchObject({
        text: "Personal voice test",
      });
      expect(
        (await request(app.getHttpServer()).get("/api/tts/health")).body.voices,
      ).toContain("jarvis-en-GB-piper");
    } finally {
      localFetch.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("local Piper fallback voices", () => {
  const wav = () =>
    new Response(Buffer.from("RIFF0000WAVE"), {
      headers: { "content-type": "audio/wav", "content-length": "12" },
    });
  const piperBodies = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map(
      (call) =>
        JSON.parse(String((call[1] as RequestInit).body)) as {
          text: string;
          voice: string;
        },
    );
  const failingEdge = () => {
    const service = new TtsService();
    const voices: string[] = [];
    service.engine = async (_text, voice) => {
      voices.push(voice);
      throw new Error("edge unreachable");
    };
    return { service, voices };
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("maps voices to Piper by language: English to Jarvis, everything else to Dutch", () => {
    expect(piperVoiceFor("nl-NL-MaartenNeural")).toBe(TTS_PIPER_NL_VOICE);
    expect(piperVoiceFor("nl-BE-DenaNeural")).toBe(TTS_PIPER_NL_VOICE);
    expect(piperVoiceFor(undefined)).toBe(TTS_PIPER_NL_VOICE);
    expect(piperVoiceFor("en-GB-RyanNeural")).toBe(TTS_PIPER_VOICE);
    expect(piperVoiceFor("en-US-JennyNeural")).toBe(TTS_PIPER_VOICE);
    expect(piperVoiceFor(TTS_PIPER_VOICE)).toBe(TTS_PIPER_VOICE);
    expect(TTS_PIPER_MODELS[TTS_PIPER_NL_VOICE]).toBe("nl_NL-pim-medium");
  });

  it("speaks a Dutch reply with the Dutch Piper voice when Edge fails, and does not cache it", async () => {
    vi.stubEnv("NOVA_PIPER_TTS_URL", "http://piper:5000/synthesize");
    const piper = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => wav());
    const { service, voices } = failingEdge();
    const first = await service.speak(
      "De deur is open.",
      "nl-NL-MaartenNeural",
    );
    expect(first).toMatchObject({ cached: false, contentType: "audio/wav" });
    const again = await service.speak(
      "De deur is open.",
      "nl-NL-MaartenNeural",
    );
    expect(again.cached).toBe(false);
    expect(voices).toEqual(["nl-NL-MaartenNeural", "nl-NL-MaartenNeural"]);
    expect(piperBodies(piper).map((body) => body.voice)).toEqual([
      "nl_NL-pim-medium",
      "nl_NL-pim-medium",
    ]);
  });

  it("uses the English Piper voice only for an English reply", async () => {
    vi.stubEnv("NOVA_PIPER_TTS_URL", "http://piper:5000/synthesize");
    const piper = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => wav());
    const { service } = failingEdge();
    await service.speak("The door is open.", "en-GB-RyanNeural");
    expect(piperBodies(piper)[0]).toMatchObject({
      text: "The door is open.",
      voice: "en_GB-jarvis-medium",
    });
  });

  it("sends the chosen Dutch Piper voice by name", async () => {
    vi.stubEnv("NOVA_PIPER_TTS_URL", "http://piper:5000/synthesize");
    const piper = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => wav());
    const service = new TtsService();
    service.engine = async () => {
      throw new Error("Edge must not be used");
    };
    const result = await service.speak("Goedemorgen", TTS_PIPER_NL_VOICE);
    expect(result.contentType).toBe("audio/wav");
    expect(piperBodies(piper)[0]?.voice).toBe("nl_NL-pim-medium");
    expect(service.health().voices).toContain(TTS_PIPER_NL_VOICE);
  });

  it("still fails without a Piper service", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { service } = failingEdge();
    await expect(service.speak("Hallo", "nl-NL-MaartenNeural")).rejects.toThrow(
      "edge unreachable",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
