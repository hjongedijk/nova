import type * as ThreeModule from "three";
import type { UiState } from "#lib/stores/chat.svelte.ts";
import { CHIN, CORE, CROWN, PIVOT, poseMatrix } from "./gestalte-body.ts";
import { buildAssets, type GestalteAssets } from "./gestalte-build.ts";
import {
  BG_FRAG,
  BG_VERT,
  CORE_FRAG,
  CORE_VERT,
  FIG_VERT,
  FILL_FRAG,
  LAND_FRAG,
  LAND_VERT,
  MESH_VERT,
  POINT_FRAG,
  POST_FRAG,
  POST_VERT,
  SHELL_FRAG,
  SPARK_FRAG,
  SPARK_VERT,
} from "./gestalte-shaders.ts";

/**
 * GESTALTE on the GPU, v6. A head-and-shoulders bust fills the screen: crown near the top, chin a little past
 * half way, the shoulders falling off the bottom. The figure is a cloud of fine dots strung along contour bands
 * that wrap the form (dark gaps between them carry the volume), a saturated neon rim, a fire in the face with a
 * few amber veins down the neck, dust drifting off the crown, and a dotted mountain land on both sides with
 * lava veins and lights that slowly wake and fade.
 *
 * Moods bloom out of the face (points never move for a mood), the figure is born as a river of points out of
 * the orb and closes with one shockwave, the head turns a little toward the pointer, the chest breathes.
 *
 * Runs on a WebGL2 canvas underneath the entity's 2D canvas (which keeps the orb). Built lazily on first use,
 * geometry in a worker; entity.ts falls back to the Canvas2D presence when this returns null.
 */

type Three = typeof ThreeModule;

export interface GestalteFrame {
  t: number;
  dt: number;
  /** 0 = orb, 1 = figure. */
  form: number;
  state: UiState;
  /** Entity look right now (eased between states). */
  h: number;
  s: number;
  l: number;
  alert: boolean;
  /** Smoothed voice level 0..1. */
  audio: number;
  /** Smoothed pointer, -1..1. */
  gazeX: number;
  gazeY: number;
  /** Orb centre and radius in CSS pixels: where the figure grows from. */
  ocx: number;
  ocy: number;
  orbR: number;
  /** Top of the visible reply in CSS pixels (far below the screen when there is none). */
  floor: number;
  /** 0..1 overall brightness (birth). */
  dim: number;
  reduceMotion: boolean;
}

export interface GestalteStats {
  /** Resolution scale the adaptive loop settled on (1 = full DPR cap). */
  scale: number;
  pixels: number;
  /** Points drawn per frame (figure + land + dust). */
  points: number;
  /** Smoothed frame interval in ms. */
  frameMs: number;
  tier: Tier;
  /** Seconds into the birth (99 once it has settled). */
  birth: number;
}

export interface Gestalte {
  readonly canvas: HTMLCanvasElement;
  render(f: GestalteFrame): void;
  /** Hide without disposing (the orb is showing). */
  hide(): void;
  /** Previews and tests: pin the birth clock at `at` seconds, or null to let it run. */
  holdBirth(at: number | null): void;
  dispose(): void;
  readonly stats: GestalteStats;
}

/** The palette: neon cyan rim over deep blue bands, a warm amber fire, near-black night. */
export const PALETTE = {
  bg: "#0a1220",
  bg2: "#020409",
  void: "#010205",
  line: "#1e6fe0",
  line2: "#4fd8ff",
  rim: "#14c8ff",
  core: "#ff8a1a",
  hot: "#ffb347",
  grid: "#1aa8ff",
  streak: "#ff9a2e",
  /** Distance haze: the far ranges lean toward it. */
  haze: "#4f7fc0",
} as const;

export type Tier = "high" | "mid" | "low";

/** Share of the points each tier draws, and its device pixel ratio cap. */
const TIERS: Record<Tier, { keep: number; dpr: number }> = {
  high: { keep: 1, dpr: 2 },
  mid: { keep: 0.6, dpr: 1.5 },
  low: { keep: 0.36, dpr: 1 },
};

/** One mood: colours in linear-ish RGB, gains and which light patterns run. */
interface Mood {
  rim: [number, number, number];
  line: [number, number, number];
  /** gain, core (face fire), rim gain, voice gain */
  look: [number, number, number, number];
  /** thinking bands, listening head, executing sweep, idle scan */
  style: [number, number, number, number];
}

