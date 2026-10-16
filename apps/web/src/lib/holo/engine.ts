import type * as T from "three";
import type * as ThreeModule from "three";
import type { OrbitControls as OrbitControlsType } from "three/examples/jsm/controls/OrbitControls.js";
import type { EffectComposer as EffectComposerType } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { resolveTheme, shapeOf, statusColor } from "./colors.ts";
import { layoutGraph } from "./layout.ts";
import { loadModel, ModelLoadError } from "./loaders.ts";
import { distance, formatDistance, type Vec3 } from "./measure.ts";
import { MaterialKit } from "./materials.ts";
import { resolveMode } from "./modes.ts";
import { sceneSignature } from "./table.ts";
import type {
  HoloDimension,
  HoloLoadState,
  HoloMeasurement,
  HoloPart,
  HoloQuality,
  HoloSelectionInfo,
  HoloTheme,
  VizCameraPreset,
  VizMode,
  VizScene,
  VizStatus,
  VizView,
} from "./types.ts";

type Three = typeof ThreeModule;

export interface EngineCallbacks {
  onSelect?(id: string | null, info: HoloSelectionInfo | null): void;
  onHover?(
    id: string | null,
    label: string,
    position: { x: number; y: number } | null,
  ): void;
  onLoad?(state: HoloLoadState): void;
  onMeasure?(measurements: HoloMeasurement[]): void;
  onParts?(parts: HoloPart[]): void;
  onQuality?(tier: "high" | "medium" | "low"): void;
  onHotspot?(id: string): void;
}

export interface EngineOptions {
  container: HTMLElement;
  theme: HoloTheme;
  quality: HoloQuality;
  callbacks?: EngineCallbacks;
}

interface Item {
  id: string;
  label: string;
  kind: HoloSelectionInfo["kind"];
  object: T.Object3D;
  mesh?: T.Mesh;
  layer?: string;
  color: string;
  /** No colour was given for this model: holographic/x-ray use the accent colour instead. */
  tinted?: boolean;
  status?: VizStatus;
  value?: number | null;
  original?: T.Material | T.Material[];
  radius: number;
  outline?: T.Object3D;
  edges?: T.LineSegments;
  labelSprite?: T.Sprite;
}

const BACKGROUND = { dark: "#050a14", light: "#eef2f8" };
const HIGHLIGHT = { dark: "#ffcf6b", light: "#a86b00" };
const SELECTED = { dark: "#ffffff", light: "#06070f" };
const TIERS = ["low", "medium", "high"] as const;
const MAX_EDGE_TRIANGLES = 250_000;

const PRESETS: Record<VizCameraPreset, [number, number, number]> = {
  iso: [1, 0.8, 1],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0.0001],
  bottom: [0, -1, 0.0001],
};

const triangles = (mesh: T.Mesh): number => {
  const geometry = mesh.geometry;
  return Math.round(
    (geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0) /
      3,
  );
};

/** Whether this browser can create a WebGL context at all. */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl")
    );
  } catch {
    return false;
  }
}

/**
 * The three.js side of the viewer. Rendering is on demand: a frame is drawn only after something
 * changed (camera, mode, selection, resize), plus a short intro animation that stops on its own.
 * There is no idle render loop. Everything GPU-side is released in dispose().
 */
export class HoloEngine {
  private three!: Three;
  private renderer!: T.WebGLRenderer;
  private scene3!: T.Scene;
  private camera!: T.PerspectiveCamera;
  private controls!: OrbitControlsType;
  private OrbitControlsClass!: typeof OrbitControlsType;
  private bloomLoading = false;
  private frameCount = 0;
  private graceUntil = 0;
  private composer: EffectComposerType | null = null;
  private bloomPass: { enabled: boolean } | null = null;
  private kit!: MaterialKit;
  private content!: T.Group;
  private overlay!: T.Group;
  private grid: T.Object3D | null = null;
  private items = new Map<string, Item>();
  private byName = new Map<string, Item>();
  private selectables: T.Object3D[] = [];
  private edgeLines: T.LineSegments | null = null;
  private partGroups = new Map<string, { object: T.Object3D; label: string }>();
  private labelCache = new Map<string, T.CanvasTexture>();
  private annotationSprites: T.Sprite[] = [];
  private measureObjects: T.Object3D[] = [];
  private measurements: HoloMeasurement[] = [];
  private measurePending: Vec3 | null = null;
  private hotspotItems: Item[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private motionQuery: MediaQueryList | null = null;
  private colorQuery: MediaQueryList | null = null;
  private abort = new AbortController();
  private rafId = 0;
  private disposed = false;
  private reducedMotion = false;
  private animateUntil = 0;
  private tween: {
    start: number;
    duration: number;
    fromPos: T.Vector3;
    toPos: T.Vector3;
    fromTarget: T.Vector3;
    toTarget: T.Vector3;
  } | null = null;
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  private tier = 2;
  private qualityPinned: HoloQuality = "auto";
  private theme: "dark" | "light" = "dark";
  private themeSetting: HoloTheme;
  private mode: VizMode = "holographic";
  private dimension: HoloDimension = "3d";
  private current: VizScene | null = null;
  private signature = "";
  private zUp = false;
  private sceneRadius = 5;
  private highlights = new Set<string>();
  private selectedId: string | null = null;
  private hidden = new Set<string>();
  private hiddenParts = new Set<string>();
  private measuring = false;
  private view: VizView | null = null;
  private lastCameraSeq = 0;
  private pointerDown: { x: number; y: number; t: number } | null = null;
  private lastHover: string | null = null;
  private hoverQueued = false;
  private hoverEvent: PointerEvent | null = null;
  private cleanup: (() => void)[] = [];
  private loadToken = 0;

  private constructor(private readonly options: EngineOptions) {
    this.themeSetting = options.theme;
    this.qualityPinned = options.quality;
  }

  static async create(options: EngineOptions): Promise<HoloEngine> {
    const engine = new HoloEngine(options);
    await engine.init();
    return engine;
  }

  private get cb(): EngineCallbacks {
    return this.options.callbacks ?? {};
  }

  private async init(): Promise<void> {
    const three = (this.three = await import("three"));
    const { OrbitControls } =
      await import("three/examples/jsm/controls/OrbitControls.js");
    if (this.disposed) return;
    this.OrbitControlsClass = OrbitControls;
    const { container } = this.options;
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.colorQuery = window.matchMedia("(prefers-color-scheme: light)");
    this.reducedMotion = this.motionQuery.matches;
    const onMotion = () => {
      this.reducedMotion = !!this.motionQuery?.matches;
      this.controls.enableDamping = !this.reducedMotion;
    };
    const onColor = () => {
      if (this.themeSetting === "auto") this.applyTheme();
    };
    this.motionQuery.addEventListener("change", onMotion);
    this.colorQuery.addEventListener("change", onColor);
    this.cleanup.push(() => {
      this.motionQuery?.removeEventListener("change", onMotion);
      this.colorQuery?.removeEventListener("change", onColor);
    });

    this.theme = resolveTheme(this.themeSetting, !!this.colorQuery.matches);
    this.tier =
      this.qualityPinned === "auto"
        ? 2
        : TIERS.indexOf(this.qualityPinned as (typeof TIERS)[number]);
    this.renderer = new three.WebGLRenderer({
      antialias: this.tier > 0,
      powerPreference: "high-performance",
    });
    const canvas = this.renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    canvas.tabIndex = 0;
    canvas.setAttribute("data-holo-canvas", "");
    container.appendChild(canvas);

    this.scene3 = new three.Scene();
    this.scene3.background = new three.Color(BACKGROUND[this.theme]);
    this.camera = new three.PerspectiveCamera(45, 1, 0.01, 5000);
    this.content = new three.Group();
    this.overlay = new three.Group();
    this.scene3.add(this.content, this.overlay);
    const hemi = new three.HemisphereLight("#cfe8ff", "#1a2233", 1.1);
    const sun = new three.DirectionalLight("#ffffff", 1.6);
    sun.position.set(3, 6, 4);
    this.scene3.add(hemi, sun);
    this.kit = new MaterialKit(three);
    this.kit.theme = this.theme;

    this.createControls();
    this.resize();
    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
      this.requestRender();
    });
    this.resizeObserver.observe(container);

