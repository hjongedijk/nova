import * as THREE from "three";
import { audioLevel } from "#lib/stores/audio-level.svelte.ts";
import type { UiState } from "#lib/stores/chat.svelte.ts";
import type { OrbHandle } from "./orb.ts";
import { portraitPose, portraitBodyPose } from "./portrait-motion.ts";
import { createProjectionBackdrop } from "./projection-backdrop.ts";
import { loadProjectionSurface } from "./projection-surface.ts";

interface Host {
  panoramic?: boolean;
  state(): UiState;
  cancelled(): boolean;
}

/** A continuous, filtered holographic surface preserves fine contours during gestures. */
export async function startTalkingPortrait(
  node: HTMLElement,
  host: Host,
): Promise<OrbHandle> {
  const field = await loadProjectionSurface(
    "/avatars/nova-projection.png?v=cd34ec38",
    host.cancelled,
  );
  if (!field) return { stop() {}, trigger() {} };
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.domElement.className = "companion-helmet";
  renderer.domElement.dataset.renderer = "holographic-surface";
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  field.texture.anisotropy = Math.min(
    8,
    renderer.capabilities.getMaxAnisotropy(),
  );
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
    pose: { value: new THREE.Vector3() },
    bodyPose: { value: new THREE.Vector3() },
    time: { value: 0 },
    voice: { value: 0 },
    activity: { value: 0 },
    reaction: { value: 0 },
    artwork: { value: field.texture },
  };
  const geometry = field.geometry;
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `
      uniform float time, voice; uniform vec3 pose, bodyPose;
      varying vec2 vUv;
      void main() {
        vec3 p = position;
        float head = smoothstep(-0.19, -0.055, p.y) * (1.0 - smoothstep(0.20, 0.27, abs(p.x)));
        float body = (1.0 - smoothstep(-0.15, 0.03, p.y)) * (1.0 - smoothstep(0.25, 0.49, abs(p.x)));
        float breath = sin(time * 1.1);
        p.x *= 1.0 + body * breath * 0.008;
        p.y += body * breath * 0.0045;
        vec3 h = p - vec3(0.0, -0.16, 0.01);
        h.xz = mat2(cos(pose.x), -sin(pose.x), sin(pose.x), cos(pose.x)) * h.xz;
        h.yz = mat2(cos(pose.y), -sin(pose.y), sin(pose.y), cos(pose.y)) * h.yz;
        h.xy = mat2(cos(pose.z), sin(pose.z), -sin(pose.z), cos(pose.z)) * h.xy;
        p = mix(p, h + vec3(0.0, -0.16, 0.01), head);
        vec3 torso = p - vec3(0.0, -0.42, -0.02);
        torso.xz = mat2(cos(bodyPose.x), -sin(bodyPose.x), sin(bodyPose.x), cos(bodyPose.x)) * torso.xz;
        torso.yz = mat2(cos(bodyPose.y), -sin(bodyPose.y), sin(bodyPose.y), cos(bodyPose.y)) * torso.yz;
        torso.xy = mat2(cos(bodyPose.z), sin(bodyPose.z), -sin(bodyPose.z), cos(bodyPose.z)) * torso.xy;
        p = mix(p, torso + vec3(0.0, -0.42, -0.02), max(head, body));
        p.x += sin(position.y * 12.0 - time * 3.0) * head * voice * 0.0005;
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `uniform sampler2D artwork;
      uniform float voice, activity, reaction;
      varying vec2 vUv;
      void main() {
        vec4 source = texture2D(artwork, vUv);
        float fade = smoothstep(0.0, 0.12, min(vUv.x, 1.0 - vUv.x));
        float warm = max(0.0, source.r - source.b);
        vec3 light = source.rgb * (1.0 + warm * (voice * 1.2 + activity * 0.1));
        light = mix(light, light * vec3(1.2, 0.45, 0.35), reaction * warm);
        gl_FragColor = vec4(light, source.a * fade);
        #include <colorspace_fragment>
      }`,
  });
  const portrait = new THREE.Mesh(geometry, material);
  scene.add(portrait);
  const backdrop = createProjectionBackdrop(
    uniforms.time,
    uniforms.voice,
    host.panoramic,
  );
  scene.add(backdrop.mesh);
  const targetPose = new THREE.Vector3();
  const targetBodyPose = new THREE.Vector3();
  let frame = 0,
    previous = 0,
    stopped = false,
    errorUntil = 0,
    positiveUntil = 0;
  const resize = () => {
    const width = Math.max(1, node.clientWidth),
      height = Math.max(1, node.clientHeight);
    const portraitHeight = host.panoramic
      ? Math.min(Math.min(width, height) * 0.68, 640)
      : height;
    camera.left = (-0.55 * width) / portraitHeight;
    camera.right = (0.55 * width) / portraitHeight;
    camera.top = (0.55 * height) / portraitHeight;
    camera.bottom = -camera.top;
    portrait.position.y = host.panoramic
      ? (0.055 * height) / portraitHeight
      : 0;
    camera.updateProjectionMatrix();
    // Bound total framebuffer pixels rather than stretching a 640px render.
    const scale = Math.min(
      1,
      Math.sqrt(5_000_000 / (width * height * renderer.getPixelRatio() ** 2)),
    );
    backdrop.resize(width, height);
    renderer.setSize(
      Math.round(width * scale),
      Math.round(height * scale),
      false,
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
    window.removeEventListener("pointermove", followPointer);
    window.removeEventListener("blur", resetLook);
    backdrop.dispose();
    geometry.dispose();
    field.texture.dispose();
    material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  try {
    node.replaceChildren(renderer.domElement);
    resize();
    observer.observe(node);
    window.addEventListener("pointermove", followPointer, { passive: true });
    window.addEventListener("blur", resetLook);
    renderer.domElement.dataset.avatarReady = "true";
    renderer.domElement.dataset.vertices = String(
      geometry.getAttribute("position").count,
    );
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
      targetPose.fromArray(
        portraitPose(
          uniforms.time.value,
          host.state(),
          uniforms.voice.value,
          uniforms.look.value.x,
          uniforms.look.value.y,
          reduced,
        ),
      );
      uniforms.pose.value.lerp(targetPose, 1 - Math.exp(-elapsed / 280));
      targetBodyPose.fromArray(
        portraitBodyPose(uniforms.time.value, uniforms.voice.value, reduced),
      );
      uniforms.bodyPose.value.lerp(
        targetBodyPose,
        1 - Math.exp(-elapsed / 450),
      );
      renderer.domElement.dataset.bodyPose = uniforms.bodyPose.value
        .toArray()
        .map((angle) => angle.toFixed(4))
        .join(",");
      renderer.domElement.dataset.pose = uniforms.pose.value
        .toArray()
        .map((angle) => angle.toFixed(4))
        .join(",");
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
