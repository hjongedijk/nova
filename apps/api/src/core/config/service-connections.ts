import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../errors/validation.error.js";
import { registerSecrets } from "../security/sanitize.js";
import type { NovaConfig } from "./nova-config.js";

export interface ConnectionField {
  key: string;
  label: string;
  kind: "url" | "text" | "boolean" | "secret";
}
export interface ConnectionSpec {
  id: string;
  label: string;
  fields: ConnectionField[];
}
const field = (
  key: string,
  label: string,
  kind: ConnectionField["kind"] = "text",
): ConnectionField => ({ key, label, kind });
export const CONNECTIONS: ConnectionSpec[] = [
  {
    id: "omniroute",
    label: "OmniRoute",
    fields: [
      field("url", "Gateway-adres (met /v1)", "url"),
      field("apiKey", "NOVA-toegangssleutel", "secret"),
      field("adminPassword", "Beheerwachtwoord", "secret"),
    ],
  },
  {
    id: "home-assistant",
    label: "Home Assistant",
    fields: [
      field("url", "Adres", "url"),
      field("token", "Toegangstoken", "secret"),
    ],
  },
  {
    id: "proxmox",
    label: "Proxmox",
    fields: [
      field("url", "Adres", "url"),
      field("tokenId", "Token-ID", "secret"),
      field("tokenSecret", "Tokengeheim", "secret"),
      field("verifyTls", "TLS-certificaat controleren", "boolean"),
    ],
  },
  {
    id: "qdrant",
    label: "Qdrant",
    fields: [
      field("url", "Adres", "url"),
      field("apiKey", "Toegangssleutel", "secret"),
      field("collection", "Geheugencollectie"),
    ],
  },
  {
    id: "mqtt",
    label: "MQTT",
    fields: [
      field("url", "Broker-adres", "url"),
      field("username", "Gebruikersnaam"),
      field("password", "Wachtwoord", "secret"),
    ],
  },
  {
    id: "node-red",
    label: "Node-RED",
    fields: [
      field("url", "Adres", "url"),
      field("adminToken", "Beheertoken", "secret"),
    ],
  },
  {
    id: "windows",
    label: "Windows-agent",
    fields: [
      field("url", "Agent-adres", "url"),
      field("token", "Agent-token", "secret"),
    ],
  },
  {
    id: "termix",
    label: "Termix",
    fields: [
      field("url", "Adres", "url"),
      field("apiKey", "Toegangssleutel", "secret"),
    ],
  },
  {
    id: "pangolin",
    label: "Pangolin",
    fields: [
      field("url", "Adres", "url"),
      field("host", "Hostnaam voor de verbinding"),
      field("apiKey", "Toegangssleutel", "secret"),
      field("orgId", "Organisatie-ID"),
      field(
        "insecureTls",
        "Zelfondertekend TLS-certificaat toestaan",
        "boolean",
      ),
    ],
  },
];
export type ConnectionValues = Record<string, string | boolean>;
export interface ConnectionRevision {
  id: string;
  service: string;
  at: string;
  before: ConnectionValues;
  after: ConnectionValues;
  secretChanges: string[];
  revertedFrom?: string;
}
export interface ConnectionFile {
  version: 1;
  services: Record<string, ConnectionValues>;
  history: ConnectionRevision[];
}
export const connectionFile = (directory: string) =>
  path.join(directory, "services.json");
export function connectionSpec(id: string): ConnectionSpec {
  const spec = CONNECTIONS.find((item) => item.id === id);
  if (!spec) throw new ValidationError(["Onbekende koppeling."]);
  return spec;
}

