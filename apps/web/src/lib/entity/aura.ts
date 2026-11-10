import type * as ThreeModule from "three";
import type { UiState } from "#lib/stores/chat.svelte.ts";
import {
  auraCameraY,
  auraViewHeight,
  buildHairGuides,
  HEART,
  REST_POSE,
  weaveFront,
  type HairGuides,
} from "./aura-body.ts";
import {
  BG_FRAG,
  BG_VERT,
  BODY_FRAG,
  BODY_VERT,
  HAIR_FRAG,
  HAIR_VERT,
  MOTE_FRAG,
  MOTE_VERT,
  POST_FRAG,
  POST_VERT,
} from "./aura-shaders.ts";

/**
 * AURA on the GPU: an elegant upper body of dark glass, drawn with neon strokes that follow its form, long hair
 * of fine light strands, a starry interior, in a room of violet smoke and slow ribbons.
 *
 * Same contract as the Gestalte (entity.ts drives both): a WebGL2 canvas under the entity's 2D canvas, built
 * lazily, `null` when WebGL2 or three.js is not available (entity.ts then falls back to the Canvas2D presence).
 * Nothing here waits on chat or audio: the frame only reads the values it is handed.
 */

type Three = typeof ThreeModule;

export interface AuraFrame {
  t: number;
  dt: number;
  /** 0 = orb, 1 = figure: the weave runs while this rises and unravels with it when it falls. */
  form: number;
  state: UiState;
  alert: boolean;
  /** Smoothed voice level 0..1. */
  audio: number;
  /** Smoothed pointer, -1..1. */
  gazeX: number;
  gazeY: number;
  /** Top of the visible reply in CSS pixels (far below the screen when there is none). */
  floor: number;
  /** 0..1 overall brightness (the orb's birth). */
  dim: number;
  reduceMotion: boolean;
}

export interface Aura {
  readonly canvas: HTMLCanvasElement;
  render(f: AuraFrame): void;
  /** Hide without disposing (the orb is showing). */
  hide(): void;
  dispose(): void;
  readonly stats: AuraStats;
}

export interface AuraStats {
  tier: GpuTier;
  scale: number;
  pixels: number;
  strands: number;
  motes: number;
  /** Smoothed interval between rendered frames, ms. */
  frameMs: number;
}

export type GpuTier = "low" | "mid" | "high";

/** Colours per look, as sRGB hex; converted to linear once. */
interface Look {
  /** Main stroke colour. */
  a: string;
  /** Accent strokes (the warm ones). */
  b: string;
  /** Rim light. */
  r: string;
  /** Face light. */
  f: string;
  /** Hair. */
  h: string;
  /** Overall stroke and rim intensity. */
  glow: number;
  /** Speed of the light travelling along the strokes. */
  pulse: number;
}

export const LOOKS: Record<UiState | "alert", Look> = {
  ready: {
    a: "#b955ff",
    b: "#ffb27a",
    r: "#c99bff",
    f: "#d9b8ff",
    h: "#a85cff",
    glow: 1.12,
    pulse: 0.6,
  },
  listening: {
    a: "#8a72ff",
    b: "#9fc8ff",
    r: "#a7a8ff",
    f: "#d8e2ff",
    h: "#8f7cff",
    glow: 1.16,
    pulse: 0.9,
  },
  thinking: {
    a: "#e45cf0",
    b: "#ffc06b",
    r: "#e69cff",
    f: "#ffd0f4",
    h: "#c55cf5",
    glow: 1.12,
    pulse: 2.4,
  },
  executing: {
    a: "#d26cff",
    b: "#ffcf73",
    r: "#e0a8ff",
    f: "#ffe0b8",
    h: "#b866ff",
    glow: 1.1,
    pulse: 2,
  },
  speaking: {
    a: "#e05cd0",
    b: "#ffc49a",
    r: "#d68ad6",
    f: "#f2c4e2",
    h: "#c066e6",
    glow: 1.0,
    pulse: 1.2,
  },
  alert: {
    a: "#ff4a6a",
    b: "#ffa070",
    r: "#ff8a9a",
    f: "#ffd0d0",
    h: "#ff5a8a",
    glow: 1.15,
    pulse: 1.6,
  },
};

