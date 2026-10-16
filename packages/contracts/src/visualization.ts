// The holographic visualisation platform: one scene description shared by the API providers,
// the visualisation tools and the web viewer. Types only; validation lives in
// apps/api/src/visualization/scene.validation.ts.

export type VizSceneKind =
  | "graph"
  | "model"
  | "chart"
  | "weather"
  | "gauges"
  | "timeline"
  | "tiles"
  | "series";

/** Rendering styles of the viewer. A scene only offers the modes that fit its content. */
export type VizMode =
  "holographic" | "realistic" | "wireframe" | "technical" | "heatmap" | "xray";

/** "unknown" is for data the source does not have: it is never drawn as healthy. */
export type VizStatus =
  "ok" | "active" | "warning" | "critical" | "off" | "unknown";

export type VizDetailValue = string | number | boolean | null;

export interface VizNode {
  id: string;
  label: string;
  /** Free kind label, e.g. "node", "vm", "lxc", "storage", "tool". Used for legend and table. */
  kind?: string;
  /** Hierarchy: drives the layout. Nodes without parent are roots. */
  parent?: string;
  /** Layer the node belongs to (see VizScene.layers). */
  layer?: string;
  status?: VizStatus;
  /** 0..1 value for the heat map; null/undefined means "no data" (drawn grey). */
  value?: number | null;
  /** Relative size, 0.5..3 (default 1). */
  size?: number;
  /** Shown in the details panel and the table. Never put secrets here. */
  detail?: Record<string, VizDetailValue>;
  /** Only when the source really knows the place (imported model, user room definition). */
  position?: [number, number, number];
}

export interface VizEdge {
  from: string;
  to: string;
  label?: string;
  status?: VizStatus;
  /** Relative weight 0..1 for line thickness/opacity. */
  weight?: number;
}

export interface VizLayer {
  id: string;
  label: string;
  visible?: boolean;
}

export type VizModelFormat = "glb" | "gltf" | "stl" | "3mf";

export interface VizModelSource {
  id: string;
  label: string;
  format: VizModelFormat;
  /** Same-origin path ("/api/...") or a blob: URL created by the page itself. */
  url: string;
  layer?: string;
  /** Scene units per model unit are given by VizScene.units; this is an optional local scale. */
  scale?: number;
  /** Per-model colour for formats without materials (STL). #rrggbb. */
  color?: string;
}

export interface VizHotspot {
  id: string;
  label: string;
  /** Position in model space. */
  position: [number, number, number];
  objectId?: string;
  detail?: Record<string, VizDetailValue>;
}

export interface VizChartPoint {
  label: string;
  value: number | null;
  status?: VizStatus;
}

export interface VizChartSeries {
  label: string;
  points: VizChartPoint[];
}

export interface VizChart {
  /** "area" is only used by kind "series" (3D bar/area time series). */
  type: "bar" | "line" | "area";
  unit: string;
  /** Upper bound for the axis; default: the largest value. */
  max?: number;
  series: VizChartSeries[];
}

/** Simple condition glyph; the words are always given next to it. */
export type VizGlyph =
  | "clear"
  | "night"
  | "partly"
  | "night-cloud"
  | "cloud"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "storm"
  | "unknown";

export interface VizWeatherHour {
  /** "14:00". */
  label: string;
  temperature: number | null;
  /** 0..100; null = the source gave no chance. */
  rainPercent: number | null;
  condition: string;
  glyph: VizGlyph;
}

export interface VizWeatherDay {
  /** "vandaag", "morgen", "woensdag". */
  label: string;
  min: number | null;
  max: number | null;
  rainMm: number | null;
  rainPercent: number | null;
  condition: string;
  glyph: VizGlyph;
}

/** kind "weather": temperature curve, rain bars and condition glyphs. Unit is always °C, mm and %. */
export interface VizWeather {
  place: string;
  now?: {
    temperature: number | null;
    feelsLike?: number | null;
    condition: string;
    glyph: VizGlyph;
    windKmh?: number | null;
    humidityPercent?: number | null;
  };
  hours: VizWeatherHour[];
  days: VizWeatherDay[];
}

/** One ring in a gauge card. value null = unknown (drawn dashed, never healthy). */
export interface VizGauge {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  min?: number;
  max: number;
  /** Values from here on are "let op" / "probleem" (in the direction of `worse`). */
  warnAt?: number;
  critAt?: number;
  /** "high" (default): a high value is bad (CPU). "low": a low value is bad (battery). */
  worse?: "high" | "low";
  status: VizStatus;
  /** Short extra text, e.g. "6,2 van 16 GB". */
  detail?: string;
}

