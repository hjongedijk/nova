import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WindowsAgentStatus } from "@nova/contracts";
import type { WallpaperPort } from "../../src/settings/wallpaper.port.js";
import { ADMIN, createApp, type TestApp } from "./helpers.js";
import { dbStat } from "../helpers/nova-db.js";

const apps: TestApp[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ app }) => app.close()));
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
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
    helperDebug: vi.fn(async () => ({
      available: true,
      helper: "window=0,0,640,340 topmost=True",
      view: "chat",
      display: 0,
      checkedAt: "2026-10-11T10:00:00.000Z",
    })),
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

  it("stores private hotkey history and restores only when the agent state matches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-hotkey-history-"));
    tempDirs.push(dir);
    const original = {
      open: "Ctrl+Alt+N",
      speak: "Ctrl+Alt+S",
      mute: "Ctrl+Alt+M",
      desktop: "Ctrl+Alt+D",
    };
    let current = { ...original };
    const helperPreferences = vi.fn(async (next?: Record<string, string>) => {
      if (next)
        current = {
          open: next.open ?? "",
          speak: next.speak ?? "",
          mute: next.mute ?? "",
          desktop: next.desktop ?? "",
        };
      return {
        ok: true,
        preferences: { hotkeys: { ...current }, warnings: [], paused: false },
      };
    });
    const wallpaper = port();
    wallpaper.helperPreferences = helperPreferences;
    const app = await createApp({
      env: { NOVA_ADMIN_PIN: "4321", NOVA_DATA_DIR: dir },
      wallpaper,
    });
    apps.push(app);
    const headers = { ...ADMIN, "x-nova-pin": "4321" };
    const changed = { ...original, open: "Ctrl+Alt+Q" };
    const save = await app.api
      .put("/api/settings/helper/hotkeys")
      .set(headers)
      .send({ hotkeys: changed });
    expect(save.status).toBe(200);
    const listed = await app.api
      .get("/api/settings/helper/hotkeys/history")
      .set(headers);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      revisions: [{ before: original, after: changed }],
      truncated: false,
    });
    const revision = listed.body.revisions[0];
    const rollback = await app.api
      .post(`/api/settings/helper/hotkeys/history/${revision.id}/rollback`)
      .set(headers)
      .send({});
    expect(rollback.status).toBe(201);
    expect(rollback.body).toMatchObject({ ok: true, hotkeys: original });
    expect(current).toEqual(original);
    const stat = dbStat(path.join(dir, "helper-hotkey-history.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.stringify(app.audits)).not.toContain("Ctrl+Alt+Q");
  });

  it("rejects hotkey rollback when the Windows agent changed since the revision", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-hotkey-conflict-"));
    tempDirs.push(dir);
    const original = {
      open: "Ctrl+Alt+N",
      speak: "Ctrl+Alt+S",
      mute: "Ctrl+Alt+M",
      desktop: "Ctrl+Alt+D",
    };
    let current = { ...original };
    const helperPreferences = vi.fn(async (next?: Record<string, string>) => {
      if (next)
        current = {
          open: next.open ?? "",
          speak: next.speak ?? "",
          mute: next.mute ?? "",
          desktop: next.desktop ?? "",
        };
      return {
        ok: true,
        preferences: { hotkeys: { ...current }, warnings: [], paused: false },
      };
    });
    const wallpaper = port();
    wallpaper.helperPreferences = helperPreferences;
    const app = await createApp({
      env: { NOVA_ADMIN_PIN: "4321", NOVA_DATA_DIR: dir },
      wallpaper,
    });
    apps.push(app);
    const headers = { ...ADMIN, "x-nova-pin": "4321" };
    await app.api
      .put("/api/settings/helper/hotkeys")
      .set(headers)
      .send({ hotkeys: { ...original, open: "Ctrl+Alt+Q" } });
    const listed = await app.api
      .get("/api/settings/helper/hotkeys/history")
      .set(headers);
    current.open = "Ctrl+Alt+X";
    const callsBefore = helperPreferences.mock.calls.length;
    const rollback = await app.api
      .post(
        `/api/settings/helper/hotkeys/history/${listed.body.revisions[0].id}/rollback`,
      )
      .set(headers)
      .send({});
    expect(rollback.status).toBe(201);
    expect(rollback.body).toMatchObject({ ok: false });
    expect(current.open).toBe("Ctrl+Alt+X");
    expect(helperPreferences).toHaveBeenCalledTimes(callsBefore + 1);
  });
});
