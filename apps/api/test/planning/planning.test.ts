import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InfrastructureEvent } from "@nova/contracts";
import type { AuditEntry } from "../../src/core/audit/audit.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { MqttService } from "../../src/core/mqtt/mqtt.service.js";
import { JarvisStateStore } from "../../src/planning/jarvis-state.store.js";
import { PlanningService } from "../../src/planning/planning.service.js";
import { PlanningSource } from "../../src/planning/planning.source.js";
import type { ProxmoxService } from "../../src/proxmox/proxmox.service.js";
import type {
  CalDavService,
  CalendarEvent,
} from "../../src/planning/caldav.service.js";

let dir: string;
let store: JarvisStateStore;
let planning: PlanningService;
let source: PlanningSource;
let events: InfrastructureEvent[];
let proxmox: { configured: boolean; resources: () => Promise<unknown[]> };
let calendarEvents: CalendarEvent[];
let auditEntries: AuditEntry[];
const run = (name: string, args: Record<string, unknown> = {}) =>
  source.execute(name, args);

function boot() {
  const config = {
    timezone: "Europe/Amsterdam",
    dataFile: (n: string) => path.join(dir, n),
  } as NovaConfig;
  store = new JarvisStateStore(config, {
    publish: () => undefined,
  } as unknown as MqttService);
  planning = new PlanningService(store);
  source = new PlanningSource(
    planning,
    store,
    proxmox as unknown as ProxmoxService,
    config,
    {
      configured: true,
      upcoming: async () => calendarEvents,
    } as unknown as CalDavService,
    {
      read: () => auditEntries,
    } as unknown as import("../../src/core/audit/audit.service.js").AuditService,
  );
  events = [];
  planning.onEvent((e) => events.push(e));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-planning-"));
  proxmox = { configured: false, resources: async () => [] };
  calendarEvents = [];
  auditEntries = [];
  boot();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("tools", () => {
  it("replaces backed-up lists without touching timers or alerts and keeps the state private", () => {
    store.data.timers.push({
      id: "11111111",
      label: "old timer",
      fireAt: Date.now() + 60_000,
    });
    store.data.alerts.push({
      id: "alert",
      key: "disk",
      severity: "warning",
      title: "Disk",
      detail: "low",
      at: new Date().toISOString(),
    });
    store.data.watch.down.disk = Date.now();
    store.data.lists.boodschappen = [
      { id: "22222222", text: "brood", addedAt: new Date().toISOString() },
    ];
    const replacement = {
      taken: [
        { id: "33333333", text: "was", addedAt: new Date().toISOString() },
      ],
    };

    store.replaceLists(replacement);

    expect(store.getListsSnapshot()).toEqual(replacement);
    expect(store.data.timers).toHaveLength(1);
    expect(store.data.alerts).toHaveLength(1);
    expect(store.data.watch.down).toHaveProperty("disk");
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    store.reload();
    expect(store.getListsSnapshot()).toEqual(replacement);
    expect(store.data.timers).toHaveLength(1);
  });

  it("lists the tools with their risks", () => {
    const risk = Object.fromEntries(
      source.definitions().map((d) => [d.name, d.risk]),
    );
    expect(risk).toEqual({
      timer_set: "SAFE",
      timer_list: "READ_ONLY",
      timer_cancel: "SAFE",
      list_add: "SAFE",
      list_show: "READ_ONLY",
      list_remove: "SAFE",
      list_clear: "CONFIRM",
      calendar_events: "READ_ONLY",
      calendar_create: "CONFIRM",
      calendar_move: "CONFIRM",
      daily_briefing: "READ_ONLY",
    });
    const calendarWrites = source
      .definitions()
      .filter((d) => d.name.startsWith("calendar_") && d.risk === "CONFIRM");
    expect(
      calendarWrites.every(
        (definition) => definition.allowStandingApproval === false,
      ),
    ).toBe(true);
  });

  it("timers: set, list, cancel by label, and sensible refusals", async () => {
    const set = await run("timer_set", { seconds: 600, label: "pasta" });
    expect(set.ok).toBe(true);
    expect(
      (set.result as { timer: { remainingSeconds: number } }).timer
        .remainingSeconds,
    ).toBeGreaterThan(590);
    expect(((await run("timer_list")).result as { count: number }).count).toBe(
      1,
    );
    expect((await run("timer_set", {})).ok).toBe(false);
    expect(
      (
        await run("timer_set", {
          seconds: 5,
          at: new Date(Date.now() + 9e5).toISOString(),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await run("timer_set", {
          at: new Date(Date.now() - 1000).toISOString(),
        })
      ).error,
    ).toMatch(/voorbij/);
    expect((await run("timer_set", { at: "morgen 10:00" })).error).toMatch(
      /geldige ISO/,
    );
    expect(
      (
        await run("timer_set", {
          at: new Date(Date.now() + 9 * 864e5).toISOString(),
        })
      ).error,
    ).toMatch(/7 dagen/);
    await run("timer_set", { seconds: 900, label: "pasta water" });
    expect((await run("timer_cancel", { label: "pasta" })).error).toMatch(
      /Meerdere timers/,
    );
    expect((await run("timer_cancel", { label: "water" })).ok).toBe(true);
    expect(((await run("timer_list")).result as { count: number }).count).toBe(
      1,
    );
    expect(
      (await run("timer_cancel", { label: "bestaat niet" })).error,
    ).toMatch(/Geen timer/);
    expect((await run("timer_cancel", {})).error).toMatch(/id of label/);
  });

  it("lists: add, duplicate, show, remove by part, ambiguity and clearing", async () => {
    const added = await run("list_add", { list: "Boodschappen", item: "Melk" });
    expect((added.result as { added: boolean }).added).toBe(true);
    const dup = await run("list_add", { list: "boodschappen", item: "melk" });
    expect((dup.result as { added: boolean }).added).toBe(false);
    await run("list_add", { list: "boodschappen", item: "halfvolle melk" });
    await run("list_add", { list: "taken", item: "tuin" });
    expect((await run("list_show", {})).result).toEqual({
      lists: { boodschappen: ["Melk", "halfvolle melk"], taken: ["tuin"] },
    });
    expect(
      (await run("list_remove", { list: "boodschappen", item: "mel" })).error,
    ).toMatch(/Meerdere/);
    expect(
      (
        (await run("list_remove", { list: "boodschappen", item: "halfvolle" }))
          .result as { removed: string }
      ).removed,
    ).toBe("halfvolle melk");
    expect(
      (await run("list_remove", { list: "boodschappen", item: "kaas" })).error,
    ).toMatch(/Niets gevonden/);
    await run("list_remove", { list: "taken", item: "tuin" });
    expect(
      Object.hasOwn((await run("list_show", {})).result as object, "taken"),
    ).toBe(false);
    const cleared = await run("list_clear", { list: "boodschappen" });
    expect((cleared.result as { cleared: number }).cleared).toBe(1);
  });
});

describe("timers firing", () => {
  it("a due timer fires exactly once as an event and is removed", async () => {
    await run("timer_set", { seconds: 60, label: "oven" });
    planning.fireDueTimers();
    expect(events).toEqual([]);
    planning.fireDueTimers(Date.now() + 61000);
    expect(events).toHaveLength(1);
    expect(events[0]?.topic).toBe("jarvis/events/timer");
    expect(events[0]?.payload).toMatchObject({
      type: "timer_fired",
      label: "oven",
      late: false,
    });
    planning.fireDueTimers(Date.now() + 62000);
    expect(events).toHaveLength(1);
    expect(planning.timers()).toEqual([]);
  });

  it("fires by itself once the service runs", async () => {
    vi.useFakeTimers();
    boot();
    planning.onModuleInit();
    await run("timer_set", { seconds: 5, label: "thee" });
    await vi.advanceTimersByTimeAsync(6000);
    planning.onModuleDestroy();
    expect(events.map((e) => e.payload.label)).toEqual(["thee"]);
  });

  it("state survives a restart, and a timer that expired meanwhile fires late", async () => {
    await run("timer_set", { seconds: 60, label: "bel" });
    await run("list_add", { list: "Boodschappen", item: "melk" });
    boot(); // new process: memory gone, the file stays
    expect(planning.timers()).toHaveLength(1);
    expect(planning.lists()).toEqual({ boodschappen: ["melk"] });
    planning.fireDueTimers(Date.now() + 120000);
    expect(events[0]?.payload.late).toBe(true);
  });

  it("resumes a persisted timer after the service starts again", async () => {
    vi.useFakeTimers();
    await run("timer_set", { seconds: 5, label: "restart tea" });
    boot();
    planning.onModuleInit();
    await vi.advanceTimersByTimeAsync(6000);
    planning.onModuleDestroy();
    expect(events.map((event) => event.payload.label)).toEqual(["restart tea"]);
  });

  it("reads a state file from the prototype unchanged", () => {
    fs.writeFileSync(
      path.join(dir, "jarvis-state.json"),
      JSON.stringify({
        timers: [],
        lists: {
          taken: [
            { id: "ab12", text: "wassen", addedAt: "2026-01-01T00:00:00.000Z" },
          ],
        },
        alerts: [
          {
            id: "1",
            key: "k",
            severity: "info",
            title: "t",
            detail: "",
            at: "x",
          },
        ],
        active: {},
        watch: { guests: { "104": "running" }, down: {} },
      }),
    );
    boot();
    expect(planning.lists()).toEqual({ taken: ["wassen"] });
    planning.addItem("taken", "koken");
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "jarvis-state.json"), "utf8"),
    );
    expect(saved.alerts).toHaveLength(1);
    expect(saved.watch.guests).toEqual({ "104": "running" });
    expect(saved.lists.taken).toHaveLength(2);
  });
});

