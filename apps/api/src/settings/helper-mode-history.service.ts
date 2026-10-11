import { Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HelperModeRevision, HelperSettings } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
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
  private readonly file: string;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("helper-mode-history.json");
  }

  private read(): HelperModeRevision[] {
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
          !Number.isFinite(Date.parse(row.at))
        )
          return [];
        try {
          return [
            {
              id: row.id,
              at: new Date(row.at).toISOString(),
              before: normalize(row.before),
              after: normalize(row.after),
              ...(typeof row.revertedFrom === "string" &&
              /^[0-9a-f-]{36}$/i.test(row.revertedFrom)
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

  private write(entries: HelperModeRevision[]): void {
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

  list(): { revisions: HelperModeRevision[]; truncated: boolean } {
    const all = this.read();
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
      this.write([...this.read(), revision]);
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
    const revision = this.read().find((entry) => entry.id === id);
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
