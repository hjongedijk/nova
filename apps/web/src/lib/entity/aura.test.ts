import { describe, expect, it, vi } from "vitest";
import {
  auraField,
  auraViewHeight,
  buildHairGuides,
  CHIN,
  CROWN,
  headField,
  SDF_GLSL,
  weaveEase,
  weaveFront,
} from "./aura-body.ts";
import { BUDGET, GAZE, gpuTier, headRotation, LOOKS, TIMING } from "./aura.ts";
import { BODY_FRAG, HAIR_VERT } from "./aura-shaders.ts";

/** Half width of the figure at height y, scanning in from the side at depth z. */
function halfWidth(y: number, z = -0.05) {
  let x = 3;
  while (x > 0 && auraField(x, y, z) > 0) x -= 0.004;
  return x;
}

describe("aura body", () => {
  it("is a head on a long neck above sloping shoulders, arms beside a narrowing torso", () => {
    expect(auraField(0, 0.6, 0)).toBeLessThan(0); // head
    expect(auraField(0, -0.4, -0.08)).toBeLessThan(0); // neck
    expect(auraField(0, -1.6, 0)).toBeLessThan(0); // chest
    expect(auraField(1.2, -2.4, -0.08)).toBeLessThan(0); // upper arm
    expect(auraField(0, CROWN + 0.05, 0)).toBeGreaterThan(0);
    expect(auraField(0, CHIN - 0.2, 0.4)).toBeGreaterThan(0); // under the chin, in front of the neck

    const head = halfWidth(0.6, 0);
    const neck = halfWidth(-0.35, -0.08);
    const shoulders = halfWidth(-1.35);
    expect(neck).toBeLessThan(head * 0.7);
    expect(shoulders / head).toBeGreaterThan(2.2);
    expect(shoulders / head).toBeLessThan(3.5);
    // The arm hangs free of the ribs: a gap between them at mid chest.
    expect(auraField(0.92, -2.5, -0.07)).toBeGreaterThan(0);
  });

  it("is mirror symmetric and its GLSL twin has the same pieces", () => {
    for (const [x, y, z] of [
      [0.3, 0.5, 0.3],
      [1.1, -1.4, 0],
      [0.45, -2, 0.2],
      [0.12, 0.55, 0.45],
    ] as const)
      expect(auraField(x, y, z)).toBeCloseTo(auraField(-x, y, z), 9);
    for (const name of ["headSdf", "auraSdf", "PIVOT", "HEART", "FACE"])
      expect(SDF_GLSL).toContain(name);
    expect(BODY_FRAG).toContain("gl_FragDepth");
  });
});

describe("aura hair", () => {
  const g = buildHairGuides(12, 20);

  it("grows from the scalp, stays outside the body and falls past the chin", () => {
    expect(g.data.length).toBe(g.count * g.points * 4);
    expect(g.groups.at(-1)).toBe(g.count);
    let lowest = Infinity;
    for (let i = 0; i < g.count; i++) {
      const root = i * g.points * 4;
      // The root sits on (just above) the scalp.
      const dh = headField(g.data[root]!, g.data[root + 1]!, g.data[root + 2]!);
      expect(dh).toBeGreaterThan(-0.01);
      expect(dh).toBeLessThan(0.12);
      for (let k = 0; k < g.points; k++) {
        const o = root + k * 4;
        const [x, y, z] = [g.data[o]!, g.data[o + 1]!, g.data[o + 2]!];
        expect(Number.isFinite(x + y + z)).toBe(true);
        expect(auraField(x, y, z)).toBeGreaterThan(-0.01);
      }
      lowest = Math.min(lowest, g.data[root + (g.points - 1) * 4 + 1]!);
    }
    expect(lowest).toBeLessThan(CHIN - 1);
  });

  it("builds the full guide set quickly enough to never hold up the page", () => {
    const t0 = performance.now();
    const full = buildHairGuides();
    const ms = performance.now() - t0;
    expect(full.count).toBe(180);
    expect(ms).toBeLessThan(250);
  });

  it("is the same on both sides", () => {
    const half = g.count / 2;
    for (const i of [0, 5, half - 1]) {
      const a = (i * g.points + g.points - 1) * 4;
      const b = ((i + half) * g.points + g.points - 1) * 4;
      expect(g.data[a]!).toBeCloseTo(-g.data[b]!, 5);
      expect(g.data[a + 1]!).toBeCloseTo(g.data[b + 1]!, 5);
    }
    expect(HAIR_VERT).toContain("texelFetch");
  });
});

describe("aura motion", () => {
  it("ends the weave and the bloom exactly at rest (no pop)", () => {
    for (const ease of [weaveEase, weaveFront]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      expect(ease(2)).toBe(1);
      let last = 0;
      for (let x = 0; x <= 1; x += 0.05) {
        expect(ease(x)).toBeGreaterThanOrEqual(last);
        last = ease(x);
      }
    }
    expect(TIMING.bloom).toBeCloseTo(1, 1);
    expect(TIMING.weave).toBeGreaterThan(2);
  });

  it("turns the head within limits, as a pure rotation", () => {
    const id = headRotation(0, 0, 0);
    expect(id).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const r = headRotation(GAZE.yaw, GAZE.pitch, 0.04);
    // Orthonormal rows.
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const dot =
          r[i * 3]! * r[j * 3]! +
          r[i * 3 + 1]! * r[j * 3 + 1]! +
          r[i * 3 + 2]! * r[j * 3 + 2]!;
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 9);
      }
    // Pointer to the right: the face (+z) turns toward +x. Positive pitch looks down.
    expect(headRotation(0.3, 0, 0)[2]).toBeGreaterThan(0);
    expect(headRotation(0, 0.1, 0)[5]).toBeGreaterThan(0);
    expect(GAZE.yaw).toBeLessThan(0.5);
  });

  it("has a look for every state and the alert", () => {
    for (const s of [
      "ready",
      "listening",
      "thinking",
      "executing",
      "speaking",
      "alert",
    ] as const) {
      expect(LOOKS[s].a).toMatch(/^#[0-9a-f]{6}$/);
      expect(LOOKS[s].glow).toBeGreaterThan(0.8);
      expect(LOOKS[s].glow).toBeLessThan(1.4);
    }
  });
});

describe("aura quality and layout", () => {
  it("budgets strands and motes per GPU class", () => {
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
    expect(BUDGET.low.strands).toBeLessThan(BUDGET.mid.strands);
    expect(BUDGET.mid.strands).toBeLessThan(BUDGET.high.strands);
    expect(BUDGET.mid.dpr).toBeLessThanOrEqual(1.5);
  });

  it("frames the head in the upper third at 16:9 and keeps the shoulders on a phone", () => {
    const vh = auraViewHeight(16 / 9);
    expect((CROWN - CHIN) / vh).toBeGreaterThan(0.28);
    expect((CROWN - CHIN) / vh).toBeLessThan(0.4);
    const phone = 390 / 844;
    expect(auraViewHeight(phone) * phone).toBeGreaterThan(2 * halfWidth(-1.35));
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