export interface VizTimelineItem {
  id: string;
  label: string;
  /** ISO timestamps. A timer starts at the moment it was read and ends when it fires. */
  start: string;
  end: string | null;
  kind: "event" | "timer";
  allDay?: boolean;
}

/** kind "timeline": one day (or window) on a time axis with a "now" marker. */
export interface VizTimeline {
  start: string;
  end: string;
  /** Moment of reading; the marker is only drawn when it lies inside the window. */
  now: string;
  /** IANA zone the labels are written in. */
  timeZone: string;
  items: VizTimelineItem[];
}

export interface VizTile {
  id: string;
  label: string;
  /** The state as a word or short value ("Draait", "Aan", "21,5 °C"); never only a colour. */
  state: string;
  status: VizStatus;
  group?: string;
  detail?: string;
}

export interface VizTileGroup {
  id: string;
  label: string;
  /** Short line under the group name, e.g. "CPU 14% · RAM 62%". */
  summary?: string;
}

export interface VizAnnotation {
  objectId: string;
  text: string;
}

export type VizCameraPreset =
  "iso" | "front" | "back" | "left" | "right" | "top" | "bottom";

/** View state the tools change; the viewer applies it whenever the revision changes. */
export interface VizView {
  mode?: VizMode;
  dimension?: "2d" | "3d";
  highlights: string[];
  selected?: string | null;
  annotations: VizAnnotation[];
  hiddenLayers: string[];
  camera?: {
    preset?: VizCameraPreset;
    focus?: string;
    /** Bumped for every camera command so the viewer re-applies an identical one. */
    seq: number;
  };
  rotations: { objectId: string; axis: "x" | "y" | "z"; degrees: number }[];
}

export interface VizAction {
  id: string;
  label: string;
  /** Sentence the user can send to NOVA; goes through the normal tool permissions. */
  prompt: string;
}

export interface VizScene {
  schema: 1;
  id: string;
  title: string;
  kind: VizSceneKind;
  /** Provider and type that built the scene ("proxmox", "topology"), or "custom". */
  providerId: string;
  typeId: string;
  revision: number;
  updatedAt: string;
  /** Graph data (kind "graph"). */
  nodes?: VizNode[];
  edges?: VizEdge[];
  /** Models (kind "model"). */
  models?: VizModelSource[];
  hotspots?: VizHotspot[];
  /** Chart data (kind "chart", or "series" for the 3D bar/area chart). */
  chart?: VizChart;
  /** Card data (kinds "weather", "gauges", "timeline", "tiles"). */
  weather?: VizWeather;
  gauges?: VizGauge[];
  timeline?: VizTimeline;
  tiles?: VizTile[];
  tileGroups?: VizTileGroup[];
  /** One plain sentence with what the picture shows; the accessible text alternative. */
  summary?: string;
  layers: VizLayer[];
  modes: VizMode[];
  defaultMode: VizMode;
  /** Meaning of the heat-map values, e.g. "CPU-belasting". */
  heatLabel?: string;
  /** Unit of model coordinates for measurements, e.g. "mm". */
  units?: string;
  /** Honest remarks: what is not shown or not known. */
  notes: string[];
  actions: VizAction[];
  /** Poll interval for live data; absent when the scene is static. */
  refreshMs?: number;
  view: VizView;
}

/** GET /api/visualizations/providers */
export interface VizProviderInfo {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  types: {
    id: string;
    title: string;
    kind: VizSceneKind;
    description: string;
  }[];
}

/** SSE "visualization" event of the chat stream, and the shape the poll endpoint answers. */
export interface VizEventInfo {
  id: string;
  title: string;
  kind: VizSceneKind;
  revision: number;
  /** "open" asks the UI to show the view; other values only refresh a view that is open. */
  action: "open" | "update" | "clear" | "inline";
  /**
   * action "inline": the whole (small, validated) scene, shown as a card under the answer. It is
   * built from tool results of this turn and is not stored on the server.
   */
  scene?: VizScene;
}

/** GET /api/visualizations/:id?since=N */
export type VizSceneResponse =
  | { unchanged: true; revision: number }
  | { unchanged?: false; scene: VizScene };
