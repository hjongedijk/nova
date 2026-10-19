/** Shared choices only. Hardware identifiers and chat sessions stay local. */
export const SHARED_CLIENT_KEYS = [
  "novaVolume",
  "novaWake",
  "novaWakeSensitivity",
  "novaVoiceAlerts",
  "novaPanels",
  "nova.light-sync",
  "novaPronunciations",
  "novaConversationLanguage",
] as const;
export type ClientPreferences = Record<string, string>;

/** Patch only actual edits; unchanged stale clients never overwrite another client's choice. */
export function preferenceChanges(
  current: ClientPreferences,
  baseline: ClientPreferences,
): ClientPreferences {
  return Object.fromEntries(
    SHARED_CLIENT_KEYS.flatMap((key) =>
      current[key] !== undefined && current[key] !== baseline[key]
        ? [[key, current[key]!]]
        : [],
    ),
  );
}
