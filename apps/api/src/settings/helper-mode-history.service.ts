import { Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import type { HelperModeRevision, HelperSettings } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, revertedFromField } from "./history-file.js";
import { SettingsStore } from "./store/settings.store.js";

const normalize = (value: unknown): HelperSettings => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid helper mode history entry");
  const row = value as Record<string, unknown>;
  if (
    !["wallpaper", "helper", "both"].includes(String(row.mode)) ||
    !Number.isInteger(row.display) ||
    (row.display as number) < 0 ||
    (row.display as number) > 8
  )
    throw new Error("Invalid helper mode history entry");
  return {
    mode: row.mode as HelperSettings["mode"],
    display: row.display as number,
  };
};

/** Private, bounded history for the saved Windows helper mode and display only. */
@Injectable()
export class HelperModeHistory {
  lastWarning: string | undefined;
  private readonly history: HistoryFile<HelperModeRevision>;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<HelperModeRevision>(
      config.dataFile("helper-mode-history.json"),
      (row) => {
        try {
          return {
            before: normalize(row.before),
            after: normalize(row.after),
            ...revertedFromField(row),
          };
        } catch {
          return undefined;
        }
      },
      {},
    );
  }

  list(): { revisions: HelperModeRevision[]; truncated: boolean } {
    const all = this.history.all();
    return { revisions: all.slice(-50).reverse(), truncated: all.length > 50 };
  }

  record(
    before: HelperSettings,
    after: HelperSettings,
    revertedFrom?: string,
  ): void {
    this.lastWarning = undefined;
    const safeBefore = normalize(before);
    const safeAfter = normalize(after);
    if (isDeepStrictEqual(safeBefore, safeAfter)) return;
    const revision: HelperModeRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before: safeBefore,
      after: safeAfter,
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
        sessionId: "settings",
        tool: "settings_change",
        risk: "SAFE",
        confirmation: "admin_ui",
        arguments: { what: "helper_mode", revision: revision.id },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Wijzigingsgeschiedenis opgeslagen, maar de auditmelding kon niet worden geschreven.";
    }
  }

  rollback(id: string): { settings: HelperSettings; auditWarning?: string } {
    const revision = this.history.all().find((entry) => entry.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = normalize(this.settings.get().helper);
    if (!isDeepStrictEqual(current, revision.after))
      throw new NotFoundException(
        "De helperinstellingen zijn daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { what: "helper_mode_rollback", revision: id },
      phase: "attempt",
    });
    this.settings.update((next) => {
      next.helper = revision.before;
    });
    this.record(current, revision.before, id);
    return {
      settings: revision.before,
      ...(this.lastWarning ? { auditWarning: this.lastWarning } : {}),
    };
  }
}
