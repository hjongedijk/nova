import * as THREE from "three";
import { toneColor } from "./card/colors.ts";
import type {
  CardLayout,
  CardShape,
  CardLine,
  ShapeStyle,
  Tone,
} from "./card/types.ts";

/*
 * The lazy 3D renderer of the holographic cards. It takes the SAME layout the flat SVG draws and
 * extrudes it into a shallow, translucent hologram: faces fade, edges glow. Text stays HTML/SVG
 * (crisp): this module only reports where each label lands on screen.
 *
 * Cost model: no idle loop. A frame is drawn on a change (tilt, hover, size, data) and during
 * the one-second turn-on animation, only while the card is visible.
 */

export interface Card3DOptions {
  host: HTMLElement;
  theme: "dark" | "light";
  /** No turn-on animation and no automatic motion; the picture is drawn once, in its resting pose. */
  reducedMotion: boolean;
  /** Screen positions (px, relative to the host) of the anchors, in the order they were given. */
  onproject(positions: Float32Array): void;
  onhover(id: string | null, x: number, y: number): void;
  onlost(): void;
}

export interface Anchor {
  x: number;
  y: number;
  z: number;
}

const FOV = 30;
const REST_YAW = -0.13;
const REST_PITCH = 0.13;
const INTRO_MS = 1000;
const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

type Mat = THREE.Material;

