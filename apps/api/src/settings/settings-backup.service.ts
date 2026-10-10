import {
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  SettingsImportPrepared,
  SettingsImportResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { JarvisStateStore } from "../planning/jarvis-state.store.js";
import { buildBackupPlan, normalizeBackupLists } from "./backup-plan.js";
import { SettingsStore, type NovaSettings } from "./store/settings.store.js";

const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Draft = {
  sessionId: string;
  expiresAt: number;
  revision: string;
  next: NovaSettings;
  nextLists: Record<string, { id: string; text: string; addedAt: string }[]>;
  summary: SettingsImportPrepared["summary"];
};
type ImportJournal = {
  version: 1;
  previousSettings: NovaSettings;
  previousLists: Record<
    string,
    { id: string; text: string; addedAt: string }[]
  >;
  digest: string;
};

/** Private, bounded import candidates; public confirmations contain counts only. */
@Injectable()
export class SettingsBackupService implements OnModuleInit, OnModuleDestroy {
  private readonly drafts = new Map<string, Draft>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly settings: SettingsStore,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
    @Optional() private readonly planning?: JarvisStateStore,
    @Optional() config?: NovaConfig,
  ) {
    this.journal = config?.dataFile("settings-import-transaction.json");
  }
  private readonly journal?: string;

  onModuleInit(): void {
    this.recoverImport();
  }

  private writeJournal(
    previousSettings: NovaSettings,
    previousLists: ImportJournal["previousLists"],
  ): void {
    if (!this.journal) throw new Error("Settings import journal unavailable");
    const payload = { previousSettings, previousLists };
    const journal: ImportJournal = {
      version: 1,
      ...payload,
      digest: digest(payload),
    };
    fs.mkdirSync(path.dirname(this.journal), { recursive: true });
    const temporary = `${this.journal}.${process.pid}.tmp`;
    let fd: number | undefined;
    try {
      fs.writeFileSync(temporary, JSON.stringify(journal), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fd = fs.openSync(temporary, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.journal);
      const directory = fs.openSync(path.dirname(this.journal), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }

  private clearJournal(): void {
    if (!this.journal) throw new Error("Settings import journal unavailable");
    fs.rmSync(this.journal, { force: true });
    const directory = fs.openSync(path.dirname(this.journal), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }

  private recoverImport(): void {
    if (!this.journal || !fs.existsSync(this.journal)) return;
    if (!this.planning)
      throw new Error("Cannot recover settings import without list store");
    let journal: ImportJournal;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.journal, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error();
      const row = raw as Partial<ImportJournal>;
      const payload = {
        previousSettings: row.previousSettings,
        previousLists: row.previousLists,
      };
      if (
        row.version !== 1 ||
        typeof row.digest !== "string" ||
        digest(payload) !== row.digest ||
        !payload.previousSettings ||
        typeof payload.previousSettings !== "object" ||
        !payload.previousLists ||
        typeof payload.previousLists !== "object" ||
        Array.isArray(payload.previousLists)
      )
        throw new Error();
      journal = row as ImportJournal;
    } catch {
      throw new Error(
        "Settings import recovery journal is invalid; refusing startup",
      );
    }
    this.planning.replaceLists(journal.previousLists);
    this.settings.update((next) =>
      Object.assign(next, structuredClone(journal.previousSettings)),
    );
    fs.rmSync(this.journal, { force: false });
    const directory = fs.openSync(path.dirname(this.journal), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }
  exportLists() {
    return normalizeBackupLists(this.planning?.getListsSnapshot() ?? {});
  }
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
    const currentLists = this.planning?.getListsSnapshot() ?? {};
    const plan = buildBackupPlan(value.data, value.mode, current, currentLists);
    const metadata = {
      mode: plan.summary.mode,
      incomingSkills: plan.summary.incomingSkills,
      incomingWidgets: plan.summary.incomingWidgets,
      removedSkills: plan.summary.removedSkills,
      removedWidgets: plan.summary.removedWidgets,
      incomingLists: plan.summary.incomingLists,
      totalLists: plan.summary.totalLists,
      removedLists: plan.summary.removedLists,
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
      revision: digest({ settings: current, lists: currentLists }),
      next: plan.next,
      nextLists: plan.nextLists,
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
      return {
        ok: true,
        cancelled: true,
        imported: 0,
        importedLists: 0,
        missingSecrets: [],
      };
    }
    if (!this.confirmations.take(sessionId, confirmationId))
      return {
        ok: false,
        error: "Toestemming verlopen. Controleer de back-up opnieuw.",
      };
    const currentLists = this.planning?.getListsSnapshot() ?? {};
    if (
      digest({ settings: this.settings.get(), lists: currentLists }) !==
      draft.revision
    )
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
    const previousSettings = this.settings.get();
    try {
      if (draft.summary.listsChanged && !this.planning)
        throw new Error("List store unavailable");
      this.writeJournal(previousSettings, currentLists);
      this.settings.update((next) => {
        if (digest(next) !== digest(previousSettings))
          throw new Error("Settings changed before import");
        Object.assign(next, structuredClone(draft.next));
      });
      if (this.planning && draft.summary.listsChanged) {
        this.planning.replaceLists(draft.nextLists);
      }
      this.clearJournal();
    } catch {
      let rollbackFailed = false;
      try {
        const current = this.settings.get();
        const lists = this.planning?.getListsSnapshot() ?? {};
        if (
          digest(current) !== digest(previousSettings) &&
          digest(lists) === digest(currentLists)
        ) {
          // The guarded settings update failed before either store was changed.
          // Keep the concurrent settings write and discard the unused journal.
          this.clearJournal();
        } else {
          this.recoverImport();
        }
      } catch {
        rollbackFailed = true;
      }
      return {
        ok: false,
        error: rollbackFailed
          ? "Import is mogelijk gedeeltelijk opgeslagen; automatisch herstel is nog niet klaar. Herstart NOVA om herstel opnieuw uit te voeren en controleer daarna je instellingen."
          : "Import kon niet volledig worden opgeslagen; de vorige instellingen en lijsten zijn hersteld. Controleer je instellingen voordat je opnieuw probeert.",
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
        result: {
          ok: true,
          imported: draft.summary.incomingSkills,
          importedLists: draft.summary.incomingLists,
        },
      });
    } catch {
      auditWarning =
        "Instellingen opgeslagen, maar het resultaat kon niet in het auditlog worden vastgelegd.";
    }
    return {
      ok: true,
      imported: draft.summary.incomingSkills,
      importedLists: draft.summary.incomingLists,
      missingSecrets: draft.summary.missingSecrets,
      ...(auditWarning ? { auditWarning } : {}),
    };
  }
}
