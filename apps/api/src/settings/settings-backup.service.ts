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
import {
  ServiceConnectionsStore,
  type BackupConnections,
} from "./services/service-connections.store.js";
import type { ConnectionFile } from "../core/config/service-connections.js";
import { SettingsStore, type NovaSettings } from "./store/settings.store.js";
import {
  NodeRedManagement,
  type NodeRedFlowSnapshot,
} from "./node-red-management.service.js";

const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Draft = {
  sessionId: string;
  expiresAt: number;
  revision: string;
  next: NovaSettings;
  nextLists: Record<string, { id: string; text: string; addedAt: string }[]>;
  nextConnections?: ConnectionFile;
  nodeRedRevision?: string;
  previousNodeRedFlows?: Record<string, unknown>[];
  nextNodeRedFlows?: Record<string, unknown>[];
  summary: SettingsImportPrepared["summary"];
};
type ImportJournalV1 = {
  version: 1;
  previousSettings: NovaSettings;
  previousLists: Record<
    string,
    { id: string; text: string; addedAt: string }[]
  >;
  digest: string;
};
type ImportJournal = {
  version: 2 | 3;
  previousSettings: NovaSettings;
  previousLists: ImportJournalV1["previousLists"];
  previousConnections?: ConnectionFile;
  previousNodeRedFlows?: Record<string, unknown>[];
  targetNodeRedFlows?: Record<string, unknown>[];
  nodeRedRevision?: string;
  digest: string;
};

/** Private, bounded import candidates; public confirmations contain counts only. */
@Injectable()
export class SettingsBackupService implements OnModuleInit, OnModuleDestroy {
  private readonly drafts = new Map<string, Draft>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private nodeRedImportInProgress = false;
  constructor(
    private readonly settings: SettingsStore,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
    @Optional() private readonly planning?: JarvisStateStore,
    @Optional() private readonly connections?: ServiceConnectionsStore,
    @Optional() config?: NovaConfig,
    @Optional() private readonly nodeRed?: NodeRedManagement,
  ) {
    this.journal = config?.dataFile("settings-import-transaction.json");
  }
  private readonly journal?: string;

  async onModuleInit(): Promise<void> {
    await this.recoverNodeRedImport();
    this.recoverImport();
  }

  private writeJournal(
    previousSettings: NovaSettings,
    previousLists: ImportJournal["previousLists"],
    previousConnections?: ConnectionFile,
    nodeRed?: Pick<
      ImportJournal,
      "previousNodeRedFlows" | "targetNodeRedFlows" | "nodeRedRevision"
    >,
  ): void {
    if (!this.journal) throw new Error("Settings import journal unavailable");
    const payload = {
      previousSettings,
      previousLists,
      ...(previousConnections ? { previousConnections } : {}),
      ...(nodeRed ?? {}),
    };
    const journal: ImportJournal = {
      version: nodeRed ? 3 : 2,
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
      const row = raw as Partial<ImportJournal> & Partial<ImportJournalV1>;
      const payload = {
        previousSettings: row.previousSettings,
        previousLists: row.previousLists,
        ...(row.version === 2 && row.previousConnections
          ? { previousConnections: row.previousConnections }
          : {}),
      };
      if (
        (row.version !== 1 && row.version !== 2) ||
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
    if (journal.version === 2 && journal.previousConnections) {
      if (!this.connections)
        throw new Error("Cannot recover service connections without store");
      this.connections.restoreSnapshot(journal.previousConnections);
    }
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

  private async recoverNodeRedImport(): Promise<void> {
    if (!this.journal || !fs.existsSync(this.journal)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.journal, "utf8"));
    } catch {
      return; // recoverImport reports the invalid journal consistently.
    }
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      (raw as { version?: unknown }).version !== 3
    )
      return;
    const row = raw as Partial<ImportJournal>;
    const payload = {
      previousSettings: row.previousSettings,
      previousLists: row.previousLists,
      ...(row.previousConnections
        ? { previousConnections: row.previousConnections }
        : {}),
      previousNodeRedFlows: row.previousNodeRedFlows,
      targetNodeRedFlows: row.targetNodeRedFlows,
      nodeRedRevision: row.nodeRedRevision,
    };
    if (
      typeof row.digest !== "string" ||
      digest(payload) !== row.digest ||
      !Array.isArray(row.previousNodeRedFlows) ||
      !Array.isArray(row.targetNodeRedFlows) ||
      typeof row.nodeRedRevision !== "string" ||
      !row.previousSettings ||
      !row.previousLists
    )
      throw new Error(
        "Settings import recovery journal is invalid; refusing startup",
      );
    if (!this.nodeRed)
      throw new Error(
        "Cannot recover interrupted Node-RED import without Node-RED access",
      );
    const snapshot = await this.nodeRed.flowSnapshot();
    if (
      JSON.stringify(snapshot.flows) === JSON.stringify(row.targetNodeRedFlows)
    ) {
      const rollback = await this.nodeRed.writeFlowSnapshot(
        snapshot.revision,
        row.previousNodeRedFlows,
      );
      if (!rollback.ok)
        throw new Error(
          "Cannot restore interrupted Node-RED import; refusing startup",
        );
    } else if (
      JSON.stringify(snapshot.flows) !==
      JSON.stringify(row.previousNodeRedFlows)
    ) {
      throw new Error(
        "Node-RED changed after interrupted import; refusing automatic recovery",
      );
    }
    this.writeJournal(
      row.previousSettings as NovaSettings,
      row.previousLists as ImportJournal["previousLists"],
      row.previousConnections,
      undefined,
    );
  }
  exportLists() {
    return normalizeBackupLists(this.planning?.getListsSnapshot() ?? {});
  }
  exportConnections(): BackupConnections {
    return this.connections?.backupValues() ?? {};
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
    return this.prepareInternal(body);
  }

