import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OmniRouteKeyActivationPrepareResult,
  OmniRouteKeyActivationResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { OmniRouteActivationHistory } from "./omniroute-activation-history.service.js";
import { object } from "./request-input.js";

const safeId = (id: string) => /^[a-zA-Z0-9_.-]{1,100}$/.test(id);
const fail =
  "Sleutelbeheer niet beschikbaar. Controleer de OmniRoute-koppeling.";
type KeyRow = {
  id: string;
  is_active: number;
  revoked_at: string | null;
  model_access_mode: string | null;
  allowed_models: string | null;
  allowed_connections: string | null;
  allowed_combos: string | null;
  allow_auto_combos: number | null;
};
const digest = (row: KeyRow) =>
  crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");

@Injectable()
export class OmniRouteKeyActivation {
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

  private row(id: string): KeyRow | undefined {
    if (
      !safeId(id) ||
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(fail);
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT id,is_active,revoked_at,model_access_mode,allowed_models,allowed_connections,allowed_combos,allow_auto_combos FROM api_keys WHERE id=?",
        )
        .get(id) as KeyRow | undefined;
    } finally {
      db.close();
    }
  }
  private novaKeyId(): string | undefined {
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      return (
        db
          .prepare("SELECT id FROM api_keys WHERE key=? LIMIT 1")
          .get(this.config.omniKey) as { id?: string } | undefined
      )?.id;
    } finally {
      db.close();
    }
  }
  private async current(id: string) {
    const row = this.row(id);
    if (
      !row ||
      (row.is_active !== 0 && row.is_active !== 1) ||
      row.revoked_at ||
      id === this.novaKeyId()
    )
      throw new Error(fail);
    const result = object(await this.management.request("/api/keys"));
    if (!Array.isArray(result.keys)) throw new Error(fail);
    const raw = result.keys.map(object).find((key) => key.id === id);
    if (
      !raw ||
      typeof raw.isActive !== "boolean" ||
      raw.isActive !== (row.is_active === 1)
    )
      throw new Error(fail);
    return {
      row,
      name:
        typeof raw.name === "string"
          ? String(sanitize(raw.name)).slice(0, 160)
          : "Sleutel zonder naam",
      active: raw.isActive,
    };
  }
  async prepare(
    id: string,
    enabled: unknown,
    acknowledgeGlobalEffect: unknown,
    expectedRevision?: string,
  ): Promise<OmniRouteKeyActivationPrepareResult> {
    if (
      !safeId(id) ||
      typeof enabled !== "boolean" ||
      acknowledgeGlobalEffect !== true
    )
      throw new Error(
        "Kies een status en bevestig dat deze sleutel voor alle OmniRoute-clients geldt.",
      );
    try {
      const route = this.routing.verifyForManagement();
      if (!route.freeOnly) throw new Error(fail);
      const current = await this.current(id);
      if (expectedRevision && digest(current.row) !== expectedRevision)
        return {
          ok: false,
          error:
            "De sleutel is intussen gewijzigd. Laad de geschiedenis opnieuw.",
        };
      if (current.active === enabled)
        return { ok: false, error: "Deze sleutel heeft die status al." };
      const revision = digest(current.row);
      const args = { id, enabled, revision };
      this.audit.record({
        sessionId: "settings",
        tool: "omniroute_key_activation",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: args,
      });
      return {
        ok: true,
        name: current.name,
        currentEnabled: current.active,
        enabled,
        action: this.confirmations.create(
          `settings-key-activation:${crypto.randomUUID()}`,
          "omniroute_key_activation",
          args,
          "DANGEROUS",
          revision,
          false,
        ),
      };
    } catch {
      return { ok: false, error: fail };
    }
  }
  async confirm(
    id: string,
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<OmniRouteKeyActivationResult> {
    if (
      !safeId(id) ||
      !/^settings-key-activation:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new Error("Ongeldige bevestiging.");
    const pending = this.confirmations.peek(sessionId);
    if (
      !pending ||
      pending.tool !== "omniroute_key_activation" ||
      pending.args.id !== id ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false,
        error:
          "Deze bevestiging staat niet meer open. Kies de sleutel opnieuw.",
      };
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false,
        error: "Bevestiging verlopen. Kies de sleutel opnieuw.",
      };
    if (this.inFlight.has(id))
      return { ok: false, error: "Deze sleutel wordt al gewijzigd." };
    this.inFlight.add(id);
    try {
      return await this.barrier.run(async (operation) => {
        let before: Awaited<ReturnType<OmniRouteKeyActivation["current"]>>;
        try {
          const route = this.routing.verifyForManagement();
          if (
            this.config.omniUrl !== this.config.verifiedOmniUrl ||
            !route.freeOnly
          )
            return { ok: false, error: fail };
          before = await this.current(id);
          if (
            digest(before.row) !== action.args.revision ||
            typeof action.args.enabled !== "boolean" ||
            before.active === action.args.enabled
          )
            return {
              ok: false,
              error:
                "De sleutel is ondertussen gewijzigd. Kies de wijziging opnieuw.",
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
          return { ok: false, error: fail };
        }
        const enabled = action.args.enabled as boolean;
        let after: Awaited<ReturnType<OmniRouteKeyActivation["current"]>>;
        try {
          await this.management.request(`/api/keys/${id}`, {
            method: "PATCH",
            body: { isActive: enabled },
          });
          after = await this.current(id);
          if (
            after.row.is_active !== Number(enabled) ||
            after.active !== enabled
          )
            throw new Error("Key update not persisted");
        } catch {
          return {
            ok: false,
            verified: null,
            routeReady: false,
            error:
              "Uitkomst niet gecontroleerd. NOVA houdt AI geblokkeerd; controleer routes en sleutelstatus.",
          };
        }
        let historyWarning: string | undefined;
        try {
          historyWarning = this.history.record({
            kind: "key",
            entityId: id,
            name: before.name,
            beforeEnabled: before.active,
            afterEnabled: after.active,
            beforeRevision: digest(before.row),
            afterRevision: digest(after.row),
          });
        } catch {
          historyWarning =
            "Sleutelwijziging is gecontroleerd, maar de geschiedenis kon niet worden opgeslagen.";
        }
        let routeReady = false;
        try {
          const status = this.routing.verifyForManagement();
          if (status.ready && status.policyVerified && status.freeOnly)
            routeReady = operation.releaseAfterVerification().ready;
        } catch {
          /* fail closed */
        }
        const result: OmniRouteKeyActivationResult = {
          ok: true,
          verified: true,
          enabled,
          routeReady,
          ...(historyWarning ? { historyWarning } : {}),
        };
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
          "Wijziging kon niet starten. Controleer koppeling en gratis route.",
      };
    } finally {
      this.inFlight.delete(id);
    }
  }
}
