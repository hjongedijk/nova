import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import type { PendingConfirmation, Risk, ToolInfo } from "@nova/contracts";
import { Ajv, type ValidateFunction } from "ajv";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { MqttService } from "../core/mqtt/mqtt.service.js";
import { sanitize } from "../core/security/sanitize.js";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { memoryCandidate } from "../memory/semantic/candidate.js";
import { SessionMemoryService } from "../memory/session-memory.service.js";
import { SettingsStore } from "../settings/store/settings.store.js";
import { coerceArguments, dropTransportReason } from "./tool-arguments.js";
import {
  TOOL_SOURCE,
  type ToolDefinition,
  type ToolPlan,
  type ToolResult,
  type ToolSource,
} from "./tool.types.js";

interface Registered {
  definition: ToolDefinition & { enabled: boolean; timeoutMs: number };
  info: ToolInfo;
  source: ToolSource;
  validate: ValidateFunction;
}

/** The OpenAI function format the chat model receives. */
export interface ModelTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

/** Sessions that are not a conversation: nothing about them is remembered. */
const SYSTEM_SESSIONS = new Set(["health", "overview", "dashboard", "sidebar"]);

/** Read-only tools the dashboard may poll without writing to the action log. */
const DASHBOARD_TOOLS = new Set([
  "proxmox_guests",
  "proxmox_storage",
  "timer_list",
  "list_show",
  "alerts_list",
]);

/**
 * Every tool NOVA has, from every source, and the one way to run one: arguments cleaned and
 * checked, the real risk decided, a confirmation asked when needed, every action logged,
 * and the result checked before it goes back to the model.
 */
