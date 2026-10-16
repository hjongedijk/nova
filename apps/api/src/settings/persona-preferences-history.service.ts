import { Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import type {
  PersonaPreferencesHistory,
  PersonaPreferencesSnapshot,
  PersonaPreferencesRollbackResult,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, revertedFromField } from "./history-file.js";
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
  private readonly history: HistoryFile<
    PersonaPreferencesHistory["revisions"][number]
  >;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<
      PersonaPreferencesHistory["revisions"][number]
    >(
      config.dataFile("persona-preferences-history.json"),
      (row) => {
        const before = safeSnapshot(row.before);
        const after = safeSnapshot(row.after);
        if (!before || !after || isDeepStrictEqual(before, after))
          return undefined;
        return { before, after, ...revertedFromField(row, false) };
      },
      { max: MAX, durability: "file", dirMode: 0o700, listLimit: 20 },
    );
  }

  private current(): PersonaPreferencesSnapshot {
    const state = this.settings.get();
    return {
      style: normalizePersonaStyle(state.personaStyle),
      profile: normalizePersonaProfile(state.personaProfile),
    };
  }

  list(): PersonaPreferencesHistory {
    return this.history.list();
  }

  record(beforeValue: unknown, afterValue: unknown, revertedFrom?: string) {
    const before = safeSnapshot(beforeValue);
    const after = safeSnapshot(afterValue);
    if (!before || !after || isDeepStrictEqual(before, after)) return;
    const rows = this.history.all();
    rows.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before,
      after,
      ...(revertedFrom ? { revertedFrom } : {}),
    });
    try {
      this.history.write(rows);
    } catch {
      // Preserve the requested settings save if a history write fails.
    }
  }

  rollback(id: string): PersonaPreferencesRollbackResult {
    const revision = this.history.all().find((item) => item.id === id);
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
