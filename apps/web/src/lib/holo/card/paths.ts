import type { ArcShape, AreaShape } from "./types.ts";

const f = (n: number) => Math.round(n * 100) / 100;

/** SVG path of a ring segment. Angles in radians, clockwise from the right (SVG orientation). */
export function arcPath(shape: ArcShape): string {
  const { cx, cy, r0, r1, a0, a1 } = shape;
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  const p = (r: number, a: number) =>
    `${f(cx + Math.cos(a) * r)} ${f(cy + Math.sin(a) * r)}`;
  return `M${p(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}

export const linePath = (pts: [number, number][]): string =>
  pts.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join("");

export function areaPath(shape: AreaShape): string {
  const { pts, baseY } = shape;
  if (!pts.length) return "";
  return `${linePath(pts)}L${f(pts[pts.length - 1]![0])} ${f(baseY)}L${f(pts[0]![0])} ${f(baseY)}Z`;
}
