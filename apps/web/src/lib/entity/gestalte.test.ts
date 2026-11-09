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
import { PALETTE, viewHeight } from "./gestalte.ts";

describe("gestalte body", () => {
  it("is a head on a long neck above broad shoulders", () => {
    // Inside the head, the neck and the shoulders; outside above the crown, beside the neck, under the chin.
    expect(gestalteField(0, 0.2, 0)).toBeLessThan(0);
    expect(gestalteField(0, -1.1, -0.1)).toBeLessThan(0);
    expect(gestalteField(2.4, -2.1, -0.1)).toBeLessThan(0);
    expect(gestalteField(0, CROWN + 0.05, 0)).toBeGreaterThan(0);
    expect(gestalteField(0.75, -1.1, 0)).toBeGreaterThan(0);
    expect(gestalteField(0, CHIN - 0.12, 0.45)).toBeGreaterThan(0);
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
    // Shoulders run off a 16:9 screen (half width ~3 units).
    expect(maxX).toBeGreaterThan(3);
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
  it("puts the head over 60% of a landscape screen and keeps air on narrow ones", () => {
    const wide = viewHeight(16 / 9);
    expect((CROWN - CHIN) / wide).toBeCloseTo(0.6, 2);
    const tall = viewHeight(9 / 19.5);
    expect((CROWN - CHIN) / tall).toBeLessThan(0.6);
    expect(tall * (9 / 19.5)).toBeGreaterThanOrEqual(2.3 - 1e-9);
  });

  it("keeps the blue and amber palette", () => {
    expect(PALETTE.bg).toBe("#0a1220");
    expect(PALETTE.core).toBe("#ff8a1a");
    expect(PALETTE.hot).toBe("#ffb347");
  });
});
