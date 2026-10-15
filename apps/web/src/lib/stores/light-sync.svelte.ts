import { getJson } from "#lib/api/client.ts";
import { storage } from "#lib/util/storage.ts";

const KEY = "nova.light-sync";
const POLL_MS = 60_000;

interface LightArea {
  areaId: string;
  areaName: string;
  hue: number;
}

export const lightSync = $state({
  enabled: false,
  areaId: "",
  hue: null as number | null,
  areas: [] as LightArea[],
  unavailable: false,
});

let loaded = false;
let requestVersion = 0;
let listeners = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function loadLightSync(): void {
  if (loaded) return;
  loaded = true;
  try {
    const value: unknown = JSON.parse(storage.get(KEY, "{}"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const saved = value as Record<string, unknown>;
    lightSync.enabled = saved.enabled === true;
    if (
      typeof saved.areaId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(saved.areaId)
    )
      lightSync.areaId = saved.areaId;
  } catch {
    // Damaged browser preference leaves synchronization off.
  }
}

export function setLightSync(
  enabled: boolean,
  areaId = lightSync.areaId,
): void {
  loadLightSync();
  lightSync.enabled = enabled;
  lightSync.areaId = /^[A-Za-z0-9_-]{1,128}$/.test(areaId) ? areaId : "";
  lightSync.hue = null;
  lightSync.unavailable = false;
  storage.set(
    KEY,
    JSON.stringify({ enabled: lightSync.enabled, areaId: lightSync.areaId }),
    "light-sync",
  );
  void refreshLightSync();
}

export async function refreshLightSync(): Promise<void> {
  loadLightSync();
  const version = ++requestVersion;
  if (!lightSync.enabled) {
    lightSync.hue = null;
    lightSync.areas = [];
    lightSync.unavailable = false;
    return;
  }
  try {
    const response = await getJson<{ areas?: unknown }>("/home/light-moods");
    if (version !== requestVersion || !lightSync.enabled) return;
    if (!Array.isArray(response.areas)) throw new Error("Invalid light moods");
    const areas = response.areas
      .filter(
        (item): item is LightArea =>
          item &&
          typeof item === "object" &&
          typeof item.areaId === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.test(item.areaId) &&
          typeof item.areaName === "string" &&
          item.areaName.length <= 80 &&
          Number.isInteger(item.hue) &&
          item.hue >= 0 &&
          item.hue < 360,
      )
      .slice(0, 100);
    lightSync.areas = areas;
    lightSync.hue =
      areas.find((area) => area.areaId === lightSync.areaId)?.hue ?? null;
    lightSync.unavailable = false;
  } catch {
    if (version !== requestVersion || !lightSync.enabled) return;
    lightSync.hue = null;
    lightSync.areas = [];
    lightSync.unavailable = true;
  }
}

export function startLightSync(): () => void {
  loadLightSync();
  listeners++;
  if (listeners === 1) {
    void refreshLightSync();
    pollTimer = setInterval(() => void refreshLightSync(), POLL_MS);
  }
  return () => {
    listeners--;
    if (listeners === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}
