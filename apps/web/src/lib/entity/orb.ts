import type { UiState } from "#lib/stores/chat.svelte.ts";
import { voiceSpectrum } from "#lib/voice/audio.ts";
import { STATES } from "./states.ts";

/**
 * The small NOVA orb of the helper: the same character as the big entity (a particle sphere whose colour and
 * motion are its state), cut down to ~110 particles so it costs next to nothing in a 44 px corner.
 */
export interface OrbHost {
  canvas: HTMLCanvasElement;
  state(): UiState;
  /** Open confirmations and warnings: the orb turns red and beats while this is above zero. */
  intensity(): number;
}

const COUNT = 110;
const FRAME_MS = 1000 / 30;

export function startOrb(host: OrbHost): () => void {
  const canvas = host.canvas;
  const g = canvas.getContext("2d")!;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let size = 0;
  const fit = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = canvas.clientWidth || 44;
    canvas.width = canvas.height = Math.round(size * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  window.addEventListener("resize", fit);

  // Fibonacci sphere: evenly spread, no lattice showing.
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points = Array.from({ length: COUNT }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / COUNT;
    const r = Math.sqrt(1 - y * y);
    return { x: Math.cos(i * golden) * r, y, z: Math.sin(i * golden) * r };
  });

  let angle = 0;
  let level = 0;
  let last = 0;
  let frame = 0;
  const bytes = new Uint8Array(32);

  const draw = (now: number) => {
    frame = requestAnimationFrame(draw);
    if (document.hidden || now - last < FRAME_MS) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    const state = host.state();
    const alert = host.intensity() > 0;
    const look = STATES[state] ?? STATES.ready;
    const hue = alert ? 10 : look.h;
    const lightness = alert ? 62 : look.l;

    // NOVA's own voice moves the orb while it speaks.
    const spectrum = voiceSpectrum();
    let target = 0;
    if (state === "speaking" && spectrum) {
      spectrum.analyser.getByteFrequencyData(spectrum.freq);
      for (let i = 0; i < bytes.length; i++) target += spectrum.freq[i] ?? 0;
      target /= bytes.length * 255;
    } else if (state === "speaking") {
      target = 0.35 + 0.25 * Math.sin(now / 120);
    }
    level += (target - level) * 0.3;

    angle += dt * look.spin * 2.2 * (reduceMotion ? 0.3 : 1);
    const beat = alert ? 0.06 * Math.sin(now / 160) : 0;
    const pulse = 1 + look.amp * Math.sin(now / 700) + level * 0.35 + beat;
    const radius = size * 0.34 * pulse;
    const middle = size / 2;

    g.clearRect(0, 0, size, size);
    const halo = g.createRadialGradient(
      middle,
      middle,
      0,
      middle,
      middle,
      size / 2,
    );
    halo.addColorStop(
      0,
      `hsla(${hue} ${look.s}% ${lightness}% / ${0.1 + look.glow * 0.25})`,
    );
    halo.addColorStop(1, `hsla(${hue} ${look.s}% ${lightness}% / 0)`);
    g.fillStyle = halo;
    g.fillRect(0, 0, size, size);

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const p of points) {
      const x = p.x * cos - p.z * sin;
      const z = p.x * sin + p.z * cos;
      const depth = (z + 1) / 2;
      g.fillStyle = `hsla(${hue} ${look.s}% ${lightness}% / ${0.25 + depth * 0.75})`;
      const dot = 0.6 + depth * 1.1;
      g.fillRect(
        middle + x * radius - dot / 2,
        middle + p.y * radius - dot / 2,
        dot,
        dot,
      );
    }
  };
  frame = requestAnimationFrame(draw);

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", fit);
  };
}
