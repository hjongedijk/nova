import { describe, expect, it } from "vitest";
import type { HaEntity } from "@nova/contracts";
import type { AuditEntry } from "../../src/core/audit/audit.service.js";
import {
  activityCalls,
  activityGraph,
  callsFromAudit,
} from "../../src/visualization/providers/ai-activity.provider.js";
import {
  entityStatus,
  homeGraph,
} from "../../src/visualization/providers/home.provider.js";
import {
  networkGraph,
  networkLatency,
} from "../../src/visualization/providers/network.provider.js";
import {
  guestStatus,
  nodeStatus,
  proxmoxLoad,
  proxmoxTopology,
  storageStatus,
  type ProxmoxSnapshot,
} from "../../src/visualization/providers/proxmox.provider.js";
import { validateScene } from "../../src/visualization/scene.validation.js";
import { VisualizationService } from "../../src/visualization/visualization.service.js";
import { VisualizationRegistry } from "../../src/visualization/visualization.registry.js";

const GB = 1073741824;
const snapshot: ProxmoxSnapshot = {
  nodes: [
    {
      node: "pve",
      status: "online",
      cpu: 0.25,
      cores: 8,
      memUsed: 8 * GB,
      memTotal: 16 * GB,
      uptime: 90_000,
    },
    {
      node: "pve2",
      status: "offline",
      cpu: null,
      cores: 4,
      memUsed: 0,
      memTotal: 0,
      uptime: 0,
    },
  ],
  guests: [
    {
      vmid: 104,
      name: "web",
      node: "pve",
      type: "qemu",
      label: "QEMU VM",
      status: "running",
      cpuUsagePercent: 95,
      memoryUsed: 2 * GB,
      memoryTotal: 4 * GB,
      uptime: 100,
    },
    {
      vmid: 105,
      name: "ct",
      node: "pve",
      type: "lxc",
      label: "LXC container",
      status: "stopped",
      cpuUsagePercent: 0,
      memoryUsed: 0,
      memoryTotal: GB,
      uptime: 0,
    },
    {
      vmid: 106,
      name: "ghost",
      node: "gone",
      type: "qemu",
      label: "QEMU VM",
      status: "weird",
      cpuUsagePercent: 0,
      memoryUsed: 0,
      memoryTotal: 0,
      uptime: 0,
    },
  ],
  storage: [
    {
      storage: "local",
      node: "pve",
      status: "available",
      plugintype: "dir",
      disk: 95 * GB,
      maxdisk: 100 * GB,
    },
    { storage: "shared", status: "available" },
  ],
};

async function validated(scene: ReturnType<typeof proxmoxTopology>) {
  const service = new VisualizationService(new VisualizationRegistry());
  const created = service.createCustom({
    title: scene.title,
    kind: scene.chart ? "chart" : "graph",
    nodes: scene.nodes,
    edges: scene.edges,
    chart: scene.chart,
    layers: scene.layers,
  });
  return validateScene(created);
}

describe("Proxmox provider mapping", () => {
  it("maps nodes, guests and storage to a valid topology with real states", async () => {
    const scene = proxmoxTopology(snapshot);
    const byId = Object.fromEntries(scene.nodes!.map((n) => [n.id, n]));
    expect(byId["node:pve"]).toMatchObject({ status: "ok", value: 0.25 });
    expect(byId["node:pve2"]).toMatchObject({
      status: "critical",
      value: null,
    });
    expect(byId["guest:104"]).toMatchObject({
      status: "ok",
      kind: "vm",
      parent: "node:pve",
      value: 0.95,
    });
    expect(byId["guest:105"]).toMatchObject({
      status: "off",
      kind: "lxc",
      value: null,
    });
    // Unknown state and unknown host stay unknown / hang under the cluster, not invented.
    expect(byId["guest:106"]).toMatchObject({
      status: "unknown",
      parent: "cluster",
    });
    expect(byId["storage:pve/local"]).toMatchObject({ status: "critical" });
    expect(byId["storage:shared/shared"]).toMatchObject({
      status: "unknown",
      parent: "cluster",
      value: null,
    });
    expect(scene.edges).toContainEqual({
      from: "node:pve",
      to: "guest:104",
      label: "draait op",
    });
    expect(await validated(scene)).toEqual({ ok: true, errors: [] });
    // Stopped guests may be started only via a chat sentence (normal confirmation applies).
    expect(scene.actions?.map((a) => a.prompt)).toEqual([
      "Start container 105 (ct)",
    ]);
  });

  it("builds a load chart with null for what has no measurement", async () => {
    const scene = proxmoxLoad(snapshot);
    const cpu = scene.chart!.series[0]!.points;
    expect(cpu.find((p) => p.label === "pve2")).toMatchObject({
      value: null,
      status: "unknown",
    });
    expect(cpu.find((p) => p.label === "web")).toMatchObject({
      value: 95,
      status: "critical",
    });
    expect(cpu.some((p) => p.label === "ct")).toBe(false);
    expect(await validated(scene)).toEqual({ ok: true, errors: [] });
  });

  it("state helpers", () => {
    expect(nodeStatus("online")).toBe("ok");
    expect(nodeStatus(undefined)).toBe("unknown");
    expect(guestStatus("paused")).toBe("warning");
    expect(storageStatus("available", 0.85)).toBe("warning");
    expect(storageStatus("available", null)).toBe("unknown");
  });
});

