import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import type {
  StackControlStatus,
  StackRestartPrepared,
  StackRestartResult,
  StackServiceId,
  StackServiceStatus,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";

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
    private readonly confirmations: ConfirmationsService,
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

  async prepareRestart(value: unknown): Promise<StackRestartPrepared> {
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
    const args = { service, revision: current.revision };
    this.audit.record({
      sessionId,
      tool: "settings_stack_service_restart",
      risk: "DANGEROUS",
      confirmation: "pending_admin_ui",
      arguments: args,
    });
    return {
      ok: true,
      service,
      label: current.label,
      action: this.confirmations.create(
        sessionId,
        "settings_stack_service_restart",
        args,
        "DANGEROUS",
        current.revision,
        false,
      ),
    };
  }

  async confirmRestart(
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<StackRestartResult> {
    if (
      !/^settings-stack-restart:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const pending = this.confirmations.peek(sessionId);
    const service = pending?.args.service;
    const revision = pending?.args.revision;
    if (
      !pending ||
      pending.tool !== "settings_stack_service_restart" ||
      typeof service !== "string" ||
      !ids.includes(service as StackServiceId) ||
      typeof revision !== "string" ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false,
        error: "Deze bevestiging is verlopen. Laad de status opnieuw.",
      };
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false,
        error: "Deze bevestiging is verlopen. Laad de status opnieuw.",
      };
    if (!approve) {
      this.audit.record({
        sessionId,
        tool: action.tool,
        risk: "DANGEROUS",
        arguments: action.args,
        confirmation: "rejected_admin_ui",
      });
      return { ok: false, error: "Herstart geannuleerd." };
    }
    this.audit.record({
      sessionId,
      tool: action.tool,
      risk: "DANGEROUS",
      arguments: action.args,
      confirmation: "approved_admin_ui",
      phase: "before_execute",
    });
    try {
      await this.call(`/services/${service}/restart`, "POST", {
        expectedRevision: revision,
      });
      try {
        this.audit.record({
          sessionId,
          tool: action.tool,
          risk: "DANGEROUS",
          arguments: action.args,
          confirmation: "confirmed_admin_ui",
          phase: "after_execute",
          result: { ok: true, service },
          verification: { brokerAcknowledged: true },
        });
      } catch {
        /* The initial audit record still records the attempted action. */
      }
      return { ok: true, service: service as StackServiceId };
    } catch {
      try {
        this.audit.record({
          sessionId,
          tool: action.tool,
          risk: "DANGEROUS",
          arguments: action.args,
          confirmation: "confirmed_admin_ui",
          phase: "after_execute",
          result: { ok: false, service },
          verification: { brokerAcknowledged: false },
        });
      } catch {
        /* Keep the confirmation audit if the outcome record cannot be written. */
      }
      return {
        ok: false,
        error: "Herstart niet uitgevoerd; controleer de actuele servicestatus.",
      };
    }
  }
}
