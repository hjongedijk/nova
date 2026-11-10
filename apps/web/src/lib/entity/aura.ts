import type * as ThreeModule from "three";
import type { UiState } from "#lib/stores/chat.svelte.ts";
import { AURA_ASSETS, auraFraming, BIRTH, FACE } from "./aura-data.ts";
import {
  loadPixels,
  sampleParticles,
  type AuraParticles,
} from "./aura-particles.ts";
import {
  PLATE_FRAG,
  PLATE_VERT,
  POINTS_FRAG,
  POINTS_VERT,
} from "./aura-shaders.ts";

export { BREATH, LIGHTS, LINES } from "./aura-shaders.ts";

/**
 * AURA: the owner's artwork (a blank-faced figure of light, static/aura) brought to life on the GPU. The picture
 * is shown as it is, with neon stripes laid over the head and body that follow its rounded form; it is also
 * sampled into particles that fly in from a glow and settle into it at birth. Moods bloom out from the face; the
 * head turns toward the pointer as a depth illusion; the chest breathes. At rest, facing front, the frame is the
 * artwork plus its stripes.
 *
 * Same contract as the Gestalte (entity.ts drives both): a canvas under the entity's 2D canvas, built lazily.
 * Without WebGL2 it is the still picture with a soft CSS glow. Nothing here waits on chat or audio: a frame only
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
  tier: GpuTier;
  scale: number;
  pixels: number;
  /** Particles drawn now, of those sampled. */
  particles: number;
  sampled: number;
  /** Particle diameter on screen, CSS px. */
  pointPx: number;
  /** Smoothed interval between rendered frames, ms. */
  frameMs: number;
}

export type GpuTier = "low" | "mid" | "high";

/** Colours per mood, as sRGB hex; converted to linear once. */
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

/** The room around the picture where it does not reach (phones): the artwork's own darkness. */
export const ROOM = "#040113";

/** Particle and resolution budgets per GPU class. */
export const BUDGET: Record<
  GpuTier,
  { particles: number; dpr: number; image: "hi" | "lo" }
