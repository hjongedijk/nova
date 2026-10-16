import type { VizNode, VizScene } from "./types.ts";

export interface NodePlace {
  /** Position in the layout plane. */
  u: number;
  v: number;
  /** Height for 3D (from the layer order); 0 when the node has no layer. */
  h: number;
  depth: number;
}

export interface Layout {
  places: Map<string, NodePlace>;
  radius: number;
}

const SPACING = 2.4;
const RING_STEP = 3.2;
const LAYER_GAP = 2.6;

/**
 * Deterministic radial tree layout: the parent chain gives the rings, every subtree gets an
 * angular wedge in proportion to its leaves. Nodes that carry a real `position` (an imported
 * model or a user-defined room) keep it. Nothing is random, so a refresh never shuffles the view.
 */
export function layoutGraph(scene: Pick<VizScene, "nodes" | "layers">): Layout {
  const nodes = scene.nodes ?? [];
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<string, VizNode[]>();
  const roots: VizNode[] = [];
  for (const node of nodes) {
    if (node.parent && ids.has(node.parent)) {
      const list = children.get(node.parent) ?? [];
      list.push(node);
      children.set(node.parent, list);
    } else roots.push(node);
  }
  const leaves = new Map<string, number>();
  const countLeaves = (node: VizNode, seen: Set<string>): number => {
    if (seen.has(node.id)) return 1;
    seen.add(node.id);
    const kids = children.get(node.id) ?? [];
    const total = kids.length
      ? kids.reduce((sum, kid) => sum + countLeaves(kid, seen), 0)
      : 1;
    leaves.set(node.id, total);
    return total;
  };
  for (const root of roots) countLeaves(root, new Set());

  // Ring radius per depth: far enough that the nodes on the ring do not overlap.
  const perDepth: number[] = [];
  const walk = (node: VizNode, depth: number, seen: Set<string>) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    perDepth[depth] = (perDepth[depth] ?? 0) + 1;
    for (const kid of children.get(node.id) ?? []) walk(kid, depth + 1, seen);
  };
  const seenAll = new Set<string>();
  for (const root of roots) walk(root, 0, seenAll);
  const radii: number[] = [];
  const single = roots.length === 1;
  for (let depth = 0; depth < perDepth.length; depth++) {
    const needed = ((perDepth[depth] ?? 1) * SPACING) / (2 * Math.PI);
    const min = single ? depth * RING_STEP : (depth + 1) * RING_STEP;
    radii[depth] = Math.max(
      needed,
      min,
      (radii[depth - 1] ?? 0) + (depth ? RING_STEP * 0.8 : 0),
    );
  }

  const layerIndex = new Map(
    (scene.layers ?? []).map((layer, index) => [layer.id, index]),
  );
  const layerCount = Math.max(1, layerIndex.size);
  const heightOf = (node: VizNode) =>
    node.layer && layerIndex.has(node.layer)
      ? (layerIndex.get(node.layer)! - (layerCount - 1) / 2) * LAYER_GAP
      : 0;

  const places = new Map<string, NodePlace>();
  const place = (
    node: VizNode,
    depth: number,
    start: number,
    end: number,
    seen: Set<string>,
  ) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const angle = (start + end) / 2;
    const radius = single && depth === 0 ? 0 : (radii[depth] ?? 0);
    places.set(node.id, {
      u: Math.cos(angle) * radius,
      v: Math.sin(angle) * radius,
      h: heightOf(node),
      depth,
    });
    const kids = children.get(node.id) ?? [];
    const total = kids.reduce((sum, kid) => sum + (leaves.get(kid.id) ?? 1), 0);
    let at = start;
    for (const kid of kids) {
      const share = ((end - start) * (leaves.get(kid.id) ?? 1)) / (total || 1);
      place(kid, depth + 1, at, at + share, seen);
      at += share;
    }
  };
  const rootTotal = roots.reduce(
    (sum, root) => sum + (leaves.get(root.id) ?? 1),
    0,
  );
  let at = -Math.PI / 2;
  const seenPlace = new Set<string>();
  for (const root of roots) {
    const share = (Math.PI * 2 * (leaves.get(root.id) ?? 1)) / (rootTotal || 1);
    place(root, 0, at, at + share, seenPlace);
    at += share;
  }
  // Real positions win over the computed ones.
  for (const node of nodes)
    if (node.position)
      places.set(node.id, {
        u: node.position[0],
        v: node.position[1],
        h: node.position[2],
        depth: places.get(node.id)?.depth ?? 0,
      });
  let radius = 1;
  for (const p of places.values())
    radius = Math.max(radius, Math.hypot(p.u, p.v, p.h));
  return { places, radius };
}
