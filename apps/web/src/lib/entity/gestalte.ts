import type * as ThreeModule from "three";
import type { UiState } from "#lib/stores/chat.svelte.ts";
import {
  buildGestalte,
  CHIN,
  CORE,
  CROWN,
  PIVOT,
  poseMatrix,
  type GestalteGeometry,
} from "./gestalte-body.ts";
import {
  BG_FRAG,
  BG_VERT,
  BODY_FRAG,
  BODY_VERT,
  CORE_FRAG,
  CORE_VERT,
  LAND_FRAG,
  LAND_VERT,
  POST_FRAG,
  POST_VERT,
  SHELL_FRAG,
  SPARK_FRAG,
  SPARK_VERT,
} from "./gestalte-shaders.ts";

/**
 * GESTALTE on the GPU. A head-and-shoulders bust fills the screen: crown near the top, chin a little past half
 * way, the shoulders and upper arms falling off the bottom. Dense dotted contour lines over a dark figure, a bright rim
 * with bloom, a warm core in the face with filaments down the neck, and a landscape of light on both sides.
 *
 * Runs on a WebGL2 canvas underneath the entity's 2D canvas (which keeps the orb, so the figure can grow out of
 * it and dissolve back). Built lazily on first use; entity.ts falls back to the Canvas2D presence when this
 * returns null.
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

export interface Gestalte {
  readonly canvas: HTMLCanvasElement;
  render(f: GestalteFrame): void;
  /** Hide without disposing (the orb is showing). */
  hide(): void;
  dispose(): void;
  /** Average GPU-bound frame interval the adaptive resolution is reacting to, in ms. */
  readonly stats: { scale: number; pixels: number };
}

/** The palette: electric blue lines and rim, a warm amber core. */
export const PALETTE = {
  bg: "#0a1220",
  bg2: "#020409",
  line: "#1e8fff",
  line2: "#4fd8ff",
  rim: "#3cc8ff",
  core: "#ff8a1a",
  hot: "#ffb347",
  grid: "#1f6fe0",
  streak: "#ff9a2e",
  /** Distance haze: the far ranges, the nebula and the stars lean toward it. */
  haze: "#6f9fe0",
} as const;

/** How much each state tints the rim and the core toward its own colour (the aesthetic stays blue + amber). */
const TINT: Record<UiState, { rim: number; core: number }> = {
  ready: { rim: 0, core: 0 },
  listening: { rim: 0.32, core: 0.15 },
  thinking: { rim: 0.38, core: 0.3 },
  executing: { rim: 0.3, core: 0.15 },
  speaking: { rim: 0.16, core: 0 },
};

let cachedGeometry: GestalteGeometry | null = null;

