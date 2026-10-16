import { Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  HouseholdProfile,
  HouseholdProfileSwitchHistory,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, revertedFromField } from "./history-file.js";
import { sanitize } from "../core/security/sanitize.js";
import { normalizeHouseholdProfiles } from "./settings-validation.js";
import { SettingsStore } from "./store/settings.store.js";

const MAX = 40;
type DefinitionsSnapshot = {
  profiles: HouseholdProfile[];
  activeProfileId: string;
};
type DefinitionsRevision = {
  id: string;
  at: string;
  before: DefinitionsSnapshot;
  after: DefinitionsSnapshot;
  revertedFrom?: string;
};

/** Reject snapshots that normalization or secret screening would change. */
function cleanDefinitions(value: unknown): DefinitionsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["profiles", "activeProfileId"].includes(key),
    ) ||
    typeof input.activeProfileId !== "string"
  )
    return null;
  try {
    const profiles = normalizeHouseholdProfiles(input.profiles);
    if (!profiles.some((profile) => profile.id === input.activeProfileId))
      return null;
    const snapshot = { profiles, activeProfileId: input.activeProfileId };
    if (!isDeepStrictEqual(value, snapshot)) return null;
    if (
      profiles.some((profile) =>
        [profile.label, ...Object.values(profile.personaProfile)].some((text) =>
          /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i.test(text),
        ),
      )
    )
      return null;
    const screened = sanitize(snapshot);
    return isDeepStrictEqual(screened, snapshot) ? screened : null;
  } catch {
    return null;
  }
}

function changedProfileIds(
  before: DefinitionsSnapshot,
  after: DefinitionsSnapshot,
): string[] {
  const old = new Map(before.profiles.map((profile) => [profile.id, profile]));
  const next = new Map(after.profiles.map((profile) => [profile.id, profile]));
  const changed = new Set<string>();
  for (const id of new Set([...old.keys(), ...next.keys()]))
    if (!isDeepStrictEqual(old.get(id), next.get(id))) changed.add(id);
  return [...changed].sort();
}

