import * as THREE from "three";
import { TalkingHead } from "@met4citizen/talkinghead";
import { audioContext } from "#lib/voice/audio.ts";
import { audioLevel } from "#lib/stores/audio-level.svelte.ts";
import { helperHue } from "#lib/stores/helper.svelte.ts";
import { chat, type UiState } from "#lib/stores/chat.svelte.ts";
import type { OrbHandle } from "./orb.ts";
import { STATES } from "./states.ts";
import { createPortraitGlow } from "./portrait-glow.ts";
import { createPortraitBackdrop } from "./portrait-backdrop.ts";

interface Host {
  state(): UiState;
  cancelled(): boolean;
}

/** TalkingHead owns the rig and expressions; NOVA remains the only speech player. */
export async function startTalkingPortrait(
  node: HTMLElement,
  host: Host,
): Promise<OrbHandle> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.domElement.className = "companion-helmet";
  renderer.domElement.dataset.renderer = "talkinghead";
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  node.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(
    -0.25,
    0.25,
    0.25,
    -0.25,
    0.01,
    10,
  );
  scene.add(new THREE.AmbientLight(0xa5e9ff, 0.12));
  const light = new THREE.DirectionalLight(0xc6edff, 2.1);
  light.position.set(-2, 1.5, 2);
  scene.add(light);
  const rim = new THREE.DirectionalLight(0x17b9ff, 4);
  rim.position.set(1, 1, -1);
  scene.add(rim);
  const time = { value: 0 };
  const color = { value: new THREE.Color(0x18c9f4) };
  const targetColor = new THREE.Color();
  const core = { value: new THREE.Vector3() };
  const level = { value: 0 };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const backdrop = createPortraitBackdrop(time, color, level);
  scene.add(backdrop.mesh);
  const glow = createPortraitGlow(renderer, scene, camera);
  let head: TalkingHead;
  try {
    head = new TalkingHead(node, {
      avatarOnly: true,
      modelRoot: "AvatarRoot",
      avatarOnlyScene: scene,
      avatarOnlyCamera: camera,
      audioCtx: audioContext(),
      lipsyncModules: [],
      ttsEndpoint: null,
      mixerGainSpeech: 0,
      cameraView: "head",
      avatarMood: "neutral",
      avatarIdleEyeContact: 0.65,
      avatarSpeakingEyeContact: 0.8,
      avatarIdleHeadMove: reduced ? 0 : 0.25,
      avatarSpeakingHeadMove: reduced ? 0 : 0.25,
      modelMovementFactor: reduced ? 0 : 0.15,
    });
  } catch (error) {
    glow.dispose();
    backdrop.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    throw error;
  }
  let stopped = false;
  let frame = 0;
  let last = 0;
  let errorUntil = 0;
  let positiveUntil = 0;
  let previousState: UiState | undefined;
  const expression = new Map<string, number>();
  const resize = () => {
    const width = Math.max(1, node.clientWidth),
      height = Math.max(1, node.clientHeight);
    camera.left = (-0.25 * width) / height;
    camera.right = (0.25 * width) / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    glow.resize(width, height);
  };
  const observer = new ResizeObserver(resize);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    head.audioReverbNode?.disconnect();
    head.dispose();
    glow.dispose();
    backdrop.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  try {
    await head.showAvatar({
      url: "/avatars/nova-human.glb?v=b8404dc8",
      body: "F",
      avatarMood: "neutral",
    });
    if (host.cancelled()) {
      stop();
      return { stop, trigger() {} };
    }
    const headBone = head.armature.getObjectByName("Head");
    if (!headBone) throw new Error("NOVA avatar has no head rig");
    const headRotation = headBone.quaternion;
    const authoredHead = new THREE.Quaternion();
    const headCorrection = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      -0.24,
    );
    let correctedHead = false;
    const leftEye = head.armature.getObjectByName("LeftEye");
    const rightEye = head.armature.getObjectByName("RightEye");
    if (!leftEye || !rightEye) throw new Error("NOVA avatar has no eye rig");
    const eyeRig = [
      {
        side: "Left",
        rotation: leftEye.quaternion,
        rest: leftEye.quaternion.clone(),
        sign: 1,
      },
      {
        side: "Right",
        rotation: rightEye.quaternion,
        rest: rightEye.quaternion.clone(),
        sign: -1,
      },
    ];
    const gazeEuler = new THREE.Euler();
    const gazeRotation = new THREE.Quaternion();
    head.armature.updateMatrixWorld(true);
    const eyes = leftEye.getWorldPosition(new THREE.Vector3());
    camera.position.set(0.085, eyes.y - 0.035, 0.9);
    camera.lookAt(0, eyes.y - 0.055, 0);
    core.value.set(0, eyes.y + 0.005, eyes.z + 0.04);
    backdrop.mesh.position.set(0, eyes.y - 0.035, -0.14);
    const surfaces: THREE.Mesh[] = [];
    head.armature.traverse((object) => {
      if (object instanceof THREE.Mesh) surfaces.push(object);
    });
    for (const object of surfaces) {
      if (/^outfit_/.test(object.name)) {
        object.visible = false;
        continue;
      }
      const isEye = /Eyeball/.test(object.name);
      const isFiber = /Eyelashes/.test(object.name);
      // The transparent cornea is omitted: the eyeball keeps the authored iris texture.
      if (/Cornea/.test(object.name)) {
        object.visible = false;
        continue;
      }
      const original = Array.isArray(object.material)
        ? object.material[0]
        : object.material;
      const surfaceMap =
        original instanceof THREE.MeshStandardMaterial ? original.map : null;
      const material = new THREE.MeshPhysicalMaterial({
        map: surfaceMap,
        normalMap:
          original instanceof THREE.MeshStandardMaterial
            ? original.normalMap
            : null,
        color: surfaceMap
          ? 0xffffff
          : isEye
            ? 0xadc6ce
            : isFiber
              ? 0x176b7a
              : 0x071a25,
        emissive: isFiber ? 0x04313b : 0x00040a,
        roughness: isEye ? 0.12 : 0.48,
        metalness: isEye ? 0 : 0.05,
        clearcoat: isEye ? 1 : 0,
        clearcoatRoughness: isEye ? 0.06 : 0.24,
        transparent: true,
      });
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, {
          novaTime: time,
          novaColor: color,
          novaCore: core,
          novaLevel: level,
          novaEyes: { value: isEye ? 1 : 0 },
        });
        shader.vertexShader = shader.vertexShader
          .replace(
            "#include <common>",
            "#include <common>\nvarying vec3 vNovaPosition; varying vec3 vNovaSurface;",
          )
          .replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvNovaSurface = position;",
          )
          .replace(
            "#include <worldpos_vertex>",
            "#include <worldpos_vertex>\nvNovaPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;",
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>
          varying vec3 vNovaPosition;
          varying vec3 vNovaSurface;
          uniform float novaEyes;
          uniform float novaTime;
          uniform float novaLevel;
          uniform vec3 novaColor;
          uniform vec3 novaCore;`,
          )
          .replace(
            "#include <normal_fragment_maps>",
            `#include <normal_fragment_maps>
            if (novaEyes < 0.5) {
              float detail = 1.0 - smoothstep(0.002, 0.005, length(fwidth(vNovaSurface)));
              float pores = sin(dot(vNovaSurface, vec3(3950.0, 2711.0, 1379.0))) * sin(dot(vNovaSurface, vec3(-2573.0, 4733.0, 1199.0)));
              float skinHeight = pores * 0.000025 * detail;
              vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
              vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
              float determinant = dot(dpdx, r1);
              vec3 gradient = sign(determinant) * (dFdx(skinHeight) * r1 + dFdy(skinHeight) * r2);
              normal = normalize(max(abs(determinant), 0.000000001) * normal - gradient);
            }`,
          )
          .replace(
            "#include <roughnessmap_fragment>",
            `#include <roughnessmap_fragment>
            if (novaEyes < 0.5) {
              float grain = sin(dot(vNovaSurface, vec3(1357.0, 2749.0, 1733.0)));
              roughnessFactor = clamp(roughnessFactor + grain * 0.055, 0.2, 0.65);
            }`,
          )
          .replace(
            "#include <color_fragment>",
            `#include <color_fragment>
            float novaAlbedo = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
            if (novaEyes < 0.5) diffuseColor.rgb = novaColor * pow(max(novaAlbedo, 0.001), 1.05) * 0.19;
`,
          )
          .replace(
            "#include <emissivemap_fragment>",
            `#include <emissivemap_fragment>
            float novaRim = pow(1.0 - max(dot(normal, normalize(vViewPosition)), 0.0), 2.2);
            vec2 field = vec2(vNovaSurface.x + vNovaSurface.z * 0.24, vNovaSurface.y) * 190.0;
            field += vec2(sin(vNovaSurface.y * 170.0 + vNovaSurface.z * 90.0), cos(vNovaSurface.x * 210.0 - vNovaSurface.y * 110.0)) * 0.14;
            vec2 grid = vec2(field.x * 1.1547, field.y + field.x * 0.57735);
            vec3 distances = abs(fract(vec3(grid, grid.x - grid.y)) - 0.5);
            vec3 lineWidth = max(fwidth(vec3(grid, grid.x - grid.y)), vec3(0.001));
            vec3 edges = 1.0 - smoothstep(vec3(0.0), min(lineWidth * 0.18, vec3(0.12)), distances);
            float network = max(edges.x, max(edges.y, edges.z));
            vec2 nodeDelta = (fract(grid) - 0.5) / clamp(fwidth(grid) * 0.4, vec2(0.02), vec2(0.12));
            float nodes = exp(-dot(nodeDelta, nodeDelta) * 0.6);
            float flow = pow(0.5 + 0.5 * sin(vNovaSurface.y * 38.0 - novaTime * 0.7 + vNovaSurface.x * 12.0), 8.0);
            float contours = 1.0 - smoothstep(0.0, max(fwidth(vNovaSurface.y * 320.0), 0.001), abs(fract(vNovaSurface.y * 320.0) - 0.5));
            vec3 edgeColor = mix(novaColor, vec3(0.5, 0.75, 1.0), 0.24);
            float anatomy = 0.18 + pow(max(dot(normal, normalize(vec3(-0.7, 0.5, 1.0))), 0.0), 2.0) * 0.5;
            totalEmissiveRadiance += (1.0 - novaEyes) * (0.3 + 0.7 * smoothstep(0.02, 0.3, novaAlbedo)) * novaColor * (network * (0.1 + flow * 0.16) + contours * anatomy * 0.12 + nodes * (0.48 + flow * 0.6));
            totalEmissiveRadiance += edgeColor * novaRim * (0.18 + novaLevel * 0.15);
            if (novaEyes > 0.5) totalEmissiveRadiance = diffuseColor.rgb * 0.35;
            else totalEmissiveRadiance += novaColor * (0.005 + novaRim * 0.12);`,
          );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <opaque_fragment>",
          `diffuseColor.a *= smoothstep(novaCore.y - 0.20, novaCore.y - 0.10, vNovaPosition.y);
          if (diffuseColor.a < 0.003) discard;
          #include <opaque_fragment>`,
        );
      };
      material.customProgramCacheKey = () => "nova-human-lightfield-v3";
      const old = Array.isArray(object.material)
        ? object.material
        : [object.material];
      old.forEach((item) => item.dispose());
      object.material = material;
    }
    resize();
    observer.observe(node);
    renderer.domElement.dataset.avatarReady = "true";
    function draw(now: number) {
      if (stopped) return;
      frame = requestAnimationFrame(draw);
      if (now - last < 1000 / 30) return;
      const delta = Math.min(100, last ? now - last : 33);
      last = now;
      time.value = reduced ? 0 : now / 1000;
      const state = host.state();
      const hue =
        now < errorUntil
          ? 4
          : state === "ready"
            ? helperHue()
            : STATES[state].h;
      targetColor.setHSL(hue / 360, 0.88, 0.55);
      color.value.lerp(targetColor, 1 - Math.exp(-delta / 180));
      const targetLevel = audioLevel.speaking
        ? Math.min(1, Math.max(0, audioLevel.level))
        : 0;
      level.value += (targetLevel - level.value) * (1 - Math.exp(-delta / 85));
      const attentive = state === "listening";
      const thoughtful = state === "thinking" || chat.mood === "thoughtful";
      const concerned = now < errorUntil || chat.mood === "concerned";
      const positive =
        now < positiveUntil ||
        chat.mood === "happy" ||
        chat.mood === "enthusiastic";
      const smile =
        concerned || thoughtful
          ? 0
          : positive
            ? 0.24
            : state === "speaking"
              ? 0.07
              : 0.07;
      const targets: Record<string, number> = {
        browInnerUp: concerned
          ? 0.18
          : attentive
            ? 0.14
            : thoughtful
              ? 0.08
              : 0.025,
        browDownLeft: thoughtful ? 0.24 : concerned ? 0.12 : 0,
        browDownRight: thoughtful ? 0.13 : concerned ? 0.12 : 0,
        mouthSmileLeft: smile,
        mouthSmileRight: smile,
        eyeSquintLeft: thoughtful ? 0.12 : positive ? 0.1 : 0,
        eyeSquintRight: thoughtful ? 0.08 : positive ? 0.1 : 0,
        eyeWideLeft: attentive ? 0.09 : 0,
        eyeWideRight: attentive ? 0.09 : 0,
        mouthPressLeft: concerned ? 0.08 : 0,
        mouthPressRight: concerned ? 0.08 : 0,
      };
      for (const [name, target] of Object.entries(targets)) {
        const value =
          (expression.get(name) ?? 0) +
          (target - (expression.get(name) ?? 0)) * (1 - Math.exp(-delta / 220));
        expression.set(name, value);
        head.setFixedValue(name, value);
      }
      if (state !== previousState) {
        if (attentive || state === "speaking") head.lookAtCamera(1800);
        else if (thoughtful && !reduced) {
          const rect = node.getBoundingClientRect();
          head.lookAt(
            rect.left + rect.width * 0.66,
            rect.top + rect.height * 0.35,
            1800,
          );
        }
        previousState = state;
      }
      const jaw = head.mtAvatar.jawOpen;
      if (jaw) {
        jaw.realtime = Math.min(0.85, Math.pow(level.value, 0.7) * 2);
        jaw.needsUpdate = true;
      }
      // This is audio-reactive mouth movement, not a phoneme/viseme timing claim.
      if (correctedHead) headRotation.copy(authoredHead);
      head.animate(delta);
      authoredHead.copy(headRotation);
      headRotation.multiply(headCorrection);
      correctedHead = true;
      // This model drives its eyeballs with bones, while TalkingHead generates gaze morph values.
      for (const { side, rotation, rest, sign } of eyeRig) {
        const gaze = (direction: string) =>
          head.mtAvatar[`eyeLook${direction}${side}`]?.value ?? 0;
        gazeEuler.set(
          (gaze("Down") - gaze("Up")) * 0.4,
          (gaze("Out") - gaze("In")) * 0.4 * sign,
          0,
        );
        gazeRotation.setFromEuler(gazeEuler);
        rotation.copy(rest).multiply(gazeRotation);
      }
      glow.render();
    }
    frame = requestAnimationFrame(draw);
    return {
      stop,
      trigger(event) {
        if (event === "error") errorUntil = performance.now() + 1400;
        if (event === "done" || event === "greet" || event === "check") {
          positiveUntil = performance.now() + 2200;
          head.lookAtCamera(900);
        }
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
