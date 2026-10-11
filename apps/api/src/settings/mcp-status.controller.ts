import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { McpHub } from "../integrations/mcp/mcp.hub.js";
import { SettingsGuard } from "./settings.guard.js";
import { McpManagement } from "./mcp-management.service.js";
import { RISKS } from "../integrations/mcp/mcp-config.js";
import type { Risk } from "@nova/contracts";

/** PIN-protected status only; never projects MCP commands, arguments, variables or process errors. */
@Controller("settings/mcp")
@UseGuards(SettingsGuard)
export class McpStatusController {
  constructor(
    private readonly hub: McpHub,
    private readonly management: McpManagement,
  ) {}

  @Get("servers")
  getServers() {
    return this.hub.status();
  }

  @Get("servers/catalog")
  getCatalog() {
    return this.management.catalog();
  }

  @Post("servers/:id/prepare-catalog")
  @HttpCode(200)
  prepareCatalog(@Param("id") id: string, @Body() body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !["add", "remove"].includes(
        String((body as Record<string, unknown>).operation),
      )
    )
      throw new ValidationError(["Ongeldige MCP-cataloguswijziging."]);
    return this.management.prepareCatalog(
      id,
      (body as { operation: "add" | "remove" }).operation,
    );
  }

  @Post("servers/confirm-catalog")
  @HttpCode(200)
  confirmCatalog(@Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige bevestiging."]);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !["sessionId", "confirmationId", "approve"].includes(key),
      ) ||
      typeof value.sessionId !== "string" ||
      !/^settings-mcp-catalog:[0-9a-f-]{36}$/i.test(value.sessionId) ||
      typeof value.confirmationId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.confirmationId) ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.management.confirmCatalog(
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }

  @Get("servers/:id/activity")
  getActivity(@Param("id") id: string) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(id))
      throw new ValidationError(["Ongeldige MCP-server-ID."]);
    return this.hub.activity(id);
  }

  @Get("servers/:id/history")
  getHistory(@Param("id") id: string) {
    return this.management.history(id);
  }

  @Post("servers/:id/history/:revisionId/prepare-rollback")
  @HttpCode(200)
  prepareRollback(
    @Param("id") id: string,
    @Param("revisionId") revisionId: string,
  ) {
    return this.management.prepareRollback(id, revisionId);
  }

  @Post("servers/:id/test")
  @HttpCode(200)
  testConnection(@Param("id") id: string) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(id))
      throw new ValidationError(["Ongeldige MCP-server-ID."]);
    return this.hub.test(id);
  }

  @Post("servers/:id/prepare-toggle")
  @HttpCode(200)
  prepareToggle(@Param("id") id: string, @Body() body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as Record<string, unknown>).enabled !== "boolean"
    )
      throw new ValidationError(["Ongeldige MCP-wijziging."]);
    return this.management.prepare(id, (body as { enabled: boolean }).enabled);
  }

  @Post("servers/:id/tools/:tool/prepare-risk")
  @HttpCode(200)
  prepareToolRisk(
    @Param("id") id: string,
    @Param("tool") tool: string,
    @Body() body: unknown,
  ) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as Record<string, unknown>).risk !== "string" ||
      !RISKS.includes((body as { risk: Risk }).risk)
    )
      throw new ValidationError(["Ongeldig MCP-risiconiveau."]);
    return this.management.prepareToolRisk(
      id,
      tool,
      (body as { risk: Risk }).risk,
    );
  }

  @Post("servers/confirm-toggle")
  @HttpCode(200)
  confirmToggle(@Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige bevestiging."]);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !["sessionId", "confirmationId", "approve"].includes(key),
      ) ||
      typeof value.sessionId !== "string" ||
      !/^settings-mcp:[0-9a-f-]{36}$/i.test(value.sessionId) ||
      typeof value.confirmationId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.confirmationId) ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.management.confirm(
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }

  @Post("servers/confirm-tool-risk")
  @HttpCode(200)
  confirmToolRisk(@Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige bevestiging."]);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !["sessionId", "confirmationId", "approve"].includes(key),
      ) ||
      typeof value.sessionId !== "string" ||
      !/^settings-mcp:[0-9a-f-]{36}$/i.test(value.sessionId) ||
      typeof value.confirmationId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.confirmationId) ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.management.confirmToolRisk(
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}
