// Builds Aura's 3D figure from the MakeHuman base mesh (CC0, makehumancommunity/makehuman, data/3dobjs and
// data/targets): an adult female bust (head, neck, shoulders, upper arms to the elbow, torso to the waist) with a
// blank, smooth ovoid head, subdivided once, with head and breath weights, plus the light lines laid on its
// surface and the landmarks the renderer needs (pivots, hair scalp, collision proxies).
//
//   capped 2G -- node scripts/aura-figure.mjs <dir with base.obj and the targets>
//
// Writes apps/web/static/aura/aura-figure.glb (EXT_meshopt_compression) and aura-figure.json.
import fs from "node:fs";
import path from "node:path";
import { MeshoptEncoder } from "meshoptimizer";
import { applyTarget, groupCentroid, readObj } from "./lib/mh.mjs";

const src = path.resolve(process.argv[2] ?? ".");
const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "apps/web/static/aura");
fs.mkdirSync(outDir, { recursive: true });

const { pos, groups } = readObj(path.join(src, "base.obj"));
// A young adult woman, slim, with a full, firm bust.
applyTarget(pos, path.join(src, "caucasian-female-young.target"), 1);
applyTarget(
  pos,
  path.join(src, "universal-female-young-averagemuscle-minweight.target"),
  0.45,
);
applyTarget(
  pos,
  path.join(
    src,
    "female-young-averagemuscle-averageweight-maxcup-averagefirmness.target",
  ),
  0.9,
);
applyTarget(
  pos,
  path.join(
    src,
    "female-young-averagemuscle-averageweight-averagecup-maxfirmness.target",
  ),
  1.0,
);

const J = (name) => groupCentroid(pos, groups.get(name));
const NECK = J("joint-neck");
const HEAD = J("joint-head");
const SH = { l: J("joint-l-shoulder"), r: J("joint-r-shoulder") };
const EL = { l: J("joint-l-elbow"), r: J("joint-r-elbow") };
const SPINE1 = J("joint-spine-1");

const smooth = (a, b, v) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
const setP = (i, p) => {
  pos[i * 3] = p[0];
  pos[i * 3 + 1] = p[1];
  pos[i * 3 + 2] = p[2];
};

let faces = groups.get("body").map((f) => f.slice());
const bodyVerts = [...new Set(faces.flat())];

/* ---------- arms: lowered from the A pose toward the body, about the shoulder ---------- */
const ARM_DROP = 0.36; // radians
for (const side of ["l", "r"]) {
  const s = SH[side];
  const sign = side === "l" ? 1 : -1;
  const axis = norm(sub(EL[side], s));
  const a = -sign * ARM_DROP;
  for (const i of bodyVerts) {
    const p = P(i);
    if (sign * p[0] < 0.6) continue;
    const along = dot(sub(p, s), axis);
    const w = smooth(-0.45, 0.55, along) * smooth(0.6, 1.2, sign * p[0]);
    if (w <= 0) continue;
    const ang = a * w;
    const dx = p[0] - s[0];
    const dy = p[1] - s[1];
    setP(i, [
      s[0] + dx * Math.cos(ang) - dy * Math.sin(ang),
      s[1] + dx * Math.sin(ang) + dy * Math.cos(ang),
      p[2],
    ]);
  }
  EL[side] = (() => {
    const dx = EL[side][0] - s[0];
    const dy = EL[side][1] - s[1];
    return [
      s[0] + dx * Math.cos(a) - dy * Math.sin(a),
      s[1] + dx * Math.sin(a) + dy * Math.cos(a),
      EL[side][2],
    ];
  })();
}

/* ---------- the head: a blank, smooth ovoid (no features), blended in above the jaw ---------- */
const headVerts = bodyVerts.filter((i) => pos[i * 3 + 1] > NECK[1] + 0.35);
let hx = 0;
let hz0 = 1e9;
let hz1 = -1e9;
let hy1 = -1e9;
let chinY = 1e9;
for (const i of headVerts) {
  const p = P(i);
  // The skull's width above the ears (the ears would make it far too wide).
  if (p[1] > HEAD[1] + 0.45) hx = Math.max(hx, Math.abs(p[0]));
  hz0 = Math.min(hz0, p[2]);
  hz1 = Math.max(hz1, p[2]);
  hy1 = Math.max(hy1, p[1]);
  if (Math.abs(p[0]) < 0.08 && p[2] > HEAD[2] + 0.3)
    chinY = Math.min(chinY, p[1]);
}
// The egg: centred a little above the head joint, slightly narrower at the jaw, deeper than wide.
const EGG = {
  c: [0, (hy1 + chinY) / 2 + 0.02, (hz0 + hz1) / 2 + 0.04],
  rx: Math.min(hx * 1.0, ((hy1 - chinY) / 2) * 0.7),
  ry: (hy1 - chinY) / 2,
  rz: ((hz1 - hz0) / 2) * 0.98,
};
function eggSurface(dir) {
  // Scale the radii toward the chin: an elegant tapered ovoid with a soft jaw.
  const d = norm(dir);
  // A human oval: widest a little above the middle, a gentle taper to a soft chin.
  const taper =
    1 - 0.13 * smooth(-0.1, -0.95, d[1]) - 0.04 * smooth(0.5, 1, d[1]);
  const rx = EGG.rx * taper;
  const rz = EGG.rz * (1 - 0.08 * smooth(0, -0.9, d[1]));
  const k =
    1 / Math.sqrt((d[0] / rx) ** 2 + (d[1] / EGG.ry) ** 2 + (d[2] / rz) ** 2);
  return add(EGG.c, mul(d, k));
}
const headBlend = (p) =>
  smooth(chinY - 0.25, chinY + 0.1, p[1]) *
  smooth(NECK[1] + 0.2, NECK[1] + 0.55, p[1]);
