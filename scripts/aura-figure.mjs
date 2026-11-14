// Builds Aura's 3D figure from our own sculpt: a mesh generated with Hunyuan3D-2 from our own FLUX image (a clay
// sculpt of a woman's bust with long hair). The sculpt is cleaned into an abstract, faceless figure, segmented
// into hair and body, and given the weights and surface fields the renderer needs.
//
//   capped 2G -- node scripts/aura-figure.mjs [raw sculpt .glb]
//
// With a raw sculpt (hundreds of thousands of triangles) it first writes a decimated, compressed copy to
// scripts/assets/aura-sculpt.glb; that copy is the committed source and is what a run without arguments reads.
// Writes apps/web/static/aura/aura-figure.glb (EXT_meshopt_compression) and aura-figure.json.
import fs from "node:fs";
import path from "node:path";
import {
  MeshoptDecoder,
  MeshoptEncoder,
  MeshoptSimplifier,
} from "meshoptimizer";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "apps/web/static/aura");
const sourceFile = path.join(root, "scripts/assets/aura-sculpt.glb");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
await Promise.all([
  MeshoptEncoder.ready,
  MeshoptDecoder.ready,
  MeshoptSimplifier.ready,
]);

const SOURCE_TRIS = 180_000;
const RUNTIME_TRIS = 70_000;
/** Smoothing passes that make the face blank. */
const FACE_SMOOTH = 500;

const smooth = (a, b, v) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const pad4 = (n) => (n + 3) & ~3;

