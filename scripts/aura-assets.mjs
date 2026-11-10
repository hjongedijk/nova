// Builds the Aura figure's shipped assets from the approved artwork (FLUX.1 schnell, Apache-2.0, owner-approved):
//   apps/web/static/aura/aura-2560.webp   desktop image
//   apps/web/static/aura/aura-1280.webp   low tier and phones
//   apps/web/static/aura/aura-data.png    three 960x540 RGB tiles stacked vertically (see AURA_DATA in aura-data.ts):
//     0: form (head + body), head, bright (hair, rims, ribbons)
//     1: hair weight (0 at the scalp, 1 toward the tips), height, figure reveal mask
//     2: normal x, normal y, across the arm (inner 0 .. outer 1, 0 off the arms)
//   apps/web/static/aura/aura-lines.png   four 1920x1080 layers (2x2): distance to the nearest light line, place along it, its weight;
//                                         alpha: the soft halo of all lines
// Run under the host's memory cap:
//   capped 2G -- node scripts/aura-assets.mjs path/to/aura-base5-4k.png
// AURA_SKIP_WEBP=1 skips the images; AURA_PREVIEW=out.png also draws the lines over the artwork for tuning.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "./lib/png.mjs";
/* global OffscreenCanvas, createImageBitmap */

const root = path.resolve(import.meta.dirname, "..");
const src = path.resolve(
  process.argv[2] ??
    path.join(root, ".claude/previews/aura-ref/aura-base5-4k.png"),
);
const outDir = path.join(root, "apps/web/static/aura");
fs.mkdirSync(outDir, { recursive: true });

const png = fs.readFileSync(src);
const img = decodePng(png);

/* ---------- analysis grid: 960x540, a 4x box average of the 3840x2160 original ---------- */
const W = 960;
const H = 540;
const N = W * H;
const S = img.width / W;
const R = new Float32Array(N);
const G = new Float32Array(N);
const B = new Float32Array(N);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const o = ((y * S + j) * img.width + x * S + i) * 4;
        r += img.data[o];
        g += img.data[o + 1];
        b += img.data[o + 2];
      }
    const k = y * W + x;
    R[k] = r / (S * S);
    G[k] = g / (S * S);
    B[k] = b / (S * S);
  }

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function blur(src, radius) {
  // Three box passes per axis approximate a gaussian with sigma about radius.
  const r = Math.max(1, Math.round(radius * 0.9));
  let a = Float32Array.from(src);
  let b = new Float32Array(N);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < H; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++)
        acc += a[y * W + Math.max(0, Math.min(W - 1, x))];
      for (let x = 0; x < W; x++) {
        b[y * W + x] = acc / (2 * r + 1);
        acc +=
          a[y * W + Math.min(W - 1, x + r + 1)] - a[y * W + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++)
        acc += b[Math.max(0, Math.min(H - 1, y)) * W + x];
      for (let y = 0; y < H; y++) {
        a[y * W + x] = acc / (2 * r + 1);
        acc +=
          b[Math.min(H - 1, y + r + 1) * W + x] - b[Math.max(0, y - r) * W + x];
      }
    }
  }
  return a;
}

function flood(seeds, ok, box) {
  const m = new Uint8Array(N);
  const stack = seeds.map(
    ([u, v]) => Math.round(v * H) * W + Math.round(u * W),
  );
  while (stack.length) {
    const k = stack.pop();
    if (k < 0 || k >= N || m[k] || !ok(k)) continue;
    const x = k % W;
    const y = (k / W) | 0;
    if (x < box[0] * W || x > box[2] * W || y < box[1] * H || y > box[3] * H)
      continue;
    m[k] = 1;
    stack.push(k - 1, k + 1, k - W, k + W);
  }
  return m;
}
/** Everything the outside (from the top corners) cannot reach. */
function fillHoles(m) {
  const out = new Uint8Array(N);
  const st = [0, W - 1];
  while (st.length) {
    const k = st.pop();
    if (k < 0 || k >= N || out[k] || m[k]) continue;
    out[k] = 1;
    const x = k % W;
    if (x > 0) st.push(k - 1);
    if (x < W - 1) st.push(k + 1);
    st.push(k - W, k + W);
  }
  return Float32Array.from(out, (v) => (v ? 0 : 1));
}
const threshold = (a, t) => Float32Array.from(a, (v) => (v > t ? 1 : 0));
/** Morphological closing (dilate, then erode) by blurring and re-thresholding: bridges the thin rim lines. */
const close = (m, r) => threshold(blur(threshold(blur(m, r), 0.12), r), 0.88);

