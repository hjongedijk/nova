import { Injectable } from "@nestjs/common";
import { DatabaseSync } from "node:sqlite";
import type { OmniRouteComboRemovalResult } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { object } from "./request-input.js";

type Row = { id: string; name: string; data: string; sort_order: number };
const validId = (id: string) => /^[a-zA-Z0-9_.-]{1,100}$/.test(id);
const unavailable =
  "Combo verwijderen is niet beschikbaar. Controleer de OmniRoute-koppeling.";

@Injectable()
export class OmniRouteComboRemoval {
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly audit: AuditService,
    private readonly barrier: RoutingManagementBarrier,
    private readonly routing: RoutingService,
  ) {}
  private row(id: string): Row | undefined {
    if (
      !validId(id) ||
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(unavailable);
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      return db
        .prepare("SELECT id,name,data,sort_order FROM combos WHERE id=?")
        .get(id) as Row | undefined;
    } finally {
      db.close();
    }
  }
  private async current(id: string) {
    const row = this.row(id);
    if (!row || row.name.startsWith("qtSd/")) throw new Error(unavailable);
    const api = object(await this.management.request(`/api/combos/${id}`));
    const data = object(JSON.parse(row.data));
    if (
      api.id !== id ||
      api.name !== row.name ||
      typeof api.isActive !== "boolean" ||
      api.isActive !== data.isActive
    )
      throw new Error(unavailable);
    return { row, name: row.name };
  }
  async remove(id: string): Promise<OmniRouteComboRemovalResult> {
    if (!validId(id)) throw new ValidationError(["Ongeldige combo."]);
    try {
      return await this.barrier.run(async (operation) => {
        try {
          const route = this.routing.verifyForManagement();
          if (!route.ready || !route.policyVerified || !route.freeOnly)
            throw new Error(unavailable);
          await this.current(id);
          this.audit.record({
            sessionId: "settings",
            tool: "omniroute_combo_remove",
            risk: "DANGEROUS",
            confirmation: "direct",
            phase: "before_execute",
            arguments: { id },
          });
          operation.block("policy_change");
        } catch {
          return { ok: false, error: unavailable };
        }
        try {
          await this.management.request(`/api/combos/${id}`, {
            method: "DELETE",
          });
          if (this.row(id))
            throw new Error("Combo deletion persistence not verified");
        } catch {
          try {
            this.audit.record({
              sessionId: "settings",
              tool: "omniroute_combo_remove",
              risk: "DANGEROUS",
              confirmation: "direct",
              phase: "after_execute",
              arguments: { id },
              result: { ok: false },
              verification: { persisted: null, routeReady: false },
            });
          } catch {
            /* keep initial audit */
          }
          return {
            ok: false,
            verified: null,
            routeReady: false,
            error:
              "Verwijdering kon niet worden gecontroleerd. De combo kan al verwijderd zijn; NOVA houdt AI geblokkeerd tot het routebeleid is gecontroleerd.",
          };
        }
        let routeReady = false;
        try {
          const status = this.routing.verifyForManagement();
          if (status.ready && status.policyVerified && status.freeOnly)
            routeReady = operation.releaseAfterVerification().ready;
        } catch {
          /* fail closed */
        }
        const result: OmniRouteComboRemovalResult = {
          ok: true,
          verified: true,
          routeReady,
        };
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "omniroute_combo_remove",
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
          "Verwijdering kon niet starten. Controleer koppeling en gratis route.",
      };
    }
  }
}
