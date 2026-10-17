import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate } from "../../src/objectives/objectives.conditions.js";
import { ObjectivesController } from "../../src/objectives/objectives.controller.js";
import { ObjectivesService } from "../../src/objectives/objectives.service.js";
import { ObjectivesSource } from "../../src/objectives/objectives.source.js";
import { ObjectivesStore } from "../../src/objectives/objectives.store.js";
import { TEMPLATES } from "../../src/objectives/objectives.templates.js";
import { inQuietHours } from "../../src/objectives/objectives.time.js";
import { rankToolsForRequest } from "../../src/tools/tool-selection.js";

const MIN = 60_000;
/** 2026-10-17 12:00 in Amsterdam (CEST, UTC+2). */
const NOON = Date.UTC(2026, 9, 17, 10, 0);
const NIGHT = Date.UTC(2026, 9, 17, 22, 30); // 00:30 local, quiet hours

type Alert = {
  payload: { title: string; severity: string; key: string; detail: string };
};

function node(cpu: number, status = "online") {
  return {
    node: "pve1",
    status,
    cpu: { usagePercent: cpu },
    memory: { usagePercent: 40 },
  };
}

function setup(
  start = NOON,
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "obj-")),
) {
  const world = {
    nodes: [node(10)],
    stopped: 0,
    services: [{ name: "api", ok: true }],
    ha: "closed",
    events: [{ title: "x" }] as unknown[],
  };
  const calls: Array<{
    name: string;
    session: string;
    readOnlyOnly?: boolean;
  }> = [];
  const registry = [
    ["proxmox_status", "READ_ONLY"],
    ["proxmox_guests", "READ_ONLY"],
    ["network_check", "READ_ONLY"],
    ["ha_get_state", "READ_ONLY"],
    ["calendar_events", "READ_ONLY"],
    ["proxmox_start_guest", "CONFIRM"],
    ["alerts_list", "READ_ONLY"],
  ].map(([name, risk]) => ({ name, risk, enabled: true }));
  const tools = {
    list: () => registry,
    execute: async (
      name: string,
      _args: unknown,
      session: string,
      _a: unknown,
      _b: unknown,
      options: { readOnlyOnly?: boolean },
    ) => {
      calls.push({ name, session, readOnlyOnly: options.readOnlyOnly });
      if (name === "proxmox_status")
        return { ok: true, result: { nodes: world.nodes } };
      if (name === "proxmox_guests")
        return { ok: true, result: { summary: { stopped: world.stopped } } };
      if (name === "network_check")
        return { ok: true, result: { results: world.services } };
      if (name === "ha_get_state")
        return { ok: true, result: { state: world.ha } };
      if (name === "calendar_events")
        return { ok: true, result: { events: world.events } };
      return { ok: false, error: "nope" };
    },
  };
  const runs = new Map<
    string,
    { id: string; status: string; result?: string }
  >();
  const started: string[] = [];
  const agent = {
    start: (goal: string) => {
      started.push(goal);
      const run = {
        id: `run${started.length}`,
        status: "running" as string,
        result: undefined as string | undefined,
      };
      runs.set(run.id, run);
      return run;
    },
    get: (id: string) => {
      const run = runs.get(id);
      if (!run) throw new Error("niet gevonden");
      return run;
    },
  };
  const alerts: Alert[] = [];
  const store = new ObjectivesStore({
    dataFile: (n: string) => path.join(dir, n),
  } as never);
  const service = new ObjectivesService(
    store,
    tools as never,
    agent as never,
    { emit: (e: Alert) => alerts.push(e) } as never,
    { record: () => undefined } as never,
  );
  let clock = start;
  service.now = () => clock;
  service.pollMs = 0;
  service.recover();
  const advance = (ms: number) => (clock += ms);
  return {
    service,
    store,
    world,
    calls,
    agent,
    runs,
    started,
    alerts,
    advance,
    dir,
    tools,
    setNow: (t: number) => (clock = t),
  };
}

