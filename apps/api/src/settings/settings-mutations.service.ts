import { Injectable, NotFoundException } from "@nestjs/common";
import type { HouseholdProfile, Skill } from "@nova/contracts";
import type { PersonaStyleId } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import {
  normalizePersona,
  normalizePersonaStyle,
  normalizePersonaProfile,
  normalizeHouseholdProfiles,
} from "./settings-validation.js";
import { PersonaHistoryService } from "./persona-history.service.js";
import { InstructionSkillHistory } from "./instruction-skill-history.service.js";
import { HelperPreferencesHistory } from "./helper-preferences-history.service.js";
import { PersonaPreferencesHistoryService } from "./persona-preferences-history.service.js";
import { normalizeHelperPreferences } from "./settings-validation.js";
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
    private readonly skillHistory: InstructionSkillHistory,
    private readonly helperHistory: HelperPreferencesHistory,
    private readonly personaPreferencesHistory: PersonaPreferencesHistoryService,
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

  setPersonaStyle(value: unknown): { ok: true; personaStyle: PersonaStyleId } {
    const personaStyle = normalizePersonaStyle(value);
    const before = {
      style: normalizePersonaStyle(this.settings.get().personaStyle),
      profile: normalizePersonaProfile(this.settings.get().personaProfile),
    };
    this.settings.update((settings) => {
      settings.personaStyle = personaStyle;
    });
    this.personaPreferencesHistory.record(before, {
      ...before,
      style: personaStyle,
    });
    this.log("persona_style", { style: personaStyle });
    return { ok: true, personaStyle };
  }

  setPersonaProfile(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ValidationError(["Ongeldig NOVA-profiel."]);
    const input = value as Record<string, unknown>;
    const fields = ["name", "character", "address", "avoid"] as const;
    if (
      Object.keys(input).length !== fields.length ||
      fields.some((key) => typeof input[key] !== "string") ||
      Object.keys(input).some(
        (key) => !fields.includes(key as (typeof fields)[number]),
      )
    )
      throw new ValidationError(["Ongeldig NOVA-profiel."]);
    const limits = { name: 40, character: 300, address: 40, avoid: 300 };
    if (
      fields.some(
        (key) => (input[key] as string).trim().length > limits[key],
      ) ||
      !(input.name as string).trim()
    )
      throw new ValidationError([
        "Controleer de lengte en vul NOVA's naam in.",
      ]);
    const before = {
      style: normalizePersonaStyle(this.settings.get().personaStyle),
      profile: normalizePersonaProfile(this.settings.get().personaProfile),
    };
    const profile = normalizePersonaProfile(value);
    this.settings.update((settings) => {
      settings.personaProfile = profile;
      const active = settings.householdProfiles.find(
        (candidate) => candidate.id === settings.activeHouseholdProfileId,
      );
      if (active) active.personaProfile = profile;
    });
    this.personaPreferencesHistory.record(before, { ...before, profile });
    this.log("persona_profile", { fields: Object.keys(input).length });
    return { ok: true as const, personaProfile: profile };
  }

  setHouseholdProfiles(value: unknown, activeId: unknown) {
    const profiles = normalizeHouseholdProfiles(value);
    if (
      typeof activeId !== "string" ||
      !profiles.some((profile) => profile.id === activeId)
    )
      throw new ValidationError(["Kies een bestaand gezinsprofiel."]);
    const beforeSettings = this.settings.get();
    const before = {
      style: normalizePersonaStyle(beforeSettings.personaStyle),
      profile: normalizePersonaProfile(beforeSettings.personaProfile),
    };
    const active = profiles.find((profile) => profile.id === activeId)!;
    this.settings.update((settings) => {
      settings.householdProfiles = profiles;
      settings.activeHouseholdProfileId = activeId;
      settings.personaProfile = active.personaProfile;
    });
    this.personaPreferencesHistory.record(before, {
      ...before,
      profile: active.personaProfile,
    });
    this.log("household_profiles", {
      count: profiles.length,
      preferenceCount: active.communicationPreferences.length,
    });
    return {
      ok: true as const,
      householdProfiles: profiles as HouseholdProfile[],
      activeHouseholdProfileId: activeId,
    };
  }

  setHelperPreference(
    key: "autohide" | "contrast" | "quietHours",
    value: boolean,
    origin: SettingsMutationOrigin,
  ): { ok: true; preferences: ReturnType<typeof normalizeHelperPreferences> } {
    const before = normalizeHelperPreferences(
      this.settings.get().helperPreferences as unknown as Record<
        string,
        unknown
      >,
    );
    const preferences = normalizeHelperPreferences(
      key === "quietHours"
        ? {
            ...before,
            cues: {
              ...before.cues,
              quiet: { ...before.cues.quiet, enabled: value },
            },
          }
        : { ...before, [key]: value },
    );
    this.settings.update((settings) => {
      settings.helperPreferences = preferences;
    });
    this.helperHistory.record(before, preferences, undefined, origin);
    return { ok: true, preferences };
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
    this.skillHistory.recordCreated(skill as StoredSkill);
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
    this.skillHistory.record(existing, skill);
    this.log(
      "skill-updated",
      { skill: skill.id, version: skill.version },
      origin,
    );
    return { ok: true, skill: publicSkill(skill) };
  }
}
