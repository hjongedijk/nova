// Builds the Aura figure's shipped assets from the approved artwork (FLUX.1 schnell, Apache-2.0, owner-approved):
//   apps/web/static/aura/aura-2560.webp   desktop image
//   apps/web/static/aura/aura-1280.webp   low tier and phones
//   apps/web/static/aura/aura-data.png    three 960x540 RGB tiles stacked vertically (see AURA_DATA in aura-data.ts):
//     0: form (head + body), head, bright (hair, rims, ribbons)
//     1: figure zone, height, figure reveal mask
//     2: normal x, normal y, (unused)
//   apps/web/static/aura/aura-lines.png   three 1920x1080 layers: distance to the nearest light line, place along it, which line
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
const BREASTS = [
  { u: axis / W - 0.06, v: 0.815 },
  { u: axis / W + 0.06, v: 0.815 },
];
const BREAST = { amp: 26, sigma: 0.034 * W };
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
const L = [
  // neck: down its side, out along the collarbone
  {
    w: 0.7,
    l: [
      [-0.022, 0.462],
      [-0.026, 0.51],
      [-0.036, 0.558],
      [-0.07, 0.6],
      [-0.118, 0.62],
    ],
  },
  {
    w: 0.65,
    r: [
      [0.022, 0.472],
      [0.027, 0.52],
      [0.039, 0.565],
      [0.078, 0.604],
      [0.114, 0.622],
    ],
  },
  // collarbone over the shoulder cap and down the outer arm
  {
    w: 1,
    l: [
      [-0.012, 0.604],
      [-0.055, 0.613],
      [-0.104, 0.614],
      [-0.144, 0.624],
      [-0.163, 0.655],
      [-0.17, 0.71],
      [-0.172, 0.8],
    ],
  },
  {
    w: 0.95,
    r: [
      [0.014, 0.606],
      [0.06, 0.615],
      [0.108, 0.617],
      [0.146, 0.628],
      [0.164, 0.66],
      [0.17, 0.72],
      [0.173, 0.83],
    ],
  },
  // a second line over the shoulder, down the front of the arm
  {
    w: 0.6,
    l: [
      [-0.088, 0.618],
      [-0.13, 0.628],
      [-0.151, 0.665],
      [-0.157, 0.75],
      [-0.158, 0.88],
    ],
  },
  {
    w: 0.55,
    r: [
      [0.1, 0.622],
      [0.134, 0.634],
      [0.152, 0.672],
      [0.158, 0.77],
      [0.16, 0.9],
    ],
  },
  // from the sternum, over the top of the breast and around its outer curve to its underside
  {
    w: 0.9,
    l: [
      [-0.006, 0.605],
      [-0.028, 0.665],
      [-0.068, 0.722],
      [-0.104, 0.752],
      [-0.12, 0.802],
      [-0.106, 0.852],
      [-0.068, 0.878],
    ],
  },
  {
    w: 0.85,
    r: [
      [0.008, 0.612],
      [0.032, 0.672],
      [0.072, 0.726],
      [0.106, 0.758],
      [0.12, 0.808],
      [0.104, 0.856],
      [0.066, 0.877],
    ],
  },
  // the soft arc under each breast, meeting at the centre
  {
    w: 0.6,
    l: [
      [-0.119, 0.832],
      [-0.1, 0.87],
      [-0.07, 0.886],
      [-0.04, 0.887],
    ],
  },
  {
    w: 0.55,
    r: [
      [0.116, 0.84],
      [0.098, 0.874],
      [0.068, 0.888],
    ],
  },
  // flanks: from under the arm toward the waist
  {
    w: 0.8,
    l: [
      [-0.128, 0.75],
      [-0.133, 0.83],
      [-0.124, 0.92],
      [-0.11, 1.0],
    ],
  },
  {
    w: 0.75,
    r: [
      [0.127, 0.77],
      [0.132, 0.85],
      [0.122, 0.93],
      [0.111, 1.0],
    ],
  },
  // long lines on the upper arms
  {
    w: 0.55,
    l: [
      [-0.145, 0.69],
      [-0.15, 0.78],
      [-0.147, 0.89],
      [-0.141, 0.99],
    ],
  },
  {
    w: 0.5,
    r: [
      [0.147, 0.72],
      [0.151, 0.81],
      [0.148, 0.92],
    ],
  },
  // from under each breast down the belly
  {
    w: 0.55,
    l: [
      [-0.074, 0.889],
      [-0.06, 0.92],
      [-0.056, 0.96],
      [-0.064, 1.0],
    ],
  },
  {
    w: 0.5,
    r: [
      [0.07, 0.892],
      [0.058, 0.925],
      [0.055, 0.965],
      [0.062, 1.0],
    ],
  },
  // more light over the shoulders and down the arms, like a bundle of strands
  {
    w: 0.45,
    l: [
      [-0.06, 0.628],
      [-0.11, 0.636],
      [-0.14, 0.652],
      [-0.154, 0.7],
      [-0.16, 0.76],
    ],
  },
  {
    w: 0.42,
    r: [
      [0.07, 0.632],
      [0.116, 0.642],
      [0.143, 0.66],
      [0.156, 0.71],
      [0.162, 0.78],
    ],
  },
  {
    w: 0.5,
    l: [
      [-0.168, 0.74],
      [-0.17, 0.85],
      [-0.167, 0.95],
      [-0.162, 1.0],
    ],
  },
  {
    w: 0.48,
    r: [
      [0.169, 0.76],
      [0.172, 0.87],
      [0.17, 0.97],
    ],
  },
  // from the collarbones down over the top of each breast
  {
    w: 0.55,
    l: [
      [-0.04, 0.62],
      [-0.06, 0.67],
      [-0.085, 0.72],
      [-0.11, 0.765],
    ],
  },
  {
    w: 0.5,
    r: [
      [0.046, 0.624],
      [0.066, 0.676],
      [0.09, 0.728],
      [0.112, 0.772],
    ],
  },
  // a long flank line from the armpit, curving in under the breast toward the waist
  {
    w: 0.55,
    l: [
      [-0.137, 0.7],
      [-0.14, 0.78],
      [-0.128, 0.86],
      [-0.1, 0.93],
      [-0.088, 1.0],
    ],
  },
  {
    w: 0.5,
    r: [
      [0.138, 0.71],
      [0.14, 0.8],
      [0.127, 0.875],
      [0.1, 0.94],
      [0.09, 1.0],
    ],
  },
  // a faint line down the centre
  {
    w: 0.4,
    l: [
      [0.003, 0.635],
      [-0.003, 0.7],
      [0.002, 0.77],
      [0, 0.835],
    ],
  },
];
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
const strokes = [];
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
for (const s of L) {
  const pts = catmull((s.l ?? s.r).map(toPx));
  strokes.push({ pts, weight: s.w * (0.9 + 0.2 * rand()), face: false });
  if (s.w >= 0.7) {
    const side = s.l ? 1 : -1;
    const from = 0.08 + 0.2 * rand();
    strokes.push({
      pts: companion(
        pts,
        side * (4 + 3 * rand()),
        from,
        Math.min(0.97, from + 0.45 + 0.3 * rand()),
      ),
      weight: 0.32 + 0.12 * rand(),
      face: false,
    });
  }
}
// On the blank face only a few faint lines: down from each temple toward the jaw, and a short one at the centre.
{
  const hu = (u) => headCx + u * headR;
  const hv = (v) => headTop + v * (headBottom - headTop);
  const face = [
    [
      [hu(-0.8), hv(0.22)],
      [hu(-0.86), hv(0.5)],
      [hu(-0.72), hv(0.75)],
      [hu(-0.38), hv(0.93)],
    ],
    [
      [hu(0.82), hv(0.32)],
      [hu(0.85), hv(0.55)],
      [hu(0.68), hv(0.78)],
      [hu(0.46), hv(0.88)],
    ],
    [
      [hu(0.02), hv(0.1)],
      [hu(-0.03), hv(0.28)],
      [hu(0.01), hv(0.48)],
    ],
  ];
  for (const ctrl of face)
    strokes.push({ pts: catmull(ctrl), weight: 0.32, face: true });
}
// Star points where lines meet.
const stars = [
  [0, 0.606],
  [-0.146, 0.635],
  [0.15, 0.64],
  [-0.07, 0.6],
  [0.078, 0.604],
  [-0.12, 0.8],
].map(toPx);

