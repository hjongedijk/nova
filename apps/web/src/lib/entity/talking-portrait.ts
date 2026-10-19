import * as THREE from "three";
import { TalkingHead } from "@met4citizen/talkinghead";
import { audioContext } from "#lib/voice/audio.ts";
import { audioLevel } from "#lib/stores/audio-level.svelte.ts";
import { helperHue } from "#lib/stores/helper.svelte.ts";
import { chat, type UiState } from "#lib/stores/chat.svelte.ts";
import type { OrbHandle } from "./orb.ts";
import { STATES } from "./states.ts";
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
  scene.add(new THREE.AmbientLight(0xa5e9ff, 0.22));
  const light = new THREE.DirectionalLight(0xc6edff, 3.0);
  light.position.set(-2, 1.5, 2);
  scene.add(light);
  const rim = new THREE.DirectionalLight(0x17b9ff, 3);
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
  let head: TalkingHead;
  try {
    head = new TalkingHead(node, {
      avatarOnly: true,
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
  };
  const observer = new ResizeObserver(resize);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    head.audioReverbNode?.disconnect();
    head.dispose();
    backdrop.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  try {
    await head.showAvatar({
      url: "/avatars/nova-human.glb",
      body: "F",
      avatarMood: "neutral",
    });
    if (host.cancelled()) {
      stop();
      return { stop, trigger() {} };
    }
    const leftEye = head.armature.getObjectByName("LeftEye");
    if (!leftEye) throw new Error("NOVA avatar has no eye rig");
    head.armature.updateMatrixWorld(true);
    const eyes = leftEye.getWorldPosition(new THREE.Vector3());
    camera.position.set(0.17, eyes.y - 0.045, 0.9);
    camera.lookAt(0, eyes.y - 0.055, 0);
    core.value.set(0, eyes.y + 0.005, eyes.z + 0.04);
    backdrop.mesh.position.set(0, eyes.y - 0.035, -0.14);
    const surfaces: THREE.Mesh[] = [];
    head.armature.traverse((object) => {
      if (object instanceof THREE.Mesh) surfaces.push(object);
    });
    const filaments: THREE.MeshBasicMaterial[] = [];
    for (const object of surfaces) {
      if (object.name === "Human") {
        const positions = object.geometry.getAttribute("position");
        // Refine only the nose, using the bundled model's rest-space landmarks.
        // The eye sockets, lips, topology, skin weights and expression targets stay intact.
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i),
            y = positions.getY(i),
            z = positions.getZ(i);
          const front = THREE.MathUtils.smoothstep(z, 0.145, 0.17);
          const weight =
            Math.exp(-((x / 0.018) ** 2) - ((y - 1.614) / 0.024) ** 2) * front;
          if (weight < 0.001) continue;
          positions.setXYZ(i, x * (1 - weight * 0.12), y, z - weight * 0.009);
        }
        positions.needsUpdate = true;
        object.geometry.computeVertexNormals();
        object.geometry.computeBoundingSphere();
      }
      // GLTFLoader sanitizes dots in node names before binding the skeleton.
      const isEye =
        object.name.replace(/[^a-z]/gi, "").toLowerCase() === "humanhighpoly";
      const material = new THREE.MeshPhysicalMaterial({
        color: isEye ? 0xadc6ce : 0x174151,
        emissive: 0x00040a,
        roughness: isEye ? 0.12 : 0.36,
        metalness: isEye ? 0 : 0.32,
        clearcoat: isEye ? 1 : 0.55,
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
            if (novaEyes > 0.5) {
              vec2 eyeUv = vec2(abs(vNovaSurface.x) - 0.032, vNovaSurface.y - 1.651);
              float eyeRadius = length(eyeUv);
              float eyeAngle = atan(eyeUv.y, eyeUv.x);
              float irisMask = 1.0 - smoothstep(0.0061, 0.0067, eyeRadius);
              float pupilMask = 1.0 - smoothstep(0.0023, 0.0028, eyeRadius);
              float fibers = 0.5 + 0.5 * sin(eyeAngle * 83.0 + sin(eyeAngle * 27.0) * 2.0 + eyeRadius * 2700.0);
              float fineFibers = 0.5 + 0.5 * sin(eyeAngle * 173.0 - eyeRadius * 4300.0);
              float limbal = exp(-pow((eyeRadius - 0.0059) / 0.0007, 2.0));
              vec3 irisColor = novaColor * (0.22 + fibers * 0.43 + fineFibers * 0.15);
              irisColor *= 1.0 - limbal * 0.72;
              vec3 eyeColor = mix(vec3(0.38, 0.48, 0.52), irisColor, irisMask);
              eyeColor = mix(eyeColor, vec3(0.003, 0.008, 0.014), pupilMask);
              float front = smoothstep(0.132, 0.141, vNovaSurface.z);
              diffuseColor.rgb = mix(vec3(0.25, 0.35, 0.39), eyeColor, front);
            }`,
          )
          .replace(
            "#include <emissivemap_fragment>",
            `#include <emissivemap_fragment>
            float bands = pow(0.5 + 0.5 * sin(vNovaPosition.y * 500.0 + novaTime * 0.4), 14.0);
            vec3 delta = (vNovaPosition - novaCore) * vec3(1.0, 1.1, 0.5);
            float warmth = exp(-dot(delta, delta) / 0.00045);
            float novaRim = pow(1.0 - max(dot(normal, normalize(vViewPosition)), 0.0), 2.5);
            vec3 lattice = cos(vNovaSurface * 1500.0);
            float nodes = pow(max(0.0, lattice.x * lattice.y * lattice.z), 18.0);
            float browX = (abs(vNovaSurface.x) - 0.034) / 0.026;
            float browArch = 1.678 + 0.007 * (1.0 - browX * browX);
            float brow = exp(-pow((vNovaSurface.y - browArch) / 0.002, 2.0)) * (1.0 - smoothstep(0.75, 1.0, abs(browX))) * smoothstep(0.10, 0.13, vNovaSurface.z);
            float browFibers = 0.5 + 0.5 * sin(vNovaSurface.x * 6500.0 + vNovaSurface.y * 3100.0);
            totalEmissiveRadiance += novaColor * brow * (0.07 + browFibers * 0.12) * (1.0 - novaEyes);
            float current = pow(0.5 + 0.5 * sin(vNovaSurface.y * 65.0 - novaTime * 0.7 + vNovaSurface.x * 25.0), 12.0);
            vec3 edgeColor = mix(novaColor, vec3(0.34, 0.55, 1.0), 0.22);
            totalEmissiveRadiance += novaColor * nodes * (1.2 + current * 1.5 + novaLevel) * (1.0 - novaEyes);
            totalEmissiveRadiance += edgeColor * novaRim * (0.18 + novaLevel * 0.15);
            // The bundled eye mesh uses baked model coordinates; keep its iris attached to the rig.
            vec2 irisPosition = vec2(abs(vNovaSurface.x) - 0.032, vNovaSurface.y - 1.651);
            float irisRadius = length(irisPosition);
            float iris = exp(-pow((irisRadius - 0.0055) / 0.0012, 2.0));
            float irisFront = smoothstep(0.136, 0.143, vNovaSurface.z);
            totalEmissiveRadiance += novaColor * novaEyes * iris * irisFront * (0.18 + novaLevel * 0.1);
            float catchlight = exp(-dot(irisPosition - vec2(-0.0018, 0.0022), irisPosition - vec2(-0.0018, 0.0022)) / 0.00000035);
            totalEmissiveRadiance += vec3(0.65, 0.85, 1.0) * catchlight * novaEyes * irisFront * 0.8;
            totalEmissiveRadiance += novaColor * (0.015 + bands * 0.04 + novaRim * 0.4);
            totalEmissiveRadiance += novaColor * warmth * (0.03 + novaLevel * 0.15);`,
          );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <opaque_fragment>",
          `diffuseColor.a *= smoothstep(novaCore.y - 0.27, novaCore.y - 0.19, vNovaPosition.y);
          if (diffuseColor.a < 0.003) discard;
          #include <opaque_fragment>`,
        );
      };
      material.customProgramCacheKey = () => "nova-human-hologram-v1";
      const old = Array.isArray(object.material)
        ? object.material
        : [object.material];
      old.forEach((item) => item.dispose());
      object.material = material;
      if (object.name === "Human" && object instanceof THREE.SkinnedMesh) {
        const filament = new THREE.MeshBasicMaterial({
          color: 0x18c9f4,
          wireframe: true,
          transparent: true,
          opacity: 0.045,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        filament.onBeforeCompile = (shader) => {
          shader.uniforms.novaCore = core;
          shader.vertexShader = shader.vertexShader
            .replace(
              "#include <common>",
              "#include <common>\nvarying vec3 vNovaPosition;",
            )
            .replace(
              "#include <worldpos_vertex>",
              "#include <worldpos_vertex>\nvNovaPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;",
            );
          shader.fragmentShader = shader.fragmentShader
            .replace(
              "#include <common>",
              "#include <common>\nuniform vec3 novaCore; varying vec3 vNovaPosition;",
            )
            .replace(
              "#include <opaque_fragment>",
              `diffuseColor.a *= smoothstep(novaCore.y - 0.27, novaCore.y - 0.19, vNovaPosition.y);
              if (diffuseColor.a < 0.001) discard;
              #include <opaque_fragment>`,
            );
        };
        filament.customProgramCacheKey = () => "nova-human-filaments-v1";
        const mesh = object.clone(false);
        mesh.material = filament;
        // The overlay shares the live facial morphs and skeleton with the human surface.
        mesh.morphTargetInfluences = object.morphTargetInfluences;
        mesh.bind(object.skeleton, object.bindMatrix);
        object.parent?.add(mesh);
        filaments.push(filament);
      }
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
              : 0.035;
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
        jaw.realtime = level.value * 0.65;
        jaw.needsUpdate = true;
      }
      // This is audio-reactive mouth movement, not a phoneme/viseme timing claim.
      head.animate(delta);
      filaments.forEach((material) => material.color.copy(color.value));
      renderer.render(scene, camera);
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
