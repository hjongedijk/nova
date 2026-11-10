import { AURA_DATA } from "./aura-data.ts";

/**
 * The artwork sampled into particles: one particle per cell of an even grid over the lit figure (hair, head,
 * body), jittered inside its cell, carrying the colour under it. Shuffled, so any prefix is an even sample too:
 * a lower budget simply draws fewer. Pure; runs in the worker (aura.worker.ts) or, without workers, on the page.
 */

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface AuraParticles {
  count: number;
  /** Picture position u, v (0..1, v down) per particle. */
  home: Float32Array;
  /** sRGB colour and figure weight, 8 bits each. */
  color: Uint8Array;
  /** Random 0..1, depth in data pixels (head) or hair weight (bright), kind (PARTICLE_KIND), jitter 0..1. */
  seed: Float32Array;
  /** Grid cell size, in picture widths: sets the point size. */
  cell: number;
}

export const PARTICLE_KIND = { body: 0, head: 1, bright: 2, room: 3 } as const;

/** 4x4 ordered-dither ranks. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Darker than this (0..255, brightest channel) adds nothing to the picture: no particle. */
const DARKEST = 14;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Read the atlas tile `tile` (0..2) at picture position u, v: three channels 0..1. */
export function atlasAt(
  atlas: Pixels,
  tile: number,
  u: number,
  v: number,
): [number, number, number] {
  const tw = atlas.width;
  const th = atlas.height / 3;
  const x = Math.max(0, Math.min(tw - 1, Math.floor(u * tw)));
  const y = Math.max(0, Math.min(th - 1, Math.floor(v * th))) + tile * th;
  const o = (y * tw + x) * 4;
  return [
    atlas.data[o]! / 255,
    atlas.data[o + 1]! / 255,
    atlas.data[o + 2]! / 255,
  ];
}

export function sampleParticles(
  image: Pixels,
  atlas: Pixels,
  target: number,
  seed = 7,
): AuraParticles {
  const { width: iw, height: ih, data } = image;
  const rand = mulberry32(seed);
  const lit = (x: number, y: number) => {
    const o = (y * iw + x) * 4;
    return Math.max(data[o]!, data[o + 1]!, data[o + 2]!) >= DARKEST;
  };
  const figureAt = (x: number, y: number) =>
    atlasAt(atlas, 1, (x + 0.5) / iw, (y + 0.5) / ih)[2];
  // How much of the picture is lit figure decides the grid.
  let candidates = 0;
  for (let y = 0; y < ih; y += 2)
    for (let x = 0; x < iw; x += 2)
      if (figureAt(x, y) > 0.04 && lit(x, y)) candidates += 4;
  const cell = Math.max(1, Math.sqrt(candidates / Math.max(1, target)));
  const cap = Math.ceil(((iw / cell + 1) * (ih / cell + 1)) | 0);
  const home = new Float32Array(cap * 2);
  const color = new Uint8Array(cap * 4);
  const seeds = new Float32Array(cap * 4);
  const rank = new Uint8Array(cap);
  let n = 0;
  let iy = 0;
  for (let cy = 0; cy < ih; cy += cell, iy++)
    for (let cx = 0, ix = 0; cx < iw; cx += cell, ix++) {
      // Jittered about the cell's centre: even coverage without a visible grid.
      const x = Math.min(iw - 1, cx + (0.38 + 0.24 * rand()) * cell);
      const y = Math.min(ih - 1, cy + (0.38 + 0.24 * rand()) * cell);
      const r = rand();
      const jitter = rand();
      const u = x / iw;
      const v = y / ih;
      const [form, headM, bright] = atlasAt(atlas, 0, u, v);
      const [hairW, height, fig] = atlasAt(atlas, 1, u, v);
      if (fig <= 0.04 || n >= cap) continue;
      // The cell's average colour: the points then add up to a smooth picture, not to single-pixel noise.
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let cnt = 0;
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const x1 = Math.min(iw, Math.max(x0 + 1, Math.floor(cx + cell)));
      const y1 = Math.min(ih, Math.max(y0 + 1, Math.floor(cy + cell)));
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * iw + xx) * 4;
          rs += data[o]!;
          gs += data[o + 1]!;
          bs += data[o + 2]!;
          cnt++;
        }
      if (Math.max(rs, gs, bs) / cnt < DARKEST) continue;
      home[n * 2] = u;
      home[n * 2 + 1] = v;
      color[n * 4] = Math.round(rs / cnt);
      color[n * 4 + 1] = Math.round(gs / cnt);
      color[n * 4 + 2] = Math.round(bs / cnt);
      color[n * 4 + 3] = Math.round(Math.min(1, fig * 1.5) * 255);
      const kind =
        headM > 0.5
          ? PARTICLE_KIND.head
          : bright > 0.35
            ? PARTICLE_KIND.bright
            : form > 0.5
              ? PARTICLE_KIND.body
              : PARTICLE_KIND.room;
      seeds[n * 4] = r;
      // Head: its depth for the turn. Hair: its weight, for the wind.
      seeds[n * 4 + 1] =
        kind === PARTICLE_KIND.head
          ? height * AURA_DATA.hmax
          : kind === PARTICLE_KIND.bright
            ? hairW
            : 0;
      seeds[n * 4 + 2] = kind;
      seeds[n * 4 + 3] = jitter;
      rank[n] = BAYER[(iy & 3) * 4 + (ix & 3)]!;
      n++;
    }
  // Order by an ordered-dither rank of the cell, randomly within each rank: any prefix is then an evenly spread
  // sample of the whole (a plain shuffle would thin it at random, and random gaps show as grain).
  const buckets: number[][] = Array.from({ length: 16 }, () => []);
  for (let i = 0; i < n; i++) buckets[rank[i]!]!.push(i);
  const order: number[] = [];
  for (const b of buckets) {
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = b[i]!;
      b[i] = b[j]!;
      b[j] = t;
    }
    for (const i of b) order.push(i);
  }
  const outHome = new Float32Array(n * 2);
  const outColor = new Uint8Array(n * 4);
  const outSeed = new Float32Array(n * 4);
  order.forEach((src, dst) => {
    outHome.set(home.subarray(src * 2, src * 2 + 2), dst * 2);
    outColor.set(color.subarray(src * 4, src * 4 + 4), dst * 4);
    outSeed.set(seeds.subarray(src * 4, src * 4 + 4), dst * 4);
  });
  return {
    count: n,
    home: outHome,
    color: outColor,
    seed: outSeed,
    cell: cell / iw,
  };
}

/** Fetch a picture and read its pixels, where the platform allows it (a worker, or a page). */
export async function loadPixels(url: string): Promise<Pixels> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(bmp.width, bmp.height)
      : Object.assign(document.createElement("canvas"), {
          width: bmp.width,
          height: bmp.height,
        });
  const g = canvas.getContext("2d", { willReadFrequently: true }) as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!g) throw new Error("no 2d context");
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data };
}

export function particleTransferables(p: AuraParticles): Transferable[] {
  return [p.home.buffer, p.color.buffer, p.seed.buffer];
}
