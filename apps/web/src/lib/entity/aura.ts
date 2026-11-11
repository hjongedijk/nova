import type * as ThreeModule from "three";
import type { UiState } from "#lib/stores/chat.svelte.ts";
import {
  AURA_ASSETS,
  auraCamera,
  BIRTH,
  headMatrix,
  idlePose,
  windForce,
  type FigureJson,
} from "./aura-data.ts";
import {
  buildRibbons,
  decodeSdf,
  growHair,
  HAIR,
  sampleSurface,
  stepHair,
  strandAttributes,
  type Hair,
} from "./aura-figure.ts";
import {
  BODY_FRAG,
  BODY_VERT,
  HAIR_FRAG,
  HAIR_VERT,
  LINE_FRAG,
  LINE_VERT,
  POINTS_FRAG,
  POINTS_VERT,
  ROOM_FRAG,
  ROOM_VERT,
  STAR_FRAG,
  STAR_VERT,
} from "./aura-shaders.ts";

export { BREATH, HAIRLOOK, LINES, SKIN } from "./aura-shaders.ts";

/**
 * AURA: a real-time 3D being of light. A sculpted feminine bust of dark glossy glass (built from the CC0
 * MakeHuman base mesh, with a blank, smooth ovoid head), light lines laid on her surface, hair of thousands of light
 * strands moved by simulated guides, in a room of violet smoke. Her head truly turns toward the pointer and has
 * its own small life; moods bloom out from her face; she is born from particles that settle onto her surface.
 *
 * Same contract as the Gestalte (entity.ts drives both): a canvas under the entity's 2D canvas, built lazily.
 * Without WebGL2 it is a still of the figure with a soft CSS glow. Nothing here waits on chat or audio: a frame only
 * reads the values it is handed.
 */

type Three = typeof ThreeModule;

export interface AuraFrame {
  t: number;
  dt: number;
  /** 0 = orb, 1 = figure: the birth runs while this rises and runs back when it falls. */
  form: number;
  state: UiState;
  alert: boolean;
  /** Smoothed voice level 0..1. */
  audio: number;
  /** Smoothed pointer, -1..1 (y down). */
  gazeX: number;
  gazeY: number;
  /** Top of the visible reply in CSS pixels (far below the screen when there is none). */
  floor: number;
  /** 0..1 overall brightness (the orb's birth). */
  dim: number;
  reduceMotion: boolean;
}

export interface Aura {
  readonly canvas: HTMLElement;
  render(f: AuraFrame): void;
  /** Hide without disposing (the orb is showing). */
  hide(): void;
  dispose(): void;
  readonly stats: AuraStats;
}

export interface AuraStats {
  mode: "webgl" | "static";
  /** What draws her now: the 3D mesh, the birth particles, or the still. */
  figure: "mesh" | "particles" | "static";
  tier: GpuTier;
  devicePixelRatio: number;
  /** Device px per CSS px the canvas renders at. */
  dpr: number;
  /** The canvas's backing store and its CSS size. */
  backing: string;
  css: string;
  renderer: string;
  mobile: boolean;
  triangles: number;
  lines: number;
  hairStrands: number;
  hairGuides: number;
  scale: number;
  /** Smoothed interval between rendered frames, ms. */
  frameMs: number;
}

export type GpuTier = "low" | "mid" | "high";

export interface Look {
  /** Main stripe colour (most stripes). */
  a: string;
  /** Second stripe colour. */
  b: string;
  /** Rim light and the bloom's edge. */
  r: string;
  /** Hair tint. */
  h: string;
  /** How far the hair takes the tint, 0 = the artwork's own colour. */
  tint: number;
  /** How much of the accent colours (pink, cyan, peach) the stripes keep. */
  accent: number;
  /** Stripe and rim intensity. */
  glow: number;
  /** Speed of the light travelling along the stripes. */
  pulse: number;
}

