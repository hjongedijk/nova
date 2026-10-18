import { Injectable } from "@nestjs/common";
import { DatabaseSync } from "node:sqlite";
import type { OmniRouteAccountRemovalResult } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";

type Account = {
  id: string;
  provider: string;
  name: string | null;
  is_active: number;
  updated_at: string;
};
const validId = (id: string) => /^[a-zA-Z0-9_.-]{1,100}$/.test(id);
const unavailable =
  "Accountbeheer is niet beschikbaar. Controleer de OmniRoute-koppeling.";

/** Explicit account deletion; there is no model tool or provider test here. */
@Injectable()
export class OmniRouteAccountRemoval {
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly audit: AuditService,
    private readonly barrier: RoutingManagementBarrier,
    private readonly routing: RoutingService,
  ) {}

  private row(id: string): Account | undefined {
    if (
      !validId(id) ||
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(unavailable);
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT id,provider,name,is_active,updated_at FROM provider_connections WHERE id=?",
        )
        .get(id) as Account | undefined;
    } finally {
      db.close();
    }
  }

  async remove(id: string): Promise<OmniRouteAccountRemovalResult> {
    if (!validId(id)) throw new ValidationError(["Ongeldig account."]);
    const tool = "omniroute_account_remove";
    try {
      return await this.barrier.run(async (operation) => {
        const before = this.row(id);
        if (!before)
          return { ok: false, error: "Dit account bestaat niet meer." };
        this.audit.record({
          sessionId: "settings",
          tool,
          risk: "DANGEROUS",
          confirmation: "direct",
          phase: "before_execute",
          arguments: { id },
        });
        operation.block("account_change");
        try {
          await this.management.request(`/api/providers/${id}`, {
            method: "DELETE",
          });
          if (this.row(id))
            throw new Error("Deletion persistence not verified");
        } catch {
          try {
            this.audit.record({
              sessionId: "settings",
              tool,
              risk: "DANGEROUS",
              confirmation: "direct",
              phase: "after_execute",
              arguments: { id },
              result: { ok: false },
              verification: { persisted: null, routeReady: false },
            });
          } catch {
            /* Before-execution audit remains available. */
          }
          return {
            ok: false,
            verified: null,
            routeReady: false,
            error:
              "Verwijdering kon niet worden gecontroleerd. Het account kan al verwijderd zijn. AI blijft geblokkeerd tot de gratis route opnieuw is gecontroleerd.",
          };
        }
        let routeReady = false;
        try {
          const status = this.routing.verifyForManagement();
          if (status.ready && status.policyVerified && status.freeOnly)
            routeReady = operation.releaseAfterVerification().ready;
        } catch {
          /* A persisted or in-memory stop remains until fresh verification succeeds. */
        }
        const result: OmniRouteAccountRemovalResult = {
          ok: true,
          verified: true,
          routeReady,
        };
        try {
          this.audit.record({
            sessionId: "settings",
            tool,
            risk: "DANGEROUS",
            confirmation: "direct",
            phase: "after_execute",
            arguments: { id },
            result: { ok: true },
            verification: { persisted: true, routeReady },
          });
        } catch {
          result.auditWarning =
            "Verwijderd en gecontroleerd; afronding kon niet in het actielog worden geschreven.";
        }
        return result;
      });
    } catch {
      return {
        ok: false,
        error:
          "Verwijdering kon niet starten. Controleer de koppeling en de gratis route voordat je opnieuw probeert.",
      };
    }
  }
}