/** Validate all persisted and submitted fields without echoing their values in errors. */
export function normalizeConnection(
  id: string,
  input: unknown,
): ConnectionValues {
  const spec = connectionSpec(id);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ValidationError(["Vul de koppeling als velden in."]);
  const result: ConnectionValues = {};
  for (const [key, value] of Object.entries(input)) {
    const definition = spec.fields.find((item) => item.key === key);
    if (!definition)
      throw new ValidationError(["Onbekend veld voor deze koppeling."]);
    if (definition.kind === "boolean") {
      if (typeof value !== "boolean")
        throw new ValidationError([`${definition.label}: kies aan of uit.`]);
      result[key] = value;
      continue;
    }
    if (
      typeof value !== "string" ||
      value.length > (definition.kind === "secret" ? 4096 : 500) ||
      Array.from(value).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      throw new ValidationError([`${definition.label}: ongeldige tekst.`]);
    const text = definition.kind === "secret" ? value : value.trim();
    if (definition.kind === "url" && text) {
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        throw new ValidationError(["Vul een geldig adres in."]);
      }
      const protocols =
        id === "mqtt"
          ? ["mqtt:", "mqtts:", "ws:", "wss:"]
          : ["http:", "https:"];
      if (
        !protocols.includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new ValidationError([
          "Gebruik een passend adres zonder wachtwoord, query of fragment.",
        ]);
      result[key] = text.replace(/\/$/, "");
    } else {
      if (key === "host" && text && !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(text))
        throw new ValidationError(["Vul een geldige hostnaam in."]);
      if (
        (key === "collection" || key === "orgId") &&
        text &&
        !/^[a-z0-9_.-]{1,100}$/i.test(text)
      )
        throw new ValidationError([
          `${definition.label}: gebruik letters, cijfers, punten of streepjes.`,
        ]);
      result[key] = text;
    }
  }
  registerSecrets(
    spec.fields.flatMap((definition) => {
      const value = result[definition.key];
      return definition.kind === "secret" && typeof value === "string"
        ? [value]
        : [];
    }),
  );
  return result;
}

export function readConnections(directory: string): ConnectionFile {
  const file = connectionFile(directory);
  if (!fs.existsSync(file)) return { version: 1, services: {}, history: [] };
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length > 1_000_000) throw new Error("size");
    const data = JSON.parse(raw) as ConnectionFile;
    if (
      data.version !== 1 ||
      !data.services ||
      typeof data.services !== "object" ||
      Array.isArray(data.services)
    )
      throw new Error("shape");
    const services = Object.fromEntries(
      Object.entries(data.services).map(([id, values]) => [
        id,
        normalizeConnection(id, values),
      ]),
    );
    // History is private metadata. Its public projection is validated independently by the store.
    return {
      version: 1,
      services,
      history: Array.isArray(data.history) ? data.history.slice(-100) : [],
    };
  } catch {
    throw new Error(
      "De opgeslagen service-instellingen zijn ongeldig. Herstel services.json uit een lokale back-up.",
    );
  }
}

/** Strip any credential or query from legacy environment URLs before showing a field. */
export function displayUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}
export function connectionDefaults(
  config: NovaConfig,
): Record<string, ConnectionValues> {
  let mqttUser = "",
    mqttPassword = "",
    mqttAddress = config.mqttUrl;
  try {
    const url = new URL(config.mqttUrl);
    mqttUser = decodeURIComponent(url.username);
    mqttPassword = decodeURIComponent(url.password);
    url.username = "";
    url.password = "";
    mqttAddress = url.toString();
  } catch {
    /* unconfigured */
  }
  return {
    omniroute: {
      url: config.omniUrl,
      apiKey: config.omniKey,
      adminPassword: config.omniAdminPassword,
    },
    "home-assistant": { ...config.homeAssistant },
    proxmox: { ...config.proxmox },
    qdrant: {
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey,
      collection: config.qdrantCollection,
    },
    mqtt: {
      url: mqttAddress,
      username: mqttUser,
      password: mqttPassword,
    },
    "node-red": {
      url: config.nodeRedUrl,
      adminToken: config.nodeRedAdminToken,
    },
    windows: { ...config.windowsAgent },
    termix: { ...config.termix },
    pangolin: { ...config.pangolin },
  };
}

/** Bootstrap overrides only allowed service fields; environment remains the fallback. */
export function applyConnectionOverrides(config: NovaConfig): void {
  const values = readConnections(config.dataDir).services;
  const defaults = connectionDefaults(config);
  const service = (id: string) => ({ ...defaults[id], ...values[id] });
  const omni = service("omniroute"),
    qdrant = service("qdrant"),
    mqtt = service("mqtt");
  let mqttUrl = Object.hasOwn(values.mqtt ?? {}, "url")
    ? String(mqtt.url)
    : config.mqttUrl;
  if (values.mqtt && mqttUrl && (mqtt.username || mqtt.password)) {
    const url = new URL(mqttUrl);
    url.username = String(mqtt.username);
    url.password = String(mqtt.password);
    mqttUrl = url.toString();
  }
  Object.assign(config, {
    omniUrl: omni.url,
    omniKey: omni.apiKey,
    omniAdminPassword: omni.adminPassword,
    qdrantUrl: qdrant.url,
    qdrantApiKey: qdrant.apiKey,
    qdrantCollection: qdrant.collection,
    mqttUrl,
    nodeRedUrl: service("node-red").url,
    nodeRedAdminToken: service("node-red").adminToken,
    homeAssistant: service("home-assistant"),
    proxmox: service("proxmox"),
    windowsAgent: service("windows"),
    termix: service("termix"),
    pangolin: service("pangolin"),
  });
}