const audit = (over: Partial<AuditEntry>): AuditEntry => ({
  id: "x",
  timestamp: "2026-10-16T10:00:00.000Z",
  sessionId: "s1",
  tool: "proxmox_guests",
  risk: "READ_ONLY",
  result: { ok: true },
  durationMs: 100,
  ...over,
});

describe("AI activity provider mapping", () => {
  const entries = [
    audit({ tool: "ha_call_service", result: { ok: false, error: "nee" } }),
    audit({ tool: "proxmox_guests" }),
    audit({ tool: "proxmox_guests", sessionId: "s2", durationMs: 300 }),
    audit({ tool: "proxmox_guests", phase: "execution_started" }),
    audit({
      tool: "memory_candidate",
      confirmation: "standing_approval_created",
    }),
    audit({
      tool: "ha_lock",
      result: { ok: false, requiresConfirmation: true },
      arguments: { secret: "do-not-leak" },
    }),
    audit({ tool: "dashboard_poll", sessionId: "dashboard" }),
  ];

  it("uses only real tool calls and skips phase/bookkeeping records", () => {
    const calls = callsFromAudit(entries);
    expect(calls.map((c) => c.tool)).toEqual([
      "ha_call_service",
      "proxmox_guests",
      "proxmox_guests",
      "ha_lock",
      "dashboard_poll",
    ]);
  });

  it("maps outcomes without reading arguments or claiming reasoning", async () => {
    const scene = activityGraph(entries);
    const json = JSON.stringify(scene);
    expect(json).not.toContain("do-not-leak");
    const byId = Object.fromEntries(scene.nodes!.map((n) => [n.id, n]));
    expect(byId["tool:ha_call_service"]).toMatchObject({ status: "critical" });
    expect(byId["tool:ha_lock"]).toMatchObject({ status: "warning" });
    expect(byId["tool:proxmox_guests"]).toMatchObject({
      status: "ok",
      value: 1,
      detail: expect.objectContaining({
        aanroepen: 2,
        gemiddelde_duur_ms: 200,
      }),
    });
    expect(byId["session:0"]!.label).toBe("Gesprek 1");
    expect(scene.nodes!.find((n) => n.kind === "background")!.label).toMatch(
      /^Achtergrond: dashboard/,
    );
    expect(scene.notes![0]).toContain("geen redenering");
    expect(await validated(scene)).toEqual({ ok: true, errors: [] });
  });

  it("builds the calls chart", async () => {
    const scene = activityCalls(entries);
    expect(scene.chart!.series[0]!.points[0]).toMatchObject({
      label: "proxmox_guests",
      value: 2,
    });
    expect(await validated(scene)).toEqual({ ok: true, errors: [] });
  });
});

const ha = (over: Partial<HaEntity>): HaEntity => ({
  entity_id: "light.kitchen",
  state: "on",
  attributes: { brightness: 128 },
  domain: "light",
  friendly_name: "Keuken",
  area_id: "kitchen",
  area: "Keuken",
  device_id: null,
  device: null,
  aliases: [],
  capabilities: [],
  supported_features: 0,
  synced_at: null,
  last_seen: null,
  ...over,
});

