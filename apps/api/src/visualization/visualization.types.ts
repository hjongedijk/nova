import type {
  VizAction,
  VizChart,
  VizEdge,
  VizHotspot,
  VizLayer,
  VizMode,
  VizModelSource,
  VizNode,
  VizScene,
  VizSceneKind,
} from "@nova/contracts";

/** One visualisation a provider can build ("topology", "load", ...). */
export interface VizTypeDefinition {
  id: string;
  title: string;
  kind: VizSceneKind;
  /** Shown to the model and in the picker; says what the data really is. */
  description: string;
  /** Words (Dutch and English) that make the request match this type; used by the intent matcher. */
  keywords: string[];
}

/** What a provider returns; the service adds ids, revision, view state and validates it. */
export interface ProviderScene {
  title: string;
  nodes?: VizNode[];
  edges?: VizEdge[];
  models?: VizModelSource[];
  hotspots?: VizHotspot[];
  chart?: VizChart;
  weather?: VizScene["weather"];
  gauges?: VizScene["gauges"];
  timeline?: VizScene["timeline"];
  tiles?: VizScene["tiles"];
  tileGroups?: VizScene["tileGroups"];
  summary?: string;
  layers?: VizLayer[];
  /** Modes override; default: derived from the content. */
  modes?: VizMode[];
  defaultMode?: VizMode;
  heatLabel?: string;
  units?: string;
  notes?: string[];
  actions?: VizAction[];
  /** Poll interval for live data, 5000..300000 ms. */
  refreshMs?: number;
}

export interface ProviderContext {
  signal: AbortSignal;
  params: Record<string, unknown>;
}

/**
 * What a source of visualisations implements. Register it with
 * `VisualizationRegistry.register(provider)` (usually in `onModuleInit`). Providers are
 * read-only: they build a scene from real data of an existing service. They never control
 * devices; `actions` are sentences the user may send to NOVA, which go through the normal
 * tool permissions and confirmations.
 */
export interface VisualizationProvider {
  /** Stable id: "proxmox", "home-assistant", "network", "ai-activity", ... */
  readonly id: string;
  readonly label: string;
  /** Visualisation types offered. */
  readonly types: VizTypeDefinition[];
  /** Security requirement, documented per provider: which existing service/permission is read. */
  readonly requires: { service: string; access: "read-only" };
  /** False while the underlying service is missing or not configured. */
  available(): { ok: true } | { ok: false; reason: string };
  /** Build a fresh scene (also used for the poll refresh of a live scene). */
  build(typeId: string, context: ProviderContext): Promise<ProviderScene>;
  /** Optional: extra facts for show_object_details beyond the node's own detail. */
  describe?(
    typeId: string,
    objectId: string,
    context: ProviderContext,
  ): Promise<Record<string, string | number | boolean | null> | null>;
}
