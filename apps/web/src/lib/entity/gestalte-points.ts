/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- build loops index typed arrays heavily; noUncheckedIndexedAccess would need `!` on every access.

/**
 * GESTALTE v6, the figure as a point cloud. The body surface (gestalte-body.ts) is sliced into contour bands
 * with marching squares over its ring grid, and every band is strung with fine dots, so the form reads through
 * the dark gaps between bands. A sparse dust fills the surface between them, and a few amber veins are grown
 * like a Lichtenberg figure down the neck and over the chest. All procedural, all deterministic.
 *
 * Per point: position, normal, data (head weight, kind, seed, birth order) and extra (vein distance from the
 * root, vein strength, band hash, unused). Kinds: 0 band dot, 1 vein dot, 2 dust.
 * Veins come first and are always drawn; the rest is shuffled, so a shorter draw range is an even thinning.
 */

import {
  CORE,
  CROWN,
  gestalteField,
  type GestalteGeometry,
} from "./gestalte-body.ts";

/** Band spacing in body units (about 9 px at 1080p). */
export const BAND = 0.032;

export interface FigurePoints {
  count: number;
  /** Leading points that are always drawn (the veins). */
  fixed: number;
  position: Float32Array;
  normal: Float32Array;
  data: Float32Array;
  extra: Float32Array;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The level a surface point sits at: horizontal on the head, leaning back a little over the torso. */
export function bandLevel(y: number, z: number, hw: number): number {
  return (y + 0.2 * z * (1 - hw)) / BAND;
}

/** Birth order: the body fills from the bottom of the screen up, the dome of the head closes last. */
export function birthOrder(y: number): number {
  return clamp01((y + 2.7) / (CROWN + 2.7));
}

class Out {
  p = [];
  n = [];
  d = [];
  e = [];
  push(px, py, pz, nx, ny, nz, hw, kind, seed, ord, e0, e1, e2) {
    this.p.push(px, py, pz);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.n.push(nx / l, ny / l, nz / l);
    this.d.push(hw, kind, seed, ord);
    this.e.push(e0, e1, e2, 0);
  }
  get length() {
    return this.d.length / 4;
  }
}

/**
 * Point on the front of the surface at (x, y), interpolated from the ring grid, or null off the figure.
 * Rings run down the body, columns sweep the front arc left to right, so x grows along a ring's front half.
 */
function surfaceAt(geo: GestalteGeometry, x: number, y: number) {
  const { rings, angles, position: P, normal: N, head: H } = geo;
  let k = -1;
  for (let i = 0; i < rings - 1; i++) {
    const y0 = P[i * angles * 3 + 1];
    const y1 = P[(i + 1) * angles * 3 + 1];
    if (y <= y0 && y >= y1) {
      k = i;
      break;
    }
  }
  if (k < 0) return null;
  const y0 = P[k * angles * 3 + 1];
  const y1 = P[(k + 1) * angles * 3 + 1];
  const f = (y0 - y) / Math.max(1e-6, y0 - y1);
  const j0 = Math.floor(angles * 0.21);
  const j1 = Math.ceil(angles * 0.79);
  const at = (j, c) => {
    const a = (k * angles + j) * 3 + c;
    const b = ((k + 1) * angles + j) * 3 + c;
    return P[a] + (P[b] - P[a]) * f;
  };
  for (let j = j0; j < j1; j++) {
    const xa = at(j, 0);
    const xb = at(j + 1, 0);
    if (x >= xa && x <= xb) {
      const u = (x - xa) / Math.max(1e-6, xb - xa);
      const out = { p: [0, 0, 0], n: [0, 0, 0], hw: 0 };
      for (let c = 0; c < 3; c++) {
        out.p[c] = at(j, c) + (at(j + 1, c) - at(j, c)) * u;
        const na = (k * angles + j) * 3 + c;
        const nb = ((k + 1) * angles + j) * 3 + c;
        const nA = N[na] + (N[nb] - N[na]) * f;
        const nB = N[na + 3] + (N[nb + 3] - N[na + 3]) * f;
        out.n[c] = nA + (nB - nA) * u;
      }
      out.hw = H[k * angles + j];
      return out;
    }
  }
  return null;
}

/** Amber veins: a few trunks from under the jaw down the neck, forking over the collarbones and chest. */
function growVeins(geo: GestalteGeometry, out: Out, rand: () => number) {
  const step = 0.006;
  const roots = [
    [-0.17, -0.8, 1.35],
    [-0.055, -0.86, 1.6],
    [0.065, -0.85, 1.5],
    [0.18, -0.81, 1.3],
  ];
  const walk = (x, y, ang, len, strength, depth, s0) => {
    let s = 0;
    let a = ang;
    let drift = 0;
    while (s < len) {
      // Lightning: mostly a slow wander, now and then a sharp kink.
      drift += (rand() - 0.5) * 0.14;
      drift *= 0.9;
      a += drift * 0.3 + (rand() < 0.035 ? (rand() - 0.5) * 0.7 : 0);
      // Down the neck they run side by side; over the chest they fan out gently from the sternum.
      const spread = y < -1.45 ? 0.2 * Math.sign(x || 1) + 0.5 * x : 0.15 * x;
      a += (spread - a) * 0.06;
      a = Math.max(-0.9, Math.min(0.9, a));
      x += Math.sin(a) * step;
      y -= Math.cos(a) * step;
      s += step;
      if (y < -2.45) break;
      const sp = surfaceAt(geo, x, y);
      if (!sp || sp.n[2] < 0.15) break;
      const tip = 1 - s / len;
      const str = strength * (0.35 + 0.65 * Math.sqrt(Math.max(0, tip)));
      out.push(
        sp.p[0] + sp.n[0] * 0.004,
        sp.p[1] + sp.n[1] * 0.004,
        sp.p[2] + sp.n[2] * 0.004,
        sp.n[0],
        sp.n[1],
        sp.n[2],
        sp.hw,
        1,
        rand(),
        birthOrder(sp.p[1]),
        s0 + s,
        str,
        depth,
      );
      if (depth < 2 && rand() < (depth === 0 ? 0.012 : 0.006) && s > 0.12) {
        const side = rand() < 0.5 ? -1 : 1;
        walk(
          x,
          y,
          a + side * (0.35 + 0.35 * rand()),
          (len - s) * (0.3 + 0.35 * rand()),
          strength * 0.62,
          depth + 1,
          s0 + s,
        );
      }
    }
  };
  for (const [x, y, len] of roots) walk(x, y, 0, len, 1, 0, 0);
}

/**
 * Build the cloud. `detail` 1 is the wallpaper (about 100k points); lower values thin the dots along each
 * band (tests, weak devices). Deterministic for a seed.
 */
export function buildFigurePoints(
  geo: GestalteGeometry,
  detail = 1,
  seed = 23,
): FigurePoints {
  const rand = rng(seed);
  const { rings, angles, position: P, normal: N, head: H } = geo;
  const lv = new Float32Array(rings * angles);
  for (let i = 0; i < rings * angles; i++)
    lv[i] = bandLevel(P[i * 3 + 1], P[i * 3 + 2], H[i]);

  const veins = new Out();
  growVeins(geo, veins, rand);

  const out = new Out();
  // Dots along a band: finer on the head (the face carries the detail), a touch wider over the torso.
  const spacing = (y) => (y > -0.9 ? 0.0058 : 0.0072) / detail;
  const ids = [0, 0, 0, 0];
  const cross = [];
  const lerpI = (a, b, t, arr, c) => arr[a * 3 + c] + (arr[b * 3 + c] - arr[a * 3 + c]) * t;
  const seg = (c0, c1, L) => {
    const p0 = [0, 0, 0];
    const p1 = [0, 0, 0];
    const n0 = [0, 0, 0];
    const n1 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      p0[c] = lerpI(c0[0], c0[1], c0[2], P, c);
      p1[c] = lerpI(c1[0], c1[1], c1[2], P, c);
      n0[c] = lerpI(c0[0], c0[1], c0[2], N, c);
      n1[c] = lerpI(c1[0], c1[1], c1[2], N, c);
    }
    const h0 = H[c0[0]] + (H[c0[1]] - H[c0[0]]) * c0[2];
    const h1 = H[c1[0]] + (H[c1[1]] - H[c1[0]]) * c1[2];
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const sp = spacing((p0[1] + p1[1]) / 2);
    const n = Math.floor(len / sp + rand());
    const hash = (Math.sin(L * 12.9898) * 43758.5453) % 1;
    for (let m = 0; m < n; m++) {
      const u = (m + 0.5 + (rand() - 0.5) * 0.45) / n;
      const nz = n0[2] + (n1[2] - n0[2]) * u;
      if (nz < -0.55) continue;
      const y = p0[1] + (p1[1] - p0[1]) * u;
      const x = p0[0] + (p1[0] - p0[0]) * u;
      const z = p0[2] + (p1[2] - p0[2]) * u;
      // Quads that bridge two parts (arm and chest) are not surface: no dots float in the air between them.
      if (Math.abs(gestalteField(x, y, z)) > 0.02) continue;
      out.push(
        x,
        y,
        z,
        n0[0] + (n1[0] - n0[0]) * u,
        n0[1] + (n1[1] - n0[1]) * u,
        nz,
        h0 + (h1 - h0) * u,
        0,
        rand(),
        birthOrder(y) + (rand() - 0.5) * 0.03,
        0,
        0,
        Math.abs(hash),
      );
    }
  };
  for (let k = 0; k < rings - 1; k++) {
    for (let j = 0; j < angles - 1; j++) {
      ids[0] = k * angles + j;
      ids[1] = k * angles + j + 1;
      ids[2] = (k + 1) * angles + j + 1;
      ids[3] = (k + 1) * angles + j;
      let mn = Infinity;
      let mx = -Infinity;
      for (const i of ids) {
        mn = Math.min(mn, lv[i]);
        mx = Math.max(mx, lv[i]);
      }
      for (let L = Math.ceil(mn); L <= mx; L++) {
        cross.length = 0;
        for (let e = 0; e < 4; e++) {
          const a = ids[e];
          const b = ids[(e + 1) % 4];
          const va = lv[a] - L;
          const vb = lv[b] - L;
          if (va * vb < 0) cross.push([a, b, va / (va - vb)]);
        }
        if (cross.length >= 2) seg(cross[0], cross[1], L);
        if (cross.length === 4) seg(cross[2], cross[3], L);
      }
    }
  }

