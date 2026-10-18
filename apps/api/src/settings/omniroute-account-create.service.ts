import { Injectable } from "@nestjs/common";
import { DatabaseSync } from "node:sqlite";
import type { OmniRouteAccountCreateResult } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { object, sameSecret } from "./request-input.js";

type StoredAccount = {
  id: string;
  provider: string;
  name: string | null;
  is_active: number;
  api_key: string | null;
};
const validProvider = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(value);
const validName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= 200;
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
const unavailable =
  "Provideraccount toevoegen is niet beschikbaar. Controleer de OmniRoute-koppeling.";
/**
 * OmniRoute may keep provider credentials encrypted at rest (a longer envelope), which NOVA cannot and need not decrypt: the
 * credential then counts as persisted when something non-empty that is not shorter than the key itself is stored. A plain-text
 * store must still match exactly. A missing or truncated credential is never accepted.
 */
function storedCredentialMatches(stored: string, key: string): boolean {
  if (!stored) return false;
  return stored.length > key.length || sameSecret(stored, key);
}

/** Creates a provider account in one step; the credential is passed straight to OmniRoute and never stored, echoed or audited. */
@Injectable()
export class OmniRouteAccountCreate {
  private readonly inFlight = new Set<string>();
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly audit: AuditService,
    private readonly barrier: RoutingManagementBarrier,
    private readonly routing: RoutingService,
  ) {}

  private assertGateway(): void {
    if (
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(unavailable);
  }

  private async assertUnique(provider: string, name: string): Promise<void> {
    const report = object(
      await this.management.request(
        `/api/providers?provider=${encodeURIComponent(provider)}&limit=200&offset=0`,
      ),
    );
    if (
      !Array.isArray(report.connections) ||
      (typeof report.total === "number" &&
        report.total > report.connections.length)
    )
      throw new Error(unavailable);
    if (
      report.connections.some((entry: unknown) => {
        const account = object(entry);
        return (
          typeof account.name === "string" &&
          account.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()
        );
      })
    )
      throw new Error(
        "Er bestaat al een account met deze naam voor deze provider.",
      );
  }

  private stored(id: string): StoredAccount | undefined {
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT id,provider,name,is_active,api_key FROM provider_connections WHERE id=?",
        )
        .get(id) as StoredAccount | undefined;
    } finally {
      db.close();
    }
  }

  async create(
    rawProvider: unknown,
    rawName: unknown,
    rawKey: unknown,
  ): Promise<OmniRouteAccountCreateResult> {
    const provider = typeof rawProvider === "string" ? rawProvider.trim() : "";
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (
      !validProvider(provider) ||
      !validName(name) ||
      !key ||
      key.length > 64_000
    )
      throw new ValidationError([
        "Vul de provider-ID, accountnaam en API-sleutel in.",
      ]);
    const secret = { provider, name, key };
    const tool = "omniroute_account_create";
    const busyKey = `${secret.provider}/${secret.name.toLocaleLowerCase()}`;
    if (this.inFlight.has(busyKey))
      return { ok: false, error: "Dit provideraccount wordt al toegevoegd." };
    this.inFlight.add(busyKey);
    try {
      return await this.barrier.run(async (operation) => {
        try {
          this.assertGateway();
          await this.assertUnique(secret.provider, secret.name);
          this.audit.record({
            sessionId: "settings",
            tool,
            risk: "DANGEROUS",
            confirmation: "direct",
            phase: "before_execute",
            arguments: {
              provider: secret.provider,
              name: String(sanitize(secret.name)).slice(0, 200),
              credentialPresent: true,
              providerMayTestCredential: true,
            },
          });
          operation.block("account_change");
        } catch (error) {
          return {
            ok: false,
            error:
              error instanceof Error &&
              error.message ===
                "Er bestaat al een account met deze naam voor deze provider."
                ? error.message
                : unavailable,
          };
        }
        try {
          const created = object(
            await this.management.request("/api/providers", {
              method: "POST",
              body: {
                provider: secret.provider,
                name: secret.name,
                apiKey: secret.key,
              },
            }),
          );
          const connection = object(created.connection);
          const id = connection.id;
          if (!validId(id)) throw new Error("Provider account ID missing");
          const api = object(
            await this.management.request(`/api/providers/${id}`),
          );
          const current = object(api.connection);
          const row = this.stored(id);
          if (
            current.id !== id ||
            current.provider !== secret.provider ||
            current.name !== secret.name ||
            !row ||
            row.id !== id ||
            row.provider !== secret.provider ||
            row.name !== secret.name ||
            (row.is_active !== 0 && row.is_active !== 1) ||
            typeof row.api_key !== "string" ||
            !storedCredentialMatches(row.api_key, secret.key)
          )
            throw new Error("Provider persistence not verified");
          let routeReady = false;
          try {
            const route = this.routing.verifyForManagement();
            if (route.ready && route.policyVerified && route.freeOnly)
              routeReady = operation.releaseAfterVerification().ready;
          } catch {
            /* Keep the durable route barrier until the policy can be verified. */
          }
          const result: OmniRouteAccountCreateResult = {
            ok: true,
            verified: true,
            id,
            provider: secret.provider,
            name: String(sanitize(secret.name)).slice(0, 200),
            active: current.isActive === true,
            routeReady,
          };
          try {
            this.audit.record({
              sessionId: "settings",
              tool,
              risk: "DANGEROUS",
              confirmation: "direct",
              phase: "after_execute",
              arguments: { id, provider: secret.provider, name: result.name },
              result: { ok: true, credentialPresent: true },
              verification: { persisted: true, routeReady },
            });
          } catch {
            result.auditWarning =
              "Opgeslagen en gecontroleerd; afronding kon niet in het actielog worden geschreven.";
          }
          return result;
        } catch {
          try {
            this.audit.record({
              sessionId: "settings",
              tool,
              risk: "DANGEROUS",
              confirmation: "direct",
              phase: "after_execute",
              arguments: {
                provider: secret.provider,
                name: String(sanitize(secret.name)),
              },
              result: { ok: false },
              verification: { persisted: null, routeReady: false },
            });
          } catch {
            /* Keep the pre-execution audit record. */
          }
          return {
            ok: false,
            verified: null,
            routeReady: false,
            error:
              "Uitkomst niet gecontroleerd. NOVA houdt AI geblokkeerd; controleer dit account in OmniRoute.",
          };
        }
      });
    } catch {
      return { ok: false, error: unavailable };
    } finally {
      this.inFlight.delete(busyKey);
    }
  }
}