const cpuObjective = (
  s: ReturnType<typeof setup>,
  extra: Record<string, unknown> = {},
) =>
  s.service.create({
    title: "houd mijn servers gezond",
    template: "servers_gezond",
    params: {},
    ...extra,
  }).objective;

describe("conditions", () => {
  test("compare looks at every array element and names the culprit", () => {
    const result = { nodes: [node(20), { ...node(95), node: "pve2" }] };
    const out = evaluate(
      { kind: "compare", path: "nodes[].cpu.usagePercent", op: ">", value: 90 },
      result,
    );
    expect(out.anomaly).toBe(true);
    expect(out.detail).toContain("pve2");
    expect(
      evaluate(
        {
          kind: "compare",
          path: "nodes[].cpu.usagePercent",
          op: ">",
          value: 99,
        },
        result,
      ).anomaly,
    ).toBe(false);
  });
  test("any service down, string equality, empty and missing paths", () => {
    expect(
      evaluate(
        { kind: "compare", path: "results[].ok", op: "==", value: false },
        {
          results: [
            { name: "a", ok: true },
            { name: "mqtt", ok: false },
          ],
        },
      ),
    ).toMatchObject({ anomaly: true, detail: expect.stringContaining("mqtt") });
    expect(
      evaluate(
        { kind: "compare", path: "state", op: "==", value: "open" },
        { state: "OPEN" },
      ).anomaly,
    ).toBe(true);
    expect(
      evaluate({ kind: "empty", path: "events" }, { events: [] }).anomaly,
    ).toBe(true);
    expect(
      evaluate({ kind: "empty", path: "events" }, { events: [1] }).anomaly,
    ).toBe(false);
    expect(
      evaluate({ kind: "compare", path: "nope", op: ">", value: 1 }, {})
        .anomaly,
    ).toBe(false);
    expect(
      evaluate({ kind: "compare", path: "__proto__.x", op: "==", value: 1 }, {})
        .anomaly,
    ).toBe(false);
    expect(
      evaluate(
        { kind: "compare", path: "state", op: ">", value: 5 },
        { state: "unavailable" },
      ).anomaly,
    ).toBe(false);
  });
});

describe("scheduler", () => {
  test("due time follows lastCheckAt and the interval, with a fake clock", async () => {
    const s = setup();
    const o = cpuObjective(s, { intervalMinutes: 10 });
    expect(s.service.isDue(o)).toBe(true);
    await s.service.tick();
    expect(o.counters.checks).toBe(1);
    s.advance(9 * MIN);
    expect(s.service.isDue(o)).toBe(false);
    await s.service.tick();
    expect(o.counters.checks).toBe(1);
    s.advance(MIN);
    await s.service.tick();
    expect(o.counters.checks).toBe(2);
  });

  test("restart resumes from stored timestamps without a burst", async () => {
    const first = setup();
    const o = cpuObjective(first, { intervalMinutes: 10 });
    await first.service.tick();
    const second = setup(NOON + 4 * MIN, first.dir);
    expect(second.service.list()).toHaveLength(1);
    await second.service.tick();
    expect(second.service.get(o.id).counters.checks).toBe(1);
    second.advance(6 * MIN);
    await second.service.tick();
    expect(second.service.get(o.id).counters.checks).toBe(2);
  });

  test("an overdue objective runs once after a long downtime", async () => {
    const first = setup();
    const o = cpuObjective(first, { intervalMinutes: 10 });
    await first.service.tick();
    const second = setup(NOON + 5 * 3_600_000, first.dir);
    await second.service.tick();
    await second.service.tick();
    expect(second.service.get(o.id).counters.checks).toBe(2);
  });

  test("expired objectives pause themselves; routine checks never call a model", async () => {
    const s = setup();
    const o = cpuObjective(s, { expiresInDays: 1 });
    s.advance(2 * 86_400_000);
    await s.service.tick();
    expect(o.enabled).toBe(false);
    expect(o.lastResult?.status).toBe("verlopen");
    expect(s.started).toHaveLength(0);
  });

  test("checks use only read-only execution under an objective_ session", async () => {
    const s = setup();
    const o = cpuObjective(s);
    await s.service.tick();
    expect(s.calls.length).toBeGreaterThan(0);
    for (const c of s.calls) {
      expect(c.readOnlyOnly).toBe(true);
      expect(c.session).toBe(`objective_${o.id}`);
    }
  });
});

