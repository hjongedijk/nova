import { STATUS_LABELS } from "./colors.ts";
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
  } else if (scene.kind === "chart" && scene.chart) {
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
    scene.layers.map((layer) => layer.id),
  ]);
}
