import { describe, expect, it } from "vitest";
import { bodyField, buildPresence, createPresence } from "./presence.ts";

describe("procedural presence", () => {
  it("is a closed, symmetric bust: narrow neck between head and wider shoulders", () => {
    expect(bodyField(0, 0.2, 0)).toBeLessThan(0); // inside the head
    expect(bodyField(0, 2, 0)).toBeGreaterThan(0); // above it
    expect(bodyField(0.5, -0.3, 0.2)).toBeCloseTo(
      bodyField(-0.5, -0.3, 0.2),
      6,
    );
    const g = buildPresence("full");
    const halfWidth = (y: number) => {
      let best = 0;
      for (let k = 0; k < g.rings; k++) {
        if (Math.abs(g.ringY[k]! - y) > 0.06) continue;
        for (let j = 0; j < g.angles; j++)
          best = Math.max(best, Math.abs(g.bx[k * g.angles + j]!));
      }
      return best;
    };
    const head = halfWidth(0.2);
    const neck = halfWidth(-1.3);
    const shoulders = halfWidth(-2.4);
    expect(neck).toBeLessThan(head * 0.75);
    expect(shoulders).toBeGreaterThan(head * 2);
  });

  it("keeps the line budget bounded per quality and every sample finite", () => {
    for (const quality of ["compact", "full", "fine"] as const) {
      const g = buildPresence(quality);
      const points = g.rings * g.angles;
      expect(points).toBeLessThan(quality === "compact" ? 1500 : 11000);
      for (let i = 0; i < points; i++) {
        expect(Number.isFinite(g.bx[i]!)).toBe(true);
        expect(Math.hypot(g.nx[i]!, g.ny[i]!, g.nz[i]!)).toBeCloseTo(1, 2);
      }
      // Head first: rings emerge from the top down.
      expect(g.delay[0]).toBe(0);
      expect(g.delay[g.rings - 1]).toBeGreaterThan(g.delay[1]!);
    }
  });

  it("leaves the orb particles untouched while fully in orb form", () => {
    const seed = new Float32Array(64).map((_, i) => (i * 0.37) % 1);
    const p = createPresence("compact", 64, seed);
    const sx = new Float32Array(64).fill(5);
    const sy = new Float32Array(64).fill(6);
    const sz = new Float32Array(64).fill(0.5);
    const vis = new Float32Array(64).fill(1);
    const frame = {
      t: 1,
      dt: 1 / 60,
      form: 0,
      state: "ready" as const,
      h: 190,
      s: 88,
      l: 70,
      glow: 0.5,
      alert: false,
      audio: 0,
      bands: null,
      gazeX: 0,
      gazeY: 0,
      ocx: 100,
      ocy: 100,
      orbR: 40,
      cx: 100,
      cy: 100,
      rb: 30,
      floor: 1000,
      dim: 1,
      reduceMotion: false,
    };
    p.update(frame);
    p.placeParticles(sx, sy, sz, vis, 64, frame);
    expect([...sx].every((v) => v === 5)).toBe(true);
    expect([...vis].every((v) => v === 1)).toBe(true);
    p.update({ ...frame, form: 1 });
    p.placeParticles(sx, sy, sz, vis, 64, { ...frame, form: 1 });
    expect([...sx].some((v) => v !== 5)).toBe(true);
  });
});
