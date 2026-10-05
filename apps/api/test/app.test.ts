import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";

/** The whole application with every module wired together, and nothing configured. */
describe("NOVA as a whole", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api", {
      exclude: ["windows-agent/{*path}", "nova-ca.crt"],
    });
    await app.init();
  });
  afterAll(() => app.close());

  it("starts, and every module finds what it needs", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/nova/health")
      .expect(200);
    expect(response.body).toMatchObject({ ok: true, name: "nova" });
  });

  it("offers the tools of every source, off when not configured", async () => {
    const { body } = await request(app.getHttpServer())
      .get("/api/tools")
      .expect(200);
    const names: string[] = body.tools.map(
      (tool: { name: string }) => tool.name,
    );
    for (const name of [
      "memory_remember",
      "omniroute_status",
      "proxmox_guests",
      "timer_set",
      "alerts_list",
      "ha_search_entities",
      "weather_forecast",
      "termix_run_command",
      "windows_wallpaper",
      "browser_status",
      "pangolin_sites",
      "system_integrations",
      "system_time",
    ])
      expect(names, name).toContain(name);
    const proxmox = body.tools.find(
      (tool: { name: string }) => tool.name === "proxmox_guests",
    );
    expect(proxmox.enabled).toBe(false);
  });

  it("the settings screen reads the public configuration without a PIN", async () => {
    const { body } = await request(app.getHttpServer())
      .get("/api/settings/public")
      .expect(200);
    expect(body.sidebar.length).toBeGreaterThanOrEqual(15);
    expect(body.quickActions.length).toBeGreaterThan(0);
  });

  it("the home screen data answers even with nothing configured", async () => {
    const system = await request(app.getHttpServer())
      .get("/api/system")
      .expect(200);
    expect(system.body.cores).toBeGreaterThan(0);
    await request(app.getHttpServer()).get("/api/alerts").expect(200);
  });

  it("asking for a chat answer without a model says so instead of crashing", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/chat")
      .send({ message: "hoi", sessionId: "t" });
    expect(response.status).toBe(409);
  });

  it("serves the Windows agent for updates, and nothing else from the agents folder", async () => {
    const agent = await request(app.getHttpServer())
      .get("/windows-agent/jarvis-agent.ps1")
      .expect(200);
    expect(agent.headers["content-disposition"]).toContain("jarvis-agent.ps1");
    await request(app.getHttpServer())
      .get("/windows-agent/agent.example.json")
      .expect(404);
  });

  it("wallpaper, language-model and alias bridges are in place", async () => {
    const { body } = await request(app.getHttpServer())
      .get("/api/settings/wallpaper")
      .set("x-nova-admin", "1")
      .expect(200);
    expect(body).toMatchObject({ available: false, reason: "no-agent" });
  });
});
