import { Body, Controller, Get, Header, HttpCode, Post } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { StackControlService } from "./stack-control.service.js";
import { NodeRedManagement } from "./node-red-management.service.js";

@Controller("settings/stack-control")
export class StackControlController {
  constructor(
    private readonly stack: StackControlService,
    private readonly nodeRed: NodeRedManagement,
  ) {}

  @Get("node-red/logs")
  @Header("Cache-Control", "no-store")
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

  @Post("restart")
  @HttpCode(200)
  restart(@Body() body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "service")
    )
      throw new ValidationError(["Ongeldige herstartaanvraag."]);
    return this.stack.restart((body as Record<string, unknown>).service);
  }
}
