import {
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from "@nestjs/common";
import {
  allowsAutoApproval,
  TAINT_WINDOW_MS,
  UNTRUSTED_SOURCES,
} from "./autonomy-policy.js";
import { AutonomyLevelStore } from "./autonomy-level.store.js";
import { DiscoveryService } from "@nestjs/core";
import type {
  ModelRoleId,
  PendingConfirmation,
  Risk,
  ToolInfo,
} from "@nova/contracts";
import { Ajv, type ValidateFunction } from "ajv";
import crypto from "node:crypto";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { MqttService } from "../core/mqtt/mqtt.service.js";
import { sanitize } from "../core/security/sanitize.js";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { requiresScreenConfirmation } from "../confirmations/screen-confirmation.js";
import {
  desktopAuditArgs,
  desktopAuditResult,
  isDesktopTool,
} from "../desktop/desktop.audit.js";
import { memoryCandidate } from "../memory/semantic/candidate.js";
import { SessionMemoryService } from "../memory/session-memory.service.js";
import { SettingsStore } from "../settings/store/settings.store.js";
import { coerceArguments, dropTransportReason } from "./tool-arguments.js";
import {
  MAX_MODEL_TOOLS,
  TOOL_DISCOVERY_NAME,
  rankToolsForRequest,
  selectToolsForRequest,
} from "./tool-selection.js";
import {
  TOOL_SOURCE,
  type ToolDefinition,
  type ToolPlan,
  type ToolResult,
  type ToolSource,
} from "./tool.types.js";

/** Stable fingerprints contain no tool arguments or secrets. */
export function approvalHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Relationship details belong in the user's memory store, not a duplicate action-log copy. */
export function memoryAuditProjection(
  args: Record<string, unknown>,
  result: ToolResult,
): { arguments: Record<string, unknown>; result: Record<string, unknown> } {
  const candidate = memoryCandidate(args.text, args);
  return {
    arguments: {
      ...(candidate ? { type: candidate.type } : { rejected: true }),
      text: "[redacted]",
    },
    result: { ok: result.ok, stored: result.ok },
  };
}

/** memory_correct carries the new memory text: keep the record id, never the text. */
export function memoryCorrectAuditProjection(
  args: Record<string, unknown>,
  result: ToolResult,
): { arguments: Record<string, unknown>; result: Record<string, unknown> } {
  return {
    arguments: {
      ...(typeof args.id === "string" ? { id: args.id.slice(0, 64) } : {}),
      text: "[redacted]",
    },
    result: { ok: result.ok, corrected: result.ok },
  };
}

/** Even fields the coercer discards must never silently match a standing approval. */
function hasUnknownArguments(parameters: unknown, value: unknown): boolean {
  if (
    !parameters ||
    typeof parameters !== "object" ||
    !value ||
    typeof value !== "object"
  )
    return false;
  const rule = parameters as {
    properties?: Record<string, unknown>;
    items?: unknown;
  };
  if (Array.isArray(value))
    return value.some((item) => hasUnknownArguments(rule.items, item));
  return Object.entries(value).some(
    ([key, item]) =>
      !Object.hasOwn(rule.properties ?? {}, key) ||
      hasUnknownArguments(rule.properties?.[key], item),
  );
}

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

/** Personal changes do not enable devices or integrations and still need fresh confirmation. */
const PERSONAL_SETTINGS_TOOLS = new Set([
  "settings_persona_set",
  "settings_instruction_create",
  "settings_skill_toggle",
  "settings_helper_preference_set",
  "settings_skills",
]);
const LOCAL_PERSONAL_TOOLS = new Set(["notes_save"]);

/** Read-only tools the dashboard may poll without writing to the action log. */
const DASHBOARD_TOOLS = new Set([
  "proxmox_guests",
  "proxmox_storage",
  "timer_list",
  "list_show",
  "alerts_list",
]);

const codeTool = (name: string) => name.startsWith("code_");
function auditArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (isDesktopTool(name)) return desktopAuditArgs(name, args);
  if (name === "notes_save")
    return {
      titleCharacters:
        typeof args.title === "string" ? [...args.title].length : 0,
      contentBytes:
        typeof args.content === "string" ? Buffer.byteLength(args.content) : 0,
    };
  if (name === "notes_search")
    return {
      queryCharacters:
        typeof args.query === "string" ? [...args.query].length : 0,
    };
  if (name === "documents_search")
    return {
      queryCharacters:
        typeof args.query === "string" ? [...args.query].length : 0,
    };
  if (name === "route_estimate" || name === "calendar_departure")
    return {
      mode: args.mode ?? "driving-car",
      originProvided: typeof args.origin === "string",
    };
  if (name === "node_red_flow")
    return {
      flow: args.flow,
      payloadBytes: Buffer.byteLength(JSON.stringify(args.payload ?? {})),
    };
  if (!codeTool(name)) return args;
  const safe: Record<string, unknown> = {};
  for (const key of ["path", "projectId", "draftId"])
    if (typeof args[key] === "string") safe[key] = args[key];
  for (const key of ["command", "testCommand"])
    if (Array.isArray(args[key]))
      safe[key] = {
        executable: (args[key] as unknown[])[0],
        argumentCount: Math.max(0, (args[key] as unknown[]).length - 1),
      };
  if (typeof args.content === "string")
    safe.content = { bytes: Buffer.byteLength(args.content) };
  return safe;
}

