import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import type {
  NativeGatewayReport,
  NativeMemoryRecords,
  NativeSkillDocument,
} from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { NativeMemorySettingsService } from "./native-memory-settings.service.js";
import { NativeMemoryRecordsService } from "./native-memory-records.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { object } from "./request-input.js";

const text = (value: unknown, limit = 200): string =>
  typeof value === "string" ? String(sanitize(value)).slice(0, limit) : "";
const identifier = (value: unknown): string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value)
    ? value
    : "";
const error = "OmniRoute-beheer is niet beschikbaar. Controleer de koppeling.";

/** Fixed read-only management endpoints. Runtime handlers and other owners stay server-side. */
@Controller("settings/omniroute/native")
export class NativeGatewayController {
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly memory: NativeMemorySettingsService,
    private readonly memoryRecordsManager: NativeMemoryRecordsService,
  ) {}

  private assertGateway(): void {
    if (
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error("Gateway management unavailable");
  }

  @Get()
  async report(): Promise<NativeGatewayReport> {
    const empty: NativeGatewayReport = {
      available: false,
      error,
      truncated: false,
      skills: [],
      documentation: [],
      prompt: { enabled: null, prefixCharacters: null, suffixCharacters: null },
      memory: { enabled: null, backend: null, maxTokens: null },
    };
    try {
      this.assertGateway();
      const owner = this.management.scope;
      const [runtime, catalog, prompt, memory] = await Promise.all([
        this.management.request("/api/skills?page=1&limit=200"),
        this.management.skills(),
        this.management.request("/api/settings/system-prompt"),
        this.memory.status(),
      ]);
      const registry = object(runtime);
      const config = object(prompt);
      const docs = object(catalog);
      if (!Array.isArray(registry.data) || !Array.isArray(docs.skills))
        throw new Error("Unexpected management response");
      const skills: NativeGatewayReport["skills"] = [];
      for (const raw of registry.data.slice(0, 200)) {
        const row = object(raw);
        const scope =
          row.apiKeyId === owner
            ? "nova"
            : ["system", "skillsmp", "skillssh"].includes(String(row.apiKeyId))
              ? "global"
              : null;
        const id = identifier(row.id);
        if (!scope || !id) continue;
        skills.push({
          id,
          name: text(row.name),
          version: text(row.version, 40),
          scope,
          enabled: typeof row.enabled === "boolean" ? row.enabled : null,
          mode:
            row.mode === "on" || row.mode === "off" || row.mode === "auto"
              ? row.mode
              : null,
        });
      }
      return {
        available: true,
        truncated:
          typeof registry.totalPages === "number" && registry.totalPages > 1,
        skills,
        documentation: docs.skills.slice(0, 200).flatMap((raw: unknown) => {
          const row = object(raw);
          const id = identifier(row.id);
          return /^[a-z][a-z0-9-]{1,80}$/.test(id)
            ? [
                {
                  id,
                  name: text(row.name),
                  description: text(row.description, 500),
                },
              ]
            : [];
        }),
        prompt: {
          enabled: typeof config.enabled === "boolean" ? config.enabled : null,
          prefixCharacters:
            typeof config.prefixPrompt === "string"
              ? config.prefixPrompt.length
              : null,
          suffixCharacters:
            typeof config.suffixPrompt === "string"
              ? config.suffixPrompt.length
              : null,
        },
        memory,
      };
    } catch {
      return empty;
    }
  }

  @Get("memory")
  memoryStatus() {
    return this.memory.status();
  }

  @Get("memories")
  async memoryRecords(
    @Query("offset") rawOffset?: string,
  ): Promise<NativeMemoryRecords> {
    try {
      this.assertGateway();
      const offset = rawOffset === undefined ? 0 : Number(rawOffset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)
        throw new ValidationError(["Ongeldige geheugenpagina."]);
      const owner = this.management.scope;
      const query = new URLSearchParams({
        apiKeyId: owner,
        limit: "50",
        offset: String(offset),
      });
      const response = object(
        await this.management.request(`/api/memory?${query}`),
      );
      if (!Array.isArray(response.data)) throw new Error("invalid memories");
      const rows = response.data.slice(0, 50).flatMap((raw: unknown) => {
        const row = object(raw);
        const metadata = object(row.metadata);
        const id = identifier(row.id);
        if (
          !id ||
          row.apiKeyId !== owner ||
          (metadata.application !== "nova" &&
            metadata.application !== "jarvis") ||
          typeof row.content !== "string"
        )
          return [];
        return [
          {
            id,
            text: text(row.content, 4000),
            ...(typeof row.createdAt === "string"
              ? { created_at: text(row.createdAt, 40) }
              : {}),
            ...(typeof row.updatedAt === "string"
              ? { updated_at: text(row.updatedAt, 40) }
              : {}),
          },
        ];
      });
      return {
        memories: rows,
        next: response.data.length === 50 ? offset + 50 : null,
      };
    } catch {
      return {
        memories: [],
        next: null,
        error: "NOVA-geheugenrecords konden niet veilig worden geladen.",
      };
    }
  }

  @Post("memories/delete")
  @HttpCode(200)
  deleteMemoryRecord(@Body() body: unknown) {
    this.assertGateway();
    return this.memoryRecordsManager.delete(body);
  }

  @Post("memories/delete-many")
  @HttpCode(200)
  deleteMemoryRecords(@Body() body: unknown) {
    this.assertGateway();
    return this.memoryRecordsManager.deleteMany(body);
  }

  @Post("memories/update")
  @HttpCode(200)
  updateMemoryRecord(@Body() body: unknown) {
    this.assertGateway();
    return this.memoryRecordsManager.update(body);
  }

  @Get("memory/history")
  memoryHistory() {
    return this.memory.history();
  }

  @Post("memory")
  @HttpCode(200)
  setMemory(@Body() body: unknown) {
    return this.memory.apply(body);
  }

  @Post("memory/rollback")
  @HttpCode(200)
  rollbackMemory(@Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige geschiedenisactie."]);
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => key !== "revisionId") ||
      typeof input.revisionId !== "string"
    )
      throw new ValidationError(["Ongeldige geschiedenisactie."]);
    return this.memory.rollback(input.revisionId);
  }

  @Get("documentation/:id")
  async document(@Param("id") id: string): Promise<NativeSkillDocument> {
    try {
      if (!/^[a-z][a-z0-9-]{1,80}$/.test(id)) throw new Error("Invalid ID");
      this.assertGateway();
      const data = object(await this.management.skills(id));
      if (typeof data.documentation !== "string")
        throw new Error("Missing document");
      return {
        available: true,
        id,
        name: text(data.name),
        documentation: text(data.documentation, 16000),
      };
    } catch {
      return { available: false, error };
    }
  }
}
