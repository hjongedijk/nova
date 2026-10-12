import type {
  ChatAttachment,
  CommunicationPreference,
  ModelRoleId,
} from "@nova/contracts";
import { checkAttachments } from "./attachments.js";
import {
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Post,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import crypto from "node:crypto";
import type { Response } from "express";
import { ValidationError } from "../core/errors/validation.error.js";
import { AppAccessPublic } from "../access/access-public.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { publishableConversation } from "./conversation-events.js";
import { sanitize } from "../core/security/sanitize.js";
import { FreeRoutingBlockedError } from "../routing/routing.service.js";
import { MqttService } from "../core/mqtt/mqtt.service.js";
import {
  SessionMemoryService,
  normalizeSessionId,
} from "../memory/session-memory.service.js";
import { ConfirmationHandler } from "./confirmation-handler.service.js";
import { directAnswer } from "./direct-answer.js";
import { directDefinitionQuery } from "./direct-definition.js";
import { directCurrencyQuery } from "./direct-currency.js";
import { OmniRouteClient } from "./omniroute-client.service.js";
import { OrchestratorService, type Reply } from "./orchestrator.service.js";
import { matchesNodeRedToken } from "../dashboard/node-red-token.js";

interface ChatBody {
  message?: unknown;
  sessionId?: unknown;
  confirmationId?: unknown;
  modelRole?: unknown;
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
  quietHours: boolean;
  communicationPreferences: CommunicationPreference[];
  responseLanguage?: "nl" | "en";
  confirmationId?: string;
  modelRole?: Exclude<ModelRoleId, "embedding">;
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
  if (body.quietHours !== undefined && typeof body.quietHours !== "boolean")
    throw new ValidationError(["Invalid quiet-hours state"]);
  const roles = ["conversation", "code", "planning", "summary", "vision"];
  if (
    body.modelRole !== undefined &&
    (typeof body.modelRole !== "string" || !roles.includes(body.modelRole))
  )
    throw new ValidationError(["Invalid model role"]);
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
  const allowedPreferences = [
    "concise",
    "fewer_jokes",
    "more_detail",
    "warmer",
  ] as const;
  if (
    body.responseLanguage !== undefined &&
    body.responseLanguage !== "nl" &&
    body.responseLanguage !== "en"
  )
    throw new ValidationError(["Invalid response language"]);
  if (
    body.communicationPreferences !== undefined &&
    (!Array.isArray(body.communicationPreferences) ||
      body.communicationPreferences.length > allowedPreferences.length ||
      body.communicationPreferences.some(
        (preference) =>
          typeof preference !== "string" ||
          !allowedPreferences.includes(
            preference as (typeof allowedPreferences)[number],
          ),
      ))
  )
    throw new ValidationError(["Invalid communication preferences"]);
  return {
    sessionId,
    attachments: checkAttachments(body.attachments),
    inputMode: body.inputMode === "voice" ? "voice" : "text",
    quietHours: body.quietHours === true,
    communicationPreferences: Array.isArray(body.communicationPreferences)
      ? (body.communicationPreferences as CommunicationPreference[])
      : [],
    responseLanguage: body.responseLanguage as "nl" | "en" | undefined,
    message: sanitize(body.message.trim()),
    confirmationId: body.confirmationId as string | undefined,
    modelRole: body.modelRole as Exclude<ModelRoleId, "embedding"> | undefined,
  };
}

@Controller()
export class ChatController {
  private proactiveWindowStartedAt = Date.now();
  private proactiveRequests = 0;

  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly handler: ConfirmationHandler,
    private readonly memory: SessionMemoryService,
    private readonly client: OmniRouteClient,
    private readonly mqtt: MqttService,
    private readonly config: NovaConfig,
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
    const {
      sessionId,
      message,
      confirmationId,
      attachments,
      inputMode,
      quietHours,
      communicationPreferences,
      responseLanguage,
      modelRole,
    } = check(body);
    const localCalculation =
      !attachments.length &&
      !confirmationId &&
      (directAnswer(message, responseLanguage) !== null ||
        directCurrencyQuery(message, responseLanguage) !== null ||
        directDefinitionQuery(message, responseLanguage) !== null);
    if (!localCalculation && !this.client.configured)
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
        quietHours,
        communicationPreferences,
        responseLanguage,
        modelRole,
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

  /** Internal endpoint for fixed scheduled Node-RED flows; read-only tools only. */
  @Post("proactive/ask")
  @AppAccessPublic()
  async proactiveAsk(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: ChatBody,
  ): Promise<Record<string, unknown>> {
    if (!this.config.nodeRedEventToken)
      throw new ServiceUnavailableException(
        "Node-RED proactive access is not configured",
      );
    if (!matchesNodeRedToken(authorization, this.config.nodeRedEventToken))
      throw new UnauthorizedException();

    const now = Date.now();
    if (now - this.proactiveWindowStartedAt >= 60_000) {
      this.proactiveWindowStartedAt = now;
      this.proactiveRequests = 0;
    }
    if (this.proactiveRequests >= 10)
      throw new HttpException(
        "Too many proactive requests",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    this.proactiveRequests++;

    const request = check(body);
    if (request.attachments.length)
      throw new ValidationError([
        "Proactive requests cannot include attachments",
      ]);
    const localCalculation =
      !request.confirmationId &&
      (directAnswer(request.message, request.responseLanguage) !== null ||
        directCurrencyQuery(request.message, request.responseLanguage) !==
          null ||
        directDefinitionQuery(request.message, request.responseLanguage) !==
          null);
    if (!localCalculation && !this.client.configured)
      throw new ConflictException("OmniRoute is not configured");
    const sessionId = `proactive_${crypto.randomUUID()}`;
    if (active.has(sessionId))
      throw new ConflictException("Proactive request is already active");
    active.add(sessionId);
    try {
      const result = await this.orchestrator.run({
        ...request,
        sessionId,
        readOnlyOnly: true,
      });
      return sanitize({ ...result, sessionId });
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
    const {
      sessionId,
      message,
      confirmationId,
      attachments,
      inputMode,
      quietHours,
      communicationPreferences,
      responseLanguage,
      modelRole,
    } = check(body);
    const localCalculation =
      !attachments.length &&
      !confirmationId &&
      (directAnswer(message, responseLanguage) !== null ||
        directCurrencyQuery(message, responseLanguage) !== null ||
        directDefinitionQuery(message, responseLanguage) !== null);
    if (!localCalculation && !this.client.configured) {
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
        quietHours,
        communicationPreferences,
        responseLanguage,
        modelRole,
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
        emit("error", {
          error:
            error instanceof FreeRoutingBlockedError
              ? responseLanguage === "en"
                ? "No verified free AI route is available."
                : "Geen geverifieerde gratis AI-route beschikbaar."
              : responseLanguage === "en"
                ? "That did not work. Check the settings and try again."
                : "Dat is niet gelukt. Controleer de instellingen en probeer opnieuw.",
        });
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
      always?: unknown;
      responseLanguage?: unknown;
    },
  ) {
    if (typeof body?.confirmationId !== "string")
      throw new ValidationError(["Confirmation ID required"]);
    if (
      body.responseLanguage !== undefined &&
      body.responseLanguage !== "nl" &&
      body.responseLanguage !== "en"
    )
      throw new ValidationError(["Invalid response language"]);
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
        body.approve === true && body.always === true,
        body.responseLanguage === "en" ? "en" : "nl",
        true,
      );
      return sanitize(
        reply ?? {
          reply:
            body.responseLanguage === "en"
              ? "There is nothing waiting for confirmation. Please ask again."
              : "Daar staat niets meer voor open. Vraag het gerust opnieuw.",
        },
      );
    } finally {
      active.delete(sessionId);
    }
  }
}
