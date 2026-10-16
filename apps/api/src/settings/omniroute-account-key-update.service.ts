import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OmniRouteAccountKeyUpdatePrepared,
  OmniRouteAccountKeyUpdateResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { object, sameSecret } from "./request-input.js";

type Account = {
  id: string;
  provider: string;
  name: string;
  authType: "apikey";
  active: boolean | null;
  key: string;
};
type PendingSecret = Account & {
  requestId: string;
  replacement: string;
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

const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
const unavailable =
  "API-sleutel vervangen is niet beschikbaar. Controleer of dit een API-sleutelaccount is en probeer opnieuw.";

/** Rotates API-key credentials only; keeps the new value in memory until one-use approval. */
@Injectable()
export class OmniRouteAccountKeyUpdate {
  private readonly secrets = new Map<string, PendingSecret>();

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

  private async readAccount(id: string): Promise<Account> {
    const response = object(
      await this.management.request(`/api/providers/${id}`),
    );
    const current = object(response.connection);
    const row = this.stored(id);
    if (
      current.id !== id ||
      typeof current.provider !== "string" ||
      typeof current.name !== "string" ||
      current.authType !== "apikey" ||
      (typeof current.isActive !== "boolean" &&
        current.isActive !== undefined) ||
      !row ||
      row.id !== id ||
      row.provider !== current.provider ||
      row.name !== current.name ||
      (row.is_active !== 0 && row.is_active !== 1) ||
      typeof row.api_key !== "string" ||
      !row.api_key
    )
      throw new Error(unavailable);
    return {
      id,
      provider: current.provider,
      name: current.name,
      authType: "apikey",
      active: typeof current.isActive === "boolean" ? current.isActive : null,
      key: row.api_key,
    };
  }

  async prepare(
    rawId: unknown,
    rawKey: unknown,
    acknowledgeEffects: unknown,
  ): Promise<OmniRouteAccountKeyUpdatePrepared> {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    const replacement = typeof rawKey === "string" ? rawKey.trim() : "";
    if (
      !validId(id) ||
      !replacement ||
      replacement.length > 64_000 ||
      acknowledgeEffects !== true
    )
      throw new ValidationError([
        "Selecteer een API-sleutelaccount, voer de nieuwe sleutel in en bevestig de clientbrede wijziging en mogelijke OmniRoute-cloudsync.",
      ]);
    try {
      this.assertGateway();
      const account = await this.readAccount(id);
      if (sameSecret(account.key, replacement))
        throw new Error("De nieuwe sleutel is gelijk aan de huidige sleutel.");
      const requestId = crypto.randomUUID();
      const action = this.confirmations.create(
        `settings-account-key-update:${requestId}`,
        "omniroute_account_key_update",
        { requestId, id },
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
        ...account,
        requestId,
        replacement,
        expiresAt: action.expiresAt,
        timer,
      });
      this.audit.record({
        sessionId: "settings",
        tool: action.tool,
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: { id, provider: account.provider, credentialPresent: true },
      });
      return {
        ok: true,
        id,
        provider: String(sanitize(account.provider)),
        name: String(sanitize(account.name)),
        action,
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error &&
          error.message ===
            "De nieuwe sleutel is gelijk aan de huidige sleutel."
            ? "De nieuwe sleutel is gelijk aan de huidige sleutel."
            : unavailable,
      };
    }
  }

  async confirm(
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<OmniRouteAccountKeyUpdateResult> {
    if (
      !/^settings-account-key-update:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const pending = this.confirmations.peek(sessionId);
    if (
      !pending ||
      pending.tool !== "omniroute_account_key_update" ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false,
        error: "Bevestiging verlopen. Vul de sleutel opnieuw in.",
      };
    const secret = this.secrets.get(confirmationId);
    const clear = () => {
      if (secret) clearTimeout(secret.timer);
      this.secrets.delete(confirmationId);
    };
    if (!secret || secret.expiresAt <= Date.now()) {
      clear();
      this.confirmations.cancel(sessionId, "expired_admin_ui");
      return {
        ok: false,
        error: "Bevestiging verlopen. Vul de sleutel opnieuw in.",
      };
    }
    if (!approve) {
      clear();
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    clear();
    if (!action)
      return {
        ok: false,
        error: "Bevestiging verlopen. Vul de sleutel opnieuw in.",
      };

    try {
      return await this.barrier.run(async (operation) => {
        try {
          this.assertGateway();
          if (
            action.args.requestId !== secret.requestId ||
            action.args.id !== secret.id
          )
            throw new Error(unavailable);
          const before = await this.readAccount(secret.id);
          if (
            before.provider !== secret.provider ||
            before.name !== secret.name ||
            !sameSecret(before.key, secret.key)
          )
            throw new Error(unavailable);
          this.audit.record({
            sessionId: "settings",
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "before_execute",
            arguments: {
              id: secret.id,
              provider: secret.provider,
              credentialPresent: true,
              cloudSyncMayRun: true,
            },
          });
          operation.block("account_change");
        } catch {
          return { ok: false, error: unavailable };
        }

        try {
          await this.management.request(`/api/providers/${secret.id}`, {
            method: "PUT",
            body: { apiKey: secret.replacement },
          });
          const after = await this.readAccount(secret.id);
          if (
            after.provider !== secret.provider ||
            after.name !== secret.name ||
            !sameSecret(after.key, secret.replacement)
          )
            throw new Error("Credential persistence not verified");
          let routeReady = false;
          try {
            const route = this.routing.verifyForManagement();
            if (route.ready && route.policyVerified && route.freeOnly)
              routeReady = operation.releaseAfterVerification().ready;
          } catch {
            /* Keep the durable route barrier until the policy can be verified. */
          }
          const result: OmniRouteAccountKeyUpdateResult = {
            ok: true,
            verified: true,
            id: secret.id,
            routeReady,
          };
          try {
            this.audit.record({
              sessionId: "settings",
              tool: action.tool,
              risk: "DANGEROUS",
              confirmation: "confirmed_admin_ui",
              phase: "after_execute",
              arguments: { id: secret.id, provider: secret.provider },
              result: { ok: true, credentialPresent: true },
              verification: { persisted: true, routeReady },
            });
          } catch {
            result.auditWarning =
              "Sleutel opgeslagen en gecontroleerd; afronding kon niet in het actielog worden geschreven.";
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
              arguments: { id: secret.id, provider: secret.provider },
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
    }
  }
}
