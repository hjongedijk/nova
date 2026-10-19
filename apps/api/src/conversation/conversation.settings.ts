import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";

export interface ConversationSettings {
  version: 1;
  /** Master switch; default OFF. */
  enabled: boolean;
  language: "nl" | "en";
  greeting: string;
  /** Secret that Asterisk's dialplan sends as the AudioSocket id; only that connection is accepted. */
  secretUuid: string;
  idleSeconds: number;
  maxMinutes: number;
}

const DEFAULTS = (): ConversationSettings => ({
  version: 1,
  enabled: false,
  language: "nl",
  greeting: "Hallo, met Nova. Waarmee kan ik je helpen?",
  secretUuid: crypto.randomUUID(),
  idleSeconds: 25,
  maxMinutes: 10,
});

/** conversation-settings.json (mode 0600), written atomically. */
@Injectable()
export class ConversationSettingsStore {
  private cached?: ConversationSettings;
  constructor(private readonly config: NovaConfig) {}

  private get file(): string {
    return this.config.dataFile("conversation-settings.json");
  }

  get(): ConversationSettings {
    if (this.cached) return this.cached;
    let value = DEFAULTS();
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.file, "utf8"),
      ) as Partial<ConversationSettings>;
      value = {
        ...value,
        ...raw,
        version: 1,
        language: raw.language === "en" ? "en" : "nl",
        greeting:
          typeof raw.greeting === "string" && raw.greeting.trim()
            ? raw.greeting.trim().slice(0, 200)
            : value.greeting,
        idleSeconds: clamp(raw.idleSeconds, 5, 60, 25),
        maxMinutes: clamp(raw.maxMinutes, 1, 60, 10),
        secretUuid:
          typeof raw.secretUuid === "string" &&
          /^[0-9a-f-]{36}$/.test(raw.secretUuid)
            ? raw.secretUuid
            : value.secretUuid,
        enabled: raw.enabled === true,
      };
    } catch {
      /* first run: defaults, saved on the first change */
    }
    this.cached = value;
    return value;
  }

  update(
    change: Partial<
      Pick<
        ConversationSettings,
        "enabled" | "language" | "greeting" | "idleSeconds" | "maxMinutes"
      >
    >,
  ): ConversationSettings {
    const next = { ...this.get() };
    if (typeof change.enabled === "boolean") next.enabled = change.enabled;
    if (change.language === "nl" || change.language === "en")
      next.language = change.language;
    if (typeof change.greeting === "string" && change.greeting.trim())
      next.greeting = change.greeting.trim().slice(0, 200);
    if (change.idleSeconds !== undefined)
      next.idleSeconds = clamp(change.idleSeconds, 5, 60, next.idleSeconds);
    if (change.maxMinutes !== undefined)
      next.maxMinutes = clamp(change.maxMinutes, 1, 60, next.maxMinutes);
    this.write(next);
    this.cached = next;
    return next;
  }

  private write(value: ConversationSettings): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(value, null, 1), {
      mode: 0o600,
    });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }
}

function clamp(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(max, Math.max(min, value)))
    : fallback;
}