@Injectable()
export class ToolsService implements OnModuleInit {
  private sources: ToolSource[] = [];
  private readonly ajv = new Ajv({ strict: false, allErrors: true });
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly log = new Logger("TOOLS");

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly config: NovaConfig,
    private readonly audit: AuditService,
    private readonly mqtt: MqttService,
    private readonly confirmations: ConfirmationsService,
    private readonly memory: SessionMemoryService,
    private readonly settings: SettingsStore,
  ) {}

  onModuleInit(): void {
    this.sources = this.discovery
      .getProviders()
      .filter(
        (wrapper) =>
          wrapper.metatype &&
          Reflect.getMetadata(TOOL_SOURCE, wrapper.metatype),
      )
      .map((wrapper) => wrapper.instance as ToolSource)
      .filter(Boolean);
    this.log.log(
      `${this.sources.length} sources: ${this.sources.map((s) => s.source).join(", ")}`,
    );
  }

  /** For tests and for sources that appear later (MCP servers). */
  addSource(source: ToolSource): void {
    this.sources.push(source);
  }

  private validator(definition: ToolDefinition): ValidateFunction {
    const key = `${definition.name}:${JSON.stringify(definition.parameters)}`;
    let validate = this.validators.get(key);
    if (!validate) {
      validate = this.ajv.compile(definition.parameters);
      this.validators.set(key, validate);
    }
    return validate;
  }

  /** All tools now, with the user's switches and descriptions applied. */
  private registry(): Map<string, Registered> {
    const overrides = this.settings.get().toolOverrides;
    const tools = new Map<string, Registered>();
    for (const source of this.sources) {
      let definitions: ToolDefinition[];
      try {
        definitions = source.definitions();
      } catch (error) {
        this.log.warn(
          `${source.source}: definitions failed (${(error as Error).message})`,
        );
        continue;
      }
      for (const raw of definitions) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(raw.name) || tools.has(raw.name)) {
          this.log.warn(`${source.source}: rejected tool ${raw.name}`);
          continue;
        }
        const override = overrides[raw.name];
        const switchedOff = override?.enabled === false;
        const available =
          raw.enabled !== false &&
          (this.config.extensionsEnabled || source.source === "nova");
        const definition = {
          ...raw,
          description: override?.description || raw.description,
          enabled: available && !switchedOff,
          timeoutMs: Math.min(60_000, raw.timeoutMs ?? 30_000),
        };
        let validate: ValidateFunction;
        try {
          validate = this.validator(raw);
        } catch {
          this.log.warn(`${source.source}: invalid schema for ${raw.name}`);
          continue;
        }
        tools.set(raw.name, {
          definition,
          source,
          validate,
          info: {
            name: raw.name,
            description: definition.description,
            defaultDescription: override?.description ? raw.description : null,
            source: source.source,
            risk: raw.risk,
            enabled: definition.enabled,
            switchedOff,
            edited: Boolean(override?.description),
          },
        });
      }
    }
    return tools;
  }

  list(): ToolInfo[] {
    return [...this.registry().values()].map((tool) => tool.info);
  }

  /** The enabled tools in the format the chat model receives. */
  forModel(): ModelTool[] {
    return [...this.registry().values()]
      .filter((tool) => tool.definition.enabled)
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.definition.name,
          description: tool.definition.description,
          parameters: tool.definition.parameters,
        },
      }));
  }

  /**
   * Run one tool for a session. `approved` is the confirmation the user gave; without one, an
   * action that needs confirming comes back as { requiresConfirmation, action }.
   */
  async execute(
    name: string,
    rawArgs: unknown,
    sessionId: string,
    approved: PendingConfirmation | null = null,
  ): Promise<ToolResult> {
    const started = Date.now();
    let args: Record<string, unknown> = (rawArgs ?? {}) as Record<
      string,
      unknown
    >;
    let risk: Risk = "READ_ONLY";
    let confirmation = "not_required";
    let entity: ToolPlan["entity"] = null;
    const finish = (result: ToolResult): ToolResult => {
      const clean = sanitize(result);
      this.audit.record({
        sessionId,
        tool: name,
        arguments:
          name === "memory_remember" &&
          !memoryCandidate(args?.text, { explicit: true })
            ? { text: "[rejected memory candidate]" }
            : args,
        risk,
        confirmation,
        result: clean,
        verification: clean.verified ?? null,
        durationMs: Date.now() - started,
      });
      if (!SYSTEM_SESSIONS.has(sessionId))
        this.memory.rememberTool(sessionId, name, args ?? {}, clean, entity);
      this.mqtt.publish("jarvis/events/tool", {
        type: "completed",
        tool: name,
        ok: clean.ok,
        durationMs: Date.now() - started,
      });
      return clean;
    };

    const tool = this.registry().get(name);
    if (!tool || !tool.definition.enabled)
      return finish({
        ok: false,
        error: "Unknown tool or integration unavailable",
        hint: /^browser_/.test(name)
          ? "De browser-agent is niet geinstalleerd, dus browser_* bestaat niet. Gebruik windows_search om de zoekopdracht op de pc te openen, of web_search om zelf het antwoord te zoeken."
          : "Deze tool bestaat niet of staat uit. Gebruik alleen tools uit je lijst.",
      });
    risk = tool.definition.risk;
    const cleaned = coerceArguments(
      tool.definition.parameters,
      dropTransportReason(tool.definition.parameters, rawArgs),
    );
    if (
      !cleaned ||
      typeof cleaned !== "object" ||
      Array.isArray(cleaned) ||
      !tool.validate(cleaned)
    ) {
      const details = (tool.validate.errors ?? [])
        .slice(0, 3)
        .map((item) => `${item.instancePath || "arguments"} ${item.message}`);
      return finish({
        ok: false,
        error: "Invalid tool arguments",
        ...(details.length ? { details } : {}),
      });
    }
    args = cleaned as Record<string, unknown>;

    try {
      const signal = AbortSignal.timeout(
        Math.min(tool.definition.timeoutMs, this.config.toolTimeoutMs),
      );
      const call = { sessionId, signal };
      let plan: ToolPlan = { args, risk };
      if (tool.source.prepare) {
        const prepared = await tool.source.prepare(name, args, call);
        if ("error" in prepared) return finish({ ok: false, ...prepared });
        plan = prepared;
        args = plan.args;
        risk = plan.risk;
        entity = plan.entity ?? null;
      }
      if (
        risk !== "READ_ONLY" &&
        !name.startsWith("memory_") &&
        !this.config.actionsEnabled
      )
        return finish({
          ok: false,
          error:
            "Device actions are disabled until integration onboarding is complete",
        });
      const needsConfirmation =
        risk === "CONFIRM" ||
        risk === "DANGEROUS" ||
        (risk === "SAFE" && !this.config.autoExecuteSafe);
      if (needsConfirmation) {
        const matches =
          approved &&
          approved.tool === name &&
          approved.sessionId === sessionId &&
          JSON.stringify(approved.args) === JSON.stringify(args) &&
          (!approved.risk || approved.risk === risk);
        if (!matches) {
          confirmation = "pending";
          const action = this.confirmations.create(sessionId, name, args, risk);
          return finish({ ok: false, requiresConfirmation: true, action });
        }
        confirmation = "confirmed";
      }
      // Prove the log is writable before anything changes.
      if (risk !== "READ_ONLY")
        this.audit.record({
          sessionId,
          tool: name,
          arguments: args,
          risk,
          confirmation,
          phase: "execution_started",
        });
      signal.throwIfAborted();
      const result = await tool.source.execute(name, args, { ...call, plan });
      if (!result || typeof result.ok !== "boolean")
        return finish({ ok: false, error: "Malformed tool response" });
      return finish(result);
    } catch (error) {
      this.log.warn(`${name} failed: ${(error as Error).message}`);
      return finish({
        ok: false,
        error: "Tool unavailable, timed out, or verification failed",
      });
    }
  }

  /** A read-only dashboard tool: no log entry, no conversation context. */
  async executeQuiet(name: string): Promise<ToolResult> {
    if (!DASHBOARD_TOOLS.has(name))
      return { ok: false, error: "Not a dashboard tool" };
    const tool = this.registry().get(name);
    if (!tool?.definition.enabled || tool.definition.risk !== "READ_ONLY")
      return { ok: false, error: "Tool unavailable" };
    try {
      const signal = AbortSignal.timeout(
        Math.min(tool.definition.timeoutMs, this.config.toolTimeoutMs),
      );
      return sanitize(
        await tool.source.execute(name, {}, { sessionId: "dashboard", signal }),
      );
    } catch {
      return { ok: false, error: "Tool unavailable" };
    }
  }
}
