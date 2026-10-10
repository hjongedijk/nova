import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import crypto from "node:crypto";
import type {
  SettingsImportPrepared,
  SettingsImportResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { buildBackupPlan } from "./backup-plan.js";
import { SettingsStore, type NovaSettings } from "./store/settings.store.js";

const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Draft = {
  sessionId: string;
  expiresAt: number;
  revision: string;
  next: NovaSettings;
  summary: SettingsImportPrepared["summary"];
};

/** Private, bounded import candidates; public confirmations contain counts only. */
@Injectable()
export class SettingsBackupService implements OnModuleDestroy {
  private readonly drafts = new Map<string, Draft>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly settings: SettingsStore,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
  ) {}
  private drop(id: string): void {
    this.drafts.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }
  onModuleDestroy(): void {
    for (const id of this.drafts.keys()) this.drop(id);
  }
  prepare(body: unknown): SettingsImportPrepared {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige importaanvraag."]);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !["data", "mode", "acknowledgeEffects"].includes(key),
      ) ||
      value.acknowledgeEffects !== true
    )
      throw new ValidationError([
        "Bevestig dat deze import je instellingen en vaardigheden wijzigt.",
      ]);
    for (const [id, draft] of this.drafts)
      if (draft.expiresAt <= this.confirmations.now()) this.drop(id);
    if (this.drafts.size >= 20)
      throw new ValidationError([
        "Te veel imports staan open. Annuleer of wacht tot ze verlopen.",
      ]);
    const current = this.settings.get();
    const plan = buildBackupPlan(value.data, value.mode, current);
    const metadata = {
      mode: plan.summary.mode,
      incomingSkills: plan.summary.incomingSkills,
      incomingWidgets: plan.summary.incomingWidgets,
      removedSkills: plan.summary.removedSkills,
      removedWidgets: plan.summary.removedWidgets,
    };
    this.audit.record({
      sessionId: "settings",
      tool: "settings_import",
      risk: "DANGEROUS",
      confirmation: "pending_admin_ui",
      arguments: metadata,
    });
    const action = this.confirmations.create(
      `settings-import:${crypto.randomUUID()}`,
      "settings_import",
      metadata,
      "DANGEROUS",
      undefined,
      false,
    );
    this.drafts.set(action.confirmationId, {
      sessionId: action.sessionId,
      expiresAt: action.expiresAt,
      revision: digest(current),
      next: plan.next,
      summary: plan.summary,
    });
    const timer = setTimeout(
      () => this.drop(action.confirmationId),
      Math.max(0, action.expiresAt - this.confirmations.now()),
    );
    timer.unref();
    this.timers.set(action.confirmationId, timer);
    return { ok: true, summary: structuredClone(plan.summary), action };
  }
  confirm(body: unknown): SettingsImportResult {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError([
        "Controleer de back-up eerst en bevestig daarna de import.",
      ]);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !["sessionId", "confirmationId", "approve"].includes(key),
      ) ||
      typeof value.sessionId !== "string" ||
      !/^settings-import:[0-9a-f-]{36}$/i.test(value.sessionId) ||
      typeof value.confirmationId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.confirmationId) ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError([
        "Controleer de back-up eerst en bevestig daarna de import.",
      ]);
    const { sessionId, confirmationId, approve } = value as {
      sessionId: string;
      confirmationId: string;
      approve: boolean;
    };
    const draft = this.drafts.get(confirmationId);
    const pending = this.confirmations.peek(sessionId);
    if (
      !draft ||
      draft.sessionId !== sessionId ||
      pending?.confirmationId !== confirmationId
    )
      return {
        ok: false,
        error:
          "Importbevestiging bestaat niet meer. Controleer de back-up opnieuw.",
      };
    this.drop(confirmationId);
    if (!approve) {
      this.confirmations.cancel(sessionId);
      return { ok: true, cancelled: true, imported: 0, missingSecrets: [] };
    }
    if (!this.confirmations.take(sessionId, confirmationId))
      return {
        ok: false,
        error: "Toestemming verlopen. Controleer de back-up opnieuw.",
      };
    if (digest(this.settings.get()) !== draft.revision)
      return {
        ok: false,
        error:
          "Instellingen zijn intussen gewijzigd. Controleer de back-up opnieuw.",
      };
    try {
      this.audit.record({
        sessionId,
        tool: "settings_import",
        risk: "DANGEROUS",
        confirmation: "approved_admin_ui",
        arguments: pending.args,
      });
    } catch {
      return {
        ok: false,
        error: "Import niet uitgevoerd: het auditlog is niet beschikbaar.",
      };
    }
    try {
      this.settings.update((next) => {
        if (digest(next) !== draft.revision)
          throw new Error("Settings changed before import");
        Object.assign(next, structuredClone(draft.next));
      });
    } catch {
      return {
        ok: false,
        error:
          "Import kon niet worden opgeslagen. Controleer je instellingen voordat je opnieuw probeert.",
      };
    }
    let auditWarning: string | undefined;
    try {
      this.audit.record({
        sessionId,
        tool: "settings_import",
        risk: "DANGEROUS",
        confirmation: "confirmed_admin_ui",
        arguments: pending.args,
        result: { ok: true, imported: draft.summary.incomingSkills },
      });
    } catch {
      auditWarning =
        "Instellingen opgeslagen, maar het resultaat kon niet in het auditlog worden vastgelegd.";
    }
    return {
      ok: true,
      imported: draft.summary.incomingSkills,
      missingSecrets: draft.summary.missingSecrets,
      ...(auditWarning ? { auditWarning } : {}),
    };
  }
}
