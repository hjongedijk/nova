import crypto from "node:crypto";
import type {
  VizGauge,
  VizScene,
  VizTile,
  VizTileGroup,
  VizTimelineItem,
} from "@nova/contracts";
import {
  calendarDateKey,
  wallTimeAsInstant,
} from "../planning/calendar-day.js";
import {
  clean,
  finiteOrNull,
  gaugesScene,
  loadGauge,
  nl,
  percentGauge,
  tilesScene,
  weatherScene,
} from "./card-builders.js";
import { validateScene } from "./scene.validation.js";
import type { ProviderScene } from "./visualization.types.js";

/*
 * Inline holographic cards: a deterministic map from a tool name and the RESULT that really
 * arrived to a small card scene. Nothing here reads model text, nothing is invented, and a failed
 * or empty result gives no card. The orchestrator emits at most one per turn.
 */

export const MAX_INLINE_BYTES = 24_000;

export interface InlineCardContext {
  now?: Date;
  timeZone?: string;
  /** Test hook: fixed scene id. */
  id?: string;
}

/** What the orchestrator knows about a finished tool call. */
export interface InlineToolResult {
  ok?: boolean;
  result?: unknown;
  requiresConfirmation?: boolean;
  ambiguous?: boolean;
  executed?: boolean;
  error?: string;
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number | null => finiteOrNull(value);
const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

const GB = 1_073_741_824;
const round1 = (value: number) => Math.round(value * 10) / 10;

// ---------- Proxmox ----------

function proxmoxNodes(payload: unknown): ProviderScene | null {
  const nodes = list(obj(payload)?.nodes).flatMap((entry) => {
    const node = obj(entry);
    return node && str(node.node) ? [node] : [];
  });
  if (!nodes.length) return null;
  const gauges: VizGauge[] = [];
  for (const node of nodes.slice(0, 4)) {
    const name = clean(node.node, 30);
    const online = node.status === "online";
    const cpu = obj(node.cpu);
    const memory = obj(node.memory);
    gauges.push(
      loadGauge({
        id: `cpu:${name}`,
        label: `${name} CPU`,
        value: online ? num(cpu?.usagePercent) : null,
        detail: online
          ? `${num(cpu?.cores) ?? "?"} kernen`
          : "Node is niet online",
      }),
    );
    const used = num(memory?.usedGB);
    const total = num(memory?.totalGB);
    gauges.push(
      loadGauge({
        id: `mem:${name}`,
        label: `${name} geheugen`,
        value: online ? num(memory?.usagePercent) : null,
        detail:
          online && used !== null && total !== null
            ? `${nl(used)} van ${nl(total)} GB`
            : "Node is niet online",
      }),
    );
  }
  if (gauges.every((gauge) => gauge.value === null)) return null;
  return gaugesScene("Proxmox-nodes", gauges, {
    notes: ["Bron: de Proxmox-API (alleen nodes die NOVA mag zien)."],
  });
}

const GUEST_STATE: Record<string, [string, VizTile["status"]]> = {
  running: ["Draait", "ok"],
  stopped: ["Gestopt", "off"],
  paused: ["Gepauzeerd", "warning"],
  suspended: ["Gepauzeerd", "warning"],
};

function proxmoxGuests(payload: unknown): ProviderScene | null {
  const guests = list(obj(payload)?.guests).flatMap((entry) => {
    const guest = obj(entry);
    return guest && num(guest.vmid) !== null ? [guest] : [];
  });
  if (guests.length < 2) return null;
  const groups = new Map<
    string,
    { label: string; running: number; total: number }
  >();
  const tiles: VizTile[] = [];
  for (const guest of guests.slice(0, 120)) {
    const node = clean(guest.node || "onbekend", 30);
    const key = `node:${node}`;
    const group = groups.get(key) ?? { label: node, running: 0, total: 0 };
    group.total++;
    const [word, status] = GUEST_STATE[str(guest.status)] ?? [
      "Onbekend",
      "unknown" as const,
    ];
    if (guest.status === "running") group.running++;
    groups.set(key, group);
    const cpu = num(guest.cpuUsagePercent);
    const memUsed = num(guest.memoryUsed);
    const memTotal = num(guest.memoryTotal);
    const running = guest.status === "running";
    tiles.push({
      id: `guest:${num(guest.vmid)}`,
      label: clean(
        guest.name ||
          `${guest.type === "lxc" ? "CT" : "VM"} ${num(guest.vmid)}`,
        40,
      ),
      state: word,
      status,
      group: key,
      detail: running
        ? [
            cpu !== null ? `CPU ${nl(cpu)}%` : "",
            memUsed !== null && memTotal
              ? `RAM ${Math.round((memUsed / memTotal) * 100)}%`
              : "",
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        : undefined,
    });
  }
  const tileGroups: VizTileGroup[] = [...groups.entries()]
    .slice(0, 12)
    .map(([id, group]) => ({
      id,
      label: group.label,
      summary: `${group.running} van ${group.total} draaien`,
    }));
  return tilesScene("Proxmox: VM's en containers", tiles, tileGroups, {
    notes: ["Bron: de Proxmox-API (alleen gasten die NOVA mag zien)."],
  });
}

function proxmoxStorage(payload: unknown): ProviderScene | null {
  const gauges: VizGauge[] = [];
  for (const entry of list(obj(payload)?.storage).slice(0, 8)) {
    const item = obj(entry);
    const name = clean(item?.storage, 30);
    if (!item || !name) continue;
    const disk = num(item.disk);
    const max = num(item.maxdisk);
    const known =
      item.status !== "unavailable" && disk !== null && max !== null && max > 0;
    const node = clean(item.node, 20);
    gauges.push(
      percentGauge({
        id: `disk:${node}/${name}`,
        label: node ? `${name} (${node})` : name,
        value: known ? (disk! / max!) * 100 : null,
        warnAt: 80,
        critAt: 90,
        detail: known
          ? `${nl(round1(disk! / GB))} van ${nl(round1(max! / GB))} GB`
          : item.status === "unavailable"
            ? "Opslag niet beschikbaar"
            : "Grootte onbekend",
      }),
    );
  }
  if (!gauges.length || gauges.every((gauge) => gauge.value === null))
    return null;
  return gaugesScene("Proxmox-opslag", gauges, {
    notes: [
      "Bron: de Proxmox-API. Gebruikte ruimte; 80% is let op, 90% een probleem.",
    ],
  });
}

function proxmoxGuest(payload: unknown): ProviderScene | null {
  const guest = obj(payload);
  if (!guest || guest.status !== "running") return null;
  const name = clean(guest.name || `${num(guest.vmid)}`, 30);
  const cpu = num(guest.cpuUsagePercent);
  const used = num(guest.memoryUsed);
  const total = num(guest.memoryTotal);
  if (cpu === null && (used === null || !total)) return null;
  return gaugesScene(`${name}: belasting`, [
    loadGauge({ id: "cpu", label: "CPU", value: cpu }),
    loadGauge({
      id: "mem",
      label: "Geheugen",
      value: used !== null && total ? (used / total) * 100 : null,
      detail:
        used !== null && total
          ? `${nl(round1(used / GB))} van ${nl(round1(total / GB))} GB`
          : undefined,
    }),
  ]);
}

// ---------- network ----------

function networkChecks(payload: unknown): ProviderScene | null {
  const results = list(obj(payload)?.results).flatMap((entry) => {
    const item = obj(entry);
    return item && str(item.name) ? [item] : [];
  });
  if (results.length < 2) return null;
  const tiles: VizTile[] = results.slice(0, 30).map((item, index) => {
    const up = item.ok === true;
    const ms = num(item.ms);
    return {
      id: `check:${index}`,
      label: clean(item.name, 40),
      state: up ? "Bereikbaar" : "Niet bereikbaar",
      status: up ? (ms !== null && ms >= 1000 ? "warning" : "ok") : "critical",
      ...(up && ms !== null ? { detail: `${Math.round(ms)} ms` } : {}),
    };
  });
  return tilesScene("NOVA-diensten", tiles, undefined, {
    notes: [
      "Bron: de bereikbaarheidscontroles van NOVA; vanaf 1000 ms is het traag.",
    ],
  });
}

// ---------- Home Assistant ----------

const HIDDEN_DOMAINS = new Set([
  "person",
  "device_tracker",
  "camera",
  "alarm_control_panel",
]);
const STATE_WORDS: Record<string, [string, VizTile["status"]]> = {
  on: ["Aan", "active"],
  off: ["Uit", "off"],
  open: ["Open", "active"],
  opening: ["Gaat open", "active"],
  closed: ["Dicht", "off"],
  closing: ["Gaat dicht", "active"],
  locked: ["Op slot", "ok"],
  unlocked: ["Niet op slot", "warning"],
  playing: ["Speelt", "active"],
  paused: ["Gepauzeerd", "off"],
  idle: ["Inactief", "off"],
  standby: ["Standby", "off"],
  home: ["Thuis", "ok"],
  not_home: ["Weg", "off"],
  heat: ["Verwarmt", "active"],
  cool: ["Koelt", "active"],
  unavailable: ["Niet beschikbaar", "unknown"],
  unknown: ["Onbekend", "unknown"],
};

function entityTile(entity: Obj): { tile: VizTile; area: string } | null {
  const id = str(entity.entity_id);
  const domain = str(entity.domain) || id.split(".")[0] || "";
  if (!/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/i.test(id) || HIDDEN_DOMAINS.has(domain))
    return null;
  const attributes = obj(entity.attributes) ?? {};
  const state = str(entity.state);
  const unit = clean(attributes.unit_of_measurement, 10);
  const numeric =
    state !== "" && Number.isFinite(Number(state)) ? Number(state) : null;
  let word: string;
  let status: VizTile["status"];
  if (numeric !== null && domain === "sensor") {
    word = `${nl(numeric)}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;
    status = "ok";
    if (attributes.device_class === "battery")
      status = numeric <= 5 ? "critical" : numeric <= 15 ? "warning" : "ok";
    else if (
      attributes.device_class === "power" ||
      attributes.device_class === "energy"
    )
      status = "active";
  } else {
    const known = STATE_WORDS[state];
    word = known ? known[0] : clean(state, 30) || "Onbekend";
    status = known ? known[1] : state ? "ok" : "unknown";
  }
  return {
    tile: {
      id,
      label: clean(entity.friendly_name || id, 40),
      state: word,
      status,
    },
    area: clean(entity.area, 30),
  };
}

function homeEntities(payload: unknown): ProviderScene | null {
  const entries = list(payload).flatMap((entry) => {
    const entity = obj(entry);
    const mapped = entity ? entityTile(entity) : null;
    return mapped ? [mapped] : [];
  });
  if (entries.length < 2) return null;
  const groups = new Map<string, VizTileGroup>();
  const tiles: VizTile[] = [];
  for (const { tile, area } of entries.slice(0, 60)) {
    const label = area || "Overig";
    const key = `area:${
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40) || "overig"
    }`;
    if (!groups.has(key)) {
      if (groups.size >= 12) {
        if (!groups.has("area:overig"))
          groups.set("area:overig", { id: "area:overig", label: "Overig" });
        tiles.push({ ...tile, group: "area:overig" });
        continue;
      }
      groups.set(key, { id: key, label });
    }
    tiles.push({ ...tile, group: key });
  }
  return tilesScene("Apparaten in huis", tiles, [...groups.values()], {
    notes: ["Bron: Home Assistant (alleen apparaten die NOVA mag zien)."],
  });
}

function homeStatus(payload: unknown): ProviderScene | null {
  const home = obj(payload);
  if (!home) return null;
  const tiles: VizTile[] = [];
  const groups: VizTileGroup[] = [];
  const group = (id: string, label: string) => {
    if (!groups.some((item) => item.id === id)) groups.push({ id, label });
    return id;
  };
  for (const [index, entry] of list(home.people).slice(0, 8).entries()) {
    const person = obj(entry);
    if (!person) continue;
    const state = str(person.state);
    tiles.push({
      id: `person:${index}`,
      label: clean(person.name, 30),
      state: state === "thuis" ? "Thuis" : state === "weg" ? "Weg" : "Onbekend",
      status: state === "thuis" ? "ok" : state === "weg" ? "off" : "unknown",
      group: group("people", "Wie is thuis"),
    });
  }
  const lights = obj(home.lights);
  if (lights && num(lights.total) !== null) {
    const on = list(lights.on).length;
    tiles.push({
      id: "lights",
      label: "Lampen",
      state: `${on} van ${num(lights.total)} aan`,
      status: on ? "active" : "off",
      group: group("devices", "Licht en schakelaars"),
    });
  }
  const switches = obj(home.switches);
  if (switches && num(switches.total) !== null)
    tiles.push({
      id: "switches",
      label: "Schakelaars",
      state: `${num(switches.on) ?? 0} van ${num(switches.total)} aan`,
      status: (num(switches.on) ?? 0) ? "active" : "off",
      group: group("devices", "Licht en schakelaars"),
    });
  for (const [index, entry] of list(home.climate).slice(0, 6).entries()) {
    const item = obj(entry);
    const current = num(item?.current);
    const target = num(item?.target);
    if (!item) continue;
    tiles.push({
      id: `climate:${index}`,
      label: clean(item.name, 30),
      state: current !== null ? `${nl(current)} °C` : "Onbekend",
      status: current !== null ? "ok" : "unknown",
      ...(target !== null ? { detail: `doel ${nl(target)} °C` } : {}),
      group: group("climate", "Klimaat"),
    });
  }
  for (const [index, entry] of list(home.temperatures).slice(0, 6).entries()) {
    const item = obj(entry);
    const value = num(item?.value);
    if (!item) continue;
    tiles.push({
      id: `temp:${index}`,
      label: clean(item.name, 30),
      state:
        value !== null
          ? `${nl(value)} ${clean(item.unit, 6) || "°C"}`
          : "Onbekend",
      status: value !== null ? "ok" : "unknown",
      group: group("climate", "Klimaat"),
    });
  }
  for (const [index, name] of list(home.playing).slice(0, 4).entries())
    tiles.push({
      id: `playing:${index}`,
      label: clean(name, 30),
      state: "Speelt",
      status: "active",
      group: group("media", "Muziek en beeld"),
    });
  if (tiles.length < 2) return null;
  return tilesScene("Huis nu", tiles, groups, {
    notes: ["Bron: Home Assistant. Wat er niet is gekoppeld staat hier niet."],
  });
}

function homeState(payload: unknown): ProviderScene | null {
  const entity = obj(payload);
  const attributes = obj(entity?.attributes);
  const value = Number(entity?.state);
  if (!entity || !attributes || !Number.isFinite(value)) return null;
  if (str(entity.domain || str(entity.entity_id).split(".")[0]) !== "sensor")
    return null;
  const unit = str(attributes.unit_of_measurement);
  if (unit !== "%" || value < 0 || value > 100) return null;
  const battery = attributes.device_class === "battery";
  return gaugesScene(clean(entity.friendly_name, 40) || "Sensor", [
    percentGauge({
      id: "value",
      label: clean(entity.friendly_name, 40) || "Waarde",
      value,
      ...(battery ? { warnAt: 15, critAt: 5, worse: "low" as const } : {}),
    }),
  ]);
}

// ---------- planning ----------

const addDay = (key: string, days: number): string => {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days))
    .toISOString()
    .slice(0, 10);
};

function instantOf(
  value: string,
  eventZone: string | null,
  zone: string,
  allDay: boolean,
): Date | null {
  if (allDay || !value.includes("T"))
    return wallTimeAsInstant(`${value.slice(0, 10)}T00:00:00`, zone);
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return wallTimeAsInstant(
    value.length === 16 ? `${value}:00` : value.slice(0, 19),
    eventZone || zone,
  );
}

function calendarTimeline(
  payload: unknown,
  now: Date,
  zone: string,
): ProviderScene | null {
  const events = list(obj(payload)?.events).flatMap((entry) => {
    const event = obj(entry);
    if (!event || !str(event.start)) return [];
    const allDay = event.allDay === true;
    const eventZone = str(event.timeZone) || null;
    const start = instantOf(str(event.start), eventZone, zone, allDay);
    if (!start) return [];
    let end: Date | null = str(event.end)
      ? instantOf(str(event.end), eventZone, zone, allDay)
      : null;
    if (end && end.getTime() < start.getTime()) end = null;
    return [
      { summary: clean(event.summary, 80) || "Afspraak", start, end, allDay },
    ];
  });
  if (!events.length) return null;
  events.sort((a, b) => a.start.getTime() - b.start.getTime());
  const today = calendarDateKey(now, zone);
  for (let offset = 0; offset < 8; offset++) {
    const key = addDay(today, offset);
    const dayStart = wallTimeAsInstant(`${key}T00:00:00`, zone);
    const dayEnd = wallTimeAsInstant(`${addDay(key, 1)}T00:00:00`, zone);
    if (!dayStart || !dayEnd) continue;
    const onDay = events.filter((event) => {
      const stop = event.end ?? event.start;
      return (
        event.start < dayEnd && (stop > dayStart || event.start >= dayStart)
      );
    });
    if (!onDay.length) continue;
    const items: VizTimelineItem[] = onDay.slice(0, 40).map((event, index) => ({
      id: `event:${index}`,
      label: event.summary,
      start: (event.start < dayStart ? dayStart : event.start).toISOString(),
      end: event.end
        ? (event.end > dayEnd ? dayEnd : event.end).toISOString()
        : null,
      kind: "event",
      ...(event.allDay ? { allDay: true } : {}),
    }));
    const upcoming = onDay.find((event) => !event.allDay && event.start >= now);
    const clock = (date: Date) =>
      new Intl.DateTimeFormat("nl-NL", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
    const dayName =
      offset === 0
        ? "vandaag"
        : new Intl.DateTimeFormat("nl-NL", {
            timeZone: zone,
            weekday: "long",
            day: "numeric",
            month: "long",
          }).format(dayStart);
    return {
      title: `Agenda ${dayName}`,
      timeline: {
        start: dayStart.toISOString(),
        end: dayEnd.toISOString(),
        now: now.toISOString(),
        timeZone: zone,
        items,
      },
      summary: clean(
        `Agenda ${dayName}: ${onDay.length} ${onDay.length === 1 ? "afspraak" : "afspraken"}${upcoming ? `, eerstvolgende om ${clock(upcoming.start)}: ${upcoming.summary}` : ""}.`,
        400,
      ),
      notes: offset
        ? [
            "Vandaag staat er niets in de agenda; dit is de eerstvolgende dag met afspraken.",
          ]
        : [],
    };
  }
  return null;
}

function timerTimeline(
  payload: unknown,
  now: Date,
  zone: string,
): ProviderScene | null {
  const timers = list(obj(payload)?.timers).flatMap((entry) => {
    const timer = obj(entry);
    const fire = new Date(str(timer?.fireAt));
    return timer && Number.isFinite(fire.getTime())
      ? [{ id: str(timer.id), label: clean(timer.label, 60) || "Timer", fire }]
      : [];
  });
  if (!timers.length) return null;
  timers.sort((a, b) => a.fire.getTime() - b.fire.getTime());
  const last = timers[timers.length - 1]!.fire.getTime();
  const end = new Date(Math.max(last, now.getTime() + 60_000));
  const left = (fire: Date) => {
    const seconds = Math.max(
      0,
      Math.round((fire.getTime() - now.getTime()) / 1000),
    );
    return seconds >= 3600
      ? `${Math.floor(seconds / 3600)} u ${Math.round((seconds % 3600) / 60)} min`
      : seconds >= 60
        ? `${Math.round(seconds / 60)} min`
        : `${seconds} s`;
  };
  return {
    title: timers.length === 1 ? "Timer" : "Timers",
    timeline: {
      start: now.toISOString(),
      end: end.toISOString(),
      now: now.toISOString(),
      timeZone: zone,
      items: timers.slice(0, 20).map((timer, index) => ({
        id: `timer:${index}`,
        label: timer.label,
        start: now.toISOString(),
        end: timer.fire.toISOString(),
        kind: "timer" as const,
      })),
    },
    summary: clean(
      `${timers.length} ${timers.length === 1 ? "timer" : "timers"}: ${timers
        .slice(0, 5)
        .map((timer) => `${timer.label} nog ${left(timer.fire)}`)
        .join(", ")}.`,
      400,
    ),
    notes: [],
  };
}

function lists(payload: unknown): ProviderScene | null {
  const entries = list(obj(payload)?.lists).flatMap((entry) => {
    const item = obj(entry);
    const name = clean(item?.list || item?.name, 40);
    return item && name ? [{ name, count: list(item.items).length }] : [];
  });
  if (entries.length < 2) return null;
  const tiles: VizTile[] = entries.slice(0, 20).map((entry, index) => ({
    id: `list:${index}`,
    label: entry.name,
    state: entry.count
      ? `${entry.count} ${entry.count === 1 ? "item" : "items"}`
      : "Leeg",
    status: entry.count ? "active" : "off",
  }));
  return tilesScene("Je lijsten", tiles, undefined);
}

// ---------- registry ----------

const WEATHER = (payload: unknown) => weatherScene(obj(payload) ?? {});

/** Tool name to card builder. Anything not listed never gets a card. */
const MAPPERS: Record<
  string,
  (payload: unknown, now: Date, zone: string) => ProviderScene | null
> = {
  weather_forecast: WEATHER,
  proxmox_status: proxmoxNodes,
  proxmox_nodes: proxmoxNodes,
  proxmox_guests: proxmoxGuests,
  proxmox_storage: proxmoxStorage,
  proxmox_guest_status: proxmoxGuest,
  network_check: networkChecks,
  home_status: homeStatus,
  ha_search_entities: homeEntities,
  ha_get_state: homeState,
  calendar_events: (payload, now, zone) => calendarTimeline(payload, now, zone),
  timer_list: (payload, now, zone) => timerTimeline(payload, now, zone),
  list_show: lists,
};

export const INLINE_CARD_TOOLS: readonly string[] = Object.keys(MAPPERS);

const kindOf = (built: ProviderScene): VizScene["kind"] | null =>
  built.weather
    ? "weather"
    : built.gauges
      ? "gauges"
      : built.timeline
        ? "timeline"
        : built.tiles
          ? "tiles"
          : built.chart
            ? "series"
            : null;

/**
 * The card for one finished tool call, or null: unknown tool, failed or unconfirmed call, no data
 * in the result, an invalid scene or one above the payload cap.
 */
export function inlineCardFor(
  tool: string,
  result: InlineToolResult,
  context: InlineCardContext = {},
): VizScene | null {
  const mapper = MAPPERS[tool];
  if (!mapper) return null;
  if (
    result.ok !== true ||
    result.requiresConfirmation === true ||
    result.ambiguous === true ||
    result.executed === false ||
    result.result === undefined ||
    result.result === null
  )
    return null;
  const now = context.now ?? new Date();
  const zone = context.timeZone || "Europe/Amsterdam";
  let built: ProviderScene | null;
  try {
    built = mapper(result.result, now, zone);
  } catch {
    return null;
  }
  const kind = built ? kindOf(built) : null;
  if (!built || !kind) return null;
  const scene: VizScene = {
    schema: 1,
    id: context.id ?? `inline-${crypto.randomBytes(5).toString("hex")}`,
    title: built.title,
    kind,
    providerId: "inline",
    typeId: tool,
    revision: 1,
    updatedAt: now.toISOString(),
    ...(built.weather ? { weather: built.weather } : {}),
    ...(built.gauges ? { gauges: built.gauges } : {}),
    ...(built.timeline ? { timeline: built.timeline } : {}),
    ...(built.tiles ? { tiles: built.tiles } : {}),
    ...(built.tileGroups ? { tileGroups: built.tileGroups } : {}),
    ...(built.chart ? { chart: built.chart } : {}),
    ...(built.summary ? { summary: built.summary } : {}),
    layers: [],
    modes: ["holographic"],
    defaultMode: "holographic",
    notes: built.notes ?? [],
    actions: [],
    view: { highlights: [], annotations: [], hiddenLayers: [], rotations: [] },
  };
  if (!validateScene(scene).ok) return null;
  if (Buffer.byteLength(JSON.stringify(scene)) > MAX_INLINE_BYTES) return null;
  return scene;
}
