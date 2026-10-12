import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OmniRouteAccountCreatePrepared,
  OmniRouteAccountCreateResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";

type PendingSecret = {
  requestId: string;
  provider: string;
  name: string;
  key: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};
type StoredAccount = {
  id: string;
  provider: string;
  name: string | null;
  is_active: number;
  api_key: string | null;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
const sameSecret = (left: string, right: string) =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(left).digest(),
    crypto.createHash("sha256").update(right).digest(),
  );

/** Keeps a provider credential in process memory only until its one-use confirmation expires. */
@Injectable()
export class OmniRouteAccountCreate {
  private readonly secrets = new Map<string, PendingSecret>();
  private readonly inFlight = new Set<string>();
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
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

  async prepare(
    rawProvider: unknown,
    rawName: unknown,
    rawKey: unknown,
    acknowledgeEffects: unknown,
  ): Promise<OmniRouteAccountCreatePrepared> {
    const provider = typeof rawProvider === "string" ? rawProvider.trim() : "";
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (
      !validProvider(provider) ||
      !validName(name) ||
      !key ||
      key.length > 64_000 ||
      acknowledgeEffects !== true
    )
      throw new ValidationError([
        "Vul de provider-ID, accountnaam en API-sleutel in en bevestig de clientbrede toegang en mogelijke providerverzoeken door OmniRoute.",
      ]);
    try {
      this.assertGateway();
      await this.assertUnique(provider, name);
      const requestId = crypto.randomUUID();
      const action = this.confirmations.create(
        `settings-account-create:${requestId}`,
        "omniroute_account_create",
        { requestId, provider, name },
        "DANGEROUS",
        undefined,
        false,
      );
      const timer = setTimeout(
        () => this.secrets.delete(action.confirmationId),
        60_500,
      );
      timer.unref?.();
      this.secrets.set(action.confirmationId, {
        requestId,
        provider,
        name,
        key,
        expiresAt: action.expiresAt,
        timer,
      });
      this.audit.record({
        sessionId: "settings",
        tool: "omniroute_account_create",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: {
          provider,
          name: String(sanitize(name)).slice(0, 200),
          credentialPresent: true,
        },
      });
      return {
        ok: true,
        provider,
        name: String(sanitize(name)).slice(0, 200),
        action,
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error &&
          error.message ===
            "Er bestaat al een account met deze naam voor deze provider."
            ? "Er bestaat al een account met deze naam voor deze provider."
            : unavailable,
      };
    }
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

  async confirm(
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<OmniRouteAccountCreateResult> {
    if (
      !/^settings-account-create:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const pending = this.confirmations.peek(sessionId);
    if (
      !pending ||
      pending.tool !== "omniroute_account_create" ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false,
        error:
          "Deze bevestiging staat niet meer open. Vul het account opnieuw in.",
      };
    const secret = this.secrets.get(confirmationId);
    if (!secret || secret.expiresAt <= Date.now()) {
      if (secret) clearTimeout(secret.timer);
      this.secrets.delete(confirmationId);
      this.confirmations.cancel(sessionId, "expired_admin_ui");
      return {
        ok: false,
        error: "Bevestiging verlopen. Vul het account opnieuw in.",
      };
    }
    if (!approve) {
      clearTimeout(secret.timer);
      this.secrets.delete(confirmationId);
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action) {
      clearTimeout(secret.timer);
      this.secrets.delete(confirmationId);
      return {
        ok: false,
        error: "Bevestiging verlopen. Vul het account opnieuw in.",
      };
    }
    clearTimeout(secret.timer);
    this.secrets.delete(confirmationId);
    const busyKey = `${secret.provider}/${secret.name.toLocaleLowerCase()}`;
    if (this.inFlight.has(busyKey))
      return { ok: false, error: "Dit provideraccount wordt al toegevoegd." };
    this.inFlight.add(busyKey);
    try {
      return await this.barrier.run(async (operation) => {
        try {
          this.assertGateway();
          if (
            action.args.requestId !== secret.requestId ||
            action.args.provider !== secret.provider ||
            action.args.name !== secret.name
          )
            throw new Error(unavailable);
          await this.assertUnique(secret.provider, secret.name);
          this.audit.record({
            sessionId: "settings",
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "before_execute",
            arguments: {
              provider: secret.provider,
              name: String(sanitize(secret.name)).slice(0, 200),
              credentialPresent: true,
              providerMayTestCredential: true,
            },
          });
          operation.block("account_change");
        } catch {
          return { ok: false, error: unavailable };
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
            !sameSecret(row.api_key, secret.key)
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
              tool: action.tool,
              risk: "DANGEROUS",
              confirmation: "confirmed_admin_ui",
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
              tool: action.tool,
              risk: "DANGEROUS",
              confirmation: "confirmed_admin_ui",
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
