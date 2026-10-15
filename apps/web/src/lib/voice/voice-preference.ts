import { storage } from "#lib/util/storage.ts";
import type { AssistantMood } from "#lib/stores/chat.svelte.ts";
import { publishLocalPreferenceReceipt } from "#lib/util/local-preference-receipts.ts";

export const TTS_VOICES = [
  { id: "en-US-GuyNeural", label: "Guy · Engels (VS)" },
  { id: "en-US-JennyNeural", label: "Jenny · Engels (VS)" },
  { id: "en-GB-RyanNeural", label: "Ryan · Engels (VK)" },
  { id: "en-GB-SoniaNeural", label: "Sonia · Engels (VK)" },
  { id: "de-DE-ConradNeural", label: "Conrad · Duits" },
  { id: "de-DE-KatjaNeural", label: "Katja · Duits" },
  { id: "fr-FR-HenriNeural", label: "Henri · Frans" },
  { id: "fr-FR-DeniseNeural", label: "Denise · Frans" },
  { id: "es-ES-AlvaroNeural", label: "Álvaro · Spaans" },
  { id: "es-ES-ElviraNeural", label: "Elvira · Spaans" },
  { id: "it-IT-DiegoNeural", label: "Diego · Italiaans" },
  { id: "it-IT-ElsaNeural", label: "Elsa · Italiaans" },
  { id: "pt-BR-AntonioNeural", label: "Antônio · Portugees (Brazilië)" },
  { id: "pt-BR-FranciscaNeural", label: "Francisca · Portugees (Brazilië)" },
  { id: "ja-JP-KeitaNeural", label: "Keita · Japans" },
  { id: "ja-JP-NanamiNeural", label: "Nanami · Japans" },
  { id: "nl-NL-MaartenNeural", label: "Maarten · Nederlands" },
  { id: "nl-NL-FennaNeural", label: "Fenna (Nederlands)" },
  { id: "nl-NL-ColetteNeural", label: "Colette (Nederlands)" },
  { id: "nl-BE-DenaNeural", label: "Dena (Vlaams)" },
  { id: "jarvis-en-GB-piper", label: "Engels (lokale Piper-stem)" },
] as const;
export type TtsVoiceId = (typeof TTS_VOICES)[number]["id"];
const DEFAULT_VOICE: TtsVoiceId = "nl-NL-FennaNeural";
let serverDefaultVoice: TtsVoiceId = DEFAULT_VOICE;
const KEY = "novaTtsVoice";
const RATE_KEY = "novaTtsRate";
const PITCH_KEY = "novaTtsPitch";

export function ttsVoice(): TtsVoiceId {
  const saved = storage.get(KEY, "");
  return TTS_VOICES.some((voice) => voice.id === saved)
    ? (saved as TtsVoiceId)
    : serverDefaultVoice;
}

/** Health supplies the configured default for settings and recognition. */
export function setServerDefaultVoice(voice: string | undefined): void {
  if (TTS_VOICES.some((item) => item.id === voice))
    serverDefaultVoice = voice as TtsVoiceId;
}

/** Omit the voice for default speech so the API applies TTS_VOICE. */
export function ttsVoiceForSpeech(
  language?: "nl" | "en",
): TtsVoiceId | undefined {
  const saved = storage.get(KEY, "");
  const explicit = TTS_VOICES.find((voice) => voice.id === saved)?.id;
  if (!language) return explicit;
  if (explicit && localeOf(explicit).startsWith(`${language}-`))
    return explicit;
  if (language === "en") return "en-GB-RyanNeural";
  return explicit ? DEFAULT_VOICE : undefined;
}

export function saveTtsVoice(voice: string): TtsVoiceId {
  const selected = TTS_VOICES.some((item) => item.id === voice)
    ? (voice as TtsVoiceId)
    : DEFAULT_VOICE;
  storage.set(KEY, selected, "tts-voice");
  return selected;
}

function localeOf(voice: TtsVoiceId): string {
  if (voice === "jarvis-en-GB-piper") return "en-GB";
  return voice.split("-").slice(0, 2).join("-");
}

/** Prefer the configured voice when it matches this conversation's language. */
export function ttsVoiceForLanguage(language?: "nl" | "en"): TtsVoiceId {
  const selected = ttsVoice();
  if (!language || localeOf(selected).startsWith(`${language}-`))
    return selected;
  return language === "en" ? "en-GB-RyanNeural" : DEFAULT_VOICE;
}

/** Locale used by recognition; an explicit conversation language overrides the settings voice. */
export function ttsLocale(language?: "nl" | "en"): string {
  return localeOf(ttsVoiceForLanguage(language));
}

export interface TtsProsody {
  rate: number;
  pitch: number;
}

export function ttsProsody(): TtsProsody {
  const rate = Number(storage.get(RATE_KEY, "-3"));
  const pitch = Number(storage.get(PITCH_KEY, "-2"));
  return {
    rate: Number.isFinite(rate)
      ? Math.max(-10, Math.min(10, Math.round(rate)))
      : -3,
    pitch: Number.isFinite(pitch)
      ? Math.max(-5, Math.min(5, Math.round(pitch)))
      : -2,
  };
}

const MOOD_ADJUSTMENT: Record<AssistantMood, TtsProsody> = {
  happy: { rate: 2, pitch: 1 },
  thoughtful: { rate: -1, pitch: -1 },
  concerned: { rate: -2, pitch: -1 },
  enthusiastic: { rate: 2, pitch: 2 },
  neutral: { rate: 0, pitch: 0 },
};

/** Small mood adjustments preserve the user's chosen voice and base prosody. */
export function ttsProsodyForMood(mood: AssistantMood): TtsProsody {
  const base = ttsProsody();
  const adjustment = MOOD_ADJUSTMENT[mood];
  return {
    rate: Math.max(-10, Math.min(10, base.rate + adjustment.rate)),
    pitch: Math.max(-5, Math.min(5, base.pitch + adjustment.pitch)),
  };
}

export function saveTtsProsody(
  rate: number,
  pitch: number,
  recordChange = true,
): TtsProsody {
  const selected = {
    rate: Number.isFinite(rate)
      ? Math.max(-10, Math.min(10, Math.round(rate)))
      : -3,
    pitch: Number.isFinite(pitch)
      ? Math.max(-5, Math.min(5, Math.round(pitch)))
      : -2,
  };
  storage.set(RATE_KEY, String(selected.rate));
  storage.set(PITCH_KEY, String(selected.pitch));
  if (recordChange)
    publishLocalPreferenceReceipt(
      "tts-prosody",
      storage.matches(RATE_KEY, String(selected.rate)) &&
        storage.matches(PITCH_KEY, String(selected.pitch)),
    );
  return selected;
}
