import type * as T from "three";
import type * as ThreeModule from "three";
import { heatColor } from "./colors.ts";
import type { VizMode } from "./types.ts";

type Three = typeof ThreeModule;

export interface Look {
  /** Base colour (#rrggbb): the status colour of a node or the model colour. */
  color: string;
  /** 0..1 for the heat map; null/undefined = no data. */
  value?: number | null;
  /** Status "unknown": drawn as an outline so it never looks healthy. */
  unknown?: boolean;
  /** Status "off": dimmed. */
  off?: boolean;
  /** The material the model came with (realistic mode). */
  original?: T.Material | T.Material[];
}

const VERTEX = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// Fresnel rim + fixed scan lines. The lines are a static pattern in world space; uTime only
// moves them while the engine is already rendering (intro and interaction), never on its own.
const FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uBase;
  uniform float uRim;
  uniform float uScan;
  uniform float uDim;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vWorld;
  void main() {
    // Clamped: pow() of a tiny negative number is NaN, and one NaN pixel blacks out the bloom pass.
    float f = clamp(1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir))), 0.0, 1.0);
    float rim = pow(f, 2.2);
    float scan = 0.5 + 0.5 * sin(vWorld.y * 38.0 + uTime * 2.0);
    float alpha = (uBase + uRim * rim) * (1.0 - uScan + uScan * (0.55 + 0.45 * scan)) * uDim;
    gl_FragColor = vec4(uColor * (0.7 + 0.8 * rim), clamp(alpha, 0.0, 0.9));
  }
`;

/** Creates and caches the materials of every mode; one kit per engine, disposed with it. */
export class MaterialKit {
  private cache = new Map<string, T.Material>();
  private shaders: T.ShaderMaterial[] = [];
  private edge = new Map<string, T.LineBasicMaterial>();
  theme: "dark" | "light" = "dark";

  constructor(private readonly three: Three) {}

  setTime(time: number): void {
    for (const shader of this.shaders) shader.uniforms.uTime!.value = time;
  }

  private holo(
    color: string,
    base: number,
    rim: number,
    dim: number,
    xray: boolean,
  ) {
    const key = `h:${color}:${base}:${rim}:${dim}:${this.theme}:${xray}`;
    let material = this.cache.get(key);
    if (!material) {
      const shader = new this.three.ShaderMaterial({
        uniforms: {
          uColor: { value: new this.three.Color(color) },
          uTime: { value: 0 },
          uBase: { value: base },
          uRim: { value: rim },
          uScan: { value: xray ? 0 : 0.55 },
          uDim: { value: dim },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: this.three.DoubleSide,
        blending:
          this.theme === "dark"
            ? this.three.AdditiveBlending
            : this.three.NormalBlending,
      });
      this.shaders.push(shader);
      shader.userData.holoShared = true;
      material = shader;
      this.cache.set(key, material);
    }
    return material;
  }

  private basic(key: string, make: () => T.Material): T.Material {
    let material = this.cache.get(key);
    if (!material) {
      material = make();
      material.userData.holoShared = true;
      this.cache.set(key, material);
    }
    return material;
  }

  forMode(mode: VizMode, look: Look): T.Material | T.Material[] {
    const three = this.three;
    const dim = look.off ? 0.35 : 1;
    if (look.unknown && mode !== "wireframe")
      // Unknown is always an outline, in every mode.
      return this.basic(
        `unknown:${look.color}`,
        () =>
          new three.MeshBasicMaterial({
            color: look.color,
            wireframe: true,
            transparent: true,
            opacity: 0.7,
          }),
      );
    switch (mode) {
      case "holographic":
        return this.holo(look.color, 0.14, 0.65, dim, false);
      case "xray":
        return this.holo(look.color, 0.03, 0.8, dim, true);
      case "wireframe":
        return this.basic(
          `wire:${look.color}:${dim}`,
          () =>
            new three.MeshBasicMaterial({
              color: look.color,
              wireframe: true,
              transparent: dim < 1,
              opacity: dim,
            }),
        );
      case "technical":
        return this.basic(
          `tech:${this.theme}`,
          () =>
            new three.MeshBasicMaterial({
              color: this.theme === "dark" ? "#16284a" : "#dde6f3",
              polygonOffset: true,
              polygonOffsetFactor: 1,
              polygonOffsetUnits: 1,
            }),
        );
      case "heatmap": {
        const color = heatColor(look.value, this.theme);
        return this.basic(
          `heat:${color}:${dim}`,
          () =>
            new three.MeshStandardMaterial({
              color,
              roughness: 0.55,
              metalness: 0.05,
              transparent: dim < 1,
              opacity: dim,
            }),
        );
      }
      default:
        if (look.original) return look.original;
        return this.basic(
          `real:${look.color}:${dim}`,
          () =>
            new three.MeshStandardMaterial({
              color: look.color,
              roughness: 0.5,
              metalness: 0.15,
              transparent: dim < 1,
              opacity: dim,
            }),
        );
    }
  }

  /** Material of the edge/outline overlay for a mode, or null when the mode has none. */
  edges(mode: VizMode, color: string): T.LineBasicMaterial | null {
    if (mode === "wireframe" || mode === "realistic" || mode === "heatmap")
      return null;
    const key = `${mode}:${color}:${this.theme}`;
    let material = this.edge.get(key);
    if (!material) {
      material = new this.three.LineBasicMaterial({
        color:
          mode === "technical"
            ? this.theme === "dark"
              ? "#e9e6f5"
              : "#0d2447"
            : color,
        transparent: true,
        opacity: mode === "technical" ? 0.95 : 0.8,
        depthWrite: false,
      });
      material.userData.holoShared = true;
      this.edge.set(key, material);
    }
    return material;
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    for (const material of this.edge.values()) material.dispose();
    this.cache.clear();
    this.edge.clear();
    this.shaders = [];
  }
}
