import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ARRIVAL_GLSL,
  arrival,
  AURA_ASSETS,
  AURA_DATA,
  auraFraming,
  BIRTH,
  f,
  FACE,
} from "./aura-data.ts";
import {
  PARTICLE_KIND,
  sampleParticles,
  type Pixels,
} from "./aura-particles.ts";
import {
  BLOOM_REACH,
  bloomFront,
  BUDGET,
  createAura,
  GAZE,
  gpuTier,
  LOOKS,
  spring,
  STRIPES,
  TIMING,
} from "./aura.ts";
import { PLATE_FRAG, POINTS_VERT } from "./aura-shaders.ts";

const STATIC = path.resolve(import.meta.dirname, "../../../static");

describe("aura artwork", () => {
  it("ships the approved picture in two sizes and its data atlas", () => {
    for (const url of [AURA_ASSETS.hi, AURA_ASSETS.lo]) {
      const buf = fs.readFileSync(path.join(STATIC, url));
      expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
      expect(buf.toString("ascii", 8, 12)).toBe("WEBP");
      // Compressed, not a raw dump: the large one stays well under a megabyte.
      expect(buf.length).toBeLessThan(1_000_000);
    }
    const png = fs.readFileSync(path.join(STATIC, AURA_ASSETS.data));
    expect(png.readUInt32BE(16)).toBe(AURA_DATA.width);
    expect(png.readUInt32BE(20)).toBe(AURA_DATA.height * 3);
    // RGB, no alpha: nothing for a browser to premultiply.
    expect(png[25]).toBe(2);
  });

  it("is documented as generated with FLUX.1 schnell, Apache-2.0, owner-approved", () => {
    const doc = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../../../docs/third-party-assets.md",
      ),
      "utf8",
    );
    expect(doc).toMatch(/FLUX\.1 schnell/);
    expect(doc).toMatch(/Apache-2\.0/);
    expect(doc).toMatch(/aura-2560\.webp/);
  });

  it("knows where the head and body are in the picture", () => {
    const { head, axis, torsoHalf } = AURA_DATA;
    // Head and chest centred as in the artwork.
    expect(Math.abs(axis - 0.5)).toBeLessThan(0.04);
    expect(Math.abs(head.cx - axis)).toBeLessThan(0.01);
    expect(head.top).toBeLessThan(head.cy);
    expect(head.bottom).toBeGreaterThan(head.cy);
    expect(torsoHalf).toBeGreaterThan(head.radius * 2.5);
    expect(FACE.v).toBeGreaterThan(head.top);
    expect(FACE.v).toBeLessThan(head.bottom);
  });
});

