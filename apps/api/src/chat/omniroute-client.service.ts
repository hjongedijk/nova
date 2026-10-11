import { Injectable, Optional } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";
import { RoutingService } from "../routing/routing.service.js";
import { ModelMetricsService } from "../routing/model-metrics.service.js";
import { sanitize } from "../core/security/sanitize.js";
import type { ModelTool } from "../tools/tools.service.js";
import type { ModelRoleId } from "@nova/contracts";
import {
  extractAssistantMood,
  stripPrivateMoodMarkers,
  type AssistantMood,
} from "./assistant-mood.js";

export interface ModelToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ModelToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "auto" } };

export type ModelInputMessage =
  | ModelMessage
  | {
      role: "user";
      content: ModelContentPart[];
    };

export interface GatewayMetadata {
  compression: string | null;
  cache: string | null;
  sessionId: string | null;
  model?: string | null;
  provider?: string | null;
  fallback?: unknown;
  latencyMs?: number;
}

export interface ModelAnswer {
  assistant: ModelMessage;
  model: string | null;
  usage: Record<string, unknown> | null;
  metadata: GatewayMetadata;
  mood?: AssistantMood;
}

export interface CallOptions {
  /** Stream tokens to `emit` as they arrive. */
  stream?: boolean;
  emit?: (event: string, data: Record<string, unknown>) => void;
  signal?: AbortSignal;
  sessionId?: string;
  toolChoice?: "auto" | "required";
  /** A pure text answer is wanted: no tools are offered. */
  tools?: ModelTool[];
  maxTokens?: number;
  /** Set only by the internal role router; validated against both role settings and free policy. */
  roleModel?: { role: ModelRoleId; modelId: string };
  includeMood?: boolean;
}

/**
 * The one way NOVA talks to a language model: through OmniRoute, which owns the free-only selection,
 * quota and failover. Nothing is sent unless the free route is verified, and there is no other gateway
 * to fall back to.
 */
@Injectable()
export class OmniRouteClient {
  constructor(
    private readonly config: NovaConfig,
    private readonly routing: RoutingService,
    @Optional() private readonly metrics?: ModelMetricsService,
  ) {}

  private recordResponse(
    model: unknown,
    provider: unknown,
    started: number,
  ): void {
    this.metrics?.observe(model, provider, Date.now() - started);
  }

  get configured(): boolean {
    return Boolean(
      this.config.omniKey &&
      this.config.omniModel &&
      this.config.omniKey !== "CHANGE_ME" &&
      this.config.omniModel !== "CHANGE_ME",
    );
  }

  /** A plain text completion without tools (settings assistant, summaries). */
  async complete(
    messages: ModelMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    const answer = await this.call(messages, { signal });
    return String(answer.assistant.content ?? "");
  }