> = {
  low: { particles: 70_000, dpr: 1, image: "lo" },
  mid: { particles: 170_000, dpr: 1.5, image: "hi" },
  high: { particles: 280_000, dpr: 2, image: "hi" },
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

/** Head turn limits toward the pointer, radians. */
export const GAZE = { yaw: 0.3, pitch: 0.12 } as const;

/** Birth length, and how long a mood takes to bloom out from the face, seconds. */
export const TIMING = { birth: BIRTH.total, bloom: 1.0 } as const;

/** Ease of the bloom's radius: it gathers, spreads over the body, and settles as it reaches the edges. */
export function bloomFront(p: number): number {
  const x = Math.max(0, Math.min(1, p));
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/** The bloom has covered the whole frame (from the face past the farthest corner) when its radius reaches this. */
export const BLOOM_REACH = 1.3;

/** Particle radius in grid cells (the fragment shader normalises its weight for this). */
const KERNEL = 2;

/** Dev only: which layers to show, to compare the particles and the artwork. */
export type AuraView = "composed" | "artwork" | "particles";

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

async function bitmap(url: string, raw: boolean): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  // Decoded off the main thread. Data stays exactly as stored; the picture is plain sRGB.
  return createImageBitmap(await res.blob(), {
    colorSpaceConversion: raw ? "none" : "default",
    premultiplyAlpha: "none",
  });
}

/** Sample the artwork into particles in a worker (on the page if workers are unavailable). */
function loadParticles(image: string, count: number): Promise<AuraParticles> {
  const local = async () =>
    sampleParticles(
      await loadPixels(image),
      await loadPixels(AURA_ASSETS.data),
      count,
    );
  return new Promise<AuraParticles>((resolve, reject) => {
    try {
      const w = new Worker(new URL("./aura.worker.ts", import.meta.url), {
        type: "module",
      });
      w.onmessage = (e: MessageEvent<AuraParticles | { error: string }>) => {
        w.terminate();
        if ("error" in e.data) local().then(resolve, reject);
        else resolve(e.data);
      };
      w.onerror = () => {
        w.terminate();
        local().then(resolve, reject);
      };
      w.postMessage({ image, data: AURA_ASSETS.data, count });
    } catch {
      local().then(resolve, reject);
    }
  });
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

export async function createAura(
  under: HTMLCanvasElement,
  options: { tier?: GpuTier; forceStatic?: boolean } = {},
): Promise<Aura | null> {
  if (typeof document === "undefined") return null;
  if (options.forceStatic || !webgl2Available()) return createStaticAura(under);
  let THREE: Three;
  try {
    THREE = (await import("three")) as Three;
  } catch {
    return createStaticAura(under);
  }
  try {
    return await createGlAura(THREE, under, options.tier);
  } catch {
    return createStaticAura(under);
  }
}

async function createGlAura(
  THREE: Three,
  under: HTMLCanvasElement,
  forcedTier: GpuTier | undefined,
): Promise<Aura> {
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
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

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
  const tier = forcedTier ?? gpuTier(rendererName, window.innerWidth);
  const budget = BUDGET[tier];
  const wide =
    window.innerWidth * Math.min(window.devicePixelRatio || 1, budget.dpr) >
    1400;
  const imageUrl =
    budget.image === "hi" && wide ? AURA_ASSETS.hi : AURA_ASSETS.lo;

  const particlesPromise = loadParticles(imageUrl, budget.particles).catch(
    () => null,
  );
  let imageBmp: ImageBitmap;
  let dataBmp: ImageBitmap;
  let linesBmp: ImageBitmap;
  try {
    [imageBmp, dataBmp, linesBmp] = await Promise.all([
      bitmap(imageUrl, false),
      bitmap(AURA_ASSETS.data, true),
      bitmap(AURA_ASSETS.lines, true),
    ]);
  } catch (err) {
    renderer.dispose();
    throw err;
  }
  under.before(canvas);

  const imageTex = new THREE.Texture(imageBmp);
  imageTex.colorSpace = THREE.SRGBColorSpace;
  imageTex.flipY = false;
  imageTex.generateMipmaps = true;
  imageTex.minFilter = THREE.LinearMipmapLinearFilter;
  imageTex.magFilter = THREE.LinearFilter;
  imageTex.wrapS = imageTex.wrapT = THREE.ClampToEdgeWrapping;
  imageTex.anisotropy = 4;
  imageTex.needsUpdate = true;
  const dataTex = new THREE.Texture(dataBmp);
  dataTex.colorSpace = THREE.NoColorSpace;
  dataTex.flipY = false;
  dataTex.generateMipmaps = false;
  dataTex.minFilter = THREE.LinearFilter;
  dataTex.magFilter = THREE.LinearFilter;
  dataTex.wrapS = dataTex.wrapT = THREE.ClampToEdgeWrapping;
  dataTex.needsUpdate = true;
  const linesTex = new THREE.Texture(linesBmp);
  linesTex.colorSpace = THREE.NoColorSpace;
  linesTex.flipY = false;
  linesTex.generateMipmaps = false;
  linesTex.minFilter = THREE.LinearFilter;
  linesTex.magFilter = THREE.LinearFilter;
  linesTex.wrapS = linesTex.wrapT = THREE.ClampToEdgeWrapping;
  linesTex.needsUpdate = true;

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
  const room = new THREE.Color(ROOM);

  const U = {
    uImage: { value: imageTex },
    uData: { value: dataTex },
    uLines: { value: linesTex },
    uFrame: { value: new THREE.Vector4(0, 0, 1, 1) },
    uFade: { value: new THREE.Vector4(1e-4, 1e-4, 1e-4, 1e-4) },
    uRes: { value: new THREE.Vector2(1, 1) },
    uT: { value: 0 },
    uMotion: { value: 1 },
    uTurn: { value: new THREE.Vector2() },
    uBreath: { value: 0 },
    uTau: { value: 0 },
    uRoom: { value: new THREE.Vector3(room.r, room.g, room.b) },
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
    uPulse: { value: ready.pulse },
    uAudio: { value: 0 },
    uFloor: { value: -1 },
    uView: { value: 0 },
  };
  const P = {
    uFrame: { value: new THREE.Vector4(0, 0, 1, 1) },
    uView: { value: new THREE.Vector2(1, 1) },
    uPx: { value: 1 },
    uSize: { value: 1 },
    uT: U.uT,
    uMotion: U.uMotion,
    uTau: U.uTau,
    uBreath: U.uBreath,
    uTurn: U.uTurn,
    uGain: { value: 0 },
    uTwinkle: { value: 0.15 },
    uFly: { value: new THREE.Vector3(0.8, 0.6, 1) },
  };

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const tri = new THREE.BufferGeometry();
  tri.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]),
      3,
    ),
  );
  const plateMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: PLATE_VERT,
    fragmentShader: PLATE_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const plate = new THREE.Mesh(tri, plateMat);
  plate.frustumCulled = false;
  plate.renderOrder = 0;
  scene.add(plate);

  const pointsMat = new THREE.ShaderMaterial({
    uniforms: P,
    vertexShader: POINTS_VERT,
    fragmentShader: POINTS_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  let pointsGeo: ThreeModule.BufferGeometry | null = null;
  let points: ThreeModule.Points | null = null;
  let sampled = 0;
  let drawn = 0;
  let cell = 0.002;
  const setDrawn = (n: number) => {
    drawn = Math.max(0, Math.min(sampled, Math.round(n)));
    pointsGeo?.setDrawRange(0, drawn);
  };
  const particles = await particlesPromise;
  if (particles && particles.count > 0) {
    pointsGeo = new THREE.BufferGeometry();
    // The home position doubles as `position` (two components): three counts vertices by it.
    pointsGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(particles.home, 2),
    );
    pointsGeo.setAttribute(
      "aColor",
      new THREE.BufferAttribute(particles.color, 4, true),
    );
    pointsGeo.setAttribute(
      "aSeed",
      new THREE.BufferAttribute(particles.seed, 4),
    );
    // Two-component positions: give three the bounds instead of letting it compute them.
    pointsGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    points = new THREE.Points(pointsGeo, pointsMat);
    points.frustumCulled = false;
    points.renderOrder = 1;
    scene.add(points);
    sampled = particles.count;
    cell = particles.cell;
    setDrawn(sampled);
  }

  /* sizing: the buffer is capped per GPU class and steps down while frames run long */
  let W = 0;
  let H = 0;
  let scale = tier === "low" ? 0.8 : 1;
  let pr = 1;
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
    const fr = auraFraming(W, H);
    U.uFrame.value.set(fr.x * pr, fr.y * pr, fr.w * pr, fr.h * pr);
    P.uFrame.value.set(fr.x, fr.y, fr.w, fr.h);
    P.uView.value.set(W, H);
    P.uPx.value = pr;
    U.uRes.value.set(Math.round(W * pr), Math.round(H * pr));
    // Fade the picture into the room only along edges that are on screen.
    const top = fr.y > 0.5 ? 0.07 : 1e-4;
    const bottom = fr.y + fr.h < H - 0.5 ? 0.16 : 1e-4;
    const side = fr.x > 0.5 ? 0.04 : 1e-4;
    U.uFade.value.set(top, bottom, side, side);
    sizePoints();
  }
  function sizePoints() {
    // An even grid of kernels of the cell's size adds up to the picture; fewer drawn, each a little larger.
    P.uSize.value =
      KERNEL *
      cell *
      P.uFrame.value.z *
      Math.sqrt(sampled / Math.max(1, drawn));
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
    // Interrupted mid-bloom: start from what most of the figure shows now.
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

  const pose = { yaw: { x: 0, v: 0 }, pitch: { x: 0, v: 0 } };
  const weight = { listening: 0, thinking: 0, speaking: 0 };
  let tau = 0;
  let lastForm = 0;
  let lastT = -1;
  let slow = 0;
  let fast = 0;
  let frameMs = 16.7;
  let view: AuraView = "composed";

  const aura: Aura & { view(v: AuraView): void; particles(n: number): void } = {
    canvas,
    get stats(): AuraStats {
      return {
        mode: "webgl",
        tier,
        scale,
        pixels: Math.round(W * pr) * Math.round(H * pr),
        particles: drawn,
        sampled,
        pointPx: Math.round(P.uSize.value * 200) / 100,
        frameMs: Math.round(frameMs * 10) / 10,
      };
    },
    particles(n) {
      setDrawn(n);
      sizePoints();
    },
    view(v) {
      view = v;
      U.uView.value = v === "artwork" ? 1 : v === "particles" ? 2 : 0;
      P.uGain.value = v === "particles" ? 1 : 0;
      if (points) points.visible = v !== "artwork";
    },
    render(f) {
      const { t } = f;
      const dt = Math.max(0, Math.min(0.1, f.dt));
      // Adaptive quality: long frames first thin the particles, then lower the buffer, never the frame rate.
      if (lastT >= 0) {
        const gap = (t - lastT) * 1000;
        if (gap < 200) {
          frameMs = frameMs * 0.95 + gap * 0.05;
          slow = slow * 0.97 + (gap > 22 ? 1 : 0) * 0.03;
          fast = gap < 17.5 ? fast + gap / 1000 : 0;
        }
        if (slow > 0.6) {
          slow = 0;
          if (drawn > BUDGET.low.particles) {
            setDrawn(Math.max(BUDGET.low.particles, drawn * 0.75));
            sizePoints();
          } else if (scale > 0.55) scale = Math.max(0.55, scale * 0.85);
        } else if (fast > 12 && scale < 1) {
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
      // Birth: forward while the figure forms, back toward the glow when it dissolves. Skipped without motion.
      if (f.reduceMotion) tau = f.form > 0 ? BIRTH.total : 0;
      else if (f.form >= lastForm && f.form > 0)
        tau = Math.min(BIRTH.total, tau + dt);
      else tau = Math.min(tau, f.form * BIRTH.total);
      lastForm = f.form;
      U.uTau.value = view === "composed" ? tau : BIRTH.total;

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

      /* head: toward the pointer, within limits, on springs; facing front it is exactly the artwork */
      const clamp = (x: number, m: number) => Math.max(-m, Math.min(m, x));
      const yawT =
        motion * clamp(f.gazeX * GAZE.yaw + weight.thinking * 0.05, GAZE.yaw);
      const pitchT =
        motion *
        clamp(
          -f.gazeY * GAZE.pitch +
            weight.listening * 0.03 -
            weight.thinking * 0.03 +
            weight.speaking * 0.015 * f.audio * Math.sin(t * 2.3),
          GAZE.pitch,
        );
      spring(pose.yaw, yawT, dt);
      spring(pose.pitch, pitchT, dt);
      const tiny = (v: number) => (Math.abs(v) < 2e-4 ? 0 : v);
      U.uTurn.value.set(tiny(pose.yaw.x), tiny(pose.pitch.x));

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
      tri.dispose();
      pointsGeo?.dispose();
      plateMat.dispose();
      pointsMat.dispose();
      imageTex.dispose();
      dataTex.dispose();
      linesTex.dispose();
      imageBmp.close();
      dataBmp.close();
      linesBmp.close();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
  if (import.meta.env?.DEV)
    (window as unknown as { __novaAura?: typeof aura }).__novaAura = aura;
  return aura;
}

/** Without WebGL2: the picture itself, framed the same way, with a soft glow breathing at the face. */
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
    background: ROOM,
  } satisfies Partial<CSSStyleDeclaration>);
  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.src =
    window.innerWidth * (window.devicePixelRatio || 1) > 1400
      ? AURA_ASSETS.hi
      : AURA_ASSETS.lo;
  Object.assign(img.style, {
    position: "absolute",
    maxWidth: "none",
    userSelect: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  const glow = document.createElement("div");
  Object.assign(glow.style, {
    position: "absolute",
    borderRadius: "50%",
    mixBlendMode: "screen",
    transition: "background 1s ease",
  } satisfies Partial<CSSStyleDeclaration>);
  root.append(img, glow);
  under.before(root);
  let breathing: Animation | null = null;
  let lastKey = "";
  let W = 0;
  let H = 0;
  return {
    canvas: root,
    get stats(): AuraStats {
      return {
        mode: "static",
        tier: "low",
        scale: 1,
        pixels: 0,
        particles: 0,
        sampled: 0,
        pointPx: 0,
        frameMs: 0,
      };
    },
    render(f) {
      root.style.display = "block";
      root.style.opacity = String(
        Math.min(1, f.form / 0.3) * (0.35 + 0.65 * f.dim),
      );
      if (window.innerWidth !== W || window.innerHeight !== H) {
        W = window.innerWidth;
        H = window.innerHeight;
        const fr = auraFraming(W, H);
        Object.assign(img.style, {
          left: `${fr.x}px`,
          top: `${fr.y}px`,
          width: `${fr.w}px`,
          height: `${fr.h}px`,
        });
        const r = fr.h * 0.34;
        Object.assign(glow.style, {
          left: `${fr.x + FACE.u * fr.w - r}px`,
          top: `${fr.y + FACE.v * fr.h - r}px`,
          width: `${2 * r}px`,
          height: `${2 * r}px`,
        });
      }
      const k = f.alert ? "alert" : f.state;
      if (k !== lastKey) {
        lastKey = k;
        glow.style.background = `radial-gradient(closest-side, ${LOOKS[k].a}55, ${LOOKS[k].b}22 55%, transparent)`;
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
}
