import { Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import type {
  HelperPreferences,
  HelperPreferenceRevision,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, revertedFromField } from "./history-file.js";
import { normalizeHelperPreferences } from "./settings-validation.js";
import { SettingsStore } from "./store/settings.store.js";

export interface HelperPreferenceMutationOrigin {
  sessionId: string;
  confirmation: "confirmed_tool";
}

const normalize = (value: unknown): HelperPreferences =>
  normalizeHelperPreferences(
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined,
  );

/** Private, bounded history for the validated secret-free helper preference shape. */
@Injectable()
export class HelperPreferencesHistory {
  lastWarning: string | undefined;
  private readonly history: HistoryFile<HelperPreferenceRevision>;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<HelperPreferenceRevision>(
      config.dataFile("helper-preferences-history.json"),
      (row) => {
        if (!row.before || !row.after) return undefined;
        try {
          return {
            before: normalize(row.before),
            after: normalize(row.after),
            ...revertedFromField(row, false),
          };
        } catch {
          return undefined;
        }
      },
      {},
    );
  }

  list(): { revisions: HelperPreferenceRevision[]; truncated: boolean } {
    const all = this.history.all();
    return { revisions: all.slice(-50).reverse(), truncated: all.length > 50 };
  }

  record(
    before: HelperPreferences,
    after: HelperPreferences,
    revertedFrom?: string,
    origin?: HelperPreferenceMutationOrigin,
  ): void {
    this.lastWarning = undefined;
    if (isDeepStrictEqual(before, after)) return;
    const revision: HelperPreferenceRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before: normalize(before),
      after: normalize(after),
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    try {
      this.history.append(revision);
    } catch {
      this.lastWarning =
        "Instellingen opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
      return;
    }
    try {
      this.audit.record({
        sessionId: origin?.sessionId ?? "settings",
        tool: "settings_change",
        risk: origin ? "CONFIRM" : "SAFE",
        confirmation: origin?.confirmation ?? "admin_ui",
        arguments: { what: "helper_preferences", revision: revision.id },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Wijzigingsgeschiedenis opgeslagen, maar de auditmelding kon niet worden geschreven.";
    }
  }

  rollback(id: string): {
    ok: true;
    preferences: HelperPreferences;
    auditWarning?: string;
  } {
    const revision = this.history.all().find((entry) => entry.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = normalize(this.settings.get().helperPreferences);
    if (!isDeepStrictEqual(current, revision.after))
      throw new NotFoundException(
        "De instellingen zijn daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { what: "helper_preferences_rollback", revision: id },
      phase: "attempt",
    });
    this.settings.update((next) => {
      next.helperPreferences = revision.before;
    });
    this.record(current, revision.before, id);
    return {
      ok: true,
      preferences: revision.before,
      ...(this.lastWarning ? { auditWarning: this.lastWarning } : {}),
    };
  }
}
