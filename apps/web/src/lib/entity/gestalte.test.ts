import { describe, expect, it } from "vitest";
import {
  BASE,
  buildGestalte,
  CHIN,
  CROWN,
  gestalteField,
  headWeight,
  poseMatrix,
} from "./gestalte-body.ts";
import { BIRTH, MOODS, PALETTE, shockAt, viewHeight } from "./gestalte.ts";
import { buildLand, landAt } from "./gestalte-land.ts";
import {
  bandLevel,
  birthOrder,
  buildFigurePoints,
} from "./gestalte-points.ts";

describe("gestalte body", () => {
  it("is a head on a neck above a bust: sloping shoulders, deltoids, arms falling down", () => {
    // Inside the head, the neck, the chest and the upper arms; outside above the crown, under the chin.
    expect(gestalteField(0, 0.2, 0)).toBeLessThan(0);
    expect(gestalteField(0, -1.1, -0.1)).toBeLessThan(0);
    expect(gestalteField(0, -2.1, 0.3)).toBeLessThan(0);
    expect(gestalteField(1.45, -2.6, 0)).toBeLessThan(0);
    expect(gestalteField(0, CROWN + 0.05, 0)).toBeGreaterThan(0);
    expect(gestalteField(0, CHIN - 0.12, 0.45)).toBeGreaterThan(0);
    // Trapezius slope: the top of the shoulder falls 25-35 degrees from the side of the neck to the deltoid.
    const top = (x: number) => {
      let y = -0.6;
      while (gestalteField(x, y, -0.15) > 0) y -= 0.002;
      return y;
    };
    const slope = (Math.atan2(top(0.55) - top(1.1), 0.55) * 180) / Math.PI;
    expect(slope).toBeGreaterThan(22);
    expect(slope).toBeLessThan(36);
    // Shoulders span about twice the head, then the arms go down instead of running off to the sides.
    const width = (y: number) => {
      let x = 3;
      while (x > 0 && gestalteField(x, y, -0.02) > 0) x -= 0.005;
      return x;
    };
    const head = width(-0.05);
    const shoulders = Math.max(width(-1.9), width(-2.1));
    expect((2 * shoulders) / (2 * head)).toBeGreaterThan(1.9);
    expect((2 * shoulders) / (2 * head)).toBeLessThan(2.4);
    expect(Math.abs(width(-3.2) - shoulders)).toBeLessThan(0.15);
    // Featureless and symmetric.
    for (const [x, y, z] of [
      [0.3, 0.1, 0.5],
      [1.2, -1.8, 0.2],
      [0.6, -0.1, 0.1],
    ] as const)
      expect(gestalteField(x, y, z)).toBeCloseTo(gestalteField(-x, y, z), 9);
  });

  it("meshes the front of the figure, crown first, with sparks on the silhouette", () => {
    const g = buildGestalte(0.35, 300);
    const n = g.rings * g.angles;
    expect(g.position.length).toBe(n * 3);
    expect(g.index.length).toBe((g.rings - 1) * (g.angles - 1) * 6);
    let maxY = -Infinity;
    let minY = Infinity;
    let maxX = 0;
    for (let i = 0; i < n; i++) {
      const y = g.position[i * 3 + 1]!;
      maxY = Math.max(maxY, y);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, Math.abs(g.position[i * 3]!));
      // Every vertex sits on the surface, with a unit normal.
      const d = gestalteField(g.position[i * 3]!, y, g.position[i * 3 + 2]!);
      expect(Math.abs(d)).toBeLessThan(0.02);
      const nl = Math.hypot(
        g.normal[i * 3]!,
        g.normal[i * 3 + 1]!,
        g.normal[i * 3 + 2]!,
      );
      expect(nl).toBeCloseTo(1, 3);
    }
    expect(maxY).toBeLessThanOrEqual(CROWN + 0.01);
    expect(minY).toBeGreaterThan(BASE - 0.05);
    // The shoulders stay on a 16:9 screen (half width ~3.5 units) and leave through its bottom edge.
    expect(maxX).toBeGreaterThan(1.5);
    expect(maxX).toBeLessThan(2);
    // The crown starts first, the chest last.
    expect(g.delay[0]).toBe(0);
    expect(g.delay[n - 1]).toBeCloseTo(0.42, 5);
    expect(headWeight(0)).toBe(1);
    expect(headWeight(-2)).toBe(0);
    // Sparks leave the silhouette, not the face.
    for (let p = 0; p < g.sparkHead.length; p++)
      expect(Math.abs(g.sparkNormal[p * 3 + 2]!)).toBeLessThanOrEqual(0.42);
  });

  it("poses with rotations", () => {
    const m = poseMatrix(new Float32Array(9), 0.3, -0.1, 0.05, 0.1);
    // Rows are orthonormal.
    for (let r = 0; r < 3; r++) {
      const l = Math.hypot(m[r * 3]!, m[r * 3 + 1]!, m[r * 3 + 2]!);
      expect(l).toBeCloseTo(1, 5);
    }
    const id = poseMatrix(new Float32Array(9), 0, 0, 0, 0);
    expect([...id]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

describe("gestalte framing", () => {
  it("puts the head over half a landscape screen and keeps air on narrow ones", () => {
    const wide = viewHeight(16 / 9);
    expect((CROWN - CHIN) / wide).toBeCloseTo(0.52, 2);
    const tall = viewHeight(9 / 19.5);
    expect((CROWN - CHIN) / tall).toBeLessThan(0.52);
    expect(tall * (9 / 19.5)).toBeGreaterThanOrEqual(2.3 - 1e-9);
  });

  it("keeps the blue and amber palette", () => {
    expect(PALETTE.bg).toBe("#0a1220");
    expect(PALETTE.core).toBe("#ff8a1a");
    expect(PALETTE.hot).toBe("#ffb347");
  });
});

describe("gestalte v6 point cloud", () => {
  const geo = buildGestalte(0.5, 200);
  const fig = buildFigurePoints(geo, 0.5);

  it("strings dots along contour bands on the surface, veins first", () => {
    expect(fig.count).toBeGreaterThan(5000);
    expect(fig.fixed).toBeGreaterThan(100);
    let bands = 0;
    for (let i = 0; i < fig.count; i++) {
      const x = fig.position[i * 3]!;
      const y = fig.position[i * 3 + 1]!;
      const z = fig.position[i * 3 + 2]!;
      const kind = fig.data[i * 4 + 1]!;
      expect(kind === 1).toBe(i < fig.fixed);
      // Coarse test grid: dots lie on its chords, within a hair of the true surface.
      expect(Math.abs(gestalteField(x, y, z))).toBeLessThan(0.03);
      const ord = fig.data[i * 4 + 3]!;
      expect(ord).toBeGreaterThan(-0.05);
      expect(ord).toBeLessThan(1.05);
      if (kind === 0) {
        bands++;
        // A band dot sits on (or very near) an integer level: dark gaps between bands carry the form.
        const lv = bandLevel(y, z, fig.data[i * 4]!);
        expect(Math.abs(lv - Math.round(lv))).toBeLessThan(0.12);
      }
    }
    expect(bands / fig.count).toBeGreaterThan(0.7);
    // Veins run down the front of the neck and chest only.
    for (let i = 0; i < fig.fixed; i++) {
      expect(fig.position[i * 3 + 1]!).toBeLessThan(-0.7);
      expect(fig.position[i * 3 + 1]!).toBeGreaterThan(-2.5);
      expect(fig.normal[i * 3 + 2]!).toBeGreaterThan(0.1);
    }
  });

  it("is deterministic and fills the body from the bottom up", () => {
    const again = buildFigurePoints(geo, 0.5);
    expect(again.count).toBe(fig.count);
    expect(again.position[123]).toBe(fig.position[123]);
    expect(birthOrder(-3)).toBe(0);
    expect(birthOrder(CROWN)).toBe(1);
    expect(birthOrder(-1)).toBeLessThan(birthOrder(0.5));
  });

  it("builds a land that rises at the sides and leaves the middle dark", () => {
    const land = buildLand(40000, 3);
    expect(land.count).toBeGreaterThan(5000);
    const mid = landAt(0, -20);
    const side = landAt(14, -20);
    expect(side.y).toBeGreaterThan(mid.y);
    for (let i = 0; i < land.count; i++) {
      const crest = land.data[i * 4]!;
      const lava = land.data[i * 4 + 1]!;
      expect(crest).toBeGreaterThanOrEqual(0);
      expect(crest).toBeLessThanOrEqual(1);
      expect(lava).toBeGreaterThanOrEqual(0);
      expect(lava).toBeLessThanOrEqual(1);
    }
  });

  it("times one shockwave after the face ignites and ends without residue", () => {
    expect(BIRTH.shock).toBeGreaterThanOrEqual(BIRTH.ignite[0]);
    expect(shockAt(-0.1)).toBeNull();
    expect(shockAt(BIRTH.shockLen)).toBeNull();
    const early = shockAt(0.2)!;
    const late = shockAt(BIRTH.shockLen * 0.9)!;
    expect(early.r).toBeLessThan(late.r);
    expect(late.a).toBeLessThan(early.a);
    expect(shockAt(BIRTH.shockLen - 1e-3)!.a).toBeLessThan(0.01);
  });

  it("has a look for every state, rim colours never white", () => {
    for (const m of Object.values(MOODS)) {
      expect(Math.min(...m.rim)).toBeLessThan(0.35);
      expect(m.look[0]).toBeGreaterThan(0.5);
    }
  });
});
