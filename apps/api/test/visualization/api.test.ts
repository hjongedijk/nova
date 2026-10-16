import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { AuditService } from "../../src/core/audit/audit.service.js";

/** The REST API the viewer uses, with the real application wired together. */
describe("visualization REST API", () => {
  let app: INestApplication;
  let audit: AuditService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api", {
      exclude: ["windows-agent/{*path}", "nova-ca.crt"],
    });
    await app.init();
    audit = moduleRef.get(AuditService);
  }, 60_000);
  afterAll(() => app.close());

  it("lists providers with their availability and reasons", async () => {
    const { body } = await request(app.getHttpServer())
      .get("/api/visualizations/providers")
      .expect(200);
    const proxmox = body.providers.find(
      (p: { id: string }) => p.id === "proxmox",
    );
    expect(proxmox).toMatchObject({ available: false });
    expect(proxmox.reason).toContain("niet gekoppeld");
    expect(
      body.providers.find((p: { id: string }) => p.id === "ai-activity"),
    ).toMatchObject({ available: true });
  });

  it("refuses an unknown or unavailable source with a clear message", async () => {
    await request(app.getHttpServer())
      .post("/api/visualizations")
      .send({ source: "koelkast" })
      .expect(400);
    const unavailable = await request(app.getHttpServer())
      .post("/api/visualizations")
      .send({ source: "proxmox" })
      .expect(503);
    expect(JSON.stringify(unavailable.body)).toContain("Proxmox");
  });

  it("opens, polls, exports and closes an AI-activity scene from real audit records", async () => {
    await request(app.getHttpServer())
      .post("/api/visualizations")
      .send({ source: "activiteit" })
      .expect(503); // nothing in the action log yet: no invented activity
    audit.record({
      sessionId: "s-api-test",
      tool: "timer_list",
      risk: "READ_ONLY",
      result: { ok: true },
      durationMs: 5,
      arguments: { secret: "never-shown" },
    });
    const created = await request(app.getHttpServer())
      .post("/api/visualizations")
      .send({ source: "ai-activity" })
      .expect(201);
    const scene = created.body.scene;
    expect(scene).toMatchObject({ kind: "graph", providerId: "ai-activity" });
    expect(JSON.stringify(scene)).not.toContain("never-shown");
    expect(scene.nodes.map((n: { id: string }) => n.id)).toContain(
      "tool:timer_list",
    );

    const same = await request(app.getHttpServer())
      .get(`/api/visualizations/${scene.id}?since=${scene.revision}`)
      .expect(200);
    expect(same.body).toEqual({ unchanged: true, revision: scene.revision });
    const full = await request(app.getHttpServer())
      .get(`/api/visualizations/${scene.id}`)
      .expect(200);
    expect(full.body.scene.id).toBe(scene.id);

    const csv = await request(app.getHttpServer())
      .get(`/api/visualizations/${scene.id}/export?format=csv`)
      .expect(200);
    expect(csv.headers["content-disposition"]).toContain("attachment");
    expect(csv.text).toContain("timer_list");

    await request(app.getHttpServer())
      .delete(`/api/visualizations/${scene.id}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/visualizations/${scene.id}`)
      .expect(404);
  });

  it("rejects malformed ids", async () => {
    await request(app.getHttpServer())
      .get("/api/visualizations/..%2F..%2Fetc")
      .expect(404);
    await request(app.getHttpServer())
      .delete("/api/visualizations/not-an-id")
      .expect(404);
  });
});
