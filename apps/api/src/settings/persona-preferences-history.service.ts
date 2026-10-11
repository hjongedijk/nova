import { Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  PersonaPreferencesHistory,
  PersonaPreferencesSnapshot,
  PersonaPreferencesRollbackResult,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { SettingsStore } from "./store/settings.store.js";
import { normalizePersonaProfile } from "./settings-validation.js";
import { normalizePersonaStyle } from "./settings-validation.js";

const MAX = 40;
const safeSnapshot = (value: unknown): PersonaPreferencesSnapshot | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const profile = row.profile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    return null;
  const fields = profile as Record<string, unknown>;
  if (
    typeof fields.name !== "string" ||
    typeof fields.character !== "string" ||
    typeof fields.address !== "string" ||
    typeof fields.avoid !== "string" ||
    fields.name.length > 40 ||
    fields.character.length > 300 ||
    fields.address.length > 40 ||
    fields.avoid.length > 300
  )
    return null;
  try {
    const snapshot = {
      style: normalizePersonaStyle(row.style),
      profile: normalizePersonaProfile(fields),
    };
    return isDeepStrictEqual(sanitize(snapshot), snapshot) ? snapshot : null;
  } catch {
    return null;
  }
};

/** Private rollback history for non-secret persona style and profile preferences. */
@Injectable()
export class PersonaPreferencesHistoryService {
  private readonly file: string;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("persona-preferences-history.json");
  }

  private current(): PersonaPreferencesSnapshot {
    const state = this.settings.get();
    return {
      style: normalizePersonaStyle(state.personaStyle),
      profile: normalizePersonaProfile(state.personaProfile),
    };
  }

  private read(): PersonaPreferencesHistory["revisions"] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      return value
        .flatMap((raw: unknown) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
          const row = raw as Record<string, unknown>;
          const before = safeSnapshot(row.before);
          const after = safeSnapshot(row.after);
          if (
            typeof row.id !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(row.id) ||
            typeof row.at !== "string" ||
            !Number.isFinite(Date.parse(row.at)) ||
            !before ||
            !after ||
            isDeepStrictEqual(before, after)
          )
            return [];
          return [
            {
              id: row.id,
              at: new Date(row.at).toISOString(),
              before,
              after,
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

  private write(rows: PersonaPreferencesHistory["revisions"]): void {
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

  record(beforeValue: unknown, afterValue: unknown, revertedFrom?: string) {
    const before = safeSnapshot(beforeValue);
    const after = safeSnapshot(afterValue);
    if (!before || !after || isDeepStrictEqual(before, after)) return;
    const rows = this.read();
    rows.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before,
      after,
      ...(revertedFrom ? { revertedFrom } : {}),
    });
    try {
      this.write(rows);
    } catch {
      // Preserve the requested settings save if a history write fails.
    }
  }

  list(): PersonaPreferencesHistory {
    const all = this.read();
    return { revisions: all.slice(-20).reverse(), truncated: all.length > 20 };
  }

  rollback(id: string): PersonaPreferencesRollbackResult {
    const revision = this.read().find((item) => item.id === id);
    if (!revision)
      throw new NotFoundException(
        "Deze profielwijziging is niet meer beschikbaar.",
      );
    const current = this.current();
    if (!isDeepStrictEqual(current, revision.after))
      throw new NotFoundException(
        "NOVA's profiel is daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { what: "persona_preferences_rollback", revision: id },
      phase: "attempt",
    });
    this.settings.update((state) => {
      const latest = {
        style: normalizePersonaStyle(state.personaStyle),
        profile: normalizePersonaProfile(state.personaProfile),
      };
      if (!isDeepStrictEqual(latest, revision.after))
        throw new NotFoundException(
          "NOVA's profiel is intussen gewijzigd. Terugdraaien is afgebroken.",
        );
      state.personaStyle = revision.before.style;
      state.personaProfile = revision.before.profile;
      const active = state.householdProfiles.find(
        (profile) => profile.id === state.activeHouseholdProfileId,
      );
      if (active) active.personaProfile = revision.before.profile;
    });
    this.record(current, revision.before, revision.id);
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: { what: "persona_preferences_rollback", revision: id },
        result: { ok: true },
      });
      return { ok: true, snapshot: revision.before };
    } catch {
      return {
        ok: true,
        snapshot: revision.before,
        auditWarning:
          "Profiel hersteld, maar de auditmelding kon niet worden geschreven.",
      };
    }
  }
}