export class Card3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 1, 5000);
  private readonly pivot = new THREE.Group();
  private readonly content = new THREE.Group();
  private readonly materials = new Map<string, Mat>();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly pickable: THREE.Mesh[] = [];
  private readonly animated: {
    object: THREE.Object3D;
    appear: number;
    axis: "y" | "z";
  }[] = [];
  private scan: THREE.Mesh | null = null;
  private anchors: Anchor[] = [];
  private layout: CardLayout | null = null;
  private theme: "dark" | "light";
  private width = 1;
  private height = 1;
  private yaw = REST_YAW;
  private pitch = REST_PITCH;
  private visible = true;
  private raf = 0;
  private introStart = -1;
  private introElapsed = INTRO_MS;
  private lastTick = 0;
  private frames = 0;
  private disposed = false;
  private drag: { x: number; y: number; yaw: number; pitch: number } | null =
    null;
  private hoverAt: { x: number; y: number } | null = null;
  private hoverQueued = false;
  private hoverId: string | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly options: Card3DOptions) {
    this.theme = options.theme;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    const canvas = this.renderer.domElement;
    canvas.dataset.frames = "0";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:pan-y;cursor:grab";
    options.host.append(canvas);
    this.pivot.add(this.content);
    this.scene.add(this.pivot);

    const on = <E extends Event>(type: string, handler: (event: E) => void) => {
      canvas.addEventListener(type, handler as EventListener);
      this.cleanup.push(() =>
        canvas.removeEventListener(type, handler as EventListener),
      );
    };
    on<PointerEvent>("pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      this.drag = {
        x: event.clientX,
        y: event.clientY,
        yaw: this.yaw,
        pitch: this.pitch,
      };
      canvas.setPointerCapture?.(event.pointerId);
      canvas.style.cursor = "grabbing";
    });
    on<PointerEvent>("pointermove", (event) => {
      if (this.drag) {
        this.yaw = clamp(
          this.drag.yaw + (event.clientX - this.drag.x) * 0.006,
          -0.75,
          0.75,
        );
        this.pitch = clamp(
          this.drag.pitch + (event.clientY - this.drag.y) * 0.005,
          -0.05,
          0.6,
        );
        this.requestRender();
        return;
      }
      const box = canvas.getBoundingClientRect();
      this.hoverAt = {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      };
      if (this.hoverQueued) return;
      this.hoverQueued = true;
      requestAnimationFrame(() => {
        this.hoverQueued = false;
        if (!this.disposed) this.updateHover();
      });
    });
    const end = (event: PointerEvent) => {
      if (!this.drag) return;
      this.drag = null;
      canvas.releasePointerCapture?.(event.pointerId);
      canvas.style.cursor = "grab";
    };
    on<PointerEvent>("pointerup", end);
    on<PointerEvent>("pointercancel", end);
    on("pointerleave", () => {
      this.hoverAt = null;
      this.setHover(null, 0, 0);
    });
    on("dblclick", () => this.resetTilt());
    on("webglcontextlost", (event) => {
      event.preventDefault();
      options.onlost();
    });
  }

  get frameCount(): number {
    return this.frames;
  }

  resetTilt(): void {
    this.yaw = REST_YAW;
    this.pitch = REST_PITCH;
    this.requestRender();
  }

  /** Build (or rebuild) the hologram for a layout. `animate` plays the turn-on. */
  setLayout(layout: CardLayout, anchors: Anchor[], animate: boolean): void {
    if (this.disposed) return;
    this.layout = layout;
    this.anchors = anchors;
    this.clearContent();
    this.build(layout);
    this.fitCamera();
    const play = animate && !this.options.reducedMotion;
    this.introStart = -1;
    this.introElapsed = play ? 0 : INTRO_MS;
    if (!play) {
      this.yaw = this.drag ? this.yaw : REST_YAW;
      this.pitch = this.drag ? this.pitch : REST_PITCH;
    }
    this.requestRender();
  }

  setTheme(theme: "dark" | "light"): void {
    if (theme === this.theme || !this.layout) return;
    this.theme = theme;
    this.setLayout(this.layout, this.anchors, false);
  }

  resize(width: number, height: number): void {
    if (this.disposed || width < 1 || height < 1) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.fitCamera();
    this.requestRender();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.lastTick = 0;
    } else this.requestRender();
  }

  private fitCamera(): void {
    const layout = this.layout;
    if (!layout) return;
    const dist = (this.height / 2 / Math.tan((FOV * Math.PI) / 360)) * 1.1;
    const depth = layout.depth;
    this.camera.aspect = this.width / this.height;
    this.camera.position.set(0, 0, dist + depth / 2);
    this.camera.near = 10;
    this.camera.far = dist * 4 + 1000;
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.content.position.set(-layout.width / 2, layout.height / 2, -depth / 2);
  }

  private material(
    tone: Tone,
    style: ShapeStyle,
    face: string,
    opacity: number,
  ): Mat {
    const key = `${tone}|${style}|${face}|${this.theme}`;
    let material = this.materials.get(key);
    if (!material) {
      const scale = style === "ghost" ? 0.4 : style === "dashed" ? 0 : 1;
      material = new THREE.MeshBasicMaterial({
        color: toneColor(tone, this.theme),
        transparent: true,
        opacity: opacity * scale * (this.theme === "light" ? 1.5 : 1),
        depthWrite: false,
        side: THREE.DoubleSide,
        visible: scale > 0,
      });
      this.materials.set(key, material);
    }
    return material;
  }

  private edgeMaterial(tone: Tone, style: ShapeStyle, strong = 0.95): Mat {
    const key = `edge|${tone}|${style}|${strong}|${this.theme}`;
    let material = this.materials.get(key);
    if (!material) {
      const color = toneColor(tone, this.theme);
      material =
        style === "dashed"
          ? new THREE.LineDashedMaterial({
              color,
              dashSize: 4,
              gapSize: 3,
              transparent: true,
              opacity: strong,
            })
          : new THREE.LineBasicMaterial({
              color,
              transparent: true,
              opacity: style === "ghost" ? strong * 0.55 : strong,
            });
      this.materials.set(key, material);
    }
    return material;
  }

  private addEdges(
    geometry: THREE.BufferGeometry,
    mesh: THREE.Mesh,
    shape: CardShape,
  ): void {
    const edges = new THREE.EdgesGeometry(geometry, 28);
    this.geometries.push(edges);
    const lines = new THREE.LineSegments(
      edges,
      this.edgeMaterial(shape.tone, shape.style),
    );
    if (shape.style === "dashed") lines.computeLineDistances();
    mesh.add(lines);
  }

  private build(layout: CardLayout): void {
    // Back plate: the faint "glass" the hologram stands in front of.
    const plate = new THREE.PlaneGeometry(layout.width, layout.height);
    plate.translate(layout.width / 2, -layout.height / 2, -18);
    this.geometries.push(plate);
    const plateMesh = new THREE.Mesh(
      plate,
      this.material(
        "accent",
        "solid",
        "plate",
        this.theme === "light" ? 0.03 : 0.045,
      ),
    );
    this.content.add(plateMesh);
    const frame = new THREE.EdgesGeometry(plate);
    this.geometries.push(frame);
    this.content.add(
      new THREE.LineSegments(frame, this.edgeMaterial("accent", "ghost", 0.5)),
    );

    for (const line of layout.lines) this.addLine(line);
    for (const shape of layout.shapes) this.addShape(shape);

    if (!this.options.reducedMotion) {
      const geometry = new THREE.PlaneGeometry(layout.width, 3);
      this.geometries.push(geometry);
      this.scan = new THREE.Mesh(
        geometry,
        this.material("accent", "solid", "scan", 0.7),
      );
      this.scan.position.set(layout.width / 2, 0, 30);
      this.scan.visible = false;
      this.content.add(this.scan);
    }
  }

  private addShape(shape: CardShape): void {
    let geometry: THREE.BufferGeometry;
    let mesh: THREE.Mesh;
    if (shape.type === "box") {
      geometry = new THREE.BoxGeometry(shape.w, shape.h, shape.d);
      geometry.translate(shape.w / 2, shape.h / 2, shape.d / 2);
      const o = (face: string, value: number) =>
        this.material(shape.tone, shape.style, face, value);
      mesh = new THREE.Mesh(geometry, [
        o("side", 0.2),
        o("side", 0.2),
        o("top", 0.55),
        o("bottom", 0.1),
        o("front", 0.32),
        o("back", 0.12),
      ]);
      mesh.position.set(shape.x, -(shape.y + shape.h), shape.z);
      this.animated.push({ object: mesh, appear: shape.appear, axis: "y" });
    } else {
      const outline = new THREE.Shape();
      let origin = 0;
      if (shape.type === "arc") {
        const steps = Math.max(
          8,
          Math.ceil(Math.abs(shape.a1 - shape.a0) / 0.06),
        );
        const outer: [number, number][] = [];
        const inner: [number, number][] = [];
        for (let i = 0; i <= steps; i++) {
          const a = shape.a0 + ((shape.a1 - shape.a0) * i) / steps;
          outer.push([
            shape.cx + Math.cos(a) * shape.r1,
            -(shape.cy + Math.sin(a) * shape.r1),
          ]);
          inner.push([
            shape.cx + Math.cos(a) * shape.r0,
            -(shape.cy + Math.sin(a) * shape.r0),
          ]);
        }
        outline.moveTo(...outer[0]!);
        for (const point of outer.slice(1)) outline.lineTo(...point);
        for (const point of inner.reverse()) outline.lineTo(...point);
        outline.closePath();
      } else {
        origin = -shape.baseY;
        outline.moveTo(shape.pts[0]![0], 0);
        for (const [x, y] of shape.pts) outline.lineTo(x, -y - origin);
        outline.lineTo(shape.pts[shape.pts.length - 1]![0], 0);
        outline.closePath();
      }
      geometry = new THREE.ExtrudeGeometry(outline, {
        depth: shape.d,
        bevelEnabled: false,
        curveSegments: 1,
      });
      mesh = new THREE.Mesh(geometry, [
        this.material(shape.tone, shape.style, "cap", 0.42),
        this.material(shape.tone, shape.style, "wall", 0.22),
      ]);
      mesh.position.set(0, origin, shape.z);
      this.animated.push({
        object: mesh,
        appear: shape.appear,
        axis: shape.type === "area" ? "y" : "z",
      });
    }
    this.geometries.push(geometry);
    this.addEdges(geometry, mesh, shape);
    mesh.userData.id = shape.id;
    mesh.userData.tip = shape.tip;
    this.content.add(mesh);
    if (shape.style !== "dashed" || shape.type === "box")
      this.pickable.push(mesh);
  }

  private addLine(line: CardLine): void {
    const points = line.pts.map(([x, y]) => new THREE.Vector3(x, -y, line.z));
    if (points.length < 2) return;
    if (line.kind === "curve" && !line.dashed) {
      const curve = new THREE.CatmullRomCurve3(
        points,
        false,
        "catmullrom",
        0.2,
      );
      const core = new THREE.TubeGeometry(
        curve,
        Math.min(400, points.length * 2),
        1.5,
        5,
        false,
      );
      const halo = new THREE.TubeGeometry(
        curve,
        Math.min(400, points.length * 2),
        4.5,
        5,
        false,
      );
      this.geometries.push(core, halo);
      this.content.add(
        new THREE.Mesh(
          core,
          new THREE.MeshBasicMaterial({
            color: toneColor(line.tone, this.theme),
          }),
        ),
        new THREE.Mesh(halo, this.material(line.tone, "solid", "halo", 0.16)),
      );
      return;
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    this.geometries.push(geometry);
    const strong =
      line.kind === "grid" ? 0.2 : line.kind === "axis" ? 0.6 : 0.95;
    const object = new THREE.Line(
      geometry,
      this.edgeMaterial(line.tone, line.dashed ? "dashed" : "solid", strong),
    );
    if (line.dashed) object.computeLineDistances();
    this.content.add(object);
  }

  private clearContent(): void {
    this.content.clear();
    for (const geometry of this.geometries.splice(0)) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.pickable.length = 0;
    this.animated.length = 0;
    this.scan = null;
  }

  requestRender(): void {
    if (this.disposed || !this.visible || this.raf) return;
    this.raf = requestAnimationFrame((time) => this.tick(time));
  }

  private tick(time: number): void {
    this.raf = 0;
    if (this.disposed || !this.visible) return;
    const dt = this.lastTick ? Math.min(250, time - this.lastTick) : 16;
    this.lastTick = time;
    const intro = this.introElapsed < INTRO_MS;
    if (intro) this.introElapsed = Math.min(INTRO_MS, this.introElapsed + dt);
    this.apply(intro ? this.introElapsed / INTRO_MS : 1);
    this.render();
    if (this.introElapsed < INTRO_MS) this.requestRender();
    else this.lastTick = 0;
  }

  private apply(progress: number): void {
    const turn = ease(progress * 1.6);
    this.pivot.rotation.set(this.pitch * turn, this.yaw * turn, 0, "YXZ");
    for (const item of this.animated) {
      const p =
        progress >= 1 ? 1 : ease((progress * 1.5 - item.appear * 0.6) / 0.5);
      const value = Math.max(0.001, p);
      if (item.axis === "y") item.object.scale.y = value;
      else item.object.scale.z = value;
    }
    if (this.scan && this.layout) {
      this.scan.visible = progress < 1;
      this.scan.position.y = -this.layout.height * Math.min(1, progress * 1.25);
    }
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
    this.canvasFrame();
    this.project();
  }

  private canvasFrame(): void {
    this.frames++;
    this.renderer.domElement.dataset.frames = String(this.frames);
  }

  private project(): void {
    if (!this.anchors.length) return;
    this.scene.updateMatrixWorld(true);
    const out = new Float32Array(this.anchors.length * 2);
    const vector = new THREE.Vector3();
    this.anchors.forEach((anchor, i) => {
      vector.set(anchor.x, -anchor.y, anchor.z);
      this.content.localToWorld(vector);
      vector.project(this.camera);
      out[i * 2] = ((vector.x + 1) / 2) * this.width;
      out[i * 2 + 1] = ((1 - vector.y) / 2) * this.height;
    });
    this.options.onproject(out);
  }

  private updateHover(): void {
    if (!this.hoverAt || !this.visible) return;
    const { x, y } = this.hoverAt;
    this.raycaster.setFromCamera(
      new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1),
      this.camera,
    );
    this.scene.updateMatrixWorld(true);
    const hit = this.raycaster.intersectObjects(this.pickable, false)[0];
    this.setHover(
      (hit?.object.userData.id as string | undefined) ?? null,
      x,
      y,
    );
  }

  private setHover(id: string | null, x: number, y: number): void {
    if (id === this.hoverId && id === null) return;
    this.hoverId = id;
    this.options.onhover(id, x, y);
    this.renderer.domElement.style.cursor = id
      ? "pointer"
      : this.drag
        ? "grabbing"
        : "grab";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const undo of this.cleanup.splice(0)) undo();
    this.clearContent();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