/** Private ID-only history for switching the active household profile. */
@Injectable()
export class HouseholdProfileHistory {
  private readonly switchHistory: HistoryFile<
    HouseholdProfileSwitchHistory["revisions"][number]
  >;
  private readonly definitionsHistory: HistoryFile<DefinitionsRevision>;
  private definitionsWarning: string | undefined;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.switchHistory = new HistoryFile<
      HouseholdProfileSwitchHistory["revisions"][number]
    >(
      config.dataFile("household-profile-history.json"),
      (row) =>
        typeof row.beforeProfileId === "string" &&
        /^[a-zA-Z0-9_-]{1,40}$/.test(row.beforeProfileId) &&
        typeof row.afterProfileId === "string" &&
        /^[a-zA-Z0-9_-]{1,40}$/.test(row.afterProfileId) &&
        row.beforeProfileId !== row.afterProfileId
          ? {
              beforeProfileId: row.beforeProfileId,
              afterProfileId: row.afterProfileId,
              ...revertedFromField(row, false),
            }
          : undefined,
      { max: MAX, durability: "file", dirMode: 0o700, listLimit: 20 },
    );
    this.definitionsHistory = new HistoryFile<DefinitionsRevision>(
      config.dataFile("household-profile-definitions-history.json"),
      (row) => {
        const before = cleanDefinitions(row.before);
        const after = cleanDefinitions(row.after);
        if (
          !before ||
          !after ||
          isDeepStrictEqual(before.profiles, after.profiles)
        )
          return undefined;
        return { before, after, ...revertedFromField(row) };
      },
      { max: MAX, durability: "file", dirMode: 0o700 },
    );
  }

  recordDefinitions(
    before: DefinitionsSnapshot,
    after: DefinitionsSnapshot,
    revertedFrom?: string,
  ): void {
    this.definitionsWarning = undefined;
    const cleanBefore = cleanDefinitions(before);
    const cleanAfter = cleanDefinitions(after);
    if (
      !cleanBefore ||
      !cleanAfter ||
      isDeepStrictEqual(cleanBefore.profiles, cleanAfter.profiles)
    )
      return;
    const revision: DefinitionsRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before: cleanBefore,
      after: cleanAfter,
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    try {
      this.definitionsHistory.append(revision);
    } catch {
      this.definitionsWarning =
        "Profielen opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
    }
  }

  listDefinitions(): {
    revisions: Array<{
      id: string;
      at: string;
      beforeCount: number;
      afterCount: number;
      changedProfileIds: string[];
      revertedFrom?: string;
    }>;
    truncated: boolean;
  } {
    const all = this.definitionsHistory.all();
    return {
      revisions: all
        .slice(-20)
        .reverse()
        .map((row) => ({
          id: row.id,
          at: row.at,
          beforeCount: row.before.profiles.length,
          afterCount: row.after.profiles.length,
          changedProfileIds: changedProfileIds(row.before, row.after),
          ...(row.revertedFrom ? { revertedFrom: row.revertedFrom } : {}),
        })),
      truncated: all.length > 20,
    };
  }

  rollbackDefinitions(id: string): {
    ok: true;
    householdProfiles: HouseholdProfile[];
    activeHouseholdProfileId: string;
    auditWarning?: string;
  } {
    const revisions = this.definitionsHistory.all();
    const revision = revisions.at(-1);
    if (!revision || revision.id !== id)
      throw new NotFoundException(
        "Alleen de laatste profielwijziging kan worden teruggedraaid.",
      );
    const state = this.settings.get();
    const current = cleanDefinitions({
      profiles: state.householdProfiles,
      activeProfileId: state.activeHouseholdProfileId,
    });
    if (
      !current ||
      !isDeepStrictEqual(current.profiles, revision.after.profiles)
    )
      throw new NotFoundException(
        "Gezinsprofielen zijn daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: {
        what: "household_profile_definitions_rollback",
        revision: id,
      },
      phase: "attempt",
    });
    let restoredActiveProfileId = revision.before.activeProfileId;
    this.settings.update((next) => {
      const latest = this.definitionsHistory.all().at(-1);
      const live = cleanDefinitions({
        profiles: next.householdProfiles,
        activeProfileId: next.activeHouseholdProfileId,
      });
      if (
        latest?.id !== id ||
        !live ||
        !isDeepStrictEqual(live.profiles, revision.after.profiles)
      )
        throw new NotFoundException(
          "Gezinsprofielen zijn intussen gewijzigd. Terugdraaien is afgebroken.",
        );
      restoredActiveProfileId = revision.before.profiles.some(
        (profile) => profile.id === live.activeProfileId,
      )
        ? live.activeProfileId
        : revision.before.activeProfileId;
      next.householdProfiles = revision.before.profiles;
      next.activeHouseholdProfileId = restoredActiveProfileId;
      next.personaProfile = revision.before.profiles.find(
        (profile) => profile.id === restoredActiveProfileId,
      )!.personaProfile;
    });
    this.record(current.activeProfileId, restoredActiveProfileId);
    this.recordDefinitions(
      current,
      {
        profiles: revision.before.profiles,
        activeProfileId: restoredActiveProfileId,
      },
      revision.id,
    );
    let auditWarning = this.definitionsWarning;
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: {
          what: "household_profile_definitions_rollback",
          revision: id,
        },
        result: { ok: true },
      });
    } catch {
      auditWarning ??=
        "Profielen hersteld, maar de auditmelding kon niet worden geschreven.";
    }
    return {
      ok: true,
      householdProfiles: revision.before.profiles,
      activeHouseholdProfileId: restoredActiveProfileId,
      ...(auditWarning ? { auditWarning } : {}),
    };
  }

  list(): HouseholdProfileSwitchHistory {
    return this.switchHistory.list();
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
    const rows = this.switchHistory.all();
    rows.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      beforeProfileId,
      afterProfileId,
      ...(revertedFrom ? { revertedFrom } : {}),
    });
    try {
      this.switchHistory.write(rows);
    } catch {
      // Do not fail a profile switch if local history cannot be written.
    }
  }

  rollback(id: string): {
    ok: true;
    activeHouseholdProfileId: string;
    auditWarning?: string;
  } {
    const revisions = this.switchHistory.all();
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
        this.switchHistory.all().at(-1)?.id !== id ||
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
