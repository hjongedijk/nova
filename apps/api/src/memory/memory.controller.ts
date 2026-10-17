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
  AuditLogEntry,
  MemoryListResponse,
  MemorySearchResponse,
  SessionMemoryResponse,
} from "@nova/contracts";
import type { Response } from "express";
import { AuditService } from "../core/audit/audit.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { ToolsService } from "../tools/tools.service.js";
import type { ToolResult } from "../tools/tool.types.js";
import { isKind, type MemoryKind } from "./semantic/lifecycle.js";
import { SemanticMemoryService } from "./semantic-memory.service.js";
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
  ): { entries: AuditLogEntry[] } {
    return {
      entries: this.audit
        .read(
          Number(limit) || 100,
          sessionId ? normalizeSessionId(sessionId) : undefined,
        )
        .map((entry) => {
          const result =
            entry.result && typeof entry.result === "object"
              ? (entry.result as Record<string, unknown>)
              : null;
          return {
            id: entry.id,
            timestamp: entry.timestamp,
            tool: typeof entry.tool === "string" ? entry.tool : undefined,
            risk: typeof entry.risk === "string" ? entry.risk : undefined,
            confirmation:
              typeof entry.confirmation === "string"
                ? entry.confirmation
                : undefined,
            phase: typeof entry.phase === "string" ? entry.phase : undefined,
            result: result
              ? {
                  ok: result.ok === true,
                  accepted: result.accepted === true,
                  verified: result.verified === true,
                  ...(result.error || result.ok === false
                    ? { error: "Actie mislukt." }
                    : {}),
                }
              : undefined,
          };
        }),
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
    @Query("kind") kind?: string,
    @Query("q") q?: string,
    @Query("history") history?: string,
  ): Promise<MemoryListResponse | { error: string }> {
    if (kind !== undefined && !isKind(kind))
      throw new ValidationError(["Ongeldig geheugentype."]);
    try {
      if (kind || q || history === "true") {
        const page = await this.semantic.listMemories({
          limit: Number(limit) || 50,
          offset,
          kind: kind as MemoryKind | undefined,
          search: q?.slice(0, 200),
          includeHistory: history === "true",
        });
        return sanitize(page) as MemoryListResponse;
      }
      return sanitize(
        await this.semantic.list(Number(limit) || 50, offset),
      ) as MemoryListResponse;
    } catch {
      response.status(503);
      return { error: "Geheugen is tijdelijk niet beschikbaar." };
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
    if (
      typeof args.text === "string" &&
      !/^(onthoud|remember|bewaar als voorkeur|mijn voorkeur is|my preference is)\b/i.test(
        args.text.trim(),
      )
    )
      args.text = `Onthoud ${args.text}`;
    const result = await this.tools.execute(
      "memory_remember",
      args,
      normalizeSessionId(sessionId ?? "admin"),
    );
    response.status(result.ok || result.requiresConfirmation ? 200 : 400);
    return result;
  }

  /** POST /api/memories/:id/correct: replace the text, keeping the old one as history. */
  @Post("memories/:id/correct")
  @HttpCode(200)
  async correct(
    @Param("id") id: string,
    @Body() body: { text?: unknown; sessionId?: unknown } | undefined,
  ): Promise<ToolResult> {
    return this.tools.execute(
      "memory_correct",
      { id, text: body?.text },
      normalizeSessionId(body?.sessionId ?? "admin"),
    );
  }

  /**
   * DELETE /api/memories/:id: forget one memory (asks for confirmation first). `?history=true`
   * also removes the older versions it replaced.
   */
  @Delete("memories/:id")
  async forget(
    @Param("id") id: string,
    @Body() body: { sessionId?: unknown } | undefined,
    @Query("history") history?: string,
  ): Promise<ToolResult> {
    return this.tools.execute(
      "memory_forget",
      { id, ...(history === "true" ? { include_history: true } : {}) },
      normalizeSessionId(body?.sessionId ?? "admin"),
    );
  }
}
