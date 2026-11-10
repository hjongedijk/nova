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

/** Half width of the figure at height y, scanning in from x = `from` at depth z. */
function halfWidth(y: number, z = -0.05, from = 3) {
  let x = from;
  while (x > 0 && auraField(x, y, z) > 0) x -= 0.002;
  return x;
}

describe("aura body", () => {
  it("has adult female proportions: head, a neck half its height, gentle shoulders", () => {
    // One head is one unit: chin at 0, crown at 1.
    expect(CROWN - CHIN).toBeCloseTo(1, 1);
    expect(auraField(0, 0.5, 0)).toBeLessThan(0);
    expect(auraField(0, CROWN + 0.03, -0.05)).toBeGreaterThan(0);
    // The head is about 1.3-1.45 times as tall as it is wide.
    const headW = 2 * halfWidth(0.6, -0.05, 1);
    expect((CROWN - CHIN) / headW).toBeGreaterThan(1.3);
    expect((CROWN - CHIN) / headW).toBeLessThan(1.5);
    // A slender but real neck from under the jaw to the notch, about half a head long.
    expect(auraField(0, -0.12, -0.04)).toBeLessThan(0);
    expect(auraField(0, CHIN - 0.12, 0.3)).toBeGreaterThan(0);
    const neckW = 2 * halfWidth(-0.12, -0.04, 1);
    expect(neckW / headW).toBeGreaterThan(0.38);
    expect(neckW / headW).toBeLessThan(0.6);
    // Shoulders about two and a half head widths; the line from neck to shoulder slopes down.
    const shoulders = 2 * halfWidth(-0.72);
    expect(shoulders / headW).toBeGreaterThan(2.1);
    expect(shoulders / headW).toBeLessThan(2.8);
    const top = (x: number) => {
      let y = 0;
      while (auraField(x, y, -0.08) > 0) y -= 0.002;
      return y;
    };
    const slope = (Math.atan2(top(0.25) - top(0.6), 0.35) * 180) / Math.PI;
    expect(slope).toBeGreaterThan(12);
    expect(slope).toBeLessThan(35);
  });

  it("tapers from the rib cage to a defined waist and opens to the hips; the arms hang free", () => {
    const ribs = halfWidth(-1.45, -0.04, 0.68);
    const waist = halfWidth(-2.0, -0.02, 0.7);
    const hips = halfWidth(-2.75, -0.02, 0.8);
    expect(waist).toBeLessThan(ribs * 0.88);
    expect(hips).toBeGreaterThan(waist * 1.3);
    expect(auraField(0.62, -1.6, -0.07)).toBeGreaterThan(0);
    // A natural bust: in front of the chest, never past the shoulders.
    expect(auraField(0.26, -1.0, 0.28)).toBeLessThan(0);
    expect(auraField(0.26, -1.0, 0.36)).toBeGreaterThan(0);
  });

  it("is a softly sculpted mask: closed eyes, nose, lips and chin in relief, no crease down the face", () => {
    expect(headField(0, 0.37, 0.415)).toBeLessThan(0); // the tip of the nose
    expect(headField(0.1, 0.37, 0.415)).toBeGreaterThan(0); // beside it, the cheek is further back
    expect(headField(0, 0.03, 0.2)).toBeLessThan(0); // a defined chin
    // No carved sockets: the surface at the eyes is no deeper than a smooth face would be.
    let z = 0.6;
    while (headField(0.115, 0.46, z) > 0) z -= 0.002;
    expect(z).toBeGreaterThan(0.33);
    // Closed lids: the eye area is a shallow hollow under the brow, never a socket.
    let brow = 0.6;
    while (headField(0.115, 0.56, brow) > 0) brow -= 0.002;
    expect(brow - z).toBeLessThan(0.08);
    // The upper lip has a Cupid's bow: fuller either side of the centre than at it.
    let lipC = 0.5;
    while (headField(0, 0.208, lipC) > 0) lipC -= 0.001;
    let lipS = 0.5;
    while (headField(0.03, 0.208, lipS) > 0) lipS -= 0.001;
    expect(lipS).toBeGreaterThanOrEqual(lipC - 0.004);
    // The mirror fold is smooth: the field has no kink at x = 0.
    const e = 1e-3;
    const left = headField(-e, 0.5, 0.35) - headField(0, 0.5, 0.35);
    const right = headField(e, 0.5, 0.35) - headField(0, 0.5, 0.35);
    expect(Math.abs(left - right)).toBeLessThan(1e-4);
  });

  it("is mirror symmetric and its GLSL twin has the same pieces", () => {
    for (const [x, y, z] of [
      [0.3, 0.5, 0.3],
      [0.7, -0.7, 0],
      [0.26, -1.0, 0.2],
      [0.12, 0.45, 0.38],
    ] as const)
      expect(auraField(x, y, z)).toBeCloseTo(auraField(-x, y, z), 9);
    for (const name of ["headSdf", "auraSdf", "PIVOT", "HEART", "FACE"])
      expect(SDF_GLSL).toContain(name);
    expect(BODY_FRAG).toContain("gl_FragDepth");
    // No seam down the face any more.
    expect(BODY_FRAG).not.toContain("onFace");
  });
});

