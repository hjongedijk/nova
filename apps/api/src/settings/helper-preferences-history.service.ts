import { Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  HelperPreferences,
  HelperPreferenceRevision,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
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
  private readonly file: string;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("helper-preferences-history.json");
  }

  private read(): HelperPreferenceRevision[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      return value.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return [];
        const row = entry as Record<string, unknown>;
        if (
          typeof row.id !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(row.id) ||
          typeof row.at !== "string" ||
          !Number.isFinite(Date.parse(row.at)) ||
          !row.before ||
          !row.after
        )
          return [];
        try {
          return [
            {
              id: row.id,
              at: new Date(row.at).toISOString(),
              before: normalize(row.before),
              after: normalize(row.after),
              ...(typeof row.revertedFrom === "string"
                ? { revertedFrom: row.revertedFrom }
                : {}),
            },
          ];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  private write(entries: HelperPreferenceRevision[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(entries.slice(-100)), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  list(): { revisions: HelperPreferenceRevision[]; truncated: boolean } {
    const all = this.read();
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
      this.write([...this.read(), revision]);
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
    const revision = this.read().find((entry) => entry.id === id);
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
