// Builds the Aura figure's shipped assets from the approved artwork (FLUX.1 schnell, Apache-2.0, owner-approved):
//   apps/web/static/aura/aura-2560.webp   desktop image
//   apps/web/static/aura/aura-1280.webp   low tier and phones
//   apps/web/static/aura/aura-data.png    three 960x540 RGB tiles stacked vertically (see AURA_DATA in aura-data.ts):
//     0: form (head + body), head, bright (hair, cyan line, ribbons)
//     1: stripe offset (arc length minus x), height, figure reveal mask
//     2: normal x, normal y, figure zone
// Run under the host's memory cap:  capped 2G -- node scripts/aura-assets.mjs [path/to/aura-base-4k.png]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "./lib/png.mjs";
/* global OffscreenCanvas, createImageBitmap */

const root = path.resolve(import.meta.dirname, "..");
const src = path.resolve(
  process.argv[2] ??
    path.join(root, ".claude/previews/aura-ref/aura-base-4k.png"),
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

/* ---------- head: the dark blank face, flood-filled from its centre and bounded by the bright hair ---------- */
const head = new Float32Array(N);
{
  const box = [0.38 * W, 0.12 * H, 0.62 * W, 0.6 * H];
  const dark = (k) => Math.max(R[k], G[k], B[k]) < 60;
  const stack = [Math.round(0.3 * H) * W + Math.round(0.49 * W)];
  while (stack.length) {
    const k = stack.pop();
    if (head[k] || !dark(k)) continue;
    const x = k % W;
    const y = (k / W) | 0;
    if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
    head[k] = 1;
    stack.push(k - 1, k + 1, k - W, k + W);
  }
  // Fill holes (the shading of the nose): everything the outside cannot reach is head.
  const outside = new Uint8Array(N);
  const st = [0];
  while (st.length) {
    const k = st.pop();
    if (k < 0 || k >= N || outside[k] || head[k]) continue;
    outside[k] = 1;
    const x = k % W;
    if (x > 0) st.push(k - 1);
    if (x < W - 1) st.push(k + 1);
    st.push(k - W, k + W);
  }
  for (let k = 0; k < N; k++) head[k] = outside[k] ? 0 : 1;
}
// A clean contour: blur and re-threshold (a morphological smoothing), then a soft 1 px edge.
{
  const b = blur(head, 4);
  for (let k = 0; k < N; k++) head[k] = b[k] > 0.5 ? 1 : 0;
}
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

/* ---------- body: neck and torso, fitted to the faint rim light of the shoulders ---------- */
// The arms are as dark as the room; only a thin rim marks them. Measure that rim on the lower rows, mirror it.
const blurB = blur(B, 2);
const rimRows = [];
for (let y = Math.round(0.78 * H); y < H - 2; y++) {
  let best = -1;
  let at = -1;
  for (let x = Math.round(0.27 * W); x < 0.36 * W; x++)
    if (blurB[y * W + x] > best && R[y * W + x] < 60) {
      best = blurB[y * W + x];
      at = x;
    }
  let bestR = -1;
  let atR = -1;
  for (let x = Math.round(0.68 * W); x < 0.77 * W; x++)
    if (blurB[y * W + x] > bestR && R[y * W + x] < 60) {
      bestR = blurB[y * W + x];
      atR = x;
    }
  rimRows.push([at, atR]);
}
const leftEdge = rimRows.reduce((s, r) => s + r[0], 0) / rimRows.length;
const rightEdge = rimRows.reduce((s, r) => s + r[1], 0) / rimRows.length;
const axis = (leftEdge + rightEdge) / 2;
const torsoHalf = (rightEdge - leftEdge) / 2;
const shoulderTop = 0.688 * H;
const corner = 60;
const neckHalf = 38;
// Signed distance (px, negative inside) of the neck and torso, smoothly joined: the hair hides the trapezius.
function bodySdf(x, y) {
  const px = Math.abs(x - axis);
  // Torso: a box with rounded shoulders, open below the frame.
  const qx = px - (torsoHalf - corner);
  const qy = shoulderTop + corner - y;
  const torso =
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    corner;
  // Neck: a column from inside the head down into the chest, a touch wider at its base.
  const neckW = neckHalf + Math.max(0, y - 0.6 * H) * 0.12;
  const neck = Math.max(px - neckW, headCy - y);
  const k = 34;
  const hm = clamp01(0.5 + (0.5 * (torso - neck)) / k);
  return torso * (1 - hm) + neck * hm - k * hm * (1 - hm);
}
const body = new Float32Array(N);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    body[y * W + x] = clamp01(0.5 - bodySdf(x + 0.5, y + 0.5));

/* ---------- bright: what the artwork already lights (hair strands, the cyan line, ribbons) ---------- */
const bright = new Float32Array(N);
for (let k = 0; k < N; k++) {
  const m = Math.max(R[k], G[k], B[k]);
  // Hair and ribbons are violet-pink (red well above the body's), the chest line is cyan.
  const lit = Math.max(smooth(55, 120, R[k]), smooth(90, 170, G[k]));
  bright[k] = lit * smooth(70, 150, m);
}

/* ---------- zone and figure: the figure is what particles build; the rest is the room ---------- */
const zone = new Float32Array(N);
const fig = new Float32Array(N);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const k = y * W + x;
    const ex = (x - axis) / (0.27 * W);
    const ey = (y - 0.55 * H) / (0.62 * H);
    zone[k] = 1 - smooth(0.78, 1.0, Math.hypot(ex, ey));
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

/* ---------- height: the silhouette inflated into a rounded form ---------- */
// A membrane (Poisson, lap u = -1, u = 0 on the contour) is smooth everywhere, unlike a distance transform with
// its creases; sqrt(4u) turns it into a round profile: exactly a hemisphere for a disc.
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
const HMAX = 128;
const BUST = { dx: 0.08 * W, y: 0.97 * H, amp: 24, sigma: 58, lens: 0.42 };
const headSoft = blur(head, 1);
const hHead = blur(inflate(head, false, 1500), 1.5);
const hBodyRaw = inflate(body, true, 4000);
const hBody = new Float32Array(N);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const k = y * W + x;
    // A torso is far shallower than it is wide.
    let hb = hBodyRaw[k] * 0.5;
    for (const side of [-1, 1]) {
      const dx = x - (axis + side * BUST.dx);
      const dy = y - BUST.y;
      hb +=
        BUST.amp *
        Math.exp(-(dx * dx + dy * dy) / (2 * BUST.sigma * BUST.sigma)) *
        Math.min(1, hBodyRaw[k] / 40);
    }
    hBody[k] = hb;
  }
