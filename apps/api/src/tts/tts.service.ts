import { Injectable, Logger } from "@nestjs/common";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { ValidationError } from "../core/errors/validation.error.js";

export const TTS_DEFAULT_VOICE = "nl-NL-FennaNeural";
export const TTS_VOICES = [
  "nl-NL-FennaNeural",
  "nl-NL-ColetteNeural",
  "nl-BE-DenaNeural",
] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];
const configuredVoice = process.env.TTS_VOICE?.trim();
export const TTS_VOICE: TtsVoice = TTS_VOICES.includes(
  configuredVoice as TtsVoice,
)
  ? (configuredVoice as TtsVoice)
  : TTS_DEFAULT_VOICE;
// A little slower and lower than the default: less robotic.
const DEFAULT_PROSODY = { rate: -3, pitch: -2 } as const;
const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(min, Math.min(max, value)))
    : fallback;
const variation = (text: string): number => {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (Math.abs(hash) % 3) - 1;
};
export const TTS_MAX_CHARS = 5000;

/**
 * Text to speech with Microsoft's neural voices (edge-tts). Audio is collected in memory and the
 * last sentences are kept, because short ones ("Even kijken", greetings) come back often.
 */
@Injectable()
export class TtsService {
  private readonly log = new Logger("TTS");
  private readonly cache = new Map<string, Buffer>();
  private readonly cacheSize = 64;
  /** Replaceable in tests. */
  engine: (
    text: string,
    voice: TtsVoice,
    prosody: { rate: number; pitch: number },
  ) => Promise<Buffer> = (text, voice, prosody) =>
    this.synthesize(text, voice, prosody);

  health() {
    return {
      ok: true,
      voice: TTS_VOICE,
      voices: TTS_VOICES,
      ...DEFAULT_PROSODY,
    };
  }

  async speak(
    raw: unknown,
    requestedVoice?: unknown,
    requestedProsody?: unknown,
  ): Promise<{ audio: Buffer; cached: boolean }> {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text)
      throw new ValidationError(["Er is tekst nodig om uit te spreken."]);
    if (text.length > TTS_MAX_CHARS)
      throw new ValidationError(["De tekst is te lang."]);
    const voice = TTS_VOICES.includes(requestedVoice as TtsVoice)
      ? (requestedVoice as TtsVoice)
      : TTS_VOICE;
    const options =
      requestedProsody && typeof requestedProsody === "object"
        ? (requestedProsody as Record<string, unknown>)
        : {};
    const prosody = {
      rate: clamp(options.rate, -10, 10, DEFAULT_PROSODY.rate),
      pitch: clamp(options.pitch, -5, 5, DEFAULT_PROSODY.pitch),
    };
    const cacheKey = `${voice}\0${prosody.rate}\0${prosody.pitch}\0${text}`;
    const hit = this.cache.get(cacheKey);
    if (hit) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, hit);
      return { audio: hit, cached: true };
    }
    const varied = variation(text);
    const audio = await this.engine(text, voice, {
      rate: clamp(prosody.rate + varied, -10, 10, prosody.rate),
      pitch: clamp(prosody.pitch - varied, -5, 5, prosody.pitch),
    });
    if (!audio.length) throw new Error("No audio");
    this.cache.set(cacheKey, audio);
    while (this.cache.size > this.cacheSize)
      this.cache.delete(this.cache.keys().next().value as string);
    return { audio, cached: false };
  }

  private async synthesize(
    text: string,
    voice: TtsVoice,
    prosody: { rate: number; pitch: number },
  ): Promise<Buffer> {
    // One connection per request: the service drops idle connections after a while.
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, {
      rate: `${prosody.rate}%`,
      pitch: `${prosody.pitch}Hz`,
      volume: "+0%",
    });
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of audioStream) chunks.push(Buffer.from(chunk));
    } catch (error) {
      this.log.warn(`synthesis failed: ${(error as Error).message}`);
      throw error;
    } finally {
      tts.close();
    }
    return Buffer.concat(chunks);
  }
}
