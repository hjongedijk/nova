import type { FigureJson, FigureLine } from "./aura-data.ts";

/**
 * Geometry for the 3D Aura, built at load from the figure's mesh and landmarks: the light lines as ribbons, the
 * birth particles on the surface, and the hair (guide strands with verlet physics, drawn as many interpolated
 * strands). Pure; no three.js and no DOM, so it can be tested.
 */

export type V3 = [number, number, number];

function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weight (6 bits), warm and face flags in one exact float: the shaders decode it. */
export function lineCode(w: number, warm: boolean, face: boolean): number {
  return (
    (1 + Math.min(62, Math.round(w * 41))) * 4 + (warm ? 2 : 0) + (face ? 1 : 0)
  );
}

export interface Ribbons {
  /** Per vertex: position (3), the next point along the line (3), normal (3), across (-1/1), t, line info. */
  position: Float32Array;
  next: Float32Array;
  prev: Float32Array;
  normal: Float32Array;
  /** across (-1 or 1), t along 0..1, head weight, line length (m). */
  info: Float32Array;
  /** line code, line id. */
  code: Float32Array;
  index: Uint32Array;
  lines: number;
  faceLines: number;
}

/** The lines on the surface as camera-facing ribbons: two vertices per point, widened in the vertex shader. */
export function buildRibbons(lines: readonly FigureLine[]): Ribbons {
  let n = 0;
  for (const l of lines) n += l.p.length / 7;
  const position = new Float32Array(n * 2 * 3);
  const next = new Float32Array(n * 2 * 3);
  const prev = new Float32Array(n * 2 * 3);
  const normal = new Float32Array(n * 2 * 3);
  const info = new Float32Array(n * 2 * 4);
  const code = new Float32Array(n * 2 * 2);
  const index: number[] = [];
  let v = 0;
  lines.forEach((line, li) => {
    const m = line.p.length / 7;
    const pt = (i: number): V3 => [
      line.p[i * 7]!,
      line.p[i * 7 + 1]!,
      line.p[i * 7 + 2]!,
    ];
    const cum = [0];
    for (let i = 1; i < m; i++) {
      const a = pt(i - 1);
      const b = pt(i);
      cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const total = cum[m - 1] || 1;
    const c = lineCode(line.w, !!line.warm, !!line.face);
    for (let i = 0; i < m; i++) {
      const p = pt(i);
      // The neighbour that gives the direction: the next point (the previous one, mirrored, at the end).
      const q =
        i < m - 1
          ? pt(i + 1)
          : ((): V3 => {
              const a = pt(i - 1);
              return [2 * p[0] - a[0], 2 * p[1] - a[1], 2 * p[2] - a[2]];
            })();
      const r =
        i > 0
          ? pt(i - 1)
          : ((): V3 => [2 * p[0] - q[0], 2 * p[1] - q[1], 2 * p[2] - q[2]])();
      for (const side of [-1, 1]) {
        position.set(p, v * 3);
        next.set(q, v * 3);
        prev.set(r, v * 3);
        normal.set(
          [line.p[i * 7 + 3]!, line.p[i * 7 + 4]!, line.p[i * 7 + 5]!],
          v * 3,
        );
        info.set([side, cum[i]! / total, line.p[i * 7 + 6]!, total], v * 4);
        code.set([c, li], v * 2);
        v++;
      }
      if (i < m - 1) {
        const a = v - 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  });
  return {
    position,
    next,
    prev,
    normal,
    info,
    code,
    index: Uint32Array.from(index),
    lines: lines.length,
    faceLines: lines.filter((l) => l.face).length,
  };
}

/** Points spread evenly over the surface (area weighted), for the birth: position, normal, head weight, random. */
export function sampleSurface(
  pos: ArrayLike<number>,
  nrm: ArrayLike<number>,
  head: ArrayLike<number>,
  index: ArrayLike<number>,
  count: number,
  seed = 7,
): { position: Float32Array; normal: Float32Array; seed: Float32Array } {
  const rand = mulberry(seed);
  const tris = index.length / 3;
  const area = new Float64Array(tris + 1);
  for (let t = 0; t < tris; t++) {
    const [a, b, c] = [index[t * 3]!, index[t * 3 + 1]!, index[t * 3 + 2]!];
    const ux = pos[b * 3]! - pos[a * 3]!;
    const uy = pos[b * 3 + 1]! - pos[a * 3 + 1]!;
    const uz = pos[b * 3 + 2]! - pos[a * 3 + 2]!;
    const vx = pos[c * 3]! - pos[a * 3]!;
    const vy = pos[c * 3 + 1]! - pos[a * 3 + 1]!;
    const vz = pos[c * 3 + 2]! - pos[a * 3 + 2]!;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    area[t + 1] = area[t]! + Math.hypot(cx, cy, cz) / 2;
  }
  const total = area[tris]!;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 4);
  for (let k = 0; k < count; k++) {
    // Stratified: one sample per equal slice of the total area.
    const target = ((k + rand()) / count) * total;
    let lo = 0;
    let hi = tris;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (area[mid + 1]! < target) lo = mid + 1;
      else hi = mid;
    }
    const t = Math.min(tris - 1, lo);
    let r1 = rand();
    let r2 = rand();
    if (r1 + r2 > 1) {
      r1 = 1 - r1;
      r2 = 1 - r2;
    }
    const w = [1 - r1 - r2, r1, r2];
    const ids = [index[t * 3]!, index[t * 3 + 1]!, index[t * 3 + 2]!];
    let hw = 0;
    for (let c = 0; c < 3; c++) {
      let p = 0;
      let n = 0;
      for (let j = 0; j < 3; j++) {
        p += pos[ids[j]! * 3 + c]! * w[j]!;
        n += nrm[ids[j]! * 3 + c]! * w[j]!;
      }
      position[k * 3 + c] = p;
      normal[k * 3 + c] = n;
    }
    for (let j = 0; j < 3; j++) hw += head[ids[j]!]! * w[j]!;
    seeds.set([rand(), hw, rand(), rand()], k * 4);
  }
  // Shuffle so any prefix is an even sample (a lower budget draws fewer).
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    for (const [arr, k] of [
      [position, 3],
      [normal, 3],
      [seeds, 4],
    ] as const)
      for (let c = 0; c < k; c++) {
        const tmp = arr[i * k + c]!;
        arr[i * k + c] = arr[j * k + c]!;
        arr[j * k + c] = tmp;
      }
  }
  return { position, normal, seed: seeds };
}