const orig = new Map(headVerts.map((i) => [i, P(i)]));
for (const i of headVerts) {
  const p = P(i);
  const w = headBlend(p);
  if (w <= 0) continue;
  setP(i, add(mul(p, 1 - w), mul(eggSurface(sub(p, EGG.c)), w)));
}
// Faces that folded inward (inside the mouth, the eyes, the nostrils, behind the ears) go; their holes are filled.
const faceNormal = (f) => {
  const a = P(f[0]);
  let n = [0, 0, 0];
  for (let k = 1; k + 1 < f.length; k++)
    n = add(n, cross(sub(P(f[k]), a), sub(P(f[k + 1]), a)));
  return n;
};
faces = faces.filter((f) => {
  const ws = f.map((i) => (orig.has(i) ? headBlend(orig.get(i)) : 0));
  if (Math.max(...ws) < 0.5) return true;
  const c = mul(f.map(P).reduce(add, [0, 0, 0]), 1 / f.length);
  const radial = norm(sub(c, EGG.c));
  const n = faceNormal(f);
  const area = len(n);
  return area > 1e-6 && dot(n, radial) / area > 0.35;
});

/* ---------- cut: torso to the waist, arms to the elbow ---------- */
const WAIST_Y = SPINE1[1] - 2.4;
const keepVert = (i) => {
  const p = P(i);
  if (p[1] < WAIST_Y) return false;
  for (const side of ["l", "r"]) {
    const sign = side === "l" ? 1 : -1;
    if (sign * p[0] < 1.0) continue;
    const axis = norm(sub(EL[side], SH[side]));
    const along = dot(sub(p, SH[side]), axis);
    if (along > len(sub(EL[side], SH[side])) + 0.05) return false;
  }
  return true;
};
faces = faces.filter((f) => f.every(keepVert));

/* ---------- fill the holes the cleanup left in the head (not the cuts at waist and elbows) ---------- */
function boundaryLoops(fs_) {
  const edges = new Map();
  for (const f of fs_)
    for (let k = 0; k < f.length; k++) {
      const a = f[k];
      const b = f[(k + 1) % f.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (edges.has(key)) edges.delete(key);
      else edges.set(key, [a, b]);
    }
  const next = new Map();
  for (const [a, b] of edges.values()) next.set(a, b);
  const loops = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let v = start;
    while (v !== undefined && !seen.has(v)) {
      seen.add(v);
      loop.push(v);
      v = next.get(v);
    }
    loops.push(loop);
  }
  return loops;
}
const extra = [];
const newPos = [];
let nextIndex = pos.length / 3;
for (const loop of boundaryLoops(faces)) {
  const c = mul(loop.map(P).reduce(add, [0, 0, 0]), 1 / loop.length);
  if (c[1] < NECK[1] + 0.3) continue;
  const centre = eggSurface(sub(c, EGG.c));
  const ci = nextIndex++;
  newPos.push(...centre);
  // The loop runs along the hole's edge in the faces' winding: reverse it for the fan.
  for (let k = 0; k < loop.length; k++)
    extra.push([loop[(k + 1) % loop.length], loop[k], ci]);
}
let P2 = new Float64Array(pos.length + newPos.length);
P2.set(pos);
P2.set(newPos, pos.length);
faces = faces.concat(extra);

/* ---------- compact ---------- */
{
  const map = new Map();
  const out = [];
  for (const f of faces)
    for (const i of f)
      if (!map.has(i)) {
        map.set(i, map.size);
        out.push(P2[i * 3], P2[i * 3 + 1], P2[i * 3 + 2]);
      }
  faces = faces.map((f) => f.map((i) => map.get(i)));
  P2 = Float64Array.from(out);
}

/* ---------- smooth the head (Taubin, so it does not shrink) where the ovoid was blended in ---------- */
function neighbours(n, fs_) {
  const nb = Array.from({ length: n }, () => new Set());
  for (const f of fs_)
    for (let k = 0; k < f.length; k++) {
      const a = f[k];
      const b = f[(k + 1) % f.length];
      nb[a].add(b);
      nb[b].add(a);
    }
  return nb.map((s) => [...s]);
}
{
  const n = P2.length / 3;
  const nb = neighbours(n, faces);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++)
    w[i] = headBlend([P2[i * 3], P2[i * 3 + 1], P2[i * 3 + 2]]) ** 0.5;
  for (let it = 0; it < 60; it++)
    for (const lambda of [0.5, -0.53]) {
      const next = Float64Array.from(P2);
      for (let i = 0; i < n; i++) {
        if (w[i] <= 0 || nb[i].length === 0) continue;
        let x = 0;
        let y = 0;
        let z = 0;
        for (const j of nb[i]) {
          x += P2[j * 3];
          y += P2[j * 3 + 1];
          z += P2[j * 3 + 2];
        }
        const k = nb[i].length;
        next[i * 3] += lambda * w[i] * (x / k - P2[i * 3]);
        next[i * 3 + 1] += lambda * w[i] * (y / k - P2[i * 3 + 1]);
        next[i * 3 + 2] += lambda * w[i] * (z / k - P2[i * 3 + 2]);
      }
      P2 = next;
    }
  // And settle the head back onto the ovoid where it is fully head.
  for (let i = 0; i < n; i++) {
    const p = [P2[i * 3], P2[i * 3 + 1], P2[i * 3 + 2]];
    const b = headBlend(p) ** 2;
    if (b <= 0) continue;
    const q = add(mul(p, 1 - b), mul(eggSurface(sub(p, EGG.c)), b));
    P2[i * 3] = q[0];
    P2[i * 3 + 1] = q[1];
    P2[i * 3 + 2] = q[2];
  }
}

