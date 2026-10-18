import { Injectable } from "@nestjs/common";
import { DatabaseSync } from "node:sqlite";
import type { NativeSkillRemovalResult } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
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
const unavailable =
  "Skillbeheer is niet beschikbaar. Controleer de OmniRoute-koppeling.";

@Injectable()
export class NativeSkillRemoval {
  private readonly inFlight = new Set<string>();
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
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

  /** Removes one NOVA-owned skill immediately. */
  async remove(id: string): Promise<NativeSkillRemovalResult> {
    if (!validId(id)) throw new ValidationError(["Kies een geldige skill."]);
    if (this.inFlight.has(id))
      return {
        ok: false,
        error: "Deze skill wordt al gewijzigd. Probeer het later opnieuw.",
      };
    this.inFlight.add(id);
    try {
      const before = this.row(id);
      if (!before || before.api_key_id !== this.management.scope)
        return {
          ok: false,
          error: "Alleen een eigen NOVA-skill kan hier worden verwijderd.",
        };
      const name = String(sanitize(before.name)).slice(0, 200);
      this.audit.record({
        sessionId: "settings",
        tool: "native_skill_remove",
        risk: "DANGEROUS",
        confirmation: "direct",
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
            confirmation: "direct",
            phase: "after_execute",
            arguments: { id },
            result: { ok: true },
            verification: { persisted: true, runtimeMayBeCached: true },
          });
        } catch {
          auditWarning =
            "Verwijderd en gecontroleerd; de afronding kon niet in het actielog worden geschreven.";
        }
        return { ok: true, verified: true, name, auditWarning };
      } catch {
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "native_skill_remove",
            risk: "DANGEROUS",
            confirmation: "direct",
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
