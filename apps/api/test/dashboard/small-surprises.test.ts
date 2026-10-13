import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SmallSurprisesService } from "../../src/dashboard/small-surprises.service.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function fixture({
  enabled = true,
  birthday = "10-13",
  focused = false,
  present = true,
  quiet = false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-surprises-"));
  directories.push(dir);
  const record = vi.fn();
  const service = new SmallSurprisesService(
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
          wardrobe: { theme: "nova", seasonal: false, birthday },
          cues: {
            enabled: true,
            volume: 0.35,
            theme: "soft",
            quiet: { enabled: quiet, start: "09:00", end: "12:00" },
          },
          rituals: {
            morning: { enabled: false, time: "08:00" },
            evening: { enabled: false, time: "22:00" },
            checkIn: { enabled: false, afterHours: 4 },
            smallSurprises: { enabled },
          },
        },
      }),
    } as never,
    { record, focusStatus: () => ({ active: focused }) } as never,
    { maySpeak: () => present } as never,
  );
  return { dir, record, service };
}

describe("opt-in small surprises", () => {
  const birthday = new Date("2026-10-13T08:00:00Z");

  it("sends only one fixed birthday line and persists the day privately", () => {
    const { service, record, dir } = fixture();
    service.checkSchedule(new Date("2026-10-13T06:00:00Z"));
    expect(record).not.toHaveBeenCalled();
    service.checkSchedule(birthday);
    service.checkSchedule(birthday);
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0].payload).toMatchObject({
      title: "Fijne verjaardag",
      detail: "Maak er een mooie dag van.",
    });
    const progress = path.join(dir, "small-surprises-progress.json");
    expect(JSON.parse(fs.readFileSync(progress, "utf8"))).toEqual({
      completedDay: "2026-10-13",
    });
    expect(fs.statSync(progress).mode & 0o777).toBe(0o600);
  });

  it("stays quiet without opt-in, during focus, quiet hours or absence", () => {
    for (const options of [
      { enabled: false },
      { focused: true },
      { quiet: true },
      { present: false },
    ]) {
      const { service, record } = fixture(options);
      service.checkSchedule(birthday);
      expect(record).not.toHaveBeenCalled();
    }
  });

  it("uses a public New Year occasion without reading conversation content", () => {
    const { service, record } = fixture({ birthday: "" });
    service.checkSchedule(new Date("2027-01-01T08:00:00Z"));
    expect(record.mock.calls[0]?.[0].payload.title).toBe("Gelukkig nieuwjaar");
  });

  it("pauses on damaged progress instead of repeating an occasion", () => {
    const { service, record, dir } = fixture();
    fs.writeFileSync(
      path.join(dir, "small-surprises-progress.json"),
      "{broken",
    );
    service.checkSchedule(birthday);
    expect(record).not.toHaveBeenCalled();
  });
});
