import type {
  OmniRouteApiKeyInventory,
  OmniRouteAccountsReport,
  OmniRouteUsageReport,
  OmniRouteModelVisibilityReport,
} from "@nova/contracts";
import { Controller, Get } from "@nestjs/common";
import { DatabaseSync } from "node:sqlite";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { object } from "./request-input.js";

const identifier = (value: unknown, model = false): string =>
  typeof value === "string" &&
  (model
    ? /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) &&
      !/(^|\/)\.{1,2}(\/|$)/.test(value)
    : /^[a-zA-Z0-9_.-]{1,100}$/.test(value))
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
const timestamp = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const measure = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15
    ? value
    : null;

/** Private metadata only: a catalog label never establishes account billing safety. */
@Controller("settings/omniroute/accounts")
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

  /** On-demand, allowlisted key metadata; masked and revealed key values are ignored. */
  @Get("keys")
  async apiKeys(): Promise<OmniRouteApiKeyInventory> {
    const empty: OmniRouteApiKeyInventory = {
      available: false,
      error: "API-sleutels zijn niet beschikbaar. Controleer de koppeling.",
      truncated: false,
      keys: [],
    };
    try {
      if (
        this.config.omniUrl !== this.config.verifiedOmniUrl ||
        !this.management.configured
      )
        throw new Error("Gateway management unavailable");
      const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
      let novaKeyId: string | undefined;
      try {
        const row = db
          .prepare("SELECT id FROM api_keys WHERE key=? LIMIT 1")
          .get(this.config.omniKey) as { id?: string } | undefined;
        novaKeyId = row?.id;
      } finally {
        db.close();
      }
      if (!novaKeyId) throw new Error("NOVA API key owner unavailable");
      const raw = object(await this.management.request("/api/keys"));
      if (!Array.isArray(raw.keys)) throw new Error("Unexpected key inventory");
      const keys = raw.keys.slice(0, 200).flatMap((entry: unknown) => {
        const row = object(entry);
        const id = identifier(row.id);
        if (!id) return [];
        const countList = (value: unknown) =>
          Array.isArray(value) && value.length <= 1000 ? value.length : null;
        const mode = row.modelAccessMode;
        const accessMode: OmniRouteApiKeyInventory["keys"][number]["accessMode"] =
          mode === "restricted" || mode === "all" ? mode : "unknown";
        return [
          {
            id,
            name: text(row.name, 160),
            active: typeof row.isActive === "boolean" ? row.isActive : null,
            isNovaKey: id === novaKeyId,
            accessMode,
            allowedModelCount: countList(row.allowedModels),
            allowedComboCount: countList(row.allowedCombos),
            allowedConnectionCount: countList(row.allowedConnections),
            expiresAt: timestamp(row.expiresAt),
          },
        ];
      });
      return {
        available: true,
        truncated: raw.keys.length > 200 || (count(raw.total) ?? 0) > 200,
        keys: keys.slice(0, 200),
      };
    } catch {
      return empty;
    }
  }

  /** Native hidden-model state affects catalog visibility only, not request authorization. */
  @Get("model-visibility")
  async modelVisibility(): Promise<OmniRouteModelVisibilityReport> {
    const empty: OmniRouteModelVisibilityReport = {
      available: false,
      error: "Modelzichtbaarheid is niet beschikbaar. Controleer de koppeling.",
      truncated: false,
      hidden: [],
    };
    try {
      if (
        this.config.omniUrl !== this.config.verifiedOmniUrl ||
        !this.management.configured
      )
        throw new Error("Gateway management unavailable");
      const report = object(
        await this.management.request("/api/provider-models"),
      );
      const hiddenByProvider = object(report.hiddenModelsByProvider);
      const hidden: OmniRouteModelVisibilityReport["hidden"] = [];
      let truncated = false;
      for (const [rawProvider, models] of Object.entries(hiddenByProvider)) {
        const provider = identifier(rawProvider);
        if (!provider || !Array.isArray(models)) continue;
        if (models.length > 200) truncated = true;
        for (const rawModel of models.slice(0, 200)) {
          const modelId = identifier(rawModel, true);
          if (modelId) hidden.push({ provider, modelId });
          if (hidden.length >= 500) {
            truncated = true;
            break;
          }
        }
        if (hidden.length >= 500) break;
      }
      return { available: true, truncated, hidden };
    } catch {
      return empty;
    }
  }

  /** Cached quota metadata only; never triggers a provider refresh or returns logs. */
  @Get("usage")
  async usage(): Promise<OmniRouteUsageReport> {
    const empty: OmniRouteUsageReport = {
      available: false,
      error: "Providerlimieten zijn niet beschikbaar. Controleer de koppeling.",
      truncated: false,
      intervalMinutes: null,
      lastAutoSyncAt: null,
      billingVerified: false,
      connections: [],
    };
    try {
      if (
        this.config.omniUrl !== this.config.verifiedOmniUrl ||
        !this.management.configured
      )
        throw new Error("Gateway management unavailable");
      const [providerReport, limitReport] = await Promise.all([
        this.management.request("/api/providers?limit=200&offset=0"),
        this.management.request("/api/usage/provider-limits"),
      ]);
      const providers = object(providerReport);
      const limits = object(limitReport);
      const caches = object(limits.caches);
      if (
        !Array.isArray(providers.connections) ||
        !limits.caches ||
        typeof limits.caches !== "object" ||
        Array.isArray(limits.caches)
      )
        throw new Error("Unexpected management response");

      const byId = new Map<string, { provider: string; name: string }>();
      for (const raw of providers.connections.slice(0, 200)) {
        const row = object(raw);
        const id = identifier(row.id);
        const provider = identifier(row.provider);
        if (id && provider)
          byId.set(id, { provider, name: text(row.name, 200) });
      }
      const interval = count(limits.intervalMinutes);
      const intervalMinutes =
        interval !== null && interval > 0 && interval <= 10_080
          ? interval
          : null;
      const now = Date.now();
      let quotaTruncated = false;
      const connections = Object.entries(caches)
        .slice(0, 200)
        .flatMap(([id, raw]) => {
          const owner = byId.get(id);
          const cache = object(raw);
          const fetchedAt = timestamp(cache.fetchedAt);
          if (!owner || !fetchedAt) return [];
          const quotaObject = object(cache.quotas);
          const quotaEntries = Object.entries(quotaObject);
          if (quotaEntries.length > 25) quotaTruncated = true;
          const quotas = quotaEntries
            .slice(0, 25)
            .flatMap(([window, value]) => {
              const quota = object(value);
              const normalized = {
                window: text(window, 80),
                limit: measure(quota.limit),
                remaining: measure(quota.remaining),
                remainingPercentage: measure(quota.remainingPercentage),
                resetAt: timestamp(quota.resetAt),
                unlimited:
                  typeof quota.unlimited === "boolean" ? quota.unlimited : null,
              };
              return normalized.window &&
                Object.values(normalized).some(
                  (item) => item !== null && item !== normalized.window,
                )
                ? [normalized]
                : [];
            });
          const age = now - Date.parse(fetchedAt);
          const stale =
            intervalMinutes === null || age < -300_000
              ? null
              : age > intervalMinutes * 60_000;
          return [{ id, ...owner, fetchedAt, stale, quotas }];
        });
      return {
        available: true,
        truncated:
          providers.connections.length > 200 ||
          (count(providers.total) ?? 0) > 200 ||
          Object.keys(caches).length > 200 ||
          quotaTruncated,
        intervalMinutes,
        lastAutoSyncAt: timestamp(limits.lastAutoSyncAt),
        billingVerified: false,
        connections,
      };
    } catch {
      return empty;
    }
  }
}