describe("aura hair", () => {
  const g = buildHairGuides(12, 20);

  it("sits on the skull, stays outside the body and falls past the shoulders", () => {
    expect(g.data.length).toBe(g.count * g.points * 4);
    expect(g.groups.at(-1)).toBe(g.count);
    let lowest = Infinity;
    for (let i = 0; i < g.count; i++) {
      const root = i * g.points * 4;
      const dh = headField(g.data[root]!, g.data[root + 1]!, g.data[root + 2]!);
      expect(dh).toBeGreaterThan(-0.01);
      expect(dh).toBeLessThan(0.2);
      // Still on the skull a few points later: it lies on the head instead of floating off it.
      const o = root + 2 * 4;
      expect(
        headField(g.data[o]!, g.data[o + 1]!, g.data[o + 2]!),
      ).toBeLessThan(0.2);
      for (let k = 0; k < g.points; k++) {
        const q = root + k * 4;
        const [x, y, z] = [g.data[q]!, g.data[q + 1]!, g.data[q + 2]!];
        expect(Number.isFinite(x + y + z)).toBe(true);
        expect(auraField(x, y, z)).toBeGreaterThan(-0.01);
      }
      lowest = Math.min(lowest, g.data[root + (g.points - 1) * 4 + 1]!);
    }
    expect(lowest).toBeLessThan(-0.9);
  });

  it("has a soft side parting and locks both in front of and behind the shoulders", () => {
    for (let i = 0; i < g.count; i++) {
      const x = g.data[i * g.points * 4]!;
      expect(x).toBeGreaterThan(0.03);
      expect(x).toBeLessThan(0.25);
    }
    let inFront = 0;
    let behind = 0;
    for (let i = 0; i < g.count; i++) {
      const tip = (i * g.points + g.points - 1) * 4;
      if (g.data[tip + 2]! > 0.12) inFront++;
      if (g.data[tip + 2]! < -0.1) behind++;
    }
    expect(inFront).toBeGreaterThan(0);
    expect(behind).toBeGreaterThan(0);
    expect(HAIR_VERT).toContain("texelFetch");
  });

  it("builds the full guide set quickly enough to never hold up the page", () => {
    const t0 = performance.now();
    const full = buildHairGuides();
    const ms = performance.now() - t0;
    expect(full.count).toBe(288);
    // Generous: the suite runs files in parallel on a busy machine; alone it takes a few tens of ms.
    expect(ms).toBeLessThan(1500);
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

  it("frames a bust portrait: head about 43% of a 16:9 height, shoulders kept on a phone", () => {
    const vh = auraViewHeight(16 / 9);
    expect((CROWN - CHIN) / vh).toBeGreaterThan(0.4);
    expect((CROWN - CHIN) / vh).toBeLessThan(0.46);
    const phone = 390 / 844;
    expect(auraViewHeight(phone) * phone).toBeGreaterThan(2 * halfWidth(-0.72));
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
