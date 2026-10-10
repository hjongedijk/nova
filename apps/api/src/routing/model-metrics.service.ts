import { Injectable } from "@nestjs/common";
import type { ModelMetricsReport } from "@nova/contracts";
import { OmniRouteManagement } from "./omniroute-management.service.js";
import { RoutingService } from "./routing.service.js";

/** Keep only model identifiers and numeric measurements; never forward upstream objects. */
export function modelIdentifier(value: unknown): string | null {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9/:._@+-]{0,255}$/.test(value)
    ? value
    : null;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const measurement = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

@Injectable()
export class ModelMetricsService {
  private lastResponse: ModelMetricsReport["lastResponse"] = null;
  constructor(
    private readonly management: OmniRouteManagement,
    private readonly routing: RoutingService,
  ) {}

  /** Private, bounded, volatile metadata; never put this in public component state. */
  observe(model: unknown, provider: unknown, latencyMs: unknown): void {
    const id = modelIdentifier(model);
    if (id)
      this.lastResponse = {
        model: id,
        provider: modelIdentifier(provider),
        latencyMs: measurement(latencyMs),
        at: new Date().toISOString(),
      };
  }

  async report(): Promise<ModelMetricsReport> {
    const route = this.routing.status();
    const base: ModelMetricsReport = {
      updatedAt: new Date().toISOString(),
      available: false,
      windowHours: 24,
      routeReady: route.ready,
      models: [],
      lastResponse: this.lastResponse ? { ...this.lastResponse } : null,
    };
    // An edited gateway must never receive credentials tied to the old database.
    if (route.status === "GATEWAY_PROVENANCE_UNVERIFIED")
      return { ...base, error: "Het gateway-adres is nog niet geverifieerd." };
    if (!this.management.configured)
      return { ...base, error: "Stel eerst de OmniRoute-beheerkoppeling in." };
    try {
      const response = record(
        await this.management.request(
          "/api/usage/model-latency-stats?windowHours=24&minSamples=1&maxRows=10000",
        ),
      );
      if (!Array.isArray(response.entries))
        throw new Error("Invalid metrics shape");
      const models = response.entries.slice(0, 200).flatMap((value) => {
        const row = record(value);
        const provider = modelIdentifier(row.provider);
        const model = modelIdentifier(row.model);
        const total = measurement(row.totalRequests);
        const success = measurement(row.successfulRequests);
        if (
          !provider ||
          !model ||
          total === null ||
          success === null ||
          !Number.isSafeInteger(total) ||
          !Number.isSafeInteger(success) ||
          success > total
        )
          return [];
        return [
          {
            provider,
            model,
            requests: total,
            failures: total - success,
            averageMs: measurement(row.avgLatencyMs),
            firstTokenMs: measurement(row.avgTtftMs),
            tokensPerSecond: measurement(row.avgTokensPerSecond),
            enabled:
              route.enabledModels?.includes(`${provider}/${model}`) === true,
          },
        ];
      });
      return { ...base, available: true, models };
    } catch {
      return {
        ...base,
        error: "Modelmetingen zijn nu niet beschikbaar. Probeer later opnieuw.",
      };
    }
  }
}
