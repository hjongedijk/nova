import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import type { NativeGatewayReport, NativeSkillDocument } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { SettingsGuard } from "./settings.guard.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, limit = 200): string =>
  typeof value === "string" ? String(sanitize(value)).slice(0, limit) : "";
const identifier = (value: unknown): string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value)
    ? value
    : "";
const error = "OmniRoute-beheer is niet beschikbaar. Controleer de koppeling.";

/** Fixed read-only management endpoints. Runtime handlers and other owners stay server-side. */
@Controller("settings/omniroute/native")
@UseGuards(SettingsGuard)
export class NativeGatewayController {
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
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
    };
    try {
      this.assertGateway();
      const owner = this.management.scope;
      const [runtime, catalog, prompt] = await Promise.all([
        this.management.request("/api/skills?page=1&limit=200"),
        this.management.skills(),
        this.management.request("/api/settings/system-prompt"),
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
      };
    } catch {
      return empty;
    }
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
