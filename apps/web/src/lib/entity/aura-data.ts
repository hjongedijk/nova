/**
 * The Aura artwork and what is known about it: where its files are, where the head and body sit in the picture,
 * how it is framed on screen, and the timing of the birth. Pure numbers and functions, shared by the renderer,
 * the particle worker and the tests.
 *
 * The artwork (static/aura) was generated with FLUX.1 schnell (Apache-2.0) and approved by the owner; the data
 * atlas next to it is built from it by scripts/aura-assets.mjs.
 */

export const AURA_ASSETS = {
  /** 2560x1440, desktop. */
  hi: "/aura/aura-2560.webp",
  /** 1280x720, low tier and phones. */
  lo: "/aura/aura-1280.webp",
  /** Three 960x540 RGB tiles stacked vertically, see AURA_DATA. */
  data: "/aura/aura-data.png",
  /** Three 1920x1080 RGB layers stacked: distance to the nearest light line, place along it, which line. */
  lines: "/aura/aura-lines.png",
} as const;

/**
 * Measurements of the artwork, in picture units (u across 0..1 left to right, v down 0..1 top to bottom), written
 * by scripts/aura-assets.mjs. Atlas tiles: 0 = form, head, bright; 1 = figure zone, height, figure;
 * 2 = normal x, normal y.
 */
export const AURA_DATA = {
  width: 960,
  height: 540,
  aspect: 16 / 9,
  /** The body's vertical axis. */
  axis: 0.4963,
  head: { cx: 0.4967, cy: 0.289, top: 0.1426, bottom: 0.4389, radius: 0.0583 },
  torsoHalf: 0.1705,
  shoulderTop: 0.6111,
  /** Height range, in data pixels. */
  hmax: 128,
} as const;

/** Star points where the light lines meet (picture units), from scripts/aura-assets.mjs. */
export const STARS: readonly (readonly [number, number])[] = [
  [0.4963, 0.606],
  [0.3503, 0.635],
  [0.6463, 0.64],
  [0.4263, 0.6],
  [0.5743, 0.604],
  [0.3763, 0.8],
];

/** The face, where moods bloom from and the birth's shockwave starts. */
export const FACE = { u: AURA_DATA.head.cx, v: AURA_DATA.head.cy } as const;

/** Room either side of the shoulders when a narrow screen zooms in on the bust (picture widths). */
const BUST_MARGIN = 0.04;

export interface Framing {
  /** Top-left corner of the picture in CSS pixels; may be negative (cropped). */
  x: number;
  y: number;
  /** Size of the whole picture in CSS pixels. */
  w: number;
  h: number;
}

/**
 * Where the picture goes on a W x H screen. Wide screens cover the screen with the figure centred as in the
 * artwork; portrait screens (a phone at 390x844) zoom in on the bust so head and shoulders fill the width.
 */
export function auraFraming(W: number, H: number): Framing {
  W = Math.max(1, W);
  H = Math.max(1, H);
  // Cover: the picture fills the screen...
  const cover = Math.max(W, H * AURA_DATA.aspect);
  // ...unless that would crop the shoulders: then the bust (plus a margin) fills the width instead.
  const bust = W / (2 * (AURA_DATA.torsoHalf + BUST_MARGIN));
  const w = Math.min(cover, bust);
  const h = w / AURA_DATA.aspect;
  // The body's axis on the screen's centre line, as far as the picture reaches.
  const x = Math.min(0, Math.max(W - w, W / 2 - AURA_DATA.axis * w));
  // Covering, the face keeps its place in the frame; zoomed in on a phone, the bust sits in the upper part of
  // the screen (the chat lives below) and fades into the room past the picture's edges.
  const y =
    h >= H
      ? Math.min(0, Math.max(H - h, H * 0.42 - FACE.v * h))
      : H * 0.3 - FACE.v * h;
  return { x, y, w, h };
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * The birth, in seconds: particles leave a glow low on the chest, fly up into the picture and settle, from the
 * bottom of the frame to the top; the face comes last and ignites, then one soft shockwave runs out from it.
 */
export const BIRTH = {
  /** Where the particles come from (picture units). */
  source: { u: AURA_DATA.axis, v: 0.84 },
  /** The glow swells before the first particle leaves. */
  lead: 0.35,
  /** Flight time of one particle. */
  flight: 1.05,
  /** Bottom-to-top spread of the launches (the body and hair). */
  spread: 1.2,
  /** How much later the sides land than the centre, per picture width. */
  arch: 0.6,
  /** The face's launches, after everything else. */
  faceAt: 1.85,
  faceSpread: 0.3,
  /** A landed particle hands over to the picture in this time. */
  settle: 0.45,
  /** The shockwave. */
  ringAt: 3.25,
  ringTime: 1.0,
  /** All done: from here the frame is the rest frame. */
  total: 4.3,
} as const;

/** When the particle (or picture pixel) at u, v lands. `head` 0..1 is how much of it is face; `jitter` 0..1. */
export function arrival(
  u: number,
  v: number,
  head: number,
  jitter = 0.5,
): number {
  // Bottom to top, the centre a little ahead of the sides: the front rises as a soft arch.
  const body =
    BIRTH.lead +
    BIRTH.spread * (1 - v) * (1 - v * 0.15) +
    BIRTH.arch * Math.abs(u - AURA_DATA.axis) +
    jitter * 0.18;
  const r = Math.hypot((u - FACE.u) * AURA_DATA.aspect, v - FACE.v) / 0.16;
  const face = BIRTH.faceAt + BIRTH.faceSpread * Math.min(1, r) + jitter * 0.08;
  return body + (face - body) * head + BIRTH.flight;
}

/** The same timing in GLSL (keep in step with `arrival`). */
export const ARRIVAL_GLSL = /* glsl */ `
float arrival(vec2 p, float head, float jitter) {
  float body = ${f(BIRTH.lead)} + ${f(BIRTH.spread)} * (1.0 - p.y) * (1.0 - p.y * 0.15)
    + ${f(BIRTH.arch)} * abs(p.x - ${f(AURA_DATA.axis)}) + jitter * 0.18;
  float r = length(vec2((p.x - ${f(FACE.u)}) * ${f(AURA_DATA.aspect)}, p.y - ${f(FACE.v)})) / 0.16;
  float face = ${f(BIRTH.faceAt)} + ${f(BIRTH.faceSpread)} * min(1.0, r) + jitter * 0.08;
  return mix(body, face, head) + ${f(BIRTH.flight)};
}
`;

/** A GLSL float literal. */
export function f(n: number): string {
  const s = String(n);
  return /[.e]/.test(s) ? s : `${s}.0`;
}