describe("daily_briefing", () => {
  it("combines time, servers, timers, lists and open alerts", async () => {
    proxmox = {
      configured: true,
      resources: async () => [
        { vmid: 1, name: "a", status: "running" },
        { vmid: 2, name: "b", status: "stopped" },
      ],
    };
    boot();
    await run("timer_set", { seconds: 300, label: "thee" });
    await run("list_add", { list: "boodschappen", item: "brood" });
    store.data.alerts.push({
      id: "1",
      key: "x",
      severity: "warning",
      title: "Open",
      detail: "",
      at: "now",
    });
    store.data.active.x = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await run("daily_briefing")).result as Record<string, any>;
    expect(out.now.time).toMatch(/^\d\d:\d\d$/);
    expect(out.servers).toEqual({ vmsRunning: 1, vmsTotal: 2, stopped: ["b"] });
    expect(out.timers[0].label).toBe("thee");
    expect(out.lists.boodschappen).toEqual({ count: 1, first: ["brood"] });
    expect(out.openAlerts).toHaveLength(1);
    proxmox.resources = async () => {
      throw new Error("down");
    };
    expect(
      ((await run("daily_briefing")).result as { servers: unknown }).servers,
    ).toEqual({
      error: "Proxmox is niet bereikbaar",
    });
  });

  it("includes successful action names without private arguments or results and marks tomorrow's calendar", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-31T22:30:00.000Z"));
    calendarEvents = [
      {
        summary: "Tomorrow",
        start: "2024-04-02T09:00:00",
        end: null,
        timeZone: "Europe/Amsterdam",
        allDay: false,
      },
    ];
    auditEntries = [
      {
        id: "one",
        timestamp: "2024-04-01T18:15:00.000Z",
        tool: "timer_set",
        risk: "SAFE",
        result: { ok: true, result: { label: "private timer detail" } },
        arguments: { label: "private timer detail" },
      },
      {
        id: "read",
        timestamp: "2024-04-01T18:14:00.000Z",
        tool: "weather_forecast",
        risk: "READ_ONLY",
        result: { ok: true },
      },
      {
        id: "started",
        timestamp: "2024-04-01T18:13:00.000Z",
        tool: "home_control",
        risk: "SAFE",
        phase: "execution_started",
      },
    ];
    boot();
    const result = (await run("daily_briefing")).result as {
      activity: {
        tracked: boolean;
        complete: boolean;
        entries: { tool: string; time: string }[];
      };
      tomorrow: {
        calendar: {
          configured: boolean;
          untrusted: boolean;
          events: CalendarEvent[];
        };
      };
    };
    expect(result.activity).toMatchObject({
      tracked: true,
      complete: true,
      entries: [{ tool: "timer_set" }],
    });
    expect(JSON.stringify(result.activity)).not.toContain(
      "private timer detail",
    );
    expect(result.tomorrow.calendar).toMatchObject({
      configured: true,
      untrusted: true,
      events: [{ summary: "Tomorrow" }],
    });
  });
});
