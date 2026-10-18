import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";

export interface VoiceProfile {
  /** An edge voice id or the Piper voice; undefined means the server default. */
  voice?: string;
  rate: number;
  pitch: number;
}

const DEFAULT_RATE = -3;
const DEFAULT_PITCH = -2;
const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(min, Math.min(max, value)))
    : fallback;
// Edge ids ("nl-NL-MaartenNeural") and the Piper voice ("jarvis-en-GB-piper"), whose prefix is longer than a locale.
const VOICE_ID = /^[A-Za-z]{2,6}-[A-Za-z0-9-]{2,40}$/;

/**
 * The voice NOVA uses on the phone and in spoken conversations. The browser keeps its own copy in local storage, so the
 * settings screen mirrors every change here (voice-profile.json, mode 0600); otherwise calls could never sound like it.
 */
@Injectable()
export class VoiceProfileStore {
  private cached?: VoiceProfile;
  constructor(private readonly config: NovaConfig) {}

  private get file(): string {
    return this.config.dataFile("voice-profile.json");
  }

  get(): VoiceProfile {
    if (this.cached) return this.cached;
    let profile: VoiceProfile = { rate: DEFAULT_RATE, pitch: DEFAULT_PITCH };
    try {
      profile = this.clean(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      /* not set yet: server defaults */
    }
    this.cached = profile;
    return profile;
  }

  set(input: unknown): VoiceProfile {
    const profile = this.clean(input);
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(profile), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    this.cached = profile;
    return profile;
  }

  private clean(input: unknown): VoiceProfile {
    const row =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const voice =
      typeof row.voice === "string" && VOICE_ID.test(row.voice)
        ? row.voice
        : undefined;
    return {
      ...(voice ? { voice } : {}),
      rate: clamp(row.rate, -10, 10, DEFAULT_RATE),
      pitch: clamp(row.pitch, -5, 5, DEFAULT_PITCH),
    };
  }
}