/* ---------- segmentation: the dark indigo skin, bounded by the bright rim lines and the hair ---------- */
// Skin is dark indigo (blue well above the black room, little red); rims, hair and ribbons are bright violet.
const skin = (k) => B[k] > 28 && B[k] < 135 && R[k] < 48;
let head = flood(
  [
    [0.5, 0.3],
    [0.47, 0.38],
    [0.53, 0.38],
    [0.5, 0.2],
  ],
  skin,
  [0.4, 0.1, 0.6, 0.47],
);
head = threshold(blur(fillHoles(close(head, 2)), 2), 0.5);
let body = flood(
  [
    [0.5, 0.52],
    [0.5, 0.68],
    [0.5, 0.86],
    [0.44, 0.82],
    [0.56, 0.82],
    [0.35, 0.8],
    [0.65, 0.8],
    [0.35, 0.95],
    [0.65, 0.95],
    [0.4, 0.66],
    [0.6, 0.66],
  ],
  (k) => skin(k) && !head[k],
  [0.24, 0.42, 0.76, 1],
);
body = threshold(blur(close(body, 3), 1.5), 0.5);
// The rim lines along the outline belong to the figure: grow by about their width.
body = Float32Array.from(
  threshold(blur(body, 1.2), 0.25),
  (v, k) => v * (1 - head[k]),
);
head = threshold(blur(head, 1.2), 0.3);

let headCx = 0;
let headCy = 0;
let headN = 0;
let headTop = H;
let headBottom = 0;
for (let k = 0; k < N; k++)
  if (head[k]) {
    const x = k % W;
    const y = (k / W) | 0;
    headCx += x;
    headCy += y;
    headN++;
    headTop = Math.min(headTop, y);
    headBottom = Math.max(headBottom, y);
  }
headCx /= headN;
headCy /= headN;
let headR = 0;
for (let y = 0; y < H; y++) {
  let l = -1;
  let r = -1;
  for (let x = 0; x < W; x++)
    if (head[y * W + x]) {
      if (l < 0) l = x;
      r = x;
    }
  if (l >= 0) headR = Math.max(headR, (r - l + 1) / 2);
}
const rowExtent = (y) => {
  let l = -1;
  let r = -1;
  for (let x = 0; x < W; x++)
    if (body[Math.round(y) * W + x]) {
      if (l < 0) l = x;
      r = x;
    }
  return [l, r];
};
let axis = 0;
let torsoHalf = 0;
{
  let n = 0;
  for (let y = Math.round(0.7 * H); y < 0.95 * H; y++) {
    const [l, r] = rowExtent(y);
    axis += (l + r) / 2;
    torsoHalf += (r - l) / 2;
    n++;
  }
  axis /= n;
  torsoHalf /= n;
}
let shoulderTop = H;
for (let y = Math.round(headBottom); y < H; y++) {
  const [l, r] = rowExtent(y);
  if (r - l > 1.4 * torsoHalf) {
    shoulderTop = y;
    break;
  }
}

/* ---------- bright: what the artwork already lights (hair strands, rims, ribbons) ---------- */
const bright = new Float32Array(N);
for (let k = 0; k < N; k++) {
  const m = Math.max(R[k], G[k], B[k]);
  const lit = Math.max(smooth(55, 120, R[k]), smooth(90, 170, G[k]));
  bright[k] = lit * smooth(70, 150, m);
}

/* ---------- zone and figure: the figure is what the particles build; the rest is the room ---------- */
const ZONE = { cv: 0.55, ru: 0.33, rv: 0.62 };
const zone = new Float32Array(N);
const fig = new Float32Array(N);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const ex = (x - axis) / (ZONE.ru * W);
    const ey = (y - ZONE.cv * H) / (ZONE.rv * H);
    zone[y * W + x] = 1 - smooth(0.78, 1.0, Math.hypot(ex, ey));
  }
{
  const formSoft = blur(
    Float32Array.from(head, (v, k) => Math.max(v, body[k])),
    2,
  );
  const brightSoft = blur(bright, 3);
  for (let k = 0; k < N; k++)
    fig[k] = zone[k] * Math.max(formSoft[k], Math.min(1, brightSoft[k] * 1.6));
}

