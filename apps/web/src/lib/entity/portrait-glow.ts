import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/** A restrained optical glow; derive alpha so the projection stays transparent. */
export function createPortraitGlow(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
) {
  const composer = new EffectComposer(renderer);
  const render = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.48, 0.35, 0.42);
  const alpha = new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
      void main() {
        vec3 light = texture2D(tDiffuse, vUv).rgb;
        float strength = max(light.r, max(light.g, light.b));
        float opacity = smoothstep(0.0, 0.09, strength);
        gl_FragColor = vec4(light, opacity);
      }`,
  });
  const output = new OutputPass();
  for (const pass of [render, bloom, alpha, output]) composer.addPass(pass);
  return {
    resize(width: number, height: number) {
      composer.setSize(width, height);
    },
    render() {
      composer.render();
    },
    dispose() {
      for (const pass of [render, bloom, alpha, output]) pass.dispose();
      composer.dispose();
    },
  };
}
