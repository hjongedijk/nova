import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { HaEntity, VizEdge, VizNode, VizStatus } from "@nova/contracts";
import { HomeAssistantService } from "../../home/home-assistant.service.js";
import { VisualizationRegistry } from "../visualization.registry.js";
import type {
  ProviderScene,
  VisualizationProvider,
  VizTypeDefinition,
} from "../visualization.types.js";

/** Domains shown, in priority order when the home has more than MAX_ENTITIES entities. */
const DOMAINS = [
  "light",
  "climate",
  "switch",
  "cover",
  "lock",
  "media_player",
  "fan",
  "binary_sensor",
  "sensor",
] as const;
const LAYER_OF: Record<string, string> = {
  light: "lights",
  climate: "climate",
  switch: "switches",
  fan: "switches",
  cover: "openings",
  lock: "openings",
  binary_sensor: "sensors",
  sensor: "sensors",
  media_player: "media",
};
const MAX_ENTITIES = 350;

export function entityStatus(entity: HaEntity): VizStatus {
  const state = entity.state;
  if (state === "unavailable") return "warning";
  if (state === "unknown" || state === "" || state === undefined)
    return "unknown";
  switch (entity.domain) {
    case "light":
    case "switch":
    case "fan":
    case "binary_sensor":
      return state === "on" ? "active" : state === "off" ? "off" : "unknown";
    case "climate":
      return state === "off" ? "off" : "active";
    case "cover":
      return state === "closed" ? "off" : "active";
    case "lock":
      return state === "locked"
        ? "ok"
        : state === "unlocked"
          ? "warning"
          : "unknown";
    case "media_player":
      return state === "playing" ? "active" : state === "off" ? "off" : "ok";
    case "sensor":
      return Number.isFinite(Number(state)) || state ? "ok" : "unknown";
    default:
      return "unknown";
  }
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value ? value.slice(0, 60) : null;

/** Pure mapping of Home Assistant's real areas and entities (tested without Home Assistant). */
export function homeGraph(all: HaEntity[]): ProviderScene {
  const wanted = all
    .filter((e) => (DOMAINS as readonly string[]).includes(e.domain))
    .sort(
      (a, b) =>
        DOMAINS.indexOf(a.domain as (typeof DOMAINS)[number]) -
          DOMAINS.indexOf(b.domain as (typeof DOMAINS)[number]) ||
        a.entity_id.localeCompare(b.entity_id),
    );
  const entities = wanted.slice(0, MAX_ENTITIES);
  const nodes: VizNode[] = [];
  const edges: VizEdge[] = [];
  const areas = new Map<string, { label: string; entities: HaEntity[] }>();
  for (const entity of entities) {
    const key = entity.area_id ?? "none";
    const area = areas.get(key) ?? {
      label: entity.area ?? "Zonder ruimte",
      entities: [],
    };
    area.entities.push(entity);
    areas.set(key, area);
  }
  const rooms: VizNode[] = [];
  const actions: ProviderScene["actions"] = [];
  for (const [key, area] of [...areas].sort((a, b) =>
    a[1].label.localeCompare(b[1].label, "nl"),
  )) {
    const lights = area.entities.filter((e) => e.domain === "light");
    const lightsOn = lights.filter((e) => e.state === "on").length;
    const statuses = area.entities.map(entityStatus);
    const status: VizStatus = statuses.includes("warning")
      ? "warning"
      : statuses.includes("active")
        ? "active"
        : statuses.every((s) => s === "unknown")
          ? "unknown"
          : "off";
    rooms.push({
      id: `area:${key}`,
      label: area.label,
      kind: "room",
      parent: "home",
      layer: "rooms",
      status,
      size: 1.2,
      detail: {
        apparaten: area.entities.length,
        lampen_aan: lights.length ? `${lightsOn} van ${lights.length}` : null,
      },
    });
    edges.push({ from: "home", to: `area:${key}`, label: "ruimte" });
    if (lightsOn && key !== "none" && actions.length < 6)
      actions.push({
        id: `off-${key}`,
        label: `Lampen uit in ${area.label}`,
        prompt: `Zet de lampen in ${area.label} uit`,
      });
  }
  nodes.push({
    id: "home",
    label: "Huis",
    kind: "home",
    layer: "rooms",
    status: entities.length ? "ok" : "unknown",
    size: 1.6,
    detail: { ruimtes: rooms.length, apparaten: entities.length },
  });
  nodes.push(...rooms);
  for (const entity of entities) {
    const area = `area:${entity.area_id ?? "none"}`;
    const brightness =
      entity.domain === "light" && entity.state === "on"
        ? num(entity.attributes.brightness)
        : null;
    const unit = text(entity.attributes.unit_of_measurement);
    const reading =
      entity.domain === "sensor" && entity.state !== "unknown"
        ? `${entity.state}${unit ? ` ${unit}` : ""}`
        : null;
    nodes.push({
      id: `entity:${entity.entity_id}`,
      label: entity.friendly_name || entity.entity_id,
      kind: entity.domain,
      parent: area,
      layer: LAYER_OF[entity.domain] ?? "sensors",
      status: entityStatus(entity),
      value: brightness === null ? null : Math.min(1, brightness / 255),
      size: 0.8,
      detail: {
        entiteit: entity.entity_id,
        toestand: entity.state ?? "onbekend",
        ...(reading ? { waarde: reading } : {}),
        ...(brightness !== null
          ? { helderheid: `${Math.round((brightness / 255) * 100)}%` }
          : {}),
        apparaat: entity.device ?? null,
        ruimte: entity.area ?? null,
        bijgewerkt: entity.last_updated ?? null,
      },
    });
    edges.push({ from: area, to: `entity:${entity.entity_id}` });
  }
  return {
    title: "Huis",
    nodes,
    edges,
    layers: [
      { id: "rooms", label: "Ruimtes" },
      { id: "lights", label: "Lampen" },
      { id: "climate", label: "Klimaat" },
      { id: "switches", label: "Schakelaars" },
      { id: "openings", label: "Ramen, deuren en sloten" },
      { id: "sensors", label: "Sensoren" },
      { id: "media", label: "Media" },
    ],
    heatLabel: "Helderheid van lampen die aan zijn",
    notes: [
      "Bron: Home Assistant (alleen apparaten die NOVA mag zien). Ruimtes zijn de ruimtes uit Home Assistant, getekend als groepen.",
      "Er is geen plattegrond: een 3D-plattegrond vraagt om een geïmporteerd model of eigen ruimtedefinities. Er wordt niets verzonnen.",
      "Personen en locaties van apparaten worden hier niet getoond.",
      ...(wanted.length > entities.length
        ? [
            `Alleen de eerste ${MAX_ENTITIES} van ${wanted.length} apparaten zijn getekend.`,
          ]
        : []),
    ],
    actions,
    refreshMs: 20_000,
  };
}

const TYPES: VizTypeDefinition[] = [
  {
    id: "home",
    title: "Huis",
    kind: "graph",
    description:
      "Ruimtes uit Home Assistant met hun lampen, schakelaars, klimaat, sloten en sensoren en de actuele toestand. Geen plattegrond.",
    keywords: [
      "huis",
      "home",
      "kamers",
      "ruimtes",
      "ruimte",
      "lampen",
      "lichten",
      "sensoren",
      "apparaten",
      "slimme",
      "domotica",
      "home assistant",
    ],
  },
];

@Injectable()
export class HomeVisualizationProvider
  implements VisualizationProvider, OnModuleInit
{
  readonly id = "home-assistant";
  readonly label = "Home Assistant";
  readonly types = TYPES;
  readonly requires = {
    service: "home-assistant",
    access: "read-only" as const,
  };

  constructor(
    private readonly home: HomeAssistantService,
    private readonly registry: VisualizationRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  available(): { ok: true } | { ok: false; reason: string } {
    return this.home.configured
      ? { ok: true }
      : { ok: false, reason: "Home Assistant is niet gekoppeld." };
  }

  async build(): Promise<ProviderScene> {
    await this.home.sync();
    const visible = this.home.visibleEntities();
    if (!visible.length)
      throw new Error("Home Assistant gaf geen zichtbare apparaten terug.");
    return homeGraph(visible);
  }
}
