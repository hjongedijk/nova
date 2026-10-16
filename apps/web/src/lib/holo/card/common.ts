import type { VizStatus } from "../types.ts";
import {
  FONT_PX,
  type CardLayout,
  type LabelSize,
  type Tone,
} from "./types.ts";

export const PAD = 14;

/** Rough text width in px (Sora is wide). Layout only needs it to decide what fits. */
export const textWidth = (
  text: string,
  size: LabelSize,
  bold = false,
): number => text.length * FONT_PX[size] * (bold ? 0.62 : 0.57);

/** Cut a text with an ellipsis so it fits `max` px. */
export function fit(
  text: string,
  max: number,
  size: LabelSize,
  bold = false,
): string {
  if (textWidth(text, size, bold) <= max) return text;
  const per = FONT_PX[size] * (bold ? 0.62 : 0.57);
  const keep = Math.max(1, Math.floor((max - per) / per));
  return `${text.slice(0, keep).trimEnd()}…`;
}

export const toneOf = (status: VizStatus | undefined): Tone =>
  status === undefined ? "unknown" : status;

const NL = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1 });
export const num = (value: number): string => NL.format(value);

/** 1/2/5 x 10^n tick values covering [min, max]. */
export function niceTicks(
  min: number,
  max: number,
  target = 4,
): { ticks: number[]; min: number; max: number } {
  const span = Math.max(max - min, 1e-9);
  const raw = span / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  const lo = Math.floor(min / unit) * unit;
  const hi = Math.ceil(max / unit) * unit;
  const ticks: number[] = [];
  for (let value = lo; value <= hi + unit / 2; value += unit)
    ticks.push(Math.round(value * 1e9) / 1e9);
  return { ticks, min: lo, max: hi };
}

/** Smooth polyline through the points (Catmull-Rom sampled), for the curves. */
export function smooth(pts: [number, number][], steps = 8): [number, number][] {
  if (pts.length < 3) return pts;
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b +
          (-a + c) * t +
          (2 * a - 5 * b + 4 * c - d) * t2 +
          (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

export function finish(layout: CardLayout): CardLayout {
  layout.depth = layout.shapes.reduce(
    (max, shape) => Math.max(max, shape.z + shape.d),
    0,
  );
  return layout;
}

/** The mark that goes with a status word, so a status never depends on colour alone. */
export const markFor = (status: VizStatus) => `mark-${status}` as const;
