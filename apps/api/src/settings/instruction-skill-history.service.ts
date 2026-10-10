import { Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  InstructionSkill,
  InstructionSkillContentHistory,
  InstructionSkillContentRevision,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { SettingsStore } from "./store/settings.store.js";
import { normalizeSkill, type StoredSkill } from "./skills/skills.js";

const MAX_REVISIONS = 40;
const cleanContent = (
  value: unknown,
): { version: number; instructions: string } | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.instructions !== "string" ||
    !Number.isSafeInteger(row.version) ||
    row.instructions.length > 4000
  )
    return null;
  return sanitize({ version: row.version, instructions: row.instructions }) as {
    version: number;
    instructions: string;
  };
};

/** Private, bounded history for instruction text; webhook configuration is never stored here. */
@Injectable()
export class InstructionSkillHistory {
  private readonly file: string;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("instruction-skill-history.json");
  }

  private read(): InstructionSkillContentRevision[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      return value
        .flatMap((item: unknown) => {
          if (!item || typeof item !== "object" || Array.isArray(item))
            return [];
          const row = item as Record<string, unknown>;
          const before = cleanContent(row.before);
          const after = cleanContent(row.after);
          if (
            typeof row.id !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(row.id) ||
            typeof row.at !== "string" ||
            !Number.isFinite(Date.parse(row.at)) ||
            typeof row.skillId !== "string" ||
            !before ||
            !after
          )
            return [];
          return [
            {
              id: row.id,
              skillId: row.skillId,
              at: new Date(row.at).toISOString(),
              before,
              after,
            },
          ];
        })
        .slice(-MAX_REVISIONS);
    } catch {
      return [];
    }
  }

  private write(rows: InstructionSkillContentRevision[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(rows.slice(-MAX_REVISIONS)), {
      mode: 0o600,
    });
    fs.chmodSync(temp, 0o600);
    const fd = fs.openSync(temp, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, this.file);
  }

  record(before: StoredSkill, after: StoredSkill): void {
    if (before.type !== "instruction" || after.type !== "instruction") return;
    const safeBefore = cleanContent(before);
    const safeAfter = cleanContent(after);
    if (!safeBefore || !safeAfter || isDeepStrictEqual(safeBefore, safeAfter))
      return;
    try {
      this.write([
        ...this.read(),
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

  list(id: string): InstructionSkillContentHistory {
    const current = (
      this.settings.get().skills as unknown as StoredSkill[]
    ).find((s) => s.id === id);
    if (!current || current.type !== "instruction")
      throw new NotFoundException("De instructievaardigheid bestaat niet.");
    const all = this.read().filter((r) => r.skillId === id);
    return {
      currentVersion: current.version,
      revisions: all.slice(-20).reverse(),
      truncated: all.length > 20,
    };
  }

  rollback(
    id: string,
    revisionId: string,
  ): { ok: true; skill: InstructionSkill } {
    const revision = this.read().find(
      (r) => r.id === revisionId && r.skillId === id,
    );
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = (
      this.settings.get().skills as unknown as StoredSkill[]
    ).find((s) => s.id === id);
    if (
      !current ||
      current.type !== "instruction" ||
      current.instructions !== revision.after.instructions
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
        latest.instructions !== revision.after.instructions
      )
        throw new NotFoundException(
          "De vaardigheid is intussen gewijzigd. Terugdraaien is afgebroken.",
        );
      const restored = normalizeSkill(
        { ...latest, instructions: revision.before.instructions },
        { existing: latest },
      );
      state.skills = state.skills.map((s) =>
        (s as StoredSkill).id === id ? (restored as never) : s,
      );
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
    this.record(current, skill);
    return { ok: true, skill: skill as InstructionSkill };
  }
}