export const LOOKS: Record<UiState | "alert", Look> = {
  // Idle: the artwork's own violet and magenta, accents of pink, cyan and peach.
  ready: {
    a: "#9a5cff",
    b: "#e050f0",
    r: "#c8a0ff",
    h: "#b070ff",
    tint: 0,
    accent: 1,
    glow: 1,
    pulse: 0.35,
  },
  // Listening: cooler, toward periwinkle and ice blue.
  listening: {
    a: "#6f7bff",
    b: "#52c2ff",
    r: "#a8c8ff",
    h: "#7f8cff",
    tint: 0.38,
    accent: 0.8,
    glow: 1.12,
    pulse: 0.6,
  },
  // Thinking: orchid and hot pink, the light running faster.
  thinking: {
    a: "#d25cff",
    b: "#ff4fb8",
    r: "#ffa8f0",
    h: "#e05ad8",
    tint: 0.36,
    accent: 0.85,
    glow: 1.1,
    pulse: 1.5,
  },
  // At work: violet with warm amber-peach.
  executing: {
    a: "#b45cff",
    b: "#ffa86a",
    r: "#ffc8a0",
    h: "#f08ad0",
    tint: 0.3,
    accent: 1,
    glow: 1.12,
    pulse: 1.9,
  },
  // Speaking: warm pink; the brightness follows the voice.
  speaking: {
    a: "#ff5ccf",
    b: "#c45cff",
    r: "#ffb0e8",
    h: "#f070e0",
    tint: 0.3,
    accent: 1,
    glow: 1,
    pulse: 0.9,
  },
  alert: {
    a: "#ff3d6e",
    b: "#ff7a5c",
    r: "#ff8a9a",
    h: "#ff4a78",
    tint: 0.6,
    accent: 0.25,
    glow: 1.2,
    pulse: 1.3,
  },
};

/** Strand, particle and resolution budgets per GPU class. */
export const BUDGET: Record<
  GpuTier,
  { particles: number; dpr: number; strands: number; guides: number }
> = {
  low: {
    particles: 40_000,
    dpr: 1,
    strands: HAIR.strands.low,
    guides: HAIR.guides.low,
  },
  // Phones: full sharpness (device pixels up to 2x), lighter hair.
  mid: {
    particles: 90_000,
    dpr: 2,
    strands: HAIR.strands.mid,
    guides: HAIR.guides.mid,
  },
  high: {
    particles: 160_000,
    dpr: 2,
    strands: HAIR.strands.high,
    guides: HAIR.guides.high,
  },
};

/** The least device pixels per CSS pixel the adaptive loop may fall to (it never goes below this). */
export const MIN_DPR = { desktop: 1, phone: 1.5 } as const;

/** The GPU class: only software rendering is "low"; a masked or unknown renderer is a real GPU. */
export function gpuTier(renderer: string, mobile: boolean): GpuTier {
  const r = renderer.toLowerCase();
  if (/swiftshader|llvmpipe|software|softpipe|microsoft basic render/.test(r))
    return "low";
  return mobile ? "mid" : "high";
}

/** A phone or tablet browser (by its user agent, or a coarse pointer on a small screen). */
export function isMobile(ua: string, coarse: boolean, width: number): boolean {
  return /android|iphone|ipad|ipod|mobile/i.test(ua) || (coarse && width < 900);
}

/** Head turn limits toward the pointer, radians (a real rotation of the head about the neck). */
export const GAZE = { yaw: 0.42, pitch: 0.16 } as const;

/** Birth length, and how long a mood takes to bloom out from the face, seconds. */
export const TIMING = { birth: BIRTH.total, bloom: 1.0 } as const;

/** Ease of the bloom's radius. */
export function bloomFront(p: number): number {
  const x = Math.max(0, Math.min(1, p));
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/** The bloom has passed over the whole figure (metres from the face) when its radius reaches this. */
export const BLOOM_REACH = 0.75;

/** The room's ribbons. */
export const ROOM = "#7f52d8";

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

/** A soft spring that overshoots a little and settles in about `settle` seconds: for the hair's lag. */
export function swing(
  s: { x: number; v: number },
  target: number,
  dt: number,
  settle = 0.85,
): void {
  const zeta = 0.42;
  const w = 4.6 / (zeta * settle);
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = Math.min(dt, 0.1) / steps;
  for (let i = 0; i < steps; i++) {
    s.v += (w * w * (target - s.x) - 2 * zeta * w * s.v) * h;
    s.x += s.v * h;
  }
}

/** The middle value (0 for none). */
export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Critically damped spring: glides toward the target, keeps its velocity through a retarget, never overshoots. */
export function spring(
  s: { x: number; v: number },
  target: number,
  dt: number,
  period = 1.4,
): void {
  const w = (2 * Math.PI) / period;
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = Math.min(dt, 0.1) / steps;
  for (let i = 0; i < steps; i++) {
    s.v += (w * w * (target - s.x) - 2 * w * s.v) * h;
    s.x += s.v * h;
  }
}

async function loadThree() {
  const [three, gltf, meshopt] = await Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  ]);
  return {
    THREE: three as Three,
    GLTFLoader: gltf.GLTFLoader,
    MeshoptDecoder: meshopt.MeshoptDecoder,
  };
}