/* ---------------------------------------------------------------- hair ---------------------------------------------------------------- */

export interface Sphere {
  c: V3;
  r: number;
  /** Ellipsoid radii (when set, `r` is ignored): the head. */
  e?: V3;
  /** Moves with the head. */
  head?: boolean;
}

/** The body's signed distance field (metres; negative inside), for the hair to rest on. */
export interface Sdf {
  cell: number;
  min: V3;
  dims: V3;
  data: Int8Array;
}

export function decodeSdf(j: {
  cell: number;
  min: number[];
  dims: number[];
  data: string;
}): Sdf {
  const bin =
    typeof atob === "function"
      ? atob(j.data)
      : Buffer.from(j.data, "base64").toString("binary");
  const data = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    data[i] = (bin.charCodeAt(i) << 24) >> 24;
  return { cell: j.cell, min: j.min as V3, dims: j.dims as V3, data };
}

/** Signed distance (m) at p, trilinear; far outside the grid it is "far". */
export function sdfAt(f: Sdf, x: number, y: number, z: number): number {
  const gx = (x - f.min[0]) / f.cell;
  const gy = (y - f.min[1]) / f.cell;
  const gz = (z - f.min[2]) / f.cell;
  const [nx, ny, nz] = f.dims;
  if (
    gx < 0 ||
    gy < 0 ||
    gz < 0 ||
    gx >= nx - 1 ||
    gy >= ny - 1 ||
    gz >= nz - 1
  )
    return 0.127;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fy = gy - iy;
  const fz = gz - iz;
  const at = (a: number, b: number, c: number) =>
    f.data[((iy + b) * nz + (iz + c)) * nx + (ix + a)]!;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = lerp(at(0, 0, 0), at(1, 0, 0), fx);
  const c10 = lerp(at(0, 1, 0), at(1, 1, 0), fx);
  const c01 = lerp(at(0, 0, 1), at(1, 0, 1), fx);
  const c11 = lerp(at(0, 1, 1), at(1, 1, 1), fx);
  return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz) / 1000;
}