/* ---------- one Catmull-Clark step: smooth curvature at close range ---------- */
function catmullClark(V, F) {
  const n = V.length / 3;
  const v = (i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
  const out = Array.from(V);
  const facePts = F.map((f) =>
    mul(f.map(v).reduce(add, [0, 0, 0]), 1 / f.length),
  );
  const fi0 = n;
  for (const fp of facePts) out.push(...fp);
  const edges = new Map();
  F.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      const a = f[k];
      const b = f[(k + 1) % f.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edges.has(key)) edges.set(key, { a, b, faces: [] });
      edges.get(key).faces.push(fi);
    }
  });
  const edgeIndex = new Map();
  let next = out.length / 3;
  for (const [key, e] of edges) {
    const mid = mul(add(v(e.a), v(e.b)), 0.5);
    const p =
      e.faces.length === 2
        ? mul(
            add(
              add(v(e.a), v(e.b)),
              add(facePts[e.faces[0]], facePts[e.faces[1]]),
            ),
            0.25,
          )
        : mid;
    out.push(...p);
    edgeIndex.set(key, next++);
  }
  // Move the original vertices.
  const vf = Array.from({ length: n }, () => []);
  const ve = Array.from({ length: n }, () => []);
  F.forEach((f, fi) => f.forEach((i) => vf[i].push(fi)));
  for (const e of edges.values()) {
    ve[e.a].push(e);
    ve[e.b].push(e);
  }
  for (let i = 0; i < n; i++) {
    const boundary = ve[i].filter((e) => e.faces.length < 2);
    let p;
    if (boundary.length >= 2) {
      const m = boundary
        .map((e) => mul(add(v(e.a), v(e.b)), 0.5))
        .reduce(add, [0, 0, 0]);
      p = add(mul(v(i), 0.5), mul(m, 0.25 / (boundary.length / 2)));
    } else if (vf[i].length > 0) {
      const k = vf[i].length;
      const F_ = mul(
        vf[i].map((fi) => facePts[fi]).reduce(add, [0, 0, 0]),
        1 / k,
      );
      const R_ = mul(
        ve[i].map((e) => mul(add(v(e.a), v(e.b)), 0.5)).reduce(add, [0, 0, 0]),
        1 / ve[i].length,
      );
      p = mul(add(add(F_, mul(R_, 2)), mul(v(i), k - 3)), 1 / k);
    } else p = v(i);
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  const quads = [];
  F.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      const a = f[k];
      const prev = f[(k + f.length - 1) % f.length];
      const nxt = f[(k + 1) % f.length];
      const ek = (x, y) => edgeIndex.get(x < y ? `${x},${y}` : `${y},${x}`);
      quads.push([a, ek(a, nxt), fi0 + fi, ek(prev, a)]);
    }
  });
  return { V: Float64Array.from(out), F: quads };
}
const cc = catmullClark(P2, faces);
let V = cc.V;
const tris = [];
for (const f of cc.F) tris.push(f[0], f[1], f[2], f[0], f[2], f[3]);

/* ---------- normalise: metres-ish units, neck pivot known, figure centred ---------- */
const SCALE = 0.1; // MakeHuman decimetres to metres
for (let i = 0; i < V.length; i++) V[i] *= SCALE;
const scaleP = (p) => mul(p, SCALE);

/* ---------- normals ---------- */
const nVerts = V.length / 3;
const N = new Float64Array(nVerts * 3);
for (let t = 0; t < tris.length; t += 3) {
  const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
  const pa = [V[a * 3], V[a * 3 + 1], V[a * 3 + 2]];
  const n = cross(
    sub([V[b * 3], V[b * 3 + 1], V[b * 3 + 2]], pa),
    sub([V[c * 3], V[c * 3 + 1], V[c * 3 + 2]], pa),
  );
  for (const i of [a, b, c]) {
    N[i * 3] += n[0];
    N[i * 3 + 1] += n[1];
    N[i * 3 + 2] += n[2];
  }
}
for (let i = 0; i < nVerts; i++) {
  const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
  N[i * 3] /= l;
  N[i * 3 + 1] /= l;
  N[i * 3 + 2] /= l;
}