const hBodyS = blur(hBody, 1.5);
const height = new Float32Array(N);
for (let k = 0; k < N; k++)
  height[k] = hHead[k] * headSoft[k] + hBodyS[k] * (1 - headSoft[k]);

/* ---------- normals ---------- */
const nx = new Float32Array(N);
const ny = new Float32Array(N);
const at = (a, x, y) =>
  a[Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))];
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const hx = (at(height, x + 1, y) - at(height, x - 1, y)) / 2;
    const hy = (at(height, x, y + 1) - at(height, x, y - 1)) / 2;
    const l = Math.hypot(hx, hy, 1);
    nx[y * W + x] = -hx / l;
    // Image rows run down; the normal's y points up.
    ny[y * W + x] = hy / l;
  }

/* ---------- the stripe coordinate: meridians of each part, as if it were turned on a lathe ---------- */
// s = longitude * radius. On the head the radius is fixed, so the lines converge at crown and chin like a
// globe's; on the body it follows the width a little (STRIPE_FLARE), so lines fan out from the neck over the
// shoulders and new ones come round from behind. A lens around each breast bows the lines around it.
const STRIPE_FLARE = 0.8;
const headRows = [];
let headR = 0;
{
  // Sub-pixel contour per row from a soft mask, then smoothed down the rows: no jitter in the meridians.
  const soft = blur(head, 1.5);
  const raw = [];
  for (let y = 0; y < H; y++) {
    let l = -1;
    let r = -1;
    for (let x = 1; x < W; x++) {
      const a = soft[y * W + x - 1];
      const b = soft[y * W + x];
      if (a < 0.5 && b >= 0.5 && l < 0) l = x - 1 + (0.5 - a) / (b - a);
      if (a >= 0.5 && b < 0.5) r = x - 1 + (a - 0.5) / (a - b);
    }
    raw.push(l < 0 || r < 0 ? null : { c: (l + r) / 2 + 0.5, r: (r - l) / 2 });
  }
  for (let y = 0; y < H; y++) {
    if (!raw[y]) {
      headRows.push(null);
      continue;
    }
    let c = 0;
    let r = 0;
    let n = 0;
    for (let j = -6; j <= 6; j++) {
      const row = raw[y + j];
      if (!row) continue;
      const wgt = Math.exp(-(j * j) / 18);
      c += row.c * wgt;
      r += row.r * wgt;
      n += wgt;
    }
    // Keep the true width at the crown and chin (where the smoothing would widen it).
    const rr = Math.min(raw[y].r + 1.5, r / n);
    headRows.push({ c: c / n, r: Math.max(1, rr) });
    headR = Math.max(headR, rr);
  }
}
const bodyRows = [];
for (let y = 0; y < H; y++) {
  let r = 0;
  while (r < W / 2 && bodySdf(axis + r, y + 0.5) < 0) r += 0.25;
  bodyRows.push(r);
}
const DMAX = 256;
const offset = new Float32Array(N);
for (let y = 0; y < H; y++) {
  const hr = headRows[y];
  const rb = Math.max(bodyRows[y], 4);
  // The flare follows a smoothed width, so lines bend gradually from the neck into the shoulders.
  let rs = 0;
  let ws = 0;
  for (let j = -14; j <= 14; j++) {
    const row = bodyRows[Math.max(0, Math.min(H - 1, y + j))];
    const wgt = Math.exp(-(j * j) / 72);
    rs += Math.max(row, 4) * wgt;
    ws += wgt;
  }
  const rRef =
    Math.pow(rs / ws, STRIPE_FLARE) * Math.pow(torsoHalf, 1 - STRIPE_FLARE);
  for (let x = 0; x < W; x++) {
    const k = y * W + x;
    let xl = x + 0.5 - axis;
    for (const side of [-1, 1]) {
      const bx = side * BUST.dx;
      const w = Math.exp(
        -((xl - bx) ** 2 + (y - BUST.y) ** 2) / (2 * BUST.sigma * BUST.sigma),
      );
      xl -= BUST.lens * w * (xl - bx);
    }
    const sBody = Math.asin(Math.max(-1, Math.min(1, xl / rb))) * rRef;
    let sHead = sBody;
    if (hr)
      sHead =
        Math.asin(Math.max(-1, Math.min(1, (x + 0.5 - hr.c) / hr.r))) * headR;
    const hm = headSoft[k];
    offset[k] = sHead * hm + sBody * (1 - hm) - (x + 0.5 - axis);
  }
}