/** Visible height of the scene at the figure's plane, in body units, for a viewport aspect. */
export function viewHeight(aspect: number): number {
  // Crown ~5% from the top, chin ~57%: the head spans 52% of the height, which leaves room for the collarbones,
  // the chest and the start of the arms. Narrow screens widen the view so the head (about 1.5 units with the
  // ears) keeps some air on both sides.
  const byHeight = (CROWN - CHIN) / 0.52;
  return Math.max(byHeight, 2.3 / Math.max(0.2, aspect));
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

export async function createGestalte(
  under: HTMLCanvasElement,
): Promise<Gestalte | null> {
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
  renderer.setClearColor(PALETTE.bg, 1);

  const geo = (cachedGeometry ??= buildGestalte(1, 12000));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 200);

  const col = (hex: string) => new THREE.Color(hex);
  const v3 = (c: ThreeModule.Color) => new THREE.Vector3(c.r, c.g, c.b);
  const base = {
    line: col(PALETTE.line),
    line2: col(PALETTE.line2),
    rim: col(PALETTE.rim),
    core: col(PALETTE.core),
    hot: col(PALETTE.hot),
  };
  const U = {
    uT: { value: 0 },
    uMotion: { value: 1 },
    uAudio: { value: 0 },
    uDim: { value: 1 },
    uPx: { value: 1 },
    uFloor: { value: -1 },
    uH: { value: 1 },
    uW: { value: new THREE.Vector4() },
    uScan: { value: 0 },
    uCoreI: { value: 1 },
    uLine: { value: v3(base.line) },
    uLine2: { value: v3(base.line2) },
    uRim: { value: v3(base.rim) },
    uCore: { value: v3(base.core) },
    uHot: { value: v3(base.hot) },
    uHead: { value: new THREE.Matrix3() },
    uTorso: { value: new THREE.Matrix3() },
    uPivot: { value: new THREE.Vector3(...PIVOT) },
    uPivotT: { value: new THREE.Vector3() },
    uForm: { value: 0 },
    uBreath: { value: 0 },
    uOpen: { value: 0 },
    uOrbC: { value: new THREE.Vector3() },
    uOrbR: { value: 1 },
    uShell: { value: 0 },
    uReady: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uBg: { value: v3(col(PALETTE.bg)) },
    uBg2: { value: v3(col(PALETTE.bg2)) },
    uGrid: { value: v3(col(PALETTE.grid)) },
    uStreak: { value: v3(col(PALETTE.streak)) },
    uHaze: { value: v3(col(PALETTE.haze)) },
    uPar: { value: new THREE.Vector2() },
    uFade: { value: 0 },
    uCoreC: { value: new THREE.Vector3() },
    uCoreS: { value: 1.5 },
  };
  const shellU = { ...U, uShell: { value: 0.07 } };

  // Body mesh, shared by the depth pre-pass, the lit pass and the shell.
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute("position", new THREE.BufferAttribute(geo.position, 3));
  bodyGeo.setAttribute("normal", new THREE.BufferAttribute(geo.normal, 3));
  bodyGeo.setAttribute("aOrb", new THREE.BufferAttribute(geo.orb, 3));
  bodyGeo.setAttribute("aDelay", new THREE.BufferAttribute(geo.delay, 1));
  bodyGeo.setAttribute("aHead", new THREE.BufferAttribute(geo.head, 1));
  bodyGeo.setIndex(new THREE.BufferAttribute(geo.index, 1));

  const additive = {
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  } as const;
  const depthMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: BODY_VERT,
    fragmentShader: "void main() { gl_FragColor = vec4(0.0); }",
    colorWrite: false,
    side: THREE.DoubleSide,
  });
  const bodyMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: BODY_VERT,
    fragmentShader: BODY_FRAG,
    side: THREE.DoubleSide,
    depthFunc: THREE.LessEqualDepth,
    ...additive,
  });
  const shellMat = new THREE.ShaderMaterial({
    uniforms: shellU,
    vertexShader: BODY_VERT,
    fragmentShader: SHELL_FRAG,
    side: THREE.FrontSide,
    ...additive,
  });
  const depthMesh = new THREE.Mesh(bodyGeo, depthMat);
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  const shellMesh = new THREE.Mesh(bodyGeo, shellMat);

  // Sparks.
  const sparkGeo = new THREE.BufferGeometry();
  const ns = geo.sparkHead.length;
  const seeds = new Float32Array(ns * 4);
  for (let i = 0; i < seeds.length; i++)
    seeds[i] = (Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1;
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.abs(seeds[i]!);
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

  // Core glow, background, landscape.
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
  const landGeo = new THREE.PlaneGeometry(100, 64, 480, 300);
  const landMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: LAND_VERT,
    fragmentShader: LAND_FRAG,
    ...additive,
  });
  const land = new THREE.Mesh(landGeo, landMat);

  const order: [ThreeModule.Object3D, number][] = [
    [bgMesh, -10],
    [depthMesh, 0],
    [land, 1],
    [bodyMesh, 2],
    [shellMesh, 3],
    [coreMesh, 4],
    [sparks, 5],
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
    0.85,
    0.18,
    0.5,
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

  /* sizing: the drawing buffer never exceeds 4K, and steps down if frames run long */
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
      2,
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

  /* pose and state, eased so nothing ever snaps */
  const weight = { listening: 0, thinking: 0, executing: 0, speaking: 0 };
  // Head pose follows its targets on critically damped springs (no overshoot), so a gaze change starts
  // softly, keeps its velocity through a retarget and settles without a bounce.
  const pose = {
    yaw: { x: 0, v: 0 },
    pitch: { x: 0, v: 0 },
    roll: { x: 0, v: 0 },
  };
  const par = { x: 0, y: 0 };
  function spring(s: { x: number; v: number }, target: number, dt: number) {
    const w = (2 * Math.PI) / 1.1;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = Math.min(dt, 0.1) / steps;
    for (let i = 0; i < steps; i++) {
      s.v += (w * w * (target - s.x) - 2 * w * s.v) * h;
      s.x += s.v * h;
    }
  }
  let scan = 0;
  const Mh = new Float32Array(9);
  const Mt = new Float32Array(9);
  const tint = new THREE.Color();
  const tmp = new THREE.Color();
  let rimMix = 0;
  let coreMix = 0;
  let slow = 0;
  let lastT = -1;

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

  return {
    canvas,
    get stats() {
      return { scale, pixels: Math.round(W * pr) * Math.round(H * pr) };
    },
    render(f) {
      const { t, dt } = f;
      // Adaptive resolution: a wallpaper runs all day, so long frames lower the buffer, never the frame rate.
      if (lastT >= 0) {
        const gap = (t - lastT) * 1000;
        // Gaps over 200 ms are throttling or a hitch elsewhere, not this scene being too heavy.
        if (gap < 200) slow = slow * 0.97 + (gap > 24 ? 1 : 0) * 0.03;
        if (slow > 0.6 && scale > 0.55) {
          scale = Math.max(0.55, scale * 0.85);
          slow = 0;
        }
      }
      lastT = t;
      size();
      canvas.style.display = "block";
      // The figure's own light carries the emergence; the room fades in underneath it.
      canvas.style.opacity = String(Math.min(1, f.form / 0.3));

      const motion = f.reduceMotion ? 0 : 1;
      const kw = 1 - Math.exp(-dt * 3);
      for (const key of Object.keys(weight) as (keyof typeof weight)[])
        weight[key] += ((key === f.state ? 1 : 0) - weight[key]) * kw;

      const yawT =
        motion *
        (f.gazeX * 0.16 +
          0.035 * Math.sin(t * 0.17) +
          weight.thinking * 0.1 -
          weight.executing * 0.04);
      const pitchT =
        motion *
        (f.gazeY * 0.07 -
          weight.thinking * 0.06 +
          weight.listening * 0.05 +
          weight.speaking * 0.025 * f.audio * Math.sin(t * 2.3));
      const rollT =
        motion *
        (weight.listening * 0.04 -
          weight.thinking * 0.025 +
          0.012 * Math.sin(t * 0.23 + 1.3));
      spring(pose.yaw, yawT, dt);
      spring(pose.pitch, pitchT, dt);
      spring(pose.roll, rollT, dt);
      const yaw = pose.yaw.x;
      const pitch = pose.pitch.x;
      const roll = pose.roll.x;
      const kpar = 1 - Math.exp(-dt * 1.6);
      par.x += (motion * f.gazeX - par.x) * kpar;
      par.y += (motion * f.gazeY - par.y) * kpar;
      U.uPar.value.set(par.x, par.y);
      // The camera sits a little above the figure: the face is met nearly level, the torso is seen more from
      // above, so the slices across the chest bow toward the viewer like a real body's.
      poseMatrix(Mh, yaw, pitch, roll, 0.1);
      poseMatrix(Mt, yaw * 0.18, pitch * 0.1, 0, 0.32);
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
      U.uW.value.set(
        weight.listening,
        weight.thinking,
        weight.executing,
        weight.speaking,
      );
      U.uForm.value = f.form;
      U.uReady.value = Math.max(0, (f.form - 0.75) / 0.25);
      U.uFade.value = Math.max(0, Math.min(1, (f.form - 0.2) / 0.8));
      U.uDim.value = f.dim;
      U.uFloor.value = f.floor > H ? -1e4 : (H - f.floor) * pr;
      U.uOrbC.value.set((f.ocx - W / 2) / ppu, camY - (f.ocy - H / 2) / ppu, 0);
      U.uOrbR.value = Math.max(0.05, f.orbR / ppu);

      // State tints: the rim and the core lean toward the state's colour; an alert turns both toward red.
      const target = f.alert ? { rim: 0.6, core: 0.5 } : TINT[f.state];
      rimMix += (target.rim - rimMix) * kw;
      coreMix += (target.core - coreMix) * kw;
      tint.setHSL(f.h / 360, Math.min(1, f.s / 100), 0.6);
      U.uRim.value.set(
        base.rim.r + (tint.r - base.rim.r) * rimMix,
        base.rim.g + (tint.g - base.rim.g) * rimMix,
        base.rim.b + (tint.b - base.rim.b) * rimMix,
      );
      tmp.copy(base.core).lerp(tint, coreMix);
      U.uCore.value.set(tmp.r, tmp.g, tmp.b);
      const breathe = 0.08 * Math.sin(t * 0.7) * motion;
      U.uCoreI.value =
        0.85 +
        breathe +
        weight.thinking *
          0.25 *
          (0.5 + 0.5 * Math.sin(t * 1.6 * (motion || 0.2))) +
        weight.listening * 0.15 +
        weight.speaking * f.audio * 0.45;

      if (document.hidden) return;
      composer.render(dt);
    },
    hide() {
      canvas.style.display = "none";
      lastT = -1;
    },
    dispose() {
      bodyGeo.dispose();
      sparkGeo.dispose();
      quad.dispose();
      landGeo.dispose();
      for (const m of [
        depthMat,
        bodyMat,
        shellMat,
        sparkMat,
        coreMat,
        bgMat,
        landMat,
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
