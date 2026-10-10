import { Injectable, NotFoundException } from "@nestjs/common";
import type { Skill } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { normalizePersona } from "./settings-validation.js";
import {
  normalizeSkill,
  publicSkill,
  type StoredSkill,
} from "./skills/skills.js";
import { SettingsStore } from "./store/settings.store.js";

export const MAX_SKILLS = 50;

/** Shared validation and persistence for personal settings. Service credentials have a separate owner. */
@Injectable()
export class SettingsMutationsService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {}

  private log(what: string, detail: Record<string, unknown>): void {
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "SAFE",
      confirmation: "admin_ui",
      arguments: { what, ...detail },
      result: { ok: true },
    });
  }

  setPersona(value: unknown): { ok: true; persona: string } {
    const persona = normalizePersona(value);
    this.settings.update((settings) => void (settings.persona = persona));
    this.log("persona", { length: persona.length });
    return { ok: true, persona };
  }

  createSkill(body: unknown): { ok: true; skill: Skill } {
    const skills = this.settings.get().skills as unknown as StoredSkill[];
    if (skills.length >= MAX_SKILLS)
      throw new ValidationError([`Maximaal ${MAX_SKILLS} vaardigheden.`]);
    const skill = normalizeSkill(body, {
      takenIds: skills.map((item) => item.id),
    });
    this.settings.update(
      (settings) => void settings.skills.push(skill as never),
    );
    this.log("skill-created", { skill: skill.id, type: skill.type });
    return { ok: true, skill: publicSkill(skill) };
  }

  updateSkill(id: string, body: unknown): { ok: true; skill: Skill } {
    const existing = (
      this.settings.get().skills as unknown as StoredSkill[]
    ).find((item) => item.id === id);
    if (!existing) throw new NotFoundException("Die vaardigheid bestaat niet.");
    const skill = normalizeSkill(body, { existing });
    this.settings.update((settings) => {
      settings.skills = settings.skills.map((item) =>
        (item as StoredSkill).id === skill.id ? (skill as never) : item,
      );
    });
    this.log("skill-updated", { skill: skill.id, version: skill.version });
    return { ok: true, skill: publicSkill(skill) };
  }
}
