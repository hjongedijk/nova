import type { VizScene } from "../types.ts";
import { emptyLayout, type CardLayout } from "./types.ts";
import { layoutGauges } from "./gauges.ts";
import { layoutSeries } from "./series.ts";
import { layoutTiles } from "./tiles.ts";
import { layoutTimeline } from "./timeline.ts";
import { layoutWeather } from "./weather.ts";

export const CARD_KINDS = ["weather", "gauges", "timeline", "tiles", "series"];
export const isCardScene = (scene: VizScene): boolean =>
  CARD_KINDS.includes(scene.kind);

/** Width the layout is made for: the real width of the card, within sane limits. */
export const clampWidth = (px: number): number =>
  Math.round(Math.min(960, Math.max(280, px || 360)));

export function layoutCard(scene: VizScene, widthPx: number): CardLayout {
  const width = clampWidth(widthPx);
  switch (scene.kind) {
    case "weather":
      return layoutWeather(scene, width);
    case "gauges":
      return layoutGauges(scene, width);
    case "timeline":
      return layoutTimeline(scene, width);
    case "tiles":
      return layoutTiles(scene, width);
    case "series":
      return layoutSeries(scene, width);
    default:
      return emptyLayout(width, 80);
  }
}
export type * from "./types.ts";
export { FONT_PX } from "./types.ts";
