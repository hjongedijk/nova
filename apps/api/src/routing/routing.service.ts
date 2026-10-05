import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { NovaConfig } from "../core/config/nova-config.js";
import { classifyFreeAccess, type FreeCandidate } from "./free-access.js";

interface Policy {
  providers?: unknown[];
  nativeFreeAccessPolicy?: string;
  enabledModels: string[];
  verifiedProviders: string[];
  verifiedConnectionIds?: string[];
  blockedProviders: string[];
  nativeModelAllowlist?: string[];
  catalog?: (FreeCandidate & { provider: string; modelId: string })[];
  route?: string;
  status?: string;
  reason?: string;
}

export interface RoutingStatus {
  freeOnly: boolean;
  ready: boolean;
  policyVerified?: boolean;
  status: string;
  route?: string;
  enabledModels?: string[];
  verifiedProviders?: string[];
  reason?: string;
  quotaSource?: string;
  fallback?: string;
}

export class FreeRoutingBlockedError extends Error {}

/**
 * NOVA only talks to models that cost nothing. The policy (data/free-routing-policy.json) says which
 * ones; this checks it against what OmniRoute is really configured to do (read-only), and blocks all
 * inference when the two drift apart.
 */
@Injectable()
export class RoutingService {
  constructor(private readonly config: NovaConfig) {}

  private policy(): Policy {
    return JSON.parse(
      fs.readFileSync(this.config.dataFile("free-routing-policy.json"), "utf8"),
    ) as Policy;
  }

  providerInventory(): unknown[] {
    try {
      return this.policy().providers ?? [];
    } catch {
      return [];
    }
  }

  status(): RoutingStatus {
    if (!this.config.freeOnly && process.env.NODE_ENV === "test")
      return {
        freeOnly: false,
        ready: true,
        status: "TEST_OR_EXPLICIT_UNRESTRICTED_MODE",
      };
    try {
      const policy = this.policy();
      const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
      try {
        const settings = Object.fromEntries(
          (
            db
              .prepare(
                "SELECT key,value FROM key_value WHERE namespace='settings'",
              )
              .all() as { key: string; value: string }[]
          ).map((row) => [row.key, JSON.parse(row.value) as unknown]),
        ) as Record<string, unknown> & {
          modelVisibilityAllowlist?: string[];
          blockedProviders?: string[];
        };
        const key = db
          .prepare(
            "SELECT model_access_mode,allowed_models,allowed_connections,allow_auto_combos FROM api_keys WHERE key=? AND is_active=1 AND revoked_at IS NULL",
          )
          .get(this.config.omniKey) as
          | {
              model_access_mode: string;
              allowed_models: string | null;
              allowed_connections: string | null;
            }
          | undefined;
        const allowed = key
          ? (JSON.parse(key.allowed_models || "[]") as string[])
          : undefined;
        const connections = key
          ? (JSON.parse(key.allowed_connections || "[]") as string[])
          : undefined;
        const candidateOf = (id: string) =>
          policy.catalog?.find(
            (item) => `${item.provider}/${item.modelId}` === id,
          );
        const strict =
          settings.freeAccessPolicy ===
            (policy.nativeFreeAccessPolicy || "strict") &&
          (settings.freeAccessPolicy === "strict" ||
            (policy.enabledModels.length > 0 &&
              policy.enabledModels.every((id) => {
                const candidate = candidateOf(id);
                return (
                  candidate?.accountFreeVerified === true &&
                  policy.verifiedProviders.includes(candidate.provider)
                );
              }))) &&
          settings.hidePaidModels === true &&
          settings.excludeTosAvoid === true &&
          (policy.nativeModelAllowlist === undefined ||
            (Array.isArray(settings.modelVisibilityAllowlist) &&
              settings.modelVisibilityAllowlist.length ===
                policy.nativeModelAllowlist.length &&
              settings.modelVisibilityAllowlist.every((id) =>
                policy.nativeModelAllowlist!.includes(id),
              ) &&
              policy.enabledModels.every((id) =>
                policy.nativeModelAllowlist!.includes(id),
              ))) &&
          this.config.omniModel === policy.route &&
          this.config.omniModel === "auto" &&
          key?.model_access_mode === "restricted" &&
          allowed?.length === 1 &&
          allowed[0] === "auto" &&
          (connections?.length ?? 0) > 0 &&
          connections!.every((id) =>
            (policy.verifiedConnectionIds || policy.verifiedProviders).includes(
              id,
            ),
          ) &&
          policy.blockedProviders.every((id) =>
            settings.blockedProviders?.includes(id),
          );
        return {
          freeOnly: true,
          ready:
            strict &&
            policy.enabledModels.length > 0 &&
            policy.enabledModels.every((id) => {
              const candidate = candidateOf(id);
              return (
                candidate?.nativeAutoEligible === true &&
                classifyFreeAccess(candidate).allowed
              );
            }),
          policyVerified: strict,
          route: this.config.omniModel,
          status: strict ? (policy.status ?? "OK") : "POLICY_DRIFT_BLOCKED",
          enabledModels: policy.enabledModels,
          verifiedProviders: policy.verifiedProviders,
          reason: strict
            ? policy.reason
            : "Native policy, route or key restrictions changed. Inference is blocked.",
          quotaSource: "OmniRoute native per-connection quota",
          fallback: "Native only; no paid or local fallback",
        };
      } finally {
        db.close();
      }
    } catch {
      return {
        freeOnly: true,
        ready: false,
        policyVerified: false,
        status: "POLICY_UNAVAILABLE",
        reason:
          "Free-only configuration cannot be verified. Inference is blocked.",
      };
    }
  }

  /** Throws when no verified free route exists: nothing may be sent to a model then. */
  assertFree(): RoutingStatus {
    const status = this.status();
    if (!status.ready)
      throw new FreeRoutingBlockedError(
        status.policyVerified
          ? "Geen geverifieerde gratis AI-route beschikbaar. No verified free AI route is available."
          : "Free-only routing verification failed; inference blocked",
      );
    return status;
  }
}