export interface Hair {
  guides: number;
  points: number;
  /** Rest positions in the head's frame for the roots (guides x 3). */
  roots: Float32Array;
  /** Current and previous positions (guides x points x 3), world space. */
  pos: Float32Array;
  prev: Float32Array;
  /** Rest length of each segment per guide. */
  seg: Float32Array;
  /** Root direction (the first segment's direction at rest, head frame). */
  dir: Float32Array;
  colliders: Sphere[];
  pivot: V3;
  sdf: Sdf | null;
}

export const HAIR = {
  /** Guide strands and their points (root first). */
  guides: { low: 120, mid: 180, high: 240 },
  points: 16,
  /** Drawn strands interpolated from the guides. */
  strands: { low: 1500, mid: 3200, high: 6000 },
  /** Length range (m). */
  length: [0.26, 0.5] as const,
  gravity: 9.8,
  damping: 0.965,
  /** Constraint passes per step. */
  iterations: 4,
} as const;

/** A point on the head ellipsoid in direction d (head frame). */
function onEllipsoid(c: V3, e: V3, d: V3, grow = 1): V3 {
  const k =
    1 / Math.sqrt((d[0] / e[0]) ** 2 + (d[1] / e[1]) ** 2 + (d[2] / e[2]) ** 2);
  return [
    c[0] + d[0] * k * grow,
    c[1] + d[1] * k * grow,
    c[2] + d[2] * k * grow,
  ];
}

