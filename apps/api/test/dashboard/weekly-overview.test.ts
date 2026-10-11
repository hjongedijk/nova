import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dueWeeklyWindow,
  WeeklyOverviewService,
} from "../../src/dashboard/weekly-overview.service.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(enabled: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-weekly-"));
  directories.push(dir);
  const record = vi.fn();
  const auditRecord = vi.fn();
  let receivedOptions: unknown;
  const call = vi.fn(async (messages: unknown, options: unknown) => {
    void messages;
    receivedOptions = options;
    return {
      assistant: {
        content:
          "Goed gegaan: taken afgerond. Aandacht: geen. Komende week: afspraak dinsdag.",
      },
    };
  });
  const service = new WeeklyOverviewService(
    {
      timezone: "Europe/Amsterdam",
      dataFile: (name: string) => path.join(dir, name),
    } as never,
    {
      get: () => ({
        helperPreferences: {
          autohide: true,
          contrast: false,
          shape: "orb",
          cues: {
            enabled: true,
            volume: 0.35,
            theme: "soft",
            quiet: { enabled: false, start: "22:00", end: "07:00" },
          },
          rituals: {
            morning: { enabled: false, time: "08:00" },
            evening: { enabled: false, time: "22:00" },
            checkIn: { enabled: false, afterHours: 4 },
            weeklyOverview: { enabled, time: "18:00" },
          },
        },
      }),
    } as never,
    {
      allMessages: () => [
        {
          role: "user",
          content: "Ik heb mijn project afgerond.",
          at: "2026-10-08T12:00:00.000Z",
        },
      ],
    } as never,
    {
      read: () => [
        {
          tool: "list_add",
          timestamp: "2026-10-08T12:00:00.000Z",
          result: { ok: true },
        },
      ],
      record: auditRecord,
    } as never,
    {
      configured: true,
      upcoming: async () => [
        { summary: "Afspraak", start: "2026-10-13T09:00:00Z", allDay: false },
      ],
    } as never,
    {
      preferredModelForRole: () => "free-summary",
      assertRoleModel: vi.fn(),
    } as never,
    { call } as never,
    { record } as never,
  );
  return {
    dir,
    record,
    auditRecord,
    call,
    options: () => receivedOptions,
    service,
  };
}

describe("opt-in weekly overview", () => {
  it("uses local Monday-Sunday dates and waits until Sunday time", () => {
    expect(
      dueWeeklyWindow(new Date("2026-10-11T15:59:00Z"), "Europe/Amsterdam"),
    ).toBeNull();
    expect(
      dueWeeklyWindow(new Date("2026-10-11T16:00:00Z"), "Europe/Amsterdam"),
    ).toEqual({
      key: "2026-10-11",
      start: "2026-10-05",
      end: "2026-10-11",
    });
    expect(
      dueWeeklyWindow(new Date("2026-10-12T07:00:00Z"), "Europe/Amsterdam")
        ?.key,
    ).toBe("2026-10-11");
  });

  it("stays off by default and sends one free-role digest when enabled", async () => {
    const disabled = fixture(false);
    await disabled.service.checkSchedule(new Date("2026-10-11T16:00:00Z"));
    expect(disabled.call).not.toHaveBeenCalled();

    const enabled = fixture(true);
    const now = new Date("2026-10-11T16:00:00Z");
    await enabled.service.checkSchedule(now);
    await enabled.service.checkSchedule(now);
    expect(enabled.call).toHaveBeenCalledTimes(1);
    expect(enabled.options()).toMatchObject({
      roleModel: { role: "summary", modelId: "free-summary" },
      tools: [],
    });
    expect(enabled.record).toHaveBeenCalledTimes(1);
    expect(enabled.record.mock.calls[0]?.[0].payload.title).toBe(
      "Je weekoverzicht",
    );
    expect(enabled.auditRecord).toHaveBeenCalledOnce();
    expect(enabled.auditRecord.mock.calls[0]?.[0]).toMatchObject({
      tool: "proactive_weekly_overview",
      risk: "READ_ONLY",
      phase: "completed",
      arguments: { week: "2026-10-11" },
      result: { ok: true },
    });
    const logged = JSON.stringify(enabled.auditRecord.mock.calls[0]?.[0]);
    expect(logged).not.toContain("taken afgerond");
    expect(logged).not.toContain("Afspraak");
    const progress = path.join(enabled.dir, "weekly-overview-progress.json");
    expect(JSON.parse(fs.readFileSync(progress, "utf8"))).toEqual({
      completedWeek: "2026-10-11",
    });
    expect(fs.statSync(progress).mode & 0o777).toBe(0o600);
  });
});