/** The aesthetic stays neon cyan + amber; each state shifts it a little and changes what the light does. */
export const MOODS: Record<UiState | "alert", Mood> = {
  ready: {
    rim: [0.06, 0.72, 1.0],
    line: [0.06, 0.3, 0.85],
    look: [1, 1, 1, 0],
    style: [0, 0, 0, 1],
  },
  listening: {
    rim: [0.1, 0.85, 1.0],
    line: [0.06, 0.4, 0.95],
    look: [1.18, 0.85, 1.15, 0],
    style: [0, 1, 0, 0],
  },
  thinking: {
    rim: [0.2, 0.34, 1.0],
    line: [0.12, 0.18, 0.9],
    look: [1.05, 1.3, 1.05, 0],
    style: [1, 0, 0, 0],
  },
  executing: {
    rim: [0.2, 0.55, 1.0],
    line: [0.1, 0.26, 0.9],
    look: [1.08, 1.15, 1.1, 0],
    style: [0.3, 0, 1, 0],
  },
  speaking: {
    rim: [0.08, 0.75, 1.0],
    line: [0.07, 0.34, 0.9],
    look: [1.05, 1.2, 1.05, 1],
    style: [0, 0, 0, 0.3],
  },
  alert: {
    rim: [1.0, 0.16, 0.22],
    line: [0.7, 0.08, 0.16],
    look: [1.1, 1.3, 1.1, 0.4],
    style: [0, 0, 1, 0],
  },
};

/** Birth timeline, in seconds of assembly. */
export const BIRTH = {
  /** The face ignites as the dome of the head closes. */
  ignite: [1.7, 2.1] as const,
  /** One shockwave out of the face across the figure and the land. */
  shock: 1.95,
  shockLen: 1.6,
  shockReach: 85,
} as const;

/** Mood bloom: radius from the face in body units, and how long it takes to cover the figure. */
const MOOD_REACH = 4.6;
const MOOD_LEN = 1.1;

/** Visible height of the scene at the figure's plane, in body units, for a viewport aspect. */
export function viewHeight(aspect: number): number {
  // Crown ~5% from the top, chin ~57%: the head spans 52% of the height, which leaves room for the collarbones,
  // the chest and the start of the arms. Narrow screens widen the view so the head (about 1.5 units with the
  // ears) keeps some air on both sides.
  const byHeight = (CROWN - CHIN) / 0.52;
  return Math.max(byHeight, 2.3 / Math.max(0.2, aspect));
}

/** Shockwave radius and strength `s` seconds after it starts; null once it has passed. */
export function shockAt(s: number): { r: number; a: number } | null {
  if (s < 0 || s >= BIRTH.shockLen) return null;
  const k = s / BIRTH.shockLen;
  // Slow out of the face (so it reads crossing the figure), then racing out over the land.
  return {
    r: BIRTH.shockReach * Math.pow(k, 2.2),
    a: 1 - smooth(0.55, 1, k),
  };
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

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

/** three.js and its post-processing passes, loaded only when the figure is first shown. */
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

let assetsPromise: Promise<GestalteAssets> | null = null;

/** Geometry for the figure and the land, built in a worker (main thread if workers are unavailable). */
function loadAssets(): Promise<GestalteAssets> {
  return (assetsPromise ??= new Promise<GestalteAssets>((resolve) => {
    const local = () => resolve(buildAssets());
    try {
      const w = new Worker(new URL("./gestalte.worker.ts", import.meta.url), {
        type: "module",
      });
      w.onmessage = (e: MessageEvent<GestalteAssets>) => {
        resolve(e.data);
        w.terminate();
      };
      w.onerror = () => {
        w.terminate();
        local();
      };
      w.postMessage(0);
    } catch {
      local();
    }
  }));
}

/** Pick a quality tier: a saved override, else the GPU and the device. */
function pickTier(gl: WebGL2RenderingContext | WebGLRenderingContext): {
  tier: Tier;
  forced: boolean;
} {
  try {
    const saved = localStorage.getItem("nova.gestalte.quality");
    if (saved === "high" || saved === "mid" || saved === "low")
      return { tier: saved, forced: true };
  } catch {
    /* storage blocked */
  }
  let name = "";
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    /* hidden by the browser */
  }
  if (/swiftshader|llvmpipe|software|basic render/i.test(name))
    return { tier: "low", forced: false };
  const coarse = matchMedia("(pointer: coarse)").matches;
  const small = Math.min(screen.width || 0, screen.height || 0) < 700;
  if (coarse || small || /mali|adreno [0-5]|powervr|intel.*hd/i.test(name))
    return { tier: "mid", forced: false };
  return { tier: "high", forced: false };
}

