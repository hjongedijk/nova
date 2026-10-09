import { SvelteDate } from "svelte/reactivity";
import { storage } from "#lib/util/storage.ts";
import type { OrbEvent } from "#lib/entity/orb.ts";
import {
  HELPER_CUE_NAMES,
  type CuePreferences,
} from "#lib/voice/helper-cues.ts";

export const helper = $state({
  wardrobe: { theme: "nova", seasonal: false, birthday: "" } as {
    theme: "nova" | "violet" | "gold";
    seasonal: boolean;
    birthday: string;
  },
  shape: "orb" as "orb" | "ring" | "mist",
  event: "greet" as OrbEvent,
  eventId: 0,
  cues: {
    enabled: true,
    volume: 0.35,
    theme: "soft",
    quiet: { enabled: false, start: "22:00", end: "07:00" },
  } as CuePreferences,
});
let nextEvent = 0;
export function animateHelper(event: OrbEvent): void {
  helper.event = event;
  helper.eventId = ++nextEvent;
}
export function loadHelperPreferences(): void {
  try {
    const value: unknown = JSON.parse(
      storage.get("nova.helper.personality", "{}"),
    );
    if (!value || typeof value !== "object") return;
    const saved = value as Record<string, unknown>;
    if (["orb", "ring", "mist"].includes(String(saved.shape)))
      helper.shape = saved.shape as typeof helper.shape;
    if (saved.wardrobe && typeof saved.wardrobe === "object") {
      const wardrobe = saved.wardrobe as Record<string, unknown>;
      if (
        ["nova", "violet", "gold"].includes(String(wardrobe.theme)) &&
        typeof wardrobe.seasonal === "boolean" &&
        typeof wardrobe.birthday === "string" &&
        (wardrobe.birthday === "" ||
          /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(wardrobe.birthday))
      )
        helper.wardrobe = wardrobe as typeof helper.wardrobe;
    }
    if (saved.cues && typeof saved.cues === "object") {
      const cues = saved.cues as Record<string, unknown>;
      if (cues.cues && typeof cues.cues === "object") {
        helper.cues.cues = {};
        for (const [key, value] of Object.entries(cues.cues))
          if (
            HELPER_CUE_NAMES.includes(
              key as (typeof HELPER_CUE_NAMES)[number],
            ) &&
            typeof value === "boolean"
          )
            helper.cues.cues[key as (typeof HELPER_CUE_NAMES)[number]] = value;
      }
      if (typeof cues.enabled === "boolean") helper.cues.enabled = cues.enabled;
      if (typeof cues.volume === "number" && Number.isFinite(cues.volume))
        helper.cues.volume = Math.min(1, Math.max(0, cues.volume));
      if (["soft", "playful", "minimal"].includes(String(cues.theme)))
        helper.cues.theme = cues.theme as CuePreferences["theme"];
      if (cues.quiet && typeof cues.quiet === "object") {
        const quiet = cues.quiet as Record<string, unknown>;
        if (
          typeof quiet.enabled === "boolean" &&
          typeof quiet.start === "string" &&
          typeof quiet.end === "string"
        )
          helper.cues.quiet = {
            enabled: quiet.enabled,
            start: quiet.start,
            end: quiet.end,
          };
      }
    }
  } catch {
    /* Damaged browser preferences retain defaults. */
  }
}
export function saveHelperPreferences(): void {
  storage.set(
    "nova.helper.personality",
    JSON.stringify({
      shape: helper.shape,
      cues: helper.cues,
      wardrobe: helper.wardrobe,
    }),
  );
}

/** Optional date accents use only a birthday explicitly supplied in settings. */
export function helperHue(now = new SvelteDate()): number {
  const base = { nova: 190, violet: 270, gold: 42 }[helper.wardrobe.theme];
  if (!helper.wardrobe.seasonal) return base;
  const date = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (helper.wardrobe.birthday === date) return 42;
  if (now.getMonth() === 11 && now.getDate() >= 20 && now.getDate() <= 26)
    return 140;
  if ([11, 0, 1].includes(now.getMonth())) return 210;
  return base;
}
