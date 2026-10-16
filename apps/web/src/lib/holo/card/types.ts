import type { VizGlyph } from "../types.ts";

/**
 * A card (weather, gauges, timeline, tiles, series) is laid out ONCE, in plain pixels, into a list
 * of primitives. The flat SVG renderer draws them as they are; the lazy three.js renderer extrudes
 * the very same primitives into a shallow hologram and projects the labels back onto the screen.
 * One layout, two renderers: the flat version is always a complete, legible fallback.
 */
export type Tone =
  | "accent"
  | "ok"
  | "active"
  | "warning"
  | "critical"
  | "off"
  | "unknown"
  | "rain"
  | "warm"
  | "muted";

export type ShapeStyle = "solid" | "ghost" | "dashed";

interface ShapeBase {
  id: string;
  tone: Tone;
  style: ShapeStyle;
  /** Text for the tooltip (also the accessible name of the value). */
  tip: string;
  /** Depth of the extrusion and its offset towards the viewer, in px. */
  d: number;
  z: number;
  /** 0..1 order of the intro animation. */
  appear: number;
}

export interface BoxShape extends ShapeBase {
  type: "box";
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ArcShape extends ShapeBase {
  type: "arc";
  cx: number;
  cy: number;
  r0: number;
  r1: number;
  /** Radians, SVG orientation (0 = right, clockwise). */
  a0: number;
  a1: number;
}
export interface AreaShape extends ShapeBase {
  type: "area";
  /** Top edge, left to right; the shape is closed down to `baseY`. */
  pts: [number, number][];
  baseY: number;
}
export type CardShape = BoxShape | ArcShape | AreaShape;

export interface CardLine {
  id: string;
  kind: "grid" | "axis" | "curve" | "marker";
  pts: [number, number][];
  z: number;
  tone: Tone;
  width: number;
  dashed?: boolean;
}

export type LabelSize = "xs" | "sm" | "md" | "lg" | "xl";
export interface CardLabel {
  id: string;
  x: number;
  y: number;
  z: number;
  text: string;
  anchor: "start" | "middle" | "end";
  tone: Tone | "text" | "dim";
  size: LabelSize;
  bold?: boolean;
}

export type GlyphName =
  | VizGlyph
  | "mark-ok"
  | "mark-active"
  | "mark-warning"
  | "mark-critical"
  | "mark-off"
  | "mark-unknown"
  | "timer";
export interface CardGlyph {
  id: string;
  x: number;
  y: number;
  z: number;
  size: number;
  glyph: GlyphName;
  tone: Tone | "text" | "dim";
  /** Alternative text for the glyph (the word next to it already says the same). */
  title: string;
}

export interface CardLayout {
  width: number;
  height: number;
  shapes: CardShape[];
  lines: CardLine[];
  labels: CardLabel[];
  glyphs: CardGlyph[];
  legend: { tone: Tone; label: string }[];
  /** Largest extrusion depth, for framing the camera. */
  depth: number;
}

export const FONT_PX: Record<LabelSize, number> = {
  xs: 11.5,
  sm: 13,
  md: 14.5,
  lg: 19,
  xl: 30,
};

export const emptyLayout = (width: number, height: number): CardLayout => ({
  width,
  height,
  shapes: [],
  lines: [],
  labels: [],
  glyphs: [],
  legend: [],
  depth: 0,
});
