import {
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  UnauthorizedException,
  ServiceUnavailableException,
  Body,
  BadRequestException,
} from "@nestjs/common";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { AlertsFeed } from "./alerts-feed.service.js";
import { NodeRedHealth } from "./node-red-health.service.js";
import { matchesNodeRedToken } from "./node-red-token.js";

const MAX_BODY_BYTES = 4096;
const MAX_PER_MINUTE = 60;
const severities = new Set(["info", "warning", "critical"]);
const RAW_DIAGNOSTIC =
  /\b(?:exception|traceback|stack trace|error|failed|failure|econn\w+|timeout)\b|https?:\/\/|(?:\d{1,3}\.){3}\d{1,3}|\b(?:bearer|token|password|secret)\s*[:= ]/i;

type IncomingEvent = {
  type?: unknown;
  title?: unknown;
  detail?: unknown;
  severity?: unknown;
  category?: unknown;
  at?: unknown;
  flowId?: unknown;
  deliveryId?: unknown;
};

/** Authenticated, bounded ingress for plain notifications from trusted flows. */
@Controller("integrations/node-red/events")
export class NodeRedEventsController {
  private windowStartedAt = Date.now();
  private acceptedInWindow = 0;

  constructor(
    private readonly config: NovaConfig,
    private readonly alerts: AlertsFeed,
    private readonly health: NodeRedHealth,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(202)
  receive(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: IncomingEvent,
  ): { accepted: true } {
    const expected = this.config.nodeRedEventToken;
    if (expected.length < 32)
      throw new ServiceUnavailableException(
        "Node-RED event ingress is not configured",
      );
    if (!matchesNodeRedToken(authorization, expected))
      throw new UnauthorizedException();

    const now = Date.now();
    if (now - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = now;
      this.acceptedInWindow = 0;
    }
    if (this.acceptedInWindow >= MAX_PER_MINUTE)
      throw new HttpException(
        "Too many Node-RED events",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    this.acceptedInWindow++;

    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new BadRequestException("Invalid Node-RED event");
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES)
      throw new BadRequestException("Node-RED event is too large");

    if (
      body.deliveryId !== undefined &&
      (body.type !== "alert" ||
        typeof body.deliveryId !== "string" ||
        !/^nova-workflow:[a-f0-9]{64}$/.test(body.deliveryId))
    )
      throw new BadRequestException("Invalid workflow delivery id");

    if (body.type === "alert") {
      if (typeof body.title !== "string" || !body.title.trim())
        throw new BadRequestException("Alert title is required");
      if (
        body.severity !== undefined &&
        !severities.has(body.severity as string)
      )
        throw new BadRequestException("Unsupported alert severity");
      if (body.category !== undefined && body.category !== "briefing")
        throw new BadRequestException("Unsupported alert category");
      const at =
        typeof body.at === "string" && !Number.isNaN(Date.parse(body.at))
          ? new Date(body.at).toISOString()
          : new Date().toISOString();
      const rawTitle = sanitize(body.title).slice(0, 120);
      const rawDetail =
        typeof body.detail === "string"
          ? sanitize(body.detail).slice(0, 240)
          : "";
      const diagnostic =
        RAW_DIAGNOSTIC.test(body.title) ||
        (typeof body.detail === "string" && RAW_DIAGNOSTIC.test(body.detail));
      let result;
      try {
        result = this.alerts.recordNodeRedAlert({
          title: diagnostic ? "Node-RED meldt een fout" : rawTitle,
          detail: diagnostic
            ? "Een flow meldde een fout. Controleer de flow in Node-RED."
            : rawDetail,
          severity: body.severity as
            "info" | "warning" | "critical" | undefined,
          category: diagnostic
            ? undefined
            : (body.category as "briefing" | undefined),
          at,
          deliveryId: body.deliveryId as string | undefined,
        });
      } catch {
        throw new ServiceUnavailableException(
          "Node-RED alert acceptance unavailable",
        );
      }
      if (!result) throw new BadRequestException("Node-RED alert was rejected");
    } else if (body.type === "runtime_error") {
      if (typeof body.detail !== "string" || !body.detail.trim())
        throw new BadRequestException("Runtime error detail is required");
      if (
        body.flowId !== undefined &&
        (typeof body.flowId !== "string" ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(body.flowId))
      )
        throw new BadRequestException("Invalid Node-RED flow id");
      this.health.recordRuntimeError(
        body.detail,
        typeof body.flowId === "string" ? body.flowId : undefined,
      );
    } else {
      throw new BadRequestException("Unsupported Node-RED event type");
    }

    this.audit.record({
      tool: "node_red_event",
      phase: "accepted",
      eventType: body.type,
      severity: body.type === "alert" ? body.severity : "error",
    });
    return { accepted: true };
  }
}
