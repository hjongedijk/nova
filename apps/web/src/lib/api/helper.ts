import type { HelperDisplays } from "@nova/contracts";
import { getJson, sendJson } from "./client.ts";

export type HelperView =
  | "compact"
  | "overview"
  | "chat"
  | "weather"
  | "lists"
  | "notifications"
  | "confirmation";

type Resize = { view: HelperView; hidden: boolean; reducedMotion: boolean };
let pending: Resize | null = null;
let running: Promise<void> | null = null;

async function drain(): Promise<void> {
  try {
    while (pending) {
      const next = pending;
      pending = null;
      try {
        await sendJson<{ ok: boolean }>("POST", "/settings/helper/size", next);
      } catch {
        /* A browser preview has no Windows agent. */
      }
    }
  } finally {
    running = null;
  }
}

/** Serialize native resizing; rapid tab changes retain only the latest queued size. */
export function requestHelperSize(
  view: HelperView,
  hidden = false,
): Promise<void> {
  pending = {
    view,
    hidden,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
  running ??= Promise.resolve().then(drain);
  return running;
}

/** The displays the helper can appear on (no PIN needed; the page only moves NOVA's own helper window). */
export const getHelperDisplays = () =>
  getJson<HelperDisplays>("/settings/helper/displays");

/** Move the helper to a display (0 = main display) and remember it. */
export const setHelperDisplay = (display: number) =>
  sendJson<HelperDisplays>("POST", "/settings/helper/display", { display });

/** "Scherm 2 (2560x1440, hoofdscherm)": the label of one display in the menu. */
export function displayLabel(screen: {
  index: number;
  primary: boolean;
  width: number;
  height: number;
}): string {
  return `Scherm ${screen.index} (${screen.width}x${screen.height}${screen.primary ? ", hoofdscherm" : ""})`;
}
