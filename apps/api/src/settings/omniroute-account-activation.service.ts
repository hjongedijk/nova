import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OmniRouteAccountActivationPrepared,
  OmniRouteAccountActivationResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { claimConfirmation } from "./confirmation-step.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { OmniRouteActivationHistory } from "./omniroute-activation-history.service.js";
import { object } from "./request-input.js";

type Account = {
  id: string;
  provider: string;
  name: string | null;
  is_active: number;
  updated_at: string;
};
type AccountView = {
  id: string;
  provider: string;
  name: string | null;
  isActive: boolean;
};
const validId = (id: string) => /^[a-zA-Z0-9_.-]{1,100}$/.test(id);
const revision = (row: Account) =>
  crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
const unavailable =
  "Accountbeheer is niet beschikbaar. Controleer de OmniRoute-koppeling.";

/** Explicit global provider toggle; never probes credentials or returns key material. */
@Injectable()
export class OmniRouteAccountActivation {
  private readonly inFlight = new Set<string>();
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
    private readonly barrier: RoutingManagementBarrier,
    private readonly routing: RoutingService,
    private readonly history: OmniRouteActivationHistory,
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

  private async current(
    id: string,
  ): Promise<{ row: Account; view: AccountView }> {
    const row = this.row(id);
    if (!row || (row.is_active !== 0 && row.is_active !== 1))
      throw new Error(unavailable);
    const raw = object(await this.management.request(`/api/providers/${id}`));
    const connection = object(raw.connection);
    if (
      connection.id !== id ||
      connection.provider !== row.provider ||
      typeof connection.isActive !== "boolean" ||
      (connection.name ?? null) !== row.name ||
      connection.isActive !== (row.is_active === 1)
    )
      throw new Error("Provider persistence does not match management API");
    return {
      row,
      view: {
        id,
        provider: row.provider,
        name: row.name,
        isActive: connection.isActive,
      },
    };
  }

  async prepare(
    id: string,
    enabled: unknown,
    acknowledgeGlobalEffect: unknown,
    expectedCurrentRevision?: string,
  ): Promise<OmniRouteAccountActivationPrepared> {
    if (
      !validId(id) ||
      typeof enabled !== "boolean" ||
      acknowledgeGlobalEffect !== true
    )
      throw new ValidationError([
        "Kies een status en bevestig dat dit account voor alle OmniRoute-clients wordt gewijzigd.",
      ]);
    try {
      const route = this.routing.verifyForManagement();
      // Allow recovery when a disabled account itself has made an otherwise
      // free-only route unready. No inference is released by this operation
      // unless the full policy verifies after the write.
      if (!route.freeOnly) throw new Error(unavailable);
      const { row, view } = await this.current(id);
      if (
        expectedCurrentRevision !== undefined &&
        revision(row) !== expectedCurrentRevision
      )
        return {
          ok: false,
          error:
            "Het account is gewijzigd sinds deze wijzigingsgeschiedenis. Herstel is afgebroken.",
        };
      if (view.isActive === enabled)
        return { ok: false, error: "Dit provideraccount heeft die status al." };
      const digest = revision(row);
      this.audit.record({
        sessionId: "settings",
        tool: "omniroute_account_activation",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: { id, enabled, revision: digest },
      });
      return {
        ok: true,
        name: String(sanitize(view.name || view.provider)).slice(0, 200),
        currentEnabled: view.isActive,
        enabled,
        action: this.confirmations.create(
          `settings-account-activation:${crypto.randomUUID()}`,
          "omniroute_account_activation",
          { id, enabled, revision: digest },
          "DANGEROUS",
          digest,
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
  ): Promise<OmniRouteAccountActivationResult> {
    if (
      !validId(id) ||
      !/^settings-account-activation:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const claimed = claimConfirmation(
      this.confirmations,
      sessionId,
      confirmationId,
      approve,
      {
        tool: "omniroute_account_activation",
        arg: { name: "id", value: id },
        stale:
          "Deze bevestiging staat niet meer open. Kies het account opnieuw.",
        expired: "Bevestiging verlopen. Kies het account opnieuw.",
      },
    );
    if ("reply" in claimed) return claimed.reply;
    const action = claimed.action;
    if (this.inFlight.has(id))
      return { ok: false, error: "Dit account wordt al gewijzigd." };
    this.inFlight.add(id);
    try {
      return await this.barrier.run(async (operation) => {
        let before: { row: Account; view: AccountView };
        let after: { row: Account; view: AccountView };
        try {
          const route = this.routing.verifyForManagement();
          if (
            this.config.omniUrl !== this.config.verifiedOmniUrl ||
            !route.freeOnly
          )
            return { ok: false, error: unavailable };
          before = await this.current(id);
          if (
            revision(before.row) !== action.args.revision ||
            typeof action.args.enabled !== "boolean" ||
            before.view.isActive === action.args.enabled
          )
            return {
              ok: false,
              error:
                "Het account is ondertussen gewijzigd. Kies de wijziging opnieuw.",
            };
          this.audit.record({
            sessionId: "settings",
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "before_execute",
            arguments: {
              id,
              enabled: action.args.enabled,
              revision: action.args.revision,
            },
          });
          operation.block("policy_change");
        } catch {
          return { ok: false, error: unavailable };
        }
        const enabled = action.args.enabled as boolean;
        try {
          await this.management.request(`/api/providers/${id}`, {
            method: "PATCH",
            body: { isActive: enabled },
          });
          after = await this.current(id);
          if (
            after.row.id !== before.row.id ||
            after.row.provider !== before.row.provider ||
            after.row.name !== before.row.name ||
            after.row.is_active !== Number(enabled) ||
            after.view.isActive !== enabled
          )
            throw new Error("Provider update persistence not verified");
        } catch {
          try {
            this.audit.record({
              sessionId: "settings",
              tool: action.tool,
              risk: "DANGEROUS",
              confirmation: "confirmed_admin_ui",
              phase: "after_execute",
              arguments: { id, enabled },
              result: { ok: false },
              verification: { persisted: null, routeReady: false },
            });
          } catch {
            /* Keep initial audit. */
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
          /* Durable inference stop remains until recovery verification. */
        }
        const result: OmniRouteAccountActivationResult = {
          ok: true,
          verified: true,
          enabled,
          routeReady,
        };
        result.historyWarning = this.history.record({
          entityId: id,
          name: String(
            sanitize(before.view.name || before.view.provider),
          ).slice(0, 200),
          beforeEnabled: before.view.isActive,
          afterEnabled: after.view.isActive,
          beforeRevision: revision(before.row),
          afterRevision: revision(after.row),
        });
        if (!result.historyWarning) delete result.historyWarning;
        try {
          this.audit.record({
            sessionId: "settings",
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
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
