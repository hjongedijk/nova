import type {
  VizDetailValue,
  VizMode,
  VizScene,
  VizSceneKind,
  VizStatus,
} from "@nova/contracts";

export const MAX_NODES = 1500;
export const MAX_EDGES = 4000;
export const MAX_MODELS = 12;
export const MAX_HOTSPOTS = 200;
export const MAX_CHART_POINTS = 500;
export const MAX_ANNOTATIONS = 50;

export const VIZ_MODES: readonly VizMode[] = [
  "holographic",
  "realistic",
  "wireframe",
  "technical",
  "heatmap",
  "xray",
];
export const VIZ_STATUSES: readonly VizStatus[] = [
  "ok",
  "active",
  "warning",
  "critical",
  "off",
  "unknown",
];
const FORMATS = new Set(["glb", "gltf", "stl", "3mf"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/#@+-]{0,119}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++)
    if (value.charCodeAt(i) < 32) return true;
  return false;
}

/** A model URL is a same-origin API path or a blob: URL made by the page; never an external host. */
export function isSafeModelUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 500) return false;
  if (url.startsWith("blob:")) return /^blob:[A-Za-z0-9:/._-]+$/.test(url);
  if (!url.startsWith("/") || url.startsWith("//") || url.includes("\\"))
    return false;
  if (hasControlCharacter(url)) return false;
  const path = url.split(/[?#]/)[0] ?? "";
  return !path.split("/").some((part) => part === ".." || part === ".");
}

/** Which modes make sense for what the scene contains. */
export function modesFor(scene: {
  kind: VizSceneKind;
  nodes?: { value?: number | null }[];
  heatLabel?: string;
}): VizMode[] {
  if (scene.kind === "chart") return ["realistic"];
  const heat = (scene.nodes ?? []).some(
    (node) => typeof node.value === "number",
  );
  if (scene.kind === "graph")
    return [
      "holographic",
      "realistic",
      "wireframe",
      ...(heat ? (["heatmap"] as const) : []),
    ];
  return [
    "holographic",
    "realistic",
    "wireframe",
    "technical",
    "xray",
    ...(heat ? (["heatmap"] as const) : []),
  ];
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const vec3 = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((item) => finite(item) && Math.abs(item) < 1e7);

function details(value: unknown, where: string, errors: string[]): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return void errors.push(`${where}: detail moet een object zijn`);
  const entries = Object.entries(value as Record<string, VizDetailValue>);
  if (entries.length > 40) errors.push(`${where}: te veel detailvelden`);
  for (const [key, item] of entries) {
    if (key.length > 60)
      errors.push(`${where}: detailnaam te lang (${key.slice(0, 20)}...)`);
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    )
      errors.push(`${where}: detailwaarde van ${key} is ongeldig`);
    else if (typeof item === "string" && item.length > 400)
      errors.push(`${where}: detailwaarde van ${key} is te lang`);
    else if (typeof item === "number" && !Number.isFinite(item))
      errors.push(`${where}: detailwaarde van ${key} is geen getal`);
  }
}

