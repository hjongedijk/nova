import { STATUS_LABELS } from "./colors.ts";
import { clockFormatter, durationText } from "./card/timeline.ts";
import type { VizDetailValue, VizScene } from "./types.ts";

export interface HoloTable {
  id: string;
  caption: string;
  columns: string[];
  rows: { id?: string; cells: string[] }[];
}

const cell = (value: unknown): string =>
  value === null || value === undefined || value === ""
    ? "–"
    : typeof value === "boolean"
      ? value
        ? "ja"
        : "nee"
      : String(value);

const detailText = (detail?: Record<string, VizDetailValue>): string =>
  detail
    ? Object.entries(detail)
        .filter(([, value]) => value !== null && value !== "")
        .map(([key, value]) => `${key.replace(/_/g, " ")}: ${cell(value)}`)
        .join("; ")
    : "–";

/**
 * The accessible, non-3D view of a scene: everything the picture shows, as plain tables that a
 * screen reader can walk through. Unknown stays "Onbekend".
 */
export function sceneTables(scene: VizScene): HoloTable[] {
  const tables: HoloTable[] = [];
  if (scene.kind === "graph") {
    const label = new Map((scene.nodes ?? []).map((n) => [n.id, n.label]));
    tables.push({
      id: "nodes",
      caption: `${scene.title}: onderdelen`,
      columns: ["Naam", "Soort", "Status", "Waarde", "Hoort bij", "Details"],
      rows: (scene.nodes ?? []).map((node) => ({
        id: node.id,
        cells: [
          node.label,
          cell(node.kind),
          STATUS_LABELS[node.status ?? "unknown"],
          typeof node.value === "number"
            ? `${Math.round(node.value * 100)}%`
            : "onbekend",
          node.parent ? (label.get(node.parent) ?? node.parent) : "–",
          detailText(node.detail),
        ],
      })),
    });
    if (scene.edges?.length)
      tables.push({
        id: "edges",
        caption: `${scene.title}: verbindingen`,
        columns: ["Van", "Naar", "Soort"],
        rows: scene.edges.map((edge) => ({
          cells: [
            label.get(edge.from) ?? edge.from,
            label.get(edge.to) ?? edge.to,
            cell(edge.label),
          ],
        })),
      });
  } else if (scene.kind === "weather" && scene.weather) {
    const { hours, days } = scene.weather;
    const chance = (value: number | null) =>
      value === null ? "onbekend" : `${value}%`;
    const degrees = (value: number | null) =>
      value === null ? "onbekend" : `${Math.round(value)}°`;
    if (hours.length)
      tables.push({
        id: "hours",
        caption: `${scene.title}: per uur`,
        columns: ["Tijd", "Temperatuur", "Kans op regen", "Weer"],
        rows: hours.map((hour) => ({
          cells: [
            hour.label,
            degrees(hour.temperature),
            chance(hour.rainPercent),
            hour.condition,
          ],
        })),
      });
    if (days.length)
      tables.push({
        id: "days",
        caption: `${scene.title}: per dag`,
        columns: ["Dag", "Laagste", "Hoogste", "Regen", "Kans", "Weer"],
        rows: days.map((day) => ({
          cells: [
            day.label,
            degrees(day.min),
            degrees(day.max),
            day.rainMm === null ? "onbekend" : `${day.rainMm} mm`,
            chance(day.rainPercent),
            day.condition,
          ],
        })),
      });
  } else if (scene.kind === "gauges") {
    tables.push({
      id: "gauges",
      caption: scene.title,
      columns: ["Meter", "Waarde", "Status", "Details"],
      rows: (scene.gauges ?? []).map((gauge) => ({
        id: gauge.id,
        cells: [
          gauge.label,
          gauge.value === null
            ? "onbekend"
            : `${gauge.value} ${gauge.unit} van ${gauge.max} ${gauge.unit}`,
          STATUS_LABELS[gauge.status],
          cell(gauge.detail),
        ],
      })),
    });
  } else if (scene.kind === "timeline" && scene.timeline) {
    const clock = clockFormatter(scene.timeline.timeZone);
    const now = Date.parse(scene.timeline.now);
    tables.push({
      id: "timeline",
      caption: scene.title,
      columns: ["Soort", "Titel", "Begin", "Einde", "Nog"],
      rows: scene.timeline.items.map((item) => ({
        cells: [
          item.kind === "timer"
            ? "Timer"
            : item.allDay
              ? "Hele dag"
              : "Afspraak",
          item.label,
          item.allDay ? "–" : clock(Date.parse(item.start)),
          item.end && !item.allDay ? clock(Date.parse(item.end)) : "–",
          item.kind === "timer" && item.end
            ? durationText(Math.max(0, Date.parse(item.end) - now))
            : "–",
        ],
      })),
    });
  } else if (scene.kind === "tiles") {
    const groups = new Map(
      (scene.tileGroups ?? []).map((g) => [g.id, g.label]),
    );
    tables.push({
      id: "tiles",
      caption: scene.title,
      columns: ["Groep", "Naam", "Toestand", "Status", "Details"],
      rows: (scene.tiles ?? []).map((tile) => ({
        id: tile.id,
        cells: [
          tile.group ? (groups.get(tile.group) ?? tile.group) : "–",
          tile.label,
          tile.state,
          STATUS_LABELS[tile.status],
          cell(tile.detail),
        ],
      })),
    });
  } else if (
    (scene.kind === "chart" || scene.kind === "series") &&
    scene.chart
  ) {
    tables.push({
      id: "chart",
      caption: `${scene.title} (${scene.chart.unit})`,
      columns: ["Reeks", "Label", "Waarde", "Status"],
      rows: scene.chart.series.flatMap((series) =>
        series.points.map((point) => ({
          cells: [
            series.label,
            point.label,
            point.value === null
              ? "onbekend"
              : `${point.value} ${scene.chart!.unit}`,
            STATUS_LABELS[point.status ?? "unknown"],
          ],
        })),
      ),
    });
  } else {
    tables.push({
      id: "models",
      caption: `${scene.title}: modellen`,
      columns: ["Naam", "Formaat", "Laag"],
      rows: (scene.models ?? []).map((model) => ({
        id: model.id,
        cells: [model.label, model.format.toUpperCase(), cell(model.layer)],
      })),
    });
    if (scene.hotspots?.length)
      tables.push({
        id: "hotspots",
        caption: `${scene.title}: hotspots`,
        columns: ["Naam", "Positie", "Details"],
        rows: scene.hotspots.map((spot) => ({
          id: spot.id,
          cells: [
            spot.label,
            spot.position.map((n) => Math.round(n * 100) / 100).join(", "),
            detailText(spot.detail),
          ],
        })),
      });
  }
  return tables;
}

/** Signature of what a scene draws; the view state (highlights, camera) is not part of it. */
export function sceneSignature(scene: VizScene): string {
  return JSON.stringify([
    scene.id,
    scene.nodes,
    scene.edges,
    scene.models,
    scene.hotspots,
    scene.chart,
    scene.weather,
    scene.gauges,
    scene.timeline,
    scene.tiles,
    scene.tileGroups,
    scene.layers.map((layer) => layer.id),
  ]);
}