type Slot = {
  rim: number[];
  line: number[];
  look: number[];
  style: number[];
};
const slotOf = (m: Mood): Slot => ({
  rim: [...m.rim],
  line: [...m.line],
  look: [...m.look],
  style: [...m.style],
});
function copySlot(to: Slot, from: Slot) {
  for (const k of ["rim", "line", "look", "style"] as const)
    for (let i = 0; i < from[k].length; i++) to[k][i] = from[k][i]!;
}
function easeSlot(cur: Slot, target: Slot, k: number) {
  for (const key of ["rim", "line", "look", "style"] as const)
    for (let i = 0; i < cur[key].length; i++)
      cur[key][i]! += (target[key][i]! - cur[key][i]!) * k;
}

export async function createGestalte(
  under: HTMLCanvasElement,
): Promise<Gestalte | null> {
  if (typeof document === "undefined" || !webgl2Available()) return null;
  let mods: Awaited<ReturnType<typeof loadThree>>;
  let assets: GestalteAssets;
  try {
    [mods, assets] = await Promise.all([loadThree(), loadAssets()]);
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
  const { geo, fig, land } = assets;

  const canvas = document.createElement("canvas");
  canvas.className = "entity-gl";
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
  renderer.setClearColor(PALETTE.void, 1);
  const picked = pickTier(renderer.getContext());
  const tier = picked.tier;
  let keep = TIERS[tier].keep;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 200);

  const col = (hex: string) => new THREE.Color(hex);
  const v3 = (c: ThreeModule.Color) => new THREE.Vector3(c.r, c.g, c.b);
  const vec3 = () => new THREE.Vector3();
  const vec4 = () => new THREE.Vector4();
  const U = {
    uT: { value: 0 },
    uMotion: { value: 1 },
    uAudio: { value: 0 },
    uDim: { value: 1 },
    uPx: { value: 1 },
    uFloor: { value: -1 },
    uH: { value: 1 },
    uSize: { value: 0.0062 },
    uComp: { value: 1 },
    uScan: { value: 0 },
    uAsm: { value: 0 },
    uSrc: { value: vec3() },
    uSrcR: { value: 0.3 },
    uIgnite: { value: 0 },
    uShockR: { value: -10 },
    uShockA: { value: 0 },
    uMoodR: { value: MOOD_REACH },
    uMoodEdge: { value: 0 },
    uYaw: { value: 0 },
    uRimA: { value: vec3() },
    uRimB: { value: vec3() },
    uLineA: { value: vec3() },
    uLineB: { value: vec3() },
    uLookA: { value: vec4() },
    uLookB: { value: vec4() },
    uStyleA: { value: vec4() },
    uStyleB: { value: vec4() },
    uRimMix: { value: vec3() },
    uCore: { value: v3(col(PALETTE.core)) },
    uHot: { value: v3(col(PALETTE.hot)) },
    uHead: { value: new THREE.Matrix3() },
    uTorso: { value: new THREE.Matrix3() },
    uPivot: { value: new THREE.Vector3(...PIVOT) },
    uPivotT: { value: vec3() },
    uBreath: { value: 0 },
    uShell: { value: -0.014 },
    uShellA: { value: 0 },
    uReady: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uVoid: { value: v3(col(PALETTE.void)) },
    uBg: { value: v3(col(PALETTE.bg)) },
    uGrid: { value: v3(col(PALETTE.grid)) },
    uStreak: { value: v3(col(PALETTE.streak)) },
    uHaze: { value: v3(col(PALETTE.haze)) },
    uPar: { value: new THREE.Vector2() },
    uFade: { value: 0 },
    uLandOn: { value: 0 },
    uCoreC: { value: vec3() },
    uCoreS: { value: 1.3 },
    uCoreI: { value: 0 },
  };
  const shellU = { ...U, uShell: { value: 0.05 } };

  // Body mesh: the dark fill (depth for every point layer, blocks the land) and the neon shell outside it.
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute("position", new THREE.BufferAttribute(geo.position, 3));
  bodyGeo.setAttribute("normal", new THREE.BufferAttribute(geo.normal, 3));
  bodyGeo.setAttribute("aHead", new THREE.BufferAttribute(geo.head, 1));
  bodyGeo.setIndex(new THREE.BufferAttribute(geo.index, 1));

  const additive = {
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  } as const;
  const fillMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: MESH_VERT,
    fragmentShader: FILL_FRAG,
    side: THREE.DoubleSide,
  });
  const shellMat = new THREE.ShaderMaterial({
    uniforms: shellU,
    vertexShader: MESH_VERT,
    fragmentShader: SHELL_FRAG,
    side: THREE.FrontSide,
    ...additive,
  });
  const fillMesh = new THREE.Mesh(bodyGeo, fillMat);
  const shellMesh = new THREE.Mesh(bodyGeo, shellMat);

  // The figure's points.
  const figGeo = new THREE.BufferGeometry();
  figGeo.setAttribute("position", new THREE.BufferAttribute(fig.position, 3));
  figGeo.setAttribute("normal", new THREE.BufferAttribute(fig.normal, 3));
  figGeo.setAttribute("aData", new THREE.BufferAttribute(fig.data, 4));
  figGeo.setAttribute("aExtra", new THREE.BufferAttribute(fig.extra, 4));
  const figMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: FIG_VERT,
    fragmentShader: POINT_FRAG,
    depthFunc: THREE.LessEqualDepth,
    ...additive,
  });
  const figure = new THREE.Points(figGeo, figMat);

  // Dust off the crown and shoulders.
  const sparkGeo = new THREE.BufferGeometry();
  const ns = geo.sparkHead.length;
  const seeds = new Float32Array(ns * 4);
  for (let i = 0; i < seeds.length; i++)
    seeds[i] = Math.abs((Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1);
  sparkGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(geo.sparkBase, 3),
  );
  sparkGeo.setAttribute(
    "normal",
    new THREE.BufferAttribute(geo.sparkNormal, 3),
  );
  sparkGeo.setAttribute("aHead", new THREE.BufferAttribute(geo.sparkHead, 1));
  sparkGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: SPARK_VERT,
    fragmentShader: SPARK_FRAG,
    ...additive,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);

  // The land.
  const landGeo = new THREE.BufferGeometry();
  landGeo.setAttribute("position", new THREE.BufferAttribute(land.position, 3));
  landGeo.setAttribute("aLand", new THREE.BufferAttribute(land.data, 4));
  const landMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: LAND_VERT,
    fragmentShader: LAND_FRAG,
    ...additive,
  });
  const landPts = new THREE.Points(landGeo, landMat);

  // Face light and sky.
  const quad = new THREE.PlaneGeometry(1, 1);
  const coreMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: CORE_VERT,
    fragmentShader: CORE_FRAG,
    depthTest: false,
    ...additive,
  });
  const coreMesh = new THREE.Mesh(quad, coreMat);
  const bgMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: BG_VERT,
    fragmentShader: BG_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const bgMesh = new THREE.Mesh(quad, bgMat);

  const order: [ThreeModule.Object3D, number][] = [
    [bgMesh, -10],
    [fillMesh, 0],
    [landPts, 1],
    [figure, 2],
    [shellMesh, 3],
    [coreMesh, 4],
    [sparks, 5],
  ];
  for (const [o, r] of order) {
    o.renderOrder = r;
    o.frustumCulled = false;
    scene.add(o);
  }

  function applyKeep() {
    const figN = fig.fixed + Math.round((fig.count - fig.fixed) * keep);
    figGeo.setDrawRange(0, figN);
    landGeo.setDrawRange(0, Math.round(land.count * keep));
    // Fewer, slightly larger dots keep the same light per area.
    U.uComp.value = Math.min(1.6, Math.sqrt(1 / keep));
  }
  applyKeep();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(256, 256),
    0.72,
    0.2,
    0.32,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  // Grade, grain, lens fringe and vignette: one cheap full-screen pass after tone mapping.
  // A material (not a shader description), so the pass keeps these shared uniform objects instead of cloning.
  const postMat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uRes: U.uRes,
      uT: U.uT,
      uMotion: U.uMotion,
      uPx: U.uPx,
    },
    vertexShader: POST_VERT,
    fragmentShader: POST_FRAG,
  });
  const post = new ShaderPass(postMat);
  composer.addPass(post);

  /* sizing: the drawing buffer never exceeds 4K or the tier's DPR cap, and steps down if frames run long */
  let W = 0;
  let H = 0;
  let scale = 1;
  let pr = 1;
  let ppu = 1;
  let camY = 0;
  function size(force = false) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(
      window.devicePixelRatio || 1,
      3840 / Math.max(1, w),
      2160 / Math.max(1, h),
      TIERS[tier].dpr,
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
    const vh = viewHeight(aspect);
    const dist = vh / 2 / Math.tan(((camera.fov / 2) * Math.PI) / 180);
    camY = CROWN + 0.05 * vh - vh / 2;
    camera.aspect = aspect;
    camera.position.set(0, camY, dist);
    camera.lookAt(0, camY, 0);
    camera.updateProjectionMatrix();
    ppu = H / vh;
    U.uRes.value.set(W * pr, H * pr);
    U.uH.value = H * pr;
    U.uPx.value = pr;
  }
  size(true);

  /* pose: critically damped springs (no overshoot) so a gaze change starts softly and settles without a bounce */
  const pose = {
    yaw: { x: 0, v: 0 },
    pitch: { x: 0, v: 0 },
    roll: { x: 0, v: 0 },
  };
  const par = { x: 0, y: 0 };
  function spring(s: { x: number; v: number }, target: number, dt: number) {
    const w = (2 * Math.PI) / 1.5;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = Math.min(dt, 0.1) / steps;
    for (let i = 0; i < steps; i++) {
      s.v += (w * w * (target - s.x) - 2 * w * s.v) * h;
      s.x += s.v * h;
    }
  }
  const weight = { listening: 0, thinking: 0, executing: 0, speaking: 0 };
  let lastGx = 0;
  let lastGy = 0;
  let still = 0;
  let scan = 0;
  const Mh = new Float32Array(9);
  const Mt = new Float32Array(9);

  /* mood bloom: A outside, B inside a radius growing out of the face */
  let moodKey: UiState | "alert" | null = null;
  const A = slotOf(MOODS.ready);
  const B = slotOf(MOODS.ready);
  const Bt = slotOf(MOODS.ready);
  let moodClock = MOOD_LEN;

  /* birth */
  let asm = 0;
  let lastForm = 0;
  let shocked = false;
  let held: number | null = null;
  let landOn = false;

  /* frame time */
  let slow = 0;
  let lastT = -1;
  let frameMs = 16.7;

  function setMat(m: ThreeModule.Matrix3, a: Float32Array) {
    m.set(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!, a[6]!, a[7]!, a[8]!);
  }
  function apply(m: Float32Array, x: number, y: number, z: number) {
    return [
      m[0]! * x + m[1]! * y + m[2]! * z,
      m[3]! * x + m[4]! * y + m[5]! * z,
      m[6]! * x + m[7]! * y + m[8]! * z,
    ] as const;
  }
  const setV3 = (v: ThreeModule.Vector3, a: number[]) =>
    v.set(a[0]!, a[1]!, a[2]!);
  const setV4 = (v: ThreeModule.Vector4, a: number[]) =>
    v.set(a[0]!, a[1]!, a[2]!, a[3]!);

  return {
    canvas,
    get stats() {
      return {
        scale,
        pixels: Math.round(W * pr) * Math.round(H * pr),
        points:
          (figGeo.drawRange.count === Infinity
            ? fig.count
            : figGeo.drawRange.count) +
          (landGeo.drawRange.count === Infinity
            ? land.count
            : landGeo.drawRange.count) +
          ns,
        frameMs,
        tier,
        birth: asm,
      };
    },
    render(f) {
      const { t, dt } = f;
      if (document.hidden) {
        lastT = -1;
        return;
      }
      // Adaptive quality: a wallpaper runs all day, so long frames first thin the points, then lower the
      // buffer, never the frame rate. A saved quality override pins the point count.
      if (lastT >= 0) {
        const gap = (t - lastT) * 1000;
        // Gaps over 200 ms are throttling or a hitch elsewhere, not this scene being too heavy.
        if (gap < 200) {
          frameMs = frameMs * 0.95 + gap * 0.05;
          slow = slow * 0.97 + (gap > 24 ? 1 : 0) * 0.03;
        }
        if (slow > 0.6) {
          if (!picked.forced && keep > 0.3) {
            keep = Math.max(0.3, keep * 0.8);
            applyKeep();
          } else if (!picked.forced && scale > 0.55)
            scale = Math.max(0.55, scale * 0.85);
          slow = 0;
        }
      }
      lastT = t;
      size();
      canvas.style.display = "block";
      canvas.style.opacity = String(Math.min(1, f.form / 0.3));

      const motion = f.reduceMotion ? 0 : 1;
      const kw = 1 - Math.exp(-dt * 3);
      for (const key of Object.keys(weight) as (keyof typeof weight)[])
        weight[key] += ((key === f.state ? 1 : 0) - weight[key]) * kw;

      /* birth: a river out of the orb, the face ignites, one shockwave; skipped under reduced motion */
      if (held !== null) asm = held;
      else if (f.reduceMotion) asm = 99;
      else if (f.form >= lastForm && f.form > 0) asm = Math.min(99, asm + dt);
      else asm = Math.max(0, Math.min(asm, BIRTH.shock) - dt * 1.6);
      lastForm = f.form;
      U.uAsm.value = asm;
      U.uIgnite.value = smooth(BIRTH.ignite[0], BIRTH.ignite[1], asm);
      U.uReady.value = smooth(2.0, 2.7, asm);
      U.uShellA.value = smooth(1.8, 2.4, asm);
      fillMesh.visible = asm >= BIRTH.shock;
      const sh = f.reduceMotion ? null : shockAt(asm - BIRTH.shock);
      if (sh) shocked = true;
      U.uShockR.value = sh ? sh.r : -10;
      U.uShockA.value = sh ? sh.a : 0;
      // The land stays lit once the shockwave has crossed it, also while the figure dissolves back into
      // the orb (the canvas fades with the form); it resets only once the figure is gone.
      if (f.reduceMotion || (asm >= BIRTH.shock + BIRTH.shockLen && shocked))
        landOn = true;
      if (f.form <= 0.02) landOn = false;
      U.uLandOn.value = landOn ? 1 : 0;
      if (asm < BIRTH.shock) shocked = false;
      U.uSrc.value.set((f.ocx - W / 2) / ppu, camY - (f.ocy - H / 2) / ppu, 0);
      U.uSrcR.value = Math.max(0.05, f.orbR / ppu);

      /* mood: on a change, B starts over from the face (A takes the settled look); mid-bloom, B retargets */
      const key: UiState | "alert" = f.alert ? "alert" : f.state;
      if (moodKey === null) {
        moodKey = key;
        copySlot(A, slotOf(MOODS[key]));
        copySlot(B, A);
        copySlot(Bt, A);
      } else if (key !== moodKey) {
        moodKey = key;
        if (moodClock >= MOOD_LEN) {
          copySlot(A, B);
          moodClock = f.reduceMotion ? MOOD_LEN : 0;
        }
        copySlot(Bt, slotOf(MOODS[key]));
      }
      moodClock = Math.min(MOOD_LEN, moodClock + dt);
      easeSlot(B, Bt, 1 - Math.exp(-dt * 6));
      const mk = moodClock / MOOD_LEN;
      const moodR = MOOD_REACH * (1 - Math.pow(1 - mk, 3));
      U.uMoodR.value = moodR;
      U.uMoodEdge.value = mk >= 1 ? 0 : 1 - smooth(0.55, 1, mk);
      setV3(U.uRimA.value, A.rim);
      setV3(U.uRimB.value, B.rim);
      setV3(U.uLineA.value, A.line);
      setV3(U.uLineB.value, B.line);
      setV4(U.uLookA.value, A.look);
      setV4(U.uLookB.value, B.look);
      setV4(U.uStyleA.value, A.style);
      setV4(U.uStyleB.value, B.style);
      const cover = Math.min(1, moodR / 2.5);
      U.uRimMix.value.set(
        A.rim[0]! + (B.rim[0]! - A.rim[0]!) * cover,
        A.rim[1]! + (B.rim[1]! - A.rim[1]!) * cover,
        A.rim[2]! + (B.rim[2]! - A.rim[2]!) * cover,
      );

      /* head turn: toward the pointer, limited, gliding; back to neutral when the pointer rests */
      if (
        Math.abs(f.gazeX - lastGx) > 0.002 ||
        Math.abs(f.gazeY - lastGy) > 0.002
      )
        still = 0;
      else still += dt;
      lastGx = f.gazeX;
      lastGy = f.gazeY;
      const attend = motion * (1 - smooth(4, 7, still));
      const gX = Math.max(-1, Math.min(1, f.gazeX)) * attend;
      const gY = Math.max(-1, Math.min(1, f.gazeY)) * attend;
      const yawT =
        motion *
        (gX * 0.27 +
          0.03 * Math.sin(t * 0.17) +
          weight.thinking * 0.08 -
          weight.executing * 0.03);
      const pitchT =
        motion *
        (gY * 0.08 -
          weight.thinking * 0.05 +
          weight.listening * 0.04 +
          weight.speaking * 0.02 * f.audio * Math.sin(t * 2.3));
      const rollT =
        motion *
        (weight.listening * 0.035 -
          weight.thinking * 0.02 +
          0.01 * Math.sin(t * 0.23 + 1.3));
      spring(pose.yaw, yawT, dt);
      spring(pose.pitch, pitchT, dt);
      spring(pose.roll, rollT, dt);
      const yaw = pose.yaw.x;
      U.uYaw.value = yaw;
      const kpar = 1 - Math.exp(-dt * 1.6);
      par.x += (gX - par.x) * kpar;
      par.y += (gY - par.y) * kpar;
      U.uPar.value.set(par.x, par.y);
      // The camera sits a little above the figure: the face is met nearly level, the torso seen from above.
      poseMatrix(Mh, yaw, pose.pitch.x, pose.roll.x, 0.1);
      poseMatrix(Mt, yaw * 0.15, pose.pitch.x * 0.1, 0, 0.32);
      setMat(U.uHead.value, Mh);
      setMat(U.uTorso.value, Mt);
      const pv = apply(Mt, PIVOT[0], PIVOT[1], PIVOT[2]);
      U.uPivotT.value.set(pv[0], pv[1], pv[2]);
      const cr = apply(
        Mh,
        CORE[0] - PIVOT[0],
        CORE[1] - PIVOT[1],
        CORE[2] - PIVOT[2],
      );
      U.uCoreC.value.set(cr[0] + pv[0], cr[1] + pv[1], cr[2] + pv[2] + 0.25);

      scan += dt * (0.11 + 0.45 * weight.executing) * (motion || 0.25);
      U.uScan.value = CROWN + 0.2 - (scan % 1.4) * 3.4;
      U.uT.value = t;
      U.uMotion.value = motion;
      U.uAudio.value = f.audio;
      U.uBreath.value = motion * Math.sin(t * 0.9);
      U.uFade.value = Math.max(0, Math.min(1, (f.form - 0.2) / 0.8));
      U.uDim.value = f.dim;
      U.uFloor.value = f.floor > H ? -1e4 : (H - f.floor) * pr;
      const coreGain = A.look[1]! + (B.look[1]! - A.look[1]!) * cover;
      U.uCoreI.value =
        U.uIgnite.value *
        coreGain *
        (0.9 + 0.08 * Math.sin(t * 0.7) * motion + weight.speaking * f.audio * 0.5);

      composer.render(dt);
    },
    holdBirth(at) {
      held = at;
    },
    hide() {
      canvas.style.display = "none";
      lastT = -1;
    },
    dispose() {
      bodyGeo.dispose();
      figGeo.dispose();
      sparkGeo.dispose();
      landGeo.dispose();
      quad.dispose();
      for (const m of [
        fillMat,
        shellMat,
        figMat,
        sparkMat,
        landMat,
        coreMat,
        bgMat,
      ])
        m.dispose();
      bloom.dispose();
      postMat.dispose();
      post.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
