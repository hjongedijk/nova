/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- the frame loop indexes typed arrays in hot loops; noUncheckedIndexedAccess would need `!` on every access.
import type { UiState } from "#lib/stores/chat.svelte.ts";

/**
 * THE PRESENCE. NOVA's orb, re-formed as a head and shoulders.
 *
 * Nothing here is an image. The body is a signed distance field built from a handful of ellipsoids and
 * capsules (cranium, face, brow, nose, chin, neck, shoulders, chest). At start-up it is sliced into horizontal
 * contour rings; each ring starts life as one of the orb's latitudes and slides into its cross-section of the
 * body, head first, shoulders last. Because the geometry is real 3D, a head turn is a rotation, not a warp.
 *
 * Shading is rim light plus one soft key light, so the silhouette reads from across the room while the face
 * stays quiet. Eyes and mouth are light, not anatomy: two slits that blink and drift toward the pointer, and a
 * mouth glow plus jaw drop that follow the voice level. The orb's particles keep flowing along the rings.
 *
 * Units: one unit is the presence radius `rb` in CSS pixels. y points up, +z points at the viewer.
 */

const TAU = Math.PI * 2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}
/** On-screen morphs ease in and out; enter/exit timing comes from the per-ring stagger. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/* ---------------------------------------------------------------------------------------------------------
 * The body field
 * ------------------------------------------------------------------------------------------------------- */

function ellipsoid(
  x: number,
  y: number,
  z: number,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
): number {
  const px = (x - cx) / rx;
  const py = (y - cy) / ry;
  const pz = (z - cz) / rz;
  const k0 = Math.hypot(px, py, pz);
  const k1 = Math.hypot(px / rx, py / ry, pz / rz);
  return k1 < 1e-9 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}