describe("debounce, alerts and recovery", () => {
  test("CPU must exceed the limit three checks in a row; one alert, then hersteld", async () => {
    const s = setup();
    const o = cpuObjective(s, { intervalMinutes: 5 });
    s.world.nodes = [node(97)];
    await s.service.tick();
    s.advance(5 * MIN);
    await s.service.tick();
    expect(s.alerts).toHaveLength(0);
    s.advance(5 * MIN);
    await s.service.tick();
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]!.payload.title).toContain("Let op");
    expect(s.alerts[0]!.payload.key).toBe(`objective-${o.id}`);
    // Still bad: de-duplicated.
    for (let i = 0; i < 3; i++) {
      s.advance(5 * MIN);
      await s.service.tick();
    }
    expect(s.alerts).toHaveLength(1);
    // A single good check resets the counter and clears the anomaly.
    s.world.nodes = [node(10)];
    s.advance(5 * MIN);
    await s.service.tick();
    expect(s.alerts).toHaveLength(2);
    expect(s.alerts[1]!.payload.title).toContain("Hersteld");
    expect(o.active).toBeUndefined();
    expect(o.counters.anomalies).toBe(1);
  });

  test("a spike that clears before the debounce never alerts", async () => {
    const s = setup();
    cpuObjective(s);
    for (const cpu of [97, 97, 10, 97, 97, 10]) {
      s.world.nodes = [node(cpu)];
      await s.service.tick();
      s.advance(10 * MIN);
    }
    expect(s.alerts).toHaveLength(0);
  });

  test("a failing tool is skipped, then becomes an anomaly after three failures", async () => {
    const s = setup();
    const o = s.service.create({
      title: "dienst bewaken",
      template: "service_online",
      params: { target: "api" },
      intervalMinutes: 5,
    }).objective;
    s.tools.execute = async () => ({ ok: false, error: "x" }) as never;
    for (let i = 0; i < 2; i++) {
      await s.service.tick();
      s.advance(5 * MIN);
    }
    expect(o.active).toBeUndefined();
    await s.service.tick();
    expect(o.active?.detail).toContain("mislukt");
  });
});

