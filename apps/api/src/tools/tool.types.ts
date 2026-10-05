import { applyDecorators, Injectable, SetMetadata } from "@nestjs/common";
import type {
  ArgumentSchema,
  PendingConfirmation,
  Risk,
} from "@nova/contracts";

/** A tool as a source offers it. */
export interface ToolDefinition {
  name: string;
  /** What the model reads to decide when to use it. English works best for the models. */
  description: string;
  parameters: ArgumentSchema;
  risk: Risk;
  /** Upper limit for one call, at most 60 s. */
  timeoutMs?: number;
  /** False when the tool exists but cannot work right now (missing configuration). */
  enabled?: boolean;
}

/** What every tool answers. `ok` is required; the rest depends on the tool. */
export interface ToolResult {
  ok: boolean;
  error?: string;
  result?: unknown;
  /** true: NOVA checked the effect; null: done but not checked. */
  verified?: boolean | null;
  accepted?: boolean;
  requiresConfirmation?: boolean;
  action?: PendingConfirmation;
  hint?: string;
  details?: string[];
  ambiguous?: boolean;
  candidates?: unknown;
  [key: string]: unknown;
}

/** One call, as a source sees it. */
export interface ToolCall {
  sessionId: string;
  signal: AbortSignal;
}

/** What `prepare` decided: possibly adjusted arguments and the real risk for this call. */
export interface ToolPlan {
  args: Record<string, unknown>;
  risk: Risk;
  /** For the session context: which device/room this is about. */
  entity?: { area?: string | null } | null;
  /** Anything else the source needs in `execute`. */
  data?: unknown;
}

export interface ToolPlanError {
  error: string;
  [key: string]: unknown;
}

/**
 * Anything that offers tools: Proxmox, planning, Home Assistant, the Windows PC, MCP servers,
 * the user's own skills, ... Mark the class with @ToolSource() and register it as a provider in
 * its module; the tool registry finds it by itself.
 */
export interface ToolSource {
  /** Shown in the settings: proxmox, home-assistant, windows, ... */
  readonly source: string;
  definitions(): ToolDefinition[];
  /** Optional: decide the real risk or fix up arguments for this call (e.g. depends on the device). */
  prepare?(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall,
  ): Promise<ToolPlan | ToolPlanError>;
  execute(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall & { plan?: ToolPlan },
  ): Promise<ToolResult>;
}

export const TOOL_SOURCE = Symbol("nova:tool-source");

/** Marks a provider as a source of tools for the registry. */
export const ToolSourceProvider = () =>
  applyDecorators(Injectable(), SetMetadata(TOOL_SOURCE, true));

/** Object schema helpers, so definitions stay short. */
export const schema = (
  properties: Record<string, unknown> = {},
  required: string[] = Object.keys(properties),
): ArgumentSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export const text = (maxLength = 200) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
export const integer = (minimum: number, maximum: number) => ({
  type: "integer",
  minimum,
  maximum,
});
export const number = (minimum: number, maximum: number) => ({
  type: "number",
  minimum,
  maximum,
});