/** Grow the guide strands from the scalp (a soft centre parting, never over the face) and let them settle. */
export function growHair(
  fig: FigureJson,
  guides: number,
  seed = 11,
  sdf: Sdf | null = null,
): Hair {
  const rand = mulberry(seed);
  const P = HAIR.points;
  const c = fig.head.c;
  const e: V3 = [
    fig.head.r[0] * 1.03,
    fig.head.r[1] * 1.03,
    fig.head.r[2] * 1.03,
  ];
  const roots = new Float32Array(guides * 3);
  const dir = new Float32Array(guides * 3);
  const seg = new Float32Array(guides);
  const pos = new Float32Array(guides * P * 3);
  let g = 0;
  // Scalp directions: a centre parting at the top, the crown, the sides and the back; the hairline frames the
  // face. About a third are front locks: from the hairline beside the face they fall over the shoulders onto the
  // upper chest.
  const frontLocks = Math.round(guides * 0.34);
  while (g < guides) {
    const lock = g < frontLocks;
    let d: V3;
    if (lock) {
      // Along the front hairline, from the parting down to the temples.
      const side = g % 2 ? 1 : -1;
      const a = 0.12 + 0.75 * rand();
      d = [
        side * Math.sin(a * 1.35),
        Math.cos(a * 1.35) * 0.85 + 0.1,
        0.32 + 0.15 * rand(),
      ];
      const l0 = Math.hypot(...d);
      d = [d[0] / l0, d[1] / l0, d[2] / l0];
    } else {
      const u = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const sn = Math.sqrt(1 - u * u);
      d = [sn * Math.cos(phi), u, sn * Math.sin(phi)];
    }
    if (d[1] < -0.05) continue;
    // Not on the face: in front, the hairline sits high and arches over the temples.
    const front = d[2];
    if (!lock && front > 0.2 && d[1] < 0.55 + 0.25 * (1 - Math.abs(d[0]) * 1.3))
      continue;
    if (!lock && d[1] < 0.25 && Math.abs(d[0]) > 0.7 && front > -0.1) continue;
    let root = onEllipsoid(c, e, d, 1.0);
    if (sdf) {
      // Onto the real scalp: step along the direction until just outside the surface.
      for (let k = 0; k < 40; k++) {
        const dist = sdfAt(sdf, root[0], root[1], root[2]);
        if (dist > 0.0015 && dist < 0.004) break;
        const step = dist < 0.0015 ? 0.002 : -Math.min(0.002, dist - 0.0025);
        root = [
          root[0] + d[0] * step,
          root[1] + d[1] * step,
          root[2] + d[2] * step,
        ];
      }
    }
    roots.set(root, g * 3);
    // Combed away from the parting, then falling.
    const side =
      Math.abs(d[0]) < 0.06 ? (rand() < 0.5 ? -1 : 1) : Math.sign(d[0]);
    // Combed out from the parting, over the temples: the back hair falls behind, the front locks forward of the
    // shoulders. The face stays free.
    const comb: V3 = lock
      ? [side * (0.85 + 0.2 * rand()), -0.25, 0.25 + 0.2 * rand()]
      : [
          side * (0.75 + 0.3 * rand()) + d[0] * 0.3,
          -0.1 + d[1] * 0.2,
          -0.35 + d[2] * 0.25 + (rand() - 0.5) * 0.4,
        ];
    const l = Math.hypot(...comb);
    dir.set([comb[0] / l, comb[1] / l, comb[2] / l], g * 3);
    const length =
      HAIR.length[0] +
      (HAIR.length[1] - HAIR.length[0]) *
        (0.4 + 0.6 * rand()) *
        (0.75 + 0.25 * (1 - Math.max(0, front)));
    seg[g] = length / (P - 1);
    // Start along the head's surface, then down (front locks down in front of the shoulder).
    for (let i = 0; i < P; i++) {
      const k = i * seg[g]!;
      const dd = Math.min(k, 0.09);
      const fall = Math.max(0, k - 0.09);
      const p: V3 = [
        root[0] + (comb[0] / l) * dd,
        root[1] + (comb[1] / l) * dd - fall,
        root[2] + (comb[2] / l) * dd + fall * (lock ? 0.35 : -0.25),
      ];
      pos.set(p, (g * P + i) * 3);
    }
    g++;
  }
  const colliders = bodyColliders(fig);
  const hair: Hair = {
    guides,
    points: P,
    roots,
    pos,
    prev: Float32Array.from(pos),
    seg,
    dir,
    colliders,
    pivot: fig.neck,
    sdf,
  };
  // Let it fall into place.
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let s = 0; s < 150; s++) stepHair(hair, 1 / 60, I, [0, 0], 0.9);
  hair.prev.set(hair.pos);
  return hair;
}

/** Spheres (and the head's ellipsoid) the hair rests on: head, neck, shoulders, upper back, chest and bust. */
export function bodyColliders(fig: FigureJson): Sphere[] {
  const [sl, sr] = fig.shoulders as [V3, V3];
  const [bl, br] = fig.breasts as [V3, V3];
  const n = fig.neck;
  const out: Sphere[] = [
    {
      c: fig.head.c,
      r: 0,
      e: [fig.head.r[0] * 1.06, fig.head.r[1] * 1.04, fig.head.r[2] * 1.05],
      head: true,
    },
    { c: [n[0], n[1] + 0.03, n[2] - 0.005], r: 0.052 },
    { c: [n[0], n[1] - 0.05, n[2] - 0.02], r: 0.075 },
  ];
  for (const s of [sl, sr]) {
    out.push({ c: [s[0] * 0.92, s[1] + 0.01, s[2] - 0.02], r: 0.06 });
    out.push({ c: [s[0] * 0.55, s[1] + 0.005, s[2] - 0.035], r: 0.068 });
    out.push({ c: [s[0] * 1.05, s[1] - 0.09, s[2] - 0.01], r: 0.052 });
  }
  out.push({ c: [0, sl[1] - 0.08, -0.03], r: 0.12 });
  out.push({ c: [0, sl[1] - 0.2, -0.02], r: 0.12 });
  for (const b of [bl, br])
    out.push({ c: [b[0], b[1] + 0.005, b[2] - 0.045], r: 0.06 });
  return out;
}

