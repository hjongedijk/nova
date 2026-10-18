import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../errors/validation.error.js";
import { registerSecrets } from "../security/sanitize.js";
import type { NovaConfig } from "./nova-config.js";

/**
 * Operator preferences that used to live only in .env. A value saved here wins over the environment
 * variable, which stays as the fallback default. Stored next to services.json.
 */
export type RuntimeValues = Record<string, string | boolean>;
export interface RuntimeField {
  key: string;
  env: string;
  label: string;
  kind: "text" | "url" | "secret" | "boolean" | "number" | "choice";
  choices?: string[];
  hint?: string;
}
export interface RuntimeGroup {
  id: string;
  label: string;
  fields: RuntimeField[];
}
const f = (
  key: string,
  env: string,
  label: string,
  kind: RuntimeField["kind"] = "text",
  extra: Partial<RuntimeField> = {},
): RuntimeField => ({ key, env, label, kind, ...extra });

export const RUNTIME_GROUPS: RuntimeGroup[] = [
  {
    id: "stt",
    label: "Spraak naar tekst",
    fields: [
      f("model", "NOVA_STT_MODEL", "Model"),
      f("mode", "NOVA_STT_MODE", "Soort", "choice", {
        choices: ["transcriptions", "chat-audio"],
      }),
      f(
        "freeVerified",
        "NOVA_STT_FREE_VERIFIED",
        "Model is gratis bevestigd",
        "boolean",
      ),
      f("key", "NOVA_STT_KEY", "Aparte toegangssleutel", "secret"),
    ],
  },
  {
    id: "embeddings",
    label: "Embeddings",
    fields: [
      f("model", "EMBEDDING_MODEL", "Model"),
      f("dimensions", "EMBEDDING_DIMENSIONS", "Dimensies", "number"),
      f(
        "freeVerified",
        "EMBEDDING_FREE_VERIFIED",
        "Model is gratis bevestigd",
        "boolean",
      ),
    ],
  },
  {
    id: "news",
    label: "Nieuwsbronnen",
    fields: [
      f("feeds", "NOVA_NEWS_FEEDS", "Bronnen (JSON, maximaal vijf)", "text", {
        hint: '[{"name":"NOS","url":"https://feeds.nos.nl/nosnieuwsalgemeen"}]',
      }),
    ],
  },
  {
    id: "ntfy",
    label: "Pushmeldingen (ntfy)",
    fields: [
      f("url", "NTFY_URL", "Adres", "url"),
      f("topic", "NTFY_TOPIC", "Topic"),
      f("token", "NTFY_TOKEN", "Publiceertoken", "secret"),
    ],
  },
  {
    id: "checks",
    label: "Bereikbaarheidscontrole",
    fields: [
      f(
        "targets",
        "NOVA_CHECK_TARGETS",
        "Doelen (naam=adres, komma-gescheiden)",
      ),
    ],
  },
  {
    id: "home",
    label: "Thuislocatie",
    fields: [
      f("latitude", "NOVA_HOME_LAT", "Breedtegraad", "number"),
      f("longitude", "NOVA_HOME_LON", "Lengtegraad", "number"),
    ],
  },
];

export interface RuntimeFile {
  version: 1;
  groups: Record<string, RuntimeValues>;
}
export const runtimeFile = (directory: string) =>
  path.join(directory, "runtime-settings.json");
export function runtimeGroup(id: string): RuntimeGroup {
  const group = RUNTIME_GROUPS.find((item) => item.id === id);
  if (!group) throw new ValidationError(["Onbekende instelling."]);
  return group;
}

export function normalizeRuntime(id: string, input: unknown): RuntimeValues {
  const group = runtimeGroup(id);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ValidationError(["Vul de instelling in als velden."]);
  const result: RuntimeValues = {};
  for (const [key, value] of Object.entries(input)) {
    const field = group.fields.find((item) => item.key === key);
    if (!field) throw new ValidationError(["Onbekend veld."]);
    if (field.kind === "boolean") {
      if (typeof value !== "boolean")
        throw new ValidationError([`${field.label}: kies aan of uit.`]);
      result[key] = value;
      continue;
    }
    if (
      typeof value !== "string" ||
      value.length > (field.kind === "secret" ? 4096 : 2000) ||
      Array.from(value).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      throw new ValidationError([`${field.label}: ongeldige tekst.`]);
    const text = field.kind === "secret" ? value : value.trim();
    if (text) {
      if (field.kind === "choice" && !field.choices?.includes(text))
        throw new ValidationError([`${field.label}: onbekende keuze.`]);
      if (field.kind === "number" && !Number.isFinite(Number(text)))
        throw new ValidationError([`${field.label}: vul een getal in.`]);
      if (field.kind === "url") {
        let url: URL;
        try {
          url = new URL(text);
        } catch {
          throw new ValidationError(["Vul een geldig adres in."]);
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new ValidationError([
            "Gebruik een http(s)-adres zonder wachtwoord, query of fragment.",
          ]);
      }
    }
    if (id === "home" && text) {
      const n = Number(text);
      const limit = key === "latitude" ? 90 : 180;
      if (Math.abs(n) > limit)
        throw new ValidationError([`${field.label}: buiten bereik.`]);
    }
    if (id === "embeddings" && key === "dimensions" && text) {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 0 || n > 8192)
        throw new ValidationError([`${field.label}: kies 0 tot 8192.`]);
    }
    if (id === "news" && text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ValidationError(["Nieuwsbronnen: ongeldige JSON."]);
      }
      if (!Array.isArray(parsed) || parsed.length > 5)
        throw new ValidationError(["Nieuwsbronnen: maximaal vijf bronnen."]);
    }
    result[key] = field.kind === "url" ? text.replace(/\/$/, "") : text;
  }
  registerSecrets(
    group.fields.flatMap((field) => {
      const value = result[field.key];
      return field.kind === "secret" && typeof value === "string" && value
        ? [value]
        : [];
    }),
  );
  return result;
}

