import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  arrival,
  AURA_ASSETS,
  auraCamera,
  BIRTH,
  gustAt,
  headMatrix,
  IDLE,
  idlePose,
  VIEW,
  windForce,
  type FigureJson,
} from "./aura-data.ts";
import {
  buildRibbons,
  decodeSdf,
  growHair,
  lineCode,
  sampleSurface,
  sdfAt,
  stepHair,
  strandAttributes,
} from "./aura-figure.ts";
import {
  BLOOM_REACH,
  bloomFront,
  BUDGET,
  createAura,
  GAZE,
  gpuTier,
  isMobile,
  LINES,
  LOOKS,
  median,
  MIN_DPR,
  spring,
  swing,
  TIMING,
} from "./aura.ts";
import {
  BODY_FRAG,
  HAIR_VERT,
  LINE_FRAG,
  LINE_VERT,
  WEAVE,
} from "./aura-shaders.ts";

const STATIC = path.resolve(import.meta.dirname, "../../../static");
const fig = JSON.parse(
  fs.readFileSync(path.join(STATIC, AURA_ASSETS.figure), "utf8"),
) as FigureJson;

describe("aura figure", () => {
  it("ships a compressed glTF of a bust: 20-60k triangles with normals and head and breath weights", () => {
    const glb = fs.readFileSync(path.join(STATIC, AURA_ASSETS.mesh));
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    const jsonLen = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.toString("utf8", 20, 20 + jsonLen));
    expect(gltf.extensionsRequired).toContain("EXT_meshopt_compression");
    const prim = gltf.meshes[0].primitives[0];
    for (const a of [
      "POSITION",
      "NORMAL",
      "_HEAD",
      "_BREATH",
      "_GLOW",
      "_WARM",
    ])
      expect(prim.attributes[a]).toBeTypeOf("number");
    const tris = gltf.accessors[prim.indices].count / 3;
    expect(tris).toBeGreaterThan(20_000);
    expect(tris).toBeLessThan(60_000);
    expect(glb.length).toBeLessThan(1_500_000);
  });

  it("is documented: MakeHuman base mesh, CC0", () => {
    const doc = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../../../docs/third-party-assets.md",
      ),
      "utf8",
    );
    expect(doc).toMatch(/MakeHuman/);
    expect(doc).toMatch(/CC0/);
    expect(doc).toMatch(/aura-figure\.glb/);
    expect(fig.source).toMatch(/CC0/);
  });

  it("has natural proportions: a head above a short neck, round breasts in front, a waist below", () => {
    const { head, neck, breasts, waist } = fig;
    expect(head.c[1]).toBeGreaterThan(neck[1]);
    // A short, graceful neck: the chin a few centimetres above the neck joint.
    const chin = head.c[1] - head.r[1];
    expect(chin - neck[1]).toBeGreaterThan(0.02);
    expect(chin - neck[1]).toBeLessThan(0.1);
    // Her real head: about 21 cm from crown to chin, about 13 cm wide.
    expect(head.r[1] * 2).toBeGreaterThan(0.18);
    expect(head.r[1] * 2).toBeLessThan(0.24);
    expect(head.r[0] * 2).toBeGreaterThan(0.11);
    expect(head.r[0] * 2).toBeLessThan(0.16);
    for (const b of breasts) {
      expect(b[2]).toBeGreaterThan(neck[2] + 0.12);
      expect(b[1]).toBeLessThan(neck[1] - 0.12);
    }
    expect(Math.abs(breasts[0]![0] + breasts[1]![0])).toBeLessThan(1e-6);
    expect(waist).toBeLessThan(breasts[0]![1] - 0.05);
  });
});

