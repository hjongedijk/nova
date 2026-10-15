import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "./settings.guard.js";
import { StackControlService } from "./stack-control.service.js";
import { NodeRedManagement } from "./node-red-management.service.js";

@Controller("settings/stack-control")
@UseGuards(SettingsGuard)
export class StackControlController {
  constructor(
    private readonly stack: StackControlService,
    private readonly nodeRed: NodeRedManagement,
  ) {}

  @Get("node-red/logs")
  async nodeRedLogs() {
    const logs = await this.stack.nodeRedLogs();
    const mapping = logs.available
      ? await this.nodeRed.resolveLogSources(
          logs.entries.map((row) => row.source),
        )
      : { available: false, flowIds: [] };
    return {
      ...logs,
      flowLinksAvailable: mapping.available,
      entries: logs.entries.map((row, index) => ({
        ...row,
        flowId: mapping.flowIds[index] ?? null,
      })),
    };
  }

  @Get("services")
  status() {
    return this.stack.status();
  }

  @Post("restart/prepare")
  @HttpCode(200)
  prepare(@Body() body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "service")
    )
      throw new ValidationError(["Ongeldige herstartaanvraag."]);
    return this.stack.prepareRestart((body as Record<string, unknown>).service);
  }

  @Post("restart/confirm")
  @HttpCode(200)
  confirm(@Body() body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) => !["sessionId", "confirmationId", "approve"].includes(key),
      )
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const input = body as Record<string, unknown>;
    if (
      typeof input.sessionId !== "string" ||
      typeof input.confirmationId !== "string" ||
      typeof input.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.stack.confirmRestart(
      input.sessionId,
      input.confirmationId,
      input.approve,
    );
  }
}
