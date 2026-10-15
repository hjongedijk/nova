import { publishSettingsReceipt } from "../api/settings-receipt-events.ts";

const preferences = {
  "tts-voice": "Spreekstem",
  "tts-prosody": "Spreektempo en toonhoogte",
  "wake-sensitivity": "Gevoeligheid van het wekwoord",
  pronunciations: "Uitspraakregels",
  "audio-input": "Microfoonkeuze",
  "audio-output": "Geluidsuitvoer",
  "conversation-language": "Gesprekstaal",
  volume: "Geluidsvolume",
  wake: "Wekwoordherkenning",
  "voice-alerts": "Gesproken meldingen",
  panels: "Zijpanelen",
  "light-sync": "Lichtsynchronisatie",
  "communication-style": "Onthouden gespreksvoorkeuren",
  "helper-preferences": "Lokale helpervoorkeuren",
} as const;

export type LocalPreferenceReceiptKind = keyof typeof preferences;
let sequence = 0;

/** Receipts describe browser storage only; device values and names never enter the card. */
export function publishLocalPreferenceReceipt(
  kind: LocalPreferenceReceiptKind,
  stored: boolean,
): void {
  if (!Object.hasOwn(preferences, kind)) return;
  const label = preferences[kind];
  const confirmed = stored === true;
  const recoverHref = [
    "tts-voice",
    "tts-prosody",
    "wake-sensitivity",
    "pronunciations",
    "volume",
  ].includes(kind)
    ? "/settings?section=voice"
    : undefined;
  publishSettingsReceipt({
    id: `local-settings-${Date.now()}-${++sequence}`,
    requested: `${label} aanpassen`,
    performed: confirmed
      ? `${label}: keuze op dit apparaat opgeslagen`
      : `${label}: opslag niet bevestigd`,
    verification: confirmed
      ? "Browseropslag opnieuw gelezen en gecontroleerd. Hardware, spraak en server niet gecontroleerd."
      : "Browseropslag niet bevestigd. Hardware, spraak en server niet gecontroleerd.",
    ...(recoverHref ? { recoverHref } : {}),
  });
}
