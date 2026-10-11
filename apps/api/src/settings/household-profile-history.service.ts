import { Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HouseholdProfileSwitchHistory } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { SettingsStore } from "./store/settings.store.js";

const MAX = 40;

/** Private ID-only history for switching the active household profile. */
@Injectable()
export class HouseholdProfileHistory {
  private readonly file: string;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("household-profile-history.json");
  }

  private read(): HouseholdProfileSwitchHistory["revisions"] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      return value
        .flatMap((item: unknown) => {
          if (!item || typeof item !== "object" || Array.isArray(item))
            return [];
          const row = item as Record<string, unknown>;
          if (
            typeof row.id !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(row.id) ||
            typeof row.at !== "string" ||
            !Number.isFinite(Date.parse(row.at)) ||
            typeof row.beforeProfileId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,40}$/.test(row.beforeProfileId) ||
            typeof row.afterProfileId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,40}$/.test(row.afterProfileId) ||
            row.beforeProfileId === row.afterProfileId
          )
            return [];
          return [
            {
              id: row.id,
              at: new Date(row.at).toISOString(),
              beforeProfileId: row.beforeProfileId,
              afterProfileId: row.afterProfileId,
              ...(typeof row.revertedFrom === "string"
                ? { revertedFrom: row.revertedFrom }
                : {}),
            },
          ];
        })
        .slice(-MAX);
    } catch {
      return [];
    }
  }

  private write(rows: HouseholdProfileSwitchHistory["revisions"]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(rows.slice(-MAX)), { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    const fd = fs.openSync(temp, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, this.file);
  }

  record(
    beforeProfileId: string,
    afterProfileId: string,
    revertedFrom?: string,
  ) {
    if (beforeProfileId === afterProfileId) return;
    const profiles = this.settings.get().householdProfiles;
    if (
      !profiles.some((profile) => profile.id === beforeProfileId) ||
      !profiles.some((profile) => profile.id === afterProfileId)
    )
      return;
    const rows = this.read();
    rows.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      beforeProfileId,
      afterProfileId,
      ...(revertedFrom ? { revertedFrom } : {}),
    });
    try {
      this.write(rows);
    } catch {
      // Do not fail a profile switch if local history cannot be written.
    }
  }

  list(): HouseholdProfileSwitchHistory {
    const all = this.read();
    return { revisions: all.slice(-20).reverse(), truncated: all.length > 20 };
  }

  rollback(id: string): {
    ok: true;
    activeHouseholdProfileId: string;
    auditWarning?: string;
  } {
    const revisions = this.read();
    const revision = revisions.find((item) => item.id === id);
    if (!revision)
      throw new NotFoundException(
        "Deze profielwissel is niet meer beschikbaar.",
      );
    if (revisions.at(-1)?.id !== id)
      throw new NotFoundException(
        "Alleen de laatste profielwissel kan worden teruggedraaid.",
      );
    const state = this.settings.get();
    const target = state.householdProfiles.find(
      (profile) => profile.id === revision.beforeProfileId,
    );
    if (state.activeHouseholdProfileId !== revision.afterProfileId || !target)
      throw new NotFoundException(
        "Gezinsprofielen zijn daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { what: "household_profile_rollback", revision: id },
      phase: "attempt",
    });
    this.settings.update((current) => {
      const currentTarget = current.householdProfiles.find(
        (profile) => profile.id === revision.beforeProfileId,
      );
      if (
        this.read().at(-1)?.id !== id ||
        current.activeHouseholdProfileId !== revision.afterProfileId ||
        !currentTarget
      )
        throw new NotFoundException(
          "Gezinsprofielen zijn intussen gewijzigd. Terugdraaien is afgebroken.",
        );
      current.activeHouseholdProfileId = revision.beforeProfileId;
      current.personaProfile = currentTarget.personaProfile;
    });
    this.record(revision.afterProfileId, revision.beforeProfileId, revision.id);
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: { what: "household_profile_rollback", revision: id },
        result: { ok: true },
      });
      return {
        ok: true,
        activeHouseholdProfileId: revision.beforeProfileId,
      };
    } catch {
      return {
        ok: true,
        activeHouseholdProfileId: revision.beforeProfileId,
        auditWarning:
          "Profiel hersteld, maar de auditmelding kon niet worden geschreven.",
      };
    }
  }
}
