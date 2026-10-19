import { Body, Controller, Get, Put } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";
import { readJsonState, writeJsonState } from "../core/db/json-state.js";
import { ValidationError } from "../core/errors/validation.error.js";

/** Global presentation preferences shared by the website, wallpaper and helper.
 * Device credentials, microphone IDs and conversation IDs remain outside this document.
 */
export const CLIENT_PREFERENCE_KEYS = [
  "novaVolume",
  "novaWake",
  "novaWakeSensitivity",
  "novaVoiceAlerts",
  "novaPanels",
  "nova.light-sync",
  "novaPronunciations",
  "novaConversationLanguage",
] as const;

const ALLOWED_KEYS = new Set<string>(CLIENT_PREFERENCE_KEYS);
const MAX_VALUE_BYTES = 8 * 1024;
const MAX_DOCUMENT_BYTES = 32 * 1024;
type Values = Record<string, string>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

@Controller("settings/client-preferences")
export class ClientPreferencesController {
  private readonly file: string;

  constructor(config: NovaConfig) {
    this.file = config.dataFile("client-preferences.json");
  }

  @Get()
  get(): { values: Values } {
    const stored = readJsonState(this.file);
    const values: Values = {};
    // Project only known presentation keys, even if an older document contains extra fields.
    if (record(stored) && record(stored.values)) {
      for (const key of CLIENT_PREFERENCE_KEYS) {
        const value = stored.values[key];
        if (
          typeof value === "string" &&
          Buffer.byteLength(value, "utf8") <= MAX_VALUE_BYTES
        )
          values[key] = value;
      }
    }
    return { values };
  }

  @Put()
  put(@Body() body: unknown): { values: Values } {
    if (
      !record(body) ||
      Object.keys(body).some(
        (key) => key !== "values" && key !== "initialize",
      ) ||
      !record(body.values) ||
      (body.initialize !== undefined && typeof body.initialize !== "boolean")
    )
      throw new ValidationError(["Ongeldige gedeelde voorkeuren."]);

    for (const [key, value] of Object.entries(body.values)) {
      if (
        !ALLOWED_KEYS.has(key) ||
        typeof value !== "string" ||
        Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES
      )
        throw new ValidationError(["Onbekende of te grote gedeelde voorkeur."]);
    }

    if (
      Buffer.byteLength(JSON.stringify(body.values), "utf8") >
      MAX_DOCUMENT_BYTES
    )
      throw new ValidationError([
        "De gedeelde voorkeuren zijn samen te groot.",
      ]);

    // Read and merge synchronously: separate clients changing different fields retain both edits.
    const { values } = this.get();
    for (const [key, value] of Object.entries(body.values)) {
      if (body.initialize === true && Object.hasOwn(values, key)) continue;
      values[key] = value as string;
    }
    if (Buffer.byteLength(JSON.stringify(values), "utf8") > MAX_DOCUMENT_BYTES)
      throw new ValidationError([
        "De gedeelde voorkeuren zijn samen te groot.",
      ]);

    writeJsonState(this.file, { values }, "dir");
    return { values };
  }
}
