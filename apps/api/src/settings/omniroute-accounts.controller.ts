import type { OmniRouteAccountsReport } from "@nova/contracts";
import { Controller, Get, UseGuards } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { SettingsGuard } from "./settings.guard.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const identifier = (value: unknown, model = false): string =>
  typeof value === "string" &&
  (model ? /^[a-zA-Z0-9_.:/-]{1,200}$/ : /^[a-zA-Z0-9_.-]{1,100}$/).test(value)
    ? value
    : "";
const text = (value: unknown, limit: number): string =>
  typeof value === "string" ? sanitize(value).slice(0, limit) : "";
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const present = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

/** Private metadata only: a catalog label never establishes account billing safety. */
@Controller("settings/omniroute/accounts")
@UseGuards(SettingsGuard)
export class OmniRouteAccountsController {
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
  ) {}

  @Get()
  async report(): Promise<OmniRouteAccountsReport> {
    const empty: OmniRouteAccountsReport = {
      available: false,
      error:
        "OmniRoute-accounts zijn niet beschikbaar. Controleer de koppeling.",
      truncated: false,
      connections: [],
      models: [],
      combos: [],
      billingVerified: false,
    };
    try {
      if (
        this.config.omniUrl !== this.config.verifiedOmniUrl ||
        !this.management.configured
      )
        throw new Error("Gateway management unavailable");
      const [providers, catalog, comboReport] = await Promise.all([
        this.management.request("/api/providers?limit=200&offset=0"),
        this.management.request("/api/free-models"),
        this.management.request("/api/combos?limit=200&offset=0"),
      ]);
      const providerData = object(providers);
      const catalogData = object(catalog);
      const combosData = object(comboReport);
      if (
        !Array.isArray(providerData.connections) ||
        !Array.isArray(catalogData.models) ||
        !Array.isArray(combosData.combos)
      )
        throw new Error("Unexpected management response");
      return {
        available: true,
        truncated:
          providerData.connections.length > 200 ||
          (count(providerData.total) ?? 0) > 200 ||
          catalogData.models.length > 500 ||
          combosData.combos.length > 200 ||
          (count(combosData.total) ?? 0) > 200,
        connections: providerData.connections
          .slice(0, 200)
          .flatMap((raw: unknown) => {
            const row = object(raw);
            const id = identifier(row.id);
            const provider = identifier(row.provider);
            return id && provider
              ? [
                  {
                    id,
                    provider,
                    name: text(row.name, 200),
                    active:
                      typeof row.isActive === "boolean" ? row.isActive : null,
                    credentialPresent:
                      present(row.apiKey) || present(row.accessToken),
                  },
                ]
              : [];
          }),
        models: catalogData.models.slice(0, 500).flatMap((raw: unknown) => {
          const row = object(raw);
          const provider = identifier(row.provider);
          const modelId = identifier(row.modelId, true);
          return provider && modelId
            ? [
                {
                  provider,
                  modelId,
                  name: text(row.displayName, 200),
                  freeType: text(row.freeType, 60),
                  monthlyTokens: count(row.monthlyTokens),
                  creditTokens: count(row.creditTokens),
                },
              ]
            : [];
        }),
        combos: combosData.combos.slice(0, 200).flatMap((raw: unknown) => {
          const row = object(raw);
          const id = identifier(row.id);
          const name = text(row.name, 200);
          if (!id || !name) return [];
          const models = Array.isArray(row.models)
            ? row.models.slice(0, 100).flatMap((item: unknown) => {
                if (typeof item === "string") {
                  const modelId = identifier(item, true);
                  return modelId ? [modelId] : [];
                }
                const model = object(item);
                const provider = identifier(model.provider);
                const modelId = identifier(
                  model.modelId ?? model.model ?? model.name,
                  true,
                );
                return modelId
                  ? [provider ? `${provider}/${modelId}` : modelId]
                  : [];
              })
            : [];
          return [
            {
              id,
              name,
              displayName: text(row.displayName, 200),
              active: typeof row.isActive === "boolean" ? row.isActive : null,
              strategy: text(row.strategy, 60),
              models,
            },
          ];
        }),
        billingVerified: false,
      };
    } catch {
      return empty;
    }
  }
}