  prepareWithNodeRed(
    body: unknown,
    snapshot: NodeRedFlowSnapshot,
  ): SettingsImportPrepared {
    return this.prepareInternal(body, snapshot);
  }

  private prepareInternal(
    body: unknown,
    nodeRedSnapshot?: NodeRedFlowSnapshot,
  ): SettingsImportPrepared {
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
    const currentConnections = this.connections?.snapshot();
    const plan = buildBackupPlan(
      value.data,
      value.mode,
      current,
      currentLists,
      nodeRedSnapshot?.flows ?? [],
    );
    const backup = value.data as Record<string, unknown>;
    let nextConnections: ConnectionFile | undefined;
    if (Object.hasOwn(backup, "connections")) {
      if (!this.connections || !currentConnections)
        throw new ValidationError([
          "Servicekoppelingen kunnen hier niet veilig worden hersteld.",
        ]);
      const connectionPlan = this.connections.prepareBackup(
        backup.connections,
        value.mode as "merge" | "replace",
      );
      nextConnections = connectionPlan.next;
      plan.summary.connectionsChanged = connectionPlan.changes.length > 0;
      plan.summary.changedConnections = connectionPlan.changes.length;
      plan.summary.connectionChanges = connectionPlan.changes;
    }
    const metadata = {
      mode: plan.summary.mode,
      incomingSkills: plan.summary.incomingSkills,
      incomingWidgets: plan.summary.incomingWidgets,
      removedSkills: plan.summary.removedSkills,
      removedWidgets: plan.summary.removedWidgets,
      incomingLists: plan.summary.incomingLists,
      totalLists: plan.summary.totalLists,
      removedLists: plan.summary.removedLists,
      changedConnections: plan.summary.changedConnections,
      modelRolesChanged: plan.summary.modelRolesChanged,
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
      revision: digest({
        settings: current,
        lists: currentLists,
        connections: currentConnections,
      }),
      next: plan.next,
      nextLists: plan.nextLists,
      ...(nextConnections ? { nextConnections } : {}),
      ...(nodeRedSnapshot && Object.hasOwn(backup, "nodeRedFlows")
        ? {
            nodeRedRevision: nodeRedSnapshot.revision,
            previousNodeRedFlows: structuredClone(nodeRedSnapshot.flows),
            nextNodeRedFlows: structuredClone(plan.nextNodeRedFlows),
          }
        : {}),
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
  confirm(body: unknown, flowCommit = false): SettingsImportResult {
    if (this.nodeRedImportInProgress && !flowCommit)
      return {
        ok: false,
        error: "Een andere import wordt verwerkt. Probeer opnieuw.",
      };
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
        importedFlows: 0,
        changedConnections: 0,
        missingSecrets: [],
      };
    }
    if (!this.confirmations.take(sessionId, confirmationId))
      return {
        ok: false,
        error: "Toestemming verlopen. Controleer de back-up opnieuw.",
      };
    const currentLists = this.planning?.getListsSnapshot() ?? {};
    const currentConnections = this.connections?.snapshot();
    if (
      digest({
        settings: this.settings.get(),
        lists: currentLists,
        connections: currentConnections,
      }) !== draft.revision
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
    const previousConnections = this.connections?.snapshot();
    let settingsRevisionConflict = false;
    try {
      if (draft.summary.listsChanged && !this.planning)
        throw new Error("List store unavailable");
      this.writeJournal(
        previousSettings,
        currentLists,
        previousConnections,
        draft.nodeRedRevision &&
          draft.previousNodeRedFlows &&
          draft.nextNodeRedFlows
          ? {
              previousNodeRedFlows: draft.previousNodeRedFlows,
              targetNodeRedFlows: draft.nextNodeRedFlows,
              nodeRedRevision: draft.nodeRedRevision,
            }
          : undefined,
      );
      this.settings.update((next) => {
        if (digest(next) !== digest(previousSettings)) {
          settingsRevisionConflict = true;
          throw new Error("Settings changed before import");
        }
        Object.assign(next, structuredClone(draft.next));
      });
      if (this.planning && draft.summary.listsChanged) {
        this.planning.replaceLists(draft.nextLists);
      }
      if (draft.nextConnections && this.connections)
        this.connections.restoreSnapshot(draft.nextConnections);
      this.clearJournal();
    } catch {
      let rollbackFailed = false;
      try {
        if (settingsRevisionConflict) {
          // The settings store's in-update check caught a concurrent edit before
          // any import write. Preserve that edit and discard the unused journal.
          this.clearJournal();
        } else {
          // The journal is durable; restore all stores after any partial commit.
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
          changedConnections: draft.summary.changedConnections,
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
      importedFlows: draft.summary.incomingFlows,
      changedConnections: draft.summary.changedConnections,
      missingSecrets: draft.summary.missingSecrets,
      ...(auditWarning ? { auditWarning } : {}),
    };
  }

  async confirmWithNodeRed(body: unknown): Promise<SettingsImportResult> {
    if (!body || typeof body !== "object" || Array.isArray(body))
      return this.confirm(body);
    const value = body as Record<string, unknown>;
    const id =
      typeof value.confirmationId === "string" ? value.confirmationId : "";
    const draft = this.drafts.get(id);
    if (!draft?.nodeRedRevision || !draft.nextNodeRedFlows)
      return this.confirm(body);
    if (value.approve !== true) return this.confirm(body);
    if (
      typeof value.sessionId !== "string" ||
      draft.sessionId !== value.sessionId ||
      this.confirmations.peek(value.sessionId)?.confirmationId !== id
    )
      return this.confirm(body);
    if (!this.nodeRed)
      return { ok: false, error: "Node-RED-flowimport is niet beschikbaar." };
    if (this.nodeRedImportInProgress)
      return {
        ok: false,
        error: "Een andere import wordt verwerkt. Probeer opnieuw.",
      };
    this.nodeRedImportInProgress = true;
    try {
      const live = await this.nodeRed.flowSnapshot().catch(() => null);
      if (!live)
        return {
          ok: false,
          error:
            "Node-RED-flowrevisie kon niet worden gecontroleerd. Probeer opnieuw.",
        };
      if (live.revision !== draft.nodeRedRevision) {
        this.drop(id);
        this.confirmations.cancel(draft.sessionId);
        return {
          ok: false,
          error: "Node-RED-flows zijn gewijzigd; laad de back-up opnieuw.",
        };
      }
      const currentLists = this.planning?.getListsSnapshot() ?? {};
      const currentConnections = this.connections?.snapshot();
      const previousSettings = this.settings.get();
      this.writeJournal(previousSettings, currentLists, currentConnections, {
        previousNodeRedFlows: draft.previousNodeRedFlows!,
        targetNodeRedFlows: draft.nextNodeRedFlows,
        nodeRedRevision: draft.nodeRedRevision,
      });
      const result = await this.nodeRed.writeFlowSnapshot(
        draft.nodeRedRevision,
        draft.nextNodeRedFlows,
      );
      if (!result.ok || !result.revision) {
        if (result.error?.startsWith("Node-RED-flows zijn gewijzigd")) {
          this.clearJournal();
          this.drop(id);
          this.confirmations.cancel(draft.sessionId);
          return { ok: false, error: result.error };
        }
        try {
          await this.recoverNodeRedImport();
          this.recoverImport();
        } catch {
          return {
            ok: false,
            error:
              result.error ??
              "Flowimport is onzeker; herstel blijft vastgelegd en vereist controle.",
          };
        }
        return {
          ok: false,
          error: result.error ?? "Node-RED-flowimport is mislukt.",
        };
      }
      const committed = this.confirm(body, true);
      if (committed.ok) {
        if ("cancelled" in committed && committed.cancelled) {
          const current = await this.nodeRed.flowSnapshot();
          const rollback = await this.nodeRed.writeFlowSnapshot(
            current.revision,
            draft.previousNodeRedFlows,
          );
          if (!rollback.ok)
            return {
              ok: false,
              error:
                "Import geannuleerd, maar Node-RED-herstel is nog niet bevestigd.",
            };
        }
        return { ...committed, importedFlows: draft.summary.incomingFlows };
      }
      const current = await this.nodeRed.flowSnapshot().catch(() => null);
      const rollback = current
        ? await this.nodeRed.writeFlowSnapshot(
            current.revision,
            draft.previousNodeRedFlows,
          )
        : { ok: false };
      if (!rollback.ok)
        return {
          ok: false,
          error:
            "Lokale import mislukte en Node-RED-herstel is niet bevestigd. Controleer Node-RED voor je opnieuw importeert.",
        };
      try {
        await this.recoverNodeRedImport();
        this.recoverImport();
      } catch {
        return {
          ok: false,
          error:
            "Node-RED is hersteld, maar lokaal herstel is nog niet bevestigd. Herstart NOVA voor herstel.",
        };
      }
      return committed;
    } finally {
      this.nodeRedImportInProgress = false;
    }
  }
}
