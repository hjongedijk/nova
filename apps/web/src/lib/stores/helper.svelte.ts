import { SvelteDate } from "svelte/reactivity";
import { storage } from "#lib/util/storage.ts";
import { lightSync } from "./light-sync.svelte.ts";
import type { OrbEvent } from "#lib/entity/orb.ts";
import type { NotificationModes } from "@nova/contracts";
import type { HelperPreferences } from "@nova/contracts";
import {
  HELPER_CUE_NAMES,
  type CuePreferences,
} from "#lib/voice/helper-cues.ts";

export const helper = $state({
  avatar: "orb" as "face" | "orb",
  wardrobe: { theme: "nova", seasonal: false, birthday: "" } as {
    theme: "nova" | "violet" | "gold";
    seasonal: boolean;
    birthday: string;
  },
  shape: "orb" as "orb" | "ring" | "mist",
  notifications: {
    info: "helper",
    briefing: "speak",
    warning: "speak",
    critical: "speak",
    timer: "speak",
  } as NotificationModes,
  rituals: {
    morning: { enabled: false, time: "08:00" },
    evening: { enabled: false, time: "22:00" },
    checkIn: { enabled: false, afterHours: 4 },
    weeklyOverview: { enabled: false, time: "18:00" },
    dailyHighlight: { enabled: false, time: "20:00" },
    smallSurprises: { enabled: false },
    welcomeHome: { enabled: false },
    calendarReminders: { enabled: false, minutesBefore: 15 },
  } as NonNullable<HelperPreferences["rituals"]>,
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
    // Retired face preferences must not reactivate the rejected humanoid.
    helper.avatar = "orb";
    if (["orb", "ring", "mist"].includes(String(saved.shape)))
      helper.shape = saved.shape as typeof helper.shape;
    if (saved.notifications && typeof saved.notifications === "object") {
      const notifications = saved.notifications as Record<string, unknown>;
      for (const kind of [
        "info",
        "briefing",
        "warning",
        "critical",
        "timer",
      ] as const)
        if (["screen", "helper", "speak"].includes(String(notifications[kind])))
          helper.notifications[kind] = notifications[kind] as
            "screen" | "helper" | "speak";
    }
    if (saved.rituals && typeof saved.rituals === "object") {
      const rituals = saved.rituals as Record<string, unknown>;
      for (const kind of ["morning", "evening"] as const) {
        const value = rituals[kind];
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>;
        if (
          typeof item.enabled === "boolean" &&
          typeof item.time === "string" &&
          /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time)
        )
          helper.rituals[kind] = { enabled: item.enabled, time: item.time };
      }
      const checkIn = rituals.checkIn;
      if (checkIn && typeof checkIn === "object") {
        const item = checkIn as Record<string, unknown>;
        if (
          typeof item.enabled === "boolean" &&
          [3, 4, 6].includes(Number(item.afterHours))
        )
          helper.rituals.checkIn = {
            enabled: item.enabled,
            afterHours: Number(item.afterHours),
          };
      }
      const weeklyOverview = rituals.weeklyOverview;
      if (weeklyOverview && typeof weeklyOverview === "object") {
        const item = weeklyOverview as Record<string, unknown>;
        if (
          typeof item.enabled === "boolean" &&
          typeof item.time === "string" &&
          /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time)
        )
          helper.rituals.weeklyOverview = {
            enabled: item.enabled,
            time: item.time,
          };
      }
      const dailyHighlight = rituals.dailyHighlight;
      if (dailyHighlight && typeof dailyHighlight === "object") {
        const item = dailyHighlight as Record<string, unknown>;
        if (
          typeof item.enabled === "boolean" &&
          typeof item.time === "string" &&
          /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time)
        )
          helper.rituals.dailyHighlight = {
            enabled: item.enabled,
            time: item.time,
          };
      }
      const smallSurprises = rituals.smallSurprises;
      if (smallSurprises && typeof smallSurprises === "object") {
        const item = smallSurprises as Record<string, unknown>;
        if (typeof item.enabled === "boolean")
          helper.rituals.smallSurprises = { enabled: item.enabled };
      }
      const welcomeHome = rituals.welcomeHome;
      if (welcomeHome && typeof welcomeHome === "object") {
        const item = welcomeHome as Record<string, unknown>;
        if (typeof item.enabled === "boolean")
          helper.rituals.welcomeHome = { enabled: item.enabled };
      }
      const calendarReminders = rituals.calendarReminders;
      if (calendarReminders && typeof calendarReminders === "object") {
        const item = calendarReminders as Record<string, unknown>;
        if (
          typeof item.enabled === "boolean" &&
          [5, 15, 30].includes(Number(item.minutesBefore))
        )
          helper.rituals.calendarReminders = {
            enabled: item.enabled,
            minutesBefore: Number(item.minutesBefore) as 5 | 15 | 30,
          };
      }
    }
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
export function saveHelperPreferences(): boolean {
  const value = JSON.stringify({
    avatar: helper.avatar,
    shape: helper.shape,
    notifications: helper.notifications,
    rituals: helper.rituals,
    cues: helper.cues,
    wardrobe: helper.wardrobe,
  });
  storage.set("nova.helper.personality", value);
  return storage.matches("nova.helper.personality", value);
}

/** Optional date accents use only a birthday explicitly supplied in settings. */
export function helperHue(now = new SvelteDate()): number {
  if (lightSync.enabled && lightSync.hue !== null) return lightSync.hue;
  const base = { nova: 190, violet: 270, gold: 42 }[helper.wardrobe.theme];
  if (!helper.wardrobe.seasonal) return base;
  const date = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (helper.wardrobe.birthday === date) return 42;
  if (now.getMonth() === 11 && now.getDate() >= 20 && now.getDate() <= 26)
    return 140;
  if ([11, 0, 1].includes(now.getMonth())) return 210;
  return base;
}
