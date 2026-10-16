import {
  Controller,
  Get,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Risk, ToolUsageReport } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { sanitize } from "../core/security/sanitize.js";
import { ToolsService } from "../tools/tools.service.js";
import { SettingsGuard } from "./settings.guard.js";
import { object } from "./request-input.js";

const ENTRY_LIMIT = 500;
const ACTIVITY_LIMIT = 50;
const LOG_BYTE_LIMIT = 2_000_000;
const RISKS: Risk[] = ["READ_ONLY", "SAFE", "CONFIRM", "DANGEROUS"];
function timestamp(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  )
    return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
    ? value
    : null;
}
function context(
  value: unknown,
): keyof ToolUsageReport["tools"][number]["contexts"] {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  if (["health", "overview", "dashboard", "sidebar"].includes(value))
    return "background";
  return value === "settings" || value.startsWith("settings:")
    ? "settings"
    : "chat";
}
function errorType(
  value: unknown,
):
  | "timeout"
  | "authorization"
  | "not_found"
  | "invalid_request"
  | "unavailable"
  | "other" {
  const message = typeof value === "string" ? value.toLowerCase() : "";
  if (/timeout|timed out|etimedout/.test(message)) return "timeout";
  if (/unauthori[sz]ed|forbidden|\b401\b|\b403\b/.test(message))
    return "authorization";
  if (/\b404\b|not found/.test(message)) return "not_found";
  if (/invalid|required|validation|unsupported/.test(message))
    return "invalid_request";
  if (
    /unavailable|not configured|econnrefused|network|fetch failed/.test(message)
  )
    return "unavailable";
  return "other";
}

/** Bounded private usage counts. Successful results do not imply verified physical effects. */
@Controller("settings/tools/usage")
@UseGuards(SettingsGuard)
export class ToolUsageController {
  constructor(
    private readonly audit: AuditService,
    private readonly tools: ToolsService,
  ) {}

  @Get()
  report(): ToolUsageReport {
    try {
      const registry: unknown = this.tools.list();
      const log: unknown = this.audit.read(ENTRY_LIMIT);
      if (!Array.isArray(registry) || !Array.isArray(log))
        throw new Error("Invalid usage sources");
      const entries = log.slice(0, ENTRY_LIMIT);
      const tools = new Map<string, ToolUsageReport["tools"][number]>();
      const durations = new Map<string, number>();
      for (const raw of registry.slice(0, 500)) {
        const tool = object(raw);
        if (
          typeof tool.name !== "string" ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) ||
          sanitize(tool.name) !== tool.name ||
          tools.has(tool.name) ||
          !RISKS.includes(tool.risk as Risk) ||
          typeof tool.enabled !== "boolean" ||
          typeof tool.source !== "string"
        )
          continue;
        tools.set(tool.name, {
          name: tool.name,
          source: sanitize(tool.source).slice(0, 100),
          risk: tool.risk as Risk,
          enabled: tool.enabled,
          attempts: 0,
          okResults: 0,
          failedResults: 0,
          lastAt: null,
          averageDurationMs: null,
          contexts: { chat: 0, settings: 0, background: 0, unknown: 0 },
        });
        durations.set(tool.name, 0);
      }
      let oldestAt: string | null = null;
      let latestAt: string | null = null;
      const recentActivity: ToolUsageReport["recentActivity"] = [];
      for (const raw of entries) {
        const entry = object(raw);
        const at = timestamp(entry.timestamp);
        if (!at) continue;
        if (oldestAt === null || at < oldestAt) oldestAt = at;
        if (latestAt === null || at > latestAt) latestAt = at;
        const toolName =
          typeof entry.tool === "string" &&
          /^[A-Za-z0-9_-]{1,64}$/.test(entry.tool) &&
          sanitize(entry.tool) === entry.tool
            ? entry.tool
            : undefined;
        const tool = toolName ? tools.get(toolName) : undefined;
        const result = object(entry.result);
        if (
          !toolName ||
          entry.phase !== undefined ||
          typeof result.ok !== "boolean" ||
          result.requiresConfirmation === true ||
          typeof entry.durationMs !== "number" ||
          !Number.isFinite(entry.durationMs) ||
          entry.durationMs < 0 ||
          entry.durationMs > 3_600_000 ||
          [
            "pending",
            "cancelled",
            "canceled",
            "expired",
            "standing_approval_created",
            "replaced",
            "superseded",
          ].includes(String(entry.confirmation))
        )
          continue;
        const callContext = context(entry.sessionId);
        const ok = result.ok;
        if (recentActivity.length < ACTIVITY_LIMIT)
          recentActivity.push({
            at,
            tool: toolName,
            source: tool ? tool.source : "removed or unavailable",
            context: callContext,
            ok,
            ...(!ok ? { errorType: errorType(result.error) } : {}),
          });
        if (!tool) continue;
        tool.attempts++;
        if (ok) tool.okResults++;
        else tool.failedResults++;
        tool.contexts[callContext]++;
        if (tool.lastAt === null || at > tool.lastAt) tool.lastAt = at;
        durations.set(tool.name, durations.get(tool.name)! + entry.durationMs);
      }
      for (const tool of tools.values())
        if (tool.attempts)
          tool.averageDurationMs = durations.get(tool.name)! / tool.attempts;
      return {
        scannedEntries: entries.length,
        entryLimit: ENTRY_LIMIT,
        logByteLimit: LOG_BYTE_LIMIT,
        activityLimit: ACTIVITY_LIMIT,
        oldestAt,
        latestAt,
        toolsTruncated: registry.length > 500,
        recentActivity,
        tools: [...tools.values()],
      };
    } catch {
      throw new ServiceUnavailableException(
        "Toolgebruik is niet beschikbaar. Probeer het later opnieuw.",
      );
    }
  }
}
