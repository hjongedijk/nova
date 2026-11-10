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
  /** Four 1920x1080 RGB layers in a 2x2 sheet: distance to the nearest light line, place along it, its weight. */
  lines: "/aura/aura-lines.png",
} as const;

/**
 * Measurements of the artwork, in picture units (u across 0..1 left to right, v down 0..1 top to bottom), written
 * by scripts/aura-assets.mjs. Atlas tiles: 0 = form, head, bright; 1 = hair weight, height, figure;
 * 2 = normal x, normal y, across the arm.
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
  [0.4963, 0.608],
  [0.3493, 0.636],
  [0.6463, 0.64],
  [0.4903, 0.77],
  [0.5263, 0.9],
  [0.3933, 0.81],
  [0.5863, 0.72],
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

/**
 * The hair in the wind, in data pixels (the picture is 960 of them wide). `w` is the hair weight from the atlas:
 * 0 at the scalp (roots, parting, crown), rising toward the tips, so the roots stay put and the motion grows
 * smoothly along each strand. Slow sway (about 0.2 Hz) and a slower cross-wave, gusts, and a fine flutter at the
 * tips; mostly sideways, with a little lift. `motion` 0 (reduced motion) is a still rest pose.
 */
export const WIND = {
  /** Largest sideways reach at the tips, data px. */
  reach: 5.5,
  sway: 0.21,
  cross: 0.13,
  flutter: 1.3,
  /** Gusts: one every this many seconds (a range), each this long. */
  gustEvery: [6, 12] as const,
  gustLength: 2.6,
  lift: 1.6,
} as const;

export function hairWind(
  u: number,
  v: number,
  w: number,
  t: number,
  motion: number,
  gust: number,
  lift: number,
): [number, number] {
  if (motion <= 0 || w <= 0) return [0, 0];
  const tau = 2 * Math.PI;
  // A domain warp keeps neighbouring strands in phase but never in lockstep.
  const vw = v + 0.05 * Math.sin(u * 9 + t * 0.4);
  const dx =
    (0.55 + 0.45 * gust) * Math.sin(tau * WIND.sway * t + vw * 3 + u * 2) +
    0.35 * Math.sin(tau * WIND.cross * t + vw * 7 - u * 5 + 1.3) +
    0.16 * w * Math.sin(tau * WIND.flutter * t + vw * 31 + u * 17);
  const dy = -(0.3 * gust + 0.15 * Math.sin(tau * 0.17 * t + u * 6) + lift);
  const k = WIND.reach * w * motion;
  return [dx * k, dy * k * (WIND.lift / WIND.reach)];
}

/** The same in GLSL (keep in step with `hairWind`). */
export const WIND_GLSL = /* glsl */ `
vec2 hairWind(vec2 q, float w, float t, float motion, float gust, float lift) {
  if (motion <= 0.0 || w <= 0.0) return vec2(0.0);
  float tau = 6.28318;
  float vw = q.y + 0.05 * sin(q.x * 9.0 + t * 0.4);
  float dx = (0.55 + 0.45 * gust) * sin(tau * ${f(WIND.sway)} * t + vw * 3.0 + q.x * 2.0)
    + 0.35 * sin(tau * ${f(WIND.cross)} * t + vw * 7.0 - q.x * 5.0 + 1.3)
    + 0.16 * w * sin(tau * ${f(WIND.flutter)} * t + vw * 31.0 + q.x * 17.0);
  float dy = -(0.3 * gust + 0.15 * sin(tau * 0.17 * t + q.x * 6.0) + lift);
  float k = ${f(WIND.reach)} * w * motion;
  return vec2(dx * k, dy * k * ${f(WIND.lift / WIND.reach)});
}
`;

/** Gust strength 0..1 at time t: a soft swell every 6 to 12 s (deterministic). */
export function gustAt(t: number): number {
  let start = 0;
  for (let i = 0; i < 400; i++) {
    const gap =
      WIND.gustEvery[0] +
      (WIND.gustEvery[1] - WIND.gustEvery[0]) *
        (0.5 + 0.5 * Math.sin(i * 12.9898 + 4.1));
    if (t < start + gap) {
      const x = (t - start) / WIND.gustLength;
      return x >= 0 && x <= 1 ? Math.sin(Math.PI * x) ** 2 : 0;
    }
    start += gap;
  }
  return 0;
}

/**
 * The head's own life on top of following the pointer: slow, small turns and tilts from layered sines, and now and
 * then a gentle look aside that returns. Radians; all zero without motion.
 */
export const IDLE = { yaw: 0.08, pitch: 0.04, roll: 0.03, aside: 0.1 } as const;

export function idlePose(
  t: number,
  motion: number,
): { yaw: number; pitch: number; roll: number } {
  if (motion <= 0) return { yaw: 0, pitch: 0, roll: 0 };
  const n = (a: number, b: number, c: number) =>
    Math.sin(t * a) * 0.55 +
    Math.sin(t * b + 1.7) * 0.3 +
    Math.sin(t * c + 4.2) * 0.15;
  // A look aside every 9 to 15 s, held for a couple of seconds, eased in and out.
  const period = 12;
  const cycle = Math.floor(t / period);
  const phase =
    t - cycle * period - 3 - 3 * (0.5 + 0.5 * Math.sin(cycle * 7.3));
  const look =
    phase > 0 && phase < 3.2 ? Math.sin((Math.PI * phase) / 3.2) ** 2 : 0;
  const dir = Math.sin(cycle * 3.7 + 1.1) > 0 ? 1 : -1;
  return {
    yaw:
      motion *
      (IDLE.yaw * n(0.21, 0.37, 0.71) * 0.75 + dir * IDLE.aside * look),
    pitch: motion * IDLE.pitch * n(0.17, 0.43, 0.89),
    roll: motion * IDLE.roll * n(0.13, 0.31, 0.67),
  };
}
