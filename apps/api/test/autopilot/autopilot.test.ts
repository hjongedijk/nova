import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { applySettings } from "../../src/autopilot/autopilot.store.js";
import { DEFAULT_SETTINGS } from "../../src/autopilot/autopilot.types.js";
import {
  entity,
  event,
  HOUR,
  MIN,
  NIGHT,
  NOON,
  rig,
  titles,
  type Rig,
} from "./harness.js";

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

describe("(a) calendar", () => {
  it("reminds once for an event starting within 30 minutes", async () => {
    const r = make();
    r.world.events = [event("Tandarts", NOON + 20 * MIN)];
    await r.service.scan();
    expect(titles(r.world)).toEqual(["Straks: Tandarts"]);
    expect(r.world.alerts[0]!.payload).toMatchObject({
      severity: "info",
      detail: expect.stringContaining("20 minuten"),
    });
    r.clock.t += 5 * MIN;
    await r.service.scan();
    r.clock.t += 5 * MIN;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(1);
  });

  it("ignores events that are too far away, already started or all-day", async () => {
    const r = make();
    r.world.events = [
      event("Later", NOON + 45 * MIN),
      event("Al bezig", NOON - 5 * MIN),
      { ...event("Hele dag", NOON + 10 * MIN), allDay: true },
    ];
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(0);
  });

  it("is silent when the calendar is not configured", async () => {
    const r = make();
    r.world.calendarConfigured = false;
    r.world.events = [event("x", NOON + 10 * MIN)];
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(0);
  });

  it("skips quietly when the tool does not exist", async () => {
    const r = make();
    delete r.world.tools.calendar_events;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(0);
  });
});

describe("(b) Home Assistant", () => {
  const scans = async (r: Rig, n: number) => {
    for (let i = 0; i < n; i++) {
      await r.service.scan();
      r.clock.t += 5 * MIN;
    }
  };

  it("needs two consecutive scans before a device counts as gone", async () => {
    const r = make();
    r.world.entities = [entity("light.hal", "unavailable", "Hallamp")];
    await scans(r, 1);
    expect(r.world.alerts).toHaveLength(0);
    await scans(r, 1);
    expect(titles(r.world)).toEqual(["Hallamp reageert niet meer"]);
    expect(r.world.alerts[0]!.payload.severity).toBe("warning");
  });

  it("ignores flapping devices", async () => {
    const r = make();
    for (const state of [
      "unavailable",
      "on",
      "unavailable",
      "on",
      "unavailable",
    ]) {
      r.world.entities = [entity("light.hal", state)];
      await scans(r, 1);
    }
    expect(r.world.alerts).toHaveLength(0);
  });

  it("announces a device only once while it stays gone", async () => {
    const r = make();
    r.world.entities = [entity("switch.pomp", "unavailable")];
    await scans(r, 6);
    expect(r.world.alerts).toHaveLength(1);
  });

  it("groups many devices into one message about the hub", async () => {
    const r = make();
    r.world.entities = ["a", "b", "c", "d", "e"].map((n) =>
      entity(`light.${n}`, "unavailable"),
    );
    await scans(r, 2);
    expect(titles(r.world)).toEqual(["5 apparaten reageren niet meer"]);
  });

  it("does not count Home Assistant being unreachable as devices vanishing", async () => {
    const r = make();
    r.world.entities = [entity("light.hal", "unavailable")];
    await scans(r, 1);
    r.world.haOk = false;
    await scans(r, 3);
    expect(r.world.alerts).toHaveLength(0);
  });

  it("does not watch sensors, trackers or unknown states", async () => {
    const r = make();
    r.world.entities = [
      entity("sensor.temp", "unavailable"),
      entity("device_tracker.telefoon", "unavailable"),
      entity("light.hal", "unknown"),
    ];
    await scans(r, 3);
    expect(r.world.alerts).toHaveLength(0);
  });
});

