import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type {
  MemoryListResponse,
  MemorySearchResponse,
  SessionMemoryResponse,
} from "@nova/contracts";
import type { Response } from "express";
import { AuditService, type AuditEntry } from "../core/audit/audit.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { ToolsService } from "../tools/tools.service.js";
import type { ToolResult } from "../tools/tool.types.js";
import { SemanticMemoryService } from "./semantic-memory.service.js";
import { messageOf } from "./semantic/backend.js";
import {
  normalizeSessionId,
  SessionMemoryService,
} from "./session-memory.service.js";

@Controller()
export class MemoryController {
  constructor(
    private readonly semantic: SemanticMemoryService,
    private readonly session: SessionMemoryService,
    private readonly tools: ToolsService,
    private readonly audit: AuditService,
  ) {}

  /** GET /api/audit: newest actions first. */
  @Get("audit")
  auditLog(
    @Query("limit") limit?: string,
    @Query("sessionId") sessionId?: string,
  ): { entries: AuditEntry[] } {
    return {
      entries: this.audit.read(
        Number(limit) || 100,
        sessionId ? normalizeSessionId(sessionId) : undefined,
      ),
    };
  }

  /** GET /api/memory/:sessionId: the stored conversation of one session. */
  @Get("memory/:sessionId")
  conversation(@Param("sessionId") raw: string): SessionMemoryResponse {
    const sessionId = normalizeSessionId(raw);
    const { messages } = this.session.session(sessionId);
    return { sessionId, count: messages.length, messages };
  }

  /** DELETE /api/memory/:sessionId: forget one conversation. */
  @Delete("memory/:sessionId")
  forgetConversation(@Param("sessionId") raw: string): {
    ok: true;
    sessionId: string;
  } {
    const sessionId = normalizeSessionId(raw);
    this.session.clear(sessionId);
    return { ok: true, sessionId };
  }

  /** GET /api/memories: the long-term memories (503 when the store is down). */
  @Get("memories")
  async list(
    @Res({ passthrough: true }) response: Response,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<MemoryListResponse | { error: string }> {
    try {
      return sanitize(
        await this.semantic.list(Number(limit) || 50, offset),
      ) as MemoryListResponse;
    } catch (error) {
      response.status(503);
      return { error: sanitize(messageOf(error)) };
    }
  }

  /** POST /api/memories/search */
  @Post("memories/search")
  @HttpCode(200)
  async search(
    @Body() body: { query?: unknown },
  ): Promise<MemorySearchResponse> {
    if (typeof body?.query !== "string" || body.query.length > 2000)
      throw new ValidationError(["Ongeldige geheugenvraag."]);
    return {
      memories: sanitize(await this.semantic.search(body.query)),
      configured: this.semantic.configured,
    };
  }

  /** POST /api/memories: remember something, through the normal tool pipeline (audit, rules). */
  @Post("memories")
  @HttpCode(200)
  async remember(
    @Res({ passthrough: true }) response: Response,
    @Body() body: Record<string, unknown> | undefined,
  ): Promise<ToolResult> {
    const { sessionId, ...args } = body ?? {};
    const result = await this.tools.execute(
      "memory_remember",
      args,
      normalizeSessionId(sessionId ?? "admin"),
    );
    response.status(result.ok || result.requiresConfirmation ? 200 : 400);
    return result;
  }

  /** DELETE /api/memories/:id: forget one memory (asks for confirmation first). */
  @Delete("memories/:id")
  async forget(
    @Param("id") id: string,
    @Body() body: { sessionId?: unknown } | undefined,
  ): Promise<ToolResult> {
    return this.tools.execute(
      "memory_forget",
      { id },
      normalizeSessionId(body?.sessionId ?? "admin"),
    );
  }
}
