import * as THREE from "three";

/** Transparent holographic projection behind the face, sharing its light and timing. */
export function createPortraitBackdrop(
  time: { value: number },
  color: { value: THREE.Color },
  level: { value: number },
) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { time, color, level },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float time, level;
      uniform vec3 color;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x), f.y);
      }
      void main() {
        vec2 p = vUv - vec2(0.5, 0.54);
        vec2 ellipse = p * vec2(1.28, 0.98);
        float radius = length(ellipse);
        float angle = atan(ellipse.y, ellipse.x);
        float aa = max(fwidth(radius), 0.001);
        float turbulence = noise(p * 13.0 + vec2(time * 0.035, -time * 0.025));
        turbulence += noise(p * 31.0 - vec2(time * 0.012, 0.0)) * 0.35;
        float corona = exp(-pow((radius - 0.29) / 0.065, 2.0));
        float wisps = pow(max(0.0, turbulence - 0.24), 2.0) * corona;
        float orbit = 1.0 - smoothstep(0.0006, 0.0006 + aa, abs(radius - 0.345));
        float arcs = pow(max(0.0, sin(angle * 3.0 + time * 0.06)), 12.0);
        vec2 cell = floor(p * 110.0);
        vec2 random = vec2(hash(cell), hash(cell + 43.7));
        vec2 location = (cell + random) / 110.0;
        float star = exp(-dot(p - location, p - location) / 0.0000018);
        float spark = step(0.95, hash(cell + 13.0)) * star;
        spark *= 0.6 + 0.4 * sin(time * 0.4 + random.x * 20.0);
        float halo = exp(-dot(ellipse, ellipse) * 18.0) * 0.016;
        float intensity = wisps * 0.14 + orbit * arcs * 0.09 + spark * corona * 0.75 + halo;
        float edge = 1.0 - smoothstep(0.36, 0.49, radius);
        gl_FragColor = vec4(color, intensity * edge * (0.85 + level * 0.25));
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.52), material);
  return {
    mesh,
    dispose() {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