/* ---------- write the data atlas ---------- */
const atlas = new Uint8Array(W * H * 3 * 3);
const put = (tile, k, a, b, c) => {
  const o = (tile * N + k) * 3;
  atlas[o] = Math.round(clamp01(a) * 255);
  atlas[o + 1] = Math.round(clamp01(b) * 255);
  atlas[o + 2] = Math.round(clamp01(c) * 255);
};
const headFinal = blur(head, 0.8);
for (let k = 0; k < N; k++) {
  const form = Math.max(headFinal[k], body[k]);
  const d = Math.round(clamp01((offset[k] + DMAX) / (2 * DMAX)) * 65535);
  put(0, k, form, headFinal[k], bright[k]);
  put(1, k, (d >> 8) / 255, height[k] / HMAX, fig[k]);
  put(2, k, 0.5 + nx[k] * 0.5, 0.5 + ny[k] * 0.5, (d & 255) / 255);
}
fs.writeFileSync(
  path.join(outDir, "aura-data.png"),
  encodePng(W, H * 3, atlas),
);

const meta = {
  axis: +(axis / W).toFixed(4),
  headCx: +(headCx / W).toFixed(4),
  headCy: +(headCy / H).toFixed(4),
  headTop: +(headTop / H).toFixed(4),
  headBottom: +(headBottom / H).toFixed(4),
  headRadius: +(headR / W).toFixed(4),
  torsoHalf: +(torsoHalf / W).toFixed(4),
  shoulderTop: +(shoulderTop / H).toFixed(4),
  dmax: DMAX,
  hmax: HMAX,
  heightMax: +height.reduce((a, b) => Math.max(a, b)).toFixed(1),
};
console.log(JSON.stringify(meta));

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
