import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OmniRouteComboRemovalPrepared,
  OmniRouteComboRemovalResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { object } from "./request-input.js";

type Row = { id: string; name: string; data: string; sort_order: number };
const validId = (id: string) => /^[a-zA-Z0-9_.-]{1,100}$/.test(id);
const hash = (row: Row) =>
  crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
const unavailable =
  "Combo verwijderen is niet beschikbaar. Controleer de OmniRoute-koppeling.";

@Injectable()
export class OmniRouteComboRemoval {
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
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
  async prepare(
    id: string,
    acknowledgeEffects: unknown,
  ): Promise<OmniRouteComboRemovalPrepared> {
    if (!validId(id) || acknowledgeEffects !== true)
      throw new ValidationError([
        "Bevestig dat het verwijderen deze OmniRoute-route voor alle clients kan raken.",
      ]);
    try {
      const route = this.routing.verifyForManagement();
      if (!route.ready || !route.policyVerified || !route.freeOnly)
        throw new Error(unavailable);
      const { row, name } = await this.current(id);
      const revision = hash(row);
      const args = { id, revision };
      this.audit.record({
        sessionId: "settings",
        tool: "omniroute_combo_remove",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: args,
      });
      return {
        ok: true,
        name: String(sanitize(name)).slice(0, 160),
        action: this.confirmations.create(
          `settings-combo-remove:${crypto.randomUUID()}`,
          "omniroute_combo_remove",
          args,
          "DANGEROUS",
          revision,
          false,
        ),
      };
    } catch {
      return { ok: false, error: unavailable };
    }
  }
  async confirm(
    id: string,
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<OmniRouteComboRemovalResult> {
    if (
      !validId(id) ||
      !/^settings-combo-remove:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const pending = this.confirmations.peek(sessionId);
    if (
      !pending ||
      pending.tool !== "omniroute_combo_remove" ||
      pending.args.id !== id ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false,
        error: "Deze bevestiging staat niet meer open. Kies de combo opnieuw.",
      };
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false,
        error: "Bevestiging verlopen. Kies de combo opnieuw.",
      };
    try {
      return await this.barrier.run(async (operation) => {
        let before: { row: Row; name: string };
        try {
          before = await this.current(id);
          if (hash(before.row) !== action.args.revision)
            return {
              ok: false,
              error: "De combo is ondertussen gewijzigd. Kies haar opnieuw.",
            };
          this.audit.record({
            sessionId: "settings",
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "before_execute",
            arguments: { id, revision: action.args.revision },
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
              tool: action.tool,
              risk: "DANGEROUS",
              confirmation: "confirmed_admin_ui",
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
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
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