describe("aura light lines", () => {
  it("weaves the body with isolines of surface fields baked on the mesh, drawn sharp in the shader", () => {
    const glb = fs.readFileSync(path.join(STATIC, AURA_ASSETS.mesh));
    const gltf = JSON.parse(
      glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)),
    );
    const attrs = gltf.meshes[0].primitives[0].attributes;
    for (const a of ["_FA", "_FB", "_ARM"])
      expect(attrs[a]).toBeTypeOf("number");
    // Screen-space derivatives make every line about a device pixel wide at any resolution.
    expect(BODY_FRAG).toContain("fwidth(g)");
    expect(BODY_FRAG).toContain("weave(");
    expect(WEAVE.spacing).toBeGreaterThan(0.003);
    expect(WEAVE.spacing).toBeLessThan(0.012);
    expect(WEAVE.warm).toBeGreaterThan(0.2);
    expect(WEAVE.warm).toBeLessThan(0.4);
    // Calm arms, a dense chest, a faint face.
    expect(WEAVE.arms).toBeLessThan(WEAVE.chest);
    expect(WEAVE.faceGain).toBeLessThan(0.6);
    // A few hand-laid accents remain (the collarbones), each lying on the surface.
    expect(fig.lines.length).toBeGreaterThanOrEqual(4);
    expect(fig.lines.length).toBeLessThanOrEqual(40);
    const sdf = decodeSdf(fig.sdf);
    for (const l of fig.lines)
      for (let i = 0; i < l.p.length; i += 7 * 5)
        expect(
          Math.abs(sdfAt(sdf, l.p[i]!, l.p[i + 1]!, l.p[i + 2]!)),
        ).toBeLessThan(0.015);
  });

  it("draws no seam down the face and no facial features", () => {
    expect(fig.lines.filter((x) => x.face).length).toBe(0);
    // The face's lines are masked away from its middle.
    expect(BODY_FRAG).toContain("abs(vObj.x)");
    for (const src of [BODY_FRAG, LINE_FRAG])
      expect(src).not.toMatch(/\b(eyes?|mouth|lips?|nose|brows?|pupils?)\b/i);
  });

  it("builds camera-facing ribbons: two vertices per point, widened in the shader at native resolution", () => {
    const r = buildRibbons(fig.lines.slice(0, 3));
    const pts = fig.lines.slice(0, 3).reduce((n, l) => n + l.p.length / 7, 0);
    expect(r.position.length).toBe(pts * 2 * 3);
    expect(r.index.length).toBe((pts - 3) * 6);
    expect(LINE_VERT).toContain("uRes");
    // Analytic anti-aliasing: the core never thinner than about a device pixel.
    expect(LINE_FRAG).toContain("max(");
    expect(lineCode(1, true, true) % 4).toBe(3);
    expect(LINES.core).toBeLessThan(LINES.glow);
  });
});

describe("aura hair", () => {
  const sdf = decodeSdf(fig.sdf);
  const hair = growHair(fig, 60, 3, sdf);

  it("grows from the scalp, never over the face, and rests outside the body", () => {
    let inside = 0;
    for (let i = 0; i < hair.pos.length / 3; i++)
      if (
        sdfAt(
          sdf,
          hair.pos[i * 3]!,
          hair.pos[i * 3 + 1]!,
          hair.pos[i * 3 + 2]!,
        ) < -0.002
      )
        inside++;
    expect(inside / (hair.pos.length / 3)).toBeLessThan(0.02);
    const { c, r } = fig.head;
    for (let g = 0; g < hair.guides; g++)
      for (let i = 0; i < hair.points; i++) {
        const k = (g * hair.points + i) * 3;
        const [x, y, z] = [hair.pos[k]!, hair.pos[k + 1]!, hair.pos[k + 2]!];
        // In front of the face, well within its width, below the hairline: no hair (it may cover the edges).
        if (z > c[2] + r[2] * 0.5 && y < c[1] + r[1] * 0.3 && y > c[1] - r[1])
          expect(Math.abs(x - c[0])).toBeGreaterThan(r[0] * 0.8);
      }
  });

  it("follows the head with lag, keeps its roots on it, and is still without motion", () => {
    const h = growHair(fig, 30, 3, sdf);
    const before = Float32Array.from(h.pos);
    const R = headMatrix(0.3, 0, 0);
    stepHair(h, 1 / 60, R, [0, 0], 1);
    // Roots follow the head's turn exactly.
    expect(h.pos[0]).not.toBeCloseTo(before[0]!, 4);
    // Without motion and with no wind, a settled head of hair stays where it is.
    const still = growHair(fig, 30, 3, sdf);
    const rest = Float32Array.from(still.pos);
    const I = headMatrix(0, 0, 0);
    stepHair(still, 1 / 60, I, [0, 0], 0);
    let moved = 0;
    for (let i = 0; i < rest.length; i++)
      moved = Math.max(moved, Math.abs(rest[i]! - still.pos[i]!));
    expect(moved).toBeLessThan(0.005);
    const s = strandAttributes(h, 100);
    expect(s.guides.length).toBe(300);
    expect(HAIR_VERT).toContain("uGuides");
  });

  it("feels the wind in gusts every 6-12 s, and none without motion", () => {
    expect(windForce(3, 0)).toEqual([0, 0]);
    let gusts = 0;
    let was = false;
    for (let t = 0; t < 60; t += 0.05) {
      const on = gustAt(t) > 0.5;
      if (on && !was) gusts++;
      was = on;
    }
    expect(gusts).toBeGreaterThanOrEqual(4);
    expect(gusts).toBeLessThanOrEqual(10);
  });

  it("swings after the head with a little overshoot and settles within a second", () => {
    const s = { x: 0, v: 0 };
    let peak = 0;
    let settled = Infinity;
    for (let i = 0; i < 240; i++) {
      swing(s, 1, 1 / 120);
      peak = Math.max(peak, s.x);
      if (Math.abs(s.x - 1) > 0.03) settled = Infinity;
      else if (settled === Infinity) settled = i / 120;
    }
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.35);
    expect(settled).toBeLessThan(1.1);
  });
});

