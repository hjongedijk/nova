import { Injectable, Logger } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import {
  applyConnectionOverrides,
  readConnections,
} from "./service-connections.js";
import { applyRuntimeOverrides, readRuntime } from "./runtime-settings.js";
import { auditEnvironment } from "./env-audit.js";

const text = (name: string, fallback = "") =>
  process.env[name]?.trim() || fallback;
export const DEFAULT_QDRANT_COLLECTION = "jarvis_memory";
const logger = new Logger("NovaConfig");
const warnedLegacyNames = new Set<string>();
const warnedAudit = new Set<string>();
const setting = (name: string, oldName: string, fallback = "") => {
  const current = text(name);
  if (current) return current;
  const old = text(oldName);
  if (old && !warnedLegacyNames.has(oldName)) {
    warnedLegacyNames.add(oldName);
    logger.warn(`${oldName} is deprecated; use ${name}.`);
  }
  return old || fallback;
};
const url = (name: string, fallback: string) =>
  text(name, fallback).replace(/\/$/, "");
const flagValue = (raw: string, fallback: boolean) => {
  const value = raw.trim().toLowerCase();
  return value ? value === "true" : fallback;
};
const flag = (name: string, fallback: boolean) =>
  flagValue(process.env[name]?.trim() ?? "", fallback);
const numberFrom = (
  raw: string,
  fallback: number,
  min: number,
  max: number,
) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? Math.min(max, Math.max(min, value))
    : fallback;
};
const number = (name: string, fallback: number, min: number, max: number) =>
  numberFrom(process.env[name] ?? "", fallback, min, max);

/**
 * Everything NOVA reads from the environment, read once and typed. Internal addresses default
 * to the docker-compose service names; secrets have no default. NOVA_* names take precedence;
 * supported JARVIS_* aliases warn and remain as a migration fallback.
 */
@Injectable()
export class NovaConfig {
  readonly version = text("NOVA_VERSION", "dev");
  readonly port = number("PORT", 3000, 1, 65535);
  readonly httpsPort = Number(process.env.HTTPS_PORT ?? 0);
  readonly dataDir = path.resolve(
    setting("NOVA_DATA_DIR", "JARVIS_DATA_DIR", "../../dev-data"),
  );
  readonly backupDir = path.resolve(
    text("NOVA_BACKUP_DIR", `${this.dataDir}-backups`),
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
  readonly publicUrl = text("NOVA_PUBLIC_URL");
  /** Permit a graceful process restart only when an external supervisor restarts this process. */
  readonly restartEnabled = flag("NOVA_RESTART_ENABLED", false);
  readonly stackControlUrl = url(
    "NOVA_STACK_CONTROL_URL",
    "http://stack-control:8090",
  );
  readonly stackControlToken = text("NOVA_STACK_CONTROL_TOKEN");
  /** Speech-to-text through OmniRoute only: a model that is inside the verified free key scope. */
  readonly sttModel = text("NOVA_STT_MODEL");
  /** "transcriptions" (/audio/transcriptions, e.g. a Whisper model) or "chat-audio" (an audio-capable chat model). */
  readonly sttMode = text("NOVA_STT_MODE", "transcriptions");
  readonly sttFreeVerified = flag("NOVA_STT_FREE_VERIFIED", false);
  /** A separate OmniRoute key restricted to exactly the STT model and one connection (see docs/integrations.md#telephony-and-conversations). */
  readonly sttKey = text("NOVA_STT_KEY");
  readonly defaultLanguage = setting(
    "NOVA_DEFAULT_LANGUAGE",
    "JARVIS_DEFAULT_LANGUAGE",
    "nl-NL",
  );
  readonly timezone = text("TZ", "Europe/Amsterdam");

  // AI
  readonly omniUrl = url("OMNIROUTE_URL", "http://omniroute:20128/v1");
  /** Environment endpoint identifies the gateway whose database is verified locally. */
  readonly verifiedOmniUrl = this.omniUrl;
  readonly omniKey = text("OMNIROUTE_API_KEY");
  readonly omniModel = text("OMNIROUTE_MODEL", "auto");
  readonly omniAdminPassword = text("OMNIROUTE_ADMIN_PASSWORD");
  readonly omniDatabase = text(
    "OMNIROUTE_DATABASE",
    "/omniroute/storage.sqlite",
  );
  readonly omniCompression = setting(
    "NOVA_OMNIROUTE_COMPRESSION",
    "JARVIS_OMNIROUTE_COMPRESSION",
    "off",
  );
  readonly freeOnly = flag("FREE_ONLY", true);
  readonly maxToolRounds = numberFrom(
    setting("NOVA_MAX_TOOL_ITERATIONS", "JARVIS_MAX_TOOL_ITERATIONS"),
    8,
    1,
    16,
  );

  // Tools and actions
  readonly toolTimeoutMs = numberFrom(
    setting("NOVA_TOOL_TIMEOUT_MS", "JARVIS_TOOL_TIMEOUT_MS"),
    30000,
    1000,
    60000,
  );
  /** Kept for existing health consumers; legacy action flags no longer gate execution. */
  readonly actionsEnabled = true;
  readonly autoExecuteSafe = flagValue(
    setting(
      "NOVA_AUTO_EXECUTE_SAFE_ACTIONS",
      "JARVIS_AUTO_EXECUTE_SAFE_ACTIONS",
    ),
    true,
  );
  readonly extensionsEnabled = flagValue(
    setting("NOVA_EXTENSIONS", "JARVIS_EXTENSIONS"),
    true,
  );
  /** Seed the owned catalog once so shipped defaults remain editable through Settings. */
  readonly mcpConfig = ((): string => {
    const own = setting(
      "NOVA_MCP_CONFIG",
      "JARVIS_MCP_CONFIG",
      path.join(this.dataDir, "mcp-servers.json"),
    );
    if (fs.existsSync(own)) return own;
    const shipped = text("NOVA_MCP_DEFAULT", own);
    const relative = path.relative(this.dataDir, path.resolve(own));
    // Explicit catalogs outside NOVA's data directory remain deployment-owned and read-only.
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return shipped;
    let descriptor: number | undefined;
    try {
      const contents = fs.readFileSync(shipped);
      fs.mkdirSync(path.dirname(own), { recursive: true });
      descriptor = fs.openSync(own, "wx", 0o600);
      fs.writeFileSync(descriptor, contents);
      fs.fsyncSync(descriptor);
      return own;
    } catch (error) {
      if (descriptor !== undefined) {
        // Remove only the incomplete file created by this invocation, never a concurrent replacement.
        try {
          const created = fs.fstatSync(descriptor);
          const current = fs.lstatSync(own);
          if (created.dev === current.dev && created.ino === current.ino)
            fs.unlinkSync(own);
        } catch {
          /* Keep the shipped catalog usable when cleanup is unavailable. */
        }
      } else if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return own;
      }
      return shipped;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  })();
  /** Fallback for "home" in the weather tools when Home Assistant has no zone.home. */
  readonly homeLocation = (() => {
    const latitudeValue = setting("NOVA_HOME_LAT", "JARVIS_HOME_LAT");
    const longitudeValue = setting("NOVA_HOME_LON", "JARVIS_HOME_LON");
    const latitude = Number(latitudeValue);
    const longitude = Number(longitudeValue);
    return latitudeValue &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude)
      ? { latitude, longitude }
      : null;
  })();