describe("(c) NOVA's own health", () => {
  it("explains a blocked routing in plain language", async () => {
    const r = make();
    r.world.routing = { ready: false, status: "POLICY_CHANGE_PENDING" };
    await r.service.scan();
    expect(titles(r.world)).toEqual(["Ik mag nu geen modellen gebruiken"]);
    expect(String(r.world.alerts[0]!.payload.detail)).toMatch(
      /gecontroleerd.*Instellingen/s,
    );
  });

  it("stays quiet when routing is ready", async () => {
    const r = make();
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(0);
  });

  it("reports an unregistered trunk only when telephony is on and the trunk is offline", async () => {
    const r = make();
    r.world.telephony.ready = {
      ready: false,
      reason: "de trunk is niet geregistreerd",
    };
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(0);
    r.world.telephony.enabled = true;
    r.clock.t += 5 * MIN;
    await r.service.scan();
    expect(titles(r.world)).toEqual(["Mijn telefoonlijn is niet verbonden"]);
  });

  it("heals a stopped MCP worker by reconnecting it, without alerting", async () => {
    const r = make();
    r.world.mcp = [{ id: "filesystem", enabled: true, connected: false }];
    r.world.mcpRefreshHeals = true;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(0);
    expect(r.world.mcp[0]!.connected).toBe(true);
    expect(r.service.status().activity.some((a) => a.kind === "heal")).toBe(
      true,
    );
  });

  it("alerts when the worker stays down, and does not retry the heal every scan", async () => {
    const r = make();
    r.world.mcp = [{ id: "filesystem", enabled: true, connected: false }];
    await r.service.scan();
    expect(titles(r.world)).toEqual(["Hulpprogramma filesystem draait niet"]);
    r.clock.t += 5 * MIN;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(1);
  });

  it("never heals when self-heal is off, and ignores disabled workers", async () => {
    const r = make();
    r.service.updateSettings({ selfHeal: false });
    r.world.mcp = [
      { id: "a", enabled: true, connected: false },
      { id: "b", enabled: false, connected: false },
    ];
    r.world.mcpRefreshHeals = true;
    await r.service.scan();
    expect(r.world.mcp[0]!.connected).toBe(false);
    expect(titles(r.world)).toEqual(["Hulpprogramma a draait niet"]);
  });

  it("refreshes a stale Home Assistant link first and alerts only if it persists for two scans", async () => {
    const healed = make();
    healed.world.ha = { configured: true, stale: true };
    healed.world.haSyncHeals = true;
    await healed.service.scan();
    expect(healed.world.alerts).toHaveLength(0);

    const stuck = make();
    stuck.world.ha = { configured: true, stale: true };
    await stuck.service.scan();
    expect(stuck.world.alerts).toHaveLength(0);
    stuck.clock.t += 5 * MIN;
    await stuck.service.scan();
    expect(titles(stuck.world)).toEqual(["Home Assistant reageert niet"]);
  });

  it("warns about a nearly full disk, urgent below 5 percent", async () => {
    const warn = make();
    warn.world.disk = 10;
    await warn.service.scan();
    expect(warn.world.alerts[0]!.payload).toMatchObject({
      severity: "warning",
    });
    const urgent = make();
    urgent.world.disk = 3;
    await urgent.service.scan();
    expect(urgent.world.alerts[0]!.payload).toMatchObject({
      severity: "critical",
    });
  });
});

describe("(d) nudges", () => {
  it("nudges once about a run that has waited longer than 30 minutes", async () => {
    const r = make();
    r.world.runs = [
      {
        id: "r1",
        goal: "zoek de beste router uit",
        status: "waiting",
        updatedAt: NOON - 45 * MIN,
        waiting: { kind: "approval", text: "mag ik?" },
      },
    ];
    await r.service.scan();
    expect(titles(r.world)).toEqual(["Een taak wacht op jou"]);
    expect(String(r.world.alerts[0]!.payload.detail)).toContain("goedkeuring");
    r.clock.t += 5 * MIN;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(1);
  });

  it("leaves fresh runs alone", async () => {
    const r = make();
    r.world.runs = [
      { id: "r1", goal: "x y z", status: "waiting", updatedAt: NOON - 5 * MIN },
      { id: "r2", goal: "klaar", status: "done", updatedAt: NOON - 500 * MIN },
    ];
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(0);
  });

  it("nudges about an objective anomaly that is still open after 30 minutes", async () => {
    const r = make();
    r.world.objectives = [
      {
        id: "o1",
        title: "Houd de garage in de gaten",
        enabled: true,
        active: { since: NOON - 50 * MIN, dismissed: false },
      },
      {
        id: "o2",
        title: "Gedempt",
        enabled: true,
        active: { since: NOON - 90 * MIN, dismissed: true },
      },
    ];
    await r.service.scan();
    expect(titles(r.world)).toEqual([
      "Nog niet opgelost: Houd de garage in de gaten",
    ]);
  });
});