/** The room. */
export const ROOM = {
  bg0: "#07040e",
  bg1: "#030106",
  smoke: "#1e0f36",
  ribbon: "#7f62b8",
  star: "#d8ccf4",
  aura: "#211040",
  clear: "#05030b",
} as const;

/** Strand, mote and resolution budgets per GPU class. */
export const BUDGET: Record<
  GpuTier,
  { strands: number; motes: number; dpr: number }
> = {
  low: { strands: 2200, motes: 260, dpr: 1 },
  mid: { strands: 5200, motes: 620, dpr: 1.5 },
  high: { strands: 8400, motes: 900, dpr: 2 },
};

/** Guess the GPU class from the renderer string; software renderers and old integrated parts get the low budget. */
export function gpuTier(renderer: string, width: number): GpuTier {
  const r = renderer.toLowerCase();
  if (
    /swiftshader|llvmpipe|software|softpipe|mali-[2-4]|adreno \(tm\) [2-5]\d\d|powervr|intel.*hd graphics [2-6]\d{2,3}\b/.test(
      r,
    )
  )
    return "low";
  if (width < 700) return "low";
  if (/rtx|radeon rx [6-9]|apple m[2-9]|rx 7|arc a7/.test(r)) return "high";
  return "mid";
}

let cachedHair: HairGuides | null = null;