// On the head, the ovoid's own smooth normals (no trace of the old features' seams).
for (let i = 0; i < nVerts; i++) {
  const p = [V[i * 3] / SCALE, V[i * 3 + 1] / SCALE, V[i * 3 + 2] / SCALE];
  const b = headBlend(p) ** 2;
  if (b <= 0) continue;
  const e = 1e-3;
  const f0 = (q) =>
    len(sub(q, EGG.c)) - len(sub(eggSurface(sub(q, EGG.c)), EGG.c));
  const g = norm([
    f0(add(p, [e, 0, 0])) - f0(add(p, [-e, 0, 0])),
    f0(add(p, [0, e, 0])) - f0(add(p, [0, -e, 0])),
    f0(add(p, [0, 0, e])) - f0(add(p, [0, 0, -e])),
  ]);
  const n = norm([
    N[i * 3] * (1 - b) + g[0] * b,
    N[i * 3 + 1] * (1 - b) + g[1] * b,
    N[i * 3 + 2] * (1 - b) + g[2] * b,
  ]);
  N[i * 3] = n[0];
  N[i * 3 + 1] = n[1];
  N[i * 3 + 2] = n[2];
}

/* ---------- landmarks (metres) ---------- */
const neckP = scaleP(NECK);
const egg = {
  c: scaleP(EGG.c),
  r: [EGG.rx * SCALE, EGG.ry * SCALE, EGG.rz * SCALE],
};
// Breasts: the most forward points either side of the sternum, at bust height.
const breast = {};
for (const side of [1, -1]) {
  let best = -1;
  let bz = -1e9;
  for (let i = 0; i < nVerts; i++) {
    const x = V[i * 3] * side;
    const y = V[i * 3 + 1];
    const z = V[i * 3 + 2];
    if (
      x > 0.03 &&
      x < 0.16 &&
      y > SPINE1[1] * SCALE - 0.12 &&
      y < SPINE1[1] * SCALE + 0.08 &&
      z > bz
    ) {
      bz = z;
      best = i;
    }
  }
  breast[side > 0 ? "l" : "r"] = [
    V[best * 3],
    V[best * 3 + 1],
    V[best * 3 + 2],
  ];
}

