import { Injectable } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";
import { RoutingService } from "../routing/routing.service.js";

export type SttResult =
  { ok: true; text: string } | { ok: false; error: string; retry?: boolean };

export interface SttPort {
  /** Why speech recognition cannot run, or null. */
  unavailable(): string | null;
  transcribe(
    wav: Buffer,
    options: { language: "nl" | "en"; signal?: AbortSignal },
  ): Promise<SttResult>;
}
export const STT_PORT = Symbol("nova:stt-port");

const HINT = "Nova, Jarvis, Home Assistant, Proxmox, Sonos, Spotify, Linphone.";

/** Known Whisper hallucinations on silence or noise; never treated as something the caller said. */
const HALLUCINATIONS = [
  /^\W*(ondertitels? (ingediend )?door|ondertiteld door|subtitles? by|amara\.org)/i,
  /^\W*(bedankt voor het (kijken|luisteren)|thanks? for watching|thank you for watching)\W*$/i,
  /^\W*(tot de volgende keer|see you (next time|in the next))\W*$/i,
  /^\W*(thank you|thanks|dank je wel|bedankt|you)\W*$/i,
  /^\W*[.…\-–,!? ]*\W*$/,
];

export function cleanTranscript(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text.length < 2) return "";
  return HALLUCINATIONS.some((pattern) => pattern.test(text)) ? "" : text;
}

/**
 * Speech to text through OmniRoute. The model must come from NOVA_STT_MODEL, be declared free
 * (NOVA_STT_FREE_VERIFIED) and be inside the verified free key scope on every request; otherwise
 * nothing is sent. Credentials never leave OmniRoute, and there is no local model.
 */
@Injectable()
export class OmniRouteStt implements SttPort {
  constructor(
    private readonly config: NovaConfig,
    private readonly routing: RoutingService,
  ) {}

  unavailable(): string | null {
    if (!this.config.sttModel || !this.config.sttFreeVerified)
      return "Spraakherkenning is niet ingesteld: kies een gratis model (NOVA_STT_MODEL) en bevestig dat het gratis is (NOVA_STT_FREE_VERIFIED=true).";
    if (!this.config.omniKey) return "OmniRoute is niet geconfigureerd.";
    return null;
  }

  async transcribe(
    wav: Buffer,
    options: { language: "nl" | "en"; signal?: AbortSignal },
  ): Promise<SttResult> {
    const problem = this.unavailable();
    if (problem) return { ok: false, error: problem };
    try {
      this.routing.assertFreeModel(this.config.sttModel);
    } catch {
      return {
        ok: false,
        error:
          "Het spraakmodel valt buiten de geverifieerde gratis sleutelinstelling van OmniRoute; er is niets verstuurd.",
      };
    }
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000);
    const base = this.config.omniUrl.replace(/\/$/, "");
    try {
      const text =
        this.config.sttMode === "chat-audio"
          ? await this.viaChat(base, wav, options.language, signal)
          : await this.viaTranscriptions(base, wav, options.language, signal);
      return { ok: true, text: cleanTranscript(text) };
    } catch (error) {
      const aborted = (error as Error)?.name === "AbortError";
      return {
        ok: false,
        retry: !aborted,
        error: aborted
          ? "Spraakherkenning duurde te lang."
          : "Spraakherkenning is nu niet beschikbaar.",
      };
    }
  }

  private async viaTranscriptions(
    base: string,
    wav: Buffer,
    language: string,
    signal: AbortSignal,
  ): Promise<string> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
      "speech.wav",
    );
    form.append("model", this.config.sttModel);
    form.append("language", language);
    form.append("prompt", HINT);
    form.append("response_format", "json");
    const response = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.omniKey}` },
      body: form,
      signal,
    });
    if (!response.ok) throw new Error(`stt_${response.status}`);
    const body = (await response.json()) as { text?: unknown };
    return typeof body.text === "string" ? body.text : "";
  }

  private async viaChat(
    base: string,
    wav: Buffer,
    language: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.omniKey}`,
      },
      body: JSON.stringify({
        model: this.config.sttModel,
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Transcribe this ${language === "nl" ? "Dutch" : "English"} speech exactly, with normal punctuation. Output only the words that were spoken. If there is no speech, output nothing. Names that may occur: ${HINT}`,
              },
              {
                type: "input_audio",
                input_audio: { data: wav.toString("base64"), format: "wav" },
              },
            ],
          },
        ],
      }),
      signal,
    });
    if (!response.ok) throw new Error(`stt_${response.status}`);
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }
}
