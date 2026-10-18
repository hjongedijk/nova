import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Finding, ScanName } from "../../src/autopilot/autopilot.types.js";
import { HOUR, MIN, NOON, rig, titles, type Rig } from "./harness.js";

const rigs: Rig[] = [];
const make = (start = NOON) => {
  const r = rig(start);
  rigs.push(r);
  return r;
};
afterEach(() => {
  for (const r of rigs.splice(0))
    fs.rmSync(r.dir, { recursive: true, force: true });
});

let n = 0;
const nudge = (scan: ScanName): Finding => ({
  id: `f${++n}`,
  scan,
  urgency: "info",
  key: `${scan}:${n}`,
  cooldownMinutes: 60,
  title: "t",
  detail: "d",
});

/** Delivers one nudge per entry (an hour apart) and reacts to each. */
async function react(
  r: Rig,
  entries: [ScanName, "dismissed" | "acted" | "stopped"][],
) {
  for (const [scan, reaction] of entries) {
    const f = nudge(scan);
    expect(await r.service.deliver(f)).toBe("gemeld");
    r.service.react({ id: f.id }, reaction);
    r.clock.t += HOUR;
  }
}

const tuningNotes = (r: Rig) =>
  r.service
    .activity()
    .filter((a) => a.kind === "tuning")
    .map((a) => a.outcome);