describe("Home Assistant provider mapping", () => {
  const entities = [
    ha({}),
    ha({
      entity_id: "light.hall",
      friendly_name: "Gang",
      area_id: null,
      area: null,
      state: "unavailable",
    }),
    ha({
      entity_id: "sensor.temp",
      domain: "sensor",
      state: "21.5",
      attributes: { unit_of_measurement: "°C" },
      friendly_name: "Temperatuur",
    }),
    ha({ entity_id: "person.me", domain: "person", state: "home" }),
    ha({
      entity_id: "device_tracker.phone",
      domain: "device_tracker",
      state: "home",
    }),
    ha({
      entity_id: "lock.door",
      domain: "lock",
      state: "unlocked",
      friendly_name: "Deur",
    }),
  ];

  it("groups by the real Home Assistant areas and invents no layout", async () => {
    const scene = homeGraph(entities);
    const ids = scene.nodes!.map((n) => n.id);
    expect(ids).toContain("area:kitchen");
    expect(ids).toContain("area:none");
    expect(ids).not.toContain("entity:person.me");
    expect(ids).not.toContain("entity:device_tracker.phone");
    expect(scene.nodes!.every((n) => n.position === undefined)).toBe(true);
    expect(scene.notes!.join(" ")).toContain("Er is geen plattegrond");
    const byId = Object.fromEntries(scene.nodes!.map((n) => [n.id, n]));
    expect(byId["entity:light.kitchen"]).toMatchObject({
      status: "active",
      value: 128 / 255,
    });
    expect(byId["entity:light.hall"]).toMatchObject({ status: "warning" });
    expect(byId["entity:lock.door"]).toMatchObject({ status: "warning" });
    expect(byId["entity:sensor.temp"]!.detail).toMatchObject({
      waarde: "21.5 °C",
    });
    expect(scene.actions![0]!.prompt).toBe("Zet de lampen in Keuken uit");
    expect(await validated(scene)).toEqual({ ok: true, errors: [] });
  });

  it("entityStatus keeps unknown as unknown", () => {
    expect(entityStatus(ha({ state: "unknown" }))).toBe("unknown");
    expect(entityStatus(ha({ state: "off" }))).toBe("off");
  });
});

describe("network provider mapping", () => {
  it("shows unknown as unknown and invents no router", async () => {
    const scene = networkGraph({
      checks: [
        { name: "internet", ok: true, ms: 40, detail: "HTTP 200" },
        { name: "dns", ok: false, ms: 0, detail: "geen antwoord" },
      ],
      throughput: null,
      trackers: [
        ha({
          entity_id: "device_tracker.phone",
          domain: "device_tracker",
          state: "home",
          friendly_name: "Telefoon",
        }),
        ha({
          entity_id: "device_tracker.tv",
          domain: "device_tracker",
          state: "weird",
          friendly_name: "TV",
        }),
      ],
    });
    const byId = Object.fromEntries(scene.nodes!.map((n) => [n.id, n]));
    expect(byId["nova"]).toMatchObject({ status: "unknown" });
    expect(String(byId["nova"]!.detail!.ontvangen)).toContain("onbekend");
    expect(byId["service:dns"]).toMatchObject({
      status: "critical",
      value: null,
    });
    expect(byId["service:internet"]).toMatchObject({
      status: "ok",
      value: 0.04,
    });
    expect(byId["tracker:device_tracker.tv"]).toMatchObject({
      status: "unknown",
    });
    expect(
      scene.nodes!.some((n) => /router|switch|access/i.test(n.label)),
    ).toBe(false);
    expect(scene.notes!.join(" ")).toContain("onbekend blijft onbekend");
    expect(await validated(scene)).toEqual({ ok: true, errors: [] });
  });

  it("omits the device list when Home Assistant gave nothing", () => {
    const scene = networkGraph({
      checks: [],
      throughput: { rxPerSec: 2048, txPerSec: 1024 },
      trackers: null,
    });
    expect(scene.nodes!.map((n) => n.id)).toEqual(["nova"]);
    expect(scene.nodes![0]!.detail).toMatchObject({ ontvangen: "2 kB/s" });
    expect(scene.notes!.join(" ")).toContain("ontbreekt");
  });

  it("latency chart leaves failed probes empty", () => {
    const scene = networkLatency({
      checks: [{ name: "dns", ok: false, ms: 0, detail: "" }],
      throughput: null,
      trackers: null,
    });
    expect(scene.chart!.series[0]!.points[0]).toMatchObject({ value: null });
  });
});
