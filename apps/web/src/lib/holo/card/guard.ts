import type { VizScene } from "../types.ts";
import { CARD_KINDS } from "./index.ts";

const obj = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const arr = (value: unknown, max: number): value is unknown[] =>
  Array.isArray(value) && value.length <= max;
const date = (value: unknown): boolean =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

/** Largest scene the chat accepts as an inline card (the server caps at 24 KB too). */
export const MAX_INLINE_CHARS = 60_000;

/**
 * A scene that arrived over the chat stream is data from the network: before it is laid out it
 * must have the right shape. Returns the scene, or null when anything is off (no card, no crash).
 */
export function parseInlineScene(value: unknown): VizScene | null {
  if (!obj(value) || value.schema !== 1) return null;
  if (typeof value.id !== "string" || typeof value.title !== "string")
    return null;
  const kind = value.kind;
  if (typeof kind !== "string" || !CARD_KINDS.includes(kind)) return null;
  try {
    if (JSON.stringify(value).length > MAX_INLINE_CHARS) return null;
  } catch {
    return null;
  }
  if (!obj(value.view) || !Array.isArray(value.notes)) return null;
  switch (kind) {
    case "weather": {
      const w = value.weather;
      if (!obj(w) || !arr(w.hours, 48) || !arr(w.days, 10)) return null;
      break;
    }
    case "gauges": {
      const g = value.gauges;
      if (!arr(g, 16) || !g.length) return null;
      if (
        !g.every(
          (x) =>
            obj(x) &&
            typeof x.max === "number" &&
            x.max > 0 &&
            typeof x.id === "string" &&
            typeof x.status === "string",
        )
      )
        return null;
      break;
    }
    case "timeline": {
      const t = value.timeline;
      if (
        !obj(t) ||
        !arr(t.items, 40) ||
        !date(t.start) ||
        !date(t.end) ||
        !date(t.now)
      )
        return null;
      if (
        !t.items.every(
          (x) => obj(x) && date(x.start) && typeof x.id === "string",
        )
      )
        return null;
      break;
    }
    case "tiles": {
      const tiles = value.tiles;
      if (!arr(tiles, 120) || !tiles.length) return null;
      if (
        !tiles.every(
          (x) =>
            obj(x) && typeof x.id === "string" && typeof x.status === "string",
        )
      )
        return null;
      break;
    }
    case "series": {
      const chart = value.chart;
      if (!obj(chart) || !Array.isArray(chart.series)) return null;
      break;
    }
  }
  return value as unknown as VizScene;
}
