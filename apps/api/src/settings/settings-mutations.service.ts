import { Injectable, NotFoundException } from "@nestjs/common";
import type { Skill } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { normalizePersona } from "./settings-validation.js";
import { PersonaHistoryService } from "./persona-history.service.js";
import {
  normalizeSkill,
  publicSkill,
  type StoredSkill,
} from "./skills/skills.js";
import { SettingsStore } from "./store/settings.store.js";

export const MAX_SKILLS = 50;

export interface SettingsMutationOrigin {
  sessionId: string;
  confirmation: "confirmed_tool";
}

/** Shared validation and persistence for personal settings. Service credentials have a separate owner. */
@Injectable()
export class SettingsMutationsService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
    private readonly personaHistory: PersonaHistoryService,
  ) {}

  private log(
    what: string,
    detail: Record<string, unknown>,
    origin?: SettingsMutationOrigin,
  ): void {
    this.audit.record({
      sessionId: origin?.sessionId ?? "settings",
      tool: "settings_change",
      risk: origin ? "CONFIRM" : "SAFE",
      confirmation: origin?.confirmation ?? "admin_ui",
      arguments: { what, ...detail },
      result: { ok: true },
    });
  }

  setPersona(
    value: unknown,
    origin?: SettingsMutationOrigin,
  ): { ok: true; persona: string; historyWarning?: string } {
    const persona = normalizePersona(value);
    const previous = this.settings.get().persona;
    this.settings.update((settings) => void (settings.persona = persona));
    this.personaHistory.record(previous, persona);
    this.log("persona", { length: persona.length }, origin);
    return {
      ok: true,
      persona,
      ...(this.personaHistory.lastWarning
        ? { historyWarning: this.personaHistory.lastWarning }
        : {}),
    };
  }

  createSkill(
    body: unknown,
    origin?: SettingsMutationOrigin,
  ): { ok: true; skill: Skill } {
    const skills = this.settings.get().skills as unknown as StoredSkill[];
    if (skills.length >= MAX_SKILLS)
      throw new ValidationError([`Maximaal ${MAX_SKILLS} vaardigheden.`]);
    const skill = normalizeSkill(body, {
      takenIds: skills.map((item) => item.id),
    });
    this.settings.update(
      (settings) => void settings.skills.push(skill as never),
    );
    this.log(
      "skill-created",
      { skill: skill.id, type: skill.type, version: skill.version },
      origin,
    );
    return { ok: true, skill: publicSkill(skill) };
  }

  updateSkill(
    id: string,
    body: unknown,
    origin?: SettingsMutationOrigin,
  ): { ok: true; skill: Skill } {
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
    this.log(
      "skill-updated",
      { skill: skill.id, version: skill.version },
      origin,
    );
    return { ok: true, skill: publicSkill(skill) };
  }
}
