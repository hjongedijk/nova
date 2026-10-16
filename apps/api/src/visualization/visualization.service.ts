import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import type {
  VizCameraPreset,
  VizDetailValue,
  VizEventInfo,
  VizMode,
  VizScene,
  VizSceneKind,
  VizView,
} from "@nova/contracts";
import { VisualizationRegistry } from "./visualization.registry.js";
import type { ProviderScene } from "./visualization.types.js";
import {
  MAX_ANNOTATIONS,
  hasControlCharacter,
  modesFor,
  validateScene,
  VIZ_MODES,
} from "./scene.validation.js";

export class VisualizationError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

const MAX_SCENES = 30;
const TTL_MS = 6 * 3_600_000;
const MIN_REFRESH_MS = 5_000;
const MAX_REFRESH_MS = 300_000;
const validObjectId = (id: string): boolean =>
  id.length >= 1 && id.length <= 120 && !hasControlCharacter(id);
export const CAMERA_PRESETS: readonly VizCameraPreset[] = [
  "iso",
  "front",
  "back",
  "left",
  "right",
  "top",
  "bottom",
];

interface Stored {
  scene: VizScene;
  params: Record<string, unknown>;
  touchedAt: number;
  builtAt: number;
  hash: string;
  rebuilding?: Promise<void>;
}

export interface CustomSceneInput {
  title: string;
  kind: VizSceneKind;
  nodes?: VizScene["nodes"];
  edges?: VizScene["edges"];
  models?: VizScene["models"];
  hotspots?: VizScene["hotspots"];
  chart?: VizScene["chart"];
  layers?: VizScene["layers"];
  notes?: string[];
  units?: string;
  heatLabel?: string;
  mode?: VizMode;
}

const hashOf = (scene: ProviderScene | VizScene): string =>
  crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        scene.title,
        scene.nodes,
        scene.edges,
        scene.models,
        scene.hotspots,
        scene.chart,
        scene.layers,
        scene.notes,
      ]),
    )
    .digest("hex");

