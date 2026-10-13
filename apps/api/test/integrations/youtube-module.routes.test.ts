import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { CoreModule } from "../../src/core/core.module.js";
import { YoutubeModule } from "../../src/integrations/youtube/youtube.module.js";
import { YoutubeService } from "../../src/integrations/youtube/youtube.service.js";

describe("YouTube playback module", () => {
  let app: INestApplication;
  let directory: string;
  let previousDataDir: string | undefined;
  const preservedPrivateData = "legacy-private-data";

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-youtube-module-"));
    previousDataDir = process.env.NOVA_DATA_DIR;
    process.env.NOVA_DATA_DIR = directory;
    fs.writeFileSync(
      path.join(directory, "youtube-oauth.json"),
      preservedPrivateData,
    );
    const module = await Test.createTestingModule({
      imports: [CoreModule, YoutubeModule],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.NOVA_DATA_DIR;
    else process.env.NOVA_DATA_DIR = previousDataDir;
  });

  it("removes subtitle authorization routes without deleting existing private data", async () => {
    const agent = request(app.getHttpServer());
    const route = "/api/settings/youtube/oauth";
    await agent.get(`${route}/status`).expect(404);
    await agent.get(`${route}/callback?state=unused&code=unused`).expect(404);
    for (const action of ["config", "start", "disconnect"])
      await agent
        .post(`${route}/${action}`)
        .set("x-nova-admin", "1")
        .send({})
        .expect(404);
    expect(
      fs.readFileSync(path.join(directory, "youtube-oauth.json"), "utf8"),
    ).toBe(preservedPrivateData);
  });

  it("keeps video search available for the existing Windows playback tool", async () => {
    const service = app.get(YoutubeService);
    const found = await service.findVideo("music", {
      post: async () => ({
        videoRenderer: {
          videoId: "DDDDDDDDDDD",
          title: { simpleText: "Music video" },
          ownerText: { simpleText: "Channel" },
          lengthText: { simpleText: "3:00" },
        },
      }),
    });
    expect(found?.url).toBe("https://www.youtube.com/watch?v=DDDDDDDDDDD");
    expect(found?.title).toBe("Music video");
  });
});
