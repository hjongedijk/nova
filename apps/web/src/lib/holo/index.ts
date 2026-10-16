// Public entry of the holographic viewer library. Components import from here; the three.js
// engine is loaded lazily by HoloViewer, so importing this file never pulls in three.
export * from "./types.ts";
export {
  availableModes,
  resolveMode,
  MODE_LABELS,
  MODE_HINTS,
} from "./modes.ts";
export { sceneTables, sceneSignature } from "./table.ts";
export { layoutGraph } from "./layout.ts";
export { distance, formatDistance } from "./measure.ts";
export { STATUS_LABELS, statusColor, heatColor, shapeOf } from "./colors.ts";