describe("quiet hours, cooldown and budget", () => {
  test("quiet hours helper wraps midnight in Amsterdam time", () => {
    const quiet = {
      enabled: true,
      start: "23:00",
      end: "07:00",
      timezone: "Europe/Amsterdam",
    };
    expect(inQuietHours(NOON, quiet)).toBe(false);
    expect(inQuietHours(NIGHT, quiet)).toBe(true);
    expect(inQuietHours(NIGHT, { ...quiet, enabled: false })).toBe(false);
  });

  test("warn is recorded but silent at night, then sent when quiet hours end", async () => {
    const s = setup(NIGHT);
    const o = cpuObjective(s, { intervalMinutes: 5 });
    s.world.services = [{ name: "api", ok: false }];
    await s.service.tick();
    s.advance(5 * MIN);
    await s.service.tick();
    expect(o.active).toBeDefined();
    expect(s.alerts).toHaveLength(0);
    expect(o.history.at(-1)?.delivery).toBe("stil");
    s.setNow(Date.UTC(2026, 9, 18, 5, 10)); // 07:10 local
    await s.service.tick();
    expect(s.alerts).toHaveLength(1);
    expect(o.active?.notified).toBe(true);
  });

  test("urgent notifies even during quiet hours", async () => {
    const s = setup(NIGHT);
    cpuObjective(s, { intervalMinutes: 5 });
    s.world.nodes = [node(10, "offline")];
    await s.service.tick();
    s.advance(5 * MIN);
    await s.service.tick();
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]!.payload.severity).toBe("critical");
  });

  test("a changed anomaly inside the cooldown waits; the daily budget caps everything", async () => {
    const s = setup();
    const o = cpuObjective(s, { intervalMinutes: 5, cooldownMinutes: 60 });
    s.world.services = [{ name: "api", ok: false }];
    for (let i = 0; i < 2; i++) {
      await s.service.tick();
      s.advance(5 * MIN);
    }
    expect(s.alerts).toHaveLength(1);
    s.world.nodes = [node(97)];
    for (let i = 0; i < 3; i++) {
      await s.service.tick();
      s.advance(5 * MIN);
    }
    expect(s.alerts).toHaveLength(1); // changed signature, but in cooldown
    expect(o.history.some((h) => h.delivery === "cooldown")).toBe(true);
    s.advance(60 * MIN);
    await s.service.tick();
    expect(s.alerts).toHaveLength(2); // delivered once the cooldown is over
  });

  test("global daily budget stops non-urgent alerts and resets the next day", async () => {
    const s = setup();
    const data = s.store.load();
    data.settings.dailyBudget = 2;
    s.store.save(data);
    s.service.recover();
    const o = cpuObjective(s, { intervalMinutes: 5, cooldownMinutes: 0 });
    for (let i = 0; i < 12; i++) {
      s.world.services = [{ name: "api", ok: i % 3 === 2 }];
      await s.service.tick();
      s.advance(5 * MIN);
    }
    expect(s.alerts.length).toBe(2);
    expect(o.counters.suppressed).toBeGreaterThan(0);
    s.setNow(NOON + 24 * 60 * MIN);
    s.world.services = [{ name: "api", ok: false }];
    for (let i = 0; i < 2; i++) {
      await s.service.tick();
      s.advance(5 * MIN);
    }
    expect(s.alerts.length).toBeGreaterThan(2);
  });
});

describe("investigation", () => {
  test("starts exactly once per new anomaly, read-only goal, cooldown 30 min, attaches KLAAR summary", async () => {
    const s = setup();
    const o = cpuObjective(s, { intervalMinutes: 5 });
    s.world.nodes = [node(10, "offline")];
    await s.service.tick();
    s.advance(5 * MIN);
    await s.service.tick();
    expect(s.started).toHaveLength(1);
    expect(s.started[0]).toMatch(/^onderzoek waarom/);
    expect(s.started[0]).toMatch(/Alleen lezen/);
    s.advance(5 * MIN);
    await s.service.tick();
    expect(s.started).toHaveLength(1);
    // Recovery, then a new anomaly inside the 30 minute cooldown: no second investigation.
    s.world.nodes = [node(10)];
    s.advance(5 * MIN);
    await s.service.tick();
    s.world.nodes = [node(10, "offline")];
    for (let i = 0; i < 2; i++) {
      s.advance(5 * MIN);
      await s.service.tick();
    }
    expect(s.started).toHaveLength(1);
    // The summary arrives asynchronously.
    s.runs.get("run1")!.status = "done";
    s.runs.get("run1")!.result = "pve1 is herstart door stroomonderhoud.";
    await new Promise((r) => setTimeout(r, 20));
    expect(o.lastInvestigation?.summary).toMatch(/stroomonderhoud/);
    expect(s.alerts.some((a) => a.payload.title.startsWith("Onderzoek"))).toBe(
      true,
    );
  });

  test("after the cooldown a new anomaly may investigate again; info anomalies never do", async () => {
    const s = setup();
    cpuObjective(s, { intervalMinutes: 5 });
    s.world.nodes = [node(10, "offline")];
    for (let i = 0; i < 2; i++) {
      await s.service.tick();
      s.advance(5 * MIN);
    }
    s.world.nodes = [node(10)];
    await s.service.tick();
    s.advance(31 * MIN);
    s.world.nodes = [node(10, "offline")];
    for (let i = 0; i < 2; i++) {
      await s.service.tick();
      s.advance(5 * MIN);
    }
    expect(s.started).toHaveLength(2);
    const t = setup();
    t.service.create({
      title: "afspraken checken",
      template: "agenda_leeg",
      params: {},
    });
    t.world.events = [];
    await t.service.tick();
    expect(t.started).toHaveLength(0);
  });

  test("a failing agent start does not break the objective", async () => {
    const s = setup();
    cpuObjective(s, { intervalMinutes: 5 });
    s.agent.start = () => {
      throw new Error("daglimiet");
    };
    s.world.nodes = [node(10, "offline")];
    for (let i = 0; i < 2; i++) {
      await s.service.tick();
      s.advance(5 * MIN);
    }
    expect(s.alerts).toHaveLength(1);
  });
});