/** Keep private note bodies, titles, and search terms out of the durable action log. */
export function noteAuditProjection(
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
): {
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
} | null {
  if (!name.startsWith("notes_")) return null;
  const safeResult: Record<string, unknown> = { ok: result.ok };
  const payload = result.result as
    { id?: unknown; count?: unknown; notes?: unknown } | undefined;
  if (name === "notes_save" && typeof payload?.id === "string")
    safeResult.noteId = payload.id;
  if (
    (name === "notes_search" || name === "notes_recent") &&
    Array.isArray(payload?.notes)
  )
    safeResult.count = payload.notes.length;
  if (!result.ok) safeResult.error = "Notes operation failed";
  return { arguments: auditArgs(name, args), result: safeResult };
}

export function documentAuditProjection(
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
): {
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
} | null {
  if (!name.startsWith("documents_")) return null;
  const safe: Record<string, unknown> = { ok: result.ok };
  const payload = result.result as
    { results?: unknown[]; documents?: unknown[] } | undefined;
  if (Array.isArray(payload?.results)) safe.count = payload.results.length;
  if (Array.isArray(payload?.documents)) safe.count = payload.documents.length;
  if (!result.ok) safe.error = "Document operation failed";
  return { arguments: auditArgs(name, args), result: safe };
}

/** Route cities and calendar titles are private; retain only action metadata. */
export function routeAuditProjection(
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
): { arguments: Record<string, unknown>; result: { ok: boolean } } | null {
  if (name !== "route_estimate" && name !== "calendar_departure") return null;
  return { arguments: auditArgs(name, args), result: { ok: result.ok } };
}

