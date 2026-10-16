import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { VizNode, VizEdge, VizStatus } from "@nova/contracts";
import {
  ProxmoxService,
  type GuestView,
  type PveResource,
} from "../../proxmox/proxmox.service.js";
import { VisualizationRegistry } from "../visualization.registry.js";
import type {
  ProviderScene,
  VisualizationProvider,
  VizTypeDefinition,
} from "../visualization.types.js";

const GB = 1073741824;
const round1 = (value: number) => Math.round(value * 10) / 10;
const ratio = (used: number, total: number): number | null =>
  total > 0 ? Math.min(1, Math.max(0, used / total)) : null;
const pct = (value: number | null) =>
  value === null ? "onbekend" : `${Math.round(value * 100)}%`;
const loadStatus = (value: number | null): VizStatus =>
  value === null
    ? "unknown"
    : value >= 0.9
      ? "critical"
      : value >= 0.75
        ? "warning"
        : "ok";

export function nodeStatus(status: string | undefined): VizStatus {
  if (status === "online") return "ok";
  if (status === "offline") return "critical";
  return "unknown";
}
export function guestStatus(status: string | undefined): VizStatus {
  if (status === "running") return "ok";
  if (status === "stopped") return "off";
  if (status === "paused" || status === "suspended") return "warning";
  return "unknown";
}
export function storageStatus(
  status: string | undefined,
  usage: number | null,
): VizStatus {
  if (status === "unavailable") return "critical";
  if (usage === null) return "unknown";
  return usage >= 0.9 ? "critical" : usage >= 0.8 ? "warning" : "ok";
}

export interface ProxmoxSnapshot {
  nodes: {
    node: string;
    status: string;
    cpu: number | null;
    cores: number;
    memUsed: number;
    memTotal: number;
    uptime: number;
  }[];
  guests: GuestView[];
  storage: PveResource[];
}

const uptimeText = (seconds: number): string => {
  if (!seconds) return "gestopt of onbekend";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days
    ? `${days} d ${hours} u`
    : `${hours} u ${Math.floor((seconds % 3600) / 60)} min`;
};

/** Pure mapping of the real Proxmox data to a topology graph (tested without Proxmox). */
export function proxmoxTopology(snapshot: ProxmoxSnapshot): ProviderScene {
  const nodes: VizNode[] = [
    {
      id: "cluster",
      label: "Proxmox",
      kind: "cluster",
      layer: "nodes",
      status: snapshot.nodes.some((n) => n.status !== "online")
        ? "warning"
        : snapshot.nodes.length
          ? "ok"
          : "unknown",
      size: 1.6,
      detail: {
        nodes: snapshot.nodes.length,
        guests: snapshot.guests.length,
        actief: snapshot.guests.filter((g) => g.status === "running").length,
      },
    },
  ];
  const edges: VizEdge[] = [];
  const nodeIds = new Set(snapshot.nodes.map((n) => n.node));
  for (const n of snapshot.nodes) {
    const memory = ratio(n.memUsed, n.memTotal);
    nodes.push({
      id: `node:${n.node}`,
      label: n.node,
      kind: "node",
      parent: "cluster",
      layer: "nodes",
      status: nodeStatus(n.status),
      value: n.status === "online" ? n.cpu : null,
      size: 1.3,
      detail: {
        toestand: n.status || "onbekend",
        cpu: n.status === "online" ? pct(n.cpu) : "onbekend",
        cores: n.cores,
        geheugen:
          n.memTotal > 0
            ? `${round1(n.memUsed / GB)} van ${round1(n.memTotal / GB)} GB (${pct(memory)})`
            : "onbekend",
        uptime: uptimeText(n.uptime),
      },
    });
    edges.push({ from: "cluster", to: `node:${n.node}`, label: "bevat" });
  }
  for (const g of snapshot.guests) {
    const hostId = g.node && nodeIds.has(g.node) ? `node:${g.node}` : "cluster";
    const running = g.status === "running";
    const cpu = running ? Math.min(1, g.cpuUsagePercent / 100) : null;
    const memory = ratio(g.memoryUsed, g.memoryTotal);
    const id = `guest:${g.vmid}`;
    nodes.push({
      id,
      label: g.name || `${g.type === "lxc" ? "CT" : "VM"} ${g.vmid}`,
      kind: g.type === "lxc" ? "lxc" : "vm",
      parent: hostId,
      layer: "guests",
      status: guestStatus(g.status),
      value: cpu,
      detail: {
        vmid: g.vmid ?? null,
        soort: g.label,
        toestand: g.status ?? "onbekend",
        node: g.node ?? "onbekend",
        cpu: running ? pct(cpu) : "niet actief",
        geheugen:
          running && g.memoryTotal > 0
            ? `${round1(g.memoryUsed / GB)} van ${round1(g.memoryTotal / GB)} GB (${pct(memory)})`
            : g.memoryTotal > 0
              ? `${round1(g.memoryTotal / GB)} GB toegewezen`
              : "onbekend",
        uptime: running ? uptimeText(g.uptime) : "niet actief",
      },
    });
    edges.push({ from: hostId, to: id, label: "draait op" });
  }
  for (const s of snapshot.storage) {
    if (!s.storage) continue;
    const hostId = s.node && nodeIds.has(s.node) ? `node:${s.node}` : "cluster";
    const usage = ratio(s.disk ?? 0, s.maxdisk ?? 0);
    const id = `storage:${s.node ?? "shared"}/${s.storage}`;
    nodes.push({
      id,
      label: s.storage,
      kind: "storage",
      parent: hostId,
      layer: "storage",
      status: storageStatus(s.status, usage),
      value: usage,
      detail: {
        toestand: s.status ?? "onbekend",
        type: s.plugintype ?? "onbekend",
        gebruikt:
          s.maxdisk && s.maxdisk > 0
            ? `${round1((s.disk ?? 0) / GB)} van ${round1(s.maxdisk / GB)} GB (${pct(usage)})`
            : "onbekend",
        node: s.node ?? "gedeeld",
      },
    });
    edges.push({ from: hostId, to: id, label: "opslag" });
  }
  const stopped = snapshot.guests.filter((g) => g.status === "stopped");
  return {
    title: "Proxmox-topologie",
    nodes,
    edges,
    layers: [
      { id: "nodes", label: "Nodes" },
      { id: "guests", label: "VM's en containers" },
      { id: "storage", label: "Opslag" },
    ],
    heatLabel: "CPU-belasting (opslag: gebruikte ruimte)",
    notes: [
      "Bron: de Proxmox-API; alleen nodes, gasten en opslag die NOVA mag zien.",
      "Kleur toont de status; in de warmtemodus de CPU-belasting. Gestopte gasten hebben geen waarde.",
      "Starten of stoppen gaat via NOVA en vraagt altijd bevestiging.",
    ],
    actions: stopped.slice(0, 6).map((g) => ({
      id: `start-${g.vmid}`,
      label: `Start ${g.name ?? g.vmid}`,
      prompt: `Start ${g.type === "lxc" ? "container" : "VM"} ${g.vmid}${g.name ? ` (${g.name})` : ""}`,
    })),
    refreshMs: 15_000,
  };
}

