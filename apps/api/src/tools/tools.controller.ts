import { Body, ConflictException, Controller, Get, Post } from "@nestjs/common";
import type { ToolInfo } from "@nova/contracts";
import { ValidationError } from "../core/errors/validation.error.js";
import { normalizeSessionId } from "../memory/session-memory.service.js";
import { ToolsService } from "./tools.service.js";
import type { ToolResult } from "./tool.types.js";

const running = new Set<string>();

@Controller()
export class ToolsController {
  constructor(private readonly tools: ToolsService) {}

  /** GET /api/tools: every tool, also the ones that are off. */
  @Get("tools")
  list(): { tools: ToolInfo[] } {
    return { tools: this.tools.list() };
  }

  /** POST /api/actions/execute: run one tool directly (dashboard buttons). One at a time per session. */
  @Post("actions/execute")
  async execute(
    @Body() body: { sessionId?: unknown; tool?: unknown; args?: unknown },
  ): Promise<ToolResult> {
    const sessionId = normalizeSessionId(body?.sessionId);
    if (
      typeof body?.tool !== "string" ||
      !body.args ||
      typeof body.args !== "object"
    )
      throw new ValidationError(["Een tool en argumenten zijn verplicht."]);
    if (running.has(sessionId))
      throw new ConflictException("Er loopt al een verzoek voor deze sessie.");
    running.add(sessionId);
    try {
      return await this.tools.execute(body.tool, body.args, sessionId);
    } finally {
      running.delete(sessionId);
    }
  }
}
