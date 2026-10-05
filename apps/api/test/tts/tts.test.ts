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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TtsController],
      providers: [TtsService],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new ApiErrorFilter());
    app.get(TtsService).engine = async (text) => {
      calls++;
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
    });
  });
});