describe("aura framing", () => {
  it("shows a 16:9 screen the artwork exactly as it is", () => {
    expect(auraFraming(1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(auraFraming(2560, 1440)).toEqual({ x: 0, y: 0, w: 2560, h: 1440 });
  });

  it("covers wide and tall desktop windows with the figure kept in view", () => {
    for (const [W, H] of [
      [2560, 1080],
      [1440, 900],
      [1280, 1024],
    ] as const) {
      const fr = auraFraming(W, H);
      expect(fr.x).toBeLessThanOrEqual(0);
      expect(fr.y).toBeLessThanOrEqual(0);
      expect(fr.x + fr.w).toBeGreaterThanOrEqual(W - 1e-6);
      expect(fr.y + fr.h).toBeGreaterThanOrEqual(H - 1e-6);
      const faceY = fr.y + FACE.v * fr.h;
      expect(faceY).toBeGreaterThan(0.2 * H);
      expect(faceY).toBeLessThan(0.6 * H);
      const shoulders = [
        fr.x + (AURA_DATA.axis - AURA_DATA.torsoHalf) * fr.w,
        fr.x + (AURA_DATA.axis + AURA_DATA.torsoHalf) * fr.w,
      ];
      expect(shoulders[0]).toBeGreaterThanOrEqual(0);
      expect(shoulders[1]).toBeLessThanOrEqual(W);
    }
  });

  it("crops a phone (390x844) to the bust: head and both shoulders in the width", () => {
    const W = 390;
    const H = 844;
    const fr = auraFraming(W, H);
    const left = fr.x + (AURA_DATA.axis - AURA_DATA.torsoHalf) * fr.w;
    const right = fr.x + (AURA_DATA.axis + AURA_DATA.torsoHalf) * fr.w;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(W);
    // Zoomed in: the shoulders fill most of the width.
    expect((right - left) / W).toBeGreaterThan(0.8);
    const top = fr.y + AURA_DATA.head.top * fr.h;
    expect(top).toBeGreaterThan(0);
    expect(fr.y + FACE.v * fr.h).toBeLessThan(H * 0.45);
  });
});

describe("aura birth", () => {
  it("settles bottom to top, the centre ahead of the sides, and the face last", () => {
    expect(arrival(AURA_DATA.axis, 0.95, 0)).toBeLessThan(
      arrival(AURA_DATA.axis, 0.5, 0),
    );
    expect(arrival(AURA_DATA.axis, 0.7, 0)).toBeLessThan(arrival(0.3, 0.7, 0));
    let latestBody = 0;
    // Everything the particles build (the figure's zone: hair, head, shoulders).
    for (let v = 0.05; v <= 1; v += 0.05)
      for (let u = AURA_DATA.axis - 0.27; u <= AURA_DATA.axis + 0.27; u += 0.03)
        latestBody = Math.max(latestBody, arrival(u, v, 0, 1));
    let earliestFace = Infinity;
    for (let v = AURA_DATA.head.top; v <= AURA_DATA.head.bottom; v += 0.02)
      earliestFace = Math.min(earliestFace, arrival(FACE.u, v, 1, 0));
    expect(earliestFace).toBeGreaterThan(latestBody - 0.25);
    expect(arrival(FACE.u, FACE.v, 1, 0.5)).toBeGreaterThan(latestBody);
  });

  it("ends with one shockwave, then the rest frame", () => {
    const lastLanding = arrival(FACE.u, AURA_DATA.head.top, 1, 1);
    expect(BIRTH.ringAt).toBeGreaterThanOrEqual(lastLanding - 0.1);
    expect(BIRTH.ringAt + BIRTH.ringTime).toBeLessThanOrEqual(BIRTH.total);
    expect(lastLanding + BIRTH.settle).toBeLessThanOrEqual(BIRTH.total);
    expect(TIMING.birth).toBe(BIRTH.total);
  });

  it("uses the same timing on the GPU", () => {
    for (const n of [
      BIRTH.lead,
      BIRTH.spread,
      BIRTH.arch,
      BIRTH.faceAt,
      BIRTH.flight,
    ])
      expect(ARRIVAL_GLSL).toContain(f(n));
    expect(PLATE_FRAG).toContain("arrival(p, hp, 0.5)");
    expect(PLATE_FRAG).toContain("float arRoom = ar - 0.25");
    expect(POINTS_VERT).toContain("arrival(home, isHead, aSeed.w)");
  });
});

describe("aura particles", () => {
  /** A synthetic picture (grey) and atlas: the figure is a rectangle, the head a disc inside it. */
  function synthetic() {
    const iw = 640;
    const ih = 360;
    const image: Pixels = {
      width: iw,
      height: ih,
      data: new Uint8Array(iw * ih * 4).fill(120),
    };
    const tw = 96;
    const th = 54;
    const data = new Uint8Array(tw * th * 3 * 4);
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++) {
        const u = (x + 0.5) / tw;
        const v = (y + 0.5) / th;
        const inFig = u > 0.3 && u < 0.7 && v > 0.1;
        const inHead = Math.hypot((u - 0.5) * 1.78, v - 0.3) < 0.12;
        const set = (tile: number, r: number, g: number, b: number) => {
          const o = ((tile * th + y) * tw + x) * 4;
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
          data[o + 3] = 255;
        };
        set(0, inFig ? 255 : 0, inHead ? 255 : 0, 0);
        set(1, 128, inHead ? 200 : 0, inFig ? 255 : 0);
        set(2, 128, 128, 0);
      }
    return { image, atlas: { width: tw, height: th * 3, data } };
  }

  it("samples the lit figure to about the budget, coloured from the picture", () => {
    const { image, atlas } = synthetic();
    const p = sampleParticles(image, atlas, 20_000);
    expect(p.count).toBeGreaterThan(16_000);
    expect(p.count).toBeLessThan(24_000);
    expect(p.home.length).toBe(p.count * 2);
    let heads = 0;
    for (let i = 0; i < p.count; i++) {
      const u = p.home[i * 2]!;
      const v = p.home[i * 2 + 1]!;
      expect(u).toBeGreaterThan(0.29);
      expect(u).toBeLessThan(0.71);
      expect(v).toBeGreaterThan(0.09);
      expect(p.color[i * 4]).toBe(120);
      if (p.seed[i * 4 + 2] === PARTICLE_KIND.head) {
        heads++;
        // Head particles carry a depth for the turn.
        expect(p.seed[i * 4 + 1]).toBeGreaterThan(50);
      }
    }
    expect(heads).toBeGreaterThan(500);
  });

  it("orders them so a smaller budget is still an even spread", () => {
    const { image, atlas } = synthetic();
    const p = sampleParticles(image, atlas, 20_000);
    const n = Math.floor(p.count / 4);
    const bins = new Array<number>(16).fill(0);
    for (let i = 0; i < n; i++) {
      const bx = Math.min(3, Math.floor(((p.home[i * 2]! - 0.3) / 0.4) * 4));
      const by = Math.min(
        3,
        Math.floor(((p.home[i * 2 + 1]! - 0.1) / 0.9) * 4),
      );
      bins[by * 4 + bx]!++;
    }
    const mean = n / 16;
    for (const b of bins) expect(Math.abs(b - mean) / mean).toBeLessThan(0.12);
  });
});

describe("aura stripes", () => {
  it("has easy-to-tune stripes: count, width with a clear gap, colour shares", () => {
    expect(STRIPES.count).toBeGreaterThanOrEqual(12);
    expect(STRIPES.headCount).toBeGreaterThanOrEqual(5);
    expect(STRIPES.width).toBeGreaterThan(0.25);
    expect(STRIPES.width).toBeLessThan(0.6);
    // Neon made of light: a glow that keeps the gaps dark, a string of dots, a few star points, faint dust.
    expect(STRIPES.halo).toBeGreaterThan(0);
    expect(STRIPES.halo).toBeLessThan(0.6);
    expect(STRIPES.dots.step).toBeGreaterThan(1);
    expect(STRIPES.dots.step).toBeLessThan(8);
    expect(STRIPES.stars).toBeGreaterThan(0);
    expect(STRIPES.stars).toBeLessThan(0.2);
    expect(STRIPES.dust).toBeLessThan(0.5);
    expect(PLATE_FRAG).toContain("neonStripe(");
    const m = STRIPES.mix;
    expect(m.a + m.b + m.pink + m.cyan + m.peach).toBeCloseTo(1, 5);
    // Mostly violet and magenta.
    expect(m.a + m.b).toBeGreaterThan(0.6);
    for (const c of Object.values(STRIPES.accents))
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("adds no facial features: the face stays blank", () => {
    expect(PLATE_FRAG).not.toMatch(
      /\b(eyes?|mouth|lips?|nose|brows?|pupils?)\b/i,
    );
  });
});

describe("aura moods and motion", () => {
  it("has a look for every state and the alert; at rest the hair keeps the artwork's colour", () => {
    for (const s of [
      "ready",
      "listening",
      "thinking",
      "executing",
      "speaking",
      "alert",
    ] as const) {
      for (const c of [LOOKS[s].a, LOOKS[s].b, LOOKS[s].r, LOOKS[s].h])
        expect(c).toMatch(/^#[0-9a-f]{6}$/);
      expect(LOOKS[s].glow).toBeGreaterThan(0.8);
      expect(LOOKS[s].glow).toBeLessThan(1.4);
      expect(LOOKS[s].tint).toBeGreaterThanOrEqual(0);
      expect(LOOKS[s].tint).toBeLessThanOrEqual(1);
    }
    expect(LOOKS.ready.tint).toBe(0);
    expect(new Set(Object.values(LOOKS).map((l) => l.a)).size).toBe(6);
  });

  it("blooms from the face in about a second and ends exactly at rest", () => {
    expect(TIMING.bloom).toBeCloseTo(1, 1);
    expect(bloomFront(0)).toBe(0);
    expect(bloomFront(1)).toBe(1);
    expect(bloomFront(2)).toBe(1);
    let last = 0;
    for (let x = 0; x <= 1; x += 0.05) {
      expect(bloomFront(x)).toBeGreaterThanOrEqual(last);
      last = bloomFront(x);
    }
    // At the end the radius has passed the farthest corner of the picture.
    const corner = Math.hypot(FACE.u * AURA_DATA.aspect, 1 - FACE.v);
    expect(BLOOM_REACH).toBeGreaterThan(corner);
  });

  it("turns the head on a spring that settles without overshoot, within limits", () => {
    const s = { x: 0, v: 0 };
    let max = 0;
    for (let i = 0; i < 300; i++) {
      spring(s, GAZE.yaw, 1 / 60);
      max = Math.max(max, s.x);
    }
    expect(s.x).toBeCloseTo(GAZE.yaw, 3);
    expect(max).toBeLessThanOrEqual(GAZE.yaw + 1e-6);
    expect(GAZE.yaw).toBeLessThan(0.4);
    expect(GAZE.pitch).toBeLessThan(GAZE.yaw);
  });
});

describe("aura quality", () => {
  it("budgets particles and resolution per GPU class", () => {
    expect(
      gpuTier(
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)",
        1920,
      ),
    ).toBe("low");
    expect(gpuTier("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)", 1920)).toBe(
      "high",
    );
    expect(gpuTier("ANGLE (AMD, AMD Radeon(TM) Graphics)", 1920)).toBe("mid");
    expect(gpuTier("Apple GPU", 390)).toBe("low");
    expect(BUDGET.high.particles).toBeGreaterThanOrEqual(150_000);
    expect(BUDGET.high.particles).toBeLessThanOrEqual(300_000);
    expect(BUDGET.low.particles).toBeLessThan(BUDGET.mid.particles);
    expect(BUDGET.mid.particles).toBeLessThan(BUDGET.high.particles);
    expect(BUDGET.low.image).toBe("lo");
    expect(BUDGET.mid.dpr).toBeLessThanOrEqual(1.5);
  });

  it("builds nothing outside a browser", async () => {
    expect(await createAura({} as unknown as HTMLCanvasElement)).toBeNull();
  });
});

describe("shape option", () => {
  it("keeps Aura as a saved choice and the orb as the default", async () => {
    vi.stubGlobal("$state", <T>(value: T) => value);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    const { normalizeAvatar } = await import("#lib/stores/helper.svelte.ts");
    expect(normalizeAvatar("aura")).toBe("aura");
    expect(normalizeAvatar("presence")).toBe("presence");
    expect(normalizeAvatar(undefined)).toBe("orb");
    expect(normalizeAvatar("face")).toBe("orb");
    vi.unstubAllGlobals();
  });
});