describe("followup and dismiss", () => {
  test("a followup tells the user once and ends", async () => {
    const s = setup();
    const o = s.service.create({
      title: "laat weten als de garage open staat",
      template: "ha_waarde",
      kind: "followup",
      params: { entity: "cover.garage", operator: "==", value: "open" },
    }).objective;
    await s.service.tick();
    expect(s.alerts).toHaveLength(0);
    s.world.ha = "open";
    s.advance(5 * MIN);
    await s.service.tick();
    expect(s.alerts).toHaveLength(1);
    expect(o.enabled).toBe(false);
    expect(o.fulfilledAt).toBeDefined();
    expect(s.started).toHaveLength(0);
  });

  test("dismiss counts a false alarm and silences the anomaly until it changes", async () => {
    const s = setup();
    const o = cpuObjective(s, { intervalMinutes: 5 });
    s.world.services = [{ name: "api", ok: false }];
    for (let i = 0; i < 2; i++) {
      await s.service.tick();
      s.advance(5 * MIN);
    }
    s.service.update(o.id, { dismiss: true });
    expect(o.counters.falseAlarms).toBe(1);
    s.world.services = [{ name: "api", ok: true }];
    await s.service.tick();
    expect(s.alerts).toHaveLength(1); // no 'hersteld' for a dismissed alarm
    expect(() => s.service.update(o.id, { dismiss: true })).toThrow();
  });
});

