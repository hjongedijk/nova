import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelperPreferences } from "@nova/contracts";
import { SettingsStore } from "../../src/settings/store/settings.store.js";
import { HelperPreferencesHistory } from "../../src/settings/helper-preferences-history.service.js";
import { normalizeHelperPreferences } from "../../src/settings/settings-validation.js";
import type { AuditService } from "../../src/core/audit/audit.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { dbStat } from "../helpers/nova-db.js";

const normalize = (value: HelperPreferences) =>
  normalizeHelperPreferences(value as unknown as Record<string, unknown>);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-helper-history-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { dataFile: (name: string) => path.join(dir, name) };
  const settings = new SettingsStore(config as NovaConfig);
  const record = vi.fn();
  const history = new HelperPreferencesHistory(config as NovaConfig, settings, {
    record,
  } as unknown as AuditService);
  return { dir, settings, record, history };
}

describe("helper preference history", () => {
  it("keeps legacy delivery defaults and rejects unknown notification modes", () => {
    const f = fixture();
    const preferences = normalize(f.settings.get().helperPreferences);
    expect(preferences.notifications).toEqual({
      info: "helper",
      briefing: "speak",
      warning: "speak",
      critical: "speak",
      timer: "speak",
    });
    expect(() =>
      normalize({
        ...preferences,
        notifications: {
          ...preferences.notifications!,
          critical: "email" as never,
        },
      }),
    ).toThrow("Ongeldige meldingsvoorkeur.");
    expect(preferences.rituals).toEqual({
      morning: { enabled: false, time: "08:00" },
      evening: { enabled: false, time: "22:00" },
      checkIn: { enabled: false, afterHours: 4 },
      weeklyOverview: { enabled: false, time: "18:00" },
      dailyHighlight: { enabled: false, time: "20:00" },
      smallSurprises: { enabled: false },
      welcomeHome: { enabled: false },
      calendarReminders: { enabled: false, minutesBefore: 15 },
    });
    const legacy = normalize({
      ...preferences,
      rituals: {
        morning: preferences.rituals!.morning,
        evening: preferences.rituals!.evening,
        checkIn: preferences.rituals!.checkIn,
      },
    } as HelperPreferences);
    expect(legacy.rituals?.calendarReminders).toEqual({
      enabled: false,
      minutesBefore: 15,
    });
    expect(() =>
      normalize({
        ...preferences,
        rituals: {
          ...preferences.rituals!,
          morning: { enabled: true, time: "25:00" },
        },
      }),
    ).toThrow("Ongeldige ritueeltijd.");
  });

  it("stores secret-free bounded revisions with private file permissions", () => {
    const f = fixture();
    const before = normalize(f.settings.get().helperPreferences);
    const after = {
      ...before,
      contrast: !before.contrast,
      rituals: {
        ...before.rituals!,
        morning: { enabled: true, time: "07:30" },
      },
    };
    f.history.record(before, after);
    const listed = f.history.list();
    expect(listed.revisions).toHaveLength(1);
    expect(listed.revisions[0]).toMatchObject({ before, after });
    expect(
      dbStat(path.join(f.dir, "helper-preferences-history.json")).mode & 0o777,
    ).toBe(0o600);
    expect(JSON.stringify(listed)).not.toMatch(
      /secret|token|password|headers/i,
    );
  });

  it("rolls back only while the current values still match and records the inverse", () => {
    const f = fixture();
    const before = normalize(f.settings.get().helperPreferences);
    const after = { ...before, contrast: !before.contrast };
    f.settings.update((next) => {
      next.helperPreferences = after;
    });
    f.history.record(before, after);
    const revision = f.history.list().revisions[0]!;
    expect(f.history.rollback(revision.id).preferences).toEqual(before);
    expect(f.settings.get().helperPreferences).toEqual(before);
    expect(f.history.list().revisions[0]?.revertedFrom).toBe(revision.id);
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: {
          what: "helper_preferences_rollback",
          revision: revision.id,
        },
      }),
    );
  });

  it("rejects a stale rollback after newer settings have been saved", () => {
    const f = fixture();
    const before = normalize(f.settings.get().helperPreferences);
    const after = { ...before, contrast: !before.contrast };
    f.settings.update((next) => {
      next.helperPreferences = after;
    });
    f.history.record(before, after);
    const revision = f.history.list().revisions[0]!;
    f.settings.update((next) => {
      next.helperPreferences = { ...after, autohide: !after.autohide };
    });
    expect(() => f.history.rollback(revision.id)).toThrow(
      "De instellingen zijn daarna gewijzigd.",
    );
  });

  it("retains at most one hundred revisions", () => {
    const f = fixture();
    for (let index = 0; index < 105; index++) {
      const before = normalize(f.settings.get().helperPreferences);
      const after = { ...before, contrast: !before.contrast };
      f.history.record(before, after);
      f.settings.update((next) => {
        next.helperPreferences = after;
      });
    }
    expect(f.history.list().revisions).toHaveLength(50);
    expect(f.history.list().truncated).toBe(true);
  });
});
