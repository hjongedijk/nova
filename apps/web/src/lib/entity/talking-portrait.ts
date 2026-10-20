import * as THREE from "three";
import { audioLevel } from "#lib/stores/audio-level.svelte.ts";
import type { UiState } from "#lib/stores/chat.svelte.ts";
import type { OrbHandle } from "./orb.ts";
import { loadProjection } from "./projection-field.ts";

interface Host {
  state(): UiState;
  cancelled(): boolean;
}

/** The cyan/gold artwork becomes a breathing, audio-reactive particle portrait. */
export async function startTalkingPortrait(
  node: HTMLElement,
  host: Host,
): Promise<OrbHandle> {
  const field = await loadProjection(
    "/avatars/nova-projection.png?v=cd34ec38",
    host.cancelled,
  );
  if (!field || host.cancelled()) return { stop() {}, trigger() {} };
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.domElement.className = "companion-helmet";
  renderer.domElement.dataset.renderer = "particle-projection";
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(
    -0.55,
    0.55,
    0.55,
    -0.55,
    0.01,
    10,
  );
  camera.position.z = 2;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const uniforms = {
    look: { value: new THREE.Vector2() },
    time: { value: 0 },
    voice: { value: 0 },
    activity: { value: 0 },
    reaction: { value: 0 },
    pointSize: { value: 1 },
  };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(field.positions, 3),
  );
  geometry.setAttribute("color", new THREE.BufferAttribute(field.colors, 3));
  geometry.setAttribute("signal", new THREE.BufferAttribute(field.signals, 3));
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    vertexShader: `attribute vec3 signal;
      uniform float time, voice, activity, pointSize; uniform vec2 look;
      varying vec3 vColor; varying float vAlpha, vWarm;
      void main() {
        vec3 p = position;
        float breath = sin(time * 0.8) * 0.0015;
        p.xy *= 1.0 + breath;
        float face = exp(-pow(p.x / 0.2, 4.0) - pow((p.y - 0.1) / 0.25, 4.0));
        p.x += sin(p.y * 95.0 - time * 3.0 + signal.z) * face * voice * 0.0012;
        p.y += sin(time * 0.45 + signal.z * 6.28) * 0.00035;
        p.z += face * sin(time * 0.9) * 0.001;
        float yaw = look.x * 0.1;
        float turnX = cos(yaw) * p.x + sin(yaw) * p.z;
        p.x = mix(p.x, turnX, face);
        p.y += look.y * (p.z - 0.04) * face * 0.07;
        vColor = color; vAlpha = signal.x; vWarm = signal.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = pointSize;
      }`,
    fragmentShader: `uniform float voice, activity, reaction;
      varying vec3 vColor; varying float vAlpha, vWarm;
      void main() {
        float edge = 1.0 - smoothstep(0.43, 0.52, length(gl_PointCoord - 0.5));
        vec3 light = vColor * (1.0 + vWarm * (voice * 1.2 + activity * 0.1));
        light = mix(light, light * vec3(1.2, 0.45, 0.35), reaction * vWarm);
        gl_FragColor = vec4(light, vAlpha * edge);
        #include <colorspace_fragment>
      }`,
  });
  const portrait = new THREE.Points(geometry, material);
  scene.add(portrait);
  let frame = 0,
    previous = 0,
    stopped = false,
    errorUntil = 0,
    positiveUntil = 0;
  const resize = () => {
    const width = Math.max(1, node.clientWidth),
      height = Math.max(1, node.clientHeight);
    camera.left = (-0.55 * width) / height;
    camera.right = (0.55 * width) / height;
    camera.updateProjectionMatrix();
    const scale = Math.min(1, 640 / Math.max(width, height));
    renderer.setSize(
      Math.round(width * scale),
      Math.round(height * scale),
      false,
    );
    uniforms.pointSize.value = Math.max(
      0.7,
      ((height * scale * renderer.getPixelRatio() * field.stride) /
        field.sourceHeight /
        1.1) *
        1.3,
    );
  };
  const targetLook = new THREE.Vector2();
  const followPointer = (event: PointerEvent) => {
    if (reduced) return;
    const rect = node.getBoundingClientRect();
    targetLook.set(
      THREE.MathUtils.clamp(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -1,
        1,
      ),
      THREE.MathUtils.clamp(
        1 - ((event.clientY - rect.top) / rect.height) * 2,
        -1,
        1,
      ),
    );
  };
  const resetLook = () => targetLook.set(0, 0);
  const observer = new ResizeObserver(resize);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    node.removeEventListener("pointermove", followPointer);
    node.removeEventListener("pointerleave", resetLook);
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  try {
    node.replaceChildren(renderer.domElement);
    resize();
    observer.observe(node);
    node.addEventListener("pointermove", followPointer);
    node.addEventListener("pointerleave", resetLook);
    renderer.domElement.dataset.avatarReady = "true";
    renderer.domElement.dataset.particles = String(field.positions.length / 3);
    const draw = (now: number) => {
      if (stopped) return;
      frame = requestAnimationFrame(draw);
      if (now - previous < 1000 / 30) return;
      const elapsed = Math.min(100, previous ? now - previous : 33);
      previous = now;
      const targetVoice = audioLevel.speaking
        ? Math.min(1, Math.pow(Math.max(0, audioLevel.level), 0.7) * 2.3)
        : 0;
      uniforms.voice.value +=
        (targetVoice - uniforms.voice.value) * (1 - Math.exp(-elapsed / 80));
      uniforms.time.value = reduced ? 0 : now / 1000;
      uniforms.look.value.lerp(targetLook, 1 - Math.exp(-elapsed / 150));
      uniforms.activity.value =
        host.state() === "thinking"
          ? reduced
            ? 0.5
            : 0.5 + Math.sin(now / 550) * 0.25
          : now < positiveUntil
            ? 1
            : 0;
      uniforms.reaction.value = now < errorUntil ? 1 : 0;
      renderer.domElement.dataset.speaking = String(audioLevel.speaking);
      renderer.domElement.dataset.voiceLevel = uniforms.voice.value.toFixed(4);
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(draw);
    return {
      stop,
      trigger(event) {
        if (event === "error") errorUntil = performance.now() + 1400;
        if (event === "done" || event === "greet" || event === "check")
          positiveUntil = performance.now() + 2000;
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
