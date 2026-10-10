import { afterEach, describe, expect, it, vi } from "vitest";
import type { WindowsAgentStatus } from "@nova/contracts";
import type { WallpaperPort } from "../../src/settings/wallpaper.port.js";
import { ADMIN, createApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ app }) => app.close()));
});

const status: WindowsAgentStatus = {
  available: true,
  version: "0.1.11",
  helperOpen: true,
  paused: false,
  mode: "helper",
  display: 0,
};

function port(): WallpaperPort {
  return {
    configured: true,
    agentStatus: vi.fn(async () => status),
    displays: async () => ({ ok: true, displays: [] }),
    setWallpaper: async () => ({ ok: true, displays: [] }),
    setMode: async () => ({ ok: true, displays: [] }),
    helperSize: async () => ({ ok: true }),
    helperPreferences: vi.fn(async (hotkeys) => ({
      ok: true,
      preferences: { hotkeys: hotkeys ?? {}, warnings: [], paused: false },
    })),
  };
}

describe("private Windows settings endpoints", () => {
  it("requires the PIN before probing and exposes the provided status", async () => {
    const wallpaper = port();
    const app = await createApp({
      env: { NOVA_ADMIN_PIN: "4321" },
      wallpaper,
    });
    apps.push(app);
    expect((await app.api.get("/api/settings/windows/status")).status).toBe(
      401,
    );
    expect(
      (await app.api.get("/api/settings/windows/status").set(ADMIN)).status,
    ).toBe(401);
    expect(
      (
        await app.api
          .get("/api/settings/windows/status")
          .set("x-nova-pin", "wrong")
      ).status,
    ).toBe(401);
    expect(wallpaper.agentStatus).not.toHaveBeenCalled();
    const reply = await app.api
      .get("/api/settings/windows/status")
      .set("x-nova-pin", "4321");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(status);
    expect(wallpaper.agentStatus).toHaveBeenCalledOnce();
  });

  it("degrades cleanly without an agent or with a legacy port", async () => {
    const legacy = port();
    delete legacy.agentStatus;
    for (const wallpaper of [undefined, legacy]) {
      const app = await createApp({ wallpaper });
      apps.push(app);
      const reply = await app.api.get("/api/settings/windows/status");
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({
        available: false,
        version: null,
        helperOpen: null,
        paused: null,
        mode: null,
        display: null,
        error: "Er is geen Windows-agent ingesteld.",
      });
    }
  });

  it("guards hotkey changes and rejects invalid input before reaching the agent", async () => {
    const wallpaper = port();
    const app = await createApp({
      env: { NOVA_ADMIN_PIN: "4321" },
      wallpaper,
    });
    apps.push(app);
    const hotkeys = {
      open: "Ctrl+Alt+N",
      speak: "Ctrl+Alt+S",
      mute: "Ctrl+Alt+M",
      desktop: "Ctrl+Alt+D",
    };
    const save = (headers: Record<string, string>, body: object) =>
      app.api.put("/api/settings/helper/hotkeys").set(headers).send(body);
    expect((await save(ADMIN, { hotkeys })).status).toBe(401);
    expect((await save({ "x-nova-pin": "4321" }, { hotkeys })).status).toBe(
      403,
    );
    const headers = { ...ADMIN, "x-nova-pin": "4321" };
    for (const invalid of [
      {},
      { hotkeys: [] },
      { hotkeys: { ...hotkeys, open: 2 } },
      { hotkeys: { ...hotkeys, open: "x".repeat(81) } },
    ])
      expect((await save(headers, invalid)).status).toBe(400);
    expect(wallpaper.helperPreferences).not.toHaveBeenCalled();
    expect((await save(headers, { hotkeys })).status).toBe(200);
    expect(wallpaper.helperPreferences).toHaveBeenCalledExactlyOnceWith(
      hotkeys,
    );
  });
});