/* ---------- inflation ---------- */
// A membrane (Poisson, lap u = -1, u = 0 on the contour) is smooth everywhere; sqrt(4u) turns it into a round
// profile: exactly a hemisphere for a disc.
function inflate(mask, openBottom, iterations) {
  const m = Uint8Array.from(mask, (v) => (v > 0.5 ? 1 : 0));
  let x0 = W;
  let x1 = 0;
  let y0 = H;
  let y1 = 0;
  for (let k = 0; k < N; k++)
    if (m[k]) {
      const x = k % W;
      const y = (k / W) | 0;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  const u = new Float32Array(N);
  const get = (x, y) => {
    // Open at the bottom of the frame: the body carries on below it.
    if (y >= H) return openBottom ? u[(H - 1) * W + x] : 0;
    const k = y * W + x;
    return m[k] ? u[k] : 0;
  };
  // Over-relaxed red-black Gauss-Seidel: a few thousand sweeps converge at this size.
  const omega = 1.94;
  for (let it = 0; it < iterations; it++)
    for (let parity = 0; parity < 2; parity++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0 + ((x0 + y + parity) & 1); x <= x1; x += 2) {
          const k = y * W + x;
          if (!m[k]) continue;
          const next =
            (get(x - 1, y) +
              get(x + 1, y) +
              get(x, y - 1) +
              get(x, y + 1) +
              1) /
            4;
          u[k] += omega * (next - u[k]);
        }
  return Float32Array.from(u, (v) => Math.sqrt(Math.max(0, 4 * v)));
}

/* ---------- height: the silhouette inflated into a rounded form, with the breasts ---------- */
const HMAX = 128;
// Breast centres and size from the artwork's own contours (picture units).
// Round, not oval: the same size across and down in pixels, a little fuller below the centre.
const BREASTS = [
  { u: axis / W - 0.056, v: 0.822 },
  { u: axis / W + 0.056, v: 0.822 },
];
const BREAST = { amp: 28, sigma: 0.036 * W };
const headSoft = blur(head, 1);
const hHead = blur(inflate(head, false, 1500), 1.5);
const hBodyRaw = inflate(body, true, 4000);
const hBody = new Float32Array(N);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const k = y * W + x;
    let hb = hBodyRaw[k] * 0.45;
    for (const b of BREASTS) {
      const dx = x - b.u * W;
      const dy = y - b.v * H;
      hb +=
        BREAST.amp *
        Math.exp(-(dx * dx + dy * dy) / (2 * BREAST.sigma * BREAST.sigma)) *
        Math.min(1, hBodyRaw[k] / 30);
    }
    hBody[k] = hb;
  }
const hBodyS = blur(hBody, 1.5);
const height = new Float32Array(N);
for (let k = 0; k < N; k++)
  height[k] = hHead[k] * headSoft[k] + hBodyS[k] * (1 - headSoft[k]);

const nx = new Float32Array(N);
const ny = new Float32Array(N);
const at = (a, x, y) =>
  a[
    Math.max(0, Math.min(H - 1, Math.round(y))) * W +
      Math.max(0, Math.min(W - 1, Math.round(x)))
  ];
/** Bilinear read of a W x H field. */
const sample = (a, x, y) => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  return (
    at(a, x0, y0) * (1 - fx) * (1 - fy) +
    at(a, x0 + 1, y0) * fx * (1 - fy) +
    at(a, x0, y0 + 1) * (1 - fx) * fy +
    at(a, x0 + 1, y0 + 1) * fx * fy
  );
};
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const hx = (at(height, x + 1, y) - at(height, x - 1, y)) / 2;
    const hy = (at(height, x, y + 1) - at(height, x, y - 1)) / 2;
    const l = Math.hypot(hx, hy, 1);
    nx[y * W + x] = -hx / l;
    ny[y * W + x] = hy / l;
  }

