/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- the frame loop indexes typed arrays in hot loops; noUncheckedIndexedAccess would need `!` on every access.
import type { UiState } from "#lib/stores/chat.svelte.ts";
import { dashboard, guests } from "#lib/stores/dashboard.svelte.ts";
import { audioLevel as voiceLevel } from "#lib/stores/audio-level.svelte.ts";
import { voiceSpectrum } from "#lib/voice/audio.ts";
import { ALERT, STATES, type Look } from "./states.ts";

/**
 * THE ENTITY. One particle body on a full-screen canvas; its colour and motion are its state.
 * Ported from the prototype's frame loop: volumetric cloud, filaments, dust, HUD rings, radar, orbits,
 * voice reaction (analyser bands, or a fallback wave), alert tint, parallax and the birth animation.
 */

/** What the loop needs from the page. */
export interface EntityHost {
  canvas: HTMLCanvasElement;
  state(): UiState;
  /** Open confirmations plus open warnings: the entity turns red and beats while this is above zero. */
  intensity(): number;
  /** The invisible button over the sphere; it follows the body. */
  core?(): HTMLElement | null;
  /** The speech stage; the sphere lifts away as the answer grows. */
  stage?(): HTMLElement | null;
  /**
   * Compact mode (the helper's small orb): the SAME renderer on a small canvas, with fewer particles, without the
   * HUD instrument, dust and the lift for the stage. `life` adds the character's movement on top, per frame.
   */
  compact?: { life: Life };
}

/** Extra movement for the compact orb, in units of the orb's radius, on top of the state's own look. */
export interface Modulation {
  /** Size factor (breathing, blink, hop-less swell). */
  grow: number;
  /** Squash and stretch of the cloud. */
  sx: number;
  sy: number;
  /** Offset of the cloud's centre, in radii. */
  ox: number;
  oy: number;
  /** Brightness factor (a blink dims it). */
  dim: number;
  /** Overrides on the state's look (waiting is orange, an error red). */
  look?: Partial<Look>;
  /** Shape targets keep the same particles and interpolate their projected positions. */
  shape?: ParticleShape;
  shapeMix?: number;
  spin?: number;
}
export type ParticleShape =
  "heart" | "check" | "question" | "box" | "wave" | "ring" | "mist";

/** Original normalized paths, sampled deterministically across the particle cloud. */
export function particleShapePoint(
  shape: ParticleShape,
  progress: number,
): [number, number] {
  const u = Math.max(0, Math.min(1, progress));
  const a = u * Math.PI * 2;
  switch (shape) {
    case "heart":
      return [
        Math.pow(Math.sin(a), 3),
        -(
          13 * Math.cos(a) -
          5 * Math.cos(2 * a) -
          2 * Math.cos(3 * a) -
          Math.cos(4 * a)
        ) / 16,
      ];
    case "check":
      return u < 0.38
        ? [-0.9 + (u / 0.38) * 0.6, 0.05 + (u / 0.38) * 0.65]
        : [-0.3 + ((u - 0.38) / 0.62) * 1.15, 0.7 - ((u - 0.38) / 0.62) * 1.4];
    case "question": {
      if (u > 0.9) return [0, 0.9];
      if (u > 0.7)
        return [0.14 * (1 - (u - 0.7) / 0.2), 0.1 + ((u - 0.7) / 0.2) * 0.35];
      const angle = Math.PI + (u / 0.7) * Math.PI * 1.7;
      return [Math.cos(angle) * 0.6, -0.45 + Math.sin(angle) * 0.45];
    }
    case "box": {
      const edge = u * 4;
      return edge < 1
        ? [-0.75 + edge * 1.5, -0.75]
        : edge < 2
          ? [0.75, -0.75 + (edge - 1) * 1.5]
          : edge < 3
            ? [0.75 - (edge - 2) * 1.5, 0.75]
            : [-0.75, 0.75 - (edge - 3) * 1.5];
    }
    case "wave":
      return [u * 2 - 1, Math.sin(u * Math.PI * 3) * 0.45];
    case "ring":
      return [Math.cos(a) * 0.88, Math.sin(a) * 0.88];
    case "mist":
      return [Math.cos(a) * (0.4 + 0.7 * u), Math.sin(a) * 0.65];
  }
}
export interface Life {
  update(t: number, dt: number, level: number): Modulation;
  /** Drawn over the orb, in canvas pixels around the centre (sparkles). */
  overlay?(
    g: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
  ): void;
}