/* ---------- glb in and out (positions and indices only) ---------- */
function readGlb(file) {
  const buf = fs.readFileSync(file);
  const jl = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.toString("utf8", 20, 20 + jl));
  const bin = buf.subarray(20 + jl + 8);
  const prim = gltf.meshes[0].primitives[0];
  const view = (i, size) => {
    const a = gltf.accessors[i];
    const bv = gltf.bufferViews[a.bufferView];
    const ext = bv.extensions?.EXT_meshopt_compression;
    if (ext) {
      const out = new Uint8Array(ext.count * ext.byteStride);
      MeshoptDecoder.decodeGltfBuffer(
        out,
        ext.count,
        ext.byteStride,
        bin.subarray(
          ext.byteOffset ?? 0,
          (ext.byteOffset ?? 0) + ext.byteLength,
        ),
        ext.mode,
        ext.filter,
      );
      return { a, data: out, stride: ext.byteStride };
    }
    const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const stride = bv.byteStride ?? size;
    return { a, data: bin.subarray(off, off + a.count * stride), stride };
  };
  const p = view(prim.attributes.POSITION, 12);
  const dvp = new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);
  const pos = new Float32Array(p.a.count * 3);
  for (let i = 0; i < p.a.count; i++)
    for (let k = 0; k < 3; k++)
      pos[i * 3 + k] = dvp.getFloat32(i * p.stride + k * 4, true);
  const ix = view(prim.indices, 4);
  const dvi = new DataView(
    ix.data.buffer,
    ix.data.byteOffset,
    ix.data.byteLength,
  );
  const idx = new Uint32Array(ix.a.count);
  for (let i = 0; i < idx.length; i++) idx[i] = dvi.getUint32(i * 4, true);
  return { pos, idx };
}
/** Simplify to about `target` triangles and drop unused vertices. */
function decimate(pos, idx, target) {
  const [simplified] = MeshoptSimplifier.simplify(
    idx,
    pos,
    3,
    target * 3,
    0.01,
  );
  const map = new Int32Array(pos.length / 3).fill(-1);
  const out = [];
  const oi = new Uint32Array(simplified.length);
  for (let i = 0; i < simplified.length; i++) {
    const v = simplified[i];
    if (map[v] < 0) {
      map[v] = out.length / 3;
      out.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    }
    oi[i] = map[v];
  }
  return { pos: Float32Array.from(out), idx: oi };
}
/** Write a glb: one interleaved vertex buffer (described by `attrs`) and 32-bit indices, both meshopt-compressed. */
function writeGlb(file, vbuf, vcount, vstride, idx, attrs, generator) {
  const vComp = MeshoptEncoder.encodeVertexBuffer(vbuf, vcount, vstride);
  const iComp = MeshoptEncoder.encodeIndexBuffer(
    new Uint8Array(idx.buffer),
    idx.length,
    4,
  );
  const bin = new Uint8Array(pad4(vComp.length) + pad4(iComp.length));
  bin.set(vComp, 0);
  bin.set(iComp, pad4(vComp.length));
  const accessors = attrs.map((a) => ({
    bufferView: 0,
    byteOffset: a.offset,
    componentType: a.type,
    ...(a.normalized ? { normalized: true } : {}),
    count: vcount,
    type: a.kind,
    ...(a.min ? { min: a.min, max: a.max } : {}),
  }));
  accessors.push({
    bufferView: 1,
    byteOffset: 0,
    componentType: 5125,
    count: idx.length,
    type: "SCALAR",
  });
  const gltf = {
    asset: { version: "2.0", generator },
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
    accessors,
    meshes: [
      {
        name: "aura",
        primitives: [
          {
            attributes: Object.fromEntries(attrs.map((a, i) => [a.name, i])),
            indices: attrs.length,
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
  fs.writeFileSync(file, glb);
  return glb.length;
}

/* ---------- the source: a raw sculpt is decimated and committed once ---------- */
if (process.argv[2]) {
  const raw = readGlb(path.resolve(process.argv[2]));
  const d = decimate(raw.pos, raw.idx, SOURCE_TRIS);
  const vb = new Uint8Array(d.pos.buffer.slice(0));
  const size = writeGlb(
    sourceFile,
    vb,
    d.pos.length / 3,
    12,
    d.idx,
    [
      {
        name: "POSITION",
        offset: 0,
        type: 5126,
        kind: "VEC3",
        min: [-1, -1, -1],
        max: [1, 1, 1],
      },
    ],
    "NOVA aura-figure.mjs (our own sculpt, Hunyuan3D-2)",
  );
  console.log("source", d.idx.length / 3, "triangles,", size, "bytes");
}
const srcMesh = readGlb(sourceFile);
const run = decimate(srcMesh.pos, srcMesh.idx, RUNTIME_TRIS);

/* ---------- to real-world size (metres): crown to chin is about 22.5 cm ---------- */
// The sculpt is about 2 units tall, y up, facing +z. Landmarks below were read off the sculpt (units).
const SCALE = 0.46;
const Y0 = 0.5;
const U = {
  top: 0.988,
  chin: 0.5,
  hairline: 0.87,
  neck: 0.4,
  shoulder: 0.21,
  shoulderX: 0.4,
  cut: -0.62,
  armInner: 0.3,
  armpit: -0.3,
};
const toM = (yu) => yu * SCALE + Y0;
const nVerts = run.pos.length / 3;
const V = new Float64Array(nVerts * 3);
for (let i = 0; i < nVerts; i++) {
  V[i * 3] = run.pos[i * 3] * SCALE;
  V[i * 3 + 1] = toM(run.pos[i * 3 + 1]);
  V[i * 3 + 2] = run.pos[i * 3 + 2] * SCALE;
}
let tris = Array.from(run.idx);
const M = {
  top: toM(U.top),
  chin: toM(U.chin),
  hairline: toM(U.hairline),
  neck: toM(U.neck),
  shoulder: toM(U.shoulder),
  shoulderX: U.shoulderX * SCALE,
  cut: toM(U.cut),
  armInner: U.armInner * SCALE,
  armpit: toM(U.armpit),
};
const headC = [0, (M.top + M.chin) / 2, 0.012];
const headR = [0.07, (M.top - M.chin) / 2, 0.092];

/* ---------- cut: nothing below the waist line (torso and arms end there and fade in the shader) ---------- */
{
  const keep = [];
  for (let t = 0; t < tris.length; t += 3) {
    const ys = [tris[t], tris[t + 1], tris[t + 2]].map((i) => V[i * 3 + 1]);
    if (Math.max(...ys) > M.cut - 0.012)
      keep.push(tris[t], tris[t + 1], tris[t + 2]);
  }
  tris = keep;
}

/* ---------- adjacency and normals ---------- */
const nbrSets = Array.from({ length: nVerts }, () => new Set());
for (let t = 0; t < tris.length; t += 3) {
  const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
  nbrSets[a].add(b).add(c);
  nbrSets[b].add(a).add(c);
  nbrSets[c].add(a).add(b);
}
const nbrList = nbrSets.map((s) => [...s]);
const vAt = (i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
const N = new Float64Array(nVerts * 3);
function computeNormals() {
  N.fill(0);
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const pa = vAt(a);
    const n = cross(sub(vAt(b), pa), sub(vAt(c), pa));
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
}
computeNormals();

/* ---------- segment: hair or body ---------- */
// Skin is smooth, hair is ridged, and where hair lies on skin the sculpt has a crease. So the body is grown
// from the middle of the chest over every edge that bends only a little: it covers chest, belly, shoulders,
// arms and neck and stops at the hair. On the head the face is the front below the hairline. Everything else
// is hair. The labels are then diffused a little so the border is soft.
const SMOOTH_EDGE = 0.97;
const faceW = new Float32Array(nVerts);
const hair = new Float32Array(nVerts);
{
  const body = new Uint8Array(nVerts);
  const stack = [];
  for (let i = 0; i < nVerts; i++) {
    const [x, y, z] = vAt(i);
    if (
      Math.abs(x) < 0.05 &&
      z > 0.05 &&
      y > M.shoulder - 0.15 &&
      y < M.shoulder - 0.03
    ) {
      body[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop();
    for (const k of nbrList[i]) {
      const ax = Math.abs(V[k * 3]);
      const ky = V[k * 3 + 1];
      // Never above the line from the neck to the shoulder: what lies there beside the neck is hair.
      if (
        body[k] ||
        ky > M.chin + 0.05 ||
        V[k * 3 + 2] < -0.1 ||
        (ax > 0.055 && ky > M.neck - 0.04 - 0.25 * (ax - 0.055))
      )
        continue;
      const d =
        N[i * 3] * N[k * 3] +
        N[i * 3 + 1] * N[k * 3 + 1] +
        N[i * 3 + 2] * N[k * 3 + 2];
      if (d < SMOOTH_EDGE) continue;
      body[k] = 1;
      stack.push(k);
    }
  }
  for (let i = 0; i < nVerts; i++) {
    const [x, y, z] = vAt(i);
    const d = norm(sub([x, y, z], headC));
    const face =
      y > M.chin - 0.01 &&
      y < M.hairline &&
      d[2] > 0.3 &&
      Math.abs(x) < 0.066 - 0.03 * smooth(M.chin + 0.06, M.chin, y);
    faceW[i] = face ? 1 : 0;
    if (face) body[i] = 1;
    else if (y > M.chin + 0.05) body[i] = 0;
  }
  // Small islands (a crease the growth could not cross, a stray bit of sculpt) take the label around them.
  for (const label of [0, 1]) {
    const seen = new Uint8Array(nVerts);
    for (let s = 0; s < nVerts; s++) {
      if (seen[s] || body[s] !== label || !nbrList[s].length) continue;
      const comp = [s];
      seen[s] = 1;
      for (let q = 0; q < comp.length; q++)
        for (const k of nbrList[comp[q]])
          if (!seen[k] && body[k] === label) {
            seen[k] = 1;
            comp.push(k);
          }
      if (comp.length < 500) for (const i of comp) body[i] = 1 - label;
    }
  }
  for (let i = 0; i < nVerts; i++) hair[i] = 1 - body[i];
  const diffuse = (field, iterations) => {
    for (let it = 0; it < iterations; it++) {
      const g = Float32Array.from(field);
      for (let i = 0; i < nVerts; i++) {
        if (!nbrList[i].length) continue;
        let s = 0;
        for (const k of nbrList[i]) s += field[k];
        g[i] = 0.4 * field[i] + (0.6 * s) / nbrList[i].length;
      }
      field.set(g);
    }
  };
  diffuse(hair, 3);
  diffuse(faceW, 8);
}

/* ---------- clean the sculpt into an abstract figure ---------- */
// Weighted Laplacian smoothing takes the sculpting marks off the body and all anatomical detail off the chest
// and belly. The face is made blank another way: its distance from the middle of the head is smoothed until
// eyes, nose and lips are gone and only an even, convex plane between brow, cheekbones, jaw and chin is left.
function relax(weight, iterations) {
  const active = [];
  for (let i = 0; i < nVerts; i++)
    if (weight[i] > 0 && nbrList[i].length) active.push(i);
  const g = new Float64Array(active.length * 3);
  for (let it = 0; it < iterations; it++) {
    for (let a = 0; a < active.length; a++) {
      const i = active[a];
      let x = 0;
      let y = 0;
      let z = 0;
      for (const k of nbrList[i]) {
        x += V[k * 3];
        y += V[k * 3 + 1];
        z += V[k * 3 + 2];
      }
      const n = nbrList[i].length;
      const w = 0.5 * weight[i];
      g[a * 3] = V[i * 3] + w * (x / n - V[i * 3]);
      g[a * 3 + 1] = V[i * 3 + 1] + w * (y / n - V[i * 3 + 1]);
      g[a * 3 + 2] = V[i * 3 + 2] + w * (z / n - V[i * 3 + 2]);
    }
    for (let a = 0; a < active.length; a++) {
      const i = active[a];
      V[i * 3] = g[a * 3];
      V[i * 3 + 1] = g[a * 3 + 1];
      V[i * 3 + 2] = g[a * 3 + 2];
    }
  }
}
const skin = Float32Array.from(hair, (h) => 1 - smooth(0.2, 0.6, h));
const chestMask = (i) =>
  skin[i] *
  smooth(-0.02, 0.04, V[i * 3 + 2]) *
  (Math.abs(V[i * 3]) < M.armInner - 0.02 ? 1 : 0);
{
  // The face.
  const active = [];
  for (let i = 0; i < nVerts; i++)
    if (faceW[i] * skin[i] > 0.02) active.push(i);
  const R = new Float64Array(nVerts);
  for (let i = 0; i < nVerts; i++) R[i] = len(sub(vAt(i), headC));
  const dir = active.map((i) => norm(sub(vAt(i), headC)));
  const g = new Float64Array(active.length);
  for (let it = 0; it < FACE_SMOOTH; it++) {
    for (let a = 0; a < active.length; a++) {
      const i = active[a];
      let s = 0;
      for (const k of nbrList[i]) s += R[k];
      g[a] = R[i] + faceW[i] * skin[i] * (s / nbrList[i].length - R[i]);
    }
    for (let a = 0; a < active.length; a++) R[active[a]] = g[a];
  }
  active.forEach((i, a) => {
    for (let k = 0; k < 3; k++) V[i * 3 + k] = headC[k] + dir[a][k] * R[i];
  });
  relax(
    Float32Array.from(faceW, (f, i) => f * skin[i]),
    12,
  );
  // The ears, where they show through the hair, become part of its mass.
  relax(
    Float32Array.from(hair, (h, i) => {
      const [x, y, z] = vAt(i);
      return Math.abs(x) > 0.055 &&
        y > M.chin + 0.03 &&
        y < M.chin + 0.14 &&
        z > -0.04 &&
        z < 0.06
        ? 1
        : 0;
    }),
    30,
  );
  // The whole body a little, the chest more, the belly most.
  relax(
    Float32Array.from(skin, (b, i) => b * (V[i * 3 + 1] < M.chin ? 1 : 0.4)),
    8,
  );
  relax(
    Float32Array.from(
      skin,
      (_, i) =>
        chestMask(i) *
        (1 - smooth(M.shoulder - 0.03, M.shoulder + 0.02, V[i * 3 + 1])),
    ),
    45,
  );
  relax(
    Float32Array.from(
      skin,
      (_, i) =>
        chestMask(i) * (1 - smooth(toM(-0.24), toM(-0.16), V[i * 3 + 1])),
    ),
    140,
  );
}
computeNormals();

/* ---------- the bust: fuller and rounder than the sculpt ---------- */
// Each breast becomes a round form: a ball is set into the chest where the sculpt's breast is, the skin inside
// it is pushed out onto it, and the join is smoothed until it flows into the chest (more above, so the upper
// slope is gentle and the fullness sits low, as it does in nature). The balls stay apart: a soft cleavage.
// BUST.size is the ball's radius in metres and is the one number to tune: about 4 mm per cup size; the
// sculpt's own bust is about 0.045.
const BUST = {
  size: 0.061,
  apart: 0.075,
  lower: 0.008,
  forward: 0.037,
  join: 45,
  blend: 6,
  slope: 36,
};
function apexes() {
  const out = {};
  for (const side of [1, -1]) {
    // The apex: the point furthest out to the front and a little to the side.
    let best = 0;
    let bz = -1e9;
    for (let i = 0; i < nVerts; i++) {
      const x = V[i * 3] * side;
      const y = V[i * 3 + 1];
      const out = V[i * 3 + 2] + 0.35 * x;
      if (
        hair[i] < 0.3 &&
        x > 0.035 &&
        x < M.armInner - 0.01 &&
        y > toM(-0.26) &&
        y < toM(0.08) &&
        out > bz
      ) {
        bz = out;
        best = i;
      }
    }
    out[side > 0 ? "l" : "r"] = vAt(best);
  }
  // The sculpt is not quite symmetric; the two apexes are evened out.
  const x = (out.l[0] - out.r[0]) / 2;
  const y = (out.l[1] + out.r[1]) / 2;
  const z = (out.l[2] + out.r[2]) / 2;
  return { l: [x, y, z], r: [-x, y, z] };
}
{
  const first = apexes();
  // The chest wall: the breastbone at the height of the apexes.
  let wall = -1e9;
  for (let i = 0; i < nVerts; i++)
    if (
      skin[i] > 0.5 &&
      Math.abs(V[i * 3]) < 0.008 &&
      Math.abs(V[i * 3 + 1] - first.l[1]) < 0.01
    )
      wall = Math.max(wall, V[i * 3 + 2]);
  const cy = first.l[1] - BUST.lower;
  for (const side of [1, -1]) {
    // The ball's front is BUST.forward in front of the breastbone.
    const c = [side * BUST.apart, cy, wall + BUST.forward - BUST.size];
    const back = [c[0], c[1], c[2] - BUST.size];
    for (let i = 0; i < nVerts; i++) {
      if (skin[i] <= 0.5 || Math.abs(V[i * 3]) > M.armInner) continue;
      // Skin inside the ball moves out onto it, along the ray from the ball's back pole.
      const d = sub(vAt(i), back);
      const t =
        (2 * BUST.size * d[2]) / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      if (!(t > 1)) continue;
      for (let k = 0; k < 3; k++) V[i * 3 + k] = back[k] + d[k] * t;
    }
  }
  const chest = (i) =>
    chestMask(i) * (1 - smooth(M.shoulder - 0.05, M.shoulder, V[i * 3 + 1]));
  // How far a point is from the nearer ball's middle, in radii (seen from the front).
  const inBall = (i) =>
    Math.min(
      Math.hypot(V[i * 3] - BUST.apart, V[i * 3 + 1] - cy),
      Math.hypot(V[i * 3] + BUST.apart, V[i * 3 + 1] - cy),
    ) / BUST.size;
  // The join is smoothed well, the ball itself hardly: it stays round.
  relax(
    Float32Array.from(skin, (_, i) => chest(i) * smooth(0.55, 0.9, inBall(i))),
    BUST.join,
  );
  relax(
    Float32Array.from(skin, (_, i) => chest(i)),
    BUST.blend,
  );
  relax(
    Float32Array.from(
      skin,
      (_, i) => chest(i) * smooth(cy - 0.005, cy + 0.035, V[i * 3 + 1]),
    ),
    BUST.slope,
  );
}
computeNormals();

/* ---------- landmarks ---------- */
const breast = apexes();
const neckP = [0, M.neck, -0.01];

/* ---------- weights ---------- */
// Head: the head turns about the neck; hair near the head goes with it, the lengths only partly (they lag).
// Breath: the chest swells. Arm: the upper arms, for their own lines.
const headW = new Float32Array(nVerts);
const breathW = new Float32Array(nVerts);
const armW = new Float32Array(nVerts);
const chestC = [
  0,
  (breast.l[1] + M.neck) / 2 - 0.02,
  (breast.l[2] + neckP[2]) / 2,
];
for (let i = 0; i < nVerts; i++) {
  const p = vAt(i);
  const h = smooth(0.25, 0.75, hair[i]);
  const bodyHead = smooth(M.neck + 0.005, M.neck + 0.075, p[1]);
  const hairHead = smooth(M.shoulder + 0.01, M.chin + 0.02, p[1]);
  headW[i] = bodyHead + (hairHead - bodyHead) * h;
  const d = len(sub(p, chestC));
  breathW[i] =
    Math.exp(-(d * d) / (2 * 0.11 * 0.11)) *
    smooth(-0.05, 0.05, p[2] - chestC[2] + 0.06) *
    (1 - headW[i]) *
    (1 - h);
  const armFrom = M.armInner + 0.03 * smooth(M.armpit, M.shoulder, p[1]);
  armW[i] =
    (1 - h) *
    smooth(armFrom - 0.015, armFrom + 0.015, Math.abs(p[0])) *
    (1 - smooth(M.shoulder - 0.03, M.shoulder + 0.02, p[1]));
}

/* ---------- surface fields: their isolines are the light lines, drawn in the shader ---------- */
// A: a flow of lines over the torso, as a stream of light would run: it springs from the base of the neck,
//    fans out along the collarbones and down the chest, parts round each breast and closes again below
//    it, and runs on down the belly and the flanks. (The stream function of a flow past two round forms,
//    in the front view.) Half a line off centre, so no line runs down the middle.
// B: three things, each where the shader asks for it: on the arms the angle round the arm (lines along it),
//    on the neck the distance from the midline (lines running down it), on the face a fan that opens from
//    under the chin (lines up the cheeks and temples). On the chest it holds the distance from the nearer
//    breast's apex, which the shader uses to keep the middle of each breast calm.
// H: the hair's strands: the angle round a vertical axis. On top of the head the axis stands in the crown, so
//    the strands meet there and at the parting; lower down it stands well behind her, so the strands fall
//    straight down every lock, also the ones in front of the shoulders. The field is then smoothed over
//    the surface, so the strands run over the sculpted ridges instead of tracing every one of them.
const FLOW = {
  source: [0, M.neck + 0.02],
  scale: 0.12,
  round: 1.0,
  offset: 0.5 * 0.0125,
};
const STRANDS = { scale: 0.2, behind: 0.25, smooth: 30 };
const fieldA = new Float32Array(nVerts);
const fieldB = new Float32Array(nVerts);
const fieldH = new Float32Array(nVerts);
{
  const from = (p, c, flat) =>
    Math.hypot(p[0] - c[0], p[1] - c[1], (p[2] - c[2]) * flat);
  const [sx, sy] = FLOW.source;
  const a2 = (BUST.size * FLOW.round) ** 2;
  for (let i = 0; i < nVerts; i++) {
    const p = vAt(i);
    let f =
      Math.atan2(p[0], Math.max(0.01, sy - p[1])) * FLOW.scale + FLOW.offset;
    for (const c of [breast.l, breast.r]) {
      // The flow's direction at this breast, and how far the point lies to its side.
      const dl = Math.hypot(c[0] - sx, c[1] - sy);
      const d = [(c[0] - sx) / dl, (c[1] - sy) / dl];
      const rx = p[0] - c[0];
      const ry = p[1] - c[1];
      const s = rx * d[1] - ry * d[0];
      f += ((FLOW.scale / dl) * s * a2) / (a2 + rx * rx + ry * ry);
    }
    fieldA[i] = f;
    const ax = Math.abs(p[0]);
    const side = p[0] > 0 ? 1 : -1;
    const round = Math.atan2(p[0] - side * (M.armInner + 0.045), p[2]) * 0.045;
    const ring = Math.min(from(p, breast.l, 0.55), from(p, breast.r, 0.55));
    const fan = (ax / Math.max(0.03, p[1] - M.chin + 0.06)) * 0.12;
    const neck = ax + (fan - ax) * smooth(M.chin - 0.02, M.chin + 0.02, p[1]);
    const torso =
      ring + (neck - ring) * smooth(M.shoulder - 0.03, M.shoulder + 0.02, p[1]);
    // No blend at the arm: the shader draws nothing in the band where the two meet.
    fieldB[i] = armW[i] > 0.5 ? round : torso;
    const q = p;
    const onTop = smooth(M.chin + 0.1, M.top - 0.03, q[1]);
    const axis = -STRANDS.behind + (headC[2] - 0.02 + STRANDS.behind) * onTop;
    fieldH[i] = Math.atan2(q[0], q[2] - axis) * STRANDS.scale;
  }
  for (let it = 0; it < STRANDS.smooth; it++) {
    const g = Float32Array.from(fieldH);
    for (let i = 0; i < nVerts; i++) {
      if (hair[i] < 0.3) continue;
      let sum = 0;
      let n = 0;
      for (const j of nbrList[i]) {
        // Not across the seam at the back of the head, where the angle jumps.
        if (Math.abs(fieldH[j] - fieldH[i]) > 0.2) continue;
        sum += fieldH[j];
        n++;
      }
      if (n) g[i] = 0.5 * fieldH[i] + (0.5 * sum) / n;
    }
    fieldH.set(g);
  }
}

/* ---------- a grid of triangles in the front view, for the distance field ---------- */
const GRID = 0.01;
const gx0 = bbMinOf(0) - 0.01;
const gy0 = bbMinOf(1) - 0.01;
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

/* ---------- a signed distance field of the figure, for the loose strands to rest on ---------- */
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

/* ---------- write the runtime mesh ---------- */
const usedMap = new Int32Array(nVerts).fill(-1);
let vcount = 0;
for (const i of tris) if (usedMap[i] < 0) usedMap[i] = vcount++;
const vstride = 44;
const vbuf = new Uint8Array(vcount * vstride);
const dv = new DataView(vbuf.buffer);
const bbMin = [1e9, 1e9, 1e9];
const bbMax = [-1e9, -1e9, -1e9];
const u16 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 65535);
for (let i = 0; i < nVerts; i++) {
  const o = usedMap[i] * vstride;
  if (o < 0) continue;
  for (let k = 0; k < 3; k++) {
    dv.setFloat32(o + k * 4, V[i * 3 + k], true);
    dv.setFloat32(o + 12 + k * 4, N[i * 3 + k], true);
    bbMin[k] = Math.min(bbMin[k], V[i * 3 + k]);
    bbMax[k] = Math.max(bbMax[k], V[i * 3 + k]);
  }
  dv.setUint16(o + 24, u16(headW[i]), true);
  dv.setUint16(o + 26, u16(breathW[i]), true);
  dv.setUint16(o + 28, u16(hair[i]), true);
  dv.setUint16(o + 30, u16(armW[i]), true);
  dv.setFloat32(o + 32, fieldA[i], true);
  dv.setFloat32(o + 36, fieldB[i], true);
  dv.setFloat32(o + 40, fieldH[i], true);
}
const idx = Uint32Array.from(tris, (i) => usedMap[i]);
const glbSize = writeGlb(
  path.join(outDir, "aura-figure.glb"),
  vbuf,
  vcount,
  vstride,
  idx,
  [
    {
      name: "POSITION",
      offset: 0,
      type: 5126,
      kind: "VEC3",
      min: bbMin,
      max: bbMax,
    },
    { name: "NORMAL", offset: 12, type: 5126, kind: "VEC3" },
    { name: "_HEAD", offset: 24, type: 5123, kind: "SCALAR", normalized: true },
    {
      name: "_BREATH",
      offset: 26,
      type: 5123,
      kind: "SCALAR",
      normalized: true,
    },
    { name: "_HAIR", offset: 28, type: 5123, kind: "SCALAR", normalized: true },
    { name: "_ARM", offset: 30, type: 5123, kind: "SCALAR", normalized: true },
    { name: "_FA", offset: 32, type: 5126, kind: "SCALAR" },
    { name: "_FB", offset: 36, type: 5126, kind: "SCALAR" },
    { name: "_FH", offset: 40, type: 5126, kind: "SCALAR" },
  ],
  "NOVA aura-figure.mjs (our own sculpt, Hunyuan3D-2)",
);

/* ---------- the figure's landmarks ---------- */
const r4 = (v) => +v.toFixed(4);
const r3v = (p) => p.map(r4);
const figure = {
  source:
    "Our own sculpt: generated with Hunyuan3D-2 from our own FLUX image, cleaned by scripts/aura-figure.mjs",
  neck: r3v(neckP),
  head: { c: r3v(headC), r: r3v(headR) },
  face: r3v([0, headC[1] - headR[1] * 0.1, headC[2] + headR[2]]),
  breasts: [r3v(breast.l), r3v(breast.r)],
  shoulders: [
    r3v([M.shoulderX, M.shoulder, 0]),
    r3v([-M.shoulderX, M.shoulder, 0]),
  ],
  elbows: [
    r3v([M.armInner + 0.045, M.cut, 0]),
    r3v([-(M.armInner + 0.045), M.cut, 0]),
  ],
  waist: r4(M.cut),
  hairline: r4(M.hairline),
  bounds: { min: r3v(bbMin), max: r3v(bbMax) },
  sdf: {
    cell: SDF.cell,
    min: r3v(SDF.min),
    dims: SDF.dims,
    data: Buffer.from(sdf.buffer).toString("base64"),
  },
};
fs.writeFileSync(path.join(outDir, "aura-figure.json"), JSON.stringify(figure));
let hairShare = 0;
for (let i = 0; i < nVerts; i++) hairShare += hair[i] > 0.5 ? 1 : 0;
console.log(
  JSON.stringify({
    verts: vcount,
    tris: idx.length / 3,
    glb: glbSize,
    hairShare: r4(hairShare / nVerts),
    neck: figure.neck,
    head: figure.head,
    breasts: figure.breasts,
    waist: figure.waist,
    bounds: figure.bounds,
  }),
);