function webgl2Available(): boolean {
  try {
    const probe = document.createElement("canvas");
    const ctx = probe.getContext("webgl2");
    if (!ctx) return false;
    ctx.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

async function loadThree() {
  const [three, ec, rp, ub, op, sp] = await Promise.all([
    import("three"),
    import("three/examples/jsm/postprocessing/EffectComposer.js"),
    import("three/examples/jsm/postprocessing/RenderPass.js"),
    import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
    import("three/examples/jsm/postprocessing/OutputPass.js"),
    import("three/examples/jsm/postprocessing/ShaderPass.js"),
  ]);
  return {
    THREE: three as Three,
    EffectComposer: ec.EffectComposer,
    RenderPass: rp.RenderPass,
    UnrealBloomPass: ub.UnrealBloomPass,
    OutputPass: op.OutputPass,
    ShaderPass: sp.ShaderPass,
  };
}

/** Row-major rotation, yaw (y) · pitch (x) · roll (z). */
export function headRotation(
  yaw: number,
  pitch: number,
  roll: number,
): number[] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  // Ry
  const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  // Rx: positive pitch turns the face down.
  const rx = [1, 0, 0, 0, cp, sp, 0, -sp, cp];
  const rz = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  const mul = (a: number[], b: number[]) => {
    const o = new Array<number>(9).fill(0);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++)
          o[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
    return o;
  };
  return mul(mul(ry, rx), rz);
}

/** Head turn limits toward the pointer, radians. */
export const GAZE = { yaw: 0.34, pitch: 0.13 } as const;

/** Duration of the weave on mount, and of the state bloom spreading from the face, seconds. */
export const TIMING = { weave: 3.2, bloom: 1.0 } as const;

export async function createAura(
  under: HTMLCanvasElement,
  options: { tier?: GpuTier } = {},
): Promise<Aura | null> {
  if (typeof document === "undefined" || !webgl2Available()) return null;
  let mods: Awaited<ReturnType<typeof loadThree>>;
  try {
    mods = await loadThree();
  } catch {
    return null;
  }
  const {
    THREE,
    EffectComposer,
    RenderPass,
    UnrealBloomPass,
    OutputPass,
    ShaderPass,
  } = mods;

  const canvas = document.createElement("canvas");
  canvas.className = "entity-gl entity-aura";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    display: "none",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  let renderer: ThreeModule.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
    });
  } catch {
    return null;
  }
  under.before(canvas);
  renderer.setClearColor(ROOM.clear, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  let rendererName = "";
  try {
    const gl = renderer.getContext();
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    rendererName = String(
      gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "",
    );
  } catch {
    /* unknown GPU: mid budget */
  }
  const tier = options.tier ?? gpuTier(rendererName, window.innerWidth);
  const budget = BUDGET[tier];

  const col = (hex: string) => new THREE.Color(hex);
  const vec = (hex: string) => {
    const c = col(hex);
    return new THREE.Vector3(c.r, c.g, c.b);
  };
  const lin = Object.fromEntries(
    Object.entries(LOOKS).map(([k, l]) => [
      k,
      {
        a: vec(l.a),
        b: vec(l.b),
        r: vec(l.r),
        f: vec(l.f),
        h: vec(l.h),
        glow: l.glow,
        pulse: l.pulse,
      },
    ]),
  ) as Record<
    UiState | "alert",
    {
      a: ThreeModule.Vector3;
      b: ThreeModule.Vector3;
      r: ThreeModule.Vector3;
      f: ThreeModule.Vector3;
      h: ThreeModule.Vector3;
      glow: number;
      pulse: number;
    }
  >;

  const U = {
    uT: { value: 0 },
    uMotion: { value: 1 },
    uWeave: { value: 0 },
    uWaveR: { value: 100 },
    uWaveEdge: { value: 0 },
    uAudio: { value: 0 },
    uPulse: { value: 0.6 },
    uGlow: { value: 1 },
    uA0: { value: lin.ready.a.clone() },
    uA1: { value: lin.ready.a.clone() },
    uB0: { value: lin.ready.b.clone() },
    uB1: { value: lin.ready.b.clone() },
    uR0: { value: lin.ready.r.clone() },
    uR1: { value: lin.ready.r.clone() },
    uF0: { value: lin.ready.f.clone() },
    uF1: { value: lin.ready.f.clone() },
    uH0: { value: lin.ready.h.clone() },
    uH1: { value: lin.ready.h.clone() },
    uHead: { value: new THREE.Matrix3() },
    uHeadInv: { value: new THREE.Matrix3() },
    uBreath: { value: 0 },
    uPV: { value: new THREE.Matrix4() },
    uPixAngle: { value: 0.001 },
    uKey: { value: new THREE.Vector3(-0.45, 0.65, 0.75) },
    uPx: { value: 1 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uBg0: { value: vec(ROOM.bg0) },
    uBg1: { value: vec(ROOM.bg1) },
    uSmoke: { value: vec(ROOM.smoke) },
    uRibbon: { value: vec(ROOM.ribbon) },
    uStar: { value: vec(ROOM.star) },
    uAuraC: { value: vec(ROOM.aura) },
    uCenter: { value: new THREE.Vector2(0, 0) },
    uPar: { value: new THREE.Vector2() },
    uGuides: { value: null as ThreeModule.DataTexture | null },
    uPoints: { value: 1 },
    uHairGain: { value: 1 },
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 100);
  // The body writes its ray-marched depth with the very matrices the hair is drawn with (projection here, the
  // view matrix three hands every shader), so a strand in front of the skin is always drawn in front of it.
  U.uPV.value = camera.projectionMatrix;

  /* background */
  const quad = new THREE.PlaneGeometry(1, 1);
  const bgMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: BG_VERT,
    fragmentShader: BG_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const bg = new THREE.Mesh(quad, bgMat);

  /* body: a bounded quad in front of the figure, ray-marched per pixel */
  // Bust portrait: nothing below the upper chest is ever marched.
  const bodyQuad = new THREE.PlaneGeometry(2.4, 2.65);
  bodyQuad.translate(0, 0.05, 0.6);
  const bodyMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: BODY_VERT,
    fragmentShader: BODY_FRAG,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const body = new THREE.Mesh(bodyQuad, bodyMat);

  /* hair: strands interpolated between guides on the GPU */
  const guides = (cachedHair ??= buildHairGuides());
  const guideTex = new THREE.DataTexture(
    guides.data,
    guides.points,
    guides.count,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  guideTex.minFilter = THREE.NearestFilter;
  guideTex.magFilter = THREE.NearestFilter;
  guideTex.needsUpdate = true;
  U.uGuides.value = guideTex;
  U.uPoints.value = guides.points;
  const maxStrands = BUDGET.high.strands;
  const hairGeo = new THREE.BufferGeometry();
  {
    const pts = guides.points;
    const strand = new Float32Array(maxStrands * pts * 4);
    const index = new Uint32Array(maxStrands * (pts - 1) * 2);
    let rnd = 1234567;
    const rand = () => {
      rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
      return rnd / 0x7fffffff;
    };
    const groups = guides.groups;
    let ii = 0;
    for (let s = 0; s < maxStrands; s++) {
      // Interleave the groups so a lower budget (a shorter draw range) keeps every layer and both sides.
      const gi = s % (groups.length - 1);
      const g0 = groups[gi]!;
      const g1 = groups[gi + 1]!;
      const span = g1 - g0 - 1;
      const pos = rand() * span;
      const ga = g0 + Math.min(span - 1, Math.floor(pos));
      const mix = pos - Math.floor(pos);
      const seed = rand();
      for (let k = 0; k < pts; k++) {
        const o = (s * pts + k) * 4;
        strand[o] = ga;
        strand[o + 1] = mix;
        strand[o + 2] = seed;
        strand[o + 3] = k;
        if (k < pts - 1) {
          index[ii++] = s * pts + k;
          index[ii++] = s * pts + k + 1;
        }
      }
    }
    hairGeo.setAttribute("aStrand", new THREE.BufferAttribute(strand, 4));
    // three needs a position attribute to count vertices; the shader ignores it.
    hairGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(maxStrands * pts * 3), 3),
    );
    hairGeo.setIndex(new THREE.BufferAttribute(index, 1));
  }
  let strands = budget.strands;
  const setStrands = (n: number) => {
    U.uHairGain.value = Math.min(1, 3600 / Math.max(1, n));
    strands = n;
    hairGeo.setDrawRange(0, n * (guides.points - 1) * 2);
  };
  setStrands(strands);
  const additive = {
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  } as const;
  const hairMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: HAIR_VERT,
    fragmentShader: HAIR_FRAG,
    ...additive,
  });
  const hair = new THREE.LineSegments(hairGeo, hairMat);

  /* drifting motes */
  const maxMotes = BUDGET.high.motes;
  const moteGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(maxMotes * 3);
    const seed = new Float32Array(maxMotes * 4);
    for (let i = 0; i < maxMotes; i++) {
      const h = (n: number) =>
        Math.abs(Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1;
      // Mostly near the figure, some wide in the room.
      const near = h(1) < 0.6;
      pos[i * 3] = (h(2) - 0.5) * (near ? 2.6 : 7);
      pos[i * 3 + 1] = -3 + h(3) * 6.4;
      pos[i * 3 + 2] = (h(4) - 0.5) * (near ? 1.2 : 3) + (near ? 0.12 : -0.8);
      for (let k = 0; k < 4; k++) seed[i * 4 + k] = h(5 + k);
    }
    moteGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    moteGeo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
  }
  let motes = budget.motes;
  moteGeo.setDrawRange(0, motes);
  const moteMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    ...additive,
  });
  const moteMesh = new THREE.Points(moteGeo, moteMat);

  const order: [ThreeModule.Object3D, number][] = [
    [bg, -10],
    [body, 0],
    [hair, 1],
    [moteMesh, 2],
  ];
  for (const [o, r] of order) {
    o.renderOrder = r;
    o.frustumCulled = false;
    scene.add(o);
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(256, 256),
    1.05,
    0.5,
    0.6,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const postMat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uRes: U.uRes,
      uT: U.uT,
      uMotion: U.uMotion,
      uPx: U.uPx,
      uFloor: { value: -1e4 },
    },
    vertexShader: POST_VERT,
    fragmentShader: POST_FRAG,
  });
  const post = new ShaderPass(postMat);
  composer.addPass(post);

  /* sizing: the buffer is capped per GPU class and steps down while frames run long */
  let W = 0;
  let H = 0;
  // Software and old integrated GPUs start a step lower; the loop below finds the rest.
  let scale = tier === "low" ? 0.75 : 1;
  let pr = 1;
  const camTarget = new THREE.Vector3();
  function size(force = false) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(
      window.devicePixelRatio || 1,
      budget.dpr,
      3840 / Math.max(1, w),
      2160 / Math.max(1, h),
    );
    const next = Math.max(0.5, dpr * scale);
    if (!force && w === W && h === H && Math.abs(next - pr) < 0.01) return;
    W = w;
    H = h;
    pr = next;
    renderer.setPixelRatio(pr);
    renderer.setSize(W, H, false);
    composer.setPixelRatio(pr);
    composer.setSize(W, H);
    const aspect = W / Math.max(1, H);
    const narrow = aspect < 0.8;
    const vh = auraViewHeight(aspect);
    const camY = auraCameraY(aspect, narrow ? 0.2 : 0.07);
    const dist = vh / 2 / Math.tan(((camera.fov / 2) * Math.PI) / 180);
    camera.aspect = aspect;
    // A touch above the chest line, looking level: the face is met straight on.
    camera.position.set(0, camY + 0.1, dist);
    camTarget.set(0, camY, 0);
    camera.lookAt(camTarget);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    U.uRes.value.set(W * pr, H * pr);
    U.uPx.value = pr;
    U.uPixAngle.value =
      (2 * Math.tan(((camera.fov / 2) * Math.PI) / 180)) / Math.max(1, H * pr);
    // Where the heart is on screen: the room's light gathers behind it.
    const hp = new THREE.Vector3(HEART[0], HEART[1] + 0.7, 0).project(camera);
    U.uCenter.value.set(hp.x * 0.5 * aspect, hp.y * 0.5);
  }
  size(true);
  // Compile every program off the frame (parallel where the driver allows): the first shown frame must not hitch.
  try {
    await renderer.compileAsync(scene, camera);
  } catch {
    /* compiled lazily on first render instead */
  }

  /* state: a bloom spreading from the face carries the new look outward */
  type Key = UiState | "alert";
  let key: Key = "ready";
  let waveP = 1;
  const glowPulse = { glow: lin.ready.glow, pulse: lin.ready.pulse };
  const prevGP = { glow: lin.ready.glow, pulse: lin.ready.pulse };
  const nextGP = { glow: lin.ready.glow, pulse: lin.ready.pulse };
  const pairs: [keyof typeof U, keyof typeof U, "a" | "b" | "r" | "f" | "h"][] =
    [
      ["uA0", "uA1", "a"],
      ["uB0", "uB1", "b"],
      ["uR0", "uR1", "r"],
      ["uF0", "uF1", "f"],
      ["uH0", "uH1", "h"],
    ];
  function retarget(next: Key, instant: boolean) {
    const k = waveP >= 1 ? 1 : weaveFront(waveP);
    for (const [p0, p1, c] of pairs) {
      const v0 = U[p0].value as ThreeModule.Vector3;
      const v1 = U[p1].value as ThreeModule.Vector3;
      // Interrupted mid-bloom: start from what most of the body shows now.
      v0.lerp(v1, k);
      v1.copy(lin[next][c]);
      if (instant) v0.copy(v1);
    }
    prevGP.glow = glowPulse.glow;
    prevGP.pulse = glowPulse.pulse;
    nextGP.glow = lin[next].glow;
    nextGP.pulse = lin[next].pulse;
    key = next;
    waveP = instant ? 1 : 0;
  }

  const pose = {
    yaw: { x: 0, v: 0 },
    pitch: { x: 0, v: 0 },
    roll: { x: 0, v: 0 },
  };
  function spring(s: { x: number; v: number }, target: number, dt: number) {
    // Critically damped: glides toward the pointer, keeps velocity through a retarget, never overshoots.
    const w = (2 * Math.PI) / 1.6;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = Math.min(dt, 0.1) / steps;
    for (let i = 0; i < steps; i++) {
      s.v += (w * w * (target - s.x) - 2 * w * s.v) * h;
      s.x += s.v * h;
    }
  }
  const weight = { listening: 0, thinking: 0, speaking: 0 };
  const par = { x: 0, y: 0 };
  let weave = 0;
  let lastForm = 0;
  let lastT = -1;
  let slow = 0;
  let fast = 0;
  let frameMs = 16.7;
  const Rm = new THREE.Matrix3();

  return {
    canvas,
    get stats() {
      return {
        tier,
        scale,
        pixels: Math.round(W * pr) * Math.round(H * pr),
        strands,
        motes,
        frameMs: Math.round(frameMs * 10) / 10,
      };
    },
    render(f) {
      const { t } = f;
      const dt = Math.max(0, Math.min(0.1, f.dt));
      // Adaptive quality: long frames first thin the hair and motes, then lower the buffer, never the frame rate.
      if (lastT >= 0) {
        const gap = (t - lastT) * 1000;
        if (gap < 200) {
          frameMs = frameMs * 0.95 + gap * 0.05;
          slow = slow * 0.97 + (gap > 22 ? 1 : 0) * 0.03;
          fast = gap < 17.5 ? fast + gap / 1000 : 0;
        }
        if (slow > 0.6) {
          slow = 0;
          if (strands > BUDGET.low.strands)
            setStrands(
              Math.max(BUDGET.low.strands, Math.round(strands * 0.75)),
            );
          else if (scale > 0.55) scale = Math.max(0.55, scale * 0.85);
          motes = Math.max(BUDGET.low.motes, Math.round(motes * 0.8));
          moteGeo.setDrawRange(0, motes);
        } else if (fast > 12 && scale < 1) {
          // A long run of quick frames: give back one step of resolution.
          fast = 0;
          scale = Math.min(1, scale / 0.85);
        }
      }
      lastT = t;
      size();
      canvas.style.display = "block";
      canvas.style.opacity = String(
        Math.min(1, f.form / 0.3) * (0.35 + 0.65 * f.dim),
      );

      const motion = f.reduceMotion ? 0 : 1;
      // Birth: woven from the heart outward while the figure forms; unravels with it. Skipped without motion.
      if (f.reduceMotion) weave = f.form > 0 ? 1 : 0;
      else if (f.form >= lastForm && f.form > 0)
        weave = Math.min(1, weave + dt / TIMING.weave);
      else weave = Math.min(weave, f.form);
      lastForm = f.form;
      U.uWeave.value = weave >= 1 ? 1 : weaveFront(weave);

      const want: Key = f.alert ? "alert" : f.state;
      if (want !== key) retarget(want, f.reduceMotion);
      if (waveP < 1) {
        waveP = Math.min(1, waveP + dt / TIMING.bloom);
        const e = weaveFront(waveP);
        // Soft growing radius from the face; reaches the hips (about 5.5 units away) as the second ends.
        U.uWaveR.value = e * 6.6;
        U.uWaveEdge.value =
          0.9 * Math.sin(Math.PI * Math.min(1, waveP * 1.15)) * (1 - waveP);
        glowPulse.glow = prevGP.glow + (nextGP.glow - prevGP.glow) * e;
        glowPulse.pulse = prevGP.pulse + (nextGP.pulse - prevGP.pulse) * e;
        if (waveP >= 1)
          for (const [p0, p1] of pairs)
            (U[p0].value as ThreeModule.Vector3).copy(
              U[p1].value as ThreeModule.Vector3,
            );
      } else {
        U.uWaveR.value = 100;
        U.uWaveEdge.value = 0;
        glowPulse.glow = nextGP.glow;
        glowPulse.pulse = nextGP.pulse;
      }

      const kw = 1 - Math.exp(-dt * 3);
      weight.listening +=
        ((f.state === "listening" ? 1 : 0) - weight.listening) * kw;
      weight.thinking +=
        ((f.state === "thinking" || f.state === "executing" ? 1 : 0) -
          weight.thinking) *
        kw;
      weight.speaking +=
        ((f.state === "speaking" ? 1 : 0) - weight.speaking) * kw;

      /* head: toward the pointer, within limits, on springs */
      const clamp = (x: number, m: number) => Math.max(-m, Math.min(m, x));
      const yawT =
        motion *
        clamp(
          f.gazeX * GAZE.yaw +
            0.03 * Math.sin(t * 0.17) +
            0.008 * Math.sin(t * 0.61 + 0.7) +
            weight.thinking * 0.06,
          GAZE.yaw,
        );
      const pitchT =
        motion *
        clamp(
          f.gazeY * GAZE.pitch -
            weight.thinking * 0.05 +
            weight.listening * 0.04 +
            weight.speaking * 0.02 * f.audio * Math.sin(t * 2.3),
          GAZE.pitch,
        );
      const rollT =
        motion *
        (weight.listening * 0.05 -
          weight.thinking * 0.02 +
          0.012 * Math.sin(t * 0.23 + 1.3) +
          0.006 * Math.sin(t * 0.47));
      // The rest pose itself is a gentle three-quarter turn and tilt; motion only adds to it.
      spring(pose.yaw, REST_POSE.yaw + yawT, dt);
      spring(pose.pitch, REST_POSE.pitch + pitchT, dt);
      spring(pose.roll, REST_POSE.roll + rollT, dt);
      const R = headRotation(pose.yaw.x, pose.pitch.x, pose.roll.x);
      Rm.set(R[0]!, R[1]!, R[2]!, R[3]!, R[4]!, R[5]!, R[6]!, R[7]!, R[8]!);
      U.uHead.value.copy(Rm);
      U.uHeadInv.value.copy(Rm).transpose();

      const kp = 1 - Math.exp(-dt * 1.6);
      par.x += (motion * f.gazeX - par.x) * kp;
      par.y += (motion * f.gazeY - par.y) * kp;
      U.uPar.value.set(par.x, par.y);

      U.uT.value = t;
      U.uMotion.value = motion;
      // A slow breath, about eleven a minute.
      U.uBreath.value = motion * Math.sin((t * 2 * Math.PI) / 5.4);
      U.uAudio.value = f.audio * weight.speaking;
      U.uGlow.value =
        glowPulse.glow *
        (1 + weight.listening * 0.04 * Math.sin(t * 2.2) * motion);
      U.uPulse.value = glowPulse.pulse;
      postMat.uniforms.uFloor!.value = f.floor > H ? -1e4 : (H - f.floor) * pr;

      if (document.hidden) return;
      composer.render(dt);
    },
    hide() {
      canvas.style.display = "none";
      lastT = -1;
    },
    dispose() {
      quad.dispose();
      bodyQuad.dispose();
      hairGeo.dispose();
      moteGeo.dispose();
      guideTex.dispose();
      for (const m of [bgMat, bodyMat, hairMat, moteMat, postMat]) m.dispose();
      bloom.dispose();
      post.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
