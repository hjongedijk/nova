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

const ENTRY_LIMIT = 500;
const LOG_BYTE_LIMIT = 2_000_000;
const RISKS: Risk[] = ["READ_ONLY", "SAFE", "CONFIRM", "DANGEROUS"];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
      for (const raw of entries) {
        const entry = object(raw);
        const at = timestamp(entry.timestamp);
        if (!at) continue;
        if (oldestAt === null || at < oldestAt) oldestAt = at;
        if (latestAt === null || at > latestAt) latestAt = at;
        const tool =
          typeof entry.tool === "string" ? tools.get(entry.tool) : undefined;
        const result = object(entry.result);
        if (
          !tool ||
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
        tool.attempts++;
        if (result.ok) tool.okResults++;
        else tool.failedResults++;
        tool.contexts[context(entry.sessionId)]++;
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
        oldestAt,
        latestAt,
        toolsTruncated: registry.length > 500,
        tools: [...tools.values()],
      };
    } catch {
      throw new ServiceUnavailableException(
        "Toolgebruik is niet beschikbaar. Probeer het later opnieuw.",
      );
    }
  }
}