describe("aura birth", () => {
  it("settles from the waist up, the face last, and ends in the rest frame", () => {
    expect(arrival(0.3, 0)).toBeLessThan(arrival(0.6, 0));
    expect(arrival(0.7, 1, 0)).toBeGreaterThan(arrival(0.8, 0, 1) - 0.25);
    expect(arrival(0.7, 1, 1) + BIRTH.settle).toBeLessThanOrEqual(BIRTH.total);
    expect(BIRTH.ringAt + BIRTH.ringTime).toBeLessThanOrEqual(BIRTH.total);
    expect(TIMING.birth).toBe(BIRTH.total);
  });

  it("samples the birth particles evenly over the surface", () => {
    const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const nrm = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    const s = sampleSurface(pos, nrm, [0, 0, 0, 0], [0, 1, 2, 1, 3, 2], 1000);
    let left = 0;
    for (let i = 0; i < 1000; i++) if (s.position[i * 3]! < 0.5) left++;
    expect(left).toBeGreaterThan(420);
    expect(left).toBeLessThan(580);
  });
});

describe("aura motion", () => {
  it("turns the head as a real rotation within limits, with its own small idle life", () => {
    const R = headMatrix(0.2, 0.1, 0.05);
    // Orthonormal columns.
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const d =
          R[i * 3]! * R[j * 3]! +
          R[i * 3 + 1]! * R[j * 3 + 1]! +
          R[i * 3 + 2]! * R[j * 3 + 2]!;
        expect(d).toBeCloseTo(i === j ? 1 : 0, 9);
      }
    expect(GAZE.yaw).toBeLessThan(0.5);
    let maxYaw = 0;
    for (let t = 0; t < 120; t += 0.25)
      maxYaw = Math.max(maxYaw, Math.abs(idlePose(t, 1).yaw));
    expect(maxYaw).toBeGreaterThan(0.03);
    expect(maxYaw).toBeLessThanOrEqual(IDLE.yaw + IDLE.aside + 1e-6);
    expect(idlePose(12.3, 0)).toEqual({ yaw: 0, pitch: 0, roll: 0 });
  });

  it("blooms moods from the face in about a second; every state has a look", () => {
    expect(TIMING.bloom).toBeCloseTo(1, 1);
    expect(bloomFront(0)).toBe(0);
    expect(bloomFront(1)).toBe(1);
    expect(BLOOM_REACH).toBeGreaterThan(0.5);
    for (const s of [
      "ready",
      "listening",
      "thinking",
      "executing",
      "speaking",
      "alert",
    ] as const)
      expect(LOOKS[s].a).toMatch(/^#[0-9a-f]{6}$/);
    const sp = { x: 0, v: 0 };
    let max = 0;
    for (let i = 0; i < 300; i++) {
      spring(sp, 0.3, 1 / 60);
      max = Math.max(max, sp.x);
    }
    expect(max).toBeLessThanOrEqual(0.3 + 1e-6);
  });

  it("frames head to bust on a wide screen and keeps the shoulders in a phone's width", () => {
    const t = Math.tan(((VIEW.fov / 2) * Math.PI) / 180);
    const wide = auraCamera(1920, 1080);
    expect(t * wide.distance).toBeGreaterThanOrEqual(
      (VIEW.top - VIEW.bottom) / 2 - 1e-6,
    );
    const phone = auraCamera(393, 852);
    // On a phone, head and bust fill about 85% of the height, centred.
    expect((VIEW.top - VIEW.bottom) / (2 * t * phone.distance)).toBeCloseTo(
      0.85,
      2,
    );
    expect(phone.targetY).toBeCloseTo((VIEW.top + VIEW.bottom) / 2, 5);
  });
});

describe("aura quality", () => {
  it("is low only on software rendering; phones mid, desktops high, at up to 2 device px", () => {
    expect(
      gpuTier(
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)",
        false,
      ),
    ).toBe("low");
    expect(
      gpuTier("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti SUPER)", false),
    ).toBe("high");
    expect(gpuTier("", false)).toBe("high");
    expect(gpuTier("Apple GPU", true)).toBe("mid");
    expect(gpuTier("Adreno (TM) 740", true)).toBe("mid");
    expect(BUDGET.high.dpr).toBe(2);
    expect(BUDGET.mid.dpr).toBe(2);
    expect(MIN_DPR.desktop).toBe(1);
    expect(MIN_DPR.phone).toBe(1.5);
    expect(
      isMobile(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        true,
        393,
      ),
    ).toBe(true);
    expect(
      isMobile("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", false, 2560),
    ).toBe(false);
    expect(median([30, 10, 20])).toBe(20);
    expect(median([])).toBe(0);
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
    expect(normalizeAvatar(undefined)).toBe("orb");
    vi.unstubAllGlobals();
  });
});