export function nodeRedRoutineAuditProjection(
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
): {
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
} | null {
  if (name !== "node_red_flow_create") return null;
  const safeArgs: Record<string, unknown> = {};
  for (const key of ["tabId", "kind", "time"])
    if (typeof args[key] === "string") safeArgs[key] = args[key];
  if (typeof args.message === "string")
    safeArgs.messageCharacters = args.message.length;
  return {
    arguments: safeArgs,
    result: {
      ok: result.ok,
      verified: result.verified ?? null,
      ...(result.ok === false
        ? { error: "Node-RED routine operation failed" }
        : {}),
    },
  };
}

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
    @Optional() private readonly autonomy?: AutonomyLevelStore,
  ) {}

  /** When untrusted content (web, mail, files, the screen) was last read per session. */
  private readonly untrustedAt = new Map<string, number>();

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
      } catch {
        this.log.warn(`${source.source}: definitions unavailable`);
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
          (this.config.extensionsEnabled ||
            source.source === "nova" ||
            source.source === "code" ||
            (source.source === "settings" &&
              PERSONAL_SETTINGS_TOOLS.has(raw.name)));
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
  forModel(
    context?: { message: string; role: ModelRoleId },
    readOnlyOnly = false,
  ): ModelTool[] {
    const tools = [...this.registry().values()]
      .filter(
        (tool) =>
          tool.definition.enabled &&
          (!readOnlyOnly || tool.definition.risk === "READ_ONLY"),
      )
      .map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.definition.name,
          description: tool.definition.description,
          parameters: tool.definition.parameters,
        },
      }));
    return context
      ? selectToolsForRequest(tools, context.message, context.role)
      : tools;
  }

  /** Search only currently enabled tools in the caller's execution scope. */
  discoverForModel(query: string, readOnlyOnly = false): ModelTool[] {
    return rankToolsForRequest(
      this.forModel(undefined, readOnlyOnly).filter(
        (tool) => tool.function.name !== TOOL_DISCOVERY_NAME,
      ),
      query,
      "conversation",
    ).slice(0, 8);
  }

  /** Rebuild definitions from the live registry; never trust schemas returned by a tool. */
  expandModelTools(
    current: ModelTool[],
    query: string,
    readOnlyOnly = false,
  ): ModelTool[] {
    const available = this.forModel(undefined, readOnlyOnly);
    const byName = new Map(available.map((tool) => [tool.function.name, tool]));
    const names = [
      TOOL_DISCOVERY_NAME,
      ...this.discoverForModel(query, readOnlyOnly).map(
        (tool) => tool.function.name,
      ),
      ...current.map((tool) => tool.function.name),
    ];
    return [...new Set(names)]
      .flatMap((name) => (byName.has(name) ? [byName.get(name)!] : []))
      .slice(0, MAX_MODEL_TOOLS);
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
    always = false,
    options: { signal?: AbortSignal; readOnlyOnly?: boolean } = {},
  ): Promise<ToolResult> {
    const started = Date.now();
    let args: Record<string, unknown> = (rawArgs ?? {}) as Record<
      string,
      unknown
    >;
    let risk: Risk = "READ_ONLY";
    let confirmation = "not_required";
    let standingApproval = false;
    let entity: ToolPlan["entity"] = null;
    const finish = (result: ToolResult): ToolResult => {
      const clean = sanitize(
        standingApproval ? { ...result, standingApproval: true } : result,
      );
      const privateMemory =
        name === "memory_remember"
          ? memoryAuditProjection(args, clean)
          : name === "memory_correct"
            ? memoryCorrectAuditProjection(args, clean)
            : null;
      const privateNote = noteAuditProjection(name, args, clean);
      const privateDocument = documentAuditProjection(name, args, clean);
      const privateRoutine = nodeRedRoutineAuditProjection(name, args, clean);
      const privateRoute = routeAuditProjection(name, args, clean);
      this.audit.record({
        sessionId,
        tool: name,
        arguments:
          codeTool(name) || isDesktopTool(name)
            ? auditArgs(name, args)
            : (privateMemory?.arguments ??
              privateNote?.arguments ??
              privateDocument?.arguments ??
              privateRoutine?.arguments ??
              privateRoute?.arguments ??
              args),
        risk,
        confirmation,
        result: isDesktopTool(name)
          ? desktopAuditResult(clean)
          : codeTool(name) || name === "node_red_flow"
            ? {
                ok: clean.ok,
                ...(clean.error ? { error: clean.error } : {}),
                verified: clean.verified ?? null,
                ...(name === "node_red_flow" && clean.status !== undefined
                  ? { status: clean.status }
                  : {}),
              }
            : (privateMemory?.result ??
              privateNote?.result ??
              privateDocument?.result ??
              privateRoutine?.result ??
              privateRoute?.result ??
              clean),
        verification: clean.verified ?? null,
        durationMs: Date.now() - started,
      });
      if (
        !SYSTEM_SESSIONS.has(sessionId) &&
        !codeTool(name) &&
        !isDesktopTool(name) &&
        name !== "node_red_flow" &&
        name !== "route_estimate" &&
        name !== "calendar_departure"
      )
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
          ? "De Windows-agent is niet ingesteld, dus browser_* bestaat niet. Gebruik windows_search om de zoekopdracht op de pc te openen, of web_search om zelf het antwoord te zoeken."
          : "Deze tool bestaat niet of staat uit. Gebruik alleen tools uit je lijst.",
      });
    risk = tool.definition.risk;
    const transportArgs = dropTransportReason(
      tool.definition.parameters,
      rawArgs,
    );
    const unknownArguments = hasUnknownArguments(
      tool.definition.parameters,
      transportArgs,
    );
    const schemaFingerprint = approvalHash({
      source: tool.source.source,
      revision: tool.definition.approvalRevision ?? null,
      name,
      parameters: tool.definition.parameters,
      description: tool.definition.description,
      risk: tool.definition.risk,
      ...(tool.definition.allowStandingApproval === false
        ? { allowStandingApproval: false }
        : {}),
    });
    const cleaned = coerceArguments(tool.definition.parameters, transportArgs);
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
      const timeout = AbortSignal.timeout(
        Math.min(tool.definition.timeoutMs, this.config.toolTimeoutMs),
      );
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      const call = {
        sessionId,
        signal,
        readOnlyOnly: options.readOnlyOnly === true,
      };
      let plan: ToolPlan = { args, risk };
      if (tool.source.prepare) {
        const prepared = await tool.source.prepare(name, args, call);
        if ("error" in prepared) return finish({ ok: false, ...prepared });
        plan = prepared;
        args = plan.args;
        risk = plan.risk;
        entity = plan.entity ?? null;
      }
      if (options.readOnlyOnly && risk !== "READ_ONLY")
        return finish({
          ok: false,
          error: "Proactive requests may only run read-only tools",
        });
      if (
        risk !== "READ_ONLY" &&
        !name.startsWith("memory_") &&
        !LOCAL_PERSONAL_TOOLS.has(name) &&
        !(
          tool.source.source === "settings" && PERSONAL_SETTINGS_TOOLS.has(name)
        ) &&
        !this.config.actionsEnabled
      )
        return finish({
          ok: false,
          error:
            "Device actions are disabled until integration onboarding is complete",
        });
      const screenRequired = requiresScreenConfirmation(name, args, risk);
      const needsConfirmation =
        screenRequired ||
        risk === "CONFIRM" ||
        (risk === "SAFE" && !this.config.autoExecuteSafe);
      const allowStandingApproval =
        tool.definition.allowStandingApproval !== false && !screenRequired;
      if (needsConfirmation) {
        const matches =
          approved &&
          approved.tool === name &&
          approved.sessionId === sessionId &&
          approved.expiresAt > Date.now() &&
          JSON.stringify(approved.args) === JSON.stringify(args) &&
          (!approved.risk || approved.risk === risk) &&
          (!approved.schemaFingerprint ||
            approved.schemaFingerprint === schemaFingerprint);
        const argsHash = approvalHash(args);
        const grants = this.settings.get().standingApprovals ?? [];
        const standing =
          risk === "CONFIRM" &&
          allowStandingApproval &&
          !unknownArguments &&
          grants.some(
            (grant) =>
              grant.tool === name &&
              grant.argsHash === argsHash &&
              grant.schemaHash === schemaFingerprint,
          );
        const auto =
          !matches &&
          !standing &&
          risk === "CONFIRM" &&
          !screenRequired &&
          !unknownArguments &&
          allowsAutoApproval(name, {
            level: this.autonomy?.get() ?? "careful",
            routine: plan.routine,
            tainted:
              Date.now() - (this.untrustedAt.get(sessionId) ?? 0) <
              TAINT_WINDOW_MS,
          });
        if (!matches && !standing && !auto) {
          confirmation = "pending";
          const action = this.confirmations.create(
            sessionId,
            name,
            args,
            risk,
            schemaFingerprint,
            allowStandingApproval,
          );
          return finish({ ok: false, requiresConfirmation: true, action });
        }
        confirmation = auto
          ? "auto_approved"
          : standing && !matches
            ? "standing_approval"
            : "confirmed";
        standingApproval = confirmation === "standing_approval";
        if (
          always &&
          matches &&
          risk === "CONFIRM" &&
          allowStandingApproval &&
          !unknownArguments &&
          approved.schemaFingerprint === schemaFingerprint &&
          !standing
        ) {
          if (grants.length >= 100)
            return finish({
              ok: false,
              error:
                "Standing approval limit reached; revoke a rule in settings first",
            });
          const grant = {
            id: crypto.randomUUID(),
            tool: name,
            argsHash,
            schemaHash: schemaFingerprint,
            scope: JSON.stringify(sanitize(args)).slice(0, 500),
            createdAt: Date.now(),
          };
          this.audit.record({
            sessionId,
            tool: name,
            risk,
            confirmation: "standing_approval_created",
            grantId: grant.id,
            argsHash,
            schemaHash: schemaFingerprint,
          });
          this.settings.update((next) => {
            next.standingApprovals.push(grant);
          });
        }
      }
      // Prove the log is writable before anything changes.
      if (risk !== "READ_ONLY")
        this.audit.record({
          sessionId,
          tool: name,
          arguments: auditArgs(name, args),
          risk,
          confirmation,
          phase: "execution_started",
        });
      signal.throwIfAborted();
      const result = await tool.source.execute(name, args, { ...call, plan });
      if (!result || typeof result.ok !== "boolean")
        return finish({ ok: false, error: "Malformed tool response" });
      if (UNTRUSTED_SOURCES.has(tool.source.source)) {
        this.untrustedAt.set(sessionId, Date.now());
        if (this.untrustedAt.size > 500)
          this.untrustedAt.delete(this.untrustedAt.keys().next().value!);
      }
      return finish(result);
    } catch {
      this.log.warn(`${name} failed`);
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