/* ---------- weights: head (rotates with the neck pivot), breath (the chest swells) ---------- */
const headW = new Float32Array(nVerts);
const breathW = new Float32Array(nVerts);
const chestC = [
  0,
  (breast.l[1] + neckP[1]) / 2 - 0.02,
  (breast.l[2] + neckP[2]) / 2,
];
for (let i = 0; i < nVerts; i++) {
  const p = [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
  headW[i] = smooth(neckP[1] + 0.005, neckP[1] + 0.075, p[1]);
  const d = len(sub(p, chestC));
  breathW[i] =
    Math.exp(-(d * d) / (2 * 0.11 * 0.11)) *
    smooth(-0.05, 0.05, p[2] - chestC[2] + 0.06) *
    (1 - headW[i]);
}

/* ---------- the light lines, laid on the surface (front projection, then onto the nearest triangle) ---------- */
// A simple BVH-less raycaster over a grid of triangles in x,y.
const GRID = 0.01;
const gx0 =
  Math.min(...Array.from({ length: nVerts }, (_, i) => V[i * 3])) - 0.01;
const gy0 =
  Math.min(...Array.from({ length: nVerts }, (_, i) => V[i * 3 + 1])) - 0.01;
const cells = new Map();
for (let t = 0; t < tris.length; t += 3) {
  const xs = [tris[t], tris[t + 1], tris[t + 2]].map((i) => V[i * 3]);
  const ys = [tris[t], tris[t + 1], tris[t + 2]].map((i) => V[i * 3 + 1]);
  for (
    let cx = Math.floor((Math.min(...xs) - gx0) / GRID);
    cx <= Math.floor((Math.max(...xs) - gx0) / GRID);
    cx++
  )
    for (
      let cy = Math.floor((Math.min(...ys) - gy0) / GRID);
      cy <= Math.floor((Math.max(...ys) - gy0) / GRID);
      cy++
    ) {
      const key = cx * 100000 + cy;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(t);
    }
}
/** The frontmost surface point under (x, y), seen along -z, and its smooth normal. */
function project(x, y) {
  const key =
    Math.floor((x - gx0) / GRID) * 100000 + Math.floor((y - gy0) / GRID);
  let best = null;
  for (const t of cells.get(key) ?? []) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const ax = V[a * 3];
    const ay = V[a * 3 + 1];
    const bx = V[b * 3];
    const by = V[b * 3 + 1];
    const cx = V[c * 3];
    const cy = V[c * 3 + 1];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-14) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const z = l1 * V[a * 3 + 2] + l2 * V[b * 3 + 2] + l3 * V[c * 3 + 2];
    if (!best || z > best.z) {
      const n = norm(
        [0, 1, 2].map(
          (k) => l1 * N[a * 3 + k] + l2 * N[b * 3 + k] + l3 * N[c * 3 + k],
        ),
      );
      best = { z, n, hw: l1 * headW[a] + l2 * headW[b] + l3 * headW[c] };
    }
  }
  return best;
}
function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry(20261111);
function catmull(points, step) {
  const Q = [points[0], ...points, points[points.length - 1]];
  const out = [];
  for (let i = 1; i < Q.length - 2; i++) {
    const [p0, p1, p2, p3] = [Q[i - 1], Q[i], Q[i + 1], Q[i + 2]];
    const n = Math.max(
      3,
      Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step),
    );
    for (let j = 0; j < n; j++) {
      const t = j / n;
      const c = (a, b, cc, d) =>
        0.5 *
        (2 * b +
          (-a + cc) * t +
          (2 * a - 5 * b + 4 * cc - d) * t * t +
          (-a + 3 * b - 3 * cc + d) * t * t * t);
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
const lines = [];
/** A line through 2D control points (x, y in metres, front view), laid on the surface. */
function addLine(ctrl, weight, opts = {}) {
  const pts = [];
  for (const [x, y] of catmull(ctrl, 0.004)) {
    const hit = project(x, y);
    if (!hit) {
      if (pts.length > 4) break;
      continue;
    }
    pts.push({ p: [x, y, hit.z], n: hit.n, hw: hit.hw });
  }
  if (pts.length < 6) return;
  // Smooth the laid line (front projection can jitter on steep surfaces), then drop any point that still
  // jumps in depth.
  for (let it = 0; it < 4; it++)
    for (let i = 1; i < pts.length - 1; i++)
      for (let k = 0; k < 3; k++) {
        pts[i].p[k] = (pts[i - 1].p[k] + 2 * pts[i].p[k] + pts[i + 1].p[k]) / 4;
        pts[i].n[k] = (pts[i - 1].n[k] + 2 * pts[i].n[k] + pts[i + 1].n[k]) / 4;
      }
  for (const q of pts) q.n = norm(q.n);
  lines.push({
    w: weight,
    warm: opts.warm ? 1 : 0,
    face: opts.face ? 1 : 0,
    pts,
  });
}
function companion(ctrl, off, weight) {
  // A finer strand beside a line: offset sideways in the front view.
  const c = catmull(ctrl, 0.01);
  const out = [];
  for (let i = 0; i < c.length; i++) {
    const a = c[Math.max(0, i - 1)];
    const b = c[Math.min(c.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const k = off * (0.8 + 0.4 * Math.sin(i * 0.4));
    out.push([c[i][0] - (dy / l) * k, c[i][1] + (dx / l) * k]);
  }
  const from = Math.floor(out.length * (0.05 + 0.2 * rand()));
  const to = Math.min(
    out.length,
    from + Math.floor(out.length * (0.45 + 0.4 * rand())),
  );
  addLine(out.slice(from, to), weight);
}

// Landmarks in the front view.
const nk = neckP;
const shL = scaleP(SH.l);
const elL = scaleP(EL.l);
const B = breast.l;
// The breast seen from the front: centred a little below its most forward point, about 5 cm in radius.
const bustR = Math.abs(B[0]) * 0.86;
const lerp = (a, b, t) => a + (b - a) * t;
const j = (a) => (rand() - 0.5) * 2 * a;
for (const side of [1, -1]) {
  const s = (x) => side * x;
  const bx = side * Math.abs(B[0]);
  const by = B[1] - 0.035;
  // Neck: four fine strands per side, turning out along the collarbone.
  for (let i = 0; i < 4; i++) {
    const k = i / 3;
    addLine(
      [
        [s(lerp(0.012, 0.03, k) + j(0.002)), nk[1] + 0.055],
        [s(lerp(0.015, 0.034, k)), nk[1] + 0.02],
        [s(lerp(0.024, 0.045, k)), nk[1] - 0.025],
        [s(lerp(0.06, 0.085, k)), nk[1] - 0.045],
        [s(lerp(0.1, 0.13, k) + j(0.005)), nk[1] - 0.052],
      ],
      i === 1 ? 0.7 : 0.25 + 0.2 * rand(),
    );
  }
  // The shoulder: one smooth deltoid curve and a fainter one inside it.
  const shx = Math.abs(shL[0]);
  addLine(
    [
      [s(0.01), nk[1] - 0.06],
      [s(0.06), nk[1] - 0.055],
      [s(shx - 0.02), shL[1] + 0.03],
      [s(shx + 0.03), shL[1] + 0.005],
      [s(shx + 0.05), shL[1] - 0.04],
    ],
    0.95,
  );
  addLine(
    [
      [s(shx - 0.04), shL[1] + 0.01],
      [s(shx + 0.01), shL[1] - 0.005],
      [s(shx + 0.03), shL[1] - 0.05],
    ],
    0.3,
  );
  // Arms: three quiet lines along each upper arm (the rims come from the shader).
  const ex = Math.abs(elL[0]);
  for (let i = 0; i < 3; i++) {
    const k = (i + 1) / 4;
    addLine(
      [
        [s(lerp(shx + 0.0, shx + 0.06, k)), shL[1] - 0.03],
        [
          s(lerp(lerp(shx, ex, 0.5) - 0.02, lerp(shx, ex, 0.5) + 0.03, k)),
          lerp(shL[1], elL[1], 0.5),
        ],
        [s(lerp(ex - 0.025, ex + 0.025, k)), elL[1] + 0.02],
      ],
      0.18 + 0.12 * rand(),
    );
  }
  // The chest: sweeps from the collarbone and shoulder over and around the breast, with companions.
  const around = (r, a0, a1, dy = 0) => {
    const out = [];
    for (let a = a0; a <= a1 + 1e-6; a += (a1 - a0) / 7) {
      const t = (a * Math.PI) / 180;
      out.push([
        bx + side * bustR * r * Math.cos(t),
        by + dy - bustR * r * Math.sin(t),
      ]);
    }
    return out;
  };
  const main = [
    [s(0.008), nk[1] - 0.07],
    [s(0.02), nk[1] - 0.12],
    ...around(1.05, -62, 118, 0.0).slice(1),
    [s(0.012), by - bustR * 1.05],
  ];
  addLine(main, 1.05, { warm: false });
  for (let i = 0; i < 4; i++)
    companion(
      main,
      (i % 2 ? 1 : -1) * (0.004 + 0.003 * i),
      0.22 + 0.15 * rand(),
    );
  for (let i = 0; i < 3; i++) {
    const k = i / 2;
    const sweep = [
      [s(lerp(shx - 0.03, shx, k)), shL[1] + 0.005],
      [s(lerp(shx - 0.06, shx - 0.04, k)), shL[1] - 0.04],
      [
        lerp(bx + side * bustR * 0.2, bx + side * bustR * 0.5, k),
        by + bustR * 1.0,
      ],
      ...around(lerp(1.0, 1.12, k), -60 + 15 * k, lerp(70, 40, k), 0),
    ];
    addLine(sweep, i === 0 ? 0.8 : 0.45 + 0.2 * rand(), { warm: i === 1 });
    companion(sweep, side * 0.004, 0.25);
    companion(sweep, -side * 0.0035, 0.18);
  }
  // Contour arcs that follow the volume: open, at different radii; the undersides brightest, often warm.
  for (let i = 0; i < 7; i++) {
    const kind = i < 3 ? "outer" : "under";
    const r = lerp(
      0.5,
      0.95,
      (kind === "outer" ? i : i - 3) / (kind === "outer" ? 2 : 3),
    );
    const [a0, a1] =
      kind === "outer"
        ? [lerp(-70, -40, rand()), lerp(55, 85, rand())]
        : [lerp(-5, 25, rand()), lerp(105, 135, rand())];
    const arc = around(
      kind === "under" ? lerp(0.7, 1.05, (i - 3) / 3) : r,
      a0,
      a1,
      kind === "under" ? (i - 4.5) * 0.006 : (0.9 - r) * 0.02,
    );
    addLine(
      arc,
      kind === "under"
        ? 0.85 + 0.3 * rand()
        : r > 0.8
          ? 0.6 + 0.3 * rand()
          : 0.25 + 0.25 * rand(),
      {
        warm:
          (kind === "under" && rand() < 0.5) ||
          (kind === "outer" && rand() < 0.25),
      },
    );
    if (kind === "under" || r > 0.6)
      companion(arc, side * (0.003 + 0.002 * rand()), 0.2 + 0.1 * rand());
  }
  // From the collarbones toward the sternum, gathering softly, then parting toward the ribs and waist.
  for (let i = 0; i < 7; i++) {
    const k = i / 6;
    addLine(
      [
        [s(lerp(0.02, 0.1, k) + j(0.005)), nk[1] - 0.065 - 0.01 * k],
        [s(lerp(0.012, 0.035, k)), lerp(nk[1] - 0.12, by + 0.04, 0.5)],
        [s(lerp(0.004, 0.01, k)), by],
        [s(lerp(0.008, 0.02, k)), by - bustR * 1.1],
        [s(lerp(0.02, 0.06, k) + j(0.004)), by - bustR * 2.0],
      ],
      i === 1 ? 0.65 : 0.22 + 0.28 * rand(),
      { warm: i === 3 },
    );
  }
  // Ribs: from under the breast down toward the waist.
  for (let i = 0; i < 4; i++) {
    const k = i / 3;
    addLine(
      [
        [s(lerp(0.035, 0.09, k)), by - bustR * 1.15],
        [s(lerp(0.04, 0.085, k)), by - bustR * 1.6],
        [s(lerp(0.035, 0.08, k) + j(0.004)), by - bustR * 2.3],
      ],
      0.22 + 0.3 * rand(),
    );
  }
  // Hair light: from the parting over the skull and down the side of the head (on the head, so it turns with it).
  for (let i = 0; i < 4; i++) {
    const k = i / 3;
    const top = egg.c[1] + egg.r[1];
    addLine(
      [
        [s(0.004 + 0.01 * k), top - 0.004],
        [s(0.035 + 0.012 * k), top - 0.02 - 0.01 * k],
        [s(egg.r[0] * 0.92), egg.c[1] + 0.02 - 0.02 * k],
        [s(egg.r[0] * 0.98), egg.c[1] - 0.04 - 0.02 * k],
      ],
      0.16 + 0.1 * rand(),
    );
  }
  // The blank face: faint lines over its rounded form, never a feature, never down the middle.
  const fx = (u) => side * u * egg.r[0];
  const fy = (v) => egg.c[1] + egg.r[1] - v * 2 * egg.r[1];
  for (let i = 0; i < 3; i++) {
    const o = i * 0.07 + j(0.015);
    addLine(
      [
        [fx(0.86 - o), fy(0.2 + 0.05 * i)],
        [fx(0.88 - o * 1.2), fy(0.42 + 0.03 * i)],
        [fx(0.78 - o * 1.4), fy(0.66 + 0.02 * i)],
        [fx(0.54 - o), fy(0.86 + 0.02 * i)],
        [fx(0.34 - o * 0.6), fy(0.95)],
      ],
      0.28 + 0.1 * rand(),
      { face: true },
    );
  }
  addLine(
    [
      [fx(0.7), fy(0.76)],
      [fx(0.48), fy(0.9)],
      [fx(0.26), fy(0.99)],
      [fx(0.24), fy(1.12)],
      [fx(0.3), fy(1.25)],
    ],
    0.3,
    { face: true },
  );
}
{
  const fx = (u) => u * egg.r[0];
  const fy = (v) => egg.c[1] + egg.r[1] - v * 2 * egg.r[1];
  addLine(
    [
      [fx(-0.66), fy(0.17)],
      [fx(-0.25), fy(0.1)],
      [fx(0.22), fy(0.095)],
      [fx(0.62), fy(0.15)],
    ],
    0.3,
    { face: true },
  );
}

/* ---------- a signed distance field of the body, for the hair to rest on ---------- */
const SDF = {
  cell: 0.01,
  min: [bbMinOf(0) - 0.06, bbMinOf(1) - 0.02, bbMinOf(2) - 0.06],
  dims: [0, 0, 0],
};
function bbMinOf(k) {
  let m = 1e9;
  for (let i = 0; i < nVerts; i++) m = Math.min(m, V[i * 3 + k]);
  return m;
}
function bbMaxOf(k) {
  let m = -1e9;
  for (let i = 0; i < nVerts; i++) m = Math.max(m, V[i * 3 + k]);
  return m;
}
SDF.dims = [0, 1, 2].map(
  (k) => Math.ceil((bbMaxOf(k) + 0.06 - SDF.min[k]) / SDF.cell) + 1,
);
const sdf = new Int8Array(SDF.dims[0] * SDF.dims[1] * SDF.dims[2]);
{
  // Inside: an odd number of surface crossings in front along +z (the cuts at waist and elbows are open, so
  // count only columns that are closed: an even total).
  const vgrid = new Map();
  const VC = 0.02;
  for (let i = 0; i < nVerts; i++) {
    const key = [0, 1, 2].map((k) => Math.floor(V[i * 3 + k] / VC)).join(",");
    if (!vgrid.has(key)) vgrid.set(key, []);
    vgrid.get(key).push(i);
  }
  const nearest = (x, y, z) => {
    let best = 1e9;
    const cx = Math.floor(x / VC);
    const cy = Math.floor(y / VC);
    const cz = Math.floor(z / VC);
    for (let r = 0; r <= 4 && best > (r - 1) * VC; r++)
      for (let a = -r; a <= r; a++)
        for (let b = -r; b <= r; b++)
          for (let c = -r; c <= r; c++) {
            if (Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) !== r) continue;
            for (const i of vgrid.get(`${cx + a},${cy + b},${cz + c}`) ?? [])
              best = Math.min(
                best,
                Math.hypot(V[i * 3] - x, V[i * 3 + 1] - y, V[i * 3 + 2] - z),
              );
          }
    return best;
  };
  const [nx, ny, nz] = SDF.dims;
  for (let iy = 0; iy < ny; iy++)
    for (let ix = 0; ix < nx; ix++) {
      const x = SDF.min[0] + ix * SDF.cell;
      const y = SDF.min[1] + iy * SDF.cell;
      const hits = allHits(x, y);
      for (let iz = 0; iz < nz; iz++) {
        const z = SDF.min[2] + iz * SDF.cell;
        const inside =
          hits.length % 2 === 0 && hits.filter((hz) => hz > z).length % 2 === 1;
        const d = Math.min(0.127, nearest(x, y, z));
        sdf[(iy * nz + iz) * nx + ix] = Math.round((inside ? -d : d) * 1000);
      }
    }
}
function allHits(x, y) {
  const key =
    Math.floor((x - gx0) / GRID) * 100000 + Math.floor((y - gy0) / GRID);
  const out = [];
  for (const t of cells.get(key) ?? []) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const ax = V[a * 3];
    const ay = V[a * 3 + 1];
    const bx = V[b * 3];
    const by = V[b * 3 + 1];
    const cx = V[c * 3];
    const cy = V[c * 3 + 1];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-14) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    out.push(l1 * V[a * 3 + 2] + l2 * V[b * 3 + 2] + l3 * V[c * 3 + 2]);
  }
  // Merge hits on shared edges.
  out.sort((p, q) => p - q);
  return out.filter((z, i) => i === 0 || z - out[i - 1] > 1e-5);
}

/* ---------- write the glTF (EXT_meshopt_compression) ---------- */
await MeshoptEncoder.ready;
const vcount = nVerts;
// Position and normal as float, plus head and breath weights.
const vstride = 32;
const vbuf = new Uint8Array(vcount * vstride);
const dv = new DataView(vbuf.buffer);
let bbMin = [1e9, 1e9, 1e9];
let bbMax = [-1e9, -1e9, -1e9];
for (let i = 0; i < vcount; i++) {
  for (let k = 0; k < 3; k++) {
    dv.setFloat32(i * vstride + k * 4, V[i * 3 + k], true);
    dv.setFloat32(i * vstride + 12 + k * 4, N[i * 3 + k], true);
    bbMin[k] = Math.min(bbMin[k], V[i * 3 + k]);
    bbMax[k] = Math.max(bbMax[k], V[i * 3 + k]);
  }
  dv.setUint16(i * vstride + 24, Math.round(headW[i] * 65535), true);
  dv.setUint16(
    i * vstride + 26,
    Math.round(Math.min(1, breathW[i]) * 65535),
    true,
  );
  dv.setUint32(i * vstride + 28, 0, true);
}
let idx = Uint32Array.from(tris);
// Cache-friendly order, then compress.
idx = MeshoptEncoder.reorderMesh ? idx : idx;
const vComp = MeshoptEncoder.encodeVertexBuffer(vbuf, vcount, vstride);
const iComp = MeshoptEncoder.encodeIndexBuffer(
  new Uint8Array(idx.buffer),
  idx.length,
  4,
);
const pad4 = (n) => (n + 3) & ~3;
const bin = new Uint8Array(pad4(vComp.length) + pad4(iComp.length));
bin.set(vComp, 0);
bin.set(iComp, pad4(vComp.length));
const gltf = {
  asset: {
    version: "2.0",
    generator: "NOVA aura-figure.mjs (MakeHuman CC0 base mesh)",
  },
  extensionsUsed: ["EXT_meshopt_compression"],
  extensionsRequired: ["EXT_meshopt_compression"],
  buffers: [
    { byteLength: bin.length },
    {
      byteLength: vbuf.length + idx.byteLength,
      extensions: { EXT_meshopt_compression: { fallback: true } },
    },
  ],
  bufferViews: [
    {
      buffer: 1,
      byteOffset: 0,
      byteLength: vbuf.length,
      byteStride: vstride,
      target: 34962,
      extensions: {
        EXT_meshopt_compression: {
          buffer: 0,
          byteOffset: 0,
          byteLength: vComp.length,
          byteStride: vstride,
          count: vcount,
          mode: "ATTRIBUTES",
        },
      },
    },
    {
      buffer: 1,
      byteOffset: vbuf.length,
      byteLength: idx.byteLength,
      target: 34963,
      extensions: {
        EXT_meshopt_compression: {
          buffer: 0,
          byteOffset: pad4(vComp.length),
          byteLength: iComp.length,
          byteStride: 4,
          count: idx.length,
          mode: "TRIANGLES",
        },
      },
    },
  ],
  accessors: [
    {
      bufferView: 0,
      byteOffset: 0,
      componentType: 5126,
      count: vcount,
      type: "VEC3",
      min: bbMin,
      max: bbMax,
    },
    {
      bufferView: 0,
      byteOffset: 12,
      componentType: 5126,
      count: vcount,
      type: "VEC3",
    },
    {
      bufferView: 0,
      byteOffset: 24,
      componentType: 5123,
      normalized: true,
      count: vcount,
      type: "SCALAR",
    },
    {
      bufferView: 0,
      byteOffset: 26,
      componentType: 5123,
      normalized: true,
      count: vcount,
      type: "SCALAR",
    },
    {
      bufferView: 1,
      byteOffset: 0,
      componentType: 5125,
      count: idx.length,
      type: "SCALAR",
    },
  ],
  meshes: [
    {
      name: "aura",
      primitives: [
        {
          attributes: { POSITION: 0, NORMAL: 1, _HEAD: 2, _BREATH: 3 },
          indices: 4,
        },
      ],
    },
  ],
  nodes: [{ mesh: 0, name: "aura" }],
  scenes: [{ nodes: [0] }],
  scene: 0,
};
const jsonBuf = Buffer.from(JSON.stringify(gltf));
const jsonPad = Buffer.concat([
  jsonBuf,
  Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20),
]);
const glb = Buffer.alloc(12 + 8 + jsonPad.length + 8 + bin.length);
glb.writeUInt32LE(0x46546c67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(glb.length, 8);
glb.writeUInt32LE(jsonPad.length, 12);
glb.writeUInt32LE(0x4e4f534a, 16);
jsonPad.copy(glb, 20);
glb.writeUInt32LE(bin.length, 20 + jsonPad.length);
glb.writeUInt32LE(0x004e4942, 24 + jsonPad.length);
Buffer.from(bin).copy(glb, 28 + jsonPad.length);
fs.writeFileSync(path.join(outDir, "aura-figure.glb"), glb);

/* ---------- the figure's landmarks and lines ---------- */
const r4 = (v) => +v.toFixed(4);
const r3v = (p) => p.map(r4);
const figure = {
  source:
    "MakeHuman base mesh and targets (CC0 1.0), makehumancommunity/makehuman",
  neck: r3v(neckP),
  head: { c: r3v(egg.c), r: r3v(egg.r) },
  face: r3v([0, egg.c[1] - egg.r[1] * 0.1, egg.c[2] + egg.r[2] * 0.95]),
  breasts: [r3v(breast.l), r3v(breast.r)],
  shoulders: [r3v(scaleP(SH.l)), r3v(scaleP(SH.r))],
  elbows: [r3v(scaleP(EL.l)), r3v(scaleP(EL.r))],
  waist: r4(WAIST_Y * SCALE),
  // Signed distance to the body in mm (int8), x fastest, then z, then y; for the hair's collisions.
  sdf: {
    cell: SDF.cell,
    min: r3v(SDF.min),
    dims: SDF.dims,
    data: Buffer.from(sdf.buffer).toString("base64"),
  },
  bounds: { min: r3v(bbMin), max: r3v(bbMax) },
  lines: lines.map((l) => ({
    w: r4(l.w),
    warm: l.warm,
    face: l.face,
    // x, y, z, nx, ny, nz, head weight per point
    p: l.pts.flatMap((q) => [
      ...r3v(q.p),
      ...q.n.map((v) => +v.toFixed(3)),
      +q.hw.toFixed(3),
    ]),
  })),
};
fs.writeFileSync(path.join(outDir, "aura-figure.json"), JSON.stringify(figure));
console.log(
  JSON.stringify({
    verts: vcount,
    tris: idx.length / 3,
    glb: glb.length,
    lines: lines.length,
    faceLines: lines.filter((l) => l.face).length,
    neck: figure.neck,
    head: figure.head,
    breasts: figure.breasts,
    bounds: figure.bounds,
  }),
);