/**
 * One verlet step. `R` is the head's rotation (column-major 3x3) about the neck pivot: the roots and the head's
 * collider follow it exactly, the rest of each strand follows through its constraints, a little late, with a
 * little overshoot. `wind` is a force (x, z).
 */
export function stepHair(
  h: Hair,
  dt: number,
  R: number[],
  wind: [number, number],
  motion: number,
): void {
  const P = h.points;
  const rot = (p: V3): V3 => {
    const x = p[0] - h.pivot[0];
    const y = p[1] - h.pivot[1];
    const z = p[2] - h.pivot[2];
    return [
      h.pivot[0] + R[0]! * x + R[3]! * y + R[6]! * z,
      h.pivot[1] + R[1]! * x + R[4]! * y + R[7]! * z,
      h.pivot[2] + R[2]! * x + R[5]! * y + R[8]! * z,
    ];
  };
  const head = h.colliders[0]!;
  const headC = rot(head.c);
  const dt2 = dt * dt;
  const g = -HAIR.gravity;
  for (let s = 0; s < h.guides; s++) {
    const o = s * P * 3;
    const root = rot([
      h.roots[s * 3]!,
      h.roots[s * 3 + 1]!,
      h.roots[s * 3 + 2]!,
    ]);
    h.pos[o] = h.prev[o] = root[0];
    h.pos[o + 1] = h.prev[o + 1] = root[1];
    h.pos[o + 2] = h.prev[o + 2] = root[2];
    // The second point keeps the root's combed direction: the crown stays attached to the head.
    const d = [h.dir[s * 3]!, h.dir[s * 3 + 1]!, h.dir[s * 3 + 2]!];
    const rd = [
      R[0]! * d[0]! + R[3]! * d[1]! + R[6]! * d[2]!,
      R[1]! * d[0]! + R[4]! * d[1]! + R[7]! * d[2]!,
      R[2]! * d[0]! + R[5]! * d[1]! + R[8]! * d[2]!,
    ];
    for (let i = 1; i < P; i++) {
      const k = o + i * 3;
      const free = i / (P - 1);
      for (let c = 0; c < 3; c++) {
        const p = h.pos[k + c]!;
        const v = (p - h.prev[k + c]!) * HAIR.damping;
        let a = c === 1 ? g : 0;
        if (c === 0) a += wind[0] * free;
        if (c === 2) a += wind[1] * free;
        h.prev[k + c] = p;
        h.pos[k + c] = p + v + a * dt2 * motion;
      }
    }
    for (let it = 0; it < HAIR.iterations; it++) {
      for (let i = 1; i < P; i++) {
        const k = o + i * 3;
        const j = k - 3;
        // Distance to the previous point (that point is fixed for the root).
        const dx = h.pos[k]! - h.pos[j]!;
        const dy = h.pos[k + 1]! - h.pos[j + 1]!;
        const dz = h.pos[k + 2]! - h.pos[j + 2]!;
        const l = Math.hypot(dx, dy, dz) || 1e-9;
        const diff = (l - h.seg[s]!) / l;
        const wj = i === 1 ? 0 : 0.5;
        const wk = 1 - wj;
        h.pos[k] = h.pos[k]! - dx * diff * wk;
        h.pos[k + 1] = h.pos[k + 1]! - dy * diff * wk;
        h.pos[k + 2] = h.pos[k + 2]! - dz * diff * wk;
        h.pos[j] = h.pos[j]! + dx * diff * wj;
        h.pos[j + 1] = h.pos[j + 1]! + dy * diff * wj;
        h.pos[j + 2] = h.pos[j + 2]! + dz * diff * wj;
        if (i === 1) {
          // Pull the first segment toward the combed direction (stiff near the root).
          const tx = h.pos[j]! + rd[0]! * h.seg[s]!;
          const ty = h.pos[j + 1]! + rd[1]! * h.seg[s]!;
          const tz = h.pos[j + 2]! + rd[2]! * h.seg[s]!;
          h.pos[k] = h.pos[k]! + (tx - h.pos[k]!) * 0.6;
          h.pos[k + 1] = h.pos[k + 1]! + (ty - h.pos[k + 1]!) * 0.6;
          h.pos[k + 2] = h.pos[k + 2]! + (tz - h.pos[k + 2]!) * 0.6;
        }
      }
      // Collisions once per step, after the last pass (the cheap passes before it keep the lengths).
      if (it === HAIR.iterations - 1)
        for (let i = 1; i < P; i++) {
          keepOffFace(h, o + i * 3, R);
          if (h.sdf) collideSdf(h, o + i * 3, R);
          else collide(h, o + i * 3, headC);
        }
    }
  }
}

