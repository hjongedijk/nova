import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { OmniRouteComboActivationResult } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { OmniRouteActivationHistory } from "./omniroute-activation-history.service.js";
import { object } from "./request-input.js";

type ComboRow = { id: string; name: string; data: string; sort_order: number };
type ComboView = { id: string; name: string; isActive: boolean };
const validId = (id: string) => /^[a-zA-Z0-9_.-]{1,100}$/.test(id);
const configRevision = (row: ComboRow) => {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  delete data.isActive;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([row.id, row.name, row.sort_order, data]))
    .digest("hex");
};
const statusRevision = (row: ComboRow) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify([row.id, row.name, object(JSON.parse(row.data)).isActive]),
    )
    .digest("hex");
const unavailable =
  "Combo-beheer is niet beschikbaar. Controleer de OmniRoute-koppeling.";

/** Explicitly toggles one ordinary combo; every gateway client can be affected. */
@Injectable()
export class OmniRouteComboActivation {
  private readonly inFlight = new Set<string>();
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly audit: AuditService,
    private readonly barrier: RoutingManagementBarrier,
    private readonly routing: RoutingService,
    private readonly history: OmniRouteActivationHistory,
  ) {}

  private row(id: string): ComboRow {
    if (
      !validId(id) ||
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(unavailable);
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT id,name,data,sort_order FROM combos WHERE id=?")
        .get(id) as ComboRow | undefined;
      if (
        !row ||
        typeof row.name !== "string" ||
        typeof row.data !== "string" ||
        !Number.isSafeInteger(row.sort_order)
      )
        throw new Error(unavailable);
      return row;
    } finally {
      db.close();
    }
  }

  private view(value: unknown, id: string): ComboView {
    const row = object(value);
    if (
      row.id !== id ||
      typeof row.name !== "string" ||
      typeof row.isActive !== "boolean" ||
      row.name.startsWith("qtSd/")
    )
      throw new Error(unavailable);
    return { id, name: row.name, isActive: row.isActive };
  }

  private databaseEnabled(row: ComboRow): boolean {
    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      throw new Error(unavailable);
    }
    if (typeof object(data).isActive !== "boolean")
      throw new Error(unavailable);
    return object(data).isActive as boolean;
  }

  private async current(
    id: string,
  ): Promise<{ row: ComboRow; view: ComboView }> {
    const row = this.row(id);
    const view = this.view(
      await this.management.request(`/api/combos/${id}`),
      id,
    );
    if (view.name !== row.name || view.isActive !== this.databaseEnabled(row))
      throw new Error("Combo persistence does not match the management API");
    return { row, view };
  }

  async apply(
    id: string,
    enabled: unknown,
    expectedCurrentRevision?: string,
  ): Promise<OmniRouteComboActivationResult> {
    if (!validId(id) || typeof enabled !== "boolean")
      throw new ValidationError(["Kies een geldige status voor de combo."]);
    if (this.inFlight.has(id))
      return { ok: false, error: "Deze combo wordt al gewijzigd." };
    this.inFlight.add(id);
    try {
      return await this.barrier.run(async (operation) => {
        let before: { row: ComboRow; view: ComboView };
        let afterRow: ComboRow;
        try {
          const route = this.routing.verifyForManagement();
          if (!route.ready || !route.policyVerified || !route.freeOnly)
            throw new Error(unavailable);
          before = await this.current(id);
          if (
            expectedCurrentRevision !== undefined &&
            statusRevision(before.row) !== expectedCurrentRevision
          )
            return {
              ok: false,
              error:
                "De combo is gewijzigd sinds deze wijzigingsgeschiedenis. Herstel is afgebroken.",
            };
          if (before.view.isActive === enabled)
            return { ok: false, error: "Deze combo heeft die status al." };
          this.audit.record({
            sessionId: "settings",
            tool: "omniroute_combo_activation",
            risk: "DANGEROUS",
            confirmation: "direct",
            phase: "before_execute",
            arguments: { id, enabled },
          });
          operation.block("policy_change");
        } catch {
          return { ok: false, error: unavailable };
        }
        try {
          await this.management.request(`/api/combos/${id}`, {
            method: "PATCH",
            body: { isActive: enabled },
          });
          afterRow = this.row(id);
          const afterView = this.view(
            await this.management.request(`/api/combos/${id}`),
            id,
          );
          if (
            afterRow.id !== before.row.id ||
            afterRow.name !== before.row.name ||
            configRevision(afterRow) !== configRevision(before.row) ||
            afterView.name !== before.view.name ||
            this.databaseEnabled(afterRow) !== enabled ||
            afterView.isActive !== enabled
          )
            throw new Error("Combo update persistence not verified");
        } catch {
          try {
            this.audit.record({
              sessionId: "settings",
              tool: "omniroute_combo_activation",
              risk: "DANGEROUS",
              confirmation: "direct",
              phase: "after_execute",
              arguments: { id, enabled },
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
              "Uitkomst niet gecontroleerd. NOVA houdt AI geblokkeerd; laad routes en gratis beleid opnieuw.",
          };
        }
        let routeReady = false;
        try {
          const status = this.routing.verifyForManagement();
          if (status.ready && status.policyVerified && status.freeOnly)
            routeReady = operation.releaseAfterVerification().ready;
        } catch {
          /* Keep the durable inference stop until a later verified recovery. */
        }
        const result: OmniRouteComboActivationResult = {
          ok: true,
          verified: true,
          enabled,
          routeReady,
        };
        result.historyWarning = this.history.record({
          kind: "combo",
          entityId: id,
          name: String(sanitize(before.view.name)).slice(0, 200),
          beforeEnabled: before.view.isActive,
          afterEnabled: enabled,
          beforeRevision: statusRevision(before.row),
          afterRevision: statusRevision(afterRow),
        });
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "omniroute_combo_activation",
            risk: "DANGEROUS",
            confirmation: "direct",
            phase: "after_execute",
            arguments: { id, enabled },
            result: { ok: true },
            verification: { persisted: true, routeReady },
          });
        } catch {
          result.auditWarning =
            "Opgeslagen en gecontroleerd; afronding kon niet in het actielog worden geschreven.";
        }
        return result;
      });
    } catch {
      return {
        ok: false,
        error:
          "Wijziging kon niet starten. Controleer de koppeling en gratis route.",
      };
    } finally {
      this.inFlight.delete(id);
    }
  }
}