describe("creation rules", () => {
  test("unknown templates and bad parameters are rejected", () => {
    const s = setup();
    expect(() =>
      s.service.create({ title: "iets doen", template: "rm_rf" }),
    ).toThrow(/sjabloon/);
    expect(() =>
      s.service.create({ title: "iets doen", template: "toString" }),
    ).toThrow(/sjabloon/);
    expect(() =>
      s.service.create({
        title: "iets doen",
        template: "service_online",
        params: {},
      }),
    ).toThrow(/dienst/);
    expect(() =>
      s.service.create({
        title: "iets doen",
        template: "ha_waarde",
        params: { entity: "x;y", value: 1 },
      }),
    ).toThrow(/entiteit/);
    expect(() =>
      s.service.create({
        title: "iets doen",
        template: "ha_waarde",
        params: { entity: "sensor.temp", operator: ">", value: "warm" },
      }),
    ).toThrow(/Tekstwaarden/);
    expect(() =>
      s.service.create({
        title: "iets doen",
        template: "agenda_leeg",
        intervalMinutes: 1,
      }),
    ).toThrow(/interval/);
    expect(() =>
      s.service.create({ title: "x", template: "agenda_leeg" }),
    ).toThrow();
  });

  test("a check naming a non-READ_ONLY or non-allowlisted tool is rejected at creation", () => {
    const s = setup();
    const base = TEMPLATES.agenda_leeg!;
    const bad = (tool: string) => {
      TEMPLATES.bad = {
        ...base,
        build: () => {
          const built = base.build({});
          return {
            ...built,
            checks: built.checks.map((c) => ({ ...c, tool })),
          };
        },
      };
      try {
        return () =>
          s.service.create({ title: "slecht doel", template: "bad" });
      } finally {
        /* cleaned in the assertions below */
      }
    };
    try {
      expect(bad("proxmox_start_guest")).toThrow(/mag niet/);
      expect(bad("agent_run")).toThrow(/mag niet/);
      expect(bad("alerts_list")).toThrow(/mag niet/); // READ_ONLY but not in the allowlist
      expect(s.service.list()).toHaveLength(0);
      // Risk is also checked against the registry itself.
      const registry = s.tools.list();
      registry.find((t) => t.name === "calendar_events")!.risk = "SAFE";
      expect(() =>
        s.service.create({ title: "agenda checken", template: "agenda_leeg" }),
      ).toThrow(/alleen lezende/);
    } finally {
      delete TEMPLATES.bad;
    }
  });

  test("a stored objective whose tool turned non-read-only is disabled, not executed", async () => {
    const s = setup();
    const o = cpuObjective(s);
    o.checks[0]!.tool = "proxmox_start_guest";
    await s.service.tick();
    expect(o.enabled).toBe(false);
    expect(s.calls).toHaveLength(0);
  });

  test("at most five active objectives; pausing frees a slot; duplicates are merged", () => {
    const s = setup();
    for (let i = 0; i < 5; i++)
      s.service.create({
        title: `controleer ${i}`,
        template: "service_online",
        params: { target: `svc${i}` },
      });
    expect(() =>
      s.service.create({
        title: "zesde doel",
        template: "service_online",
        params: { target: "svc9" },
      }),
    ).toThrow(/5 actieve/);
    const again = s.service.create({
      title: "nog eens",
      template: "service_online",
      params: { target: "svc1" },
    });
    expect(again.duplicate).toBe(true);
    const first = s.service.list()[0]!;
    s.service.update(first.id, { enabled: false });
    expect(
      s.service.create({
        title: "zesde doel",
        template: "service_online",
        params: { target: "svc9" },
      }).duplicate,
    ).toBe(false);
    expect(() => s.service.update(first.id, { enabled: true })).toThrow(
      /5 actieve/,
    );
  });
});

describe("persistence", () => {
  test("objectives.json is mode 0600 and holds history and counters across a reload", async () => {
    const s = setup();
    const o = cpuObjective(s);
    await s.service.tick();
    expect(fs.statSync(s.store.file).mode & 0o777).toBe(0o600);
    const again = new ObjectivesStore({
      dataFile: () => s.store.file,
    } as never).load();
    expect(again.objectives[0]!.id).toBe(o.id);
    expect(again.objectives[0]!.history).toHaveLength(1);
    expect(again.objectives[0]!.counters.checks).toBe(1);
  });

  test("history keeps 20 results", async () => {
    const s = setup();
    const o = cpuObjective(s, { intervalMinutes: 5 });
    for (let i = 0; i < 30; i++) {
      await s.service.tick();
      s.advance(5 * MIN);
    }
    expect(o.history).toHaveLength(20);
    expect(o.counters.checks).toBe(30);
  });

  test("a corrupt file loads as empty", () => {
    const s = setup();
    fs.writeFileSync(s.store.file, "{not json");
    s.service.recover();
    expect(s.service.list()).toEqual([]);
  });
});

type Row = {
  anomaliesLast7Days: number;
  counters: { checks: number; falseAlarms: number };
  history: unknown[];
  activeAnomaly: { urgency: string };
  quietHours: string;
};