describe("self-tuning from owner reactions", () => {
  it("lowers the daily budget after repeated dismissals, logs it and persists it", async () => {
    const r = make();
    await react(r, [
      ["calendar", "dismissed"],
      ["home", "dismissed"],
      ["health", "dismissed"],
      ["nudges", "dismissed"],
    ]);
    expect(r.service.settings.dailyBudget).toBe(9);
    expect(tuningNotes(r)).toEqual([
      expect.stringContaining("dagbudget 10 naar 9"),
    ]);
    expect(r.restart().settings.dailyBudget).toBe(9);
  });

  it("recovers towards the owner's value when nudges are acted on, never above it", async () => {
    const r = make();
    await react(r, [
      ["calendar", "dismissed"],
      ["home", "dismissed"],
      ["health", "dismissed"],
      ["nudges", "dismissed"],
      ["calendar", "acted"],
      ["home", "acted"],
      ["health", "acted"],
    ]);
    expect(r.service.settings.dailyBudget).toBe(10);
    await react(r, [
      ["calendar", "acted"],
      ["home", "acted"],
      ["health", "acted"],
    ]);
    expect(r.service.settings.dailyBudget).toBe(10);
  });

  it("an owner change becomes the new ceiling", async () => {
    const r = make();
    await react(r, [
      ["calendar", "dismissed"],
      ["home", "dismissed"],
      ["health", "dismissed"],
      ["nudges", "dismissed"],
    ]);
    r.service.updateSettings({ dailyBudget: 8 });
    await react(r, [
      ["calendar", "acted"],
      ["home", "acted"],
      ["health", "acted"],
    ]);
    expect(r.service.settings.dailyBudget).toBe(8);
  });

  it("makes a brushed-off kind of nudge come back less often", async () => {
    const r = make();
    await react(r, Array(4).fill(["calendar", "dismissed"]));
    expect(r.service.status().tuning.cooldownFactor).toEqual({ calendar: 2 });
    expect(tuningNotes(r).join()).toContain("'calendar'");
    // The cooldown of the same key is now doubled.
    const f = { ...nudge("calendar"), key: "calendar:same" };
    expect(await r.service.deliver(f)).toBe("gemeld");
    r.clock.t += 90 * MIN;
    expect(await r.service.deliver(f)).toBe("cooldown");
    r.clock.t += 40 * MIN;
    expect(await r.service.deliver(f)).toBe("gemeld");
  });

  it("widens the quiet hours when late nudges keep being dismissed", async () => {
    const r = make(NOON + 10 * HOUR + 20 * MIN); // 22:20 local
    for (const scan of ["calendar", "home", "health"] as const) {
      const f = nudge(scan);
      expect(await r.service.deliver(f)).toBe("gemeld");
      r.service.react({ id: f.id }, "dismissed");
    }
    expect(r.service.settings.quiet.start).toBe("22:30");
    expect(tuningNotes(r).join()).toContain("stille uren starten eerder");
  });

  it("counts nudges nobody answered in a day as ignored", async () => {
    const r = make();
    for (let i = 0; i < 3; i++)
      expect(await r.service.deliver({ ...nudge("home"), key: `k${i}` })).toBe(
        "gemeld",
      );
    r.clock.t += 25 * HOUR;
    await r.service.scan();
    expect(r.service.status().tuning.awaitingReaction).toBe(0);
    expect(
      (r.service as unknown as { file: { tuning: { reactions: unknown[] } } })
        .file.tuning.reactions.length,
    ).toBe(3);
  });

  it("'doe dat niet meer' right after a nudge mutes that nudge", async () => {
    const r = make();
    r.world.events = [
      {
        summary: "Tandarts",
        start: new Date(NOON + 20 * MIN).toISOString(),
        end: null,
        timeZone: null,
        allDay: false,
      },
    ];
    await r.service.scan();
    expect(titles(r.world)).toEqual(["Straks: Tandarts"]);
    r.clock.t += 10 * MIN;
    expect(r.service.react({}, "stopped")).toEqual({ recorded: true });
    expect(r.service.status().tuning.mutedNudges).toBe(1);
    expect(tuningNotes(r).join()).toContain("doe dat niet meer");
    // Even once the cooldown has passed, that nudge stays quiet.
    r.clock.t += 2 * HOUR;
    const [key] = Object.keys(
      (
        r.service as unknown as {
          file: { tuning: { mutedKeys: Record<string, number> } };
        }
      ).file.tuning.mutedKeys,
    );
    expect(await r.service.deliver({ ...nudge("calendar"), key: key! })).toBe(
      "gedempt",
    );
  });

  it("ignores a stop correction when no nudge preceded it", () => {
    const r = make();
    expect(r.service.react({}, "stopped")).toEqual({ recorded: false });
  });

  it("listens to the correction learner", () => {
    const r = make();
    const listeners: ((e: { signal: { stop: boolean } }) => void)[] = [];
    (r.service as unknown as { learner: unknown }).learner = {
      onCorrection: (l: never) => listeners.push(l),
    };
    const spy = vi.spyOn(r.service, "react");
    r.service.onModuleInit();
    listeners[0]!({ signal: { stop: true } });
    listeners[0]!({ signal: { stop: false } });
    r.service.onModuleDestroy();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("LAN discovery scan", () => {
  const candidate = {
    id: "home_assistant@192.168.1.5:8123",
    service: "home_assistant",
    name: "Home Assistant",
    host: "192.168.1.5",
    port: 8123,
    url: "http://192.168.1.5:8123",
    auth: "token",
    apiConnect: false,
    firstSeen: 0,
    lastSeen: 0,
    state: "new",
  };

  it("proposes what it found once, in one line, and never connects", async () => {
    const r = make();
    const markProposed = vi.fn();
    (r.service as unknown as { discovery: unknown }).discovery = {
      scan: async () => ({ scanned: true, candidates: [candidate] }),
      proposals: () => [candidate],
      markProposed,
    };
    await r.service.scan();
    expect(titles(r.world)).toContain("Ik vond Home Assistant op 192.168.1.5");
    expect(markProposed).toHaveBeenCalledWith(candidate.id);
    expect(r.world.toolCalls.every((c) => c.name !== "api_connect")).toBe(true);
    r.clock.t += 10 * MIN;
    r.world.alerts.length = 0;
    await r.service.scan();
    expect(titles(r.world)).not.toContain(
      "Ik vond Home Assistant op 192.168.1.5",
    );
  });

  it("is silent without a discovery service", async () => {
    const r = make();
    await r.service.scan();
    expect(titles(r.world).join()).not.toContain("Ik vond");
  });
});
