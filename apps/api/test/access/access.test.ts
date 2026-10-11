import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ACCESS_PUBLIC } from "../../src/access/access-public.js";
import { NodeRedEventsController } from "../../src/dashboard/node-red-events.controller.js";
import { createApp, type TestApp } from "../settings/helpers.js";

describe("app-wide access gate", () => {
  let nova: TestApp;
  beforeAll(async () => {
    nova = await createApp({
      env: { NOVA_APP_TOKEN: "a-long-test-access-token" },
    });
  });
  afterAll(async () => nova.app.close());

  it("keeps existing access open when no app token is configured", async () => {
    const open = await createApp();
    try {
      expect((await open.api.get("/api/access/status")).body).toEqual({
        required: false,
        unlocked: true,
      });
      expect((await open.api.get("/api/settings/public")).status).toBe(200);
    } finally {
      await open.app.close();
    }
  });

  it("blocks private API routes until the token unlocks a secure session", async () => {
    expect((await nova.api.get("/api/access/status")).body).toEqual({
      required: true,
      unlocked: false,
    });
    expect((await nova.api.get("/api/settings/public")).status).toBe(403);
    expect((await nova.api.get("/api/nova/health")).status).toBe(200);

    const denied = await nova.api
      .post("/api/access/unlock")
      .send({ token: "wrong" });
    expect(denied.status).toBe(401);

    const unlocked = await nova.api
      .post("/api/access/unlock")
      .send({ token: "a-long-test-access-token" });
    expect(unlocked.status).toBe(200);
    const setCookie = unlocked.headers["set-cookie"]?.[0] ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api/i);
    const cookie = setCookie.split(";")[0] ?? "";
    expect(
      (await nova.api.get("/api/settings/public").set("Cookie", cookie)).status,
    ).toBe(200);
  });

  it("rejects cross-site writes even with an unlocked session", async () => {
    const unlocked = await nova.api
      .post("/api/access/unlock")
      .send({ token: "a-long-test-access-token" });
    const cookie = unlocked.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
    const blocked = await nova.api
      .post("/api/test-access/write")
      .set("Cookie", cookie)
      .set("Host", "nova.test")
      .set("Origin", "https://attacker.example")
      .send({});
    expect(blocked.status).toBe(403);
    const insecure = await nova.api
      .post("/api/test-access/write")
      .set("Cookie", cookie)
      .set("Host", "nova.test")
      .set("Origin", "http://nova.test")
      .send({});
    expect(insecure.status).toBe(403);
    const allowed = await nova.api
      .post("/api/test-access/write")
      .set("Cookie", cookie)
      .set("Host", "nova.test")
      .set("Origin", "https://nova.test")
      .send({});
    expect(allowed.status).toBe(201);
  });

  it("leaves the Node-RED event route outside app auth for its own bearer check", () => {
    expect(
      Reflect.getMetadata(
        APP_ACCESS_PUBLIC,
        NodeRedEventsController.prototype.receive,
      ),
    ).toBe(true);
  });

  it("rate-limits repeated incorrect tokens", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        nova.api.post("/api/access/unlock").send({ token: "wrong-again" }),
      ),
    );
    expect(attempts.slice(0, 4).every((result) => result.status === 401)).toBe(
      true,
    );
    expect(attempts[4]?.status).toBe(429);
  });
});
