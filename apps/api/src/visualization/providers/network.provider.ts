import { Injectable, type OnModuleInit } from "@nestjs/common";
import type {
  HaEntity,
  NetworkRate,
  ServiceCheckResult,
  VizEdge,
  VizNode,
  VizStatus,
} from "@nova/contracts";
import { ChecksService } from "../../checks/checks.service.js";
import { HostMetricsService } from "../../dashboard/host-metrics.service.js";
import { HomeAssistantService } from "../../home/home-assistant.service.js";
import { VisualizationRegistry } from "../visualization.registry.js";
import type {
  ProviderScene,
  VisualizationProvider,
  VizTypeDefinition,
} from "../visualization.types.js";

/** Reaction time that fills the heat scale. Documented in the scene note. */
const HEAT_FULL_MS = 1000;
const MAX_TRACKERS = 150;

const rate = (bytes: number): string =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB/s`
    : `${Math.round(bytes / 1024)} kB/s`;

export function trackerStatus(state: string | undefined): VizStatus {
  if (state === "home") return "ok";
  if (state === "not_home") return "off";
  return "unknown";
}

export interface NetworkSnapshot {
  checks: ServiceCheckResult[];
  throughput: NetworkRate | null;
  /** Null when Home Assistant is not configured or did not answer. */
  trackers: HaEntity[] | null;
}

/** Pure mapping of the telemetry NOVA really has; everything else stays "onbekend". */
export function networkGraph(snapshot: NetworkSnapshot): ProviderScene {
  const nodes: VizNode[] = [
    {
      id: "nova",
      label: "NOVA-server",
      kind: "host",
      layer: "services",
      status: snapshot.throughput ? "ok" : "unknown",
      size: 1.6,
      detail: {
        ontvangen: snapshot.throughput
          ? rate(snapshot.throughput.rxPerSec)
          : "onbekend (geen node-exporter bereikbaar)",
        verzonden: snapshot.throughput
          ? rate(snapshot.throughput.txPerSec)
          : "onbekend (geen node-exporter bereikbaar)",
      },
    },
  ];
  const edges: VizEdge[] = [];
  for (const check of snapshot.checks) {
    const id = `service:${check.name}`;
    nodes.push({
      id,
      label: check.name,
      kind: "service",
      parent: "nova",
      layer: "services",
      status: check.ok ? "ok" : "critical",
      value: check.ok ? Math.min(1, check.ms / HEAT_FULL_MS) : null,
      detail: {
        bereikbaar: check.ok,
        reactietijd: check.ok ? `${check.ms} ms` : "geen antwoord",
        melding: check.detail ? check.detail.slice(0, 120) : null,
      },
    });
    edges.push({
      from: "nova",
      to: id,
      label: "gecontroleerd vanaf NOVA",
      status: check.ok ? "ok" : "critical",
    });
  }
  if (snapshot.trackers) {
    const trackers = snapshot.trackers.slice(0, MAX_TRACKERS);
    nodes.push({
      id: "ha-trackers",
      label: "Apparaten (Home Assistant)",
      kind: "inventory",
      parent: "nova",
      layer: "devices",
      status: trackers.length ? "ok" : "unknown",
      detail: {
        thuis: trackers.filter((t) => t.state === "home").length,
        niet_thuis: trackers.filter((t) => t.state === "not_home").length,
        onbekend: trackers.filter(
          (t) => t.state !== "home" && t.state !== "not_home",
        ).length,
      },
    });
    edges.push({
      from: "nova",
      to: "ha-trackers",
      label: "via Home Assistant",
    });
    for (const tracker of trackers) {
      const id = `tracker:${tracker.entity_id}`;
      nodes.push({
        id,
        label: tracker.friendly_name || tracker.entity_id,
        kind: "device",
        parent: "ha-trackers",
        layer: "devices",
        status: trackerStatus(tracker.state),
        size: 0.8,
        detail: {
          aanwezigheid:
            tracker.state === "home"
              ? "thuis"
              : tracker.state === "not_home"
                ? "niet thuis"
                : "onbekend",
          bijgewerkt: tracker.last_updated ?? null,
        },
      });
      edges.push({
        from: "ha-trackers",
        to: id,
        label: "gemeld door Home Assistant",
      });
    }
  }
  return {
    title: "Netwerk",
    nodes,
    edges,
    layers: [
      { id: "services", label: "Diensten" },
      { id: "devices", label: "Apparaten" },
    ],
    heatLabel: `Reactietijd (${HEAT_FULL_MS} ms is vol)`,
    notes: [
      "Alleen echte metingen: bereikbaarheidscontroles vanaf NOVA, doorvoer van deze server (node-exporter) en de device_tracker-apparaten van Home Assistant.",
      "Er is geen telemetrie van router, switch of access point. Zulke onderdelen en hun verbindingen worden dus niet getekend; onbekend blijft onbekend.",
      ...(snapshot.trackers === null
        ? [
            "Home Assistant gaf geen apparaten terug; de apparaatlijst ontbreekt.",
          ]
        : []),
    ],
    refreshMs: 30_000,
  };
}

export function networkLatency(snapshot: NetworkSnapshot): ProviderScene {
  return {
    title: "Netwerk: reactietijden",
    chart: {
      type: "bar",
      unit: "ms",
      series: [
        {
          label: "Reactietijd",
          points: snapshot.checks.map((check) => ({
            label: check.name,
            value: check.ok ? check.ms : null,
            status: (check.ok ? "ok" : "critical") as VizStatus,
          })),
        },
      ],
    },
    notes: [
      "Gemeten vanaf NOVA. Een lege balk betekent: geen antwoord, dus geen meetwaarde.",
    ],
    refreshMs: 30_000,
  };
}

const TYPES: VizTypeDefinition[] = [
  {
    id: "overview",
    title: "Netwerk",
    kind: "graph",
    description:
      "Bereikbaarheid en reactietijd van de diensten die NOVA controleert, doorvoer van de server en apparaten uit Home Assistant. Onbekend blijft onbekend.",
    keywords: [
      "netwerk",
      "network",
      "internet",
      "dns",
      "diensten",
      "services",
      "bereikbaar",
      "apparaten",
      "wifi",
      "verbinding",
    ],
  },
  {
    id: "latency",
    title: "Netwerk: reactietijden",
    kind: "chart",
    description: "Staafgrafiek van de reactietijd per gecontroleerde dienst.",
    keywords: ["reactietijd", "latency", "ping", "traag"],
  },
];

@Injectable()
export class NetworkVisualizationProvider
  implements VisualizationProvider, OnModuleInit
{
  readonly id = "network";
  readonly label = "Netwerk";
  readonly types = TYPES;
  readonly requires = {
    service: "checks, host-metrics, home-assistant",
    access: "read-only" as const,
  };

  constructor(
    private readonly checks: ChecksService,
    private readonly host: HostMetricsService,
    private readonly home: HomeAssistantService,
    private readonly registry: VisualizationRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  available(): { ok: true } {
    return { ok: true };
  }

  async build(typeId: string): Promise<ProviderScene> {
    const checks = await this.checks.check();
    let trackers: HaEntity[] | null = null;
    if (this.home.configured) {
      try {
        await this.home.sync();
        trackers = this.home
          .visibleEntities()
          .filter((entity) => entity.domain === "device_tracker");
      } catch {
        trackers = null;
      }
    }
    const snapshot = { checks, throughput: this.host.network, trackers };
    return typeId === "latency"
      ? networkLatency(snapshot)
      : networkGraph(snapshot);
  }
}
