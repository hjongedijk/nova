import { storage } from "#lib/util/storage.ts";
import type { AssistantMood } from "#lib/stores/chat.svelte.ts";

export const TTS_VOICES = [
  { id: "nl-NL-FennaNeural", label: "Fenna (Nederlands)" },
  { id: "nl-NL-ColetteNeural", label: "Colette (Nederlands)" },
  { id: "nl-BE-DenaNeural", label: "Dena (Vlaams)" },
] as const;
export type TtsVoiceId = (typeof TTS_VOICES)[number]["id"];
const DEFAULT_VOICE: TtsVoiceId = "nl-NL-FennaNeural";
const KEY = "novaTtsVoice";
const RATE_KEY = "novaTtsRate";
const PITCH_KEY = "novaTtsPitch";

export function ttsVoice(): TtsVoiceId {
  const saved = storage.get(KEY, DEFAULT_VOICE);
  return TTS_VOICES.some((voice) => voice.id === saved)
    ? (saved as TtsVoiceId)
    : DEFAULT_VOICE;
}

export function saveTtsVoice(voice: string): TtsVoiceId {
  const selected = TTS_VOICES.some((item) => item.id === voice)
    ? (voice as TtsVoiceId)
    : DEFAULT_VOICE;
  storage.set(KEY, selected);
  return selected;
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

export function saveTtsProsody(rate: number, pitch: number): TtsProsody {
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
  return selected;
}
