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
      void main() {
        vec2 p = vUv - 0.5;
        float radius = length(p);
        float angle = atan(p.y, p.x);
        float aa = max(fwidth(radius), 0.001);
        float inner = 1.0 - smoothstep(0.001, 0.001 + aa, abs(radius - 0.35));
        float outer = 1.0 - smoothstep(0.0006, 0.0006 + aa, abs(radius - 0.43));
        float arc = smoothstep(-0.1, 0.25, sin(angle * 2.0 + time * 0.08));
        float lane = floor((angle + 3.141593) * 9.0);
        float laneAngle = (lane + 0.5) / 9.0 - 3.141593;
        float rayDistance = abs(sin(angle - laneAngle)) * radius;
        float ray = 1.0 - smoothstep(0.0004, 0.0004 + aa, rayDistance);
        float start = 0.30 + 0.035 * sin(lane * 7.3);
        float trace = smoothstep(start, start + 0.01, radius) * (1.0 - smoothstep(0.44, 0.46, radius));
        float pulseRadius = start + mod(time * 0.012 + lane * 0.037, 0.14);
        float pulse = exp(-pow((radius - pulseRadius) / 0.012, 2.0));
        vec2 cell = fract(p * 28.0) - 0.5;
        float dots = 1.0 - smoothstep(0.03, 0.07, length(cell));
        float field = exp(-radius * radius * 13.0);
        float edge = 1.0 - smoothstep(0.43, 0.5, radius);
        float intensity = inner * arc * 0.18 + outer * (1.0 - arc) * 0.11;
        intensity += ray * trace * (0.025 + pulse * 0.22);
        intensity += exp(-pow(rayDistance / 0.0025, 2.0) - pow((radius - start) / 0.0025, 2.0)) * 0.4;
        intensity += dots * field * 0.12;
        intensity += field * 0.018;
        gl_FragColor = vec4(color, intensity * edge * (0.8 + level * 0.2));
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.43, 0.43), material);
  return {
    mesh,
    dispose() {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
