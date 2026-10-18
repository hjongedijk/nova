import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { AuditService } from "../../core/audit/audit.service.js";
import { ValidationError } from "../../core/errors/validation.error.js";
import { ServiceConnectionsStore } from "./service-connections.store.js";

/** Restores public connection fields from history in one step. */
@Injectable()
export class ServiceConnectionsHistory {
  constructor(
    private readonly store: ServiceConnectionsStore,
    private readonly audit: AuditService,
  ) {}

  rollback(id: string) {
    const revision = this.store.history().find((row) => row.id === id);
    if (!revision)
      throw new ValidationError(["Deze wijziging is niet meer beschikbaar."]);
    if (revision.secretChanges.length)
      throw new ValidationError([
        "Geheime waarden staan niet in de geschiedenis. Vul de gewenste waarde opnieuw in.",
      ]);
    if (!this.store.list().some((item) => item.id === revision.service))
      throw new ValidationError(["Deze koppeling bestaat niet meer."]);
    const sessionId = `settings-service-history:${crypto.randomUUID()}`;
    const args = { service: revision.service, revision: revision.id };
    try {
      this.audit.record({
        sessionId,
        tool: "settings_service_connection_rollback",
        risk: "DANGEROUS",
        confirmation: "direct",
        arguments: args,
        phase: "attempt",
      });
    } catch {
      return {
        ok: false as const,
        error: "Auditlog niet beschikbaar; herstel gestopt.",
      };
    }
    const services = this.store.rollback(revision.id);
    try {
      this.audit.record({
        sessionId,
        tool: "settings_service_connection_rollback",
        risk: "DANGEROUS",
        confirmation: "direct",
        arguments: args,
        result: { ok: true },
        phase: "verified",
      });
    } catch {
      this.store.auditWarning =
        "De koppeling is teruggezet, maar de resultaatmelding kon niet worden geauditeerd.";
    }
    return {
      ok: true as const,
      services,
      ...(this.store.auditWarning
        ? { auditWarning: this.store.auditWarning }
        : {}),
    };
  }
}
