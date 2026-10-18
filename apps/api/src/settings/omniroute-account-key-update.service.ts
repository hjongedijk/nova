import { Injectable } from "@nestjs/common";
import { DatabaseSync } from "node:sqlite";
import type { OmniRouteAccountKeyUpdateResult } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
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

/** Rotates API-key credentials only, in one step; the new key is never stored, echoed or audited. */
@Injectable()
export class OmniRouteAccountKeyUpdate {
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

  async update(
    rawId: unknown,
    rawKey: unknown,
  ): Promise<OmniRouteAccountKeyUpdateResult> {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    const replacement = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!validId(id) || !replacement || replacement.length > 64_000)
      throw new ValidationError([
        "Selecteer een API-sleutelaccount en voer de nieuwe sleutel in.",
      ]);
    const tool = "omniroute_account_key_update";
    try {
      return await this.barrier.run(async (operation) => {
        let provider: string;
        let name: string;
        try {
          this.assertGateway();
          const before = await this.readAccount(id);
          if (sameSecret(before.key, replacement))
            return {
              ok: false,
              error: "De nieuwe sleutel is gelijk aan de huidige sleutel.",
            };
          provider = before.provider;
          name = before.name;
          this.audit.record({
            sessionId: "settings",
            tool,
            risk: "DANGEROUS",
            confirmation: "direct",
            phase: "before_execute",
            arguments: {
              id,
              provider,
              credentialPresent: true,
              cloudSyncMayRun: true,
            },
          });
          operation.block("account_change");
        } catch {
          return { ok: false, error: unavailable };
        }

        try {
          await this.management.request(`/api/providers/${id}`, {
            method: "PUT",
            body: { apiKey: replacement },
          });
          const after = await this.readAccount(id);
          if (
            after.provider !== provider ||
            after.name !== name ||
            !sameSecret(after.key, replacement)
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
            id,
            routeReady,
          };
          try {
            this.audit.record({
              sessionId: "settings",
              tool,
              risk: "DANGEROUS",
              confirmation: "direct",
              phase: "after_execute",
              arguments: { id, provider: provider },
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
              tool,
              risk: "DANGEROUS",
              confirmation: "direct",
              phase: "after_execute",
              arguments: { id, provider: provider },
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
