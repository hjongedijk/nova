import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { NovaConfig } from "../core/config/nova-config.js";
import type { ModelRoleId } from "@nova/contracts";
import {
  connectionFingerprint,
  type CredentialConnection,
} from "./connection-binding.js";
import { classifyFreeAccess, type FreeCandidate } from "./free-access.js";

interface Policy {
  providers?: unknown[];
  nativeFreeAccessPolicy?: string;
  enabledModels: string[];
  verifiedProviders: string[];
  verifiedConnectionIds?: string[];
  verifiedConnections?: { id: string; provider: string; fingerprint: string }[];
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
  private managementBlocked = false;

  /** Retain a stop if durable marker removal or restoration fails. */
  setManagementBlocked(blocked: boolean): void {
    this.managementBlocked = blocked;
  }

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
    if (this.managementBlocked)
      return {
        freeOnly: true,
        ready: false,
        policyVerified: false,
        status: "POLICY_CHANGE_PENDING",
        reason:
          "Routing management changes require fresh verification. Inference is blocked.",
      };
    try {
      fs.lstatSync(this.config.dataFile("free-routing-management-block.json"));
      return {
        freeOnly: true,
        ready: false,
        policyVerified: false,
        status: "POLICY_CHANGE_PENDING",
        reason:
          "Routing management changes require fresh verification. Inference is blocked.",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return {
          freeOnly: true,
          ready: false,
          policyVerified: false,
          status: "POLICY_UNAVAILABLE",
          reason:
            "Free-only configuration cannot be verified. Inference is blocked.",
        };
    }
    if (this.config.omniUrl !== this.config.verifiedOmniUrl)
      return {
        freeOnly: true,
        ready: false,
        policyVerified: false,
        status: "GATEWAY_PROVENANCE_UNVERIFIED",
        reason:
          "The configured endpoint is not bound to the locally verified OmniRoute database.",
      };

    if (!this.config.freeOnly && process.env.NODE_ENV === "test")
      return {
        freeOnly: false,
        ready: true,
        status: "TEST_OR_EXPLICIT_UNRESTRICTED_MODE",
      };
    return this.inspectPolicy();
  }

  /** Management proof only: this never authorizes inference through a pending change. */
  verifyForManagement(): RoutingStatus {
    return this.inspectPolicy();
  }

  private inspectPolicy(): RoutingStatus {
    if (this.config.omniUrl !== this.config.verifiedOmniUrl)
      return {
        freeOnly: true,
        ready: false,
        policyVerified: false,
        status: "GATEWAY_PROVENANCE_UNVERIFIED",
        reason:
          "The configured endpoint is not bound to the locally verified OmniRoute database.",
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
        const connectionById = db.prepare(
          "SELECT id,provider,is_active FROM provider_connections WHERE id=?",
        );
        const bound = policy.verifiedConnections !== undefined;
        const bindings = policy.verifiedConnections;
        const validBindings =
          !bound ||
          (Array.isArray(bindings) &&
            bindings.length > 0 &&
            bindings.every(
              (item) =>
                item !== null &&
                typeof item === "object" &&
                typeof item.id === "string" &&
                item.id.length > 0 &&
                typeof item.provider === "string" &&
                typeof item.fingerprint === "string" &&
                /^[0-9a-f]{64}$/.test(item.fingerprint),
            ) &&
            new Set(bindings.map((item) => item.id)).size === bindings.length &&
            Array.isArray(connections) &&
            new Set(connections).size === connections.length &&
            bindings.length === connections.length &&
            bindings.every((item) => connections.includes(item.id)));
        const credentialsById =
          bound && validBindings
            ? db.prepare(
                "SELECT id,provider,auth_type,api_key FROM provider_connections WHERE id=?",
              )
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
          validBindings &&
          (connections?.length ?? 0) > 0 &&
          connections!.every((id) => {
            if (
              typeof id !== "string" ||
              id.length === 0 ||
              !(
                policy.verifiedConnectionIds || policy.verifiedProviders
              ).includes(id)
            )
              return false;
            const connection = connectionById.get(id) as
              { id: string; provider: string; is_active: number } | undefined;
            if (
              connection?.is_active !== 1 ||
              !policy.verifiedProviders.includes(connection.provider)
            )
              return false;
            if (!bound) return true;
            const binding = bindings!.find((item) => item.id === id);
            const credentials = credentialsById!.get(id) as
              CredentialConnection | undefined;
            return (
              binding?.provider === connection.provider &&
              credentials?.provider === connection.provider &&
              binding.fingerprint === connectionFingerprint(credentials)
            );
          }) &&
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

  /** Explicit-model callers must still select from today's verified-free model set. */
  assertFreeModel(modelId: string): string {
    const status = this.assertFree();
    if (!status.enabledModels?.includes(modelId))
      throw new FreeRoutingBlockedError(
        "Selected model is outside the verified free route",
      );
    return modelId;
  }

  /** A role-selected model must remain both globally verified-free and explicitly approved for that role. */
  assertRoleModel(role: ModelRoleId, modelId: string): string {
    this.assertFreeModel(modelId);
    try {
      const settings = JSON.parse(
        fs.readFileSync(this.config.dataFile("settings.json"), "utf8"),
      ) as {
        modelRoles?: Record<
          string,
          { preferred?: unknown; fallback?: unknown }
        >;
      };
      const preference = settings.modelRoles?.[role];
      if (
        !preference ||
        ((!Array.isArray(preference.preferred) ||
          !preference.preferred.includes(modelId)) &&
          preference.fallback !== modelId)
      )
        throw new Error("Model is not configured for this role");
      return modelId;
    } catch {
      throw new FreeRoutingBlockedError(
        "No verified free model is configured for this role",
      );
    }
  }

  preferredModelForRole(role: ModelRoleId): string | undefined {
    return this.roleModels(role)[0];
  }

  /** Ordered, currently verified free choices; callers still revalidate each before sending. */
  roleModels(role: ModelRoleId): string[] {
    const status = this.assertFree();
    try {
      const settings = JSON.parse(
        fs.readFileSync(this.config.dataFile("settings.json"), "utf8"),
      ) as {
        modelRoles?: Record<
          string,
          { preferred?: unknown; fallback?: unknown }
        >;
      };
      const preference = settings.modelRoles?.[role];
      if (!preference) return [];
      const requested = [
        ...(Array.isArray(preference.preferred) ? preference.preferred : []),
        ...(typeof preference.fallback === "string"
          ? [preference.fallback]
          : []),
      ];
      if (!requested.length) return [];
      const models = [...new Set(requested)].filter(
        (item): item is string =>
          typeof item === "string" &&
          status.enabledModels?.includes(item) === true,
      );
      if (requested.length && !models.length)
        throw new FreeRoutingBlockedError(
          "No configured model for this role remains in the verified free route",
        );
      return models.filter((model) => {
        try {
          this.assertRoleModel(role, model);
          return true;
        } catch {
          return false;
        }
      });
    } catch (error) {
      if (error instanceof FreeRoutingBlockedError) throw error;
      return [];
    }
  }
}
