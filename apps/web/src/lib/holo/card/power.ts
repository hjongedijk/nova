/**
 * When a card stays flat (SVG): reduced motion, a device that asks to save data or is clearly
 * small, a low battery, or no WebGL. The flat card is complete; 3D is a bonus, never a need.
 */
export interface PowerHints {
  reducedMotion: boolean;
  saveData: boolean;
  /** navigator.deviceMemory in GB, when known. */
  memoryGb?: number;
  cores?: number;
  /** Battery state, when the browser tells. */
  battery?: { level: number; charging: boolean };
  /** A function: the WebGL probe itself makes a context, so it only runs when nothing else decides. */
  webgl: boolean | (() => boolean);
}

export type FlatReason = "reduced-motion" | "low-power" | "no-webgl";

export function flatReason(hints: PowerHints): FlatReason | null {
  if (hints.reducedMotion) return "reduced-motion";
  if (
    hints.saveData ||
    (hints.memoryGb !== undefined && hints.memoryGb <= 2) ||
    (hints.cores !== undefined && hints.cores <= 2) ||
    (hints.battery && !hints.battery.charging && hints.battery.level < 0.2)
  )
    return "low-power";
  const webgl = typeof hints.webgl === "function" ? hints.webgl() : hints.webgl;
  if (!webgl) return "no-webgl";
  return null;
}

export const FLAT_REASON_TEXT: Record<FlatReason, string> = {
  "reduced-motion": "Vlakke weergave: beweging is uitgezet.",
  "low-power": "Vlakke weergave: spaarstand of een licht apparaat.",
  "no-webgl": "Vlakke weergave: 3D is hier niet beschikbaar.",
};

interface NavigatorHints {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  connection?: { saveData?: boolean };
  getBattery?: () => Promise<{ level: number; charging: boolean }>;
}

let webglCache: boolean | undefined;
export function hasWebgl(): boolean {
  if (webglCache !== undefined) return webglCache;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    webglCache = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webglCache = false;
  }
  return webglCache;
}

/** Read the hints from the browser (never throws). */
export async function readPowerHints(): Promise<PowerHints> {
  const nav = (
    typeof navigator === "undefined" ? {} : navigator
  ) as NavigatorHints;
  let battery: PowerHints["battery"];
  try {
    const status = await nav.getBattery?.();
    if (status) battery = { level: status.level, charging: status.charging };
  } catch {
    battery = undefined;
  }
  return {
    reducedMotion:
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    saveData: nav.connection?.saveData === true,
    memoryGb: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    battery,
    webgl: () => typeof document !== "undefined" && hasWebgl(),
  };
}

/** At most this many 3D cards at once (WebGL contexts are scarce); the rest stay flat. */
export const MAX_3D_CARDS = 2;
let active = 0;
export const claim3d = (): boolean =>
  active < MAX_3D_CARDS ? (active++, true) : false;
export const release3d = (): void => {
  active = Math.max(0, active - 1);
};
