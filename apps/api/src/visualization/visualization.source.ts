import {
  number,
  schema,
  text,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import type { VizScene } from "@nova/contracts";
import { resolveTopic } from "./intent.js";
import { VisualizationRegistry } from "./visualization.registry.js";
import {
  CAMERA_PRESETS,
  isVizMode,
  VisualizationError,
  VisualizationService,
} from "./visualization.service.js";
import { VIZ_MODES } from "./scene.validation.js";

const MODE = { type: "string", enum: [...VIZ_MODES] };
const ID = { type: "string", minLength: 1, maxLength: 40 };
const OBJECT = text(120);
const FORMAT = { type: "string", enum: ["glb", "gltf", "stl", "3mf"] };
const EXPORT_LIMIT = 20_000;

/** What the model and the audit log get back: counts and ids, never the whole scene. */
export function describeScene(scene: VizScene) {
  return {
    id: scene.id,
    title: scene.title,
    kind: scene.kind,
    provider: scene.providerId,
    modes: scene.modes,
    mode: scene.view.mode ?? scene.defaultMode,
    nodes: scene.nodes?.length,
    edges: scene.edges?.length,
    models: scene.models?.length,
    chartPoints: scene.chart?.series.reduce((n, s) => n + s.points.length, 0),
    notes: scene.notes,
    revision: scene.revision,
  };
}

/**
 * The visualisation tools. They only change what the NOVA screen shows (nothing outside NOVA),
 * and the data they show comes from providers that read existing services, so they are
 * READ_ONLY. Device control stays with the existing tools and their confirmations.
 */
@ToolSourceProvider()
export class VisualizationSource implements ToolSource {
  readonly source = "visualization";

  constructor(
    private readonly viz: VisualizationService,
    private readonly registry: VisualizationRegistry,
  ) {}

  definitions(): ToolDefinition[] {
    const refs = this.viz.knownRefs();
    const graphData = {
      nodes: {
        type: "array",
        maxItems: 300,
        description:
          "Custom graph nodes: {id, label, kind?, parent?, status? (ok|active|warning|critical|off|unknown), value? 0..1, detail? {key: string|number|boolean}}.",
        items: { type: "object" },
      },
      edges: {
        type: "array",
        maxItems: 800,
        description: "Custom graph links: {from, to, label?}.",
        items: { type: "object" },
      },
      chart: {
        type: "object",
        description:
          "Custom 2D chart: {type: bar|line, unit, series: [{label, points: [{label, value}]}]}.",
      },
    };
    return [
      {
        name: "create_visualization",
        description: `Open the holographic visualization view (3D/2D graph or chart) for something the user asks to SEE: "toon mijn Proxmox", "laat het netwerk zien", "visualiseer mijn huis", "show my servers", "wat doet NOVA nu" as a picture. Sources: ${refs.join(", ")} (or a short topic such as "proxmox", "netwerk", "huis", "activiteit"). It shows only real data from existing services and marks unknown values as unknown. Do NOT call it for plain questions that want text ("hoeveel VM's draaien er", "hoe is de status"): answer those in words. After opening, give one short sentence about what is shown; do not read the whole scene aloud. For own data use source "custom" with nodes/edges or chart.`,
        parameters: schema(
          {
            source: text(60),
            mode: MODE,
            dimension: { type: "string", enum: ["2d", "3d"] },
            title: text(120),
            ...graphData,
            notes: { type: "array", maxItems: 10, items: text(300) },
          },
          ["source"],
        ),
        risk: "READ_ONLY",
        timeoutMs: 30_000,
      },
      {
        name: "update_visualization",
        description:
          "Change the open visualization: title, display mode (holographic, realistic, wireframe, technical, heatmap, xray; only modes that fit the content), 2d or 3d for graphs, refresh live data from its source, or replace the data of a custom visualization. Without id it uses the one that is open.",
        parameters: schema(
          {
            id: ID,
            title: text(120),
            mode: MODE,
            dimension: { type: "string", enum: ["2d", "3d"] },
            refresh: { type: "boolean" },
            ...graphData,
            notes: { type: "array", maxItems: 10, items: text(300) },
          },
          [],
        ),
        risk: "READ_ONLY",
        timeoutMs: 30_000,
      },
      {
        name: "load_3d_scene",
        description:
          'Show one or more 3D models (glb, gltf, stl, 3mf) in the holographic viewer. Each model needs a "url" that is a path on this NOVA server (starting with /api/) or a blob: URL; external web addresses are refused. Optional hotspots mark positions in model space; "units" (for example mm) is used for measurements. Use for 3D files the user or another NOVA feature provides, never for invented geometry.',
        parameters: schema(
          {
            title: text(120),
            models: {
              type: "array",
              minItems: 1,
              maxItems: 12,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "format", "url"],
                properties: {
                  id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" },
                  label: text(120),
                  format: FORMAT,
                  url: text(500),
                  layer: text(40),
                  color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
                  scale: number(0.000001, 1000000),
                },
              },
            },
            hotspots: {
              type: "array",
              maxItems: 50,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "label", "position"],
                properties: {
                  id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" },
                  label: text(120),
                  position: {
                    type: "array",
                    minItems: 3,
                    maxItems: 3,
                    items: { type: "number" },
                  },
                  detail: { type: "object" },
                },
              },
            },
            units: text(10),
            mode: MODE,
          },
          ["title", "models"],
        ),
        risk: "READ_ONLY",
      },
      {
        name: "highlight_object",
        description:
          'Highlight objects in the open visualization by id (node ids as returned by show_object_details or listed in the scene, for example "guest:104"). Set replace=true to replace earlier highlights; give an empty list with replace=true to clear them.',
        parameters: schema(
          {
            id: ID,
            objects: { type: "array", maxItems: 50, items: OBJECT },
            replace: { type: "boolean" },
          },
          ["objects"],
        ),
        risk: "READ_ONLY",
      },
      {
        name: "rotate_object",
        description:
          'Rotate one object of the open visualization (or the whole scene with object "*") around the x, y or z axis by an absolute number of degrees (-360..360).',
        parameters: schema(
          {
            id: ID,
            object: OBJECT,
            axis: { type: "string", enum: ["x", "y", "z"] },
            degrees: number(-360, 360),
          },
          ["object", "axis", "degrees"],
        ),
        risk: "READ_ONLY",
      },
      {
        name: "focus_camera",
        description: `Move the camera of the open visualization to an object and/or a preset viewpoint (${CAMERA_PRESETS.join(", ")}).`,
        parameters: schema(
          {
            id: ID,
            object: OBJECT,
            preset: { type: "string", enum: [...CAMERA_PRESETS] },
          },
          [],
        ),
        risk: "READ_ONLY",
      },
      {
        name: "show_object_details",
        description:
          "Select an object in the open visualization and return what the scene knows about it (status, values, links). Use it to answer questions about one node, VM, device or part.",
        parameters: schema({ id: ID, object: OBJECT }, ["object"]),
        risk: "READ_ONLY",
        timeoutMs: 15_000,
      },
      {
        name: "annotate_object",
        description:
          "Put a short text label next to an object in the open visualization. One note per object; a new note replaces the old one.",
        parameters: schema({ id: ID, object: OBJECT, text: text(300) }, [
          "object",
          "text",
        ]),
        risk: "READ_ONLY",
      },
      {
        name: "clear_visualization",
        description:
          "Close the open visualization (or all of them with all=true) and remove it from NOVA's memory.",
        parameters: schema({ id: ID, all: { type: "boolean" } }, []),
        risk: "READ_ONLY",
      },
      {
        name: "export_visualization",
        description: `Return the data of the open visualization as json or csv text (at most ${EXPORT_LIMIT} characters here; the viewer has a download button for the full file).`,
        parameters: schema(
          { id: ID, format: { type: "string", enum: ["json", "csv"] } },
          [],
        ),
        risk: "READ_ONLY",
      },
    ];
  }

  private done(
    scene: VizScene,
    action: "open" | "update" | "clear",
    extra: Record<string, unknown> = {},
  ): ToolResult {
    return {
      ok: true,
      verified: true,
      result: { ...describeScene(scene), ...extra },
      visualization: this.viz.eventFor(scene, action),
    };
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call: { signal: AbortSignal },
  ): Promise<ToolResult> {
    const id = typeof args.id === "string" ? args.id : undefined;
    const object = typeof args.object === "string" ? args.object : "";
    try {
      switch (name) {
        case "create_visualization": {
          const mode = isVizMode(args.mode) ? args.mode : undefined;
          const source = String(args.source ?? "");
          let scene: VizScene;
          if (source.toLowerCase() === "custom") {
            const nodes = args.nodes as VizScene["nodes"];
            const chart = args.chart as VizScene["chart"];
            if (!nodes?.length && !chart)
              return {
                ok: false,
                error:
                  "Een eigen visualisatie heeft nodes (met edges) of een chart nodig.",
              };
            scene = this.viz.createCustom({
              title:
                typeof args.title === "string" ? args.title : "Visualisatie",
              kind: chart ? "chart" : "graph",
              nodes,
              edges: args.edges as VizScene["edges"],
              chart,
              notes: Array.isArray(args.notes)
                ? (args.notes as string[])
                : undefined,
              mode,
            });
          } else {
            const ref = resolveTopic(source, this.registry);
            if (!ref)
              return {
                ok: false,
                error: `Onbekende bron "${source.slice(0, 40)}". Kies uit: ${this.viz.knownRefs().join(", ")}.`,
              };
            scene = await this.viz.create(ref, {}, call.signal, mode);
          }
          if (args.dimension === "2d" || args.dimension === "3d")
            scene = this.viz.update(scene.id, { dimension: args.dimension });
          return this.done(scene, "open");
        }
        case "update_visualization": {
          let scene: VizScene | null = null;
          if (args.refresh === true)
            scene = await this.viz.refresh(id, call.signal);
          const patch = {
            title: typeof args.title === "string" ? args.title : undefined,
            mode: isVizMode(args.mode) ? args.mode : undefined,
            dimension: (args.dimension === "2d" || args.dimension === "3d"
              ? args.dimension
              : undefined) as "2d" | "3d" | undefined,
            nodes: args.nodes as VizScene["nodes"],
            edges: args.edges as VizScene["edges"],
            chart: args.chart as VizScene["chart"],
            notes: Array.isArray(args.notes)
              ? (args.notes as string[])
              : undefined,
          };
          if (Object.values(patch).some((value) => value !== undefined))
            scene = this.viz.update(scene?.id ?? id, patch);
          if (!scene)
            return { ok: false, error: "Geef op wat er moet veranderen." };
          return this.done(scene, "update");
        }
        case "load_3d_scene": {
          const models = (args.models as Record<string, unknown>[]).map(
            (model, index) => ({
              ...model,
              id: typeof model.id === "string" ? model.id : `model${index + 1}`,
            }),
          ) as unknown as NonNullable<VizScene["models"]>;
          const layers = [
            ...new Set(models.map((model) => model.layer).filter(Boolean)),
          ].map((layer) => ({ id: layer!, label: layer! }));
          const scene = this.viz.createCustom({
            title: String(args.title),
            kind: "model",
            models,
            hotspots: args.hotspots as VizScene["hotspots"],
            layers,
            units: typeof args.units === "string" ? args.units : undefined,
            mode: isVizMode(args.mode) ? args.mode : undefined,
          });
          return this.done(scene, "open");
        }
        case "highlight_object": {
          const list = (args.objects as string[]) ?? [];
          const scene = this.viz.highlight(id, list, args.replace === true);
          return this.done(scene, "update", { highlighted: list.length });
        }
        case "rotate_object": {
          const scene = this.viz.rotate(
            id,
            object,
            args.axis as "x" | "y" | "z",
            Number(args.degrees),
          );
          return this.done(scene, "update");
        }
        case "focus_camera": {
          if (!object && !args.preset)
            return {
              ok: false,
              error: "Geef een object of een camerastandpunt.",
            };
          const scene = this.viz.focusCamera(id, {
            objectId: object || undefined,
            preset: args.preset as never,
          });
          return this.done(scene, "update");
        }
        case "show_object_details": {
          const { scene, details } = await this.viz.details(
            id,
            object,
            call.signal,
          );
          return this.done(scene, "update", { object: details });
        }
        case "annotate_object": {
          const scene = this.viz.annotate(id, object, String(args.text));
          return this.done(scene, "update");
        }
        case "clear_visualization": {
          const events = this.viz.clear(id, args.all === true);
          return {
            ok: true,
            verified: true,
            result: { cleared: events.length },
            visualization: events[0],
          };
        }
        case "export_visualization": {
          const out = this.viz.export(
            id,
            args.format === "csv" ? "csv" : "json",
          );
          return {
            ok: true,
            verified: true,
            result: {
              filename: out.filename,
              truncated: out.content.length > EXPORT_LIMIT,
              content: out.content.slice(0, EXPORT_LIMIT),
            },
          };
        }
        default:
          return { ok: false, error: "Onbekende visualisatietool." };
      }
    } catch (error) {
      if (error instanceof VisualizationError)
        return {
          ok: false,
          error: error.message,
          ...(error.details.length
            ? { details: error.details.slice(0, 10) }
            : {}),
        };
      return {
        ok: false,
        error:
          "De visualisatie kon niet worden opgebouwd. De bron antwoordt niet of geeft onbruikbare gegevens.",
      };
    }
  }
}
