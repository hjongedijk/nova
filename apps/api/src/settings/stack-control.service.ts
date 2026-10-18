import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import type {
  StackControlStatus,
  StackRestartResult,
  StackServiceId,
  StackServiceStatus,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";

type NodeRedLogLevel =
  "info" | "warn" | "error" | "debug" | "trace" | "fatal" | "unknown";
type NodeRedLogEntry = {
  at: string;
  stream: "stdout" | "stderr";
  text: string;
  truncated?: boolean;
  level: NodeRedLogLevel;
  source: { type: string; label: string } | null;
};
const nodeRedLogsError = "Node-RED-logboek is niet beschikbaar.";

function validLogTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  )
    return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function cleanLogText(value: string): string {
  const screened = sanitize(value);
  // Retain line breaks and tabs, while removing terminal and direction controls.
  const visible = screened
    // eslint-disable-next-line no-control-regex -- Remove terminal ANSI escape sequences.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(
      // eslint-disable-next-line no-control-regex -- Remove presentation controls, preserving LF and tab.
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,
      "",
    );
  return sanitize(visible);
}

const labels: Record<StackServiceId, string> = {
  nova: "NOVA",
  "node-red": "Node-RED",
  omniroute: "OmniRoute",
  mqtt: "MQTT",
  qdrant: "Qdrant",
  piper: "Lokale stem",
  "home-assistant": "Home Assistant",
  "mcp-egress": "MCP-bronverbinding",
  "stack-control": "Stackbeheer",
};
const ids = Object.keys(labels) as StackServiceId[];
const restartableIds: StackServiceId[] = ids.filter(
  (id) => id !== "stack-control",
);
const baseError =
  "Containerbeheer is niet beschikbaar. Controleer de Compose-broker.";

@Injectable()
export class StackControlService {
  constructor(
    private readonly config: NovaConfig,
    private readonly audit: AuditService,
  ) {}

