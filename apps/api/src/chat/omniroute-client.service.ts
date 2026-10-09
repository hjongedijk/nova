import { Injectable } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";
import { RoutingService } from "../routing/routing.service.js";
import type { ModelTool } from "../tools/tools.service.js";

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
  ) {}

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
    } = options;
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.config.omniModel,
      messages,
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
    const response = await fetch(`${this.config.omniUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.omniKey}`,
        "x-omniroute-no-memory": "true",
        "x-omniroute-compression":
          this.config.omniCompression === "lite" ? "lite" : "off",
        ...(sessionId
          ? { "x-omniroute-session-id": sessionId, "x-session-id": sessionId }
          : {}),
        ...(tools.length ? { "x-omniroute-no-cache": "true" } : {}),
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
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
      return {
        assistant: message,
        model: data.model ?? null,
        usage: data.usage ?? null,
        metadata: {
          ...gateway,
          model: data.model ?? null,
          provider: data.provider ?? null,
          fallback: data.fallback ?? null,
          latencyMs: Date.now() - started,
        },
      };
    }
    return this.readStream(response, gateway, started, emit);
  }

  private async readStream(
    response: Response,
    gateway: GatewayMetadata,
    started: number,
    emit: NonNullable<CallOptions["emit"]>,
  ): Promise<ModelAnswer> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
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
        emit("token", { text: delta.content });
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
      return {
        assistant: {
          role: "assistant",
          content: content || null,
          ...(calls.size ? { tool_calls: [...calls.values()] } : {}),
        },
        model,
        usage,
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