  async call(
    messages: ModelInputMessage[],
    options: CallOptions = {},
  ): Promise<ModelAnswer> {
    const {
      stream = false,
      emit = () => {},
      signal,
      sessionId,
      toolChoice = "auto",
      tools = [],
      includeMood = false,
    } = options;
    const started = Date.now();
    const roleModels = options.roleModel
      ? this.routing.roleModels(options.roleModel.role)
      : [];
    const model = options.roleModel
      ? this.routing.assertRoleModel(
          options.roleModel.role,
          options.roleModel.modelId,
        )
      : this.config.omniModel;
    const attempts = options.roleModel
      ? [model, ...roleModels.filter((candidate) => candidate !== model)]
      : [model];
    const body: Record<string, unknown> = {
      model,
      messages: sanitize(messages),
      temperature: 0.7,
      max_tokens: options.maxTokens ?? 1800,
      reasoning_effort: "none",
      stream,
    };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }
    this.routing.assertFree();
    let response: Response | undefined;
    let lastFailure: unknown;
    for (const candidate of attempts) {
      if (options.roleModel)
        body.model = this.routing.assertRoleModel(
          options.roleModel.role,
          candidate,
        );
      try {
        response = await fetch(`${this.config.omniUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.omniKey}`,
            "x-omniroute-no-memory": "true",
            "x-omniroute-compression":
              this.config.omniCompression === "lite" ? "lite" : "off",
            ...(sessionId
              ? {
                  "x-omniroute-session-id": sessionId,
                  "x-session-id": sessionId,
                }
              : {}),
            ...(tools.length ? { "x-omniroute-no-cache": "true" } : {}),
          },
          body: JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
            : AbortSignal.timeout(60_000),
        });
      } catch (error) {
        lastFailure = error;
        if (
          !options.roleModel ||
          signal?.aborted ||
          candidate === attempts.at(-1)
        )
          throw error;
        continue;
      }
      if (
        response.ok ||
        !options.roleModel ||
        ![429, 500, 502, 503, 504].includes(response.status) ||
        candidate === attempts.at(-1)
      )
        break;
      lastFailure = new Error(`OmniRoute request failed (${response.status})`);
    }
    if (!response) throw lastFailure ?? new Error("OmniRoute request failed");
    if (
      !response.ok &&
      [400, 415, 422].includes(response.status) &&
      messages.some((message) => Array.isArray(message.content))
    )
      throw new Error(
        "OmniRoute weigert deze afbeelding. Kies in OmniRoute een gratis model dat afbeeldingen kan lezen, of stuur een PDF of tekstdocument.",
      );
    if (!response.ok)
      throw new Error(
        `OmniRoute request failed (${response.status}); no alternate gateway or paid fallback was attempted`,
      );
    const gateway: GatewayMetadata = {
      compression: response.headers.get("x-omniroute-compression"),
      cache: response.headers.get("x-omniroute-cache"),
      sessionId: sessionId ?? null,
    };
    if (!stream) {
      const data = (await response.json()) as {
        choices?: { message?: ModelMessage }[];
        model?: string;
        usage?: Record<string, unknown>;
        provider?: string;
        fallback?: unknown;
      };
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error("OmniRoute returned no assistant message");
      const parsed = includeMood
        ? extractAssistantMood(String(message.content ?? ""))
        : undefined;
      this.recordResponse(data.model, data.provider, started);
      return {
        assistant: parsed ? { ...message, content: parsed.content } : message,
        model: data.model ?? null,
        usage: data.usage ?? null,
        ...(parsed ? { mood: parsed.mood } : {}),
        metadata: {
          ...gateway,
          model: data.model ?? null,
          provider: data.provider ?? null,
          fallback: data.fallback ?? null,
          latencyMs: Date.now() - started,
        },
      };
    }
    return this.readStream(response, gateway, started, emit, includeMood);
  }

  private async readStream(
    response: Response,
    gateway: GatewayMetadata,
    started: number,
    emit: NonNullable<CallOptions["emit"]>,
    includeMood: boolean,
  ): Promise<ModelAnswer> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let pendingMoodText = "";
    let mood: AssistantMood = "neutral";
    const moodPrefix = "<!--NOVA_MOOD:";
    let moodEmitted = false;
    let model: string | null = null;
    let usage: Record<string, unknown> | null = null;
    let provider: string | null = null;
    let fallback: unknown = null;
    let finished = false;
    const calls = new Map<number, ModelToolCall>();

    const consume = (line: string) => {
      if (!line.startsWith("data:")) return;
      const raw = line.slice(5).trim();
      if (raw === "[DONE]") {
        finished = true;
        return;
      }
      if (!raw) return;
      let data: {
        error?: unknown;
        model?: string;
        usage?: Record<string, unknown>;
        provider?: string;
        fallback?: unknown;
        choices?: {
          finish_reason?: string;
          delta?: {
            content?: string;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
        }[];
      };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("Malformed OmniRoute stream");
      }
      if (data.error) throw new Error("OmniRoute stream failed");
      model = data.model ?? model;
      usage = data.usage ?? usage;
      provider = data.provider ?? provider;
      fallback = data.fallback ?? fallback;
      const delta = data.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string") {
        content += delta.content;
        if (!includeMood) emit("token", { text: delta.content });
        else {
          pendingMoodText += delta.content;
          const markerAt = pendingMoodText.indexOf(moodPrefix);
          if (markerAt >= 0) {
            if (markerAt > 0)
              emit("token", { text: pendingMoodText.slice(0, markerAt) });
            pendingMoodText = pendingMoodText.slice(markerAt);
            if (pendingMoodText.includes("-->")) {
              if (content.startsWith(moodPrefix)) {
                const parsedMood = extractAssistantMood(pendingMoodText);
                if (parsedMood.matched) {
                  mood = parsedMood.mood;
                  moodEmitted = true;
                  emit("mood", { mood });
                  pendingMoodText = parsedMood.content;
                  if (pendingMoodText) emit("token", { text: pendingMoodText });
                  pendingMoodText = "";
                } else {
                  emit("token", { text: parsedMood.content });
                  pendingMoodText = "";
                }
              }
            }
          } else if (pendingMoodText.length >= moodPrefix.length) {
            const safeLength = pendingMoodText.length - moodPrefix.length + 1;
            emit("token", { text: pendingMoodText.slice(0, safeLength) });
            pendingMoodText = pendingMoodText.slice(safeLength);
          }
        }
      }
      for (const fragment of delta.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        if (index < 0) throw new Error("Malformed tool call");
        // Calls past the eighth are dropped; the orchestrator answers with the first eight.
        if (index > 7) continue;
        const current = calls.get(index) ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        current.id += fragment.id ?? "";
        current.function.name += fragment.function?.name ?? "";
        current.function.arguments += fragment.function?.arguments ?? "";
        if (current.function.arguments.length > 20_000)
          throw new Error("Tool arguments exceeded limit");
        calls.set(index, current);
      }
      if (data.choices?.[0]?.finish_reason) finished = true;
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1_000_000)
          throw new Error("OmniRoute stream exceeded limit");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          consume(buffer.slice(0, end).replace(/\r$/, ""));
          buffer = buffer.slice(end + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer.trim());
      if (!finished)
        throw new Error("OmniRoute stream ended before completion");
      if (includeMood) {
        const parsed = extractAssistantMood(content);
        mood = parsed.mood;
        if (parsed.matched && !moodEmitted) emit("mood", { mood });
        const pending = parsed.matched
          ? ""
          : stripPrivateMoodMarkers(pendingMoodText);
        if (pending) emit("token", { text: pending });
        content = parsed.content;
      }
      this.recordResponse(model, provider, started);
      return {
        assistant: {
          role: "assistant",
          content: content || null,
          ...(calls.size ? { tool_calls: [...calls.values()] } : {}),
        },
        model,
        usage,
        ...(includeMood ? { mood } : {}),
        metadata: {
          ...gateway,
          model,
          provider,
          fallback,
          latencyMs: Date.now() - started,
        },
      };
    } finally {
      reader.releaseLock();
    }
  }
}