/* ---------- the light lines: long, calm curves drawn along the anatomy ---------- */
// Hand-placed Catmull-Rom curves through points measured on the artwork (u from the body's axis, v down), each
// side drawn on its own so the figure never looks mirrored by a machine. They flow into each other: down the
// neck and out along the collarbones, over the shoulder caps and down the arms, around the outer curve and the
// underside of each breast, down the flanks.
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry(20261110);
/** Catmull-Rom through the points (centripetal enough for these gentle curves), sampled every ~0.5 data px. */
function catmull(points) {
  const P = [points[0], ...points, points[points.length - 1]];
  const out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(4, Math.ceil(seg / 0.5));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const c = (a, b, cc, d) =>
        0.5 *
        (2 * b +
          (-a + cc) * t +
          (2 * a - 5 * b + 4 * cc - d) * t2 +
          (-a + 3 * b - 3 * cc + d) * t3);
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
const toPx = ([du, v]) => [axis + du * W, v * H];
/** A finer companion strand beside a line, over part of its length, as light lines come in bundles. */
function companion(pts, offset, from, to) {
  const a = Math.floor(pts.length * from);
  const b = Math.floor(pts.length * to);
  const out = [];
  for (let i = a; i < b; i++) {
    const p0 = pts[Math.max(0, i - 2)];
    const p1 = pts[Math.min(pts.length - 1, i + 2)];
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const l = Math.hypot(dx, dy) || 1;
    // The gap breathes along the strand.
    const k = offset * (0.8 + 0.4 * Math.sin((i - a) * 0.02));
    out.push([pts[i][0] - (dy / l) * k, pts[i][1] + (dx / l) * k]);
  }
  return out;
}

// The composition, as families of lines generated per side (each side with its own random draw, so the figure is
// never mirrored by a machine). Points are [u from the body's axis, v], side = -1 (her right, our left) or 1.
const j = (a) => (rand() - 0.5) * 2 * a;
const lerp = (a, b, t) => a + (b - a) * t;
// A circle in pixels: rx (widths) * 16 = ry (heights) * 9.
const BUST = { du: 0.056, v: 0.818, rx: 0.047, ry: 0.0836 };
const strokes = [];
const add = (ctrl, weight, opts = {}) =>
  strokes.push({
    pts: catmull(ctrl.map(toPx)),
    weight,
    face: false,
    warm: !!opts.warm,
    hair: !!opts.hair,
  });
// The inner edge of each arm, where it parts from the torso (measured on the artwork's inner rim).
const ARM_INNER = [
  [0.128, 0.745],
  [0.12, 0.8],
  [0.116, 0.86],
  [0.113, 0.93],
  [0.111, 1.0],
];
const armInnerAt = (v) => {
  if (v <= ARM_INNER[0][1]) return ARM_INNER[0][0];
  for (let i = 1; i < ARM_INNER.length; i++)
    if (v <= ARM_INNER[i][1]) {
      const [a, va] = ARM_INNER[i - 1];
      const [b, vb] = ARM_INNER[i];
      return a + ((b - a) * (v - va)) / (vb - va);
    }
  return ARM_INNER[ARM_INNER.length - 1][0];
};
const bundle = (ctrl, weight, n, spread, opts = {}) => {
  const pts = catmull(ctrl.map(toPx));
  strokes.push({ pts, weight, face: false, warm: !!opts.warm });
  for (let i = 0; i < n; i++) {
    const from = 0.05 + 0.25 * rand();
    strokes.push({
      pts: companion(
        pts,
        (i % 2 ? 1 : -1) * spread * (0.6 + 0.4 * (i + 1) + 0.3 * rand()),
        from,
        Math.min(0.97, from + 0.4 + 0.45 * rand()),
      ),
      weight: 0.22 + 0.18 * rand(),
      face: false,
      warm: opts.warmEvery ? i % opts.warmEvery === 0 : false,
    });
  }
};
for (const side of [-1, 1]) {
  const s = (du) => side * du;
  // Neck: fine strands down its sides that turn out along the collarbones.
  for (let i = 0; i < 4; i++) {
    const k = i / 3;
    add(
      [
        [s(lerp(0.012, 0.034, k) + j(0.003)), 0.46 + 0.03 * k + j(0.01)],
        [s(lerp(0.016, 0.037, k)), 0.52],
        [s(lerp(0.026, 0.046, k)), 0.568 + j(0.005)],
        [s(lerp(0.06, 0.09, k)), 0.602 + 0.01 * k],
        [s(lerp(0.1, 0.14, k) + j(0.01)), 0.618 + 0.012 * k],
      ],
      i === 1 ? 0.75 : 0.3 + 0.2 * rand(),
    );
  }
  // The shoulder: one smooth deltoid curve from the collarbone over the cap into the upper arm, and a fainter one
  // inside it. No pile of lines here: the arms read as limbs by their rims, not by strokes.
  add(
    [
      [s(0.012), 0.606],
      [s(0.058), 0.614],
      [s(0.106), 0.617],
      [s(0.143), 0.627],
      [s(0.162), 0.655],
      [s(0.169), 0.7],
      [s(0.171), 0.75],
    ],
    1.0,
  );
  add(
    [
      [s(0.09), 0.63],
      [s(0.128), 0.638],
      [s(0.15), 0.662],
      [s(0.158), 0.7],
    ],
    0.32,
  );
  // Each arm: a clean rim along its outer and inner edges (the inner one leaves a dark gap to the torso), and a
  // few thin, quiet lines along its length.
  {
    const outer = [];
    for (let v = 0.665; v <= 1.0001; v += 0.045) {
      const [l, r] = rowExtent(Math.min(H - 1, v * H));
      const du = (side < 0 ? axis - l : r - axis) / W - 0.004;
      outer.push([s(du), v]);
    }
    add(outer, 0.55);
    const inner = ARM_INNER.map(([du, v]) => [s(du), v]);
    add(inner, 0.42);
    for (let i = 0; i < 3; i++) {
      const a = 0.3 + 0.24 * i + j(0.03);
      const along = [];
      for (let k = 0; k < outer.length; k++) {
        const v = outer[k][1];
        if (v < 0.72 + 0.03 * i) continue;
        const inDu = armInnerAt(v);
        along.push([s(inDu + (Math.abs(outer[k][0]) - inDu) * a), v]);
      }
      add(along, 0.18 + 0.12 * rand());
    }
  }
  // The torso's sides, inside the gap to the arms: two calm lines toward the waist.
  for (let i = 0; i < 2; i++) {
    add(
      [
        [s(0.098 - 0.012 * i), 0.82 + 0.03 * i],
        [s(0.096 - 0.012 * i), 0.9],
        [s(0.09 - 0.012 * i), 1.0],
      ],
      0.3 + 0.2 * rand(),
    );
  }
  // Light strands of the hair: from the parting, combed over the skull, past the temples and ears, and down into
  // the long hair, so crown and lengths read as one flow.
  for (let i = 0; i < 5; i++) {
    const k = i / 4;
    add(
      [
        [s(0.004 + 0.006 * k), 0.104 + 0.006 * k],
        [s(0.034 + 0.01 * k), 0.116 + 0.006 * k],
        [s(0.062 + 0.008 * k), 0.17 + 0.02 * k],
        [s(0.072 + 0.01 * k), 0.26 + 0.02 * k],
        [s(0.078 + 0.018 * k + j(0.004)), 0.38 + 0.03 * k],
        [s(0.09 + 0.05 * k + j(0.01)), 0.52 + 0.05 * k],
      ],
      0.16 + 0.12 * rand(),
      { hair: true },
    );
  }
  // The chest, the figure's centre after the face. Long sweeps leave the collarbones and the shoulders, run down
  // over the top of each breast and around its outer curve into the underside, each with fine companions; they
  // gather softly at the sternum and part again toward the ribs.
  const BX = s(BUST.du);
  const around = (r, a0, a1, dv = 0) => {
    const out = [];
    for (let a = a0; a <= a1 + 1e-6; a += (a1 - a0) / 7) {
      const t = (a * Math.PI) / 180;
      out.push([
        BX + side * BUST.rx * r * Math.cos(t),
        BUST.v + dv + BUST.ry * r * Math.sin(t),
      ]);
    }
    return out;
  };
  // Main sweep: from beside the sternum over the breast, around it and into the underside, toward the centre.
  bundle(
    [
      [s(0.008), 0.612],
      [s(0.022), 0.672],
      ...around(1.02, -88, 118, 0.004).slice(1),
      [s(0.012), 0.905],
    ],
    0.85,
    4,
    3.4,
    { warmEvery: 2 },
  );
  // Sweeps from the shoulder: down across the upper chest and around the outside of the bust.
  for (let i = 0; i < 3; i++) {
    const k = i / 2;
    bundle(
      [
        [s(lerp(0.12, 0.15, k)), 0.628 + 0.01 * k],
        [s(lerp(0.09, 0.11, k)), 0.67 + 0.01 * k],
        [s(lerp(0.075, 0.1, k) + j(0.004)), 0.72 + 0.01 * k],
        ...around(lerp(0.96, 1.08, k), -60 + 15 * k, lerp(70, 40, k), 0.006),
      ],
      i === 0 ? 0.8 : 0.45 + 0.2 * rand(),
      i === 0 ? 2 : 1,
      3,
      { warm: i === 1 },
    );
  }
  // Contour arcs that follow the volume: never closed, at different radii and sweeps, each a touch lower and
  // further out than the last; the undersides brightest (they carry the volume) and often warm.
  // (No short arcs over the top: on a blank figure they would read as closed eyes.)
  for (let i = 0; i < 7; i++) {
    const kind = i < 3 ? "outer" : "under";
    const r =
      kind === "top"
        ? lerp(0.62, 0.85, rand())
        : lerp(
            0.5,
            0.9,
            (kind === "outer" ? i : i - 3) / (kind === "outer" ? 2 : 3),
          ) *
          (0.95 + 0.1 * rand());
    const [a0, a1] =
      kind === "outer"
        ? [lerp(-80, -35, rand()), lerp(60, 95, rand())]
        : kind === "under"
          ? [lerp(20, 45, rand()), lerp(110, 140, rand())]
          : [lerp(-135, -115, rand()), lerp(-80, -60, rand())];
    const arc = around(
      r,
      a0,
      a1,
      (0.9 - r) * 0.05 + (kind === "under" ? 0.006 : 0),
    );
    const bright =
      kind === "under"
        ? 0.7 + 0.25 * rand()
        : kind === "top"
          ? 0.35 + 0.2 * rand()
          : r > 0.85
            ? 0.65 + 0.3 * rand()
            : 0.22 + 0.25 * rand();
    add(arc, bright, {
      warm:
        (kind === "under" && rand() < 0.5) ||
        (kind === "outer" && rand() < 0.25),
    });
  }
  // From the collarbones down toward the sternum, where they gather softly, then part toward the ribs and waist.
  for (let i = 0; i < 5; i++) {
    const k = i / 4;
    add(
      [
        [s(lerp(0.02, 0.11, k) + j(0.008)), 0.618 + 0.015 * k],
        [s(lerp(0.014, 0.04, k)), 0.68 + 0.02 * k],
        [s(lerp(0.005, 0.012, k) + j(0.002)), 0.76 + 0.02 * k],
        [s(lerp(0.008, 0.022, k)), 0.86 + 0.01 * k],
        [s(lerp(0.02, 0.07, k) + j(0.003)), 0.97 + 0.03 * k],
      ],
      i === 1 ? 0.7 : 0.22 + 0.28 * rand(),
      { warm: i === 3 },
    );
  }
  // From under the breast down over the ribs.
  for (let i = 0; i < 3; i++) {
    const k = i / 2;
    add(
      [
        [s(lerp(0.035, 0.095, k)), 0.885 + j(0.004)],
        [s(lerp(0.04, 0.09, k)), 0.93],
        [s(lerp(0.035, 0.1, k) + j(0.008)), 1.0],
      ],
      0.25 + 0.35 * rand(),
    );
  }
}
// The blank face: a dozen faint, fine lines that follow the head's round form (temples over the cheek planes to
// the jaw, a soft arc high on the brow, strands along the jaw into the neck, arcs under the hairline). Never a
// feature, never a closed shape, never a seam down the middle.
{
  const hu = (u) => headCx + u * headR;
  const hv = (v) => headTop + v * (headBottom - headTop);
  const face = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const o = i * 0.07 + j(0.015);
      face.push([
        [side * (0.88 - o), 0.18 + 0.05 * i],
        [side * (0.9 - o * 1.2), 0.42 + 0.03 * i],
        [side * (0.8 - o * 1.4), 0.66 + 0.02 * i],
        [side * (0.56 - o), 0.86 + 0.02 * i],
        [side * (0.36 - o * 0.6), 0.94],
      ]);
    }
    face.push([
      [side * 0.72, 0.74],
      [side * 0.5, 0.9],
      [side * 0.28, 0.985],
      [side * 0.3, 1.1],
      [side * 0.36, 1.22],
    ]);
  }
  // Under the hairline, high on the forehead: one long arc, open at both ends.
  face.push([
    [-0.66, 0.17],
    [-0.25, 0.105],
    [0.22, 0.1],
    [0.62, 0.15],
  ]);
  for (const ctrl of face)
    strokes.push({
      pts: catmull(ctrl.map(([u, v]) => [hu(u), hv(v)])),
      weight: 0.28 + 0.1 * rand(),
      face: true,
      warm: false,
    });
}
// Star points where lines meet.
const stars = [
  [0, 0.608],
  [-0.147, 0.636],
  [0.15, 0.64],
  [-0.006, 0.77],
  [0.03, 0.9],
  [-0.103, 0.81],
  [0.09, 0.72],
].map(toPx);