  // Services
  readonly mqttUrl = text("MQTT_URL", "mqtt://mqtt:1883");
  readonly nodeRedUrl = url("NODE_RED_URL", "http://node-red:1880");
  readonly nodeRedEditorUrl = text("NODE_RED_EDITOR_URL");
  readonly nodeRedAdminToken = text("NODE_RED_ADMIN_TOKEN");
  /** JSON array of exact npm module names NOVA may install or remove. Empty by default. */
  readonly nodeRedPaletteAllowlist = text("NODE_RED_PALETTE_ALLOWLIST", "[]");
  /** Shared only with trusted Node-RED flows that send allow-listed events. */
  readonly nodeRedEventToken = text("NODE_RED_EVENT_TOKEN");
  /** JSON allowlist of HTTP-in flows NOVA may trigger; entries contain no credentials. */
  readonly nodeRedFlowAllowlist = text("NODE_RED_FLOW_ALLOWLIST");
  /** Shared only with the allow-listed Node-RED HTTP-in flows NOVA may trigger. */
  readonly nodeRedFlowToken = text("NODE_RED_FLOW_TOKEN");
  /** Optional free OpenRouteService account; never sent to the browser or model. */
  readonly openRouteServiceKey = text("OPENROUTESERVICE_API_KEY");

  // Memory
  readonly memoryBackend = setting(
    "NOVA_MEMORY_BACKEND",
    "JARVIS_MEMORY_BACKEND",
    "qdrant",
  );
  readonly qdrantUrl = url("QDRANT_URL", "http://qdrant:6333");
  /** One default everywhere; existing installs keep their data under it. */
  readonly qdrantCollection = text(
    "QDRANT_COLLECTION",
    DEFAULT_QDRANT_COLLECTION,
  );
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
  /** Optional private CalDAV calendar. Credentials are read only from the server environment. */
  readonly calDav = {
    url: text("CALDAV_URL"),
    username: text("CALDAV_USERNAME"),
    password: text("CALDAV_PASSWORD"),
  };
  /** Optional private ntfy topic; push delivery is disabled unless all three values exist. */
  readonly ntfy = {
    url: text("NTFY_URL"),
    topic: text("NTFY_TOPIC"),
    token: text("NTFY_TOKEN"),
  };
  /** Optional JSON array of named public RSS feeds; URLs are rechecked by the public fetch guard. */
  readonly newsFeeds = text("NOVA_NEWS_FEEDS");
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
  readonly checkTargets = setting("NOVA_CHECK_TARGETS", "JARVIS_CHECK_TARGETS");

  constructor() {
    applyConnectionOverrides(this);
    applyRuntimeOverrides(this);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.auditEnvironment();
  }

  /** Warn once per variable that Settings now owns, or that disagrees with a saved Settings value. */
  private auditEnvironment(): void {
    try {
      for (const message of auditEnvironment(
        process.env,
        readConnections(this.dataDir).services,
        readRuntime(this.dataDir).groups,
      )) {
        if (warnedAudit.has(message)) continue;
        warnedAudit.add(message);
        logger.warn(message);
      }
    } catch {
      /* an unreadable settings file is reported where it is used */
    }
  }

  /** A file in NOVA's data folder. */
  dataFile(name: string): string {
    return path.join(this.dataDir, name);
  }
}
