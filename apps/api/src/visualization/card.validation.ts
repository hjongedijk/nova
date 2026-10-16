import type { VizGlyph, VizScene, VizStatus } from "@nova/contracts";

/** Kinds drawn as a holographic card (weather, gauges, timeline, tiles, 3D series). */
export const CARD_KINDS = [
  "weather",
  "gauges",
  "timeline",
  "tiles",
  "series",
] as const;
export const isCardKind = (kind: string): boolean =>
  (CARD_KINDS as readonly string[]).includes(kind);

export const MAX_WEATHER_HOURS = 48;
export const MAX_WEATHER_DAYS = 10;
export const MAX_GAUGES = 16;
export const MAX_TIMELINE_ITEMS = 40;
export const MAX_TILES = 120;
export const MAX_TILE_GROUPS = 12;
export const MAX_SERIES_POINTS = 200;
export const MAX_SUMMARY = 400;
export const MAX_TEXT = 120;

const GLYPHS: readonly VizGlyph[] = [
  "clear",
  "night",
  "partly",
  "night-cloud",
  "cloud",
  "fog",
  "drizzle",
  "rain",
  "snow",
  "storm",
  "unknown",
];
const STATUSES: readonly VizStatus[] = [
  "ok",
  "active",
  "warning",
  "critical",
  "off",
  "unknown",
];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/#@+-]{0,119}$/;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const finiteOrNull = (value: unknown): boolean =>
  value === null || finite(value);
const text = (value: unknown, max = MAX_TEXT): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((char) => char.charCodeAt(0) < 32);
const optText = (value: unknown, max = MAX_TEXT): boolean =>
  value === undefined || text(value, max);
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));
const percent = (value: unknown): boolean =>
  value === null || (finite(value) && value >= 0 && value <= 100);

