import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  NativeSkillRemovalPrepared,
  NativeSkillRemovalResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { claimConfirmation } from "./confirmation-step.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { ValidationError } from "../core/errors/validation.error.js";

type Skill = {
  id: string;
  api_key_id: string;
  name: string;
  handler: string;
  schema: string;
  mode: string;
  enabled: number;
  updated_at: string;
};
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const binding = (row: Skill) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        row.id,
        row.api_key_id,
        row.name,
        row.handler,
        row.schema,
      ]),
    )
    .digest("hex");
const revision = (row: Skill) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify([binding(row), row.mode, row.enabled, row.updated_at]),
    )
    .digest("hex");
const unavailable =
  "Skillbeheer is niet beschikbaar. Controleer de OmniRoute-koppeling.";

@Injectable()
export class NativeSkillRemoval {
  private readonly inFlight = new Set<string>();
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
  ) {}

  private row(id: string): Skill | undefined {
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
          "SELECT id,api_key_id,name,handler,schema,mode,enabled,updated_at FROM skills WHERE id=?",
        )
        .get(id) as Skill | undefined;
    } finally {
      db.close();
    }
  }

  prepare(id: string): NativeSkillRemovalPrepared {
    if (!validId(id)) throw new ValidationError(["Kies een geldige skill."]);
    try {
      const row = this.row(id);
      if (!row || row.api_key_id !== this.management.scope)
        return {
          ok: false,
          error: "Alleen een eigen NOVA-skill kan hier worden verwijderd.",
        };
      this.audit.record({
        sessionId: "settings",
        tool: "native_skill_remove",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: { id },
      });
      const action = this.confirmations.create(
        `settings-native-remove:${crypto.randomUUID()}`,
        "native_skill_remove",
        { id, revision: revision(row) },
        "DANGEROUS",
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
  ): Promise<NativeSkillRemovalResult> {
    if (
      !validId(id) ||
      !/^settings-native-remove:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const claimed = claimConfirmation(
      this.confirmations,
      sessionId,
      confirmationId,
      approve,
      {
        tool: "native_skill_remove",
        arg: { name: "id", value: id },
        stale: "Deze bevestiging staat niet meer open. Kies opnieuw.",
        expired: "Bevestiging verlopen. Kies opnieuw.",
      },
    );
    if ("reply" in claimed) return claimed.reply;
    const action = claimed.action;
    if (this.inFlight.has(id))
      return {
        ok: false,
        error: "Deze skill wordt al gewijzigd. Probeer het later opnieuw.",
      };
    this.inFlight.add(id);
    try {
      const before = this.row(id);
      if (
        !before ||
        before.api_key_id !== this.management.scope ||
        revision(before) !== action.args.revision
      )
        return {
          ok: false,
          error:
            "De skill is ondertussen gewijzigd of niet meer van NOVA. Laad het overzicht opnieuw.",
        };
      this.audit.record({
        sessionId: "settings",
        tool: "native_skill_remove",
        risk: "DANGEROUS",
        confirmation: "confirmed_admin_ui",
        phase: "before_execute",
        arguments: { id },
      });
      try {
        await this.management.request(`/api/skills/${id}`, {
          method: "DELETE",
        });
        if (this.row(id)) throw new Error("Skill row remains");
        let auditWarning: string | undefined;
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "native_skill_remove",
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "after_execute",
            arguments: { id },
            result: { ok: true },
            verification: { persisted: true, runtimeMayBeCached: true },
          });
        } catch {
          auditWarning =
            "Verwijderd en gecontroleerd; de afronding kon niet in het actielog worden geschreven.";
        }
        return { ok: true, verified: true, auditWarning };
      } catch {
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "native_skill_remove",
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "after_execute",
            arguments: { id },
            result: { ok: false },
            verification: { persisted: null },
          });
        } catch {
          /* Keep pre-execution audit. */
        }
        return {
          ok: false,
          verified: null,
          error:
            "Verwijderen kon niet onafhankelijk worden bevestigd. Laad het overzicht opnieuw voordat je verdergaat.",
        };
      }
    } catch {
      return { ok: false, verified: null, error: unavailable };
    } finally {
      this.inFlight.delete(id);
    }
  }
}
