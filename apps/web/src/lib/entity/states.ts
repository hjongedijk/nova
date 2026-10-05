import type { UiState } from "#lib/stores/chat.svelte.ts";

/** Look and motion of the sphere per state (hue, saturation, lightness, radius, ripple, ...). */
export interface Look {
  h: number;
  s: number;
  l: number;
  r: number;
  amp: number;
  spin: number;
  glow: number;
  wave: number;
  jit: number;
  ripple: number;
  orb: number;
  hud: number;
}

export const STATES: Record<UiState, Look> = {
  ready: {
    h: 190,
    s: 88,
    l: 70,
    r: 0.19,
    amp: 0.05,
    spin: 0.07,
    glow: 0.45,
    wave: 0,
    jit: 0,
    ripple: 0,
    orb: 0,
    hud: 0.55,
  },
  listening: {
    h: 42,
    s: 95,
    l: 70,
    r: 0.235,
    amp: 0.07,
    spin: 0.04,
    glow: 0.8,
    wave: 0,
    jit: 0,
    ripple: 1,
    orb: 0.35,
    hud: 0.8,
  },
  thinking: {
    h: 262,
    s: 90,
    l: 72,
    r: 0.165,
    amp: 0.15,
    spin: 0.5,
    glow: 0.9,
    wave: 0,
    jit: 0.012,
    ripple: 0,
    orb: 1,
    hud: 1,
  },
  executing: {
    h: 140,
    s: 80,
    l: 64,
    r: 0.185,
    amp: 0.1,
    spin: 0.35,
    glow: 0.85,
    wave: 1,
    jit: 0,
    ripple: 0,
    orb: 1,
    hud: 1,
  },
  speaking: {
    h: 335,
    s: 90,
    l: 78,
    r: 0.21,
    amp: 0.05,
    spin: 0.1,
    glow: 0.8,
    wave: 0,
    jit: 0,
    ripple: 0,
    orb: 0,
    hud: 0.85,
  },
};

/** The tint while a confirmation or a warning is waiting. */
export const ALERT = { h: 12, s: 100, l: 64 };

export const MODE_LABELS: Record<UiState, string> = {
  ready: "Gereed",
  listening: "Ik luister",
  thinking: "Ik denk na",
  executing: "Ik voer uit",
  speaking: "Ik spreek",
};

/** The page's --glow colour for a state (buttons and accents follow the entity). */
export function glowColor(state: UiState): string {
  const look = STATES[state] ?? STATES.ready;
  return `hsl(${look.h} ${look.s}% ${look.l}%)`;
}