/** Strict structural validation. Returns every problem found (bounded), never throws. */
export function validateScene(scene: VizScene): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const push = (message: string) => {
    if (errors.length < 30) errors.push(message);
  };
  if (!scene || typeof scene !== "object" || scene.schema !== 1)
    return { ok: false, errors: ["Onbekend scene-formaat."] };
  if (typeof scene.id !== "string" || !ID.test(scene.id))
    push("id is ongeldig");
  if (
    typeof scene.title !== "string" ||
    !scene.title.trim() ||
    scene.title.length > 120
  )
    push("titel ontbreekt of is te lang");
  if (!["graph", "model", "chart"].includes(scene.kind))
    push("kind moet graph, model of chart zijn");
  if (!Array.isArray(scene.modes) || !scene.modes.length)
    push("modes ontbreekt");
  else {
    for (const mode of scene.modes)
      if (!VIZ_MODES.includes(mode)) push(`onbekende weergavemodus ${mode}`);
    if (!scene.modes.includes(scene.defaultMode))
      push("defaultMode zit niet in modes");
  }
  const layerIds = new Set<string>();
  for (const layer of scene.layers ?? []) {
    if (!layer || !ID.test(layer.id) || !layer.label || layer.label.length > 80)
      push("ongeldige laag");
    else if (layerIds.has(layer.id)) push(`dubbele laag ${layer.id}`);
    else layerIds.add(layer.id);
  }
  const objectIds = new Set<string>();

  if (scene.kind === "graph") {
    const nodes = scene.nodes;
    if (!Array.isArray(nodes) || !nodes.length)
      push("een graph heeft minstens één node nodig");
    else {
      if (nodes.length > MAX_NODES)
        push(`maximaal ${MAX_NODES} nodes (nu ${nodes.length})`);
      for (const node of nodes.slice(0, MAX_NODES)) {
        if (!node || typeof node.id !== "string" || !ID.test(node.id)) {
          push("node met ongeldige id");
          continue;
        }
        if (objectIds.has(node.id)) push(`dubbele node-id ${node.id}`);
        objectIds.add(node.id);
        if (
          typeof node.label !== "string" ||
          !node.label ||
          node.label.length > 120
        )
          push(`node ${node.id}: label ontbreekt of is te lang`);
        if (node.status !== undefined && !VIZ_STATUSES.includes(node.status))
          push(`node ${node.id}: onbekende status`);
        if (
          node.value != null &&
          (!finite(node.value) || node.value < 0 || node.value > 1)
        )
          push(`node ${node.id}: value moet tussen 0 en 1 liggen`);
        if (
          node.size !== undefined &&
          (!finite(node.size) || node.size < 0.3 || node.size > 4)
        )
          push(`node ${node.id}: size buiten bereik`);
        if (node.position !== undefined && !vec3(node.position))
          push(`node ${node.id}: ongeldige positie`);
        if (node.layer && !layerIds.has(node.layer))
          push(`node ${node.id}: onbekende laag ${node.layer}`);
        details(node.detail, `node ${node.id}`, errors);
      }
      for (const node of nodes.slice(0, MAX_NODES))
        if (node?.parent && !objectIds.has(node.parent))
          push(`node ${node.id}: onbekende parent ${node.parent}`);
      // A parent chain must end: no cycles.
      const parentOf = new Map(
        nodes.map((node) => [node?.id, node?.parent] as const),
      );
      for (const node of nodes.slice(0, MAX_NODES)) {
        const seen = new Set<string>();
        let at: string | undefined = node?.id;
        while (at && parentOf.get(at)) {
          if (seen.has(at)) {
            push(`parent-lus bij ${node.id}`);
            break;
          }
          seen.add(at);
          at = parentOf.get(at);
        }
      }
    }
    if ((scene.edges?.length ?? 0) > MAX_EDGES)
      push(`maximaal ${MAX_EDGES} verbindingen`);
    for (const edge of (scene.edges ?? []).slice(0, MAX_EDGES)) {
      if (!objectIds.has(edge?.from) || !objectIds.has(edge?.to))
        push(
          `verbinding ${edge?.from} → ${edge?.to} verwijst naar een onbekende node`,
        );
      if (edge?.status !== undefined && !VIZ_STATUSES.includes(edge.status))
        push("verbinding met onbekende status");
      if (
        edge?.weight !== undefined &&
        (!finite(edge.weight) || edge.weight < 0 || edge.weight > 1)
      )
        push("verbinding: weight moet tussen 0 en 1 liggen");
    }
    if (scene.models?.length) push("een graph heeft geen models");
  }

  if (scene.kind === "model") {
    const models = scene.models;
    if (!Array.isArray(models) || !models.length)
      push("een model-scene heeft minstens één model nodig");
    else {
      if (models.length > MAX_MODELS) push(`maximaal ${MAX_MODELS} modellen`);
      for (const model of models.slice(0, MAX_MODELS)) {
        if (!model || !ID.test(model.id)) {
          push("model met ongeldige id");
          continue;
        }
        if (objectIds.has(model.id)) push(`dubbel model-id ${model.id}`);
        objectIds.add(model.id);
        if (!FORMATS.has(model.format))
          push(`model ${model.id}: formaat moet glb, gltf, stl of 3mf zijn`);
        if (!isSafeModelUrl(model.url))
          push(
            `model ${model.id}: url moet een eigen /api-pad of blob: zijn, geen externe host`,
          );
        if (!model.label || model.label.length > 120)
          push(`model ${model.id}: label ontbreekt of is te lang`);
        if (model.color !== undefined && !COLOR.test(model.color))
          push(`model ${model.id}: kleur moet #rrggbb zijn`);
        if (
          model.scale !== undefined &&
          (!finite(model.scale) || model.scale <= 0 || model.scale > 1e6)
        )
          push(`model ${model.id}: ongeldige schaal`);
        if (model.layer && !layerIds.has(model.layer))
          push(`model ${model.id}: onbekende laag ${model.layer}`);
      }
    }
    if (scene.nodes?.length) push("een model-scene heeft geen nodes");
    if ((scene.hotspots?.length ?? 0) > MAX_HOTSPOTS)
      push(`maximaal ${MAX_HOTSPOTS} hotspots`);
    for (const hotspot of (scene.hotspots ?? []).slice(0, MAX_HOTSPOTS)) {
      if (!hotspot || !ID.test(hotspot.id) || !hotspot.label)
        push("hotspot met ongeldige id of label");
      else if (!vec3(hotspot.position))
        push(`hotspot ${hotspot.id}: ongeldige positie`);
      else details(hotspot.detail, `hotspot ${hotspot.id}`, errors);
    }
  }

  if (scene.kind === "chart") {
    const chart = scene.chart;
    if (!chart || !["bar", "line"].includes(chart.type))
      push("chart.type moet bar of line zijn");
    else {
      if (!Array.isArray(chart.series) || !chart.series.length)
        push("chart heeft minstens één reeks nodig");
      let points = 0;
      for (const series of chart.series ?? []) {
        if (!series?.label) push("reeks zonder label");
        for (const point of series?.points ?? []) {
          points++;
          if (!point?.label) push("punt zonder label");
          if (point.value !== null && !finite(point.value))
            push(`punt ${point.label}: waarde is geen getal`);
          if (
            point.status !== undefined &&
            !VIZ_STATUSES.includes(point.status)
          )
            push(`punt ${point.label}: onbekende status`);
        }
      }
      if (points > MAX_CHART_POINTS)
        push(`maximaal ${MAX_CHART_POINTS} datapunten`);
      if (chart.max !== undefined && (!finite(chart.max) || chart.max <= 0))
        push("chart.max moet positief zijn");
    }
  }

  const v = scene.view;
  if (!v || typeof v !== "object") push("view ontbreekt");
  else {
    if (v.mode !== undefined && !scene.modes?.includes(v.mode))
      push(`modus ${v.mode} past niet bij deze inhoud`);
    for (const id of v.highlights ?? [])
      if (objectIds.size && !objectIds.has(id) && scene.kind !== "model")
        push(`highlight ${id} bestaat niet`);
    if ((v.annotations?.length ?? 0) > MAX_ANNOTATIONS)
      push(`maximaal ${MAX_ANNOTATIONS} annotaties`);
  }
  if ((scene.notes?.length ?? 0) > 20) push("te veel notities");
  return { ok: errors.length === 0, errors };
}