/**
 * The hairstyle's one rule: the face stays free. In the head's frame, a point in front of the head and within the
 * face's width is moved out to the side (hair parted in the middle falls beside the face, not over it).
 */
function keepOffFace(h: Hair, k: number, R: number[]): void {
  const c = h.colliders[0]!.c;
  const e = h.colliders[0]!.e!;
  const dx = h.pos[k]! - h.pivot[0];
  const dy = h.pos[k + 1]! - h.pivot[1];
  const dz = h.pos[k + 2]! - h.pivot[2];
  // Into the head's rest frame.
  const x = h.pivot[0] + R[0]! * dx + R[1]! * dy + R[2]! * dz;
  const y = h.pivot[1] + R[3]! * dx + R[4]! * dy + R[5]! * dz;
  const z = h.pivot[2] + R[6]! * dx + R[7]! * dy + R[8]! * dz;
  const top = c[1] + e[1] * 0.55;
  const bottom = c[1] - e[1] * 1.25;
  if (y > top || y < bottom || z < c[2] - e[2] * 0.15) return;
  const half = e[0] * 1.08 * (y < c[1] - e[1] * 0.6 ? 1.15 : 1);
  if (Math.abs(x - c[0]) >= half) return;
  const nx = c[0] + Math.sign(x - c[0] || 1) * half;
  const ddx = nx - x;
  // Back to world (rotate the offset by R).
  h.pos[k] = h.pos[k]! + R[0]! * ddx;
  h.pos[k + 1] = h.pos[k + 1]! + R[1]! * ddx;
  h.pos[k + 2] = h.pos[k + 2]! + R[2]! * ddx;
}

/** Push a point out of the body along the distance field's gradient (the head's part turned with the head). */
function collideSdf(h: Hair, k: number, R: number[]): void {
  const f = h.sdf!;
  const margin = 0.004;
  let x = h.pos[k]!;
  let y = h.pos[k + 1]!;
  let z = h.pos[k + 2]!;
  // Above the neck the body has turned with the head: look it up in the head's rest frame.
  const onHead = y > h.pivot[1] - 0.01;
  if (onHead) {
    const dx = x - h.pivot[0];
    const dy = y - h.pivot[1];
    const dz = z - h.pivot[2];
    // Inverse rotation = transpose.
    x = h.pivot[0] + R[0]! * dx + R[1]! * dy + R[2]! * dz;
    y = h.pivot[1] + R[3]! * dx + R[4]! * dy + R[5]! * dz;
    z = h.pivot[2] + R[6]! * dx + R[7]! * dy + R[8]! * dz;
  }
  const d = sdfAt(f, x, y, z);
  if (d >= margin) return;
  const e = f.cell * 0.5;
  let gx = sdfAt(f, x + e, y, z) - sdfAt(f, x - e, y, z);
  let gy = sdfAt(f, x, y + e, z) - sdfAt(f, x, y - e, z);
  let gz = sdfAt(f, x, y, z + e) - sdfAt(f, x, y, z - e);
  const gl = Math.hypot(gx, gy, gz) || 1;
  gx /= gl;
  gy /= gl;
  gz /= gl;
  const push = margin - d;
  if (onHead) {
    // Back to world: rotate the push direction by R.
    const wx = R[0]! * gx + R[3]! * gy + R[6]! * gz;
    const wy = R[1]! * gx + R[4]! * gy + R[7]! * gz;
    const wz = R[2]! * gx + R[5]! * gy + R[8]! * gz;
    gx = wx;
    gy = wy;
    gz = wz;
  }
  h.pos[k] = h.pos[k]! + gx * push;
  h.pos[k + 1] = h.pos[k + 1]! + gy * push;
  h.pos[k + 2] = h.pos[k + 2]! + gz * push;
}

