import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiErrorFilter } from "../../src/core/errors/validation.error.js";
import { TtsController } from "../../src/tts/tts.controller.js";
import { TtsService } from "../../src/tts/tts.service.js";

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
      "nl-NL-FennaNeural",
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
      voice: "nl-NL-FennaNeural",
      voices: ["nl-NL-FennaNeural", "nl-NL-ColetteNeural", "nl-BE-DenaNeural"],
    });
  });
});
