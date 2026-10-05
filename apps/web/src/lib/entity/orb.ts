import type { UiState } from "#lib/stores/chat.svelte.ts";
import { startEntity, type Life, type Modulation } from "./entity.ts";
import type { Look } from "./states.ts";

/**
 * The helper's small orb is the main entity (entity.ts) in compact mode: the same renderer, palette, filaments,
 * nucleus, rings and state colours, with fewer particles and no HUD. This file only adds LIFE on top, as
 * modulation of that renderer: breathing, drifting and blinking when idle, leaning in while listening, an
 * orbiting "hmm" while thinking, a pulse with its speech, a nervous orange bounce while a question waits, a hop
 * with sparkles when done, a shake in red on an error, a look toward the pointer and a squash when clicked.
 * Everything moves on springs, nothing snaps.
 */
export interface OrbHost {
  canvas: HTMLCanvasElement;
  state(): UiState;
  /** Open confirmations and warnings: the orb waits nervously in orange while this is above zero. */
  intensity(): number;
}

export type OrbEvent = "done" | "error" | "nudge";
export interface OrbHandle {
  stop(): void;
  /** A one-off reaction: a happy hop with sparkles, a shake in red, or a nudge for attention. */
  trigger(event: OrbEvent): void;
}

const TAU = Math.PI * 2;
const WAITING: Partial<Look> = { h: 24, s: 96, l: 64 };
const ERROR: Partial<Look> = { h: 4, s: 92, l: 60, jit: 0.01 };

/** A damped spring: follows `target` with a little overshoot. */
class Spring {
  x: number;
  v = 0;
  constructor(x = 0) {
    this.x = x;
  }
  step(target: number, dt: number, k = 140, c = 15): number {
    this.v += (-k * (this.x - target) - c * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

interface Spark {
  vx: number;
  vy: number;
  age: number;
}

export function startOrb(host: OrbHost): OrbHandle {
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.3 : 1;

  const squash = new Spring(0); // + wider and flatter, - taller
  const hop = new Spring(0); // vertical offset in radii (negative is up)
  const lookX = new Spring(0);
  const lookY = new Spring(0);
  const grow = new Spring(1);
  let blinkAt = 0;
  let blinkStart = -1e9;
  let nudgeAt = 0;
  let shakeUntil = 0;
  let errorUntil = 0;
  let waitingBefore = false;
  let pointer = { x: 0, y: 0 };
  const sparks: Spark[] = [];

  const onMove = (event: PointerEvent) => {
    const box = host.canvas.getBoundingClientRect();
    const far = Math.max(60, window.innerWidth / 2);
    pointer = {
      x: Math.max(
        -1,
        Math.min(1, (event.clientX - (box.left + box.width / 2)) / far),
      ),
      y: Math.max(
        -1,
        Math.min(1, (event.clientY - (box.top + box.height / 2)) / far),
      ),
    };
  };
  const onLeave = () => (pointer = { x: 0, y: 0 });
  const onDown = () => {
    squash.v = 9; // squash flat, then spring back with a stretch
  };
  window.addEventListener("pointermove", onMove);
  document.addEventListener("pointerleave", onLeave);
  host.canvas.addEventListener("pointerdown", onDown);

  function trigger(event: OrbEvent): void {
    const now = performance.now();
    if (event === "done") {
      hop.v = -7;
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * TAU + Math.random() * 0.4;
        const s = 0.7 + Math.random() * 0.9;
        sparks.push({ vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.4, age: 0 });
      }
    } else if (event === "error") {
      shakeUntil = now + 550;
      errorUntil = now + 1400;
    } else {
      hop.v = -3.5;
      squash.v = -4;
    }
  }

  const life: Life = {
    update(t, dt, level): Modulation {
      const now = t * 1000;
      if (blinkAt === 0) {
        blinkAt = now + 2500;
        nudgeAt = now + 6000;
      }
      const state = host.state();
      const waiting = host.intensity() > 0 && state === "ready";

      // Breathing, plus what each state asks for.
      let want = 1 + 0.03 * Math.sin(t * 1.6) * calm;
      if (state === "listening") want += 0.07 + 0.035 * Math.sin(t * 4) * calm; // leans in, attentive
      if (state === "thinking") want += 0.06 * Math.sin(t * 5) * calm; // contract and expand
      if (state === "speaking") want += level * 0.1 - 0.12; // its own displacement already swells the cloud
      if (waiting) want += 0.02 * Math.sin(t * 7) * calm;
      // Blink: a quick contraction and dim, every few seconds at random.
      if (now >= blinkAt) {
        blinkStart = now;
        blinkAt = now + 2500 + Math.random() * 4500;
      }
      const phase = (now - blinkStart) / 190;
      const blink = phase >= 0 && phase <= 1 ? Math.sin(phase * Math.PI) : 0;
      want *= 1 - 0.13 * blink * calm;

      // A nudge for attention while a question waits.
      if (waiting && !waitingBefore) nudgeAt = now + 800;
      if (waiting && now >= nudgeAt) {
        trigger("nudge");
        nudgeAt = now + 6000;
      }
      waitingBefore = waiting;

      const sq = squash.step(0, dt, 170, 11);
      const lift = hop.step(0, dt, 120, 9);
      lookX.step(pointer.x * 0.35, dt, 90, 13);
      lookY.step(pointer.y * 0.35, dt, 90, 13);

      const shake =
        now < shakeUntil
          ? Math.sin(now / 16) * 0.3 * ((shakeUntil - now) / 550)
          : 0;
      const wobble = state === "thinking" ? Math.sin(t * 9) * 0.08 * calm : 0;
      const lean = state === "listening" ? -0.1 : 0; // up toward the user

      return {
        grow: grow.step(want, dt),
        sx: 1 + sq * 0.12,
        sy: 1 - sq * 0.12,
        ox: Math.sin(t * 0.5) * 0.12 * calm + shake + wobble + lookX.x,
        oy: Math.cos(t * 0.37) * 0.09 * calm + lift * 0.4 + lean + lookY.x,
        dim: 1 - 0.5 * blink,
        look: now < errorUntil ? ERROR : waiting ? WAITING : undefined,
      };
    },
    overlay(g, cx, cy, R) {
      // Sparkles after a finished answer.
      const dt = 1 / 60;
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i]!;
        s.age += dt;
        if (s.age > 0.8) {
          sparks.splice(i, 1);
          continue;
        }
        const d = R * (1.1 + s.age * 1.8);
        g.fillStyle = `rgba(255, 224, 140, ${1 - s.age / 0.8})`;
        g.beginPath();
        g.arc(cx + s.vx * d, cy + s.vy * d + s.age * s.age * R, 1.3, 0, TAU);
        g.fill();
      }
    },
  };

  const stopEntity = startEntity({
    canvas: host.canvas,
    state: host.state,
    intensity: host.intensity,
    compact: { life },
  });

  return {
    stop() {
      stopEntity();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      host.canvas.removeEventListener("pointerdown", onDown);
    },
    trigger,
  };
}