/* ---------- the lines raster: four 1920x1080 layers in a 2x2 sheet, each the nearest of its own lines ---------- */
// Lines that cross or run close go to different layers, so each keeps its whole glow (one nearest-line field would
// cut a glow off where another line takes over).
const LW = 1920;
const LH = 1080;
const LAYERS = 4;
const LSCALE = LW / W;
const DMAXL = 40;
const lineD = new Float32Array(LW * LH * LAYERS).fill(DMAXL);
const lineT = new Float32Array(LW * LH * LAYERS);
const lineId = new Int16Array(LW * LH * LAYERS).fill(-1);
// Each line takes the layer whose nearest line already there is farthest from it.
const sampleOf = (st) => st.pts.filter((_, i) => i % 6 === 0);
const gap = (a, b) => {
  let m = Infinity;
  for (const p of sampleOf(a))
    for (const q of sampleOf(b))
      m = Math.min(m, Math.hypot(p[0] - q[0], p[1] - q[1]));
  return m;
};
strokes.forEach((s, id) => {
  let best = 0;
  let bestGap = -1;
  for (let l = 0; l < LAYERS; l++) {
    let g = Infinity;
    for (let j = 0; j < id; j++)
      if (strokes[j].layer === l) g = Math.min(g, gap(s, strokes[j]));
    if (g > bestGap) {
      bestGap = g;
      best = l;
    }
  }
  s.layer = best;
});
strokes.forEach((s, id) => {
  const layer = s.layer;
  const pts = s.pts.map(([x, y]) => [x * LSCALE, y * LSCALE]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(
      cum[i - 1] +
        Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]),
    );
  const total = cum[cum.length - 1] || 1;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const sx = bx - ax;
    const sy = by - ay;
    const sl = sx * sx + sy * sy || 1e-9;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - DMAXL));
    const x1 = Math.min(LW - 1, Math.ceil(Math.max(ax, bx) + DMAXL));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - DMAXL));
    const y1 = Math.min(LH - 1, Math.ceil(Math.max(ay, by) + DMAXL));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (px * sx + py * sy) / sl));
        const d = Math.hypot(px - t * sx, py - t * sy);
        const k = (layer * LH + y) * LW + x;
        if (d < lineD[k]) {
          lineD[k] = d;
          lineT[k] = (cum[i - 1] + t * Math.sqrt(sl)) / total;
          lineId[k] = id;
        }
      }
  }
});
// The lines' soft halo, summed over all lines (so it never cuts off where one layer's nearest line changes):
// each line deposits its weight along its length, tapered at the ends, then the sum is blurred.
const glowSum = new Float32Array(N);
for (const st of strokes) {
  const n = st.pts.length;
  st.pts.forEach(([x, y], i) => {
    const tt = i / Math.max(1, n - 1);
    const dep =
      st.weight *
      Math.pow(Math.max(0, Math.sin(Math.PI * tt)), 0.55) *
      (st.face ? 0.3 : 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    for (const [dx, dy, wgt] of [
      [0, 0, (1 - fx) * (1 - fy)],
      [1, 0, fx * (1 - fy)],
      [0, 1, (1 - fx) * fy],
      [1, 1, fx * fy],
    ]) {
      const xx = x0 + dx;
      const yy = y0 + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H)
        glowSum[yy * W + xx] += dep * wgt * 0.5;
    }
  });
}
const glow = blur(glowSum, 6);
const GLOW_SCALE = 0.35;
const SW = LW * 2;
const lines = new Uint8Array(SW * LH * 2 * 4);
for (let layer = 0; layer < LAYERS; layer++)
  for (let y = 0; y < LH; y++)
    for (let x = 0; x < LW; x++) {
      const k = (layer * LH + y) * LW + x;
      const o =
        ((Math.floor(layer / 2) * LH + y) * SW + (layer % 2) * LW + x) * 4;
      const id = lineId[k];
      lines[o] = Math.round((Math.min(lineD[k], DMAXL) / DMAXL) * 255);
      lines[o + 1] = id < 0 ? 0 : Math.round(lineT[k] * 255);
      // The line's weight (width and brightness, 6 bits), whether it runs warm, whether it lies on the face.
      const st = strokes[Math.max(0, id)];
      lines[o + 2] =
        id < 0
          ? 0
          : (1 + Math.min(62, Math.round(st.weight * 41))) * 4 +
            (st.warm ? 2 : 0) +
            (st.face ? 1 : 0);
      // Alpha: the summed halo (the same in every layer).
      lines[o + 3] = Math.round(
        clamp01(
          sample(glow, (x + 0.5) / LSCALE - 0.5, (y + 0.5) / LSCALE - 0.5) *
            GLOW_SCALE,
        ) * 255,
      );
    }