describe("(e) today", () => {
  it("gives one morning heads-up about open tasks, after 08:00 local", async () => {
    const early = make(Date.UTC(2026, 9, 17, 5, 30)); // 07:30 local
    early.world.listItems = 3;
    await early.service.scan();
    expect(early.world.alerts).toHaveLength(0);

    const r = make();
    r.world.listItems = 3;
    r.world.timers = 1;
    await r.service.scan();
    expect(r.world.alerts[0]!.payload.detail).toContain(
      "3 open taken en 1 lopende timer",
    );
    r.clock.t += 5 * MIN;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(1);
  });

  it("stays silent with nothing open or without the tools", async () => {
    const r = make();
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(0);
    delete r.world.tools.list_show;
    delete r.world.tools.timer_list;
    r.world.listItems = 5;
    r.clock.t += 5 * MIN;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(0);
  });
});

describe("read-only guarantee", () => {
  it("runs every scan tool with readOnlyOnly", async () => {
    const r = make();
    r.world.events = [event("x", NOON + 10 * MIN)];
    r.world.listItems = 1;
    await r.service.scan();
    const scanCalls = r.world.toolCalls.filter(
      (c) => c.session === "autopilot",
    );
    expect(scanCalls.length).toBeGreaterThan(2);
    expect(scanCalls.every((c) => c.readOnlyOnly === true)).toBe(true);
  });
});

describe("dedupe and cooldown", () => {
  it("announces again after the cooldown has passed", async () => {
    const r = make();
    r.world.routing = { ready: false, status: "POLICY_UNAVAILABLE" };
    await r.service.scan();
    r.clock.t += 5 * HOUR;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(1);
    r.clock.t += 2 * HOUR; // 6h cooldown passed
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(2);
  });

  it("gives different problems different keys", async () => {
    const r = make();
    r.world.routing = { ready: false, status: "POLICY_UNAVAILABLE" };
    await r.service.scan();
    r.world.routing = { ready: false, status: "GATEWAY_PROVENANCE_UNVERIFIED" };
    r.clock.t += 5 * MIN;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(2);
  });
});

describe("quiet hours", () => {
  it("holds non-urgent findings at night and delivers them when quiet hours end", async () => {
    const r = make(NIGHT);
    r.world.routing = { ready: false, status: "POLICY_UNAVAILABLE" };
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(0);
    expect(r.service.status().findings[0]!.outcome).toBe("stil");
    // 07:05 local the next morning.
    r.clock.t = Date.UTC(2026, 9, 18, 5, 5);
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(1);
  });

  it("lets urgent findings through at night", async () => {
    const r = make(NIGHT);
    r.world.disk = 2;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(1);
    expect(r.world.alerts[0]!.payload.severity).toBe("critical");
  });

  it("can be switched off", async () => {
    const r = make(NIGHT);
    r.service.updateSettings({ quiet: { enabled: false } });
    r.world.routing = { ready: false, status: "POLICY_UNAVAILABLE" };
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(1);
  });

  it("logs a held finding once, not on every scan", async () => {
    const r = make(NIGHT);
    r.world.routing = { ready: false, status: "POLICY_UNAVAILABLE" };
    for (let i = 0; i < 4; i++) {
      await r.service.scan();
      r.clock.t += 5 * MIN;
    }
    expect(
      r.service.status().activity.filter((a) => a.kind === "suppressed"),
    ).toHaveLength(1);
  });
});

