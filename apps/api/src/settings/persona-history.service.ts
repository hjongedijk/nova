import { Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import type { PersonaHistory, PersonaRevision } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, revertedFromField } from "./history-file.js";
import { sanitize } from "../core/security/sanitize.js";
import { SettingsStore } from "./store/settings.store.js";

const MAX_PERSONA_LENGTH = 2000;
const normalize = (value: unknown): string =>
  typeof value === "string" && value.length <= MAX_PERSONA_LENGTH
    ? sanitize(value)
    : "";

/** Private, bounded snapshots of user-authored behavior rules. */
@Injectable()
export class PersonaHistoryService {
  lastWarning: string | undefined;
  private readonly history: HistoryFile<PersonaRevision>;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<PersonaRevision>(
      config.dataFile("persona-history.json"),
      (row) =>
        typeof row.before === "string" &&
        row.before.length <= MAX_PERSONA_LENGTH &&
        typeof row.after === "string" &&
        row.after.length <= MAX_PERSONA_LENGTH
          ? {
              before: row.before,
              after: row.after,
              ...revertedFromField(row, false),
            }
          : undefined,
      { durability: "dir" },
    );
  }

  list(): PersonaHistory {
    return this.history.list();
  }

  record(beforeValue: string, afterValue: string, revertedFrom?: string): void {
    this.lastWarning = undefined;
    const before = normalize(beforeValue);
    const after = normalize(afterValue);
    if (isDeepStrictEqual(before, after)) return;
    const revision: PersonaRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before,
      after,
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    try {
      this.history.append(revision);
    } catch {
      this.lastWarning =
        "Eigen regels opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
      return;
    }
  }

  rollback(id: string): {
    ok: true;
    persona: string;
    auditWarning?: string;
  } {
    const revision = this.history.all().find((entry) => entry.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = normalize(this.settings.get().persona);
    if (!isDeepStrictEqual(current, revision.after))
      throw new NotFoundException(
        "De eigen regels zijn daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { what: "persona_rollback", revision: id },
      phase: "attempt",
    });
    this.settings.update((next) => {
      if (!isDeepStrictEqual(normalize(next.persona), revision.after))
        throw new NotFoundException(
          "De eigen regels zijn intussen gewijzigd. Terugdraaien is afgebroken.",
        );
      next.persona = revision.before;
    });
    this.record(current, revision.before, id);
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: { what: "persona_rollback", revision: id },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Eigen regels zijn teruggedraaid, maar de auditmelding kon niet worden geschreven.";
    }
    return {
      ok: true,
      persona: revision.before,
      ...(this.lastWarning ? { auditWarning: this.lastWarning } : {}),
    };
  }
}
