import type { ChatAttachment } from "@nova/contracts";
import { checkAttachments } from "./attachments.js";
import { Body, ConflictException, Controller, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { ValidationError } from "../core/errors/validation.error.js";
import { publishableConversation } from "./conversation-events.js";
import { sanitize } from "../core/security/sanitize.js";
import { MqttService } from "../core/mqtt/mqtt.service.js";
import {
  SessionMemoryService,
  normalizeSessionId,
} from "../memory/session-memory.service.js";
import { ConfirmationHandler } from "./confirmation-handler.service.js";
import { OmniRouteClient } from "./omniroute-client.service.js";
import { OrchestratorService, type Reply } from "./orchestrator.service.js";

interface ChatBody {
  message?: unknown;
  sessionId?: unknown;
  confirmationId?: unknown;
  confirmedTools?: unknown;
  [key: string]: unknown;
}

/** One request at a time per session: a second one would answer on top of the first. */
const active = new Set<string>();

const FORBIDDEN_OVERRIDES = ["model", "provider", "route", "fallback"];

function check(body: ChatBody): {
  sessionId: string;
  message: string;
  attachments: ChatAttachment[];
  inputMode: "text" | "voice";
  confirmationId?: string;
} {
  if (FORBIDDEN_OVERRIDES.some((key) => body?.[key] !== undefined))
    throw new ValidationError([
      "Model and provider overrides are disabled; OmniRoute owns routing",
    ]);
  if (
    !body ||
    typeof body.message !== "string" ||
    !body.message.trim() ||
    body.message.length > 10_000
  )
    throw new ValidationError(["Invalid message"]);
  if (
    body.inputMode !== undefined &&
    body.inputMode !== "text" &&
    body.inputMode !== "voice"
  )
    throw new ValidationError(["Invalid input mode"]);
  const sessionId = normalizeSessionId(body.sessionId);
  if (
    body.confirmationId !== undefined &&
    (typeof body.confirmationId !== "string" ||
      body.confirmationId.length > 100)
  )
    throw new ValidationError(["Invalid confirmation ID"]);
  if (body.confirmedTools !== undefined)
    throw new ValidationError([
      "Use session confirmation; confirmedTools is unsupported",
    ]);
  return {
    sessionId,
    attachments: checkAttachments(body.attachments),
    inputMode: body.inputMode === "voice" ? "voice" : "text",
    message: body.message.trim(),
    confirmationId: body.confirmationId as string | undefined,
  };
}

@Controller()
export class ChatController {
  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly handler: ConfirmationHandler,
    private readonly memory: SessionMemoryService,
    private readonly client: OmniRouteClient,
    private readonly mqtt: MqttService,
  ) {}

  private remember(
    sessionId: string,
    message: string,
    result: Reply,
    startedAt: number,
  ): void {
    this.memory.add(sessionId, "user", message);
    this.memory.add(sessionId, "assistant", result.reply);
    this.mqtt.publish(
      "jarvis/events/conversation",
      publishableConversation(sessionId, result, startedAt),
    );
  }

  /** POST /api/chat: one question, one complete answer. */
  @Post("chat")
  async chat(@Body() body: ChatBody): Promise<Record<string, unknown>> {
    const { sessionId, message, confirmationId, attachments, inputMode } =
      check(body);
    if (!this.client.configured)
      throw new ConflictException("OmniRoute is not configured");
    if (active.has(sessionId))
      throw new ConflictException(
        "A request is already active for this session",
      );
    active.add(sessionId);
    const started = Date.now();
    try {
      const result = await this.orchestrator.run({
        sessionId,
        message,
        attachments,
        inputMode,
        confirmationId,
      });
      this.remember(sessionId, message, result, started);
      return sanitize({
        ...result,
        sessionId,
        durationMs: Date.now() - started,
      });
    } finally {
      active.delete(sessionId);
    }
  }

  /** POST /api/chat-stream: the same, as Server-Sent Events (token, tool_start, tool_result, confirmation, done). */
  @Post("chat-stream")
  async stream(
    @Body() body: ChatBody,
    @Res() response: Response,
  ): Promise<void> {
    const { sessionId, message, confirmationId, attachments, inputMode } =
      check(body);
    if (!this.client.configured) {
      response.status(503).json({ error: "OmniRoute is not configured" });
      return;
    }
    if (active.has(sessionId)) {
      response
        .status(409)
        .json({ error: "A request is already active for this session" });
      return;
    }
    active.add(sessionId);
    response.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    const emit = (event: string, data: unknown) => {
      if (response.writableEnded || response.destroyed) return;
      response.write(
        `event: ${event}\ndata: ${JSON.stringify(sanitize(data))}\n\n`,
      );
    };
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref();
    emit("connected", { ok: true, sessionId });
    const started = Date.now();
    try {
      const result = await this.orchestrator.run({
        sessionId,
        message,
        attachments,
        inputMode,
        confirmationId,
        stream: true,
        emit,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      this.remember(sessionId, message, result, started);
      emit("done", { ...result, sessionId, durationMs: Date.now() - started });
    } catch (error) {
      if (!controller.signal.aborted)
        emit("error", { error: sanitize((error as Error).message) });
    } finally {
      clearInterval(heartbeat);
      active.delete(sessionId);
      response.end();
    }
  }

  /** POST /api/actions/confirm: the confirm and cancel buttons on a confirmation card. */
  @Post("actions/confirm")
  async confirm(
    @Body()
    body: {
      sessionId?: unknown;
      confirmationId?: unknown;
      approve?: unknown;
    },
  ) {
    if (typeof body?.confirmationId !== "string")
      throw new ValidationError(["Confirmation ID required"]);
    const sessionId = normalizeSessionId(body.sessionId);
    if (active.has(sessionId))
      throw new ConflictException(
        "A request is already active for this session",
      );
    active.add(sessionId);
    try {
      const reply = await this.handler.handle(
        sessionId,
        body.approve === true ? "yes" : "cancel",
        body.confirmationId,
      );
      return sanitize(
        reply ?? {
          reply: "Daar staat niets meer voor open. Vraag het gerust opnieuw.",
        },
      );
    } finally {
      active.delete(sessionId);
    }
  }
}