/* ---------- the lines raster: three 1920x1080 layers, each the nearest of its own lines ---------- */
// Line i goes to layer i % 3, so lines that cross or run close lie in different layers and each keeps its whole
// glow (one nearest-line field would cut a glow off where another line takes over).
const LW = 1920;
const LH = 1080;
const LAYERS = 3;
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
const lines = new Uint8Array(LW * LH * LAYERS * 3);
for (let k = 0; k < LW * LH * LAYERS; k++) {
  const id = lineId[k];
  lines[k * 3] = Math.round((Math.min(lineD[k], DMAXL) / DMAXL) * 255);
  lines[k * 3 + 1] = id < 0 ? 0 : Math.round(lineT[k] * 255);
  // Which line (for its own width and brightness), and whether it lies on the face (faint there).
  lines[k * 3 + 2] =
    id < 0 ? 0 : ((id % 62) + 1) * 4 + (strokes[id].face ? 2 : 0);
}
fs.writeFileSync(
  path.join(outDir, "aura-lines.png"),
  encodePng(LW, LH * LAYERS, lines),
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
for (let k = 0; k < N; k++) {
  put(0, k, Math.max(headFinal[k], bodyFinal[k]), headFinal[k], bright[k]);
  put(1, k, zone[k], height[k] / HMAX, fig[k]);
  put(2, k, 0.5 + nx[k] * 0.5, 0.5 + ny[k] * 0.5, 0);
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
