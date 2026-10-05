import { Injectable, Logger } from "@nestjs/common";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { ValidationError } from "../core/errors/validation.error.js";

export const TTS_VOICE = "nl-NL-MaartenNeural";
// A little slower and lower than the default: less robotic.
const PROSODY = { rate: "-3%", pitch: "-2Hz", volume: "+0%" } as const;
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
  engine: (text: string) => Promise<Buffer> = (text) => this.synthesize(text);

  health() {
    return { ok: true, voice: TTS_VOICE, ...PROSODY };
  }

  async speak(raw: unknown): Promise<{ audio: Buffer; cached: boolean }> {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text)
      throw new ValidationError(["Er is tekst nodig om uit te spreken."]);
    if (text.length > TTS_MAX_CHARS)
      throw new ValidationError(["De tekst is te lang."]);
    const hit = this.cache.get(text);
    if (hit) {
      this.cache.delete(text);
      this.cache.set(text, hit);
      return { audio: hit, cached: true };
    }
    const audio = await this.engine(text);
    if (!audio.length) throw new Error("No audio");
    this.cache.set(text, audio);
    while (this.cache.size > this.cacheSize)
      this.cache.delete(this.cache.keys().next().value as string);
    return { audio, cached: false };
  }

  private async synthesize(text: string): Promise<Buffer> {
    // One connection per request: the service drops idle connections after a while.
    const tts = new MsEdgeTTS();
    await tts.setMetadata(
      TTS_VOICE,
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
    );
    const { audioStream } = tts.toStream(text, PROSODY);
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