export function readRuntime(directory: string): RuntimeFile {
  const file = runtimeFile(directory);
  if (!fs.existsSync(file)) return { version: 1, groups: {} };
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length > 1_000_000) throw new Error("size");
    const data = JSON.parse(raw) as RuntimeFile;
    if (
      data.version !== 1 ||
      !data.groups ||
      typeof data.groups !== "object" ||
      Array.isArray(data.groups)
    )
      throw new Error("shape");
    return {
      version: 1,
      groups: Object.fromEntries(
        Object.entries(data.groups).map(([id, values]) => [
          id,
          normalizeRuntime(id, values),
        ]),
      ),
    };
  } catch {
    throw new Error(
      "De opgeslagen instellingen zijn ongeldig. Herstel runtime-settings.json uit een lokale back-up.",
    );
  }
}

/** A value saved in Settings, or undefined so the environment default applies. */
const saved = (values: RuntimeValues | undefined, key: string) => {
  const value = values?.[key];
  return value === undefined || value === "" ? undefined : value;
};
const str = (values: RuntimeValues | undefined, key: string, env: string) =>
  String(saved(values, key) ?? env);

/** Settings win; the constructor values read from the environment remain the fallback. */
const baselines = new WeakMap<NovaConfig, NovaConfig>();
export function applyRuntimeOverrides(live: NovaConfig): void {
  // The first call sees the pure environment values; later calls (after a save) fall back to them again.
  if (!baselines.has(live))
    baselines.set(live, {
      sttModel: live.sttModel,
      sttMode: live.sttMode,
      sttFreeVerified: live.sttFreeVerified,
      sttKey: live.sttKey,
      embeddingModel: live.embeddingModel,
      embeddingDimensions: live.embeddingDimensions,
      embeddingFreeVerified: live.embeddingFreeVerified,
      newsFeeds: live.newsFeeds,
      ntfy: { ...live.ntfy },
      checkTargets: live.checkTargets,
      homeLocation: live.homeLocation,
    } as NovaConfig);
  const config = baselines.get(live)!;
  const { stt, embeddings, news, ntfy, checks, home } = readRuntime(
    live.dataDir,
  ).groups;
  const latitude = saved(home, "latitude");
  const longitude = saved(home, "longitude");
  const homeLocation =
    latitude !== undefined && longitude !== undefined
      ? { latitude: Number(latitude), longitude: Number(longitude) }
      : config.homeLocation;
  Object.assign(live, {
    sttModel: str(stt, "model", config.sttModel),
    sttMode: str(stt, "mode", config.sttMode),
    sttFreeVerified:
      typeof stt?.freeVerified === "boolean"
        ? stt.freeVerified
        : config.sttFreeVerified,
    sttKey: str(stt, "key", config.sttKey),
    embeddingModel: str(embeddings, "model", config.embeddingModel),
    embeddingDimensions:
      Number(saved(embeddings, "dimensions") ?? config.embeddingDimensions) ||
      0,
    embeddingFreeVerified:
      typeof embeddings?.freeVerified === "boolean"
        ? embeddings.freeVerified
        : config.embeddingFreeVerified,
    newsFeeds: str(news, "feeds", config.newsFeeds),
    ntfy: {
      url: str(ntfy, "url", config.ntfy.url),
      topic: str(ntfy, "topic", config.ntfy.topic),
      token: str(ntfy, "token", config.ntfy.token),
    },
    checkTargets: str(checks, "targets", config.checkTargets),
    homeLocation,
  });
}

/** The value the environment alone gives a field (what applies when nothing is saved in Settings). */
export function environmentDefault(
  live: NovaConfig,
  group: string,
  key: string,
): string {
  const base = baselines.get(live) ?? live;
  const table: Record<string, unknown> = {
    "stt.model": base.sttModel,
    "stt.mode": base.sttMode === "transcriptions" ? "" : base.sttMode,
    "stt.freeVerified": base.sttFreeVerified ? "true" : "",
    "stt.key": base.sttKey,
    "embeddings.model": base.embeddingModel,
    "embeddings.dimensions": base.embeddingDimensions || "",
    "embeddings.freeVerified": base.embeddingFreeVerified ? "true" : "",
    "news.feeds": base.newsFeeds,
    "ntfy.url": base.ntfy.url,
    "ntfy.topic": base.ntfy.topic,
    "ntfy.token": base.ntfy.token,
    "checks.targets": base.checkTargets,
    "home.latitude": base.homeLocation?.latitude ?? "",
    "home.longitude": base.homeLocation?.longitude ?? "",
  };
  const value = table[`${group}.${key}`] ?? "";
  return String(value);
}
