import * as THREE from "three";

/** Viewport-wide filaments extend beyond the artwork and dissolve into the page. */
export function createProjectionBackdrop(
  time: { value: number },
  voice: { value: number },
  panoramic = false,
) {
  const aspect = { value: 1 };
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: { time, voice, aspect, panoramic: { value: panoramic ? 1 : 0 } },
    vertexShader: `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform float time, voice, aspect, panoramic;
      void main() {
        vec2 p = (vUv - 0.5) * vec2(aspect * 1.1, 1.1);
        float wave = sin(p.x * 6.0 - time * 0.16) * 0.032 + sin(p.x * 15.0 + time * 0.12) * 0.012;
        vec2 grid = vec2(p.x * 42.0, (p.y - wave) * 65.0);
        vec3 cell = vec3(grid, grid.x + grid.y);
        vec3 aa = max(fwidth(cell), vec3(0.001));
        vec3 edge = 1.0 - smoothstep(vec3(0.0), aa * 0.35, abs(fract(cell) - 0.5));
        float lines = max(edge.x, max(edge.y, edge.z));
        vec2 point = (fract(grid) - 0.5) / clamp(fwidth(grid), vec2(0.04), vec2(0.22));
        float nodes = exp(-dot(point, point) * 2.0);
        float band = exp(-pow((p.y + 0.13 - wave) / 0.105, 4.0));
        float sides = smoothstep(0.16, 0.38, abs(p.x));
        float fade = 1.0 - smoothstep(0.72, 1.0, abs(vUv.x * 2.0 - 1.0));
        fade = mix(fade, 1.0, panoramic);
        float gold = pow(max(0.0, sin(p.x * 4.0 + grid.y * 0.3)), 18.0);
        vec3 light = mix(vec3(0.003, 0.32, 0.64), vec3(1.0, 0.28, 0.004), gold * 0.7);
        gl_FragColor = vec4(light, (lines * 0.16 + nodes * 0.48) * band * sides * fade * (0.8 + voice * 0.2) * mix(1.0, 1.8, panoramic));
        #include <colorspace_fragment>
      }`,
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return {
    mesh,
    resize(width: number, height: number) {
      aspect.value = width / height;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
