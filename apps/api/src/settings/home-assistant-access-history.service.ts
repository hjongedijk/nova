import { Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import type { HomeAssistantAccessPolicy } from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, listRecent, revertedFromField } from "./history-file.js";
import { HomeAssistantService } from "../home/home-assistant.service.js";

type Revision = {
  id: string;
  at: string;
  before: HomeAssistantAccessPolicy;
  after: HomeAssistantAccessPolicy;
  revertedFrom?: string;
};
type Draft = { sessionId: string; revision: string; expiresAt: number };
const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fields = ["mode", "areaIds", "deviceIds", "entityIds"] as const;

/** Private bounded history for the Home Assistant access allowlist. */
@Injectable()
export class HomeAssistantAccessHistory {
  private readonly history: HistoryFile<Revision>;
  private readonly drafts = new Map<string, Draft>();
  lastWarning: string | undefined;

  constructor(
    config: NovaConfig,
    private readonly home: HomeAssistantService,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<Revision>(
      config.dataFile("home-assistant-access-history.json"),
      (row) =>
        this.valid(row.before) && this.valid(row.after)
          ? {
              before: row.before,
              after: row.after,
              ...revertedFromField(row),
            }
          : undefined,
      { durability: "dir" },
    );
  }

  private valid(value: unknown): value is HomeAssistantAccessPolicy {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const row = value as Record<string, unknown>;
    return (
      Object.keys(row).every((key) => fields.includes(key as never)) &&
      (row.mode === "all" || row.mode === "allowlist") &&
      ["areaIds", "deviceIds", "entityIds"].every(
        (key) =>
          Array.isArray(row[key]) &&
          (row[key] as unknown[]).length <= 1000 &&
          (row[key] as unknown[]).every(
            (id) => typeof id === "string" && id.length > 0 && id.length <= 255,
          ) &&
          new Set(row[key] as string[]).size === (row[key] as string[]).length,
      )
    );
  }

  record(
    before: HomeAssistantAccessPolicy,
    after: HomeAssistantAccessPolicy,
    revertedFrom?: string,
  ) {
    this.lastWarning = undefined;
    if (digest(before) === digest(after)) return;
    try {
      this.history.write([
        ...this.history.all(),
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          before,
          after,
          ...(revertedFrom ? { revertedFrom } : {}),
        },
      ]);
    } catch {
      this.lastWarning =
        "Toegang is opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
    }
  }

  list() {
    const rows = this.history.all();
    return listRecent(rows);
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
    const revision = this.history.all().find((row) => row.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = this.home.accessPolicy();
    if (digest(current) !== digest(revision.after))
      throw new NotFoundException(
        "Home Assistant-toegang is daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    const sessionId = `settings-ha-access-history:${crypto.randomUUID()}`;
    const action = this.confirmations.create(
      sessionId,
      "home_assistant_access_rollback",
      { revision: id, current: digest(current) },
      "DANGEROUS",
      digest(current),
      false,
    );
    this.audit.record({
      sessionId,
      tool: "home_assistant_access_rollback",
      risk: "DANGEROUS",
      confirmation: "pending_admin_ui",
      arguments: { revision: id },
    });
    this.drafts.set(action.confirmationId, {
      sessionId,
      revision: id,
      expiresAt: action.expiresAt,
    });
    return {
      ok: true as const,
      warning:
        "Terugzetten kan NOVA opnieuw toegang geven tot Home Assistant-apparaten.",
      action,
    };
  }

  async confirm(sessionId: string, confirmationId: string, approve: boolean) {
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
    const revision = this.history
      .all()
      .find((row) => row.id === draft.revision);
    const current = this.home.accessPolicy();
    if (
      !revision ||
      action.args.current !== digest(current) ||
      digest(current) !== digest(revision.after)
    )
      return {
        ok: false as const,
        error:
          "Home Assistant-toegang is intussen gewijzigd. Kies de wijziging opnieuw.",
      };
    try {
      await this.home.sync();
    } catch {
      return {
        ok: false as const,
        error: "Home Assistant is niet bereikbaar. Toegang is niet teruggezet.",
      };
    }
    const afterSync = this.home.accessPolicy();
    if (
      action.args.current !== digest(afterSync) ||
      digest(afterSync) !== digest(revision.after)
    )
      return {
        ok: false as const,
        error:
          "Home Assistant-toegang is intussen gewijzigd. Kies de wijziging opnieuw.",
      };
    this.audit.record({
      sessionId,
      tool: "home_assistant_access_rollback",
      risk: "DANGEROUS",
      confirmation: "approved_admin_ui",
      arguments: { revision: draft.revision },
    });
    let restored: HomeAssistantAccessPolicy;
    try {
      restored = this.home.setAccessPolicy(revision.before);
    } catch {
      return {
        ok: false as const,
        error:
          "Een eerder gekozen apparaat bestaat niet meer. Toegang is niet teruggezet.",
      };
    }
    this.record(current, restored, draft.revision);
    try {
      this.audit.record({
        sessionId,
        tool: "home_assistant_access_rollback",
        risk: "DANGEROUS",
        confirmation: "confirmed_admin_ui",
        arguments: { revision: draft.revision },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Toegang is teruggezet, maar de resultaatmelding kon niet worden geauditeerd.";
    }
    return {
      ok: true as const,
      policy: restored,
      ...(this.lastWarning ? { historyWarning: this.lastWarning } : {}),
    };
  }
}