/** Structural validation of the data of the card kinds. Pushes problems, never throws. */
export function validateCardData(
  scene: VizScene,
  push: (message: string) => void,
): void {
  const kind = scene.kind;
  if (!isCardKind(kind)) return;
  if (scene.nodes?.length || scene.models?.length)
    push(`een ${kind}-scene heeft geen nodes of modellen`);
  if (scene.summary !== undefined && !text(scene.summary, MAX_SUMMARY))
    push("summary is ongeldig of te lang");

  if (kind === "weather") {
    const weather = scene.weather;
    if (!weather) return push("weather ontbreekt");
    if (!text(weather.place)) push("weather.place ontbreekt");
    if (!Array.isArray(weather.hours) || !Array.isArray(weather.days))
      return push("weather.hours en weather.days zijn lijsten");
    if (weather.hours.length > MAX_WEATHER_HOURS)
      push(`maximaal ${MAX_WEATHER_HOURS} uren`);
    if (weather.days.length > MAX_WEATHER_DAYS)
      push(`maximaal ${MAX_WEATHER_DAYS} dagen`);
    if (!weather.hours.length && !weather.days.length)
      push("weather heeft uren of dagen nodig");
    for (const hour of weather.hours.slice(0, MAX_WEATHER_HOURS)) {
      if (
        !text(hour?.label, 20) ||
        !finiteOrNull(hour.temperature) ||
        !percent(hour.rainPercent) ||
        !text(hour.condition, 60) ||
        !GLYPHS.includes(hour.glyph)
      )
        push("ongeldig weeruur");
    }
    for (const day of weather.days.slice(0, MAX_WEATHER_DAYS)) {
      if (
        !text(day?.label, 30) ||
        !finiteOrNull(day.min) ||
        !finiteOrNull(day.max) ||
        !finiteOrNull(day.rainMm) ||
        !percent(day.rainPercent) ||
        !text(day.condition, 60) ||
        !GLYPHS.includes(day.glyph)
      )
        push("ongeldige weerdag");
    }
    if (
      weather.now &&
      (!finiteOrNull(weather.now.temperature) ||
        !text(weather.now.condition, 60) ||
        !GLYPHS.includes(weather.now.glyph))
    )
      push("ongeldig huidig weer");
  }

  if (kind === "gauges") {
    const gauges = scene.gauges;
    if (!Array.isArray(gauges) || !gauges.length)
      return push("gauges heeft minstens één meter nodig");
    if (gauges.length > MAX_GAUGES) push(`maximaal ${MAX_GAUGES} meters`);
    const ids = new Set<string>();
    for (const gauge of gauges.slice(0, MAX_GAUGES)) {
      if (!gauge || typeof gauge.id !== "string" || !ID.test(gauge.id)) {
        push("meter met ongeldige id");
        continue;
      }
      if (ids.has(gauge.id)) push(`dubbele meter-id ${gauge.id}`);
      ids.add(gauge.id);
      if (!text(gauge.label)) push(`meter ${gauge.id}: label ontbreekt`);
      if (typeof gauge.unit !== "string" || gauge.unit.length > 12)
        push(`meter ${gauge.id}: eenheid is ongeldig`);
      if (!finite(gauge.max) || gauge.max <= 0)
        push(`meter ${gauge.id}: max moet positief zijn`);
      if (
        gauge.min !== undefined &&
        (!finite(gauge.min) || gauge.min >= gauge.max)
      )
        push(`meter ${gauge.id}: min moet onder max liggen`);
      if (!finiteOrNull(gauge.value))
        push(`meter ${gauge.id}: waarde ongeldig`);
      for (const key of ["warnAt", "critAt"] as const)
        if (gauge[key] !== undefined && !finite(gauge[key]))
          push(`meter ${gauge.id}: ${key} ongeldig`);
      if (!STATUSES.includes(gauge.status))
        push(`meter ${gauge.id}: onbekende status`);
      if (
        gauge.value === null &&
        (gauge.status === "ok" || gauge.status === "active")
      )
        push(`meter ${gauge.id}: een onbekende waarde is nooit in orde`);
      if (!optText(gauge.detail, 160))
        push(`meter ${gauge.id}: detail ongeldig`);
    }
  }

  if (kind === "timeline") {
    const timeline = scene.timeline;
    if (!timeline) return push("timeline ontbreekt");
    if (
      !instant(timeline.start) ||
      !instant(timeline.end) ||
      !instant(timeline.now) ||
      Date.parse(timeline.end) <= Date.parse(timeline.start)
    )
      push("timeline: begin, einde en nu moeten geldige tijden zijn");
    if (!text(timeline.timeZone, 60)) push("timeline.timeZone ontbreekt");
    if (!Array.isArray(timeline.items) || !timeline.items.length)
      return push("timeline heeft minstens één onderdeel nodig");
    if (timeline.items.length > MAX_TIMELINE_ITEMS)
      push(`maximaal ${MAX_TIMELINE_ITEMS} tijdlijn-onderdelen`);
    const ids = new Set<string>();
    for (const item of timeline.items.slice(0, MAX_TIMELINE_ITEMS)) {
      if (!item || typeof item.id !== "string" || !ID.test(item.id)) {
        push("tijdlijn-onderdeel met ongeldige id");
        continue;
      }
      if (ids.has(item.id)) push(`dubbele tijdlijn-id ${item.id}`);
      ids.add(item.id);
      if (!text(item.label, 100)) push(`onderdeel ${item.id}: label ontbreekt`);
      if (!instant(item.start) || (item.end !== null && !instant(item.end)))
        push(`onderdeel ${item.id}: ongeldige tijd`);
      else if (
        item.end !== null &&
        Date.parse(item.end) < Date.parse(item.start)
      )
        push(`onderdeel ${item.id}: einde voor begin`);
      if (item.kind !== "event" && item.kind !== "timer")
        push(`onderdeel ${item.id}: soort moet event of timer zijn`);
    }
  }

  if (kind === "tiles") {
    const tiles = scene.tiles;
    if (!Array.isArray(tiles) || !tiles.length)
      return push("tiles heeft minstens één tegel nodig");
    if (tiles.length > MAX_TILES) push(`maximaal ${MAX_TILES} tegels`);
    const groups = new Set<string>();
    if ((scene.tileGroups?.length ?? 0) > MAX_TILE_GROUPS)
      push(`maximaal ${MAX_TILE_GROUPS} groepen`);
    for (const group of (scene.tileGroups ?? []).slice(0, MAX_TILE_GROUPS)) {
      if (!group || !ID.test(group.id) || !text(group.label))
        push("ongeldige tegelgroep");
      else groups.add(group.id);
      if (group && !optText(group.summary, 160))
        push("groepsamenvatting ongeldig");
    }
    const ids = new Set<string>();
    for (const tile of tiles.slice(0, MAX_TILES)) {
      if (!tile || typeof tile.id !== "string" || !ID.test(tile.id)) {
        push("tegel met ongeldige id");
        continue;
      }
      if (ids.has(tile.id)) push(`dubbele tegel-id ${tile.id}`);
      ids.add(tile.id);
      if (!text(tile.label)) push(`tegel ${tile.id}: label ontbreekt`);
      if (!text(tile.state, 60)) push(`tegel ${tile.id}: toestand ontbreekt`);
      if (!STATUSES.includes(tile.status))
        push(`tegel ${tile.id}: onbekende status`);
      if (tile.group !== undefined && !groups.has(tile.group))
        push(`tegel ${tile.id}: onbekende groep`);
      if (!optText(tile.detail, 160)) push(`tegel ${tile.id}: detail ongeldig`);
    }
  }

  if (kind === "series") {
    const chart = scene.chart;
    if (!chart || !["bar", "area", "line"].includes(chart.type))
      return push("series: chart.type moet bar, area of line zijn");
    if (typeof chart.unit !== "string" || chart.unit.length > 12)
      push("series: eenheid is ongeldig");
    if (!Array.isArray(chart.series) || !chart.series.length)
      return push("series heeft minstens één reeks nodig");
    if (chart.series.length > 4) push("series: maximaal 4 reeksen");
    let points = 0;
    for (const series of chart.series) {
      if (!text(series?.label, 60)) push("reeks zonder label");
      for (const point of series?.points ?? []) {
        points++;
        if (!text(point?.label, 30)) push("punt zonder label");
        if (!finiteOrNull(point?.value)) push("punt: waarde is geen getal");
      }
    }
    if (points > MAX_SERIES_POINTS)
      push(`maximaal ${MAX_SERIES_POINTS} datapunten`);
    if (points < 2) push("series heeft minstens twee punten nodig");
    if (chart.max !== undefined && (!finite(chart.max) || chart.max <= 0))
      push("chart.max moet positief zijn");
  }
}
