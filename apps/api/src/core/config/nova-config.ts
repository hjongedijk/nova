import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";

const text = (name: string, fallback = "") =>
  process.env[name]?.trim() || fallback;
const url = (name: string, fallback: string) =>
  text(name, fallback).replace(/\/$/, "");
const flag = (name: string, fallback: boolean) => {
  const value = process.env[name]?.trim().toLowerCase();
  return value ? value === "true" : fallback;
};
const number = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0
    ? Math.min(max, Math.max(min, value))
    : fallback;
};

/**
 * Everything NOVA reads from the environment, read once and typed. Internal addresses default
 * to the docker-compose service names; secrets have no default. The JARVIS_* names are kept so
 * an existing .env keeps working.
 */
@Injectable()
export class NovaConfig {
  readonly version = text("NOVA_VERSION", "dev");
  readonly port = number("PORT", 3000, 1, 65535);
  readonly httpsPort = Number(process.env.HTTPS_PORT ?? 0);
  readonly dataDir = path.resolve(
    text("NOVA_DATA_DIR") || text("JARVIS_DATA_DIR") || "../../dev-data",
  );
  readonly certDir = path.resolve(
    text("NOVA_CERT_DIR", path.join(this.dataDir, "certs")),
  );
  /** The built Svelte app (apps/web/build). Absent while developing with Vite. */
  readonly webDir = path.resolve(
    text(
      "NOVA_WEB_DIR",
      path.join(import.meta.dirname, "../../../../web/build"),
    ),
  );
  /** Where the agents (Windows, browser) live: in the repo while developing, in the image in production. */
  readonly agentsDir = path.resolve(
    text(
      "NOVA_AGENTS_DIR",
      path.join(import.meta.dirname, "../../../../../agents"),
    ),
  );
  readonly publicUrl = text("NOVA_PUBLIC_URL");
  readonly adminPin = text("NOVA_ADMIN_PIN");
  readonly defaultLanguage = text("JARVIS_DEFAULT_LANGUAGE", "nl-NL");
  readonly timezone = text("TZ", "Europe/Amsterdam");

  // AI
  readonly omniUrl = url("OMNIROUTE_URL", "http://omniroute:20128/v1");
  readonly omniKey = text("OMNIROUTE_API_KEY");
  readonly omniModel = text("OMNIROUTE_MODEL", "auto");
  readonly omniAdminPassword = text("OMNIROUTE_ADMIN_PASSWORD");
  readonly omniDatabase = text(
    "OMNIROUTE_DATABASE",
    "/omniroute/storage.sqlite",
  );
  readonly omniCompression = text("JARVIS_OMNIROUTE_COMPRESSION", "off");
  readonly freeOnly = flag("FREE_ONLY", true);
  readonly maxToolRounds = number("JARVIS_MAX_TOOL_ITERATIONS", 8, 1, 16);

  // Tools and actions
  readonly toolTimeoutMs = number("JARVIS_TOOL_TIMEOUT_MS", 30000, 1000, 60000);
  readonly actionsEnabled = flag("JARVIS_ENABLE_ACTIONS", false);
  readonly autoExecuteSafe = flag("JARVIS_AUTO_EXECUTE_SAFE_ACTIONS", true);
  readonly extensionsEnabled = flag("JARVIS_EXTENSIONS", true);
  /** The user's own list in the data folder wins; otherwise the list shipped in the image. */
  readonly mcpConfig = ((): string => {
    const own = text(
      "JARVIS_MCP_CONFIG",
      path.join(this.dataDir, "mcp-servers.json"),
    );
    return fs.existsSync(own) ? own : text("NOVA_MCP_DEFAULT", own);
  })();

  /** Fallback for "home" in the weather tools when Home Assistant has no zone.home. */
  readonly homeLocation = (() => {
    const latitude = Number(text("JARVIS_HOME_LAT"));
    const longitude = Number(text("JARVIS_HOME_LON"));
    return text("JARVIS_HOME_LAT") &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude)
      ? { latitude, longitude }
      : null;
  })();

  // Services
  readonly mqttUrl = text("MQTT_URL", "mqtt://mqtt:1883");
  readonly nodeRedUrl = url("NODE_RED_URL", "http://node-red:1880");
  readonly toolSharedSecret = text("JARVIS_TOOL_SHARED_SECRET");

  // Memory
  readonly memoryBackend = text("JARVIS_MEMORY_BACKEND", "qdrant");
  readonly qdrantUrl = url("QDRANT_URL", "http://qdrant:6333");
  readonly qdrantCollection = text("QDRANT_COLLECTION", "jarvis_memory");
  readonly qdrantApiKey = text("QDRANT_API_KEY");
  readonly embeddingKey = text("EMBEDDING_GATEWAY_API_KEY");
  readonly embeddingModel = text("EMBEDDING_MODEL");
  readonly embeddingDimensions = Number(text("EMBEDDING_DIMENSIONS", "0")) || 0;
  readonly embeddingFreeVerified = flag("EMBEDDING_FREE_VERIFIED", false);

  // Integrations
  readonly proxmox = {
    url: url("PROXMOX_URL", ""),
    tokenId: text("PROXMOX_TOKEN_ID"),
    tokenSecret: text("PROXMOX_TOKEN_SECRET"),
    verifyTls: flag("PROXMOX_VERIFY_TLS", true),
  };
  readonly homeAssistant = {
    url: url("HOME_ASSISTANT_URL", "http://host.docker.internal:8123"),
    token: text("HOME_ASSISTANT_TOKEN"),
  };
  readonly windowsAgent = {
    url: url("WINDOWS_AGENT_URL", ""),
    token: text("WINDOWS_AGENT_TOKEN"),
  };
  readonly termix = {
    url: url("TERMIX_URL", ""),
    apiKey: text("TERMIX_API_KEY"),
  };
  readonly pangolin = {
    url: url("PANGOLIN_URL", ""),
    host: text("PANGOLIN_HOST"),
    apiKey: text("PANGOLIN_API_KEY"),
    orgId: text("PANGOLIN_ORG_ID"),
    insecureTls: flag("PANGOLIN_INSECURE_TLS", false),
  };
  /** Comma-separated host:port pairs the reachability check watches. */
  readonly checkTargets = text("JARVIS_CHECK_TARGETS");

  constructor() {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  /** A file in NOVA's data folder. */
  dataFile(name: string): string {
    return path.join(this.dataDir, name);
  }
}