    const on = <E extends Event = Event>(
      type: string,
      handler: (event: E) => void,
    ) => {
      canvas.addEventListener(type, handler as EventListener);
      this.cleanup.push(() =>
        canvas.removeEventListener(type, handler as EventListener),
      );
    };
    on<PointerEvent>("pointerdown", (event) => {
      this.pointerDown = {
        x: event.clientX,
        y: event.clientY,
        t: event.timeStamp,
      };
    });
    on<PointerEvent>("pointerup", (event) => this.onPointerUp(event));
    on<PointerEvent>("pointermove", (event) => {
      this.hoverEvent = event;
      if (this.hoverQueued || this.pointerDown) return;
      this.hoverQueued = true;
      requestAnimationFrame(() => {
        this.hoverQueued = false;
        if (this.hoverEvent && !this.disposed)
          this.updateHover(this.hoverEvent);
      });
    });
    on("pointerleave", () => this.setHover(null, "", null));
    on<KeyboardEvent>("keydown", (event) => this.onKey(event));
    on("webglcontextlost", (event) => {
      event.preventDefault();
      this.cb.onLoad?.({
        state: "error",
        message:
          "De 3D-weergave is door de browser gestopt (te weinig grafisch geheugen). Sluit andere tabbladen of kies een lagere kwaliteit.",
      });
    });
    on("webglcontextrestored", () => {
      this.cb.onLoad?.({ state: "ready" });
      this.requestRender();
    });
    this.applyQuality();
  }

  private createControls(): void {
    const OrbitControls = this.OrbitControlsClass;
    const previous = this.controls;
    const target = previous?.target.clone();
    previous?.dispose();
    this.camera.up.set(0, this.zUp ? 0 : 1, this.zUp ? 1 : 0);
    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    controls.enableDamping = !this.reducedMotion;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    controls.listenToKeyEvents(this.renderer.domElement);
    controls.addEventListener("change", () => this.requestRender());
    if (target) controls.target.copy(target);
    this.controls = controls;
    this.applyDimension();
  }

  /** OrbitControls reads the camera's up vector once: recreate them when Y-up/Z-up flips. */
  private ensureControlsUp(): void {
    if ((this.camera.up.z === 1) !== this.zUp) this.createControls();
  }

  private applyDimension(): void {
    const flat = this.dimension === "2d";
    this.controls.enableRotate = !flat;
    const t = this.three.TOUCH;
    const m = this.three.MOUSE;
    this.controls.mouseButtons = {
      LEFT: flat ? m.PAN : m.ROTATE,
      MIDDLE: m.DOLLY,
      RIGHT: m.PAN,
    };
    this.controls.touches = {
      ONE: flat ? t.PAN : t.ROTATE,
      TWO: flat ? t.DOLLY_PAN : t.DOLLY_PAN,
    };
  }

  // ----- rendering -----

  requestRender(): void {
    if (this.disposed || this.rafId) return;
    this.rafId = requestAnimationFrame((time) => this.frame(time));
  }

  private frame(time: number): void {
    this.rafId = 0;
    if (this.disposed) return;
    let again = false;
    if (this.tween) {
      const t = Math.min(1, (time - this.tween.start) / this.tween.duration);
      const e = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, e);
      this.controls.target.lerpVectors(
        this.tween.fromTarget,
        this.tween.toTarget,
        e,
      );
      if (t >= 1) this.tween = null;
      else again = true;
    }
    if (this.controls.update()) again = true;
    const animating = !this.reducedMotion && time < this.animateUntil;
    if (animating) {
      this.kit.setTime(time / 1000);
      again = true;
    }
    this.draw();
    this.measureFrame(time, again);
    if (again) this.requestRender();
  }

  private draw(): void {
    // Lets tests (and curious developers) see that frames are only drawn on demand.
    this.renderer.domElement.dataset.frames = String(++this.frameCount);
    if (this.composer && this.bloomPass?.enabled) this.composer.render();
    else this.renderer.render(this.scene3, this.camera);
  }

  /** Lower the quality when consecutive frames are slow; never runs while idle. */
  private measureFrame(time: number, continuous: boolean): void {
    if (
      !continuous ||
      this.qualityPinned !== "auto" ||
      time < this.graceUntil
    ) {
      this.lastFrameAt = 0;
      this.frameTimes.length = 0;
      return;
    }
    if (this.lastFrameAt) {
      this.frameTimes.push(time - this.lastFrameAt);
      if (this.frameTimes.length >= 24) {
        const average =
          this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
        this.frameTimes.length = 0;
        if (average > 34 && this.tier > 0) {
          this.tier--;
          this.applyQuality();
          this.cb.onQuality?.(TIERS[this.tier]!);
        }
      }
    }
    this.lastFrameAt = time;
  }

  private bloomWanted(): boolean {
    return (
      this.tier >= 2 &&
      this.mode === "holographic" &&
      this.theme === "dark" &&
      !!this.composer
    );
  }

  private applyQuality(): void {
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(
      this.tier >= 2
        ? Math.min(dpr, 2)
        : this.tier === 1
          ? Math.min(dpr, 1.25)
          : 0.75,
    );
    this.resize();
    if (this.bloomPass) this.bloomPass.enabled = this.bloomWanted();
    this.ensureBloom();
    this.requestRender();
  }

  private ensureBloom(): void {
    if (
      this.tier >= 2 &&
      this.mode === "holographic" &&
      this.theme === "dark" &&
      !this.composer &&
      !this.bloomLoading &&
      !this.disposed
    ) {
      this.bloomLoading = true;
      void this.initBloom();
    }
  }

  private async initBloom(): Promise<void> {
    try {
      const [
        { EffectComposer },
        { RenderPass },
        { UnrealBloomPass },
        { OutputPass },
      ] = await Promise.all([
        import("three/examples/jsm/postprocessing/EffectComposer.js"),
        import("three/examples/jsm/postprocessing/RenderPass.js"),
        import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
        import("three/examples/jsm/postprocessing/OutputPass.js"),
      ]);
      if (this.disposed) return;
      const size = this.renderer.getSize(new this.three.Vector2());
      const composer = new EffectComposer(this.renderer);
      composer.addPass(new RenderPass(this.scene3, this.camera));
      // Restrained: a soft glow on the brightest edges only.
      const bloom = new UnrealBloomPass(
        new this.three.Vector2(size.x, size.y),
        0.32,
        0.45,
        0.2,
      );
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      composer.setSize(size.x, size.y);
      this.composer = composer;
      this.bloomPass = bloom;
      bloom.enabled = this.bloomWanted();
      this.requestRender();
    } catch {
      this.composer = null; // Without the glow the picture is simply a little plainer.
    }
  }

  resize(): void {
    if (this.disposed || !this.renderer) return;
    const { clientWidth: w, clientHeight: h } = this.options.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
  }

  // ----- scene -----

  /**
   * Show a scene. Same drawing data as before: only the view state is applied (cheap, keeps the
   * camera). Different data: the content is rebuilt; the camera is kept for the same scene id.
   */
  async setScene(
    scene: VizScene,
    options: { mode?: VizMode | null; dimension?: HoloDimension | null },
  ): Promise<void> {
    if (this.disposed) return;
    const signature = sceneSignature(scene);
    const sameScene = this.current?.id === scene.id;
    this.current = scene;
    this.mode = resolveMode(scene, options.mode ?? scene.view.mode);
    const dimension =
      scene.kind === "graph"
        ? (options.dimension ?? scene.view.dimension ?? "3d")
        : "3d";
    const dimensionChanged = dimension !== this.dimension;
    this.dimension = dimension;
    if (signature === this.signature && !dimensionChanged) {
      this.applyAll(scene.view);
      return;
    }
    this.signature = signature;
    const token = ++this.loadToken;
    const savedSelection = sameScene ? this.selectedId : null;
    if (!sameScene) {
      this.view = null;
      this.hidden.clear();
      this.highlights.clear();
    }
    this.clearContent();
    this.resetCameraOnBuild = !sameScene || dimensionChanged;
    try {
      if (scene.kind === "graph") this.buildGraph(scene);
      else if (scene.kind === "model") await this.buildModels(scene, token);
      if (token !== this.loadToken || this.disposed) return;
    } catch (error) {
      if (token !== this.loadToken) return;
      this.cb.onLoad?.({
        state: "error",
        message:
          error instanceof ModelLoadError
            ? error.message
            : "De visualisatie kon niet worden getekend.",
      });
      return;
    }
    this.applyDimension();
    this.buildHotspots(scene);
    this.cb.onParts?.(this.partList());
    this.applyAll(scene.view);
    if (savedSelection && this.items.has(savedSelection)) {
      this.selectedId = savedSelection;
      this.refreshOutlines();
    }
    if (this.resetCameraOnBuild) this.fit(true);
    this.animateUntil = performance.now() + 1500;
    this.graceUntil = performance.now() + 1200;
    this.cb.onLoad?.({ state: "ready" });
    this.requestRender();
  }

  private resetCameraOnBuild = true;

  /**
   * Apply the view state. Fields are only applied when they differ from the previous view, so a
   * live refresh does not undo what the user toggled in the viewer (layers, selection).
   */
  private applyAll(view: VizView): void {
    const prev = this.view;
    this.view = view;
    const changed = (key: keyof VizView) =>
      !prev || JSON.stringify(prev[key]) !== JSON.stringify(view[key]);
    if (changed("hiddenLayers")) this.hidden = new Set(view.hiddenLayers);
    if (changed("highlights")) this.highlights = new Set(view.highlights);
    this.applyMode();
    this.applyLayerVisibility();
    this.applyAnnotations(view);
    if (changed("rotations")) this.applyRotations(view);
    if (changed("selected") && view.selected !== undefined)
      this.selectedId = view.selected
        ? (this.resolve(view.selected)?.id ?? null)
        : null;
    this.refreshOutlines();
    this.applyCameraCommand(view);
    this.requestRender();
  }

  private clearContent(): void {
    this.setHover(null, "", null);
    this.disposeGroup(this.content);
    this.disposeGroup(this.overlay);
    this.disposeOriginals();
    for (const texture of this.labelCache.values()) texture.dispose();
    this.labelCache.clear();
    this.items.clear();
    this.byName.clear();
    this.selectables = [];
    this.partGroups.clear();
    this.annotationSprites = [];
    this.measureObjects = [];
    this.measurements = [];
    this.measurePending = null;
    this.hotspotItems = [];
    this.edgeLines = null;
    this.grid = null;
    this.selectedId = null;
    this.hiddenParts.clear();
    this.cb.onMeasure?.([]);
  }

  /** Materials (and their textures) that came with a loaded model. */
  private disposeOriginals(): void {
    for (const item of this.items.values()) {
      const list = Array.isArray(item.original)
        ? item.original
        : item.original
          ? [item.original]
          : [];
      for (const material of list) {
        for (const value of Object.values(material))
          if (value && (value as T.Texture).isTexture)
            (value as T.Texture).dispose();
        material.dispose();
      }
      item.original = undefined;
    }
  }

  private disposeGroup(group: T.Object3D): void {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((object) => {
        const holder = object as T.Mesh & T.Sprite & T.LineSegments;
        holder.geometry?.dispose?.();
        const materials = Array.isArray(holder.material)
          ? holder.material
          : holder.material
            ? [holder.material]
            : [];
        for (const material of materials) {
          for (const value of Object.values(material)) {
            if (value && (value as T.Texture).isTexture)
              (value as T.Texture).dispose();
          }
          // Shared kit materials are disposed with the kit; model materials here.
          if (!this.kitOwned(material)) material.dispose();
        }
      });
    }
  }

  private kitOwned(material: T.Material): boolean {
    return (
      (material as T.ShaderMaterial).isShaderMaterial === true ||
      material.userData?.holoShared === true
    );
  }

  // ----- graph -----

  private buildGraph(scene: VizScene): void {
    const three = this.three;
    const layout = layoutGraph(scene);
    const flat = this.dimension === "2d";
    this.zUp = false;
    this.ensureControlsUp();
    this.sceneRadius = layout.radius + 2;
    const geometries = new Map<string, T.BufferGeometry>();
    const geometryFor = (shape: string) => {
      let geometry = geometries.get(shape);
      if (!geometry) {
        geometry =
          shape === "box"
            ? new three.BoxGeometry(1.5, 1.5, 1.5)
            : shape === "cylinder"
              ? new three.CylinderGeometry(0.9, 0.9, 1.3, 20)
              : shape === "octahedron"
                ? new three.OctahedronGeometry(1)
                : shape === "icosahedron"
                  ? new three.IcosahedronGeometry(1, 1)
                  : new three.SphereGeometry(0.9, 20, 14);
        geometries.set(shape, geometry);
      }
      return geometry;
    };
    const many = (scene.nodes?.length ?? 0) > 80;
    for (const node of scene.nodes ?? []) {
      const place = layout.places.get(node.id);
      if (!place) continue;
      const size = node.size ?? 1;
      const color = statusColor(node.status, this.theme);
      const mesh = new three.Mesh(geometryFor(shapeOf(node.kind)));
      mesh.scale.setScalar(size * 0.7);
      // 2D: the layout plane is the screen (x, y). 3D: the floor plane (x, z), layers lift it (y).
      mesh.position.set(place.u, flat ? place.v : place.h, flat ? 0 : place.v);
      mesh.userData.id = node.id;
      const item: Item = {
        id: node.id,
        label: node.label,
        kind: "node",
        object: mesh,
        mesh,
        layer: node.layer,
        color,
        status: node.status,
        value: node.value,
        radius: size * 0.7,
      };
      this.content.add(mesh);
      this.items.set(node.id, item);
      this.selectables.push(mesh);
      const showLabel = !many || size >= 1.2 || node.parent === undefined;
      if (showLabel) {
        const sprite = this.labelSprite(node.label, color);
        sprite.position.set(0, 0, 0);
        sprite.userData.offset = size * 0.7 + 0.55;
        sprite.position.copy(mesh.position).y += sprite.userData.offset;
        this.content.add(sprite);
        item.labelSprite = sprite;
      }
    }
    this.rebuildEdges(scene);
  }

  private rebuildEdges(scene: VizScene): void {
    if (this.edgeLines) {
      this.content.remove(this.edgeLines);
      this.edgeLines.geometry.dispose();
      (this.edgeLines.material as T.Material).dispose();
      this.edgeLines = null;
    }
    const three = this.three;
    const positions: number[] = [];
    const colors: number[] = [];
    const color = new three.Color();
    const faint = new three.Color(
      this.theme === "dark" ? "#6b6990" : "#8f8da8",
    );
    const focus = this.selectedId;
    for (const edge of scene.edges ?? []) {
      const a = this.items.get(edge.from);
      const b = this.items.get(edge.to);
      if (!a || !b || !a.object.visible || !b.object.visible) continue;
      positions.push(
        ...a.object.position.toArray(),
        ...b.object.position.toArray(),
      );
      const strong = focus && (edge.from === focus || edge.to === focus);
      if (strong || edge.status === "critical")
        color.set(
          strong ? SELECTED[this.theme] : statusColor("critical", this.theme),
        );
      else color.copy(faint).multiplyScalar(0.55 + 0.45 * (edge.weight ?? 0.4));
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    const geometry = new three.BufferGeometry();
    geometry.setAttribute(
      "position",
      new three.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute("color", new three.Float32BufferAttribute(colors, 3));
    this.edgeLines = new three.LineSegments(
      geometry,
      new three.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
      }),
    );
    this.edgeLines.renderOrder = -1;
    this.content.add(this.edgeLines);
  }

  private labelSprite(text: string, color: string): T.Sprite {
    const key = `${text}|${color}|${this.theme}`;
    let texture = this.labelCache.get(key);
    const three = this.three;
    if (!texture) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      const font = "600 28px Sora, system-ui, sans-serif";
      ctx.font = font;
      const width = Math.min(560, Math.ceil(ctx.measureText(text).width) + 28);
      canvas.width = width;
      canvas.height = 48;
      ctx.font = font;
      ctx.fillStyle =
        this.theme === "dark" ? "rgba(5,10,20,0.72)" : "rgba(238,242,248,0.8)";
      ctx.fillRect(0, 0, width, 48);
      ctx.fillStyle = this.theme === "dark" ? "#e9e6f5" : "#06070f";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 14, 25, width - 28);
      texture = new three.CanvasTexture(canvas);
      texture.colorSpace = three.SRGBColorSpace;
      this.labelCache.set(key, texture);
    }
    const material = new three.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true,
    });
    const sprite = new three.Sprite(material);
    const image = texture.image as HTMLCanvasElement;
    sprite.scale.set((image.width / 48) * 0.5, 0.5, 1);
    sprite.renderOrder = 10;
    return sprite;
  }

  // ----- models -----

  private async buildModels(scene: VizScene, token: number): Promise<void> {
    const models = scene.models ?? [];
    this.zUp =
      models.some((m) => m.format === "stl" || m.format === "3mf") &&
      !models.some((m) => m.format === "glb" || m.format === "gltf");
    this.ensureControlsUp();
    const three = this.three;
    for (const [index, source] of models.entries()) {
      this.cb.onLoad?.({
        state: "loading",
        progress: null,
        label: `${source.label} laden (${index + 1}/${models.length})`,
      });
      const loaded = await loadModel(
        three,
        source,
        this.abort.signal,
        (progress) =>
          this.cb.onLoad?.({
            state: "loading",
            progress,
            label: `${source.label} laden (${index + 1}/${models.length})`,
          }),
      );
      if (token !== this.loadToken || this.disposed) return;
      const root = new three.Group();
      root.name = source.id;
      root.userData.layer = source.layer;
      root.add(loaded.root);
      if (source.scale) root.scale.setScalar(source.scale);
      if (this.zUp && !loaded.zUp) root.rotation.x = Math.PI / 2;
      this.content.add(root);
      this.partGroups.set(source.id, { object: root, label: source.label });
      this.indexModel(
        root,
        source.id,
        source.label,
        source.color,
        source.layer,
      );
    }
    this.sceneRadius = this.boundsRadius();
    this.addGrid();
  }

  private indexModel(
    root: T.Object3D,
    modelId: string,
    modelLabel: string,
    color: string | undefined,
    layer: string | undefined,
  ): void {
    root.updateMatrixWorld(true);
    const used = new Map<string, number>();
    const walk = (object: T.Object3D, path: string) => {
      const mesh = object as T.Mesh;
      if (mesh.isMesh) {
        const base = `${path}`;
        const count = (used.get(base) ?? 0) + 1;
        used.set(base, count);
        const id = count > 1 ? `${base}#${count}` : base;
        const original = mesh.material;
        const item: Item = {
          id,
          label: object.name || modelLabel,
          kind: "part",
          object: mesh,
          mesh,
          layer,
          color: color ?? "#b8c4d0",
          tinted: color === undefined,
          original,
          radius: 1,
        };
        mesh.userData.id = id;
        this.items.set(id, item);
        if (!this.byName.has(object.name) && object.name)
          this.byName.set(object.name, item);
        this.selectables.push(mesh);
      }
      for (const child of object.children)
        walk(child, `${path}/${child.name || child.type.toLowerCase()}`);
    };
    walk(root, modelId);
  }

  private addGrid(): void {
    const three = this.three;
    const box = new three.Box3().setFromObject(this.content);
    if (box.isEmpty()) return;
    const size = Math.max(...box.getSize(new three.Vector3()).toArray());
    const grid = new three.GridHelper(
      Math.ceil(size * 2),
      20,
      this.theme === "dark" ? "#1f4a66" : "#9db4c8",
      this.theme === "dark" ? "#12293b" : "#c8d6e4",
    );
    if (this.zUp) {
      grid.rotation.x = Math.PI / 2;
      grid.position.z = box.min.z;
    } else grid.position.y = box.min.y;
    grid.position.x = (box.min.x + box.max.x) / 2;
    if (this.zUp) grid.position.y = (box.min.y + box.max.y) / 2;
    else grid.position.z = (box.min.z + box.max.z) / 2;
    (grid.material as T.Material).transparent = true;
    (grid.material as T.Material).opacity = 0.55;
    this.overlay.add(grid);
    this.grid = grid;
  }

  private boundsRadius(): number {
    const box = new this.three.Box3().setFromObject(this.content);
    if (box.isEmpty()) return 5;
    return Math.max(
      0.001,
      box.getBoundingSphere(new this.three.Sphere()).radius,
    );
  }

  private buildHotspots(scene: VizScene): void {
    const three = this.three;
    for (const spot of scene.hotspots ?? []) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.strokeStyle = this.theme === "dark" ? "#6ddcf5" : "#0a7f9c";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(32, 32, 20, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(32, 32, 7, 0, Math.PI * 2);
      ctx.fill();
      const texture = new three.CanvasTexture(canvas);
      texture.colorSpace = three.SRGBColorSpace;
      const sprite = new three.Sprite(
        new three.SpriteMaterial({
          map: texture,
          depthTest: false,
          transparent: true,
        }),
      );
      sprite.position.set(...spot.position);
      const size = Math.max(this.sceneRadius * 0.05, 0.001);
      sprite.scale.setScalar(size);
      sprite.renderOrder = 12;
      sprite.userData.id = spot.id;
      sprite.userData.hotspot = true;
      this.overlay.add(sprite);
      this.selectables.push(sprite);
      const item: Item = {
        id: spot.id,
        label: spot.label,
        kind: "hotspot",
        object: sprite,
        color: "#6ddcf5",
        radius: size,
      };
      this.items.set(spot.id, item);
      this.hotspotItems.push(item);
    }
  }

  // ----- modes, highlights, layers -----

  setMode(mode: VizMode): void {
    if (!this.current) return;
    const next = resolveMode(this.current, mode);
    if (next === this.mode) return;
    this.mode = next;
    this.applyMode();
    this.requestRender();
  }

  setDimension(dimension: HoloDimension): void {
    if (!this.current || this.current.kind !== "graph") return;
    if (dimension === this.dimension) return;
    this.signature = ""; // force a rebuild with the other layout plane
    void this.setScene(this.current, { mode: this.mode, dimension });
  }

  private applyTheme(): void {
    const theme = resolveTheme(this.themeSetting, !!this.colorQuery?.matches);
    if (theme === this.theme) return;
    this.theme = theme;
    this.kit.theme = theme;
    this.scene3.background = new this.three.Color(BACKGROUND[theme]);
    if (this.current) {
      // Colours, labels and grid depend on the theme: rebuild the content, keep the camera.
      this.signature = "";
      void this.setScene(this.current, {
        mode: this.mode,
        dimension: this.dimension,
      });
    }
  }

  setTheme(theme: HoloTheme): void {
    this.themeSetting = theme;
    this.applyTheme();
  }

  setQuality(quality: HoloQuality): void {
    this.qualityPinned = quality;
    this.tier =
      quality === "auto" ? 2 : TIERS.indexOf(quality as (typeof TIERS)[number]);
    this.applyQuality();
    this.cb.onQuality?.(TIERS[this.tier]!);
  }

  private applyMode(): void {
    const mode = this.mode;
    for (const item of this.items.values()) {
      if (!item.mesh) continue;
      const color = this.lookColor(item, mode);
      item.mesh.material = this.kit.forMode(mode, {
        color,
        value: item.value,
        unknown: item.status === "unknown",
        off: item.status === "off",
        original: item.kind === "part" ? item.original : undefined,
      });
      this.setEdges(item, mode, color);
    }
    if (this.bloomPass) this.bloomPass.enabled = this.bloomWanted();
    this.ensureBloom();
    if (this.grid)
      this.grid.visible = mode !== "realistic" && mode !== "heatmap";
  }

  /** Models without their own colour glow in the accent colour in the see-through modes. */
  private lookColor(item: Item, mode: VizMode): string {
    return item.tinted && (mode === "holographic" || mode === "xray")
      ? this.theme === "dark"
        ? "#6ddcf5"
        : "#0a7f9c"
      : item.color;
  }

  private setEdges(item: Item, mode: VizMode, color: string): void {
    const mesh = item.mesh!;
    const material = this.kit.edges(mode, color);
    if (item.edges) {
      mesh.remove(item.edges);
      item.edges.geometry.dispose();
      item.edges = undefined;
    }
    if (!material || item.kind !== "part") return;
    if (triangles(mesh) > MAX_EDGE_TRIANGLES) return;
    const geometry = new this.three.EdgesGeometry(mesh.geometry, 28);
    const lines = new this.three.LineSegments(geometry, material);
    lines.raycast = () => undefined;
    mesh.add(lines);
    item.edges = lines;
  }

  setHighlights(ids: string[]): void {
    this.highlights = new Set(ids);
    this.refreshOutlines();
    this.requestRender();
  }

  private refreshOutlines(): void {
    for (const item of this.items.values()) {
      if (item.outline) {
        this.dropOutline(item);
      }
    }
    const make = (id: string, color: string, scale: number) => {
      const item = this.resolve(id);
      if (!item?.mesh || item.outline) return;
      const three = this.three;
      let outline: T.Object3D;
      if (item.kind === "node") {
        outline = new three.Mesh(
          item.mesh.geometry.clone(),
          new three.MeshBasicMaterial({
            color,
            side: three.BackSide,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
          }),
        );
        outline.scale.setScalar(scale);
        outline.userData.ownsMaterial = true;
      } else {
        const geometry = new three.EdgesGeometry(item.mesh.geometry, 20);
        outline = new three.LineSegments(
          geometry,
          new three.LineBasicMaterial({
            color,
            depthTest: false,
            transparent: true,
          }),
        );
        outline.renderOrder = 8;
      }
      outline.raycast = () => undefined;
      item.mesh.add(outline);
      item.outline = outline;
    };
    for (const id of this.highlights) make(id, HIGHLIGHT[this.theme], 1.35);
    if (this.selectedId) {
      const item = this.items.get(this.selectedId);
      if (item?.outline) this.dropOutline(item);
      make(this.selectedId, SELECTED[this.theme], 1.5);
    }
    if (this.current?.kind === "graph") this.rebuildEdges(this.current);
  }

  private dropOutline(item: Item): void {
    const outline = item.outline as T.Mesh | undefined;
    if (!outline) return;
    outline.parent?.remove(outline);
    outline.geometry?.dispose();
    (outline.material as T.Material | undefined)?.dispose();
    item.outline = undefined;
  }

  private resolve(id: string): Item | undefined {
    return (
      this.items.get(id) ??
      this.byName.get(id) ??
      [...this.items.values()].find((item) => item.id.endsWith(`/${id}`))
    );
  }

  setHiddenLayers(ids: string[]): void {
    this.hidden = new Set(ids);
    this.applyLayerVisibility();
    this.requestRender();
  }

  private applyLayerVisibility(): void {
    for (const item of this.items.values()) {
      const visible =
        !(item.layer && this.hidden.has(item.layer)) &&
        !this.partHidden(item.object);
      item.object.visible = visible;
      if (item.labelSprite) item.labelSprite.visible = visible;
    }
    for (const group of this.partGroups.values()) {
      const layer = group.object.userData.layer as string | undefined;
      group.object.visible = !(layer && this.hidden.has(layer));
    }
    if (this.current?.kind === "graph") this.rebuildEdges(this.current);
  }

  private partHidden(object: T.Object3D): boolean {
    for (let at: T.Object3D | null = object; at; at = at.parent)
      if (this.hiddenParts.has(at.uuid)) return true;
    return false;
  }

  /** The visible sub-parts of the models (first level below each model), for layer-like toggles. */
  private partList(): HoloPart[] {
    const parts: HoloPart[] = [];
    for (const group of this.partGroups.values()) {
      let node: T.Object3D = group.object;
      while (node.children.length === 1 && !(node.children[0] as T.Mesh).isMesh)
        node = node.children[0]!;
      const kids = node.children.length ? node.children : [];
      if (kids.length > 1)
        for (const kid of kids.slice(0, 80))
          parts.push({
            id: kid.uuid,
            label: kid.name || `${group.label} · ${kid.type}`,
            visible: !this.hiddenParts.has(kid.uuid),
          });
      else
        parts.push({
          id: group.object.uuid,
          label: group.label,
          visible: true,
        });
    }
    return parts;
  }

  setPartVisible(id: string, visible: boolean): void {
    if (visible) this.hiddenParts.delete(id);
    else this.hiddenParts.add(id);
    this.applyLayerVisibility();
    this.cb.onParts?.(this.partList());
    this.requestRender();
  }

  // ----- annotations, rotation -----

  private applyAnnotations(view: VizView): void {
    for (const sprite of this.annotationSprites) {
      this.overlay.remove(sprite);
      sprite.material.dispose();
    }
    this.annotationSprites = [];
    for (const note of view.annotations) {
      const item = this.resolve(note.objectId);
      if (!item) continue;
      const sprite = this.labelSprite(note.text, HIGHLIGHT[this.theme]);
      const box = new this.three.Box3().setFromObject(item.object);
      const center = box.getCenter(new this.three.Vector3());
      sprite.position.set(
        center.x,
        box.max.y + item.radius * 0.6 + 0.9,
        center.z,
      );
      this.overlay.add(sprite);
      this.annotationSprites.push(sprite);
    }
  }

  private applyRotations(view: VizView): void {
    for (const rotation of view.rotations) {
      const target =
        rotation.objectId === "*"
          ? this.content
          : this.resolve(rotation.objectId)?.object;
      if (target)
        target.rotation[rotation.axis] = (rotation.degrees * Math.PI) / 180;
    }
  }

  // ----- camera -----

  private applyCameraCommand(view: VizView): void {
    const command = view.camera;
    if (!command || command.seq === this.lastCameraSeq) return;
    this.lastCameraSeq = command.seq;
    if (command.focus) this.focus(command.focus, command.preset);
    else if (command.preset) this.setCamera(command.preset);
  }

  private moveCamera(
    position: T.Vector3,
    target: T.Vector3,
    instant = false,
  ): void {
    if (instant || this.reducedMotion) {
      this.tween = null;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.camera.lookAt(target);
      this.controls.update();
    } else {
      this.tween = {
        start: performance.now(),
        duration: 450,
        fromPos: this.camera.position.clone(),
        toPos: position,
        fromTarget: this.controls.target.clone(),
        toTarget: target,
      };
    }
    this.requestRender();
  }

  private cameraDistance(radius: number): number {
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = radius / Math.sin(fov / 2);
    return this.camera.aspect < 1 ? fit / this.camera.aspect : fit;
  }

  /** Corner points of every visible object (tighter than the corners of one big box). */
  private fitPoints(): T.Vector3[] {
    const three = this.three;
    const points: T.Vector3[] = [];
    const box = new three.Box3();
    const add = (target: T.Box3) => {
      for (let i = 0; i < 8; i++)
        points.push(
          new three.Vector3(
            i & 1 ? target.max.x : target.min.x,
            i & 2 ? target.max.y : target.min.y,
            i & 4 ? target.max.z : target.min.z,
          ),
        );
    };
    for (const item of this.items.values()) {
      if (!item.object.visible || item.kind === "hotspot") continue;
      add(box.setFromObject(item.object));
      if (item.labelSprite?.visible) add(box.setFromObject(item.labelSprite));
    }
    if (!points.length) add(box.setFromObject(this.content));
    return points;
  }

  /**
   * Distance along `direction` from `center` at which every point is inside the view frustum
   * (exact for the current aspect ratio).
   */
  private fitDistance(
    points: T.Vector3[],
    center: T.Vector3,
    direction: T.Vector3,
  ): number {
    const three = this.three;
    const dir = direction.clone().normalize();
    const up = new three.Vector3(0, this.zUp ? 0 : 1, this.zUp ? 1 : 0);
    const right = new three.Vector3().crossVectors(up, dir);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const cameraUp = new three.Vector3().crossVectors(dir, right).normalize();
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const tanH = tanV * this.camera.aspect;
    let distance = 0;
    const rel = new three.Vector3();
    for (const point of points) {
      rel.copy(point).sub(center);
      const depth = rel.dot(dir);
      distance = Math.max(
        distance,
        Math.abs(rel.dot(right)) / tanH + depth,
        Math.abs(rel.dot(cameraUp)) / tanV + depth,
      );
    }
    return Math.max(distance * 1.1, 0.001);
  }

  /** Camera position and target that frame everything from `direction`. */
  private framing(direction: T.Vector3): {
    position: T.Vector3;
    target: T.Vector3;
  } | null {
    const three = this.three;
    const points = this.fitPoints();
    const box = new three.Box3().setFromPoints(points);
    if (box.isEmpty()) return null;
    const center = box.getCenter(new three.Vector3());
    const dir = direction.clone().normalize();
    return {
      position: center
        .clone()
        .add(dir.clone().multiplyScalar(this.fitDistance(points, center, dir))),
      target: center,
    };
  }

  private presetDirection(preset: VizCameraPreset): T.Vector3 {
    const [x, y, z] = PRESETS[preset];
    // Presets are defined for Y-up; Z-up scenes swap the axes so "top" is still above.
    return this.zUp
      ? new this.three.Vector3(x, -z, y)
      : new this.three.Vector3(x, y, z);
  }

  /** Frame everything (or a flat 2D graph) in view. */
  fit(instant = false): void {
    const frame = this.framing(
      this.dimension === "2d"
        ? new this.three.Vector3(0, 0, 1)
        : this.presetDirection("iso"),
    );
    if (frame) this.moveCamera(frame.position, frame.target, instant);
  }

  setCamera(preset: VizCameraPreset): void {
    const frame = this.framing(
      this.dimension === "2d"
        ? new this.three.Vector3(0, 0, 1)
        : this.presetDirection(preset),
    );
    if (frame) this.moveCamera(frame.position, frame.target);
  }

  focus(id: string, preset?: VizCameraPreset): void {
    const item = this.resolve(id);
    if (!item) return;
    const box = new this.three.Box3().setFromObject(item.object);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new this.three.Sphere());
    const radius = Math.max(sphere.radius, this.sceneRadius * 0.08);
    const current = this.camera.position.clone().sub(this.controls.target);
    const direction = preset
      ? this.presetDirection(preset).normalize()
      : this.dimension === "2d"
        ? new this.three.Vector3(0, 0, 1)
        : current.lengthSq() > 0
          ? current.normalize()
          : this.presetDirection("iso").normalize();
    this.moveCamera(
      sphere.center
        .clone()
        .add(direction.multiplyScalar(this.cameraDistance(radius) * 1.4)),
      sphere.center.clone(),
    );
  }

  // ----- selection, picking, measuring -----

  private pick(event: PointerEvent): { item: Item; point: T.Vector3 } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new this.three.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new this.three.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const hits = raycaster.intersectObjects(
      this.selectables.filter((object) => object.visible),
      false,
    );
    for (const hit of hits) {
      const id = hit.object.userData.id as string | undefined;
      const item = id ? this.items.get(id) : undefined;
      if (item) return { item, point: hit.point };
    }
    return null;
  }

  private onPointerUp(event: PointerEvent): void {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || event.button !== 0) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    if (event.timeStamp - down.t > 600) return;
    const hit = this.pick(event);
    if (this.measuring) {
      if (hit && hit.item.kind !== "hotspot") this.addMeasurePoint(hit.point);
      return;
    }
    if (hit?.item.kind === "hotspot") this.cb.onHotspot?.(hit.item.id);
    this.select(hit?.item.id ?? null, true);
  }

  select(id: string | null, notify = true): void {
    const item = id ? this.resolve(id) : undefined;
    this.selectedId = item ? item.id : null;
    this.refreshOutlines();
    if (notify)
      this.cb.onSelect?.(this.selectedId, item ? this.infoOf(item) : null);
    this.requestRender();
  }

  private infoOf(item: Item): HoloSelectionInfo {
    const info: HoloSelectionInfo = {
      id: item.id,
      label: item.label,
      kind: item.kind,
    };
    if (item.mesh && item.kind === "part") {
      const size = new this.three.Box3()
        .setFromObject(item.mesh)
        .getSize(new this.three.Vector3());
      info.size = [size.x, size.y, size.z];
      info.triangles = triangles(item.mesh);
    }
    return info;
  }

  private updateHover(event: PointerEvent): void {
    const hit = this.pick(event);
    const rect = this.options.container.getBoundingClientRect();
    this.setHover(
      hit?.item.id ?? null,
      hit?.item.label ?? "",
      hit
        ? { x: event.clientX - rect.left, y: event.clientY - rect.top }
        : null,
    );
  }

  private setHover(
    id: string | null,
    label: string,
    position: { x: number; y: number } | null,
  ): void {
    if (this.renderer)
      this.renderer.domElement.style.cursor = id
        ? "pointer"
        : this.measuring
          ? "crosshair"
          : "";
    if (id === this.lastHover && !position) return;
    this.lastHover = id;
    this.cb.onHover?.(id, label, position);
  }

  /** Cycle the selection through the visible objects with the keyboard. */
  private cycle(step: 1 | -1): void {
    const list = [...this.items.values()].filter(
      (item) => item.object.visible && item.kind !== "hotspot",
    );
    if (!list.length) return;
    const at = list.findIndex((item) => item.id === this.selectedId);
    const next = list[(at + step + list.length) % list.length]!;
    this.select(next.id, true);
    this.focus(next.id);
  }

  private onKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case "]":
      case "n":
        this.cycle(1);
        break;
      case "[":
      case "p":
        this.cycle(-1);
        break;
      case "Escape":
        if (this.selectedId) this.select(null, true);
        else return;
        break;
      case "Home":
      case "0":
        this.fit();
        break;
      case "+":
      case "=":
      case "-":
      case "_": {
        const zoomIn = event.key === "+" || event.key === "=";
        const offset = this.camera.position.clone().sub(this.controls.target);
        offset.multiplyScalar(zoomIn ? 0.8 : 1.25);
        this.moveCamera(
          this.controls.target.clone().add(offset),
          this.controls.target.clone(),
          true,
        );
        break;
      }
      default:
        return;
    }
    // Handled here: keep the page's "type anywhere to focus the composer" from taking the key.
    event.stopPropagation();
    event.preventDefault();
  }

  setMeasuring(on: boolean): void {
    this.measuring = on;
    this.measurePending = null;
    if (this.renderer)
      this.renderer.domElement.style.cursor = on ? "crosshair" : "";
  }

  private addMeasurePoint(point: T.Vector3): void {
    const three = this.three;
    const marker = new three.Mesh(
      new three.SphereGeometry(Math.max(this.sceneRadius / 90, 0.0005), 12, 8),
      new three.MeshBasicMaterial({
        color: HIGHLIGHT[this.theme],
        depthTest: false,
      }),
    );
    marker.position.copy(point);
    marker.renderOrder = 11;
    this.overlay.add(marker);
    this.measureObjects.push(marker);
    const here: Vec3 = [point.x, point.y, point.z];
    if (!this.measurePending) {
      this.measurePending = here;
    } else {
      const from = this.measurePending;
      this.measurePending = null;
      const units = this.current?.units ?? "";
      const value = distance(from, here);
      const line = new three.Line(
        new three.BufferGeometry().setFromPoints([
          new three.Vector3(...from),
          point.clone(),
        ]),
        new three.LineBasicMaterial({
          color: HIGHLIGHT[this.theme],
          depthTest: false,
        }),
      );
      line.renderOrder = 11;
      this.overlay.add(line);
      this.measureObjects.push(line);
      const sprite = this.labelSprite(
        formatDistance(value, units),
        HIGHLIGHT[this.theme],
      );
      sprite.scale.multiplyScalar(
        (Math.max(this.sceneRadius / 12, 0.001) / 0.5) * 0.5,
      );
      sprite.position.set(
        (from[0] + here[0]) / 2,
        (from[1] + here[1]) / 2,
        (from[2] + here[2]) / 2,
      );
      this.overlay.add(sprite);
      this.measureObjects.push(sprite);
      this.measurements.push({
        id: `m${this.measurements.length + 1}`,
        from,
        to: here,
        distance: value,
        units,
      });
      this.cb.onMeasure?.([...this.measurements]);
    }
    this.requestRender();
  }

  clearMeasurements(): void {
    for (const object of this.measureObjects) {
      this.overlay.remove(object);
      const holder = object as T.Mesh;
      holder.geometry?.dispose?.();
      (holder.material as T.Material | undefined)?.dispose?.();
    }
    this.measureObjects = [];
    this.measurements = [];
    this.measurePending = null;
    this.cb.onMeasure?.([]);
    this.requestRender();
  }

  // ----- misc -----

  rotateObject(id: string, axis: "x" | "y" | "z", degrees: number): void {
    const target = id === "*" ? this.content : this.resolve(id)?.object;
    if (!target) return;
    target.rotation[axis] = (degrees * Math.PI) / 180;
    this.requestRender();
  }

  /** PNG of the current picture. */
  screenshot(): Promise<Blob | null> {
    this.draw();
    return new Promise((resolve) =>
      this.renderer.domElement.toBlob(resolve, "image/png"),
    );
  }

  stats(): {
    objects: number;
    tier: "high" | "medium" | "low";
    mode: VizMode;
    frames: number;
  } {
    return {
      objects: this.items.size,
      tier: TIERS[this.tier]!,
      mode: this.mode,
      frames: this.rafId ? 1 : 0,
    };
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** True while a frame is queued: the engine promises this is false when nothing changes. */
  get rendering(): boolean {
    return this.rafId !== 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.loadToken++;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.resizeObserver?.disconnect();
    for (const undo of this.cleanup.splice(0)) undo();
    if (this.content) {
      this.disposeGroup(this.content);
      this.disposeGroup(this.overlay);
    }
    this.disposeOriginals();
    for (const texture of this.labelCache.values()) texture.dispose();
    this.labelCache.clear();
    this.kit?.dispose();
    this.controls?.dispose();
    this.composer?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
    }
    this.items.clear();
    this.selectables = [];
  }
}