fs.writeFileSync(
  path.join(outDir, "aura-lines.png"),
  encodePng(
    SW,
    LH * 2,
    lines,
    4,
    JSON.stringify({
      lines: strokes.length,
      faceLines: strokes.filter((st) => st.face).length,
    }),
  ),
);

/* ---------- write the data atlas ---------- */
const atlas = new Uint8Array(W * H * 3 * 3);
const put = (tile, k, a, b, c) => {
  const o = (tile * N + k) * 3;
  atlas[o] = Math.round(clamp01(a) * 255);
  atlas[o + 1] = Math.round(clamp01(b) * 255);
  atlas[o + 2] = Math.round(clamp01(c) * 255);
};
const headFinal = blur(head, 0.8);
const bodyFinal = blur(body, 0.8);
// Hair weight: 0 at the scalp (roots, parting, crown), rising toward the tips with the distance from the head;
// only where there is hair (a wide, soft region around the bright strands), never on the body.
const hairW = new Float32Array(N);
{
  // Chamfer distance (data px) to the head.
  const dist = Float32Array.from(head, (v) => (v > 0.5 ? 0 : 1e9));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (x > 0) dist[k] = Math.min(dist[k], dist[k - 1] + 1);
      if (y > 0) dist[k] = Math.min(dist[k], dist[k - W] + 1);
      if (x > 0 && y > 0) dist[k] = Math.min(dist[k], dist[k - W - 1] + 1.414);
      if (x < W - 1 && y > 0)
        dist[k] = Math.min(dist[k], dist[k - W + 1] + 1.414);
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const k = y * W + x;
      if (x < W - 1) dist[k] = Math.min(dist[k], dist[k + 1] + 1);
      if (y < H - 1) dist[k] = Math.min(dist[k], dist[k + W] + 1);
      if (x < W - 1 && y < H - 1)
        dist[k] = Math.min(dist[k], dist[k + W + 1] + 1.414);
      if (x > 0 && y < H - 1)
        dist[k] = Math.min(dist[k], dist[k + W - 1] + 1.414);
    }
  const region = blur(bright, 10);
  const bodyNear = blur(body, 4);
  for (let k = 0; k < N; k++) {
    const w = smooth(0, 1, Math.min(1, dist[k] / (0.24 * W)));
    hairW[k] =
      w * Math.min(1, region[k] * 3) * (1 - Math.min(1, bodyNear[k] * 1.5));
  }
}
// Across each arm: 0 at its inner edge, 1 at its outer edge (0 off the arms); for the sheen down its length.
const armX = new Float32Array(N);
for (let y = Math.round(0.68 * H); y < H; y++) {
  const v = y / H;
  const [l, r] = rowExtent(y);
  const inner = armInnerAt(v) * W;
  for (const side of [-1, 1]) {
    const outer = side < 0 ? axis - l : r - axis;
    for (let x = 0; x < W; x++) {
      const du = side * (x - axis);
      if (du < inner || du > outer) continue;
      const k = y * W + x;
      armX[k] =
        Math.max(1 / 255, (du - inner) / Math.max(1, outer - inner)) *
        smooth(0.68, 0.74, v) *
        body[k];
    }
  }
}
for (let k = 0; k < N; k++) {
  put(0, k, Math.max(headFinal[k], bodyFinal[k]), headFinal[k], bright[k]);
  put(1, k, hairW[k], height[k] / HMAX, fig[k]);
  put(2, k, 0.5 + nx[k] * 0.5, 0.5 + ny[k] * 0.5, armX[k]);
}
fs.writeFileSync(
  path.join(outDir, "aura-data.png"),
  encodePng(W, H * 3, atlas),
);

