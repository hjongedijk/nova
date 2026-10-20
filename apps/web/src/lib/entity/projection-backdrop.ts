import * as THREE from "three";

/** Viewport-wide filaments extend beyond the artwork and dissolve into the page. */
export function createProjectionBackdrop(
  time: { value: number },
  voice: { value: number },
  panoramic = false,
  artwork?: THREE.Texture,
) {
  const aspect = { value: 1 };
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      time,
      voice,
      aspect,
      panoramic: { value: panoramic ? 1 : 0 },
      artwork: { value: artwork ?? null },
    },
    vertexShader: `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform float time, voice, aspect, panoramic; uniform sampler2D artwork;
      void main() {
        vec2 p = (vUv - 0.5) * vec2(aspect * 1.1, 1.1);
        float wave = sin(p.x * 6.0 - time * 0.16) * 0.032 + sin(p.x * 15.0 + time * 0.12) * 0.012;
        float depthWave = sin(p.x * 3.8 + time * 0.13) * 0.09;
        float spread = mix(1.0, 2.6, panoramic);
        vec2 grid = vec2((p.x + sin(p.y * 7.0 + time * 0.08) * panoramic * 0.045) * 42.0, (p.y - wave - depthWave * panoramic) * 65.0 / spread);
        vec3 cell = vec3(grid, grid.x + grid.y);
        vec3 aa = max(fwidth(cell), vec3(0.001));
        vec3 edge = 1.0 - smoothstep(vec3(0.0), aa * 0.35, abs(fract(cell) - 0.5));
        float lines = max(edge.x, max(edge.y, edge.z));
        vec2 point = (fract(grid) - 0.5) / clamp(fwidth(grid), vec2(0.04), vec2(0.22));
        float nodes = exp(-dot(point, point) * 2.0);
        float band = exp(-pow((p.y + 0.13 - wave) / 0.105, 4.0));
        float broad = exp(-pow((p.y + 0.04 - depthWave) / 0.30, 4.0));
        float upper = exp(-pow((p.y - 0.29 + wave) / 0.16, 2.0));
        band = mix(band, broad * 0.72 + upper * 0.2, panoramic);
        float sides = smoothstep(0.16, 0.38, abs(p.x));
        float fade = 1.0 - smoothstep(0.72, 1.0, abs(vUv.x * 2.0 - 1.0));
        fade = mix(fade, 1.0, panoramic);
        float gold = pow(max(0.0, sin(p.x * 4.0 + grid.y * 0.3)), 18.0);
        vec3 light = mix(vec3(0.003, 0.32, 0.64), vec3(1.0, 0.28, 0.004), gold * 0.7);
        float haze = exp(-length(p * vec2(0.65, 1.3)) * 2.6) * panoramic;
        vec2 dustCell = floor(vUv * vec2(190.0 * aspect, 190.0));
        float seed = fract(sin(dot(dustCell, vec2(127.1, 311.7))) * 43758.5453);
        vec2 dustUv = fract(vUv * vec2(190.0 * aspect, 190.0)) - 0.5;
        float dust = exp(-dot(dustUv, dustUv) * 140.0) * step(0.988, seed) * (0.6 + 0.4 * sin(time * 0.4 + seed * 80.0)) * panoramic;
        float fieldAlpha = (lines * 0.16 + nodes * 0.48) * band * sides * fade * (0.8 + voice * 0.2) * mix(1.0, 1.8, panoramic);
        // Extend the original mountain texture separately from the central bust.
        float reach = clamp((abs(vUv.x - 0.5) - 0.13) / 0.37, 0.0, 1.0);
        float mountainX = mix(0.28, 0.015, reach);
        if (vUv.x > 0.5) mountainX = 1.0 - mountainX;
        vec2 mountainUv = vec2(mountainX, vUv.y * 0.8 + 0.06 + sin(time * 0.12 + vUv.x * 4.0) * 0.004);
        vec4 mountain = texture2D(artwork, mountainUv);
        float mountainAlpha = mountain.a * smoothstep(0.24, 0.42, vUv.y) * smoothstep(0.10, 0.24, abs(vUv.x - 0.5)) * panoramic * 0.8;
        float ambientAlpha = (fieldAlpha * mix(1.0, 0.24, panoramic) + haze * 0.022 + dust * 0.23) * (1.0 - mountainAlpha);
        float alpha = mountainAlpha + ambientAlpha;
        vec3 combined = (mountain.rgb * mountainAlpha + light * ambientAlpha) / max(alpha, 0.0001);
        gl_FragColor = vec4(combined, alpha);
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
