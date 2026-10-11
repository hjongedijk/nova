import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RitualsService } from "../../src/dashboard/rituals.service.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(rituals: unknown, quiet = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-rituals-"));
  directories.push(dir);
  const record = vi.fn();
  const service = new RitualsService(
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
          rituals,
          cues: {
            enabled: true,
            volume: 0.35,
            theme: "soft",
            quiet: { enabled: quiet, start: "22:00", end: "07:00" },
          },
        },
      }),
    } as never,
    { lastUserMessageAt: () => "2026-10-12T05:00:00.000Z" } as never,
    { maySpeak: () => true } as never,
    { record } as never,
  );
  return { dir, record, service };
}

describe("opt-in assistant rituals", () => {
  it("keeps all rituals off by default", async () => {
    const f = fixture({
      morning: { enabled: false, time: "08:00" },
      evening: { enabled: false, time: "22:00" },
      checkIn: { enabled: false, afterHours: 4 },
    });
    await f.service.checkSchedule(new Date("2026-10-12T06:00:00.000Z"));
    expect(f.record).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.dir, "rituals-progress.json"))).toBe(
      false,
    );
  });

  it("delivers an enabled greeting once and stores private progress", async () => {
    const f = fixture({
      morning: { enabled: true, time: "08:00" },
      evening: { enabled: false, time: "22:00" },
      checkIn: { enabled: false, afterHours: 4 },
    });
    const now = new Date("2026-10-12T06:00:00.000Z");
    await f.service.checkSchedule(now);
    await f.service.checkSchedule(now);
    expect(f.record).toHaveBeenCalledTimes(1);
    expect(f.record.mock.calls[0]?.[0].payload.title).toBe("Goedemorgen");
    expect(
      fs.statSync(path.join(f.dir, "rituals-progress.json")).mode & 0o777,
    ).toBe(0o600);
  });

  it("does not issue a silence check-in before the threshold", async () => {
    const rituals = {
      morning: { enabled: false, time: "08:00" },
      evening: { enabled: false, time: "22:00" },
      checkIn: { enabled: true, afterHours: 6 },
    };
    const f = fixture(rituals, true);
    await f.service.checkSchedule(new Date("2026-10-12T10:00:00.000Z"));
    expect(f.record).not.toHaveBeenCalled();
  });

  it("sends an enabled long-silence check-in only once", async () => {
    const f = fixture({
      morning: { enabled: false, time: "08:00" },
      evening: { enabled: false, time: "22:00" },
      checkIn: { enabled: true, afterHours: 6 },
    });
    const now = new Date("2026-10-12T13:00:00.000Z");
    await f.service.checkSchedule(now);
    await f.service.checkSchedule(now);
    expect(f.record).toHaveBeenCalledTimes(1);
    expect(f.record.mock.calls[0]?.[0].payload.title).toBe("Even inchecken");
  });

  it("suppresses a scheduled greeting during configured quiet hours", async () => {
    const f = fixture(
      {
        morning: { enabled: true, time: "06:30" },
        evening: { enabled: false, time: "22:00" },
        checkIn: { enabled: false, afterHours: 4 },
      },
      true,
    );
    await f.service.checkSchedule(new Date("2026-10-12T04:30:00.000Z"));
    expect(f.record).not.toHaveBeenCalled();
  });
});