/** Start the loop on the host's canvas. Returns the function that stops it. */
export function startEntity(host: EntityHost): () => void {
  const cv = host.canvas;
  const g = cv.getContext("2d")!;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MOTION = reduceMotion ? 0.35 : 1;

  let W = 0;
  let H = 0;
  const compact = host.compact ?? null;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, compact ? 3 : 2);
    W = compact ? cv.clientWidth || 40 : window.innerWidth;
    H = compact ? cv.clientHeight || 40 : window.innerHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);
  // The compact orb changes size between the pill and the open header: follow its box.
  const watch = compact ? new ResizeObserver(resize) : null;
  watch?.observe(cv);

  const N = compact ? 560 : W < 700 ? 750 : 1300;
  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const pz = new Float32Array(N);
  const seed = new Float32Array(N);
  const nb1 = new Uint16Array(N);
  const nb2 = new Uint16Array(N);
  const sx = new Float32Array(N);
  const sy = new Float32Array(N);
  const sz = new Float32Array(N);

  {
    /* A volumetric cloud: a loose skin plus a denser, dimmer interior,
     * jittered so no lattice shows. */
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y0 = 1 - (2 * (i + 0.5)) / N;
      const r0 = Math.sqrt(1 - y0 * y0);
      const th = i * golden;
      const x = Math.cos(th) * r0 + (Math.random() - 0.5) * 0.16;
      const y = y0 + (Math.random() - 0.5) * 0.16;
      const z = Math.sin(th) * r0 + (Math.random() - 0.5) * 0.16;
      const len = Math.hypot(x, y, z) || 1;
      const rs =
        i % 3 === 0 ? 0.3 + 0.55 * Math.random() : 0.9 + 0.12 * Math.random();
      px[i] = (x / len) * rs;
      py[i] = (y / len) * rs;
      pz[i] = (z / len) * rs;
      seed[i] = Math.random();
    }
    for (let i = 0; i < N; i++) {
      const best: [number, number][] = [];
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const dx = px[i]! - px[j]!;
        const dy = py[i]! - py[j]!;
        const dz = pz[i]! - pz[j]!;
        const d = dx * dx + dy * dy + dz * dz;
        if (best.length < 5 || d < best[best.length - 1]![0]) {
          best.push([d, j]);
          best.sort((u, v) => u[0] - v[0]);
          if (best.length > 5) best.pop();
        }
      }
      nb1[i] = best[Math.floor(Math.random() * best.length)]![1];
      nb2[i] = best[Math.floor(Math.random() * best.length)]![1];
    }
  }

  const DUST = compact ? 0 : W < 700 ? 70 : 150;
  const dust = Array.from({ length: DUST }, () => ({
    x: Math.random(),
    y: Math.random(),
    z: 0.15 + Math.random() * 0.85,
    s: (Math.random() - 0.5) * 0.004,
  }));
  const rings: { t0: number; dir: number }[] = [];
  let lastRing = 0;
  let cyCur: number | null = null;

  const cur: Look = { ...STATES.ready };
  let gx = 0;
  let gy = 0;
  let tx = 0;
  let ty = 0;
  let audioLevel = 0;
  let lastT = performance.now() / 1000;
  const born = lastT;

  const onPointerMove = (e: PointerEvent) => {
    tx = (e.clientX / window.innerWidth) * 2 - 1;
    ty = (e.clientY / window.innerHeight) * 2 - 1;
  };
  window.addEventListener("pointermove", onPointerMove);

  let raf = 0;
  function frame(nowMs: number) {
    const t = nowMs / 1000;
    const dt = Math.max(0, Math.min(0.05, t - lastT));
    lastT = t;
    if (compact && document.hidden) {
      raf = requestAnimationFrame(frame);
      return;
    }

    /* ease parameters toward the target state */
    const uiState = host.state();
    const intensity = host.intensity();
    const spectrum = voiceSpectrum();
    const analyser = spectrum?.analyser ?? null;
    const freq = spectrum?.freq ?? null;
    const base = STATES[uiState] || STATES.ready;
    const mod = compact ? compact.life.update(t, dt, audioLevel) : null;
    const target: Look = {
      ...(intensity > 0
        ? {
            ...base,
            ...ALERT,
            jit: 0.006,
            amp: Math.max(base.amp, 0.1),
            glow: 1,
          }
        : base),
      ...(mod?.look ?? {}),
    };
    const k = 1 - Math.exp(-dt * 3);
    for (const key of Object.keys(target) as (keyof Look)[]) {
      if (key === "h") {
        const diff = ((target.h - cur.h + 540) % 360) - 180;
        cur.h = (cur.h + diff * k + 360) % 360;
      } else {
        cur[key] += (target[key] - cur[key]) * k;
      }
    }

    const birthRaw = Math.max(
      0,
      Math.min(1, (t - born) / (reduceMotion ? 0.6 : compact ? 1.2 : 3.4)),
    );
    const birth = 1 - Math.pow(1 - birthRaw, 3);

    gx += (tx - gx) * 0.04;
    gy += (ty - gy) * 0.04;

    /* voice energy */
    let level = 0;
    const speaking = uiState === "speaking";
    if (speaking && analyser && freq) {
      analyser.getByteFrequencyData(freq);
      let sum = 0;
      for (let i = 0; i < freq.length; i++) sum += freq[i];
      level = sum / freq.length / 255;
    } else if (speaking) {
      level = 0.28 + 0.18 * Math.sin(t * 9) * Math.sin(t * 3.1);
    }
    audioLevel += (level - audioLevel) * 0.25;
    const useBands = speaking && analyser && freq;

    /* geometry */
    let cx = W / 2;
    let cy = compact ? H / 2 : H * (W < 700 ? 0.37 : 0.4);
    // Compact: the radius is a fixed share of the canvas, so the ready look fills it the way the big one fills the screen.
    const span = compact
      ? Math.min(W, H) * 1.6
      : W < 700
        ? W * 1.5
        : Math.min(W, H * 1.15);
    const heartbeat =
      intensity > 0 ? 1 + 0.045 * Math.pow(Math.sin(t * 4.2), 2) : 1;
    const breath = 1 + 0.018 * Math.sin(t * 0.9) * MOTION;
    let R = span * cur.r * heartbeat * breath * (0.35 + 0.65 * birth);

    /* make room: it lifts away as the reply grows */
    if (!compact) {
      const stageTop = host.stage?.()?.getBoundingClientRect().top ?? H;
      const baseCy = cy;
      const wantCy = Math.max(
        H * 0.3,
        Math.min(baseCy, stageTop - R * 1.15 - 16),
      );
      cyCur =
        cyCur === null
          ? wantCy
          : cyCur + (wantCy - cyCur) * (1 - Math.exp(-dt * 4));
      if (Math.abs(wantCy - cyCur) < 0.05) cyCur = wantCy;
      cy = cyCur;
      R *=
        1 -
        0.3 * Math.min(1, Math.max(0, (baseCy - cy) / (baseCy - H * 0.3 + 1)));
    } else if (mod) {
      R *= mod.grow;
      cx += mod.ox * R;
      cy += mod.oy * R;
    }
    const squashX = mod ? mod.sx : 1;
    const squashY = mod ? mod.sy : 1;
    const dim = mod ? mod.dim : 1;
    const yaw = t * cur.spin * MOTION + gx * 0.55;
    const pitch = 0.25 + gy * 0.3;
    const cY = Math.cos(yaw);
    const sY = Math.sin(yaw);
    const cP = Math.cos(pitch);
    const sP = Math.sin(pitch);
    const amp = cur.amp * MOTION;
    const scatter = (1 - birth) * 3.2;

    g.clearRect(0, 0, W, H);

    /* atmosphere */
    const hue = cur.h;
    const halo = g.createRadialGradient(
      cx,
      cy,
      0,
      cx,
      cy,
      compact ? Math.min(R * 2.4, W / 2) : R * 2.4,
    );
    halo.addColorStop(
      0,
      `hsla(${hue},${cur.s}%,${cur.l}%,${(0.1 + 0.22 * cur.glow * birth + audioLevel * 0.2) * dim})`,
    );
    halo.addColorStop(1, `hsla(${hue},${cur.s}%,${cur.l}%,0)`);
    g.globalCompositeOperation = "lighter";
    g.fillStyle = halo;
    g.fillRect(0, 0, W, H);

    /* drifting dust gives the room depth */
    for (const d of dust) {
      d.y -= (0.004 + d.z * 0.01) * dt * MOTION;
      d.x += d.s * dt * MOTION * 4;
      if (d.y < 0) d.y += 1;
      if (d.x < 0) d.x += 1;
      if (d.x > 1) d.x -= 1;
      const a =
        (0.1 + 0.3 * d.z) * (0.5 + 0.5 * Math.sin(t * 0.8 + d.x * 40)) * birth;
      const sz = 0.6 + d.z * 1.4;
      g.fillStyle = `hsla(${hue},40%,86%,${a})`;
      g.fillRect(d.x * W - gx * d.z * 28, d.y * H - gy * d.z * 20, sz, sz);
    }

    /* HUD rings, the instrument around the entity */
    const hudA = cur.hud * birth;
    const wide = W >= 1340;
    const ro = compact
      ? Math.min(R * 1.55, Math.min(W, H) * 0.4)
      : Math.max(R * 1.7, Math.min(R * 2.3, W / 2 - (wide ? 300 : 20)));
    const spinK = 0.04 + cur.spin * 0.15;
    g.lineCap = "butt";

    if (!compact) {
      /* ticks */
      const r1 = ro * 0.66;
      g.strokeStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${0.4 * hudA})`;
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i < 120; i++) {
        const a = (i / 120) * Math.PI * 2 + t * spinK * MOTION;
        const len = i % 10 === 0 ? 11 : i % 5 === 0 ? 7 : 3.5;
        g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        g.lineTo(cx + Math.cos(a) * (r1 + len), cy + Math.sin(a) * (r1 + len));
      }
      g.stroke();

      /* segmented band */
      const r2 = ro * 0.79;
      g.lineWidth = 5;
      g.strokeStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${(0.14 + 0.1 * cur.glow) * hudA})`;
      const rot2 = -t * (0.12 + cur.spin * 0.3) * MOTION;
      for (let i = 0; i < 5; i++) {
        const a0 = rot2 + (i / 5) * Math.PI * 2;
        g.beginPath();
        g.arc(cx, cy, r2, a0, a0 + Math.PI * 2 * 0.15);
        g.stroke();
      }
      g.lineWidth = 1;
      g.strokeStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${0.25 * hudA})`;
      g.beginPath();
      g.arc(cx, cy, r2 - 9, 0, Math.PI * 2);
      g.stroke();

      /* fine dashes */
      const r3 = ro * 0.9;
      g.setLineDash([2, 7]);
      g.lineDashOffset = -t * 6 * MOTION;
      g.strokeStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${0.32 * hudA})`;
      g.beginPath();
      g.arc(cx, cy, r3, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    if (!compact) {
      /* radar: every virtual machine is a blip; distance from the center is fixed,
       * size and brightness follow its CPU. The sweep makes a blip flash as it passes. */
      const vms = guests();
      if (vms.length) {
        const rb = ro * 0.845;
        const sweep = (t * (0.5 + cur.spin * 0.8) * MOTION) % (Math.PI * 2);
        for (let k = 0; k < 10; k++) {
          const a1 = sweep - k * 0.07;
          g.beginPath();
          g.arc(cx, cy, ro * 0.9, a1 - 0.07, a1);
          g.arc(cx, cy, ro * 0.7, a1, a1 - 0.07, true);
          g.closePath();
          g.fillStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${0.08 * (1 - k / 10) * hudA})`;
          g.fill();
        }
        g.lineWidth = 1;
        g.strokeStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${0.4 * hudA})`;
        g.beginPath();
        g.moveTo(
          cx + Math.cos(sweep) * ro * 0.7,
          cy + Math.sin(sweep) * ro * 0.7,
        );
        g.lineTo(
          cx + Math.cos(sweep) * ro * 0.9,
          cy + Math.sin(sweep) * ro * 0.9,
        );
        g.stroke();
        for (let i = 0; i < vms.length; i++) {
          const vm = vms[i]!;
          const ang =
            -Math.PI / 2 + (i / vms.length) * Math.PI * 2 + t * 0.02 * MOTION;
          const x = cx + Math.cos(ang) * rb;
          const y = cy + Math.sin(ang) * rb;
          let behind = (sweep - ang) % (Math.PI * 2);
          if (behind < 0) behind += Math.PI * 2;
          const pulse = behind < 1.1 ? 1 - behind / 1.1 : 0;
          const hot = vm.vmid === dashboard.hotVmid;
          const up = vm.status === "running";
          const size = (2.2 + ((vm.cpu || 0) / 100) * 5) * (hot ? 1.7 : 1);
          if (up) {
            g.fillStyle = `hsla(${hue},${cur.s}%,${Math.min(92, cur.l + 14)}%,${(0.45 + 0.55 * pulse) * hudA})`;
            g.beginPath();
            g.arc(x, y, size + pulse * 1.5, 0, Math.PI * 2);
            g.fill();
          } else {
            g.strokeStyle = `hsla(${hue},20%,70%,${0.45 * hudA})`;
            g.beginPath();
            g.arc(x, y, 3, 0, Math.PI * 2);
            g.stroke();
          }
          if (hot) {
            g.strokeStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${0.8 * hudA})`;
            g.beginPath();
            g.arc(x, y, size + 6, 0, Math.PI * 2);
            g.stroke();
            g.font = '300 12px "Sora", system-ui, sans-serif';
            g.fillStyle = `hsla(${hue},30%,95%,${hudA})`;
            g.textAlign = x < cx ? "right" : "left";
            g.fillText(vm.name, x + (x < cx ? -14 : 14), y + 4);
          }
        }
      }
    }

    /* outer ring with a live arc */
    g.strokeStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${0.2 * hudA})`;
    g.beginPath();
    g.arc(cx, cy, ro, 0, Math.PI * 2);
    g.stroke();
    let arcLen = Math.PI / 6;
    let arcRot = t * 0.15 * MOTION;
    if (speaking) {
      arcLen = Math.min(Math.PI * 1.9, 0.5 + audioLevel * 7);
      arcRot = -Math.PI / 2;
    } else if (uiState === "thinking" || uiState === "executing") {
      arcLen = Math.PI / 3;
      arcRot = t * 2.4 * MOTION;
    } else if (uiState === "listening") {
      arcLen = Math.PI * (0.5 + 0.25 * Math.sin(t * 2));
      arcRot = -Math.PI / 2 - arcLen / 2;
    }
    g.lineWidth = compact ? 1.5 : 2.5;
    g.lineCap = "round";
    g.strokeStyle = `hsla(${hue},${cur.s}%,${Math.min(90, cur.l + 12)}%,${0.85 * hudA})`;
    g.beginPath();
    g.arc(cx, cy, ro, arcRot, arcRot + arcLen);
    g.stroke();
    g.lineCap = "butt";

    /* north marker */
    if (!compact) {
      g.fillStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${0.8 * hudA})`;
      g.beginPath();
      g.moveTo(cx, cy - ro - 4);
      g.lineTo(cx - 5, cy - ro - 13);
      g.lineTo(cx + 5, cy - ro - 13);
      g.closePath();
      g.fill();
    }
    /* connectors out to the panels */
    if (wide && !compact) {
      const lx = 36 + 240 + 12;
      g.strokeStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${0.22 * hudA})`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(lx, cy);
      g.lineTo(cx - ro - 6, cy);
      g.moveTo(cx + ro + 6, cy);
      g.lineTo(W - lx, cy);
      g.stroke();
      g.fillStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${0.6 * hudA})`;
      g.fillRect(lx - 2, cy - 2, 4, 4);
      g.fillRect(W - lx - 2, cy - 2, 4, 4);
    }

    /* rings: sound leaves it while speaking, attention flows in while listening */
    if (speaking && audioLevel > 0.2 && t - lastRing > 0.4) {
      rings.push({ t0: t, dir: 1 });
      lastRing = t;
    } else if (uiState === "listening" && t - lastRing > 1.3) {
      rings.push({ t0: t, dir: -1 });
      lastRing = t;
    }
    if (rings.length > 6) rings.shift();
    g.lineWidth = 1;
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      const age = (t - ring.t0) / 1.7;
      if (age >= 1) {
        rings.splice(i, 1);
        continue;
      }
      // Compact: the rings stay inside the small canvas.
      const span2 = compact ? 0.45 : 1;
      const rad =
        ring.dir > 0
          ? R * (1.1 + age * 1.2 * span2)
          : R * (1.1 + (1 - age) * 1.0 * span2 + (compact ? 0 : 0));
      g.strokeStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${(1 - age) * 0.32})`;
      g.beginPath();
      g.arc(
        cx,
        cy,
        compact ? Math.min(rad, Math.min(W, H) * 0.46) : rad,
        0,
        Math.PI * 2,
      );
      g.stroke();
    }

    /* orbits: scanning arcs while it works */
    if (cur.orb > 0.02) {
      for (let k = 0; k < 2; k++) {
        g.save();
        g.translate(cx, cy);
        g.rotate(t * (0.45 + 0.25 * k) * (k ? -1 : 1) * MOTION + k * 1.3);
        const orx = compact
          ? Math.min(R * (1.3 + 0.22 * k), Math.min(W, H) * 0.44)
          : R * (1.3 + 0.22 * k);
        const ory = orx * (0.3 + 0.12 * k);
        const a0 = t * (1.6 + k * 0.7) * MOTION;
        const len = Math.PI * (0.9 + 0.3 * Math.sin(t * 0.7 + k));
        g.beginPath();
        g.ellipse(0, 0, orx, ory, 0, a0, a0 + len);
        g.strokeStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${0.45 * cur.orb * birth})`;
        g.lineWidth = 1.2;
        g.stroke();
        g.fillStyle = `hsla(${hue},${cur.s}%,92%,${0.9 * cur.orb * birth})`;
        g.beginPath();
        g.arc(
          Math.cos(a0 + len) * orx,
          Math.sin(a0 + len) * ory,
          2.4,
          0,
          Math.PI * 2,
        );
        g.fill();
        g.restore();
      }
    }

    /* project points */
    const spreadRipple = cur.ripple;
    for (let i = 0; i < N; i++) {
      const x = px[i];
      const y = py[i];
      const z = pz[i];
      const sd = seed[i];

      const n =
        (Math.sin(x * 2.3 + t * 0.6 + Math.sin(y * 1.7 + t * 0.5)) +
          Math.sin(y * 2.9 - t * 0.5 + x + sd * 0.4) +
          Math.sin(z * 2.6 + t * 0.4 + y)) /
        3;
      let d = 1 + amp * 1.6 * n;
      if (spreadRipple > 0.01)
        d += 0.06 * spreadRipple * MOTION * Math.sin(t * 3.2 + y * 5);
      if (cur.wave > 0.01)
        d +=
          0.1 *
          cur.wave *
          MOTION *
          Math.sin(y * 9 - t * 6) *
          Math.max(0, 0.3 + x * 0.2);
      if (useBands) {
        const band =
          freq[
            Math.min(
              freq.length - 1,
              Math.floor(Math.abs(y) * freq.length * 0.7),
            )
          ] / 255;
        d += band * 0.34;
      } else if (speaking) {
        d += audioLevel * 0.3 * (0.5 + 0.5 * Math.sin(y * 6 + t * 7 + sd * 6));
      }
      if (cur.jit > 0.0005) d += cur.jit * Math.sin(t * 40 + sd * 50) * MOTION;
      d += scatter * (sd - 0.4);

      const x1 = x * cY + z * sY;
      const z1 = -x * sY + z * cY;
      const y1 = y * cP - z1 * sP;
      const z2 = y * sP + z1 * cP;

      const persp = 1 / (1 - z2 * d * 0.26);
      sx[i] = cx + x1 * d * R * persp * squashX;
      sy[i] = cy + y1 * d * R * persp * squashY;
      sz[i] = z2;
      if (mod?.shape) {
        const mix = Math.max(0, Math.min(1, mod.shapeMix ?? 0));
        const [targetX, targetY] = particleShapePoint(mod.shape, i / N);
        const thickness = (sd - 0.5) * (mod.shape === "mist" ? 0.8 : 0.13);
        const angle = mod.spin ?? 0;
        const mx = targetX + thickness;
        const my = targetY + thickness * Math.sin(i * 1.7);
        const targetScreenX =
          cx + (mx * Math.cos(angle) - my * Math.sin(angle)) * R;
        const targetScreenY =
          cy + (mx * Math.sin(angle) + my * Math.cos(angle)) * R;
        sx[i] += (targetScreenX - sx[i]) * mix;
        sy[i] += (targetScreenY - sy[i]) * mix;
        sz[i] += (0.5 - sz[i]) * mix;
      }
    }

    /* filaments */
    g.lineWidth = compact ? 0.6 : 0.7;
    g.strokeStyle = `hsla(${hue},${cur.s}%,${cur.l}%,${(0.05 + 0.09 * cur.glow) * (compact ? 2.4 : 1) * birth})`;
    g.beginPath();
    for (let i = 0; i < N; i++) {
      if (sz[i] < -0.15) continue;
      const a = nb1[i];
      const b = nb2[i];
      if (sz[a] > -0.15) {
        g.moveTo(sx[i], sy[i]);
        g.lineTo(sx[a], sy[a]);
      }
      if (sz[b] > -0.15) {
        g.moveTo(sx[i], sy[i]);
        g.lineTo(sx[b], sy[b]);
      }
    }
    g.stroke();

    /* particles */
    for (let i = 0; i < N; i++) {
      const depth = (sz[i] + 1) / 2;
      const alpha =
        (0.12 + 0.88 * depth) * (0.4 + 0.6 * cur.glow) * birth * dim;
      const size =
        (0.6 + 1.7 * depth) *
        (1 + audioLevel * 0.6) *
        (compact ? Math.max(0.35, Math.min(W, H) / 80) * 0.42 : 1);
      g.fillStyle = `hsla(${hue + depth * 24 + seed[i] * 26 - 13},${cur.s}%,${cur.l - 6 + depth * 10}%,${alpha})`;
      g.fillRect(sx[i] - size / 2, sy[i] - size / 2, size, size);
    }

    /* nucleus: it looks where you look */
    const nx = cx + gx * R * 0.14;
    const ny = cy + gy * R * 0.14;
    const nr =
      R *
      ((compact ? 0.3 : 0.2) + 0.1 * audioLevel + 0.025 * Math.sin(t * 1.7)) *
      birth;
    const nuc = g.createRadialGradient(nx, ny, 0, nx, ny, nr * 2.6);
    nuc.addColorStop(
      0,
      `hsla(${hue},${Math.max(30, cur.s - 40)}%,96%,${0.85 * birth * dim})`,
    );
    nuc.addColorStop(
      0.25,
      `hsla(${hue},${cur.s}%,${cur.l}%,${0.45 * birth * dim})`,
    );
    nuc.addColorStop(1, `hsla(${hue},${cur.s}%,${cur.l}%,0)`);
    g.fillStyle = nuc;
    g.beginPath();
    g.arc(nx, ny, nr * 2.6, 0, Math.PI * 2);
    g.fill();
    compact?.life.overlay?.(g, cx, cy, R);
    g.globalCompositeOperation = "source-over";

    /* click target follows the body */
    // A fixed size in whole pixels: the body breathes, the thing you press does not.
    const hit = Math.round(span * STATES.ready.r * 1.7);
    const core = compact ? null : host.core?.();
    if (core) {
      core.style.left = `${Math.round(cx - hit / 2)}px`;
      core.style.top = `${Math.round(cy - hit / 2)}px`;
      core.style.width = `${hit}px`;
      core.style.height = `${hit}px`;
    }

    /* the panels (voice equaliser) read the voice from here */
    if (!compact) {
      voiceLevel.level = audioLevel;
      voiceLevel.speaking = speaking;
      voiceLevel.bands = useBands ? freq : null;
    }

    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    watch?.disconnect();
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointermove", onPointerMove);
  };
}