const csvCell = (value: unknown): string => {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Holds the open visualisation scenes (in memory, bounded) and applies the view commands. */
@Injectable()
export class VisualizationService {
  private readonly scenes = new Map<string, Stored>();
  private currentId: string | null = null;
  now: () => number = Date.now;

  constructor(private readonly registry: VisualizationRegistry) {}

  private prune(): void {
    const now = this.now();
    for (const [id, stored] of this.scenes)
      if (now - stored.touchedAt > TTL_MS) this.scenes.delete(id);
    while (this.scenes.size > MAX_SCENES) {
      const oldest = [...this.scenes.entries()].sort(
        (a, b) => a[1].touchedAt - b[1].touchedAt,
      )[0];
      if (!oldest) break;
      this.scenes.delete(oldest[0]);
    }
  }

  private emptyView(mode?: VizMode): VizView {
    return {
      ...(mode ? { mode } : {}),
      highlights: [],
      annotations: [],
      hiddenLayers: [],
      rotations: [],
    };
  }

  private assemble(
    id: string,
    providerId: string,
    typeId: string,
    kind: VizSceneKind,
    built: ProviderScene,
    previous?: VizScene,
    mode?: VizMode,
  ): VizScene {
    const modes =
      built.modes ??
      modesFor({
        kind,
        nodes: built.nodes,
        heatLabel: built.heatLabel,
      });
    const defaultMode = modes.includes(built.defaultMode as VizMode)
      ? (built.defaultMode as VizMode)
      : modes[0]!;
    const refreshMs =
      built.refreshMs === undefined
        ? undefined
        : Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, built.refreshMs));
    const scene: VizScene = {
      schema: 1,
      id,
      title: built.title,
      kind,
      providerId,
      typeId,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date(this.now()).toISOString(),
      ...(built.nodes ? { nodes: built.nodes } : {}),
      ...(built.edges ? { edges: built.edges } : {}),
      ...(built.models ? { models: built.models } : {}),
      ...(built.hotspots ? { hotspots: built.hotspots } : {}),
      ...(built.chart ? { chart: built.chart } : {}),
      layers: built.layers ?? [],
      modes,
      defaultMode,
      ...(built.heatLabel ? { heatLabel: built.heatLabel } : {}),
      ...(built.units ? { units: built.units } : {}),
      notes: built.notes ?? [],
      actions: built.actions ?? [],
      ...(refreshMs ? { refreshMs } : {}),
      view: previous?.view ?? this.emptyView(mode),
    };
    if (mode && !previous) scene.view.mode = mode;
    // Highlights/selection of objects that no longer exist are dropped after a refresh.
    if (previous && scene.kind === "graph") {
      const ids = new Set((scene.nodes ?? []).map((node) => node.id));
      scene.view = {
        ...scene.view,
        highlights: scene.view.highlights.filter((item) => ids.has(item)),
        annotations: scene.view.annotations.filter((item) =>
          ids.has(item.objectId),
        ),
        selected:
          scene.view.selected && ids.has(scene.view.selected)
            ? scene.view.selected
            : null,
      };
    }
    const check = validateScene(scene);
    if (!check.ok)
      throw new VisualizationError("De scene is ongeldig.", check.errors);
    return scene;
  }

  private store(scene: VizScene, params: Record<string, unknown>): Stored {
    const stored: Stored = {
      scene,
      params,
      touchedAt: this.now(),
      builtAt: this.now(),
      hash: hashOf(scene),
    };
    this.scenes.set(scene.id, stored);
    this.currentId = scene.id;
    this.prune();
    return stored;
  }

  eventFor(scene: VizScene, action: VizEventInfo["action"]): VizEventInfo {
    return {
      id: scene.id,
      title: scene.title,
      kind: scene.kind,
      revision: scene.revision,
      action,
    };
  }

  /** Build a scene from a registered provider ("proxmox", "proxmox:load", ...). */
  async create(
    ref: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    mode?: VizMode,
  ): Promise<VizScene> {
    const resolved = this.registry.resolve(ref);
    if (!resolved)
      throw new VisualizationError(
        `Onbekende visualisatie ${ref}. Bekend: ${this.knownRefs().join(", ")}.`,
      );
    const availability = resolved.provider.available();
    if (!availability.ok) throw new VisualizationError(availability.reason);
    const built = await resolved.provider.build(resolved.type.id, {
      signal,
      params,
    });
    const id = `viz-${crypto.randomBytes(5).toString("hex")}`;
    const scene = this.assemble(
      id,
      resolved.provider.id,
      resolved.type.id,
      resolved.type.kind,
      built,
      undefined,
      mode,
    );
    if (mode && !scene.modes.includes(mode))
      throw new VisualizationError(
        `Modus ${mode} past niet bij deze inhoud. Kies uit: ${scene.modes.join(", ")}.`,
      );
    this.store(scene, params);
    return scene;
  }

  knownRefs(): string[] {
    return this.registry
      .list()
      .flatMap((provider) =>
        provider.types.map((type) => `${provider.id}:${type.id}`),
      );
  }

  /** A scene the model or a caller describes itself (custom graph/chart, or 3D models). */
  createCustom(input: CustomSceneInput): VizScene {
    const id = `viz-${crypto.randomBytes(5).toString("hex")}`;
    const scene = this.assemble(
      id,
      "custom",
      input.kind === "model" ? "model" : input.kind,
      input.kind,
      {
        title: input.title,
        nodes: input.nodes,
        edges: input.edges,
        models: input.models,
        hotspots: input.hotspots,
        chart: input.chart,
        layers: input.layers,
        notes: input.notes,
        units: input.units,
        heatLabel: input.heatLabel,
      },
      undefined,
      input.mode,
    );
    if (input.mode && !scene.modes.includes(input.mode))
      throw new VisualizationError(
        `Modus ${input.mode} past niet bij deze inhoud. Kies uit: ${scene.modes.join(", ")}.`,
      );
    this.store(scene, {});
    return scene;
  }

  private touch(id: string | undefined): Stored {
    this.prune();
    const key = id ?? this.currentId;
    const stored = key ? this.scenes.get(key) : undefined;
    if (!stored)
      throw new VisualizationError(
        id
          ? "Die visualisatie bestaat niet (meer)."
          : "Er is geen open visualisatie. Maak er eerst een met create_visualization.",
      );
    stored.touchedAt = this.now();
    this.currentId = stored.scene.id;
    return stored;
  }

  private bump(stored: Stored): VizScene {
    stored.scene = {
      ...stored.scene,
      revision: stored.scene.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
    };
    return stored.scene;
  }

  get(id: string): VizScene | null {
    this.prune();
    return this.scenes.get(id)?.scene ?? null;
  }

  list(): VizScene[] {
    this.prune();
    return [...this.scenes.values()].map((stored) => stored.scene);
  }

  /**
   * The scene for the UI. A live scene is rebuilt from its provider when its refresh interval
   * has passed; concurrent polls share one rebuild. A failed rebuild keeps the last scene.
   */
  async read(
    id: string,
    since: number | undefined,
    signal: AbortSignal,
  ): Promise<
    { unchanged: true; revision: number } | { scene: VizScene } | null
  > {
    const stored = this.scenes.get(id);
    if (!stored) return null;
    stored.touchedAt = this.now();
    const refreshMs = stored.scene.refreshMs;
    if (
      !stored.rebuilding &&
      refreshMs &&
      this.now() - stored.builtAt >= refreshMs &&
      stored.scene.providerId !== "custom"
    )
      stored.rebuilding = this.rebuild(stored, signal).finally(() => {
        stored.rebuilding = undefined;
      });
    // Concurrent polls wait for the one rebuild that is already running.
    if (stored.rebuilding) await stored.rebuilding;
    return since !== undefined && since === stored.scene.revision
      ? { unchanged: true, revision: stored.scene.revision }
      : { scene: stored.scene };
  }

  private async rebuild(stored: Stored, signal: AbortSignal): Promise<void> {
    const { providerId, typeId } = stored.scene;
    const provider = this.registry.get(providerId);
    const type = provider?.types.find((item) => item.id === typeId);
    stored.builtAt = this.now();
    if (!provider || !type || !provider.available().ok) return;
    try {
      const built = await provider.build(type.id, {
        signal,
        params: stored.params,
      });
      const next = this.assemble(
        stored.scene.id,
        providerId,
        typeId,
        stored.scene.kind,
        built,
        stored.scene,
      );
      const hash = hashOf(next);
      if (hash === stored.hash) return;
      stored.hash = hash;
      stored.scene = next;
    } catch {
      /* The last good scene stays visible; the viewer shows its own timestamp. */
    }
  }

  /** Rebuild a live scene from its provider now (update_visualization with refresh). */
  async refresh(
    id: string | undefined,
    signal: AbortSignal,
  ): Promise<VizScene> {
    const stored = this.touch(id);
    if (stored.scene.providerId === "custom")
      throw new VisualizationError(
        "Een eigen visualisatie heeft geen bron om te verversen.",
      );
    const before = stored.scene.revision;
    await this.rebuild(stored, signal);
    if (stored.scene.revision === before) stored.scene = this.bump(stored);
    return stored.scene;
  }

  update(
    id: string | undefined,
    patch: {
      title?: string;
      mode?: VizMode;
      dimension?: "2d" | "3d";
      nodes?: VizScene["nodes"];
      edges?: VizScene["edges"];
      chart?: VizScene["chart"];
      notes?: string[];
    },
  ): VizScene {
    const stored = this.touch(id);
    const scene = stored.scene;
    const custom = scene.providerId === "custom";
    if ((patch.nodes || patch.edges || patch.chart || patch.notes) && !custom)
      throw new VisualizationError(
        "Gegevens van een live visualisatie komen van de bron; die kun je niet overschrijven. Maak een eigen visualisatie met create_visualization.",
      );
    if (patch.mode && !scene.modes.includes(patch.mode))
      throw new VisualizationError(
        `Modus ${patch.mode} past niet bij deze inhoud. Kies uit: ${scene.modes.join(", ")}.`,
      );
    if (patch.dimension && scene.kind !== "graph")
      throw new VisualizationError(
        "2D/3D kiezen kan alleen bij een graaf-visualisatie.",
      );
    const next: VizScene = {
      ...scene,
      title: patch.title ?? scene.title,
      ...(patch.nodes ? { nodes: patch.nodes } : {}),
      ...(patch.edges ? { edges: patch.edges } : {}),
      ...(patch.chart ? { chart: patch.chart } : {}),
      notes: patch.notes ?? scene.notes,
      revision: scene.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
      view: {
        ...scene.view,
        ...(patch.mode ? { mode: patch.mode } : {}),
        ...(patch.dimension ? { dimension: patch.dimension } : {}),
      },
    };
    if (patch.nodes) {
      next.modes = modesFor({ kind: next.kind, nodes: next.nodes });
      if (!next.modes.includes(next.defaultMode))
        next.defaultMode = next.modes[0]!;
      if (next.view.mode && !next.modes.includes(next.view.mode))
        delete next.view.mode;
    }
    const check = validateScene(next);
    if (!check.ok)
      throw new VisualizationError("De scene is ongeldig.", check.errors);
    stored.scene = next;
    stored.hash = hashOf(next);
    return next;
  }

  private objectExists(scene: VizScene, objectId: string): boolean {
    if (!validObjectId(objectId)) return false;
    if (scene.kind === "graph")
      return (scene.nodes ?? []).some((node) => node.id === objectId);
    // Names of parts inside a GLB/3MF are only known to the viewer, so any valid id passes.
    if (scene.kind === "model") return true;
    return false;
  }

  private requireObject(scene: VizScene, objectId: string): void {
    if (scene.kind === "chart")
      throw new VisualizationError(
        "Een grafiek heeft geen losse objecten om te selecteren.",
      );
    if (!this.objectExists(scene, objectId))
      throw new VisualizationError(
        `Onbekend object ${String(objectId).slice(0, 60)}. Gebruik een id uit de visualisatie.`,
      );
  }

  highlight(
    id: string | undefined,
    objectIds: string[],
    replace: boolean,
  ): VizScene {
    const stored = this.touch(id);
    for (const objectId of objectIds)
      this.requireObject(stored.scene, objectId);
    const highlights = replace
      ? [...new Set(objectIds)]
      : [...new Set([...stored.scene.view.highlights, ...objectIds])];
    stored.scene = {
      ...this.bump(stored),
      view: { ...stored.scene.view, highlights: highlights.slice(0, 100) },
    };
    return stored.scene;
  }

  rotate(
    id: string | undefined,
    objectId: string,
    axis: "x" | "y" | "z",
    degrees: number,
  ): VizScene {
    const stored = this.touch(id);
    if (stored.scene.kind === "chart")
      throw new VisualizationError("Een grafiek kun je niet draaien.");
    if (stored.scene.kind === "model" && objectId !== "*")
      this.requireObject(stored.scene, objectId);
    if (stored.scene.kind === "graph" && objectId !== "*")
      this.requireObject(stored.scene, objectId);
    const rotations = [
      ...stored.scene.view.rotations.filter(
        (item) => !(item.objectId === objectId && item.axis === axis),
      ),
      { objectId, axis, degrees },
    ].slice(-50);
    stored.scene = {
      ...this.bump(stored),
      view: { ...stored.scene.view, rotations },
    };
    return stored.scene;
  }

  focusCamera(
    id: string | undefined,
    target: { objectId?: string; preset?: VizCameraPreset },
  ): VizScene {
    const stored = this.touch(id);
    if (stored.scene.kind === "chart")
      throw new VisualizationError("Een grafiek heeft geen camera.");
    if (target.objectId) this.requireObject(stored.scene, target.objectId);
    if (target.preset && !CAMERA_PRESETS.includes(target.preset))
      throw new VisualizationError(
        `Onbekend camerastandpunt. Kies uit: ${CAMERA_PRESETS.join(", ")}.`,
      );
    stored.scene = {
      ...this.bump(stored),
      view: {
        ...stored.scene.view,
        camera: {
          ...(target.preset ? { preset: target.preset } : {}),
          ...(target.objectId ? { focus: target.objectId } : {}),
          seq: (stored.scene.view.camera?.seq ?? 0) + 1,
        },
      },
    };
    return stored.scene;
  }

  annotate(id: string | undefined, objectId: string, text: string): VizScene {
    const stored = this.touch(id);
    this.requireObject(stored.scene, objectId);
    const annotations = [
      ...stored.scene.view.annotations.filter(
        (item) => item.objectId !== objectId,
      ),
      { objectId, text: text.slice(0, 300) },
    ].slice(-MAX_ANNOTATIONS);
    stored.scene = {
      ...this.bump(stored),
      view: { ...stored.scene.view, annotations },
    };
    return stored.scene;
  }

  /** Select an object and answer with the facts the scene knows about it. */
  async details(
    id: string | undefined,
    objectId: string,
    signal: AbortSignal,
  ): Promise<{ scene: VizScene; details: Record<string, unknown> }> {
    const stored = this.touch(id);
    const scene = stored.scene;
    this.requireObject(scene, objectId);
    let details: Record<string, unknown>;
    if (scene.kind === "graph") {
      const node = scene.nodes!.find((item) => item.id === objectId)!;
      const links = (scene.edges ?? []).filter(
        (edge) => edge.from === objectId || edge.to === objectId,
      );
      const labelOf = (nodeId: string) =>
        scene.nodes!.find((item) => item.id === nodeId)?.label ?? nodeId;
      details = {
        id: node.id,
        label: node.label,
        kind: node.kind ?? null,
        status: node.status ?? "unknown",
        value: node.value ?? null,
        ...(node.detail ?? {}),
        links: links.slice(0, 20).map((edge) => ({
          with: labelOf(edge.from === objectId ? edge.to : edge.from),
          ...(edge.label ? { relation: edge.label } : {}),
        })),
      };
      const provider = this.registry.get(scene.providerId);
      if (provider?.describe) {
        try {
          const extra = await provider.describe(scene.typeId, objectId, {
            signal,
            params: stored.params,
          });
          if (extra) details = { ...details, ...extra };
        } catch {
          /* The scene's own facts are enough. */
        }
      }
    } else {
      const spot = scene.hotspots?.find((item) => item.id === objectId);
      const model = scene.models?.find((item) => item.id === objectId);
      details = spot
        ? { id: spot.id, label: spot.label, ...(spot.detail ?? {}) }
        : model
          ? {
              id: model.id,
              label: model.label,
              format: model.format,
              ...(scene.units ? { units: scene.units } : {}),
            }
          : {
              id: objectId,
              note: "Onderdeel van het model; de viewer toont zijn eigen afmetingen.",
            };
    }
    stored.scene = {
      ...this.bump(stored),
      view: { ...stored.scene.view, selected: objectId },
    };
    return { scene: stored.scene, details };
  }

  clear(id: string | undefined, all = false): VizEventInfo[] {
    this.prune();
    if (all) {
      const events = [...this.scenes.values()].map((stored) =>
        this.eventFor(stored.scene, "clear"),
      );
      this.scenes.clear();
      this.currentId = null;
      return events;
    }
    const stored = this.touch(id);
    this.scenes.delete(stored.scene.id);
    this.currentId = null;
    return [this.eventFor(stored.scene, "clear")];
  }

  /** The scene as data: JSON, or CSV of its table (nodes, models or chart points). */
  export(
    id: string | undefined,
    format: "json" | "csv",
  ): { filename: string; mime: string; content: string; scene: VizScene } {
    const scene = this.touch(id).scene;
    const base =
      scene.title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40) || "visualisatie";
    if (format === "json")
      return {
        filename: `${base}.json`,
        mime: "application/json",
        content: JSON.stringify(scene, null, 2),
        scene,
      };
    const rows: unknown[][] = [];
    if (scene.kind === "graph") {
      rows.push([
        "id",
        "label",
        "soort",
        "status",
        "waarde",
        "ouder",
        "details",
      ]);
      for (const node of scene.nodes ?? [])
        rows.push([
          node.id,
          node.label,
          node.kind,
          node.status ?? "unknown",
          node.value,
          node.parent,
          Object.entries(node.detail ?? {})
            .map(([key, value]) => `${key}=${value}`)
            .join("; "),
        ]);
    } else if (scene.kind === "chart") {
      rows.push(["reeks", "label", "waarde", "eenheid", "status"]);
      for (const series of scene.chart?.series ?? [])
        for (const point of series.points)
          rows.push([
            series.label,
            point.label,
            point.value,
            scene.chart?.unit,
            point.status,
          ]);
    } else {
      rows.push(["id", "label", "formaat", "laag"]);
      for (const model of scene.models ?? [])
        rows.push([model.id, model.label, model.format, model.layer]);
    }
    return {
      filename: `${base}.csv`,
      mime: "text/csv",
      content: rows.map((row) => row.map(csvCell).join(",")).join("\n"),
      scene,
    };
  }
}

export const isVizMode = (value: unknown): value is VizMode =>
  typeof value === "string" && (VIZ_MODES as readonly string[]).includes(value);

export type { VizDetailValue };
