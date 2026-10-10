import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditService } from "../../src/core/audit/audit.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { SettingsStore } from "../../src/settings/store/settings.store.js";
import { ToolSwitchHistory } from "../../src/settings/tool-switch-history.service.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-tool-history-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { dataFile: (name: string) => path.join(dir, name) };
  const settings = new SettingsStore(config as NovaConfig);
  const record = vi.fn();
  const tools = {
    list: () =>
      ["weather_forecast", "ha_turn_on"].map((name) => ({
        name,
        enabled: settings.get().toolOverrides[name]?.enabled !== false,
      })),
  };
  const history = new ToolSwitchHistory(
    config as NovaConfig,
    settings,
    tools as never,
    { record } as unknown as AuditService,
  );
  return { dir, settings, record, history, tools };
}

describe("tool switch history", () => {
  it("stores only tool names and enabled booleans in a private bounded revision", () => {
    const f = fixture();
    f.settings.update((next) => {
      next.toolOverrides.weather_forecast = {
        enabled: false,
        description: "Private description must not enter switch history",
      };
    });
    f.history.record({ weather_forecast: true }, { weather_forecast: false });
    const listed = f.history.list();
    expect(listed.revisions[0]).toMatchObject({
      before: { weather_forecast: true },
      after: { weather_forecast: false },
    });
    expect(JSON.stringify(listed)).not.toContain("Private description");
    expect(
      fs.statSync(path.join(f.dir, "tool-switch-history.json")).mode & 0o777,
    ).toBe(0o600);
  });

  it("restores switch state while preserving descriptions and records the inverse", () => {
    const f = fixture();
    f.settings.update((next) => {
      next.toolOverrides.weather_forecast = {
        enabled: false,
        description: "Keep this current description.",
      };
    });
    f.history.record({ weather_forecast: true }, { weather_forecast: false });
    const revision = f.history.list().revisions[0]!;
    expect(f.history.rollback(revision.id).ok).toBe(true);
    expect(f.tools.list()[0]?.enabled).toBe(true);
    expect(f.settings.get().toolOverrides.weather_forecast).toEqual({
      description: "Keep this current description.",
    });
    expect(f.history.list().revisions[0]?.revertedFrom).toBe(revision.id);
  });

  it("blocks rollback when the effective tool state has since changed", () => {
    const f = fixture();
    f.history.record({ weather_forecast: false }, { weather_forecast: true });
    const revision = f.history.list().revisions[0]!;
    f.settings.update((next) => {
      next.toolOverrides.weather_forecast = { enabled: false };
    });
    expect(() => f.history.rollback(revision.id)).toThrow(
      "Deze toolinstellingen zijn daarna gewijzigd.",
    );
  });
});
