import { Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  HouseholdProfile,
  HouseholdProfileSwitchHistory,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
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
  if (before.activeProfileId !== after.activeProfileId) {
    changed.add(before.activeProfileId);
    changed.add(after.activeProfileId);
  }
  return [...changed].sort();
}

/** Private ID-only history for switching the active household profile. */
@Injectable()
export class HouseholdProfileHistory {
  private readonly file: string;
  private readonly definitionsFile: string;
  private definitionsWarning: string | undefined;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("household-profile-history.json");
    this.definitionsFile = config.dataFile(
      "household-profile-definitions-history.json",
    );
  }

  private readDefinitions(): DefinitionsRevision[] {
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(this.definitionsFile, "utf8"),
      );
      if (!Array.isArray(value)) return [];
      return value
        .flatMap((entry: unknown) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return [];
          const row = entry as Record<string, unknown>;
          const before = cleanDefinitions(row.before);
          const after = cleanDefinitions(row.after);
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
              ...(typeof row.revertedFrom === "string" &&
              /^[0-9a-f-]{36}$/i.test(row.revertedFrom)
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

  private writeDefinitions(rows: DefinitionsRevision[]): void {
    fs.mkdirSync(path.dirname(this.definitionsFile), {
      recursive: true,
      mode: 0o700,
    });
    const temp = `${this.definitionsFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(rows.slice(-MAX)), { mode: 0o600 });
      fs.chmodSync(temp, 0o600);
      const fd = fs.openSync(temp, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, this.definitionsFile);
    } finally {
      fs.rmSync(temp, { force: true });
    }
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
      isDeepStrictEqual(cleanBefore, cleanAfter)
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
      this.writeDefinitions([...this.readDefinitions(), revision]);
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
    const all = this.readDefinitions();
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
    const revisions = this.readDefinitions();
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
    if (!current || !isDeepStrictEqual(current, revision.after))
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
    this.settings.update((next) => {
      const latest = this.readDefinitions().at(-1);
      const live = cleanDefinitions({
        profiles: next.householdProfiles,
        activeProfileId: next.activeHouseholdProfileId,
      });
      if (
        latest?.id !== id ||
        !live ||
        !isDeepStrictEqual(live, revision.after)
      )
        throw new NotFoundException(
          "Gezinsprofielen zijn intussen gewijzigd. Terugdraaien is afgebroken.",
        );
      next.householdProfiles = revision.before.profiles;
      next.activeHouseholdProfileId = revision.before.activeProfileId;
      next.personaProfile = revision.before.profiles.find(
        (profile) => profile.id === revision.before.activeProfileId,
      )!.personaProfile;
    });
    this.record(
      revision.after.activeProfileId,
      revision.before.activeProfileId,
    );
    this.recordDefinitions(revision.after, revision.before, revision.id);
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
      activeHouseholdProfileId: revision.before.activeProfileId,
      ...(auditWarning ? { auditWarning } : {}),
    };
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
