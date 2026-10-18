import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Optional,
  Post,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { McpHub } from "../integrations/mcp/mcp.hub.js";
import { McpManagement } from "./mcp-management.service.js";
import { RISKS } from "../integrations/mcp/mcp-config.js";
import { McpSecretsStore } from "../integrations/mcp/mcp-secrets.store.js";
import { StackControlService } from "./stack-control.service.js";
import type { Risk } from "@nova/contracts";

/** PIN-protected status only; never projects MCP commands, arguments, variables or process errors. */
@Controller("settings/mcp")
export class McpStatusController {
  constructor(
    private readonly hub: McpHub,
    private readonly management: McpManagement,
    private readonly secrets: McpSecretsStore,
    @Optional() private readonly stack?: StackControlService,
  ) {}

  @Get("servers/:id/config")
  getConfig(@Param("id") id: string) {
    return this.secrets.status(id);
  }

  @Post("servers/:id/config")
  @HttpCode(200)
  async saveConfig(@Param("id") id: string, @Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige MCP-instellingen."]);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => !["values", "clear"].includes(key)) ||
      (value.clear !== undefined && typeof value.clear !== "boolean")
    )
      throw new ValidationError(["Ongeldige MCP-instellingen."]);
    const status = this.secrets.save(
      id,
      value.values ?? {},
      value.clear === true,
    );
    await this.hub.refresh(id);
    return status;
  }

  @Get("servers")
  async getServers() {
    const report = this.hub.status();
    const stack = await this.stack?.status();
    if (!stack?.mcpWorkers) return report;
    return {
      ...report,
      workers: stack.mcpWorkers.map((worker) => ({
        ...worker,
        connected:
          worker.server === "workspace-git"
            ? null
            : report.servers.some(
                (server) => server.id === worker.server && server.connected,
              ),
      })),
    };
  }

  @Get("servers/catalog")
  getCatalog() {
    return this.management.catalog();
  }

  @Post("servers/:id/catalog")
  @HttpCode(200)
  changeCatalog(@Param("id") id: string, @Body() body: unknown) {
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
    return this.management.changeCatalog(
      id,
      (body as { operation: "add" | "remove" }).operation,
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

  @Post("servers/:id/history/:revisionId/rollback")
  @HttpCode(200)
  rollback(@Param("id") id: string, @Param("revisionId") revisionId: string) {
    return this.management.rollback(id, revisionId);
  }

  @Post("servers/:id/test")
  @HttpCode(200)
  testConnection(@Param("id") id: string) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(id))
      throw new ValidationError(["Ongeldige MCP-server-ID."]);
    return this.hub.test(id);
  }

  @Post("servers/:id/toggle")
  @HttpCode(200)
  toggle(@Param("id") id: string, @Body() body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as Record<string, unknown>).enabled !== "boolean"
    )
      throw new ValidationError(["Ongeldige MCP-wijziging."]);
    return this.management.setEnabled(
      id,
      (body as { enabled: boolean }).enabled,
    );
  }

  @Post("servers/:id/tools/:tool/risk")
  @HttpCode(200)
  setToolRisk(
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
    return this.management.setToolRisk(id, tool, (body as { risk: Risk }).risk);
  }
}