function collide(h: Hair, k: number, headC: V3): void {
  for (let ci = 0; ci < h.colliders.length; ci++) {
    const s = h.colliders[ci]!;
    const c = ci === 0 ? headC : s.c;
    let dx = h.pos[k]! - c[0];
    let dy = h.pos[k + 1]! - c[1];
    let dz = h.pos[k + 2]! - c[2];
    if (s.e) {
      // Ellipsoid: push out along the scaled direction (the head is nearly round enough for this).
      const q = (dx / s.e[0]) ** 2 + (dy / s.e[1]) ** 2 + (dz / s.e[2]) ** 2;
      if (q < 1) {
        const k2 = 1 / Math.sqrt(q || 1e-9);
        dx *= k2;
        dy *= k2;
        dz *= k2;
        h.pos[k] = c[0] + dx;
        h.pos[k + 1] = c[1] + dy;
        h.pos[k + 2] = c[2] + dz;
      }
    } else {
      const d = Math.hypot(dx, dy, dz);
      if (d < s.r && d > 1e-9) {
        const k2 = s.r / d;
        h.pos[k] = c[0] + dx * k2;
        h.pos[k + 1] = c[1] + dy * k2;
        h.pos[k + 2] = c[2] + dz * k2;
      }
    }
  }
}

/** Strands interpolated between three nearby guides: guide indices (3), weights (2; the third is the rest), seed. */
export function strandAttributes(
  h: Hair,
  strands: number,
  seed = 5,
): { guides: Float32Array; weights: Float32Array } {
  const rand = mulberry(seed);
  const guides = new Float32Array(strands * 3);
  const weights = new Float32Array(strands * 4);
  const root = (g: number): V3 => [
    h.roots[g * 3]!,
    h.roots[g * 3 + 1]!,
    h.roots[g * 3 + 2]!,
  ];
  // Each guide's two nearest neighbours, on the same side of the parting.
  const near: [number, number][] = [];
  for (let g = 0; g < h.guides; g++) {
    const a = root(g);
    const best: [number, number][] = [];
    for (let k = 0; k < h.guides; k++) {
      if (k === g) continue;
      const b = root(k);
      if (
        Math.sign(a[0]) !== Math.sign(b[0]) &&
        Math.abs(a[0]) > 0.01 &&
        Math.abs(b[0]) > 0.01
      )
        continue;
      best.push([Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), k]);
    }
    best.sort((x, y) => x[0] - y[0]);
    near.push([best[0]?.[1] ?? g, best[1]?.[1] ?? g]);
  }
  for (let s = 0; s < strands; s++) {
    const g = s % h.guides;
    let u = rand();
    let v = rand();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    guides.set([g, near[g]![0], near[g]![1]], s * 3);
    // Mostly the own guide; random offset and brightness.
    weights.set([1 - 0.7 * (u + v), 0.7 * u, rand(), rand()], s * 4);
  }
  return { guides, weights };
}
