import { Injectable } from "@nestjs/common";
import { DatabaseSync } from "node:sqlite";
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

/**
 * A dedicated speech key must be locked down inside OmniRoute: active, restricted to exactly the speech model and to one
 * active connection of that model's provider. Read-only; checked before every use so a widened key stops speech instead of spending.
 * Returns why the key is not acceptable, or null.
 */
export function sttKeyProblem(
  databasePath: string,
  key: string,
  model: string,
): string | null {
  const provider = model.split("/")[0] ?? "";
  if (!provider || !model.includes("/"))
    return "NOVA_STT_MODEL moet provider/model zijn.";
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const row = db
      .prepare(
        "SELECT model_access_mode,allowed_models,allowed_connections FROM api_keys WHERE key=? AND is_active=1 AND revoked_at IS NULL",
      )
      .get(key) as
      | {
          model_access_mode: string;
          allowed_models: string | null;
          allowed_connections: string | null;
        }
      | undefined;
    if (!row)
      return "De spraaksleutel bestaat niet meer of is ingetrokken in OmniRoute.";
    const models = JSON.parse(row.allowed_models || "null") as unknown;
    const connections = JSON.parse(
      row.allowed_connections || "null",
    ) as unknown;
    if (
      row.model_access_mode !== "restricted" ||
      !Array.isArray(models) ||
      models.length !== 1 ||
      models[0] !== model
    )
      return "De spraaksleutel is niet beperkt tot alleen het spraakmodel; er is niets verstuurd.";
    if (
      !Array.isArray(connections) ||
      connections.length !== 1 ||
      typeof connections[0] !== "string"
    )
      return "De spraaksleutel is niet beperkt tot één providerverbinding; er is niets verstuurd.";
    const connection = db
      .prepare("SELECT provider,is_active FROM provider_connections WHERE id=?")
      .get(connections[0]) as
      { provider: string; is_active: number } | undefined;
    if (
      !connection ||
      connection.is_active !== 1 ||
      connection.provider !== provider
    )
      return "De providerverbinding van de spraaksleutel is niet actief of hoort niet bij het spraakmodel.";
    return null;
  } catch {
    return "De spraaksleutel kon niet worden gecontroleerd; er is niets verstuurd.";
  } finally {
    db?.close();
  }
}

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
  /** Replaceable in tests. */
  keyProblem: typeof sttKeyProblem = sttKeyProblem;

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
    let key = this.config.omniKey;
    if (this.config.sttKey) {
      // A dedicated key is verified directly in OmniRoute's own records on every request.
      const locked = this.keyProblem(
        this.config.omniDatabase,
        this.config.sttKey,
        this.config.sttModel,
      );
      if (locked) return { ok: false, error: locked };
      key = this.config.sttKey;
    } else {
      try {
        this.routing.assertFreeModel(this.config.sttModel);
      } catch {
        return {
          ok: false,
          error:
            "Het spraakmodel valt buiten de geverifieerde gratis sleutelinstelling van OmniRoute; er is niets verstuurd.",
        };
      }
    }
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000);
    const base = this.config.omniUrl.replace(/\/$/, "");
    try {
      const text =
        this.config.sttMode === "chat-audio"
          ? await this.viaChat(base, key, wav, options.language, signal)
          : await this.viaTranscriptions(
              base,
              key,
              wav,
              options.language,
              signal,
            );
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
    key: string,
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
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal,
    });
    if (!response.ok) throw new Error(`stt_${response.status}`);
    const body = (await response.json()) as { text?: unknown };
    return typeof body.text === "string" ? body.text : "";
  }

  private async viaChat(
    base: string,
    key: string,
    wav: Buffer,
    language: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
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
