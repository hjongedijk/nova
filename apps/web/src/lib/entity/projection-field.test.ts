import { describe, expect, it } from "vitest";
import { sampleProjection } from "./projection-field.ts";

describe("projection artwork sampling", () => {
  it("keeps the source colors, omits transparency and locates warm face energy", () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    pixels.set([255, 128, 0, 255], (2 * 4 + 2) * 4);
    const field = sampleProjection(pixels, 4, 4);
    expect(field.positions).toHaveLength(3);
    expect(field.positions[0]).toBe(0);
    expect(field.positions[1]).toBe(0);
    expect(field.positions[2]).toBeGreaterThan(0.05);
    expect(field.colors[0]).toBe(1);
    expect(field.colors[1]).toBeCloseTo(0.21586, 4);
    expect(field.colors[2]).toBe(0);
    expect(field.signals[0]).toBe(1);
    expect(field.signals[1]).toBeGreaterThan(0.9);
  });

  it("bounds the particle count for large opaque images", () => {
    const pixels = new Uint8ClampedArray(2048 * 2048 * 4).fill(255);
    const field = sampleProjection(pixels, 2048, 2048);
    expect(field.positions.length / 3).toBeLessThanOrEqual(360_000);
    expect(field.positions.length / 3).toBeGreaterThan(100_000);
    expect(field.positions.every(Number.isFinite)).toBe(true);
    expect(field.colors).toHaveLength(field.positions.length);
    expect(field.signals).toHaveLength(field.positions.length);
  });
});