/** Bar chart of CPU and memory of nodes and running guests. */
export function proxmoxLoad(snapshot: ProxmoxSnapshot): ProviderScene {
  const cpu: { label: string; value: number | null; status: VizStatus }[] = [];
  const mem: typeof cpu = [];
  for (const n of snapshot.nodes) {
    const memory = ratio(n.memUsed, n.memTotal);
    const c = n.status === "online" ? n.cpu : null;
    cpu.push({
      label: n.node,
      value: c === null ? null : c * 100,
      status: loadStatus(c),
    });
    mem.push({
      label: n.node,
      value: memory === null ? null : memory * 100,
      status: loadStatus(memory),
    });
  }
  for (const g of snapshot.guests.filter((item) => item.status === "running")) {
    const label = g.name || `${g.vmid}`;
    const c = Math.min(1, g.cpuUsagePercent / 100);
    const m = ratio(g.memoryUsed, g.memoryTotal);
    cpu.push({ label, value: c * 100, status: loadStatus(c) });
    mem.push({
      label,
      value: m === null ? null : m * 100,
      status: loadStatus(m),
    });
  }
  return {
    title: "Proxmox-belasting",
    chart: {
      type: "bar",
      unit: "%",
      max: 100,
      series: [
        { label: "CPU", points: cpu.slice(0, 60) },
        { label: "Geheugen", points: mem.slice(0, 60) },
      ],
    },
    notes: [
      "Bron: de Proxmox-API. Alleen nodes en draaiende gasten; gestopte gasten hebben geen belasting.",
    ],
    refreshMs: 15_000,
  };
}

const TYPES: VizTypeDefinition[] = [
  {
    id: "topology",
    title: "Proxmox-topologie",
    kind: "graph",
    description:
      "Nodes, VM's, LXC-containers en opslag van Proxmox met status, CPU en geheugen (live).",
    keywords: [
      "proxmox",
      "server",
      "servers",
      "vm",
      "vms",
      "vm's",
      "lxc",
      "container",
      "containers",
      "node",
      "nodes",
      "opslag",
      "storage",
      "cluster",
      "topologie",
      "topology",
    ],
  },
  {
    id: "load",
    title: "Proxmox-belasting",
    kind: "chart",
    description:
      "Staafgrafiek van CPU en geheugen van nodes en draaiende gasten (live).",
    keywords: ["belasting", "load", "druk", "cpu", "geheugen", "memory", "ram"],
  },
];

@Injectable()
export class ProxmoxVisualizationProvider
  implements VisualizationProvider, OnModuleInit
{
  readonly id = "proxmox";
  readonly label = "Proxmox";
  readonly types = TYPES;
  readonly requires = { service: "proxmox", access: "read-only" as const };

  constructor(
    private readonly proxmox: ProxmoxService,
    private readonly registry: VisualizationRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  available(): { ok: true } | { ok: false; reason: string } {
    return this.proxmox.configured
      ? { ok: true }
      : { ok: false, reason: "Proxmox is niet gekoppeld of niet ingesteld." };
  }

  async snapshot(signal: AbortSignal): Promise<ProxmoxSnapshot> {
    const [status, guests, storage] = await Promise.all([
      this.proxmox.status(signal),
      this.proxmox.guestViews(signal),
      this.proxmox.rawStorage(signal).catch(() => [] as PveResource[]),
    ]);
    return {
      nodes: status.nodes.map((n) => ({
        node: n.node,
        status: n.status,
        cpu: n.status === "online" ? n.cpu.usagePercent / 100 : null,
        cores: n.cpu.cores,
        memUsed: n.memory.usedGB * GB,
        memTotal: n.memory.totalGB * GB,
        uptime: n.uptimeSeconds,
      })),
      guests,
      storage,
    };
  }

  async build(
    typeId: string,
    context: { signal: AbortSignal },
  ): Promise<ProviderScene> {
    const snapshot = await this.snapshot(context.signal);
    if (!snapshot.nodes.length && !snapshot.guests.length)
      throw new Error("Proxmox gaf geen nodes of gasten terug.");
    return typeId === "load"
      ? proxmoxLoad(snapshot)
      : proxmoxTopology(snapshot);
  }
}