const r4 = (v) => +v.toFixed(4);
console.log(
  JSON.stringify({
    axis: r4(axis / W),
    head: {
      cx: r4(headCx / W),
      cy: r4(headCy / H),
      top: r4(headTop / H),
      bottom: r4(headBottom / H),
      radius: r4(headR / W),
    },
    torsoHalf: r4(torsoHalf / W),
    shoulderTop: r4(shoulderTop / H),
    hmax: HMAX,
    lines: strokes.length,
    stars: stars.map(([x, y]) => [r4(x / W), r4(y / H)]),
    heightMax: +height.reduce((a, b) => Math.max(a, b)).toFixed(1),
  }),
);

/* ---------- optional preview: the lines over the artwork, for tuning by eye ---------- */
if (process.env.AURA_PREVIEW) {
  const out = new Uint8Array(LW * LH * 3);
  for (let y = 0; y < LH; y++)
    for (let x = 0; x < LW; x++) {
      const k = y * LW + x;
      const o =
        (Math.floor((y / LH) * img.height) * img.width +
          Math.floor((x / LW) * img.width)) *
        4;
      let best = 0;
      for (let l = 1; l < LAYERS; l++)
        if (lineD[l * LW * LH + k] < lineD[best * LW * LH + k]) best = l;
      const kk = best * LW * LH + k;
      const d = lineD[kk];
      const s = strokes[lineId[kk]];
      const t = lineT[kk];
      const taper = Math.pow(
        Math.sin(Math.PI * Math.min(1, Math.max(0, t))),
        0.5,
      );
      const w = (s ? s.weight : 0) * taper;
      const core = Math.exp(-Math.pow(d / (1.2 * w + 0.3), 2)) * w;
      const glow = Math.exp(-Math.pow(d / (5 * w + 0.5), 2)) * 0.5 * w;
      out[k * 3] = Math.min(255, img.data[o] + core * 255 + glow * 230);
      out[k * 3 + 1] = Math.min(255, img.data[o + 1] + core * 235 + glow * 60);
      out[k * 3 + 2] = Math.min(255, img.data[o + 2] + core * 255 + glow * 240);
    }
  for (const [sx, sy] of stars)
    for (let j = -3; j <= 3; j++)
      for (let i = -3; i <= 3; i++) {
        const k =
          (Math.round(sy * LSCALE) + j) * LW + Math.round(sx * LSCALE) + i;
        if (k >= 0 && k < LW * LH && (i === 0 || j === 0))
          out.fill(255, k * 3, k * 3 + 3);
      }
  fs.writeFileSync(process.env.AURA_PREVIEW, encodePng(LW, LH, out));
}

/* ---------- the images: WebP from the browser's own encoder (no native image tools on the host) ---------- */
if (!process.env.AURA_SKIP_WEBP) {
  const browser = await chromium.launch({ args: ["--disable-gpu"] });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    const b64 = png.toString("base64");
    for (const [width, quality] of [
      [2560, 0.9],
      [1280, 0.9],
    ]) {
      const out = await page.evaluate(
        async ({ b64, width, quality }) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(
            new Blob([bytes], { type: "image/png" }),
          );
          const h = Math.round((bmp.height * width) / bmp.width);
          const c = new OffscreenCanvas(width, h);
          const g = c.getContext("2d");
          g.imageSmoothingEnabled = true;
          g.imageSmoothingQuality = "high";
          g.drawImage(bmp, 0, 0, width, h);
          const blob = await c.convertToBlob({ type: "image/webp", quality });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let s = "";
          for (let i = 0; i < buf.length; i += 0x8000)
            s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          return btoa(s);
        },
        { b64, width, quality },
      );
      const file = path.join(outDir, `aura-${width}.webp`);
      fs.writeFileSync(file, Buffer.from(out, "base64"));
      console.log(file, fs.statSync(file).size);
    }
  } finally {
    await browser.close();
  }
}
