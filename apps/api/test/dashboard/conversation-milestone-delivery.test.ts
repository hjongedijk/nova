import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertsFeed } from "../../src/dashboard/alerts-feed.service.js";
import { SmallSurprisesService } from "../../src/dashboard/small-surprises.service.js";
import { ConversationMilestoneService } from "../../src/memory/conversation-milestone.service.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const now = new Date("2026-10-14T08:00:00Z");
function fixture() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nova-milestone-delivery-"),
  );
  dirs.push(dir);
  const flags = {
    enabled: true,
    focused: false,
    quiet: false,
    present: true,
    birthday: "",
  };
  const config = {
    timezone: "Europe/Amsterdam",
    dataFile: (name: string) => path.join(dir, name),
  };
  const settings = {
    get: () => ({
      helperPreferences: {
        autohide: true,
        contrast: false,
        shape: "orb",
        rituals: {
          morning: { enabled: false, time: "08:00" },
          evening: { enabled: false, time: "22:00" },
          checkIn: { enabled: false, afterHours: 4 },
          smallSurprises: { enabled: flags.enabled },
        },
        wardrobe: { theme: "nova", seasonal: false, birthday: flags.birthday },
        cues: {
          enabled: true,
          volume: 0.35,
          theme: "soft",
          quiet: { enabled: flags.quiet, start: "09:00", end: "12:00" },
        },
      },
    }),
  };
  const boot = () => {
    const counter = new ConversationMilestoneService(
      config as never,
      settings as never,
    );
    const feed = new AlertsFeed(
      { onEvent: () => () => {} } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      config as never,
    );
    vi.spyOn(feed, "focusStatus").mockImplementation(
      () => ({ active: flags.focused }) as never,
    );
    const service = new SmallSurprisesService(
      config as never,
      settings as never,
      feed,
      { maySpeak: () => flags.present } as never,
      counter,
    );
    return { counter, feed, service };
  };
  const initial = boot();
  const reach100 = () => {
    for (let i = 0; i < 100; i++) initial.counter.completedTurn();
  };
  return { ...initial, dir, flags, boot, reach100 };
}

describe("durable opt-in conversation milestone delivery", () => {
  it("waits for the hundredth completed turn and delivers once across restart", () => {
    const f = fixture();
    for (let i = 0; i < 99; i++) f.counter.completedTurn();
    f.service.checkSchedule(now);
    expect(f.feed.recent().events).toHaveLength(0);
    f.counter.completedTurn();
    const second = f.boot();
    second.service.checkSchedule(now);
    expect(second.feed.recent().events).toHaveLength(1);
    expect(second.feed.recent().events[0]).toMatchObject({
      title: "Honderd chatbeurten",
      key: "small-surprise-conversation-100",
    });
    expect(second.counter.pending()).toBe(false);
    const third = f.boot();
    third.service.checkSchedule(new Date("2026-10-15T08:00:00Z"));
    expect(third.feed.recent().events).toHaveLength(1);
  });
  it.each(["enabled", "focused", "quiet", "present"] as const)(
    "keeps the milestone pending while %s suppresses delivery",
    (flag) => {
      const f = fixture();
      f.reach100();
      const normal = f.flags[flag];
      f.flags[flag] = !normal;
      f.service.checkSchedule(now);
      expect(f.feed.recent().events).toHaveLength(0);
      expect(f.counter.pending()).toBe(flag !== "enabled");
      f.flags[flag] = normal;
      expect(f.counter.pending()).toBe(true);
      f.service.checkSchedule(now);
      expect(f.feed.recent().events).toHaveLength(1);
    },
  );
  it("respects daytime and gives birthday priority within the shared daily budget", () => {
    const f = fixture();
    f.reach100();
    f.flags.birthday = "10-14";
    f.service.checkSchedule(new Date("2026-10-14T05:00:00Z"));
    expect(f.feed.recent().events).toHaveLength(0);
    f.service.checkSchedule(now);
    expect(f.feed.recent().events.map((e) => e.title)).toEqual([
      "Fijne verjaardag",
    ]);
    expect(f.counter.pending()).toBe(true);
    f.service.checkSchedule(now);
    expect(f.feed.recent().events).toHaveLength(1);
    f.service.checkSchedule(new Date("2026-10-15T08:00:00Z"));
    expect(f.feed.recent().events.map((e) => e.title)).toContain(
      "Honderd chatbeurten",
    );
    expect(f.counter.pending()).toBe(false);
  });
  it("retries a rejected feed acceptance without consuming the milestone", () => {
    const f = fixture();
    f.reach100();
    vi.spyOn(f.feed, "record").mockReturnValueOnce(null);
    f.service.checkSchedule(now);
    expect(f.counter.pending()).toBe(true);
    expect(f.feed.recent().events).toHaveLength(0);
    f.service.checkSchedule(now);
    expect(f.counter.pending()).toBe(false);
    expect(f.feed.recent().events).toHaveLength(1);
  });
  it.each(["conversation-milestone.json", "small-surprises-progress.json"])(
    "recovers accepted receipt after %s acknowledgement fails and history churns",
    (target) => {
      const f = fixture();
      f.reach100();
      const rename = fs.renameSync;
      const failure = vi
        .spyOn(fs, "renameSync")
        .mockImplementation((from, to) => {
          if (String(to) === path.join(f.dir, target))
            throw new Error("synthetic storage failure");
          return rename(from, to);
        });
      f.service.checkSchedule(now);
      expect(f.feed.recent().events).toHaveLength(1);
      expect(f.counter.pending()).toBe(true);
      failure.mockRestore();
      for (let i = 1; i <= 201; i++)
        f.feed.record(
          {
            topic: "jarvis/alerts",
            payload: {
              title: "Synthetic other workflow",
              detail: "",
              severity: "info",
              key: `other-${i}`,
            },
          },
          now,
          `nova-workflow:${i.toString(16).padStart(64, "0")}`,
        );
      const restarted = f.boot();
      const record = vi.spyOn(restarted.feed, "record");
      restarted.service.checkSchedule(now);
      expect(record).not.toHaveBeenCalled();
      expect(restarted.counter.pending()).toBe(false);
    },
  );
  it("a corrupt milestone file does not block an existing birthday occasion", () => {
    const f = fixture();
    f.flags.birthday = "10-14";
    fs.writeFileSync(
      path.join(f.dir, "conversation-milestone.json"),
      "{broken",
    );
    f.service.checkSchedule(now);
    expect(f.feed.recent().events.map((e) => e.title)).toEqual([
      "Fijne verjaardag",
    ]);
  });
});
