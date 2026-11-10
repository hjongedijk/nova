/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- build loops index typed arrays heavily; noUncheckedIndexedAccess would need `!` on every access.

/**
 * GESTALTE v6, the land behind the figure: ranges of dotted mountains on both sides, a dark valley in the
 * middle where the figure stands. Heights come from ridged gradient noise written for this file; points are
 * scattered evenly on screen (rows spaced by distance, columns by the view's width at that distance) and kept
 * more often on crests and lava veins, so the ridgelines read as dense dotted lines over sparse slopes.
 *
 * Per point: position, and data (light 0..1, lava 0..1, seed, kind: 0 dot, 1 living light).
 */

/** Where the camera roughly sits (gestalte.ts frames the bust the same way at 16:9). */
const CAM_Y = -0.6;
const CAM_Z = 8.5;
const TAN = Math.tan((13 * Math.PI) / 180);

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

function hash2(ix, iy) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 2D gradient noise, about -0.7..0.7. */
export function noise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const g = (cx, cy, dx, dy) => {
    const a = hash2(cx, cy) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const n00 = g(ix, iy, fx, fy);
  const n10 = g(ix + 1, iy, fx - 1, fy);
  const n01 = g(ix, iy + 1, fx, fy - 1);
  const n11 = g(ix + 1, iy + 1, fx - 1, fy - 1);
  return (n00 + (n10 - n00) * u) * (1 - v) + (n01 + (n11 - n01) * u) * v;
}

function smoothstep(a, b, v) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface LandPoints {
  count: number;
  position: Float32Array;
  data: Float32Array;
}

/** Terrain shape: screen height F (in half screen heights, -1 = bottom edge) and the ridge fields. */
function shape(x: number, z: number) {
  const D = CAM_Z - z;
  // Screen-relative: 0 in the middle, 1 at the edge of a 16:9 view at this distance.
  const s = Math.abs(x) / (D * TAN * 1.78);
  const env = smoothstep(0.16, 0.62, s);
  const wx = x * 0.15;
  const wz = z * 0.15;
  const r1 = Math.max(0, 1 - Math.abs(noise2(wx, wz)) * 1.7);
  const r2 = Math.max(0, 1 - Math.abs(noise2(wx * 2.3 + 5.1, wz * 2.3 - 1.7)) * 1.7);
  const r3 = Math.max(0, 1 - Math.abs(noise2(wx * 5.1 - 3.3, wz * 5.1 + 8.2)) * 1.7);
  const rid = 0.45 * r1 * r1 + 0.35 * r2 * r2 * (0.4 + 0.6 * r1) + 0.2 * r3 * r2;
  const far = smoothstep(9, 34, D);
  // Peaks reach about a third of the way up at the sides; near ranges stay low so the bottom corners slope
  // away toward the viewer.
  // A massif on each side, highest about two thirds of the way out, jagged by the ridged noise.
  const massif = 0.45 + Math.exp(-(((s - 0.72) / 0.28) ** 2));
  const F = -1.22 + env * massif * (0.22 + 1.5 * rid) * (0.6 + 0.4 * far);
  return { F, D, s, env, rid, r1, r2, wx, wz };
}

/** The terrain at a ground point: height, crest, light and lava weights. */
export function landAt(x: number, z: number) {
  const h = shape(x, z);
  const { F, D, s, env, rid, r1, r2, wx, wz } = h;
  const y = CAM_Y + TAN * D * F;
  // Ridgelines as the eye sees them: a point higher on screen than the ground just in front of it and just
  // behind it is on a crest silhouette. These carry the dense bright dotted lines.
  const dz = 0.035 * D;
  const Fb = shape(x, z - dz).F;
  const Ff = shape(x, z + dz).F;
  const sil = F > Fb && F > Ff ? smoothstep(0.0, 0.012, F - 0.5 * (Fb + Ff)) : 0;
  const crest =
    Math.max(sil, 0.45 * smoothstep(0.93, 0.998, r1), 0.3 * smoothstep(0.93, 0.995, r2) * r1) *
    env;
  // Light on the land: crests brightest, faces faintly textured, the valley floor nearly dark.
  const light = Math.max(crest, 0.2 * smoothstep(-1.0, 0.25, F) * env);
  const lv = 1 - Math.abs(noise2(wx * 1.7 + 11.3, wz * 1.7 - 7.9)) * 2.2;
  const lava =
    smoothstep(0.84, 1.0, lv) * env * smoothstep(0.15, 0.45, rid) * (1 - 0.4 * crest);
  return { y, crest, light, lava, F, D, s };
}

/** Build the land: `count` is the number of candidates; about half are kept. */
export function buildLand(count = 300000, seed = 11): LandPoints {
  const rand = rng(seed);
  const pos = new Float32Array(count * 3);
  const data = new Float32Array(count * 4);
  let n = 0;
  const near = 7;
  const farD = 80;
  for (let i = 0; i < count; i++) {
    // Rows by distance on a log scale and columns across the view at that distance: even on screen.
    const D = near * Math.pow(farD / near, rand());
    const sx = (rand() * 2 - 1) * 1.25;
    const x = sx * D * TAN * 1.78;
    const z = CAM_Z - D;
    const l = landAt(x, z);
    if (l.F < -1.12) continue;
    const keep = 0.26 + 0.74 * Math.max(l.crest, l.lava * 2.5);
    if (rand() > keep) continue;
    const r = rand();
    pos[n * 3] = x;
    pos[n * 3 + 1] = l.y;
    pos[n * 3 + 2] = z;
    data[n * 4] = l.light;
    data[n * 4 + 1] = l.lava;
    data[n * 4 + 2] = r;
    data[n * 4 + 3] = l.crest > 0.5 && rand() < 0.004 ? 1 : 0;
    n++;
  }
  return { count: n, position: pos.slice(0, n * 3), data: data.slice(0, n * 4) };
}
