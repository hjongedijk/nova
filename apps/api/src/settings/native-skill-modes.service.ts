import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  NativeSkillMode,
  NativeSkillModePrepared,
  NativeSkillModeResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { ValidationError } from "../core/errors/validation.error.js";

type Row = {
  id: string;
  api_key_id: string;
  name: string;
  handler: string;
  schema: string;
  mode: string;
  enabled: number;
  updated_at: string;
};
const hash = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (row: Row) =>
  hash([row.id, row.api_key_id, row.name, row.handler, row.schema]);
const revision = (row: Row) =>
  hash([binding(row), row.mode, row.enabled, row.updated_at]);
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const validMode = (value: unknown): value is NativeSkillMode =>
  value === "on" || value === "off" || value === "auto";
const unavailable =
  "Skillbeheer is niet beschikbaar. Controleer de OmniRoute-koppeling.";

/** Native mode changes stay in the settings API; there is no corresponding model tool. */
@Injectable()
export class NativeSkillModesService {
  private readonly inFlight = new Set<string>();
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
  ) {}

  private row(id: string): Row {
    if (
      !validId(id) ||
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(unavailable);
    const owner = this.management.scope;
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT id,api_key_id,name,handler,schema,mode,enabled,updated_at FROM skills WHERE id=?",
        )
        .get(id) as Row | undefined;
      if (
        !row ||
        row.api_key_id !== owner ||
        !validMode(row.mode) ||
        (row.enabled !== 0 && row.enabled !== 1)
      )
        throw new Error(unavailable);
      return row;
    } finally {
      db.close();
    }
  }

  prepare(id: string, mode: unknown): NativeSkillModePrepared {
    if (!validId(id) || !validMode(mode))
      throw new ValidationError(["Kies een geldige skill en modus."]);
    try {
      const row = this.row(id);
      this.audit.record({
        sessionId: "settings",
        tool: "native_skill_mode",
        risk: mode === "off" ? "CONFIRM" : "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: { id, mode },
      });
      const action = this.confirmations.create(
        `settings-native:${crypto.randomUUID()}`,
        "native_skill_mode",
        { id, mode, revision: revision(row) },
        mode === "off" ? "CONFIRM" : "DANGEROUS",
        binding(row),
        false,
      );
      return {
        ok: true,
        name: String(sanitize(row.name)).slice(0, 200),
        action,
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
  ): Promise<NativeSkillModeResult> {
    if (
      !validId(id) ||
      !/^settings-native:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const pending = this.confirmations.peek(sessionId);
    if (
      !pending ||
      pending.tool !== "native_skill_mode" ||
      pending.args.id !== id ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false,
        error:
          "Deze bevestiging staat niet meer open. Kies de wijziging opnieuw.",
      };
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false,
        error: "Bevestiging verlopen. Kies de wijziging opnieuw.",
      };
    if (this.inFlight.has(id))
      return {
        ok: false,
        error:
          "Deze skill wordt al gewijzigd. Kies de wijziging opnieuw zodra die klaar is.",
      };
    this.inFlight.add(id);
    try {
      let before: Row;
      try {
        before = this.row(id);
        if (
          revision(before) !== action.args.revision ||
          !validMode(action.args.mode)
        )
          return {
            ok: false,
            error:
              "De skill is ondertussen gewijzigd. Kies de wijziging opnieuw.",
          };
        this.audit.record({
          sessionId: "settings",
          tool: "native_skill_mode",
          risk: action.risk,
          confirmation: "confirmed_admin_ui",
          phase: "before_execute",
          arguments: { id, mode: action.args.mode },
        });
      } catch {
        return { ok: false, error: unavailable };
      }
      const mode = action.args.mode as NativeSkillMode;
      try {
        await this.management.request(`/api/skills/${id}`, {
          method: "PUT",
          body: { mode },
        });
        const after = this.row(id);
        if (
          binding(after) !== binding(before) ||
          after.mode !== mode ||
          after.enabled !== (mode === "off" ? 0 : 1)
        )
          throw new Error("Persistence not verified");
        const result: NativeSkillModeResult = {
          ok: true,
          verified: true,
          mode,
          enabled: after.enabled === 1,
        };
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "native_skill_mode",
            risk: action.risk,
            confirmation: "confirmed_admin_ui",
            phase: "after_execute",
            arguments: { id, mode },
            result: { ok: true },
            verification: { persisted: true, runtimeMayBeCached: true },
          });
        } catch {
          result.auditWarning =
            "Opgeslagen en gecontroleerd; de afronding kon niet in het actielog worden geschreven.";
        }
        return result;
      } catch {
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "native_skill_mode",
            risk: action.risk,
            confirmation: "confirmed_admin_ui",
            phase: "after_execute",
            arguments: { id, mode },
            result: { ok: false },
            verification: { persisted: null },
          });
        } catch {
          /* Pre-execution audit remains available. */
        }
        return {
          ok: false,
          verified: null,
          error:
            "De opgeslagen wijziging kon niet worden gecontroleerd. Laad het overzicht opnieuw voordat je verdergaat.",
        };
      }
    } finally {
      this.inFlight.delete(id);
    }
  }
}
