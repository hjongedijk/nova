import type { VizMode, VizScene } from "./types.ts";

export const MODE_LABELS: Record<VizMode, string> = {
  holographic: "Holografisch",
  realistic: "Realistisch",
  wireframe: "Draadmodel",
  technical: "Technisch",
  heatmap: "Warmtekaart",
  xray: "Röntgen",
};

/** What each mode is for, shown as a tooltip. */
export const MODE_HINTS: Record<VizMode, string> = {
  holographic: "Doorzichtig cyaan met contouren",
  realistic: "Volle kleuren en schaduw",
  wireframe: "Alleen de ribben",
  technical: "Blauwdruk met scherpe randen",
  heatmap: "Kleur naar waarde",
  xray: "Doorkijk met randen",
};

/**
 * The modes that fit the content, in the order they are offered. The server already limits
 * `scene.modes`; this keeps a scene built by another caller honest too (a heat map needs values,
 * technical/x-ray need solid models, a chart has only its own rendering).
 */
export function availableModes(scene: VizScene): VizMode[] {
  if (scene.kind !== "graph" && scene.kind !== "model") return [];
  const hasValues = (scene.nodes ?? []).some(
    (node) => typeof node.value === "number",
  );
  return scene.modes.filter((mode) => {
    if (mode === "heatmap") return hasValues;
    if (mode === "technical" || mode === "xray") return scene.kind === "model";
    return true;
  });
}

/** The mode to start in: the requested one when it fits, else the scene default, else the first. */
export function resolveMode(
  scene: VizScene,
  requested?: VizMode | null,
): VizMode {
  const modes = availableModes(scene);
  if (requested && modes.includes(requested)) return requested;
  if (modes.includes(scene.defaultMode)) return scene.defaultMode;
  return modes[0] ?? "realistic";
}
