import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { CoreModule } from "../../src/core/core.module.js";
import { YoutubeModule } from "../../src/integrations/youtube/youtube.module.js";

describe("YouTube OAuth settings routes", () => {
  let app: INestApplication;
  let directory: string;
  const previous: Record<string, string | undefined> = {};

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-youtube-routes-"));
    for (const [key, value] of Object.entries({
      NOVA_DATA_DIR: directory,
      NOVA_PUBLIC_URL: "https://nova.example.com",
      NOVA_ADMIN_PIN: "4321",
    })) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
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
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });

  it("guards configuration and start while the one-use callback redirects without echoing code", async () => {
    const agent = request(app.getHttpServer());
    const route = "/api/settings/youtube/oauth";
    await agent.get(`${route}/status`).expect(401);
    const status = await agent
      .get(`${route}/status`)
      .set("x-nova-pin", "4321")
      .expect(200);
    expect(status.body).toEqual({
      configured: false,
      connected: false,
      callbackUrl:
        "https://nova.example.com/api/settings/youtube/oauth/callback",
    });
    const client = {
      clientId: "123456789012-abcdef.apps.googleusercontent.com",
      clientSecret: "GOCSPX-example-secret",
    };
    await agent
      .post(`${route}/config`)
      .set("x-nova-pin", "4321")
      .send(client)
      .expect(403);
    const saved = await agent
      .post(`${route}/config`)
      .set("x-nova-pin", "4321")
      .set("x-nova-admin", "1")
      .send(client)
      .expect(200);
    expect(JSON.stringify(saved.body)).not.toContain(client.clientSecret);
    const started = await agent
      .post(`${route}/start`)
      .set("x-nova-pin", "4321")
      .set("x-nova-admin", "1")
      .send({})
      .expect(200);
    expect(new URL(started.body.authorizationUrl).origin).toBe(
      "https://accounts.google.com",
    );
    expect(started.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    const callback = await agent
      .get(`${route}/callback?state=invalid&code=private-code`)
      .expect(303);
    expect(callback.headers.location).toBe(
      "/settings?section=connections&youtubeOAuth=error",
    );
    expect(JSON.stringify(callback.headers)).not.toContain("private-code");
  });
});
