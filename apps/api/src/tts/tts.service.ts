import { Injectable, Logger } from "@nestjs/common";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { sanitize } from "../core/security/sanitize.js";
import { ValidationError } from "../core/errors/validation.error.js";

export const TTS_DEFAULT_VOICE = "nl-NL-FennaNeural";
export const TTS_PIPER_VOICE = "jarvis-en-GB-piper";
export const TTS_VOICES = [
  "en-US-GuyNeural",
  "en-US-JennyNeural",
  "en-GB-RyanNeural",
  "en-GB-SoniaNeural",
  "de-DE-ConradNeural",
  "de-DE-KatjaNeural",
  "fr-FR-HenriNeural",
  "fr-FR-DeniseNeural",
  "es-ES-AlvaroNeural",
  "es-ES-ElviraNeural",
  "it-IT-DiegoNeural",
  "it-IT-ElsaNeural",
  "pt-BR-AntonioNeural",
  "pt-BR-FranciscaNeural",
  "ja-JP-KeitaNeural",
  "ja-JP-NanamiNeural",
  "nl-NL-MaartenNeural",
  "nl-NL-FennaNeural",
  "nl-NL-ColetteNeural",
  "nl-BE-DenaNeural",
] as const;
export type TtsVoice = (typeof TTS_VOICES)[number] | typeof TTS_PIPER_VOICE;
const configuredVoice = process.env.TTS_VOICE?.trim();
export const TTS_VOICE: (typeof TTS_VOICES)[number] = TTS_VOICES.includes(
  configuredVoice as (typeof TTS_VOICES)[number],
)
  ? (configuredVoice as (typeof TTS_VOICES)[number])
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
    voice: (typeof TTS_VOICES)[number],
    prosody: { rate: number; pitch: number },
  ) => Promise<Buffer> = (text, voice, prosody) =>
    this.synthesize(text, voice, prosody);

  health() {
    return {
      ok: true,
      voice: TTS_VOICE,
      voices: this.piperUrl() ? [...TTS_VOICES, TTS_PIPER_VOICE] : TTS_VOICES,
      piperAvailable: Boolean(this.piperUrl()),
      ...DEFAULT_PROSODY,
    };
  }

  async speak(
    raw: unknown,
    requestedVoice?: unknown,
    requestedProsody?: unknown,
  ): Promise<{ audio: Buffer; cached: boolean; contentType: string }> {
    const input = typeof raw === "string" ? raw.trim() : "";
    if (input.length > TTS_MAX_CHARS)
      throw new ValidationError(["De tekst is te lang."]);
    const text = sanitize(input);
    if (!text)
      throw new ValidationError(["Er is tekst nodig om uit te spreken."]);
    if (text.length > TTS_MAX_CHARS)
      throw new ValidationError(["De tekst is te lang."]);
    const voice = TTS_VOICES.includes(
      requestedVoice as (typeof TTS_VOICES)[number],
    )
      ? (requestedVoice as TtsVoice)
      : requestedVoice === TTS_PIPER_VOICE && this.piperUrl()
        ? TTS_PIPER_VOICE
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
      return {
        audio: hit,
        cached: true,
        contentType: voice === TTS_PIPER_VOICE ? "audio/wav" : "audio/mpeg",
      };
    }
    const varied = variation(text);
    const audio =
      voice === TTS_PIPER_VOICE
        ? await this.synthesizePiper(text, prosody.rate)
        : await this.engine(text, voice as (typeof TTS_VOICES)[number], {
            rate: clamp(prosody.rate + varied, -10, 10, prosody.rate),
            pitch: clamp(prosody.pitch - varied, -5, 5, prosody.pitch),
          });
    if (!audio.length) throw new Error("No audio");
    this.cache.set(cacheKey, audio);
    while (this.cache.size > this.cacheSize)
      this.cache.delete(this.cache.keys().next().value as string);
    return {
      audio,
      cached: false,
      contentType: voice === TTS_PIPER_VOICE ? "audio/wav" : "audio/mpeg",
    };
  }

  private async synthesizePiper(text: string, rate: number): Promise<Buffer> {
    const piperUrl = this.piperUrl();
    let target: URL;
    try {
      target = new URL(piperUrl);
    } catch {
      throw new Error("NOVA_PIPER_TTS_URL is invalid");
    }
    if (
      target.protocol !== "http:" ||
      target.username ||
      target.password ||
      !["piper", "localhost", "127.0.0.1"].includes(target.hostname) ||
      (target.port && target.port !== "5000") ||
      target.pathname !== "/synthesize"
    ) {
      throw new Error(
        "NOVA_PIPER_TTS_URL must target the private Piper service",
      );
    }
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/wav" },
      body: JSON.stringify({
        text,
        length_scale: Math.max(0.75, Math.min(1.3, 1 - rate / 100)),
      }),
      signal: AbortSignal.timeout(45_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Piper synthesis failed (${response.status})`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 20_000_000)
      throw new Error("Piper audio response is too large");
    const audio = Buffer.from(await response.arrayBuffer());
    if (
      audio.length < 12 ||
      audio.length > 20_000_000 ||
      audio.toString("ascii", 0, 4) !== "RIFF" ||
      audio.toString("ascii", 8, 12) !== "WAVE"
    )
      throw new Error("Piper returned invalid audio");
    return audio;
  }

  private piperUrl(): string {
    return process.env.NOVA_PIPER_TTS_URL?.trim() ?? "";
  }

  private async synthesize(
    text: string,
    voice: (typeof TTS_VOICES)[number],
    prosody: { rate: number; pitch: number },
  ): Promise<Buffer> {
    // One connection per request: the service drops idle connections after a while.
    const tts = new MsEdgeTTS({
      connectionTimeoutMs: 5000,
      synthesisTimeoutMs: 15000,
    });
    const chunks: Buffer[] = [];
    try {
      await tts.setMetadata(
        voice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
      );
      // The API accepts plain text; the SDK interpolates this value into SSML.
      const plain = text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      const { audioStream } = tts.toStream(plain, {
        rate: `${prosody.rate}%`,
        pitch: `${prosody.pitch}Hz`,
        volume: "+0%",
      });
      for await (const chunk of audioStream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch (error) {
      this.log.warn("Speech synthesis stream failed");
      throw error;
    } finally {
      tts.close();
    }
  }
}
