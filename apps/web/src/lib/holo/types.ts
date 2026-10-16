// Public types of the holographic viewer. The scene description itself lives in
// @nova/contracts (visualization.ts) so the API providers and the viewer share it.
export type {
  VizAction,
  VizAnnotation,
  VizCameraPreset,
  VizChart,
  VizDetailValue,
  VizEdge,
  VizEventInfo,
  VizHotspot,
  VizLayer,
  VizMode,
  VizModelSource,
  VizNode,
  VizProviderInfo,
  VizScene,
  VizSceneKind,
  VizSceneResponse,
  VizStatus,
  VizView,
} from "@nova/contracts";

export type HoloTheme = "dark" | "light" | "auto";
export type HoloQuality = "auto" | "high" | "medium" | "low";
export type HoloDimension = "2d" | "3d";

export interface HoloSelectionInfo {
  id: string;
  label: string;
  /** "node" for graph nodes, "part" for a mesh inside a model, "hotspot", "model". */
  kind: "node" | "part" | "hotspot" | "model";
  /** Size of the object's bounding box in model units (parts and models). */
  size?: [number, number, number];
  triangles?: number;
}

export interface HoloMeasurement {
  id: string;
  from: [number, number, number];
  to: [number, number, number];
  distance: number;
  units: string;
}

export interface HoloPart {
  id: string;
  label: string;
  visible: boolean;
}

export type HoloLoadState =
  | { state: "loading"; progress: number | null; label: string }
  | { state: "ready" }
  | { state: "error"; message: string };
