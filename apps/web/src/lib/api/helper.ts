import { sendJson } from "./client.ts";

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