describe("budget and rate limit", () => {
  const manyProblems = (r: Rig, n: number) => {
    r.world.entities = Array.from({ length: n }, (_, i) =>
      entity(`light.l${i}`, "unavailable", `Lamp ${i}`),
    ).slice(0, 3);
  };

  it("stops at the global rate limit of 3 per hour", async () => {
    const r = make();
    manyProblems(r, 3);
    r.world.events = [event("Overleg", NOON + 20 * MIN)];
    await r.service.scan();
    r.clock.t += 5 * MIN;
    await r.service.scan(); // lamps now ripe: 3 lamps + calendar already sent
    expect(r.world.alerts).toHaveLength(3);
    expect(
      r.service.status().findings.filter((f) => f.outcome === "limiet").length,
    ).toBeGreaterThan(0);
    r.clock.t += 61 * MIN;
    await r.service.scan();
    expect(r.world.alerts.length).toBeGreaterThan(3);
  });

  it("stops at the daily budget and resets the next day", async () => {
    const r = make();
    r.service.updateSettings({ dailyBudget: 2, hourlyLimit: 30 });
    manyProblems(r, 3);
    await r.service.scan();
    r.clock.t += 5 * MIN;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(2);
    expect(r.service.status().initiativesToday).toBe(2);
    expect(
      r.service.status().findings.some((f) => f.outcome === "budget"),
    ).toBe(true);
    // next local day, noon
    r.clock.t += 24 * HOUR;
    await r.service.scan();
    expect(r.service.status().initiativesToday).toBeGreaterThan(0);
    expect(r.world.alerts.length).toBeGreaterThan(2);
  });

  it("lets urgent findings use double the budget", async () => {
    const r = make();
    r.service.updateSettings({ dailyBudget: 1, hourlyLimit: 30 });
    r.world.routing = { ready: false, status: "POLICY_UNAVAILABLE" };
    await r.service.scan(); // uses the 1
    r.world.disk = 1;
    r.clock.t += 5 * MIN;
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(2);
  });
});