export async function createAura(
  under: HTMLCanvasElement,
  options: { tier?: GpuTier; forceStatic?: boolean } = {},
): Promise<Aura | null> {
  if (typeof document === "undefined") return null;
  if (options.forceStatic || !webgl2Available()) return createStaticAura(under);
  let mods: Awaited<ReturnType<typeof loadThree>>;
  try {
    mods = await loadThree();
  } catch {
    return createStaticAura(under);
  }
  try {
    return await createGlAura(mods, under, options.tier);
  } catch (err) {
    if (import.meta.env?.DEV)
      console.warn("aura: falling back to the still", err);
    return createStaticAura(under);
  }
}

async function createGlAura(
  mods: Awaited<ReturnType<typeof loadThree>>,
  under: HTMLCanvasElement,
  forcedTier: GpuTier | undefined,
): Promise<Aura> {
  const { THREE, GLTFLoader, MeshoptDecoder } = mods;
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
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x020108, 1);

  let rendererName = "";
  try {
    const gl = renderer.getContext();
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    rendererName = String(
      gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "",
    );
  } catch {
    /* unknown GPU: a real one */
  }
  const mobile = isMobile(
    navigator.userAgent,
    matchMedia?.("(pointer: coarse)").matches ?? false,
    window.innerWidth,
  );
  const tier = forcedTier ?? gpuTier(rendererName, mobile);
  const budget = BUDGET[tier];
  const minDpr = mobile ? MIN_DPR.phone : MIN_DPR.desktop;

  /* the figure */
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const [gltf, fig] = await Promise.all([
    loader.loadAsync(AURA_ASSETS.mesh),
    fetch(AURA_ASSETS.figure).then((r) => {
      if (!r.ok) throw new Error(`${AURA_ASSETS.figure}: ${r.status}`);
      return r.json() as Promise<FigureJson>;
    }),
  ]);
  let bodyGeo: ThreeModule.BufferGeometry | null = null;
  gltf.scene.traverse((o) => {
    const m = o as ThreeModule.Mesh;
    if (m.isMesh && !bodyGeo) bodyGeo = m.geometry;
  });
  if (!bodyGeo) throw new Error("aura: no mesh");
  const geo: ThreeModule.BufferGeometry = bodyGeo;
  under.before(canvas);

  const lin = (hex: string) => {
    const c = new THREE.Color(hex);
    return new THREE.Vector3(c.r, c.g, c.b);
  };
  type Key = UiState | "alert";
  const looks = Object.fromEntries(
    Object.entries(LOOKS).map(([k, l]) => [
      k,
      { ...l, A: lin(l.a), B: lin(l.b), R: lin(l.r), H: lin(l.h) },
    ]),
  ) as Record<
    Key,
    Look & {
      A: ThreeModule.Vector3;
      B: ThreeModule.Vector3;
      R: ThreeModule.Vector3;
      H: ThreeModule.Vector3;
    }
  >;
  const ready = looks.ready;
  const pivot = new THREE.Vector3(...fig.neck);
  const faceRest = new THREE.Vector3(...fig.face);
  const chest = new THREE.Vector3(
    0,
    (fig.breasts[0]![1] + fig.neck[1]) / 2 - 0.02,
    (fig.breasts[0]![2] + fig.neck[2]) / 2,
  );

  const U = {
    uHead: { value: new THREE.Matrix3() },
    uPivot: { value: pivot },
    uA0: { value: ready.A.clone() },
    uA1: { value: ready.A.clone() },
    uB0: { value: ready.B.clone() },
    uB1: { value: ready.B.clone() },
    uR0: { value: ready.R.clone() },
    uR1: { value: ready.R.clone() },
    uH0: { value: ready.H.clone() },
    uH1: { value: ready.H.clone() },
    uGlow: { value: new THREE.Vector2(ready.glow, ready.glow) },
    uTint: { value: new THREE.Vector2(ready.tint, ready.tint) },
    uAccent: { value: new THREE.Vector2(ready.accent, ready.accent) },
    uBloomR: { value: 100 },
    uBloomEdge: { value: 0 },
    uFace: { value: faceRest.clone() },
    uAudio: { value: 0 },
    uPulse: { value: ready.pulse },
    uT: { value: 0 },
    uMotion: { value: 1 },
    uTau: { value: 0 },
    uFloor: { value: -1 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uBreath: { value: 0 },
    uChest: { value: chest },
    uWaist: { value: fig.waist },
    uChin: { value: fig.head.c[1] - fig.head.r[1] },
    uBreastL: { value: new THREE.Vector3(...fig.breasts[0]!) },
    uBreastR: { value: new THREE.Vector3(...fig.breasts[1]!) },
    uElbowL: { value: new THREE.Vector3(...fig.elbows[0]!) },
    uElbowR: { value: new THREE.Vector3(...fig.elbows[1]!) },
    uPx: { value: 1 },
    uFaceScreen: { value: new THREE.Vector2(0.5, 0.6) },
    uRibbon: { value: lin(ROOM) },
    uSource: {
      value: new THREE.Vector3(
        0,
        fig.breasts[0]![1] + 0.03,
        fig.breasts[0]![2] + 0.12,
      ),
    },
    uSize: { value: 1.6 },
    uGuides: { value: null as ThreeModule.DataTexture | null },
    uPoints: { value: HAIR.points },
    uGuideCount: { value: 1 },
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20);

  /* the room */
  const quad = new THREE.BufferGeometry();
  quad.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]),
      3,
    ),
  );
  const roomMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: ROOM_VERT,
    fragmentShader: ROOM_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const room = new THREE.Mesh(quad, roomMat);
  room.frustumCulled = false;
  room.renderOrder = -10;
  scene.add(room);

  /* the body */
  const bodyMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: BODY_VERT,
    fragmentShader: BODY_FRAG,
    // Front faces only: where she fades out at the cuts, nothing of her inside shows through.
    side: THREE.FrontSide,
    // Opaque except where she fades out (waist, elbows): straight alpha over the room.
    transparent: true,
    depthWrite: true,
  });
  const body = new THREE.Mesh(geo, bodyMat);
  body.frustumCulled = false;
  body.renderOrder = 0;
  scene.add(body);
  const triangles = (geo.index?.count ?? 0) / 3;

  /* the light lines */
  const rib = buildRibbons(fig.lines);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(rib.position, 3));
  lineGeo.setAttribute("aNext", new THREE.BufferAttribute(rib.next, 3));
  lineGeo.setAttribute("aPrev", new THREE.BufferAttribute(rib.prev, 3));
  lineGeo.setAttribute("normal", new THREE.BufferAttribute(rib.normal, 3));
  lineGeo.setAttribute("aInfo", new THREE.BufferAttribute(rib.info, 4));
  lineGeo.setAttribute("aCode", new THREE.BufferAttribute(rib.code, 2));
  lineGeo.setIndex(new THREE.BufferAttribute(rib.index, 1));
  const additive = {
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  } as const;
  const lineMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: LINE_VERT,
    fragmentShader: LINE_FRAG,
    ...additive,
    // Camera-facing ribbons would dip into the curved skin: they are hidden by turning away instead (vFacing).
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const lineMesh = new THREE.Mesh(lineGeo, lineMat);
  lineMesh.frustumCulled = false;
  lineMesh.renderOrder = 2;
  scene.add(lineMesh);

  /* star points where lines meet */
  {
    const [bl] = fig.breasts as [number, number, number][];
    const [sl, sr] = fig.shoulders as [number, number, number][];
    const n = fig.neck;
    const pts = [
      [0, n[1] - 0.065, n[2] + 0.06],
      [sl![0] * 1.02, sl![1] + 0.015, sl![2] + 0.02],
      [sr![0] * 1.02, sr![1] + 0.015, sr![2] + 0.02],
      [0, bl![1] - 0.06, bl![2] - 0.035],
      [bl![0] * 1.4, bl![1] + 0.01, bl![2] - 0.03],
    ];
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(Float32Array.from(pts.flat()), 3),
    );
    starGeo.setAttribute(
      "aSeed",
      new THREE.BufferAttribute(
        Float32Array.from(pts.map((_, i) => i / pts.length)),
        1,
      ),
    );
    starGeo.setAttribute(
      "aHead",
      new THREE.BufferAttribute(new Float32Array(pts.length), 1),
    );
    const stars = new THREE.Points(
      starGeo,
      new THREE.ShaderMaterial({
        uniforms: U,
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
        ...additive,
        depthTest: false,
      }),
    );
    stars.frustumCulled = false;
    stars.renderOrder = 4;
    scene.add(stars);
  }

  /* the hair */
  const hair: Hair = growHair(fig, budget.guides, 11, decodeSdf(fig.sdf));
  const P = HAIR.points;
  const guideData = new Float32Array(P * hair.guides * 4);
  const guideTex = new THREE.DataTexture(
    guideData,
    P,
    hair.guides,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  guideTex.minFilter = guideTex.magFilter = THREE.NearestFilter;
  guideTex.generateMipmaps = false;
  U.uGuides.value = guideTex;
  U.uGuideCount.value = hair.guides;
  const uploadGuides = () => {
    for (let g = 0; g < hair.guides; g++)
      for (let i = 0; i < P; i++) {
        const s = (g * P + i) * 3;
        const d = (g * P + i) * 4;
        guideData[d] = hair.pos[s]!;
        guideData[d + 1] = hair.pos[s + 1]!;
        guideData[d + 2] = hair.pos[s + 2]!;
      }
    guideTex.needsUpdate = true;
  };
  uploadGuides();
  const SEG = 24;
  const strandAttr = strandAttributes(hair, HAIR.strands.high);
  const hairGeo = new THREE.BufferGeometry();
  {
    const maxStrands = HAIR.strands.high;
    const vPer = (SEG + 1) * 2;
    const aGuides = new Float32Array(maxStrands * vPer * 3);
    const aW = new Float32Array(maxStrands * vPer * 4);
    const aK = new Float32Array(maxStrands * vPer * 2);
    const index = new Uint32Array(maxStrands * SEG * 6);
    let ii = 0;
    for (let s = 0; s < maxStrands; s++)
      for (let k = 0; k <= SEG; k++)
        for (const side of [-1, 1]) {
          const v = s * vPer + k * 2 + (side > 0 ? 1 : 0);
          aGuides.set(strandAttr.guides.subarray(s * 3, s * 3 + 3), v * 3);
          aW.set(strandAttr.weights.subarray(s * 4, s * 4 + 4), v * 4);
          aK.set([k / SEG, side], v * 2);
          if (k < SEG && side > 0) {
            const a = s * vPer + k * 2;
            index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], ii);
            ii += 6;
          }
        }
    hairGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(maxStrands * vPer * 3), 3),
    );
    hairGeo.setAttribute("aGuides", new THREE.BufferAttribute(aGuides, 3));
    hairGeo.setAttribute("aW", new THREE.BufferAttribute(aW, 4));
    hairGeo.setAttribute("aK", new THREE.BufferAttribute(aK, 2));
    hairGeo.setIndex(new THREE.BufferAttribute(index, 1));
  }
  let strands = budget.strands;
  const setStrands = (n: number) => {
    strands = Math.max(500, Math.min(HAIR.strands.high, Math.round(n)));
    hairGeo.setDrawRange(0, strands * SEG * 6);
  };
  setStrands(strands);
  const hairMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: HAIR_VERT,
    fragmentShader: HAIR_FRAG,
    ...additive,
    side: THREE.DoubleSide,
    // Strands lie a few millimetres off the scalp: pull them a hair toward the camera so the dome never hides them.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
  });
  const hairMesh = new THREE.Mesh(hairGeo, hairMat);
  hairMesh.frustumCulled = false;
  hairMesh.renderOrder = 3;
  scene.add(hairMesh);

  /* the birth particles, on the surface */
  const posAttr = geo.getAttribute("position");
  const nrmAttr = geo.getAttribute("normal");
  const headAttr = geo.getAttribute("_head");
  const headArr = new Float32Array(posAttr.count);
  for (let i = 0; i < posAttr.count; i++)
    headArr[i] = headAttr ? headAttr.getX(i) : 0;
  const posArr = new Float32Array(posAttr.count * 3);
  const nrmArr = new Float32Array(posAttr.count * 3);
  for (let i = 0; i < posAttr.count; i++) {
    posArr.set([posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)], i * 3);
    nrmArr.set([nrmAttr.getX(i), nrmAttr.getY(i), nrmAttr.getZ(i)], i * 3);
  }
  const samples = sampleSurface(
    posArr,
    nrmArr,
    headArr,
    geo.index!.array,
    budget.particles,
  );
  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(samples.position, 3),
  );
  pointsGeo.setAttribute("aSeed", new THREE.BufferAttribute(samples.seed, 4));
  const points = new THREE.Points(
    pointsGeo,
    new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      ...additive,
    }),
  );
  points.frustumCulled = false;
  points.renderOrder = 5;
  scene.add(points);

  /* sizing: native device pixels (capped at 2), never below MIN_DPR; the backing store follows the canvas */
  let W = 0;
  let H = 0;
  let scale = 1;
  let pr = 1;
  const faceNdc = new THREE.Vector3();
  function size(force = false) {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, budget.dpr);
    const floor = tier === "low" ? 0.75 : Math.min(dpr, minDpr);
    const next = Math.max(floor, dpr * scale);
    if (!force && w === W && h === H && Math.abs(next - pr) < 0.01) return;
    W = w;
    H = h;
    pr = next;
    renderer.setPixelRatio(pr);
    renderer.setSize(W, H, false);
    const cam = auraCamera(W, H);
    camera.fov = cam.fov;
    camera.aspect = W / Math.max(1, H);
    camera.position.set(0, cam.targetY + 0.02, cam.distance);
    camera.lookAt(0, cam.targetY, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    U.uRes.value.set(canvas.width, canvas.height);
    U.uPx.value = pr;
    faceNdc.copy(faceRest).project(camera);
    U.uFaceScreen.value.set(faceNdc.x * 0.5 + 0.5, faceNdc.y * 0.5 + 0.5);
  }
  size(true);
  try {
    await renderer.compileAsync(scene, camera);
  } catch {
    /* compiled lazily on first render instead */
  }

  /* state: a bloom spreading from the face carries the new look outward */
  let key: Key = "ready";
  let waveP = 1;
  const pairs = [
    ["uA0", "uA1", "A"],
    ["uB0", "uB1", "B"],
    ["uR0", "uR1", "R"],
    ["uH0", "uH1", "H"],
  ] as const;
  const scalars = [
    ["uGlow", "glow"],
    ["uTint", "tint"],
    ["uAccent", "accent"],
  ] as const;
  let pulse0 = ready.pulse;
  function retarget(next: Key, instant: boolean) {
    const k = waveP >= 1 ? 1 : bloomFront(waveP);
    for (const [p0, p1, c] of pairs) {
      U[p0].value.lerp(U[p1].value, k);
      U[p1].value.copy(looks[next][c]);
      if (instant) U[p0].value.copy(U[p1].value);
    }
    for (const [u, c] of scalars) {
      const v = U[u].value;
      v.x += (v.y - v.x) * k;
      v.y = looks[next][c];
      if (instant) v.x = v.y;
    }
    pulse0 = U.uPulse.value;
    key = next;
    waveP = instant ? 1 : 0;
  }

  const pose = {
    yaw: { x: 0, v: 0 },
    pitch: { x: 0, v: 0 },
    roll: { x: 0, v: 0 },
  };
  const weight = { listening: 0, thinking: 0, speaking: 0 };
  let tau = 0;
  let lastForm = 0;
  let lastT = -1;
  let firstT = -1;
  let judged = 0;
  const gaps: number[] = [];
  let frameMs = 16.7;
  let simAcc = 0;
  const Rm = new THREE.Matrix3();
  const faceNow = new THREE.Vector3();

  const aura: Aura = {
    canvas,
    get stats(): AuraStats {
      return {
        mode: "webgl",
        figure: points.visible ? "particles" : "mesh",
        tier,
        devicePixelRatio: window.devicePixelRatio || 1,
        dpr: Math.round(pr * 100) / 100,
        backing: `${canvas.width}x${canvas.height}`,
        css: `${canvas.clientWidth}x${canvas.clientHeight}`,
        renderer: rendererName,
        mobile,
        triangles,
        lines: rib.lines,
        hairStrands: strands,
        hairGuides: hair.guides,
        scale,
        frameMs: Math.round(frameMs * 10) / 10,
      };
    },
    render(f) {
      const { t } = f;
      const dt = Math.max(0, Math.min(0.1, f.dt));
      // Adaptive quality: judged on the median frame of the last 2 s, never in the first 3 s after load and never
      // across a hidden tab or a hitch. Thinner hair first, then fewer device pixels, never below MIN_DPR.
      if (firstT < 0) firstT = t;
      if (lastT >= 0) {
        const gap = (t - lastT) * 1000;
        if (gap < 200 && !document.hidden) {
          frameMs = frameMs * 0.95 + gap * 0.05;
          gaps.push(gap);
        } else gaps.length = 0;
        if (t - judged >= 2) {
          judged = t;
          const m = median(gaps);
          gaps.length = 0;
          if (t - firstT > 3 && m > 0) {
            if (m > 24) {
              if (strands > BUDGET.low.strands) setStrands(strands * 0.75);
              else scale = Math.max(0.5, scale * 0.85);
            } else if (m < 17.5) {
              if (scale < 1) scale = Math.min(1, scale / 0.85);
              else if (strands < budget.strands)
                setStrands(Math.min(budget.strands, strands / 0.85));
            }
          }
        }
      } else gaps.length = 0;
      lastT = t;
      size();
      canvas.style.display = "block";
      canvas.style.opacity = String(
        Math.min(1, f.form / 0.3) * (0.35 + 0.65 * f.dim),
      );

      const motion = f.reduceMotion ? 0 : 1;
      // Birth: forward while the figure forms, back toward the glow when it dissolves. Skipped without motion.
      if (f.reduceMotion) tau = f.form > 0 ? BIRTH.total : 0;
      else if (f.form >= lastForm && f.form > 0)
        tau = Math.min(BIRTH.total, tau + dt);
      else tau = Math.min(tau, f.form * BIRTH.total);
      lastForm = f.form;
      U.uTau.value = tau;
      points.visible = tau < BIRTH.total;

      const want: Key = f.alert ? "alert" : f.state;
      if (want !== key) retarget(want, f.reduceMotion);
      if (waveP < 1) {
        waveP = Math.min(1, waveP + dt / TIMING.bloom);
        const e = bloomFront(waveP);
        U.uBloomR.value = e * BLOOM_REACH;
        U.uBloomEdge.value =
          Math.sin(Math.PI * Math.min(1, waveP * 1.1)) * (1 - waveP * 0.6);
        U.uPulse.value = pulse0 + (looks[key].pulse - pulse0) * e;
        if (waveP >= 1) {
          for (const [p0, p1] of pairs) U[p0].value.copy(U[p1].value);
          for (const [u] of scalars) U[u].value.x = U[u].value.y;
        }
      } else {
        U.uBloomR.value = 100;
        U.uBloomEdge.value = 0;
        U.uPulse.value = looks[key].pulse;
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

      /* the head: a real rotation about the neck, toward the pointer, plus its own life and the mood's posture */
      const clamp = (x: number, m: number) => Math.max(-m, Math.min(m, x));
      const idle = idlePose(t, motion);
      const yawT =
        motion *
        clamp(
          f.gazeX * GAZE.yaw +
            idle.yaw +
            weight.thinking * (0.06 + 0.03 * Math.sin(t * 0.23)),
          GAZE.yaw + 0.05,
        );
      const pitchT =
        motion *
        clamp(
          f.gazeY * GAZE.pitch +
            idle.pitch -
            weight.listening * 0.04 -
            weight.thinking * (0.05 + 0.015 * Math.sin(t * 0.31)) +
            weight.speaking *
              f.audio *
              (0.04 * Math.sin(t * 5.1) + 0.015 * Math.sin(t * 8.3)),
          GAZE.pitch + 0.04,
        );
      const rollT =
        motion *
        (idle.roll +
          weight.listening * 0.07 -
          weight.thinking * 0.04 +
          weight.speaking * f.audio * 0.012 * Math.sin(t * 3.7));
      spring(pose.yaw, yawT, dt);
      spring(pose.pitch, pitchT, dt);
      spring(pose.roll, rollT, dt);
      const R = headMatrix(pose.yaw.x, pose.pitch.x, pose.roll.x);
      Rm.fromArray(R);
      U.uHead.value.copy(Rm);
      faceNow.copy(faceRest).sub(pivot).applyMatrix3(Rm).add(pivot);
      U.uFace.value.copy(faceNow);

      /* the hair: verlet at a fixed 60 Hz (the roots follow the head; the rest follows a little late) */
      if (motion > 0) {
        simAcc = Math.min(simAcc + dt, 0.05);
        const wind = windForce(t, motion);
        // Speaking lifts it a touch with the voice.
        wind[1] -= weight.speaking * f.audio * 0.6;
        while (simAcc >= 1 / 60) {
          stepHair(hair, 1 / 60, R, wind, 1);
          simAcc -= 1 / 60;
        }
        uploadGuides();
      }

      U.uT.value = t;
      U.uMotion.value = motion;
      // A slow breath, about eleven a minute.
      U.uBreath.value = motion * Math.sin((t * 2 * Math.PI) / 5.4);
      U.uAudio.value = f.audio * weight.speaking;
      U.uFloor.value = f.floor > H ? -1 : (H - f.floor) * pr;

      if (document.hidden) return;
      renderer.render(scene, camera);
    },
    hide() {
      canvas.style.display = "none";
      lastT = -1;
    },
    dispose() {
      for (const g of [quad, geo, lineGeo, hairGeo, pointsGeo]) g.dispose();
      for (const m of [roomMat, bodyMat, lineMat, hairMat]) m.dispose();
      guideTex.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
  exposeStats(aura);
  if (import.meta.env?.DEV)
    (window as unknown as { __novaAuraParts?: object }).__novaAuraParts = {
      room,
      body,
      lineMesh,
      hairMesh,
      points,
      hair,
      renderer,
      scene,
    };
  return aura;
}

/** `__novaAura.stats()` in every build, so the owner can paste what his device does. */
function exposeStats(aura: Aura): void {
  (window as unknown as { __novaAura?: object }).__novaAura = {
    stats: () => aura.stats,
    aura,
  };
}

/** Without WebGL2: a still of the 3D figure, framed the same way, with a soft glow breathing at the face. */
function createStaticAura(under: HTMLCanvasElement): Aura {
  const root = document.createElement("div");
  root.className = "entity-gl entity-aura entity-aura-static";
  root.setAttribute("aria-hidden", "true");
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    overflow: "hidden",
    display: "none",
    pointerEvents: "none",
    background: "#030109",
  } satisfies Partial<CSSStyleDeclaration>);
  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.src = AURA_ASSETS.still;
  Object.assign(img.style, {
    position: "absolute",
    left: "50%",
    top: "0",
    height: "100%",
    transform: "translateX(-50%)",
    maxWidth: "none",
    userSelect: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  const glow = document.createElement("div");
  Object.assign(glow.style, {
    position: "absolute",
    left: "50%",
    top: "22%",
    width: "40vmin",
    height: "40vmin",
    transform: "translate(-50%, -50%)",
    borderRadius: "50%",
    mixBlendMode: "screen",
    transition: "background 1s ease",
  } satisfies Partial<CSSStyleDeclaration>);
  root.append(img, glow);
  under.before(root);
  let breathing: Animation | null = null;
  let lastKey = "";
  const aura: Aura = {
    canvas: root,
    get stats(): AuraStats {
      return {
        mode: "static",
        figure: "static",
        tier: "low",
        devicePixelRatio: window.devicePixelRatio || 1,
        dpr: 1,
        backing: "",
        css: `${window.innerWidth}x${window.innerHeight}`,
        renderer: "",
        mobile: false,
        triangles: 0,
        lines: 0,
        hairStrands: 0,
        hairGuides: 0,
        scale: 1,
        frameMs: 0,
      };
    },
    render(f) {
      root.style.display = "block";
      root.style.opacity = String(
        Math.min(1, f.form / 0.3) * (0.35 + 0.65 * f.dim),
      );
      const k = f.alert ? "alert" : f.state;
      if (k !== lastKey) {
        lastKey = k;
        glow.style.background = `radial-gradient(closest-side, ${LOOKS[k].a}40, ${LOOKS[k].b}18 55%, transparent)`;
      }
      if (!breathing && !f.reduceMotion && typeof glow.animate === "function")
        breathing = glow.animate([{ opacity: 0.55 }, { opacity: 1 }], {
          duration: 2700,
          iterations: Infinity,
          direction: "alternate",
          easing: "ease-in-out",
        });
    },
    hide() {
      root.style.display = "none";
    },
    dispose() {
      breathing?.cancel();
      root.remove();
    },
  };
  exposeStats(aura);
  return aura;
}