  private async call(
    path: string,
    method = "GET",
    body?: unknown,
    timeoutMs = 5000,
  ) {
    if (!/^[a-f0-9]{64}$/i.test(this.config.stackControlToken))
      throw new Error(baseError);
    const response = await fetch(`${this.config.stackControlUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.stackControlToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(baseError);
    return response.json() as Promise<unknown>;
  }

  async nodeRedLogs(): Promise<{
    available: boolean;
    reason?: string;
    entries: NodeRedLogEntry[];
    limited: true;
    truncated: boolean;
  }> {
    try {
      const response = await this.call(
        "/services/node-red/logs",
        "GET",
        undefined,
        6000,
      );
      if (
        !response ||
        typeof response !== "object" ||
        Array.isArray(response) ||
        Buffer.byteLength(JSON.stringify(response)) > 240 * 1024
      )
        throw new Error(nodeRedLogsError);
      const payload = response as Record<string, unknown>;
      if (
        Object.keys(payload).some(
          (key) => !["entries", "limited", "truncated"].includes(key),
        ) ||
        !Array.isArray(payload.entries) ||
        payload.entries.length > 100 ||
        payload.limited !== true ||
        typeof payload.truncated !== "boolean"
      )
        throw new Error(nodeRedLogsError);
      let keyStarted = false;
      let unmatchedKeyEnd = -1;
      for (const [index, item] of payload.entries.entries()) {
        const text =
          item && typeof item === "object" && !Array.isArray(item)
            ? (item as Record<string, unknown>).text
            : undefined;
        if (typeof text !== "string") continue;
        if (/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(text))
          keyStarted = true;
        if (/-----END (?:[A-Z]+ )*PRIVATE KEY-----/.test(text)) {
          if (!keyStarted) unmatchedKeyEnd = index;
          keyStarted = false;
        }
      }
      let privateKeyBlock = false;
      const entries: NodeRedLogEntry[] = payload.entries.map(
        (item: unknown, index: number) => {
          if (!item || typeof item !== "object" || Array.isArray(item))
            throw new Error(nodeRedLogsError);
          const row = item as Record<string, unknown>;
          if (
            Object.keys(row).some(
              (key) => !["at", "stream", "text", "truncated"].includes(key),
            ) ||
            !validLogTimestamp(row.at) ||
            !["stdout", "stderr"].includes(String(row.stream)) ||
            typeof row.stream !== "string" ||
            typeof row.text !== "string" ||
            row.text.length > 2048 ||
            (row.truncated !== undefined && typeof row.truncated !== "boolean")
          )
            throw new Error(nodeRedLogsError);
          const beginsPrivateKey =
            /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(row.text);
          const endsPrivateKey = /-----END (?:[A-Z]+ )*PRIVATE KEY-----/.test(
            row.text,
          );
          const hidePrivateKey =
            index <= unmatchedKeyEnd ||
            privateKeyBlock ||
            beginsPrivateKey ||
            endsPrivateKey ||
            row.text
              .split("\n")
              .some((line) => /^[A-Za-z0-9+/]{32,}={0,2}$/.test(line.trim()));
          if (beginsPrivateKey) privateKeyBlock = true;
          if (endsPrivateKey) privateKeyBlock = false;
          const text = hidePrivateKey
            ? "[Privésleutel verborgen.]"
            : row.truncated === true
              ? "[Logregel te lang; inhoud verborgen.]"
              : cleanLogText(row.text);
          const level = (text.match(
            /\[(info|warn|error|debug|trace|fatal)\]/,
          )?.[1] ?? "unknown") as NodeRedLogLevel;
          const source = text.match(
            /^\d{1,2} [A-Z][a-z]{2} (?:\d{4} )?\d{2}:\d{2}:\d{2} - \[(?:info|warn|error|debug|trace|fatal)\] \[([a-zA-Z0-9_.-][a-zA-Z0-9_. -]{0,127}):([^\]\n\t[]{0,128})\]/,
          );
          return {
            at: row.at,
            stream: row.stream as "stdout" | "stderr",
            text,
            ...(row.truncated !== undefined
              ? { truncated: row.truncated }
              : {}),
            level,
            source: source ? { type: source[1]!, label: source[2]! } : null,
          };
        },
      );
      // A registered multiline credential can span Docker log rows. If screening
      // removes a row boundary, hide the batch instead of misassigning its text.
      const combined = (payload.entries as Record<string, unknown>[])
        .filter((row) => row.truncated !== true)
        .map((row) => row.text as string)
        .join("\n");
      if (
        (combined.match(/\n/g)?.length ?? 0) !==
        (sanitize(combined).match(/\n/g)?.length ?? 0)
      ) {
        for (const entry of entries) {
          entry.text = "[Meerregelige geheime inhoud verborgen.]";
          entry.level = "unknown";
          entry.source = null;
        }
      }
      return {
        available: true,
        entries,
        limited: true,
        truncated: payload.truncated,
      };
    } catch {
      return {
        available: false,
        reason: nodeRedLogsError,
        entries: [],
        limited: true,
        truncated: false,
      };
    }
  }

  async runCode(
    projectId: string,
    command: string[],
  ): Promise<{
    ok: boolean;
    exitCode: number | null;
    durationMs: number;
    output: string;
  }> {
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(projectId) ||
      !Array.isArray(command)
    )
      throw new Error("Code runner unavailable");
    const started = Date.now();
    const result = (await this.call(
      "/code/run",
      "POST",
      { projectId, command },
      35_000,
    )) as Record<string, unknown>;
    if (
      typeof result.ok !== "boolean" ||
      !(result.statusCode === null || Number.isInteger(result.statusCode)) ||
      typeof result.timedOut !== "boolean" ||
      typeof result.output !== "string" ||
      Buffer.byteLength(result.output) > 32 * 1024
    )
      throw new Error("Code runner returned an invalid response");
    return {
      ok: result.ok,
      exitCode: result.statusCode as number | null,
      durationMs: Date.now() - started,
      output: result.output,
    };
  }

  async status(): Promise<StackControlStatus> {
    try {
      const response = (await this.call("/services")) as {
        services?: unknown;
        mcpWorkers?: unknown;
      };
      if (!Array.isArray(response.services)) throw new Error(baseError);
      const byId = new Map<string, StackServiceStatus>();
      for (const item of response.services) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        if (
          typeof row.id !== "string" ||
          !ids.includes(row.id as StackServiceId) ||
          typeof row.state !== "string" ||
          typeof row.revision !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.revision)
        )
          continue;
        const state = [
          "running",
          "exited",
          "created",
          "restarting",
          "paused",
          "dead",
          "missing",
          "unknown",
        ].includes(row.state)
          ? (row.state as StackServiceStatus["state"])
          : "unknown";
        const health = ["healthy", "unhealthy", "starting"].includes(
          String(row.health),
        )
          ? (row.health as StackServiceStatus["health"])
          : null;
        byId.set(row.id, {
          id: row.id as StackServiceId,
          label: labels[row.id as StackServiceId],
          state,
          health,
          canRestart: restartableIds.includes(row.id as StackServiceId),
          revision: row.revision,
          startedAt:
            typeof row.startedAt === "string" &&
            Number.isFinite(Date.parse(row.startedAt))
              ? row.startedAt
              : null,
        });
      }
      return {
        ...(Array.isArray(response.mcpWorkers)
          ? {
              mcpWorkers: response.mcpWorkers.flatMap((value: unknown) => {
                if (!value || typeof value !== "object") return [];
                const row = value as Record<string, unknown>;
                if (
                  typeof row.server !== "string" ||
                  typeof row.state !== "string" ||
                  ![
                    "sequential-thinking",
                    "filesystem",
                    "context7",
                    "workspace-git",
                  ].includes(row.server) ||
                  ![
                    "running",
                    "starting",
                    "stopped",
                    "missing",
                    "mixed",
                  ].includes(row.state) ||
                  !Number.isInteger(row.workerCount) ||
                  Number(row.workerCount) < 0 ||
                  Number(row.workerCount) > 64
                )
                  return [];
                return [
                  {
                    server: row.server as NonNullable<
                      StackControlStatus["mcpWorkers"]
                    >[number]["server"],
                    state: row.state as NonNullable<
                      StackControlStatus["mcpWorkers"]
                    >[number]["state"],
                    workerCount: Number(row.workerCount),
                  },
                ];
              }),
            }
          : {}),
        available: byId.size === ids.length,
        ...(byId.size !== ids.length ? { reason: baseError } : {}),
        services: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
      };
    } catch {
      return { available: false, reason: baseError, services: [] };
    }
  }

  /** Restarts one NOVA-stack service immediately. */
  async restart(value: unknown): Promise<StackRestartResult> {
    if (
      typeof value !== "string" ||
      !restartableIds.includes(value as StackServiceId)
    )
      throw new ValidationError(["Kies één service uit de NOVA-stack."]);
    const service = value as StackServiceId;
    const status = await this.status();
    const current = status.services.find((row) => row.id === service);
    if (!status.available || !current || current.state !== "running")
      return {
        ok: false,
        error: "Deze service draait niet of status ontbreekt.",
      };
    const sessionId = `settings-stack-restart:${crypto.randomUUID()}`;
    const tool = "settings_stack_service_restart";
    const args = { service, revision: current.revision };
    this.audit.record({
      sessionId,
      tool,
      risk: "DANGEROUS",
      arguments: args,
      confirmation: "direct",
      phase: "before_execute",
    });
    try {
      await this.call(`/services/${service}/restart`, "POST", {
        expectedRevision: current.revision,
      });
      try {
        this.audit.record({
          sessionId,
          tool,
          risk: "DANGEROUS",
          arguments: args,
          confirmation: "direct",
          phase: "after_execute",
          result: { ok: true, service },
          verification: { brokerAcknowledged: true },
        });
      } catch {
        /* The initial audit record still records the attempted action. */
      }
      return { ok: true, service };
    } catch {
      try {
        this.audit.record({
          sessionId,
          tool,
          risk: "DANGEROUS",
          arguments: args,
          confirmation: "direct",
          phase: "after_execute",
          result: { ok: false, service },
          verification: { brokerAcknowledged: false },
        });
      } catch {
        /* Keep the first audit record if the outcome record cannot be written. */
      }
      return {
        ok: false,
        error: "Herstart niet uitgevoerd; controleer de actuele servicestatus.",
      };
    }
  }
}
