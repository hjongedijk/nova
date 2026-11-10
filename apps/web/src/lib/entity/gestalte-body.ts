/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- build loops index typed arrays heavily; noUncheckedIndexedAccess would need `!` on every access.

/**
 * GESTALTE, the body. A featureless head-and-shoulders as a signed distance field, meshed once into a
 * surface that the GPU shades with contour lines (gestalte.ts). Nothing here is an image or a scan: an egg of a
 * head and slight ears on a bust built like one: tapered neck, trapezius, collarbones and notch, pectorals over a
 * rib cage, rounded deltoids and the upper arms falling away, all ellipsoids and capsules blended smoothly.
 *
 * Units: the head is about two units tall (crown +1.18, chin -0.86). y up, +z toward the viewer.
 * The mesh is sliced in horizontal rings, so each ring can start life as one of the orb's latitudes.
 */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function ellipsoid(x, y, z, cx, cy, cz, rx, ry, rz): number {
  const px = (x - cx) / rx;
  const py = (y - cy) / ry;
  const pz = (z - cz) / rz;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  const qx = px / rx;
  const qy = py / ry;
  const qz = pz / rz;
  const k1 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  return k1 < 1e-9 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}
function capsule(x, y, z, ax, ay, az, bx, by, bz, r): number {
  const pax = x - ax;
  const pay = y - ay;
  const paz = z - az;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const h = clamp01(
    (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz),
  );
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  const dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export const CROWN = 1.18;
export const CHIN = -0.86;
/** Lowest ring: below the bottom of the screen at every aspect the camera allows. */
export const BASE = -4;
/** Pivot of the head turn: the top of the neck. */
export const PIVOT: readonly [number, number, number] = [0, -0.62, -0.1];
/** Centre of the warm core, in the middle of the face. */
export const CORE: readonly [number, number, number] = [0, -0.2, 0.3];

/** Signed distance to the figure: negative inside. Symmetric in x. */
export function gestalteField(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  // Primitives only blend within their smoothing radius, so far-away parts are skipped (same field, cheaper).
  let d = 1e9;
  if (y > -1.5) {
    // Head, built like a sculptor's planes of the head: a cranium over a narrower face, then the hard forms
    // that let contour lines read as a face without drawing one: a brow ridge over shallow sockets, a nose
    // bridge, cheekbones (the widest point of the front of the face), the angle of the jaw and a chin block.
    d = ellipsoid(x, y, z, 0, 0.3, -0.06, 0.7, 0.88, 0.8);
    d = smin(d, ellipsoid(x, y, z, 0, -0.24, 0.1, 0.55, 0.66, 0.64), 0.42);
    d = smin(d, ellipsoid(x, y, z, 0, -0.67, 0.28, 0.25, 0.19, 0.23), 0.26);
    if (y > -1.25 && z > -0.45) {
      // Brow ridge: a soft bar across the forehead, lowest at the temples.
      d = smin(d, capsule(ax, y, z, 0, 0.13, 0.7, 0.34, 0.1, 0.56, 0.06), 0.16);
      // Sockets: shallow hollows under the brow (a smooth subtraction).
      const s = ellipsoid(ax, y, z, 0.23, 0.0, 0.71, 0.16, 0.09, 0.08);
      const k = 0.16;
      const h = Math.max(k - Math.abs(-s - d), 0) / k;
      d = Math.max(d, -s) + h * h * k * 0.25;
      // Nose: a narrow bridge from between the brows to a soft tip.
      d = smin(d, capsule(x, y, z, 0, 0.05, 0.7, 0, -0.25, 0.77, 0.045), 0.12);
      d = smin(d, ellipsoid(x, y, z, 0, -0.27, 0.74, 0.08, 0.06, 0.07), 0.08);
      // Cheekbones.
      d = smin(d, ellipsoid(ax, y, z, 0.35, -0.18, 0.5, 0.17, 0.1, 0.14), 0.16);
      // Jaw: from under the ear to the chin, squared off at the angle.
      d = smin(
        d,
        capsule(ax, y, z, 0.46, -0.5, -0.02, 0.2, -0.78, 0.3, 0.09),
        0.2,
      );
    }
    d = smin(d, ellipsoid(ax, y, z, 0.68, -0.08, -0.08, 0.09, 0.2, 0.13), 0.09);
  }
  if (y > 0.2) return d;
  // Neck: a slightly tapered column, a touch deeper than wide, leaning forward as it rises, with the two
  // sternocleidomastoids running from behind the ears down to the sternal notch.
  d = smin(d, capsule(x, y, z, 0, -0.5, -0.14, 0, -1.25, -0.1, 0.35), 0.24);
  d = smin(d, capsule(x, y, z, 0, -0.95, -0.12, 0, -1.5, -0.12, 0.39), 0.2);
  if (y < -0.3)
    d = smin(
      d,
      capsule(ax, y, z, 0.36, -0.52, -0.1, 0.09, -1.5, 0.22, 0.085),
      0.14,
    );
  if (y > -0.75) return d;
  // Trapezius: from the side of the neck down to the point of the shoulder, about 27 degrees.
  d = smin(
    d,
    capsule(ax, y, z, 0.18, -1.02, -0.22, 1.16, -1.62, -0.14, 0.2),
    0.34,
  );
  // Upper chest and rib cage: a broad barrel under the collarbones, narrowing toward the waist.
  d = smin(d, ellipsoid(x, y, z, 0, -1.98, -0.12, 1.05, 0.5, 0.5), 0.3);
  d = smin(d, ellipsoid(x, y, z, 0, -2.75, -0.1, 0.98, 1.2, 0.6), 0.4);
  // Below the ribs the trunk narrows toward the waist (only tall, narrow screens see this far down).
  if (y < -2.6)
    d = smin(d, capsule(x, y, z, 0, -3.1, -0.1, 0, -4.6, -0.1, 0.8), 0.4);
  // Pectorals: two soft plates over the ribs, slightly apart at the sternum. The sternal notch is the hollow
  // left between the two sternocleidomastoid heads and the inner ends of the collarbones.
  d = smin(d, ellipsoid(ax, y, z, 0.47, -2.14, 0.2, 0.5, 0.34, 0.28), 0.24);
  // Collarbones: a thin ridge from the notch, rising a little toward the shoulder.
  d = smin(
    d,
    capsule(ax, y, z, 0.12, -1.56, 0.25, 1.12, -1.5, -0.02, 0.055),
    0.1,
  );
  // Deltoid caps and the start of the upper arms, falling straight down past the bottom of the screen.
  if (ax > 0.6) {
    d = smin(d, ellipsoid(ax, y, z, 1.32, -1.9, 0.0, 0.34, 0.45, 0.38), 0.2);
    d = smin(
      d,
      capsule(ax, y, z, 1.32, -1.95, -0.02, 1.38, -3.9, -0.04, 0.26),
      0.45,
    );
  }
  return d;
}

export interface GestalteGeometry {
  rings: number;
  angles: number;
  /** Rest-pose positions and normals, xyz per vertex. */
  position: Float32Array;
  normal: Float32Array;
  /** The same vertex on the orb: a unit-sphere direction (the ring's latitude, the sample's longitude). */
  orb: Float32Array;
  /** Per vertex: emergence delay (crown first) and head weight (1 turns with the gaze, 0 is torso). */
  delay: Float32Array;
  head: Float32Array;
  index: Uint32Array;
  /** Silhouette points that shed sparks: position, normal, head weight. */
  sparkBase: Float32Array;
  sparkNormal: Float32Array;
  sparkHead: Float32Array;
}

/** Ring heights: fine on the head, finer over the shoulder girdle (its tops are nearly flat), wider below. */
export function gestalteRings(headStep: number, bodyStep: number): number[] {
  const ys: number[] = [];
  for (let y = CROWN + 0.004; y > -0.9; y -= headStep) ys.push(y);
  for (let y = -0.9; y > -2.1; y -= headStep * 0.6) ys.push(y);
  for (let y = -2.1; y > BASE; y -= bodyStep) ys.push(y);
  return ys;
}

/** Head weight: the head turns, the torso barely does; blended along the neck. */
export function headWeight(y: number): number {
  return smoothstep(-1.45, -0.75, y);
}

/**
 * Where the ray from the body axis at height y leaves the surface. The torso is wide and shallow, so its rays
 * are spread by an ellipse (aspect `a`): samples land evenly along the shoulders instead of bunching at the front.
 */
function surface(
  y: number,
  theta: number,
  oz: number,
  a: number,
  guess: number,
): number {
  let dx = Math.sin(theta) * a;
  let dz = Math.cos(theta);
  const len = Math.hypot(dx, dz);
  dx /= len;
  dz /= len;
  const inside = (r: number) => gestalteField(dx * r, y, oz + dz * r) <= 0;
  if (!inside(0)) return 0;
  // Neighbouring samples are close: bracket the crossing from the previous radius, then bisect.
  const step = 0.03;
  let lo: number;
  let hi: number;
  if (guess > 0 && inside(guess)) {
    lo = guess;
    hi = guess + step;
    while (hi < 4.4 && inside(hi)) {
      lo = hi;
      hi += step;
    }
  } else {
    hi = guess > 0 ? guess : step;
    lo = Math.max(0, hi - step);
    if (guess <= 0) {
      while (hi < 4.4 && inside(hi)) {
        lo = hi;
        hi += step;
      }
    } else {
      while (lo > 0 && !inside(lo)) {
        hi = lo;
        lo = Math.max(0, lo - step);
      }
    }
  }
  for (let i = 0; i < 11; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Small deterministic generator, so the sparks sit in the same places on every start. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build the mesh. `detail` 1 is the wallpaper; lower values are for tests and weak devices. */
export function buildGestalte(detail = 1, sparks = 2600): GestalteGeometry {
  const ys = gestalteRings(0.02 / detail, 0.03 / detail);
  const angles = Math.max(24, Math.round(196 * detail));
  const rings = ys.length;
  const n = rings * angles;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const orb = new Float32Array(n * 3);
  const delay = new Float32Array(n);
  const head = new Float32Array(n);
  // Front arc only: the back of the head is never seen, the sides are (the head turns a little).
  const arc = Math.PI * 0.7;
  const e = 0.004;
  for (let k = 0; k < rings; k++) {
    const y = ys[k];
    const hw = headWeight(y);
    const oz = -0.08 * (1 - hw);
    const aspect = 1 + 1.7 * smoothstep(-1.0, -1.85, y);
    const dl = 0.42 * Math.pow(k / Math.max(1, rings - 1), 0.85);
    const phi = Math.PI * (0.06 + 0.88 * (k / Math.max(1, rings - 1)));
    let guess = 0;
    for (let j = 0; j < angles; j++) {
      const i = k * angles + j;
      const theta = -arc + (2 * arc * j) / (angles - 1);
      let dx = Math.sin(theta) * aspect;
      let dz = Math.cos(theta);
      const dlen = Math.hypot(dx, dz);
      dx /= dlen;
      dz /= dlen;
      const r = surface(y, theta, oz, aspect, guess);
      guess = r;
      const x = dx * r;
      const z = oz + dz * r;
      position[i * 3] = x;
      position[i * 3 + 1] = y;
      position[i * 3 + 2] = z;
      // Gradient from four taps on a tetrahedron.
      const f1 = gestalteField(x + e, y - e, z - e);
      const f2 = gestalteField(x - e, y - e, z + e);
      const f3 = gestalteField(x - e, y + e, z - e);
      const f4 = gestalteField(x + e, y + e, z + e);
      const gx = f1 - f2 - f3 + f4;
      const gy = -f1 - f2 + f3 + f4;
      const gz = -f1 + f2 - f3 + f4;
      const gl = Math.hypot(gx, gy, gz) || 1;
      normal[i * 3] = gx / gl;
      normal[i * 3 + 1] = gy / gl;
      normal[i * 3 + 2] = gz / gl;
      orb[i * 3] = Math.sin(theta) * Math.sin(phi);
      orb[i * 3 + 1] = Math.cos(phi);
      orb[i * 3 + 2] = Math.cos(theta) * Math.sin(phi);
      delay[i] = dl;
      head[i] = hw;
    }
  }
  const quads = (rings - 1) * (angles - 1);
  const index = new Uint32Array(quads * 6);
  let q = 0;
  for (let k = 0; k < rings - 1; k++) {
    for (let j = 0; j < angles - 1; j++) {
      const a = k * angles + j;
      const b = a + 1;
      const c = a + angles;
      const d = c + 1;
      index[q++] = a;
      index[q++] = c;
      index[q++] = b;
      index[q++] = b;
      index[q++] = c;
      index[q++] = d;
    }
  }

  // Sparks leave the silhouette: mostly the crown (a halo of light like hair), then the sides and shoulders.
  // Running sum of the weights (Float64: thousands of small terms).
  const weight = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const nz = normal[i * 3 + 2];
    const ny = normal[i * 3 + 1];
    const y = position[i * 3 + 1];
    weight[i] = total;
    if (Math.abs(nz) > 0.42 || y < -2.4) continue;
    const w =
      (0.25 + 2.4 * Math.max(0, ny) * Math.max(0, ny)) *
      (y > -0.9 ? 1.5 : 1.25) *
      (1 - Math.abs(nz) / 0.42);
    total += w;
    weight[i] = total;
  }
  const rand = rng(7);
  const sparkBase = new Float32Array(sparks * 3);
  const sparkNormal = new Float32Array(sparks * 3);
  const sparkHead = new Float32Array(sparks);
  for (let p = 0; p < sparks; p++) {
    // Binary search in the running sum.
    const pick = rand() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (weight[mid] < pick) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
    for (let c = 0; c < 3; c++) {
      sparkBase[p * 3 + c] = position[i * 3 + c];
      sparkNormal[p * 3 + c] = normal[i * 3 + c];
    }
    sparkHead[p] = head[i];
  }
  return {
    rings,
    angles,
    position,
    normal,
    orb,
    delay,
    head,
    index,
    sparkBase,
    sparkNormal,
    sparkHead,
  };
}

/** 3x3 row-major rotation: tilt (camera above) * roll * pitch * yaw. */
export function poseMatrix(
  out: Float32Array,
  yaw: number,
  pitch: number,
  roll: number,
  tilt: number,
): Float32Array {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const a = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const b = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const c = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  const d = [1, 0, 0, 0, ct, -st, 0, st, ct];
  const mul = (m: number[], o: number[]) => {
    const r = new Array(9);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        r[i * 3 + j] =
          m[i * 3] * o[j] + m[i * 3 + 1] * o[3 + j] + m[i * 3 + 2] * o[6 + j];
    return r;
  };
  const m = mul(d, mul(c, mul(b, a)));
  for (let i = 0; i < 9; i++) out[i] = m[i];
  return out;
}
