import { syncStoredVoiceProfile } from "#lib/voice/voice-preference.ts";
import { getJson, sendJson } from "#lib/api/client.ts";
import {
  getHelperPreferences,
  helperPreferenceWrites,
} from "#lib/api/settings.ts";
import { storage } from "#lib/util/storage.ts";
import {
  SHARED_CLIENT_KEYS,
  preferenceChanges,
  type ClientPreferences,
} from "#lib/util/client-preferences.ts";
import { helper } from "./helper.svelte.ts";
import { shell } from "./shell.svelte.ts";
import { lightSync, refreshLightSync } from "./light-sync.svelte.ts";
import { setWake } from "#lib/voice/wake.ts";
import { quietWallpaper } from "#lib/modes/wallpaper.ts";
import { applyVolume, playback } from "#lib/voice/audio.ts";

/** Polling also reaches separate WebView2/browser storage profiles, without a permanent new connection. */
export function startPreferenceSync(): () => void {
  let disposed = false;
  let running = false;
  let initialized = false;
  let baseline: ClientPreferences = {};
  let nextPull = 0;
  let helperSnapshot = "";
  const applied: ClientPreferences = {};
  const read = (): ClientPreferences =>
    Object.fromEntries(
      SHARED_CLIENT_KEYS.flatMap((key) => {
        const value = storage.get(key, "");
        return value ? [[key, value]] : [];
      }),
    );
  function apply(values: ClientPreferences) {
    for (const key of SHARED_CLIENT_KEYS) {
      const value = values[key];
      if (value === undefined) continue;
      if (storage.get(key, "") !== value) storage.set(key, value);
      if (applied[key] === value) continue;
      applied[key] = value;
      if (key === "novaWake" && !quietWallpaper && !shell.wakeSuspended)
        setWake(value === "on");
      if (key === "novaVoiceAlerts") shell.voiceAlerts = value !== "off";
      if (key === "novaPanels") shell.panels = value !== "off";
      if (key === "novaVolume" && playback.current)
        applyVolume(playback.current);
      if (key === "novaConversationLanguage")
        window.dispatchEvent(new Event("nova-conversation-language-changed"));
      if (key === "nova.light-sync") {
        try {
          const saved = JSON.parse(value) as {
            enabled?: boolean;
            areaId?: string;
          };
          lightSync.enabled = saved.enabled === true;
          lightSync.areaId =
            typeof saved.areaId === "string" ? saved.areaId : "";
          void refreshLightSync();
        } catch {
          /* Malformed legacy preference keeps the current light choice. */
        }
      }
    }
    window.dispatchEvent(new Event("nova-preferences-synced"));
  }
  async function tick() {
    if (disposed || running) return;
    running = true;
    try {
      const current = read();
      const changes = initialized
        ? preferenceChanges(current, baseline)
        : current;
      const hasChanges = Object.keys(changes).length > 0;
      if (!initialized || hasChanges || Date.now() >= nextPull) {
        const result = hasChanges
          ? await sendJson<{ values: ClientPreferences }>(
              "PUT",
              "/settings/client-preferences",
              {
                values: changes,
                ...(!initialized ? { initialize: true } : {}),
              },
            )
          : await getJson<{ values: ClientPreferences }>(
              "/settings/client-preferences",
              { signal: AbortSignal.timeout(5000) },
            );
        if (disposed) return;
        // Preserve edits made while the request was in flight. They will be patched on the next tick.
        const edits = preferenceChanges(read(), current);
        apply({ ...result.values, ...edits });
        baseline = {
          ...read(),
          ...Object.fromEntries(
            Object.keys(edits).map((key) => [key, current[key] ?? ""]),
          ),
        };
        initialized = true;
        nextPull = Date.now() + 5000;
        await syncStoredVoiceProfile();
        if (disposed) return;
        window.dispatchEvent(new Event("nova-preferences-synced"));
        const helperRevision = helperPreferenceWrites.revision;
        const prefs = await getHelperPreferences();
        if (disposed) return;
        const snapshot = JSON.stringify(prefs);
        if (
          snapshot !== helperSnapshot &&
          helperPreferenceWrites.pending === 0 &&
          helperRevision === helperPreferenceWrites.revision &&
          !document.activeElement?.closest("[data-helper-live]")
        ) {
          helper.shape = prefs.shape;
          helper.cues = prefs.cues;
          if (prefs.notifications) helper.notifications = prefs.notifications;
          if (prefs.rituals) helper.rituals = prefs.rituals;
          if (prefs.wardrobe) helper.wardrobe = prefs.wardrobe;
          window.dispatchEvent(
            new CustomEvent("nova-helper-preferences-synced", {
              detail: prefs,
            }),
          );
          helperSnapshot = snapshot;
        }
      }
    } catch {
      /* Keep the last choice during an outage; the next tick retries. */
    } finally {
      running = false;
    }
  }
  const focus = () => {
    nextPull = 0;
    void tick();
  };
  const timer = setInterval(() => void tick(), 1000);
  const stored = (event: StorageEvent) => {
    if (
      !event.key ||
      !SHARED_CLIENT_KEYS.includes(
        event.key as (typeof SHARED_CLIENT_KEYS)[number],
      ) ||
      event.newValue === null
    )
      return;
    // A different localStorage client owns the server write; apply its state without echoing it.
    const latest = storage.get(event.key, "");
    baseline[event.key] = latest;
    apply({ [event.key]: latest });
  };
  window.addEventListener("storage", stored);
  window.addEventListener("focus", focus);
  void tick();
  return () => {
    disposed = true;
    clearInterval(timer);
    window.removeEventListener("focus", focus);
    window.removeEventListener("storage", stored);
  };
}