describe("tools and controller", () => {
  const defs = () => new ObjectivesSource({} as never).definitions();

  test("risks: list is READ_ONLY, delete is CONFIRM, the rest SAFE", () => {
    const risk = Object.fromEntries(defs().map((d) => [d.name, d.risk]));
    expect(risk).toEqual({
      objective_create: "SAFE",
      objective_list: "READ_ONLY",
      objective_update: "SAFE",
      objective_pause: "SAFE",
      objective_resume: "SAFE",
      objective_delete: "CONFIRM",
    });
  });

  test("create, list with reflection, update, pause, delete; objectives cannot manage objectives", async () => {
    const s = setup();
    const source = new ObjectivesSource(s.service);
    const made = await source.execute(
      "objective_create",
      {
        title: "houd de garage in de gaten",
        template: "ha_waarde",
        entity: "cover.garage",
        operator: "==",
        value: "open",
        consecutive: 3,
      },
      { sessionId: "chat1" },
    );
    expect(made.ok).toBe(true);
    const id = (made.result as { id: string }).id;
    const blocked = await source.execute(
      "objective_create",
      { title: "nog een doel hier", template: "agenda_leeg" },
      { sessionId: `objective_${id}` },
    );
    expect(blocked.ok).toBe(false);
    expect(
      (
        await source.execute(
          "objective_delete",
          { id },
          { sessionId: "agent_abcd" },
        )
      ).ok,
    ).toBe(false);
    s.world.ha = "open";
    for (let i = 0; i < 3; i++) {
      await s.service.tick();
      s.advance(5 * MIN);
    }
    const listed = await source.execute(
      "objective_list",
      {},
      { sessionId: "chat1" },
    );
    const row = (listed.result as Row[])[0]!;
    expect(row.anomaliesLast7Days).toBe(1);
    expect(row.counters.checks).toBe(3);
    expect(row.history).toHaveLength(3);
    expect(row.activeAnomaly.urgency).toBe("warn");
    const upd = await source.execute(
      "objective_update",
      { id, quietHours: "22:00-08:00", dismiss: true },
      { sessionId: "chat1" },
    );
    expect(upd.ok).toBe(true);
    expect((upd.result as Row).counters.falseAlarms).toBe(1);
    expect((upd.result as Row).quietHours).toBe("22:00-08:00");
    expect(
      (await source.execute("objective_pause", { id }, { sessionId: "chat1" }))
        .result,
    ).toMatchObject({ enabled: false });
    expect(
      (await source.execute("objective_resume", { id }, { sessionId: "chat1" }))
        .result,
    ).toMatchObject({ enabled: true });
    expect(
      (await source.execute("objective_delete", { id }, { sessionId: "chat1" }))
        .ok,
    ).toBe(true);
    expect(s.service.list()).toHaveLength(0);
    expect(
      (await source.execute("objective_pause", { id }, { sessionId: "chat1" }))
        .ok,
    ).toBe(false);
  });

  test("controller lists, updates and deletes; bad ids are rejected", () => {
    const s = setup();
    const controller = new ObjectivesController(s.service);
    const o = cpuObjective(s);
    expect(controller.list().objectives).toHaveLength(1);
    expect(controller.update(o.id, { enabled: false }).enabled).toBe(false);
    expect(() => controller.update("../x", {})).toThrow();
    expect(() => controller.update(o.id, { intervalMinutes: 1 })).toThrow();
    expect(controller.remove(o.id)).toEqual({ deleted: true });
    expect(() => controller.remove(o.id)).toThrow();
  });

  test("Dutch phrases rank the objective tools", () => {
    const tools = [
      ...defs().map((d) => d.name),
      "clock_now",
      "light_toggle",
      "weather_forecast",
    ].map((name) => ({
      type: "function" as const,
      function: {
        name,
        description: defs().find((d) => d.name === name)?.description ?? name,
        parameters: {},
      },
    }));
    for (const phrase of [
      "houd de garage-deur in de gaten",
      "zorg dat mijn servers gezond blijven",
      "laat het me weten als de dienst uitvalt",
      "monitor mijn netwerk",
    ]) {
      const top = rankToolsForRequest(tools, phrase, "chat" as never)
        .slice(0, 6)
        .map((t) => t.function.name);
      expect(top, phrase).toContain("objective_create");
    }
  });
});
