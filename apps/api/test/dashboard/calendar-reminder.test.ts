import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarReminderService } from "../../src/dashboard/calendar-reminder.service.js";
import type { CalendarEvent } from "../../src/planning/caldav.service.js";
import { dbStat, stateExists, stateText } from "../helpers/nova-db.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(
  enabled: boolean,
  events: CalendarEvent[] = [],
  configured = true,
  uids: string[] = [],
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-calendar-reminder-"));
  directories.push(dir);
  const record = vi.fn((event: unknown) => {
    void event;
    return { kind: "alert" };
  });
  const upcomingForReminders = vi.fn(async () =>
    events.map((event, index) => ({
      event,
      uid: uids[index] ?? `event-${index}`,
    })),
  );
  const service = new CalendarReminderService(
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
          rituals: {
            morning: { enabled: false, time: "08:00" },
            evening: { enabled: false, time: "22:00" },
            checkIn: { enabled: false, afterHours: 4 },
            weeklyOverview: { enabled: false, time: "18:00" },
            calendarReminders: { enabled, minutesBefore: 15 },
          },
          cues: {
            enabled: true,
            volume: 0.35,
            theme: "soft",
            quiet: { enabled: false, start: "22:00", end: "07:00" },
          },
        },
      }),
    } as never,
    { configured, upcomingForReminders } as never,
    { record } as never,
  );
  return { dir, record, upcoming: upcomingForReminders, service };
}

describe("opt-in calendar reminders", () => {
  it("does not query calendar while reminders are disabled", async () => {
    const f = fixture(false);
    await f.service.checkSchedule(new Date("2026-10-12T07:00:00.000Z"));
    expect(f.upcoming).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(
      stateExists(path.join(f.dir, "calendar-reminders-progress.json")),
    ).toBe(false);
  });

  it("notifies once inside the selected lead time and stores only a private hash", async () => {
    const f = fixture(true, [
      {
        summary: "Private dentist appointment",
        start: "2026-10-12T09:15:00",
        end: "2026-10-12T09:45:00",
        timeZone: "Europe/Amsterdam",
        allDay: false,
      },
    ]);
    const now = new Date("2026-10-12T07:00:00.000Z");
    await f.service.checkSchedule(now);
    await f.service.checkSchedule(now);
    expect(f.record).toHaveBeenCalledOnce();
    expect(f.record.mock.calls[0]?.[0]).toMatchObject({
      topic: "jarvis/alerts",
      payload: {
        title: "Agenda: Private dentist appointment",
        detail: "Begint over 15 minuten.",
        severity: "info",
      },
    });
    const progressPath = path.join(f.dir, "calendar-reminders-progress.json");
    expect(dbStat(progressPath).mode & 0o777).toBe(0o600);
    const progress = stateText(progressPath);
    expect(progress).not.toContain("Private dentist appointment");
    expect(progress).not.toContain("event-0");
    expect(progress).toMatch(/[a-f0-9]{64}/);
  });

  it("keeps same-title events distinct by their stable calendar UIDs", async () => {
    const event: CalendarEvent = {
      summary: "Appointment",
      start: "2026-10-12T09:15:00",
      end: "2026-10-12T09:45:00",
      timeZone: "Europe/Amsterdam",
      allDay: false,
    };
    const f = fixture(true, [event, event], true, ["uid-one", "uid-two"]);
    await f.service.checkSchedule(new Date("2026-10-12T07:00:00.000Z"));
    expect(f.record).toHaveBeenCalledTimes(2);
  });

  it("skips all-day appointments and does not query an unconfigured calendar", async () => {
    const allDay = fixture(true, [
      {
        summary: "Holiday",
        start: "2026-10-12",
        end: "2026-10-13",
        timeZone: null,
        allDay: true,
      },
    ]);
    await allDay.service.checkSchedule(new Date("2026-10-12T07:00:00.000Z"));
    expect(allDay.record).not.toHaveBeenCalled();

    const unavailable = fixture(true, [], false);
    await unavailable.service.checkSchedule(
      new Date("2026-10-12T07:00:00.000Z"),
    );
    expect(unavailable.upcoming).not.toHaveBeenCalled();
  });
});
