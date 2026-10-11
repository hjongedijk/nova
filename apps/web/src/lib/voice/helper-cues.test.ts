import { describe, expect, it } from "vitest";
import { canSpeakFeedEvent, cueQuiet } from "./helper-cues.ts";

describe("quiet-hour schedule", () => {
  const preferences = {
    enabled: true,
    volume: 0.35,
    theme: "soft" as const,
    quiet: { enabled: true, start: "22:00", end: "07:00" },
  };

  it("uses normal volume while browser preferences are still loading", () => {
    expect(cueQuiet(undefined, new Date(2026, 9, 11, 12, 0))).toBe(false);
  });

  it("covers schedules that cross midnight", () => {
    expect(cueQuiet(preferences, new Date(2026, 9, 11, 23, 0))).toBe(true);
    expect(cueQuiet(preferences, new Date(2026, 9, 11, 6, 59))).toBe(true);
    expect(cueQuiet(preferences, new Date(2026, 9, 11, 7, 0))).toBe(false);
    expect(cueQuiet(preferences, new Date(2026, 9, 11, 12, 0))).toBe(false);
  });

  it("treats equal start and end times as quiet all day", () => {
    expect(
      cueQuiet(
        {
          ...preferences,
          quiet: { enabled: true, start: "08:00", end: "08:00" },
        },
        new Date(2026, 9, 11, 14, 0),
      ),
    ).toBe(true);
  });

  it("fails silent for an invalid enabled schedule", () => {
    expect(
      cueQuiet(
        {
          ...preferences,
          quiet: { enabled: true, start: "bad", end: "07:00" },
        },
        new Date(2026, 9, 11, 12, 0),
      ),
    ).toBe(true);
  });

  it("keeps feed events silent when paused, busy, or in quiet hours", () => {
    const daytime = new Date(2026, 9, 11, 12, 0);
    const quietTime = new Date(2026, 9, 11, 23, 0);
    expect(canSpeakFeedEvent(false, false, preferences, daytime)).toBe(true);
    expect(canSpeakFeedEvent(true, false, preferences, daytime)).toBe(false);
    expect(canSpeakFeedEvent(false, true, preferences, daytime)).toBe(false);
    expect(canSpeakFeedEvent(false, false, preferences, quietTime)).toBe(false);
  });
});
