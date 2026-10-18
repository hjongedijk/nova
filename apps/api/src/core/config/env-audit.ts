import type { ConnectionValues } from "./service-connections.js";
import { RUNTIME_GROUPS, type RuntimeValues } from "./runtime-settings.js";

/** Environment variables that Settings now owns. They keep working as a fallback default. */
interface Owned {
  env: string;
  /** services.json service id or runtime group id */
  scope: "service" | "runtime";
  id: string;
  key: string;
}
const SERVICE_ENV: Record<string, Record<string, string>> = {
  omniroute: {
    apiKey: "OMNIROUTE_API_KEY",
    adminPassword: "OMNIROUTE_ADMIN_PASSWORD",
  },
  "home-assistant": {
    url: "HOME_ASSISTANT_URL",
    token: "HOME_ASSISTANT_TOKEN",
  },
  proxmox: {
    url: "PROXMOX_URL",
    tokenId: "PROXMOX_TOKEN_ID",
    tokenSecret: "PROXMOX_TOKEN_SECRET",
    verifyTls: "PROXMOX_VERIFY_TLS",
  },
  qdrant: { apiKey: "QDRANT_API_KEY", collection: "QDRANT_COLLECTION" },
  "node-red": { adminToken: "NODE_RED_ADMIN_TOKEN" },
  windows: { url: "WINDOWS_AGENT_URL", token: "WINDOWS_AGENT_TOKEN" },
  termix: { url: "TERMIX_URL", apiKey: "TERMIX_API_KEY" },
  pangolin: {
    url: "PANGOLIN_URL",
    host: "PANGOLIN_HOST",
    apiKey: "PANGOLIN_API_KEY",
    orgId: "PANGOLIN_ORG_ID",
    insecureTls: "PANGOLIN_INSECURE_TLS",
  },
};
/** Internal wiring (OMNIROUTE_URL, QDRANT_URL, MQTT_URL, NODE_RED_URL) is set by compose on purpose. */
const OWNED: Owned[] = [
  ...Object.entries(SERVICE_ENV).flatMap(([id, fields]) =>
    Object.entries(fields).map(([key, env]): Owned => ({
      env,
      scope: "service",
      id,
      key,
    })),
  ),
  ...RUNTIME_GROUPS.flatMap((group) =>
    group.fields.map((field): Owned => ({
      env: field.env,
      scope: "runtime",
      id: group.id,
      key: field.key,
    })),
  ),
];
/** Bootstrap secrets: they stay in .env on purpose, so only a mismatch with Settings is reported. */
const BOOTSTRAP = new Set(["OMNIROUTE_API_KEY", "OMNIROUTE_ADMIN_PASSWORD"]);
/** Owned elsewhere in Settings (mcp-secrets.json, voice profile) without a services.json entry. */
const OTHER_OWNED = [
  "CALDAV_URL",
  "CALDAV_USERNAME",
  "CALDAV_PASSWORD",
  "IMAP_HOST",
  "IMAP_USER",
  "IMAP_PASSWORD",
  "TTS_VOICE",
];
const DEAD = new Map([
  [
    "EMBEDDING_GATEWAY_API_KEY",
    "has no effect: embeddings use the verified OmniRoute key; remove it from .env.",
  ],
]);

const same = (envValue: string, stored: string | boolean) =>
  typeof stored === "boolean"
    ? envValue.toLowerCase() === String(stored)
    : envValue.trim() === stored;

/**
 * Messages for the startup audit. Variable names only, never values. Pure so it can be tested;
 * the caller logs each message once.
 */
export function auditEnvironment(
  env: NodeJS.ProcessEnv,
  services: Record<string, ConnectionValues>,
  runtime: Record<string, RuntimeValues>,
): string[] {
  const messages: string[] = [];
  const present = (name: string) => Boolean(env[name]?.trim());
  for (const item of OWNED) {
    if (!present(item.env)) continue;
    if (!BOOTSTRAP.has(item.env))
      messages.push(
        `${item.env} is now managed in Settings; remove it from .env.`,
      );
    const stored =
      item.scope === "service"
        ? services[item.id]?.[item.key]
        : runtime[item.id]?.[item.key];
    if (stored !== undefined && stored !== "" && !same(env[item.env]!, stored))
      messages.push(
        `${item.env} in .env differs from the value saved in Settings; the Settings value is used.`,
      );
  }
  for (const name of OTHER_OWNED)
    if (present(name))
      messages.push(`${name} is now managed in Settings; remove it from .env.`);
  for (const [name, text] of DEAD)
    if (present(name)) messages.push(`${name} ${text}`);
  return messages;
}