describe("restart persistence", () => {
  it("keeps due time, dedupe memory and counters in a 0600 autopilot.json", async () => {
    const r = make();
    r.world.events = [event("Tandarts", NOON + 20 * MIN)];
    await r.service.scan();
    const file = r.store.file;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    r.clock.t += 2 * MIN;
    const restarted = r.restart();
    expect(restarted.status().initiativesToday).toBe(1);
    // Not due yet: the stored schedule survived.
    await restarted.tick();
    expect(r.world.alerts).toHaveLength(1);
    expect(
      (JSON.parse(fs.readFileSync(file, "utf8")) as { nextDueAt: number })
        .nextDueAt,
    ).toBe(NOON + 5 * MIN);
    // Due now: runs, but the same event is not announced twice.
    r.clock.t = NOON + 6 * MIN;
    await restarted.tick();
    expect(r.world.alerts).toHaveLength(1);
    expect(restarted.status().lastScanAt).toBe(
      new Date(NOON + 6 * MIN).toISOString(),
    );
  });

  it("schedules the first scan shortly after a fresh start", () => {
    const r = make();
    expect(r.service.status().nextDueAt).toBe(
      new Date(NOON + r.service.firstScanDelayMs).toISOString(),
    );
    expect(r.service.status().enabled).toBe(true);
  });

  it("survives a corrupt file by falling back to defaults", () => {
    const r = make();
    fs.writeFileSync(r.store.file, "{not json");
    const again = r.restart();
    expect(again.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("kill switch and settings", () => {
  it("does nothing when disabled and resumes when enabled again", async () => {
    const r = make();
    r.world.routing = { ready: false, status: "POLICY_UNAVAILABLE" };
    r.service.setEnabled(false);
    r.clock.t += HOUR;
    await r.service.tick();
    expect(r.world.alerts).toHaveLength(0);
    expect(r.service.status().enabled).toBe(false);
    expect(r.service.status().nextDueAt).toBeNull();
    // the switch itself is remembered across a restart
    expect(r.restart().settings.enabled).toBe(false);
    r.service.setEnabled(true);
    r.clock.t += 2 * MIN;
    await r.service.tick();
    expect(r.world.alerts).toHaveLength(1);
  });

  it("validates settings and rejects nonsense", () => {
    expect(() =>
      applySettings(DEFAULT_SETTINGS, { dailyBudget: -1 }),
    ).toThrow();
    expect(() =>
      applySettings(DEFAULT_SETTINGS, { quiet: { start: "25:99" } }),
    ).toThrow();
    expect(() =>
      applySettings(DEFAULT_SETTINGS, { quiet: { timezone: "Mars/Base" } }),
    ).toThrow();
    expect(() =>
      applySettings(DEFAULT_SETTINGS, { scans: { nope: true } }),
    ).toThrow();
    expect(() =>
      applySettings(DEFAULT_SETTINGS, { allowCalls: "ja" }),
    ).toThrow();
    expect(() => applySettings(DEFAULT_SETTINGS, "x")).toThrow();
    const next = applySettings(DEFAULT_SETTINGS, {
      dailyBudget: 4,
      quiet: { start: "22:00" },
      scans: { home: false },
    });
    expect(next).toMatchObject({
      dailyBudget: 4,
      quiet: { start: "22:00", end: "07:00" },
      scans: { home: false, calendar: true },
    });
  });

  it("skips a scan that is switched off", async () => {
    const r = make();
    r.service.updateSettings({ scans: { calendar: false } });
    r.world.events = [event("x", NOON + 10 * MIN)];
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(0);
  });

  it("defaults: enabled, 5 minutes, quiet 23:00-07:00 Amsterdam, budget 10, 3 per hour, text only", () => {
    const r = make();
    expect(r.service.settings).toMatchObject({
      enabled: true,
      intervalMinutes: 5,
      quiet: {
        enabled: true,
        start: "23:00",
        end: "07:00",
        timezone: "Europe/Amsterdam",
      },
      dailyBudget: 10,
      hourlyLimit: 3,
      allowCalls: false,
      textContacts: true,
    });
  });
});

describe("activity log", () => {
  it("is capped at 200 entries and holds metadata only", async () => {
    const r = make();
    r.world.events = [event("Geheime afspraak met Truus", NOON + 20 * MIN)];
    for (let i = 0; i < 120; i++) {
      await r.service.scan();
      r.clock.t += 5 * MIN;
    }
    const log = r.service.activity();
    expect(log.length).toBe(200);
    const text =
      JSON.stringify(log) +
      fs.readFileSync(r.store.file, "utf8").split('"lastFindings"')[0]!;
    expect(text).not.toContain("Truus");
    expect(text).not.toContain("Geheime");
  });
});

describe("delivery by text and call", () => {
  it("texts saved contacts that may talk with NOVA, only when telephony is ready", async () => {
    const r = make();
    r.world.telephony = {
      enabled: true,
      ready: { ready: true },
      contacts: ["Harm"],
      failText: false,
    };
    r.world.events = [event("Tandarts", NOON + 20 * MIN)];
    await r.service.scan();
    expect(r.world.texts).toHaveLength(1);
    expect(r.world.texts[0]).toMatchObject({ to: "Harm" });
    expect(r.world.texts[0]!.body).toMatch(/^NOVA: Straks: Tandarts\./);
    expect(r.phoneCalls).toHaveLength(0);
  });

  it("does not text when telephony is off, not registered or the setting is off", async () => {
    const off = make();
    off.world.telephony.contacts = ["Harm"];
    off.world.events = [event("A", NOON + 20 * MIN)];
    await off.service.scan();
    expect(off.world.texts).toHaveLength(0);

    const down = make();
    down.world.telephony = {
      enabled: true,
      ready: { ready: false, reason: "Asterisk is niet bereikbaar" },
      contacts: ["Harm"],
      failText: false,
    };
    down.world.events = [event("A", NOON + 20 * MIN)];
    await down.service.scan();
    expect(down.world.texts).toHaveLength(0);
    expect(down.world.alerts).toHaveLength(1);

    const muted = make();
    muted.service.updateSettings({ textContacts: false });
    muted.world.telephony = {
      enabled: true,
      ready: { ready: true },
      contacts: ["Harm"],
      failText: false,
    };
    muted.world.events = [event("A", NOON + 20 * MIN)];
    await muted.service.scan();
    expect(muted.world.texts).toHaveLength(0);
  });

  it("respects the minimum urgency for texts and survives a failing send", async () => {
    const r = make();
    r.service.updateSettings({ textMinUrgency: "warn" });
    r.world.telephony = {
      enabled: true,
      ready: { ready: true },
      contacts: ["Harm"],
      failText: true,
    };
    r.world.events = [event("Info", NOON + 20 * MIN)];
    r.world.routing = { ready: false, status: "POLICY_UNAVAILABLE" };
    await r.service.scan();
    expect(r.world.alerts).toHaveLength(2);
    expect(r.world.texts).toHaveLength(0);
    expect(
      r.service
        .activity()
        .some((a) => a.kind === "text" && a.outcome === "mislukt"),
    ).toBe(true);
  });

  it("texts urgent findings at night but never calls then", async () => {
    const r = make(NIGHT);
    r.service.updateSettings({ allowCalls: true });
    r.world.level = "independent";
    r.world.telephony = {
      enabled: true,
      ready: { ready: true },
      contacts: ["Harm"],
      failText: false,
    };
    r.world.disk = 2;
    await r.service.scan();
    expect(r.world.texts).toHaveLength(1);
    expect(r.phoneCalls).toHaveLength(0);
  });

  it("calls for an urgent finding only with allowCalls and an autonomy level that allows it", async () => {
    const setup = (allowCalls: boolean, level: "careful" | "balanced") => {
      const r = make();
      r.service.updateSettings({ allowCalls });
      r.world.level = level;
      r.world.telephony = {
        enabled: true,
        ready: { ready: true },
        contacts: ["Harm"],
        failText: false,
      };
      r.world.disk = 2;
      return r;
    };
    const dflt = setup(false, "balanced");
    await dflt.service.scan();
    expect(dflt.phoneCalls).toHaveLength(0);

    const careful = setup(true, "careful");
    await careful.service.scan();
    expect(careful.phoneCalls).toHaveLength(0);
    expect(careful.service.activity().some((a) => a.kind === "call")).toBe(
      true,
    );

    const allowed = setup(true, "balanced");
    await allowed.service.scan();
    expect(allowed.phoneCalls).toHaveLength(1);
    expect(allowed.phoneCalls[0]).toMatchObject({ to: "Harm" });
  });

  it("never calls for non-urgent findings", async () => {
    const r = make();
    r.service.updateSettings({ allowCalls: true });
    r.world.level = "independent";
    r.world.telephony = {
      enabled: true,
      ready: { ready: true },
      contacts: ["Harm"],
      failText: false,
    };
    r.world.events = [event("A", NOON + 20 * MIN)];
    await r.service.scan();
    expect(r.phoneCalls).toHaveLength(0);
  });
});

describe("default standing objectives", () => {
  it("watches the servers when Proxmox is there", async () => {
    const r = make();
    r.world.proxmoxOk = true;
    await r.service.scan();
    expect(r.world.createdObjectives).toHaveLength(1);
    expect(r.world.createdObjectives[0]).toMatchObject({
      template: "servers_gezond",
    });
  });

  it("watches the running key services otherwise, never servers_gezond", async () => {
    const r = make();
    r.world.services.push({ name: "qdrant-extra", ok: false });
    await r.service.scan();
    const targets = r.world.createdObjectives.map(
      (o) => (o.params as { target: string }).target,
    );
    expect(targets).toEqual(["omniroute", "mqtt", "qdrant"]);
    expect(
      r.world.createdObjectives.every((o) => o.template === "service_online"),
    ).toBe(true);
  });

  it("happens once, and not when objectives already exist", async () => {
    const r = make();
    r.world.proxmoxOk = true;
    await r.service.scan();
    r.clock.t += 5 * MIN;
    await r.service.scan();
    r.restart();
    r.clock.t += 5 * MIN;
    await r.service.scan();
    expect(r.world.createdObjectives).toHaveLength(1);

    const other = make();
    other.world.objectives = [{ id: "x", enabled: true }];
    other.world.proxmoxOk = true;
    await other.service.scan();
    expect(other.world.createdObjectives).toHaveLength(0);
  });

  it("skips silently what the install does not have", async () => {
    const r = make();
    delete r.world.tools.network_check;
    delete r.world.tools.proxmox_status;
    await r.service.scan();
    expect(r.world.createdObjectives).toHaveLength(0);
    expect(r.world.alerts).toHaveLength(0);
  });
});

describe("delegation without a model", () => {
  it("starts an agent run for explicit delegation", async () => {
    const r = make();
    const reply = await r.service.delegate(
      { kind: "agent", goal: "zoek uit waarom mijn wifi traag is" },
      { sessionId: "web" },
    );
    expect(reply).toBe(
      "Ik ga ermee aan de slag en meld me zodra het klaar is.",
    );
  });

  it("hands the conversation to the model at the careful level", async () => {
    const r = make();
    r.world.level = "careful";
    expect(
      await r.service.delegate(
        { kind: "agent", goal: "regel dat voor me" },
        { sessionId: "web" },
      ),
    ).toBeNull();
  });

  it("creates an objective for a watch request", async () => {
    const r = make();
    const reply = await r.service.delegate(
      {
        kind: "objective",
        title: "houd mijn servers in de gaten",
        template: "servers_gezond",
        params: {},
      },
      { sessionId: "web" },
    );
    expect(reply).toMatch(/in de gaten/);
    expect(r.world.createdObjectives[0]).toMatchObject({
      template: "servers_gezond",
    });
  });
});