function capsule(
  x: number,
  y: number,
  z: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r: number,
): number {
  const pax = x - ax;
  const pay = y - ay;
  const paz = z - az;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const h = clamp01(
    (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz),
  );
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/** Signed distance to the stylised bust: negative inside. Symmetric in x. */
export function bodyField(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  let d = ellipsoid(x, y, z, 0, 0.3, -0.1, 0.78, 0.88, 0.9); // cranium
  d = smin(d, ellipsoid(x, y, z, 0, -0.28, 0.12, 0.6, 0.72, 0.72), 0.36); // face mass
  d = smin(d, ellipsoid(ax, y, z, 0.38, -0.22, 0.4, 0.24, 0.2, 0.24), 0.24); // cheekbones
  d = smin(d, ellipsoid(x, y, z, 0, -0.84, 0.36, 0.28, 0.2, 0.26), 0.26); // chin
  d = smin(d, capsule(x, y, z, 0, 0.02, 0.72, 0, -0.3, 0.88, 0.07), 0.14); // nose
  d = smin(d, capsule(ax, y, z, 0.05, 0.16, 0.7, 0.42, 0.14, 0.58, 0.08), 0.12); // brow
  d = smax(d, -ellipsoid(ax, y, z, 0.29, -0.03, 0.8, 0.16, 0.1, 0.13), 0.08); // eye sockets
  d = smax(
    d,
    -capsule(x, y, z, -0.19, -0.55, 0.86, 0.19, -0.55, 0.86, 0.022),
    0.05,
  ); // mouth line
  d = smin(d, ellipsoid(ax, y, z, 0.76, -0.16, -0.08, 0.1, 0.24, 0.16), 0.1); // ears
  d = smin(d, capsule(x, y, z, 0, -0.55, -0.14, 0, -1.75, -0.1, 0.36), 0.28); // neck
  d = smin(d, capsule(ax, y, z, 0, -1.5, -0.16, 1.36, -2.32, -0.14, 0.3), 0.55); // trapezius
  d = smin(d, ellipsoid(ax, y, z, 1.46, -2.55, -0.1, 0.44, 0.56, 0.44), 0.4); // shoulder caps
  d = smin(d, capsule(ax, y, z, 1.6, -2.7, -0.1, 1.62, -3.8, -0.12, 0.4), 0.3); // upper arms
  d = smin(d, ellipsoid(x, y, z, 0, -3.35, -0.02, 1.42, 1.35, 0.72), 0.5); // chest
  return d;
}

/* ---------------------------------------------------------------------------------------------------------
 * Geometry: contour rings sampled once
 * ------------------------------------------------------------------------------------------------------- */

const TOP = 1.2;
const NECK = -0.95;
const BOTTOM = -3.3;
/** Rotation pivot of the head: the top of the neck. */
const PIVOT = [0, -0.62, -0.12] as const;

export interface PresenceGeometry {
  /** Rings and samples per ring. Point (k, j) is at index k * angles + j. */
  rings: number;
  angles: number;
  /** Body positions and normals. */
  bx: Float32Array;
  by: Float32Array;
  bz: Float32Array;
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
  /** The same ring as one of the orb's latitudes, already seen through the orb's camera (unit radius). */
  ox: Float32Array;
  oy: Float32Array;
  of: Float32Array;
  /** Per point: 1 for the head (turns with the gaze), 0 for the torso. Jaw weight for the speaking mouth. */
  head: Float32Array;
  jaw: Float32Array;
  /** Per ring: height and emergence delay (head first). */
  ringY: Float32Array;
  delay: Float32Array;
  /** Relative ring length, for spreading particles evenly over the surface. */
  ringLength: Float32Array;
}

/** Ring heights: finer on the head, where the features are, wider on the shoulders. */
function ringHeights(headStep: number, bodyStep: number): number[] {
  const ys: number[] = [];
  for (let y = TOP - headStep * 0.5; y > NECK; y -= headStep) ys.push(y);
  for (let y = NECK; y > BOTTOM; y -= bodyStep) ys.push(y);
  return ys;
}

/** Where the ray from the body's axis at height y, in direction theta, leaves the surface. */
function surfaceRadius(y: number, theta: number, oz: number): number {
  const dx = Math.sin(theta);
  const dz = Math.cos(theta);
  if (bodyField(0, y, oz) > 0) return 0;
  let lo = 0;
  let hi = 0;
  for (let r = 0.02; r < 3.2; r += 0.02) {
    if (bodyField(dx * r, y, oz + dz * r) > 0) {
      hi = r;
      break;
    }
    lo = r;
  }
  if (hi === 0) return lo;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (bodyField(dx * mid, y, oz + dz * mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export function buildPresence(
  quality: "full" | "fine" | "compact",
): PresenceGeometry {
  const ys =
    quality === "compact"
      ? ringHeights(0.14, 0.22)
      : quality === "fine"
        ? ringHeights(0.062, 0.08)
        : ringHeights(0.074, 0.095);
  const angles = quality === "compact" ? 44 : quality === "fine" ? 160 : 112;
  const rings = ys.length;
  const n = rings * angles;
  const g: PresenceGeometry = {
    rings,
    angles,
    bx: new Float32Array(n),
    by: new Float32Array(n),
    bz: new Float32Array(n),
    nx: new Float32Array(n),
    ny: new Float32Array(n),
    nz: new Float32Array(n),
    ox: new Float32Array(n),
    oy: new Float32Array(n),
    of: new Float32Array(n),
    head: new Float32Array(n),
    jaw: new Float32Array(n),
    ringY: new Float32Array(rings),
    delay: new Float32Array(rings),
    ringLength: new Float32Array(rings),
  };
  const e = 0.004;
  const orbTilt = 0.25;
  const cT = Math.cos(orbTilt);
  const sT = Math.sin(orbTilt);
  for (let k = 0; k < rings; k++) {
    const y = ys[k]!;
    g.ringY[k] = y;
    g.delay[k] = 0.42 * Math.pow(k / Math.max(1, rings - 1), 0.85);
    // The axis sits a little back on the neck and torso, so every cross-section is star-shaped from it.
    const oz = y > NECK ? 0 : -0.1;
    // The orb latitude this ring starts from: top ring near the north pole, last ring near the south pole.
    const phi = Math.PI * (0.06 + 0.88 * (k / Math.max(1, rings - 1)));
    const sy = Math.cos(phi);
    const sr = Math.sin(phi);
    let length = 0;
    let px = 0;
    let pz = 0;
    for (let j = 0; j < angles; j++) {
      const i = k * angles + j;
      const theta = (j / angles) * TAU;
      const r = surfaceRadius(y, theta, oz);
      const x = Math.sin(theta) * r;
      const z = oz + Math.cos(theta) * r;
      g.bx[i] = x;
      g.by[i] = y;
      g.bz[i] = z;
      const gx = bodyField(x + e, y, z) - bodyField(x - e, y, z);
      const gy = bodyField(x, y + e, z) - bodyField(x, y - e, z);
      const gz = bodyField(x, y, z + e) - bodyField(x, y, z - e);
      const gl = Math.hypot(gx, gy, gz) || 1;
      g.nx[i] = gx / gl;
      g.ny[i] = gy / gl;
      g.nz[i] = gz / gl;
      g.head[i] = smoothstep(-1.55, -0.8, y);
      g.jaw[i] =
        smoothstep(-0.5, -0.66, y) *
        smoothstep(-1.28, -1.02, y) *
        smoothstep(0.05, 0.38, z) *
        (1 - smoothstep(0.3, 0.6, Math.abs(x)));
      // Orb latitude, seen through the orb's own tilt (y up here, so the sign flips relative to entity.ts).
      const ox = Math.sin(theta) * sr;
      const oz2 = Math.cos(theta) * sr;
      g.ox[i] = ox;
      g.oy[i] = sy * cT - oz2 * sT;
      g.of[i] = sy * sT + oz2 * cT;
      if (j > 0) length += Math.hypot(x - px, z - pz);
      px = x;
      pz = z;
    }
    g.ringLength[k] = length;
  }
  return g;
}

/* ---------------------------------------------------------------------------------------------------------
 * The living part
 * ------------------------------------------------------------------------------------------------------- */

export interface PresenceFrame {
  t: number;
  dt: number;
  /** 0 = orb, 1 = presence. Moves linearly; the per-ring stagger and easing shape it. */
  form: number;
  state: UiState;
  /** Look of the entity right now (eased between states). */
  h: number;
  s: number;
  l: number;
  glow: number;
  /** Alert tint active (confirmation or warning waiting). */
  alert: boolean;
  /** Smoothed voice level 0..1, and the raw analyser bands while speaking. */
  audio: number;
  bands: Uint8Array | null;
  /** Smoothed pointer, -1..1. */
  gazeX: number;
  gazeY: number;
  /** Orb centre and radius, where the rings come from. */
  ocx: number;
  ocy: number;
  orbR: number;
  /** Body origin and unit, in CSS pixels. */
  cx: number;
  cy: number;
  rb: number;
  /** Fade everything below this screen y (the reply stage). */
  floor: number;
  /** 0..1 overall brightness (birth, helper dimming). */
  dim: number;
  reduceMotion: boolean;
}

export interface Presence {
  readonly geometry: PresenceGeometry;
  /** Transform the rings for this frame. Call once per frame before the other methods. */
  update(f: PresenceFrame): void;
  /** Draw the contour rings (additive). */
  drawRings(g: CanvasRenderingContext2D, f: PresenceFrame): void;
  /** Pull the orb's particles onto the rings, mixing with their orb positions per ring. */
  placeParticles(
    sx: Float32Array,
    sy: Float32Array,
    sz: Float32Array,
    vis: Float32Array,
    count: number,
    f: PresenceFrame,
  ): void;
  /** Eyes and mouth: light, drawn last. */
  drawLights(g: CanvasRenderingContext2D, f: PresenceFrame): void;
  /** The head's centre on screen (the nucleus moves there). */
  headX: number;
  headY: number;
}

const LEVELS = 8;
/** Per-state brightness behaviour of the rings, blended so state changes never snap. */
const STATE_KEYS: UiState[] = [
  "ready",
  "listening",
  "thinking",
  "executing",
  "speaking",
];

export function createPresence(
  quality: "full" | "fine" | "compact",
  particles: number,
  seed: Float32Array,
): Presence {
  const geo = buildPresence(quality);
  const { rings, angles } = geo;
  const n = rings * angles;
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  const alpha = new Float32Array(n);
  const facing = new Float32Array(n);
  const ringMix = new Float32Array(rings);
  const ringGain = new Float32Array(rings);

  // Particles ride the rings: ring and position chosen once, weighted by ring length so the surface fills
  // evenly; each drifts along its ring at its own speed, half of them against the current.
  const pRing = new Uint16Array(particles);
  const pNext = new Uint16Array(particles);
  const pBlend = new Float32Array(particles);
  const pPos = new Float32Array(particles);
  const pSpeed = new Float32Array(particles);
  {
    const total = geo.ringLength.reduce((a, b) => a + b, 0);
    for (let p = 0; p < particles; p++) {
      let pick = ((p * 0.6180339887 + seed[p] * 0.37) % 1) * total;
      let k = 0;
      while (k < rings - 1 && pick > geo.ringLength[k]) {
        pick -= geo.ringLength[k];
        k++;
      }
      pRing[p] = k;
      pNext[p] = Math.min(rings - 1, k + 1);
      // Stay close to the own ring: between a narrow neck ring and a wide shoulder ring there is only air.
      pBlend[p] = ((seed[p] * 7.31) % 1) * 0.35;
      pPos[p] = ((seed[p] * 13.7 + p * 0.37) % 1) * angles;
      pSpeed[p] = (0.35 + 0.65 * ((seed[p] * 29.3) % 1)) * (p % 2 ? 1 : -0.6);
    }
  }

  const weight: Record<UiState, number> = {
    ready: 1,
    listening: 0,
    thinking: 0,
    executing: 0,
    speaking: 0,
  };
  // Head pose on critically damped smoothing: it follows, it never snaps or overshoots.
  let yaw = 0;
  let pitch = 0;
  let roll = 0;
  let open = 0;
  let blinkAt = 3;
  let blinkStart = -1;
  let flow = 0;
  let scan = 0;
  const Mh = new Float32Array(9);
  const Mt = new Float32Array(9);
  const pivot = new Float32Array(3);

  function rotation(
    out: Float32Array,
    yawA: number,
    pitchA: number,
    rollA: number,
    tilt: number,
  ) {
    // out = Tilt(camera) * Rz(roll) * Rx(pitch) * Ry(yaw)
    const cy = Math.cos(yawA);
    const sy = Math.sin(yawA);
    const cp = Math.cos(pitchA);
    const sp = Math.sin(pitchA);
    const cr = Math.cos(rollA);
    const sr = Math.sin(rollA);
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    // Ry
    const a = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
    // Rx (positive pitch = nod down: the front moves down)
    const b = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
    // Rz
    const c = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
    const d = [1, 0, 0, 0, ct, -st, 0, st, ct];
    const mul = (m: number[], q: number[]) => [
      m[0] * q[0] + m[1] * q[3] + m[2] * q[6],
      m[0] * q[1] + m[1] * q[4] + m[2] * q[7],
      m[0] * q[2] + m[1] * q[5] + m[2] * q[8],
      m[3] * q[0] + m[4] * q[3] + m[5] * q[6],
      m[3] * q[1] + m[4] * q[4] + m[5] * q[7],
      m[3] * q[2] + m[4] * q[5] + m[5] * q[8],
      m[6] * q[0] + m[7] * q[3] + m[8] * q[6],
      m[6] * q[1] + m[7] * q[4] + m[8] * q[7],
      m[6] * q[2] + m[7] * q[5] + m[8] * q[8],
    ];
    const m = mul(d, mul(c, mul(b, a)));
    for (let i = 0; i < 9; i++) out[i] = m[i];
  }

  const self: Presence = {
    geometry: geo,
    headX: 0,
    headY: 0,
    update(f) {
      const { t, dt } = f;
      const motion = f.reduceMotion ? 0 : 1;
      // State weights ease over ~0.4 s, like the entity's colour.
      const kw = 1 - Math.exp(-dt * 3);
      for (const key of STATE_KEYS)
        weight[key] += ((key === f.state ? 1 : 0) - weight[key]) * kw;

      // Pose: pointer gaze, a slow idle drift, and what each state asks for.
      const yawT =
        motion *
        (f.gazeX * 0.3 +
          0.05 * Math.sin(t * 0.21) +
          weight.thinking * 0.2 -
          weight.executing * 0.06);
      const pitchT =
        motion *
        (f.gazeY * 0.12 -
          weight.thinking * 0.1 +
          weight.listening * 0.07 +
          weight.speaking * 0.035 * f.audio * Math.sin(t * 2.3));
      const rollT =
        motion * (weight.listening * 0.06 - weight.thinking * 0.035);
      const kp = 1 - Math.exp(-dt * 2.4);
      yaw += (yawT - yaw) * kp;
      pitch += (pitchT - pitch) * kp;
      roll += (rollT - roll) * kp;
      const breath = motion * Math.sin(t * 0.9);
      const openT = f.state === "speaking" ? clamp01(f.audio * 1.7 - 0.05) : 0;
      open += (openT - open) * (1 - Math.exp(-dt * 16));

      // Ring brightness: a slow scan while ready, a rising wave while thinking, a fast sweep while executing,
      // an attentive head while listening, and the voice travelling ring by ring away from the mouth.
      flow +=
        dt *
        motion *
        (0.05 * weight.ready +
          0.03 * weight.listening +
          0.32 * weight.thinking +
          0.5 * weight.executing +
          0.12 * weight.speaking);
      scan += dt * (0.13 + 0.5 * weight.executing);
      // One sweep from crown to chest, then a short rest before the next.
      const scanY = TOP - (scan % 1.35) * (TOP - BOTTOM);
      for (let k = 0; k < rings; k++) {
        const y = geo.ringY[k];
        const bump = Math.exp(-((y - scanY) * (y - scanY)) / 0.05);
        let gain =
          bump * (0.35 * weight.ready + 0.9 * weight.executing) +
          weight.thinking *
            0.55 *
            Math.pow(
              Math.max(0, Math.sin(y * 3.2 + t * 2.6 * (motion || 0.3))),
              6,
            ) +
          weight.listening *
            (0.18 + 0.12 * Math.sin(t * 2.2) * motion) *
            smoothstep(-1.6, -0.6, y);
        if (weight.speaking > 0.01) {
          const dist = Math.abs(y + 0.58);
          if (f.bands && f.bands.length) {
            const bi = Math.min(
              f.bands.length - 1,
              Math.floor(clamp01(dist / 2.6) * f.bands.length * 0.6),
            );
            gain += weight.speaking * (f.bands[bi] / 255) * 0.9;
          } else {
            gain +=
              weight.speaking *
              f.audio *
              0.8 *
              (0.5 + 0.5 * Math.sin(dist * 6 - t * 9 * (motion || 0.3)));
          }
        }
        ringGain[k] = gain;
        const local = (f.form - geo.delay[k]) / 0.58;
        ringMix[k] = f.reduceMotion
          ? f.form > 0
            ? 1
            : 0
          : easeInOut(clamp01(local));
      }

      // Blink: rare and quick.
      if (t > blinkAt) {
        blinkStart = t;
        blinkAt = t + 3 + Math.random() * 4.5;
      }

      // Seen from a little above, so every ring opens into an ellipse and the face planes show.
      const tilt = 0.27;
      rotation(Mh, yaw, pitch, roll, tilt);
      rotation(Mt, yaw * 0.22, pitch * 0.12, 0, tilt);
      // The head turns about the top of the neck: p' = Mh (p - pivot) + Mt pivot.
      for (let r = 0; r < 3; r++)
        pivot[r] =
          Mt[r * 3] * PIVOT[0] +
          Mt[r * 3 + 1] * PIVOT[1] +
          Mt[r * 3 + 2] * PIVOT[2];

      const { cx, cy, rb, ocx, ocy, orbR } = f;
      // Key light from above, slightly left and in front.
      const lx = -0.3;
      const ly = 0.5;
      const lz = 0.81;
      for (let k = 0; k < rings; k++) {
        const mix = ringMix[k];
        const gain = ringGain[k];
        const base = k * angles;
        for (let j = 0; j < angles; j++) {
          const i = base + j;
          const hw = geo.head[i];
          const X = geo.bx[i];
          const Y =
            geo.by[i] +
            breath * (0.022 * (1 - hw) + 0.012 * hw) -
            open * 0.13 * geo.jaw[i];
          const Z = geo.bz[i];
          // Head and torso transforms, blended across the neck.
          const hx = X - PIVOT[0];
          const hy = Y - PIVOT[1];
          const hz = Z - PIVOT[2];
          const ax = Mh[0] * hx + Mh[1] * hy + Mh[2] * hz + pivot[0];
          const ay = Mh[3] * hx + Mh[4] * hy + Mh[5] * hz + pivot[1];
          const az = Mh[6] * hx + Mh[7] * hy + Mh[8] * hz + pivot[2];
          const tx = Mt[0] * X + Mt[1] * Y + Mt[2] * Z;
          const ty = Mt[3] * X + Mt[4] * Y + Mt[5] * Z;
          const tz = Mt[6] * X + Mt[7] * Y + Mt[8] * Z;
          const px = tx + (ax - tx) * hw;
          const py = ty + (ay - ty) * hw;
          const pz = tz + (az - tz) * hw;
          const NX = geo.nx[i];
          const NY = geo.ny[i];
          const NZ = geo.nz[i];
          const nhx = Mh[0] * NX + Mh[1] * NY + Mh[2] * NZ;
          const nhy = Mh[3] * NX + Mh[4] * NY + Mh[5] * NZ;
          const nhz = Mh[6] * NX + Mh[7] * NY + Mh[8] * NZ;
          const ntx = Mt[0] * NX + Mt[1] * NY + Mt[2] * NZ;
          const nty = Mt[3] * NX + Mt[4] * NY + Mt[5] * NZ;
          const ntz = Mt[6] * NX + Mt[7] * NY + Mt[8] * NZ;
          const fx = ntx + (nhx - ntx) * hw;
          const fy = nty + (nhy - nty) * hw;
          const fz = ntz + (nhz - ntz) * hw;

          const persp = 1 / (1 - pz * 0.06);
          const bsx = cx + px * rb * persp;
          const bsy = cy - py * rb * persp;
          // Orb latitude position for the same sample.
          const osx = ocx + geo.ox[i] * orbR;
          const osy = ocy - geo.oy[i] * orbR;
          sx[i] = osx + (bsx - osx) * mix;
          sy[i] = osy + (bsy - osy) * mix;

          // Rim light makes the silhouette; the key light from upper left gives the face its planes.
          const face = geo.of[i] + (fz - geo.of[i]) * mix;
          facing[i] = face;
          const rim = 1 - Math.abs(face);
          const lam = Math.max(0, fx * lx + fy * ly + fz * lz);
          const vis = 0.07 + 0.93 * smoothstep(-0.22, 0.18, face);
          let a =
            vis *
            (0.1 + 0.55 * rim * rim + 0.5 * lam * lam * mix + gain) *
            smoothstep(0, 0.45, mix);
          // Shoulders dissolve into the dark, and stay clear of the reply.
          a *= smoothstep(BOTTOM, -2.45, Y);
          if (bsy > f.floor - rb * 0.9)
            a *= clamp01((f.floor - bsy) / (rb * 0.9));
          alpha[i] = a * f.dim;
        }
      }
      // Head centre (for the nucleus) and the pose for the lights.
      const hcx = 0 - PIVOT[0];
      const hcy = 0.12 - PIVOT[1];
      const hcz = 0 - PIVOT[2];
      self.headX =
        cx + (Mh[0] * hcx + Mh[1] * hcy + Mh[2] * hcz + pivot[0]) * rb;
      self.headY =
        cy - (Mh[3] * hcx + Mh[4] * hcy + Mh[5] * hcz + pivot[1]) * rb;
    },

    drawRings(g, f) {
      if (f.form <= 0.001) return;
      const lw = Math.max(0.7, Math.min(2.4, f.rb / 150));
      const paths: Path2D[] = [];
      for (let q = 0; q < LEVELS; q++) paths.push(new Path2D());
      for (let k = 0; k < rings; k++) {
        const base = k * angles;
        for (let j = 0; j < angles; j++) {
          const i = base + j;
          const i2 = base + (j + 1 === angles ? 0 : j + 1);
          const a = (alpha[i] + alpha[i2]) * 0.5;
          if (a < 0.03) continue;
          const q = Math.min(LEVELS - 1, Math.floor(a * LEVELS));
          const p = paths[q];
          p.moveTo(sx[i], sy[i]);
          p.lineTo(sx[i2], sy[i2]);
        }
      }
      const { h, s, l } = f;
      g.lineCap = "round";
      // A soft wide pass under the brightest rings: the light bleeds a little, like glass catching it.
      g.lineWidth = lw * 3.2;
      for (let q = LEVELS - 3; q < LEVELS; q++) {
        g.strokeStyle = `hsla(${h},${s}%,${l}%,${0.07 * (q / LEVELS) * f.dim})`;
        g.stroke(paths[q]);
      }
      g.lineWidth = lw;
      for (let q = 0; q < LEVELS; q++) {
        const level = (q + 0.5) / LEVELS;
        g.strokeStyle = `hsla(${h},${s}%,${Math.min(95, l - 6 + level * 22)}%,${Math.min(1, level * 1.05)})`;
        g.stroke(paths[q]);
      }
      g.lineCap = "butt";
    },

    placeParticles(px, py, pz, vis, count, f) {
      if (f.form <= 0.001) return;
      const step = flow;
      for (let p = 0; p < count; p++) {
        const k = pRing[p];
        const k2 = pNext[p];
        const mix = ringMix[k];
        if (mix <= 0) continue;
        let u = (pPos[p] + step * pSpeed[p] * angles) % angles;
        if (u < 0) u += angles;
        const j = Math.floor(u);
        const fr = u - j;
        const j2 = j + 1 === angles ? 0 : j + 1;
        const b = pBlend[p];
        const i1 = k * angles + j;
        const i2 = k * angles + j2;
        const i3 = k2 * angles + j;
        const i4 = k2 * angles + j2;
        const x =
          (sx[i1] + (sx[i2] - sx[i1]) * fr) * (1 - b) +
          (sx[i3] + (sx[i4] - sx[i3]) * fr) * b;
        const y =
          (sy[i1] + (sy[i2] - sy[i1]) * fr) * (1 - b) +
          (sy[i3] + (sy[i4] - sy[i3]) * fr) * b;
        const fc = facing[i1] * (1 - b) + facing[i3] * b;
        const al = alpha[i1] * (1 - b) + alpha[i3] * b;
        px[p] += (x - px[p]) * mix;
        py[p] += (y - py[p]) * mix;
        pz[p] += (fc - pz[p]) * mix;
        // Particles behind the head go quiet; the rest keep the rings' light.
        vis[p] = 1 + (Math.min(1, al * 1.6 + 0.05) - 1) * mix;
      }
    },

    drawLights(g, f) {
      if (f.form <= 0.001) return;
      const ready = clamp01((f.form - 0.62) / 0.38) * f.dim;
      if (ready <= 0) return;
      const { h, s, rb } = f;
      // Eyes: slits of light set in the sockets, brighter while listening, a soft pulse while thinking.
      const blinkPhase = (f.t - blinkStart) / 0.16;
      const blink =
        !f.reduceMotion && blinkPhase >= 0 && blinkPhase <= 1
          ? Math.sin(blinkPhase * Math.PI)
          : 0;
      const eyeLight =
        0.8 +
        0.4 * weight.listening +
        0.15 * weight.speaking +
        0.2 * weight.executing +
        weight.thinking * (0.15 + 0.15 * Math.sin(f.t * 3));
      const look = f.reduceMotion ? 0 : 1;
      for (const side of [-1, 1]) {
        const ex = side * 0.29 + f.gazeX * 0.035 * look;
        const ey = -0.04 - f.gazeY * 0.02 * look;
        const ez = 0.74;
        const hx = ex - PIVOT[0];
        const hy = ey - PIVOT[1];
        const hz = ez - PIVOT[2];
        const x = f.cx + (Mh[0] * hx + Mh[1] * hy + Mh[2] * hz + pivot[0]) * rb;
        const y = f.cy - (Mh[3] * hx + Mh[4] * hy + Mh[5] * hz + pivot[1]) * rb;
        const z = Mh[6] * hx + Mh[7] * hy + Mh[8] * hz + pivot[2];
        // The far eye fades as the head turns away from it.
        const seen = smoothstep(0.25, 0.6, z);
        const a = eyeLight * seen * ready;
        if (a < 0.01) continue;
        const w = rb * 0.16 * (1 - 0.25 * Math.abs(yaw));
        const hgt = rb * 0.055 * (1 - 0.9 * blink);
        g.save();
        g.translate(x, y);
        g.rotate(roll);
        g.scale(w, Math.max(0.5, hgt));
        const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
        grad.addColorStop(0, `hsla(${h},${Math.max(25, s - 45)}%,97%,${a})`);
        grad.addColorStop(0.35, `hsla(${h},${s}%,80%,${a * 0.55})`);
        grad.addColorStop(1, `hsla(${h},${s}%,70%,0)`);
        g.fillStyle = grad;
        g.beginPath();
        g.arc(0, 0, 1, 0, TAU);
        g.fill();
        g.restore();
      }
      // Mouth: a line of light that opens with the voice.
      const mo = Math.max(open, 0.05);
      const mx = 0 - PIVOT[0];
      const my = -0.57 - open * 0.06 - PIVOT[1];
      const mz = 0.86 - PIVOT[2];
      const x = f.cx + (Mh[0] * mx + Mh[1] * my + Mh[2] * mz + pivot[0]) * rb;
      const y = f.cy - (Mh[3] * mx + Mh[4] * my + Mh[5] * mz + pivot[1]) * rb;
      const z = Mh[6] * mx + Mh[7] * my + Mh[8] * mz + pivot[2];
      const a = (0.18 + 0.82 * open) * ready * smoothstep(0.3, 0.7, z);
      if (a > 0.01) {
        g.save();
        g.translate(x, y);
        g.rotate(roll);
        g.scale(rb * (0.17 + 0.05 * open), Math.max(0.5, rb * 0.09 * mo));
        const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
        grad.addColorStop(0, `hsla(${h},${Math.max(25, s - 35)}%,92%,${a})`);
        grad.addColorStop(1, `hsla(${h},${s}%,70%,0)`);
        g.fillStyle = grad;
        g.beginPath();
        g.arc(0, 0, 1, 0, TAU);
        g.fill();
        g.restore();
      }
    },
  };
  return self;
}
