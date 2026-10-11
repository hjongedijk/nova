import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { ConfirmationsService } from "../../confirmations/confirmations.service.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { ValidationError } from "../../core/errors/validation.error.js";
import { ServiceConnectionsStore } from "./service-connections.store.js";

type Draft = { sessionId: string; revision: string; expiresAt: number };
const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One-time DANGEROUS confirmation boundary for restoring public connection fields. */
@Injectable()
export class ServiceConnectionsHistory {
  private readonly drafts = new Map<string, Draft>();

  constructor(
    private readonly store: ServiceConnectionsStore,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
  ) {}

  private publicState(service: string) {
    const connection = this.store.list().find((item) => item.id === service);
    if (!connection)
      throw new ValidationError(["Deze koppeling bestaat niet meer."]);
    return connection.fields
      .filter((field) => field.kind !== "secret")
      .map(({ key, value }) => [key, value]);
  }

  prepareRollback(id: string) {
    for (const [confirmationId, draft] of this.drafts) {
      const pending = this.confirmations.peek(draft.sessionId);
      if (!pending || pending.expiresAt <= Date.now())
        this.drafts.delete(confirmationId);
    }
    if (this.drafts.size >= 20)
      return {
        ok: false as const,
        error: "Wacht tot een open bevestiging verloopt.",
      };
    const revision = this.store.history().find((row) => row.id === id);
    if (!revision)
      throw new ValidationError(["Deze wijziging is niet meer beschikbaar."]);
    if (revision.secretChanges.length)
      throw new ValidationError([
        "Geheime waarden staan niet in de geschiedenis. Vul de gewenste waarde opnieuw in.",
      ]);
    const current = this.publicState(revision.service);
    const currentDigest = digest(current);
    const sessionId = `settings-service-history:${crypto.randomUUID()}`;
    const action = this.confirmations.create(
      sessionId,
      "settings_service_connection_rollback",
      { revision: id, current: currentDigest },
      "DANGEROUS",
      currentDigest,
      false,
    );
    try {
      this.audit.record({
        sessionId,
        tool: "settings_service_connection_rollback",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: { service: revision.service, revision: id },
      });
    } catch {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return {
        ok: false as const,
        error: "Auditlog niet beschikbaar; herstel gestopt.",
      };
    }
    this.drafts.set(action.confirmationId, {
      sessionId,
      revision: id,
      expiresAt: action.expiresAt,
    });
    return {
      ok: true as const,
      warning:
        "Terugzetten wijzigt de opgeslagen bestemming of opties van deze koppeling.",
      action,
    };
  }

  confirm(sessionId: string, confirmationId: string, approve: boolean) {
    const draft = this.drafts.get(confirmationId);
    const pending = this.confirmations.peek(sessionId);
    if (
      !draft ||
      draft.sessionId !== sessionId ||
      draft.expiresAt <= Date.now() ||
      pending?.confirmationId !== confirmationId
    )
      return {
        ok: false as const,
        error: "Bevestiging verlopen. Kies opnieuw.",
      };
    this.drafts.delete(confirmationId);
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true as const, cancelled: true as const };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false as const,
        error: "Bevestiging verlopen. Kies opnieuw.",
      };
    const revision = this.store
      .history()
      .find((row) => row.id === draft.revision);
    if (
      !revision ||
      action.args.current !== digest(this.publicState(revision.service))
    )
      return {
        ok: false as const,
        error: "De koppeling is intussen gewijzigd. Kies de wijziging opnieuw.",
      };
    if (revision.secretChanges.length)
      return {
        ok: false as const,
        error:
          "Geheime waarden staan niet in de geschiedenis en kunnen niet worden teruggezet.",
      };
    this.audit.record({
      sessionId,
      tool: "settings_service_connection_rollback",
      risk: "DANGEROUS",
      confirmation: "approved_admin_ui",
      arguments: { service: revision.service, revision: revision.id },
      phase: "attempt",
    });
    const services = this.store.rollback(revision.id);
    try {
      this.audit.record({
        sessionId,
        tool: "settings_service_connection_rollback",
        risk: "DANGEROUS",
        confirmation: "confirmed_admin_ui",
        arguments: { service: revision.service, revision: revision.id },
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