  // Dust: a sparse, even grain over the surface between the bands (area-weighted cells).
  const cells = (rings - 1) * (angles - 1);
  const cum = new Float64Array(cells);
  let total = 0;
  for (let k = 0; k < rings - 1; k++)
    for (let j = 0; j < angles - 1; j++) {
      const a = (k * angles + j) * 3;
      const b = a + 3;
      const c = a + angles * 3;
      const ux = P[b] - P[a];
      const uy = P[b + 1] - P[a + 1];
      const uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a];
      const vy = P[c + 1] - P[a + 1];
      const vz = P[c + 2] - P[a + 2];
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      total += P[a + 1] > -2.9 && N[a + 2] > -0.3 ? area : 0;
      cum[k * (angles - 1) + j] = total;
    }
  const dust = Math.round(out.length * 0.16);
  for (let q = 0; q < dust; q++) {
    const pick = rand() * total;
    let lo = 0;
    let hi = cells - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < pick) lo = mid + 1;
      else hi = mid;
    }
    const k = Math.floor(lo / (angles - 1));
    const j = lo % (angles - 1);
    const u = rand();
    const v = rand();
    const a = k * angles + j;
    const corner = (c, arr) => {
      const p00 = arr[a * 3 + c];
      const p01 = arr[(a + 1) * 3 + c];
      const p10 = arr[(a + angles) * 3 + c];
      const p11 = arr[(a + angles + 1) * 3 + c];
      return (p00 * (1 - u) + p01 * u) * (1 - v) + (p10 * (1 - u) + p11 * u) * v;
    };
    const y = corner(1, P);
    const x = corner(0, P);
    const z = corner(2, P);
    if (Math.abs(gestalteField(x, y, z)) > 0.02) continue;
    out.push(
      x,
      y,
      z,
      corner(0, N),
      corner(1, N),
      corner(2, N),
      H[a],
      2,
      rand(),
      birthOrder(y) + (rand() - 0.5) * 0.06,
      0,
      0,
      rand(),
    );
  }

  // Shuffle everything but the veins, so any prefix of the draw range is an even sample of the figure.
  const fixed = veins.length;
  const count = fixed + out.length;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const data = new Float32Array(count * 4);
  const extra = new Float32Array(count * 4);
  position.set(veins.p);
  normal.set(veins.n);
  data.set(veins.d);
  extra.set(veins.e);
  const order = new Uint32Array(out.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  for (let i = order.length - 1; i > 0; i--) {
    const r = Math.floor(rand() * (i + 1));
    const tmp = order[i];
    order[i] = order[r];
    order[r] = tmp;
  }
  for (let i = 0; i < order.length; i++) {
    const s = order[i];
    const o = fixed + i;
    for (let c = 0; c < 3; c++) {
      position[o * 3 + c] = out.p[s * 3 + c];
      normal[o * 3 + c] = out.n[s * 3 + c];
    }
    for (let c = 0; c < 4; c++) {
      data[o * 4 + c] = out.d[s * 4 + c];
      extra[o * 4 + c] = out.e[s * 4 + c];
    }
  }
  return { count, fixed, position, normal, data, extra };
}

/** Distance from the face centre (rest pose): mood blooms and the birth shockwave travel along it. */
export function faceDistance(x: number, y: number, z: number): number {
  return Math.hypot(x - CORE[0], y - CORE[1], z - CORE[2]);
}
