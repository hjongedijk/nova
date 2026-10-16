import { Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import type {
  InstructionSkill,
  InstructionSkillContentHistory,
  InstructionSkillContentRevision,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile } from "./history-file.js";
import { sanitize } from "../core/security/sanitize.js";
import { SettingsStore } from "./store/settings.store.js";
import {
  normalizeSkill,
  toolNameFor,
  type StoredSkill,
} from "./skills/skills.js";

const MAX_REVISIONS = 40;
const cleanSnapshot = (
  value: unknown,
): InstructionSkillContentRevision["before"] | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.instructions !== "string" ||
    !Number.isSafeInteger(row.version) ||
    row.instructions.length > 4000
  )
    return null;
  const snapshot: InstructionSkillContentRevision["before"] = {
    version: row.version as number,
    instructions: row.instructions,
  };
  const hasMetadata = ["name", "description", "examples", "enabled"].some(
    (key) => Object.hasOwn(row, key),
  );
  if (hasMetadata) {
    if (
      typeof row.name !== "string" ||
      row.name.length > 60 ||
      typeof row.description !== "string" ||
      row.description.length > 300 ||
      !Array.isArray(row.examples) ||
      row.examples.length > 8 ||
      row.examples.some(
        (item) => typeof item !== "string" || item.length > 120,
      ) ||
      typeof row.enabled !== "boolean"
    )
      return null;
    snapshot.name = row.name;
    snapshot.description = row.description;
    snapshot.examples = row.examples as string[];
    snapshot.enabled = row.enabled;
  }
  const safe = sanitize(snapshot);
  // Never persist a lossy redaction that would later be restored as real config.
  if (!isDeepStrictEqual(safe, snapshot)) return null;
  return safe;
};

/** Private, bounded history for instruction text; webhook configuration is never stored here. */
@Injectable()
export class InstructionSkillHistory {
  private readonly history: HistoryFile<InstructionSkillContentRevision>;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<InstructionSkillContentRevision>(
      config.dataFile("instruction-skill-history.json"),
      (row) => {
        const before = row.before === null ? null : cleanSnapshot(row.before);
        const after = cleanSnapshot(row.after);
        if (
          typeof row.skillId !== "string" ||
          (row.before !== null && !before) ||
          !after
        )
          return undefined;
        return { skillId: row.skillId, before, after };
      },
      { max: MAX_REVISIONS, durability: "file" },
    );
  }

  record(before: StoredSkill, after: StoredSkill): void {
    if (before.type !== "instruction" || after.type !== "instruction") return;
    const project = (skill: StoredSkill) =>
      skill.type === "instruction"
        ? {
            version: skill.version,
            instructions: skill.instructions,
            name: skill.name,
            description: skill.description,
            examples: skill.examples,
            enabled: skill.enabled,
          }
        : null;
    const safeBefore = cleanSnapshot(project(before));
    const safeAfter = cleanSnapshot(project(after));
    if (!safeBefore || !safeAfter || isDeepStrictEqual(safeBefore, safeAfter))
      return;
    try {
      this.history.write([
        ...this.history.all(),
        {
          id: crypto.randomUUID(),
          skillId: before.id,
          at: new Date().toISOString(),
          before: safeBefore,
          after: safeAfter,
        },
      ]);
    } catch {
      /* History failure must not undo a successful settings save. */
    }
  }

  recordCreated(skill: StoredSkill): void {
    if (skill.type !== "instruction") return;
    const after = cleanSnapshot({
      version: skill.version,
      instructions: skill.instructions,
      name: skill.name,
      description: skill.description,
      examples: skill.examples,
      enabled: skill.enabled,
    });
    if (!after) return;
    try {
      this.history.write([
        ...this.history.all(),
        {
          id: crypto.randomUUID(),
          skillId: skill.id,
          at: new Date().toISOString(),
          before: null,
          after,
        },
      ]);
    } catch {
      /* History failure must not undo a successful skill save. */
    }
  }

  forget(id: string): void {
    const rows = this.history.all();
    const remaining = rows.filter((row) => row.skillId !== id);
    if (remaining.length !== rows.length) this.history.write(remaining);
  }

  list(id: string): InstructionSkillContentHistory {
    const current = (
      this.settings.get().skills as unknown as StoredSkill[]
    ).find((s) => s.id === id);
    if (!current || current.type !== "instruction")
      throw new NotFoundException("De instructievaardigheid bestaat niet.");
    const all = this.history.all().filter((r) => r.skillId === id);
    return {
      currentVersion: current.version,
      revisions: all.slice(-20).reverse(),
      truncated: all.length > 20,
    };
  }

  rollback(
    id: string,
    revisionId: string,
  ): {
    ok: true;
    skill?: InstructionSkill;
    removed?: true;
    historyWarning?: string;
  } {
    const revision = this.history
      .all()
      .find((r) => r.id === revisionId && r.skillId === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = (
      this.settings.get().skills as unknown as StoredSkill[]
    ).find((s) => s.id === id);
    if (
      !current ||
      current.type !== "instruction" ||
      !this.matches(current, revision.after)
    )
      throw new NotFoundException(
        "De vaardigheid is daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.settings.update((state) => {
      const latest = (state.skills as unknown as StoredSkill[]).find(
        (s) => s.id === id,
      );
      if (
        !latest ||
        latest.type !== "instruction" ||
        !this.matches(latest, revision.after)
      )
        throw new NotFoundException(
          "De vaardigheid is intussen gewijzigd. Terugdraaien is afgebroken.",
        );
      if (revision.before === null) {
        state.skills = state.skills.filter((s) => (s as StoredSkill).id !== id);
        delete state.toolOverrides[toolNameFor(latest)];
      } else {
        const restored = normalizeSkill(
          { ...latest, ...revision.before },
          { existing: latest },
        );
        state.skills = state.skills.map((s) =>
          (s as StoredSkill).id === id ? (restored as never) : s,
        );
      }
    });
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: {
        what: "instruction_skill_rollback",
        skill: id,
        revision: revisionId,
      },
      result: { ok: true },
    });
    const skill = (this.settings.get().skills as unknown as StoredSkill[]).find(
      (s) => s.id === id,
    )!;
    if (revision.before === null) {
      let historyWarning: string | undefined;
      try {
        this.forget(id);
      } catch {
        historyWarning =
          "De vaardigheid is verwijderd, maar de private geschiedenis kon niet worden gewist.";
      }
      return {
        ok: true,
        removed: true,
        ...(historyWarning ? { historyWarning } : {}),
      };
    }
    this.record(current, skill);
    return { ok: true, skill: skill as InstructionSkill };
  }

  private matches(
    skill: StoredSkill,
    snapshot: InstructionSkillContentRevision["after"],
  ): boolean {
    if (skill.type !== "instruction") return false;
    if (skill.instructions !== snapshot.instructions) return false;
    if (snapshot.name === undefined) return true; // version-one history entry
    if (skill.version !== snapshot.version) return false;
    return isDeepStrictEqual(
      {
        name: skill.name,
        description: skill.description,
        examples: skill.examples,
        enabled: skill.enabled,
      },
      {
        name: snapshot.name,
        description: snapshot.description,
        examples: snapshot.examples,
        enabled: snapshot.enabled,
      },
    );
  }
}
