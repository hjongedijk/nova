import type {
  HelperPreferences,
  HouseholdProfile,
  ModelRolePreferences,
  PersonaProfile,
  PersonaStyleId,
} from "@nova/contracts";
import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../../core/config/nova-config.js";
import {
  normalizePersona,
  normalizePersonaProfile,
  normalizePersonaStyle,
  normalizeHouseholdProfiles,
} from "../settings-validation.js";

export interface HelperChoice {
  mode: "wallpaper" | "helper" | "both";
  /** 0 = the primary display. */
  display: number;
}

export interface QuickAction {
  label: string;
  prompt: string;
}

export interface ToolOverride {
  enabled?: false;
  description?: string;
}

/** Everything the user can change on the settings screen. Shapes are checked by the settings module. */
export interface StandingApproval {
  id: string;
  tool: string;
  argsHash: string;
  schemaHash: string;
  createdAt: number;
  scope?: string;
}

export interface NovaSettings {
  standingApprovals: StandingApproval[];
  helperPreferences: HelperPreferences;
  version: 1;
  persona: string;
  personaStyle: PersonaStyleId;
  personaProfile: PersonaProfile;
  householdProfiles: HouseholdProfile[];
  activeHouseholdProfileId: string;
  quickActions: QuickAction[] | null;
  toolOverrides: Record<string, ToolOverride>;
  skills: Record<string, unknown>[];
  widgets: Record<string, unknown>[];
  sidebar: { items: Record<string, unknown>[] } | null;
  /** What the Windows PC shows: the wallpaper (default), the helper overlay, or both. */
  helper: HelperChoice;
  modelRoles: ModelRolePreferences;
}

const defaultModelRoles: ModelRolePreferences = {
  conversation: { preferred: [], fallback: null },
  code: { preferred: [], fallback: null },
  planning: { preferred: [], fallback: null },
  summary: { preferred: [], fallback: null },
  vision: { preferred: [], fallback: null },
  embedding: { preferred: [], fallback: null },
};

export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    label: "Status van de servers",
    prompt: "Hoe is de status van de servers?",
  },
  {
    label: "Welke VM's draaien er?",
    prompt: "Welke virtuele machines draaien er en hoe druk zijn ze?",
  },
  { label: "Het weer", prompt: "Wat is het weer buiten?" },
  { label: "Wat kun je?", prompt: "Wat kun je allemaal voor me doen?" },
];

const blank = (): NovaSettings => ({
  version: 1,
  standingApprovals: [],
  helperPreferences: {
    autohide: true,
    contrast: false,
    shape: "orb",
    notifications: {
      info: "helper",
      briefing: "speak",
      warning: "speak",
      critical: "speak",
      timer: "speak",
    },
    rituals: {
      morning: { enabled: false, time: "08:00" },
      evening: { enabled: false, time: "22:00" },
      checkIn: { enabled: false, afterHours: 4 },
      weeklyOverview: { enabled: false, time: "18:00" },
      calendarReminders: { enabled: false, minutesBefore: 15 },
    },
    cues: {
      enabled: true,
      volume: 0.35,
      theme: "soft",
      quiet: { enabled: false, start: "22:00", end: "07:00" },
    },
  },
  persona: "",
  personaStyle: "friendly",
  personaProfile: {
    name: "NOVA",
    character: "warm, nieuwsgierig en met af en toe droge humor",
    address: "je/jij",
    avoid: "doen alsof ik een mens ben of gevoelens en ervaringen verzinnen",
  },
  householdProfiles: [
    {
      id: "primary",
      label: "Gebruiker",
      personaProfile: {
        name: "NOVA",
        character: "warm, nieuwsgierig en met af en toe droge humor",
        address: "je/jij",
        avoid:
          "doen alsof ik een mens ben of gevoelens en ervaringen verzinnen",
      },
      communicationPreferences: [],
    },
  ],
  activeHouseholdProfileId: "primary",
  quickActions: null,
  toolOverrides: {},
  skills: [],
  widgets: [],
  sidebar: null,
  helper: { mode: "wallpaper", display: 0 },
  modelRoles: defaultModelRoles,
});

/**
 * settings.json: written atomically and readable only by NOVA, because skills may hold secrets.
 * A damaged file is set aside for inspection, never overwritten silently.
 */
@Injectable()
export class SettingsStore {
  private cache: NovaSettings | null = null;
  private readonly file: string;
  private readonly personaFile: string;

  constructor(config: NovaConfig) {
    this.file = config.dataFile("settings.json");
    this.personaFile = config.dataFile("persona.md");
  }

  private personaFromFile(fallback: string): string {
    let descriptor: number;
    try {
      descriptor = fs.openSync(
        this.personaFile,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.writePersonaFile(fallback);
        return fallback;
      }
      if ((error as NodeJS.ErrnoException).code === "ELOOP") return fallback;
      throw error;
    }
    try {
      if (!fs.fstatSync(descriptor).isFile()) return fallback;
      const value = fs.readFileSync(descriptor, "utf8");
      try {
        return normalizePersona(value);
      } catch {
        const damaged = `${this.personaFile}.damaged-${Date.now()}`;
        fs.closeSync(descriptor);
        descriptor = -1;
        fs.renameSync(this.personaFile, damaged);
        this.writePersonaFile(fallback);
        return fallback;
      }
    } finally {
      if (descriptor >= 0) fs.closeSync(descriptor);
    }
  }

  private writePersonaFile(value: string): void {
    fs.mkdirSync(path.dirname(this.personaFile), { recursive: true });
    try {
      if (fs.lstatSync(this.personaFile).isSymbolicLink())
        throw new Error("persona.md may not be a symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${this.personaFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, value, { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.personaFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private load(): NovaSettings {
    if (this.cache) return this.cache;
    let saved: Partial<NovaSettings> = {};
    try {
      saved = JSON.parse(
        fs.readFileSync(this.file, "utf8"),
      ) as Partial<NovaSettings>;
      this.cache = {
        ...blank(),
        ...saved,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          fs.renameSync(this.file, `${this.file}.damaged-${Date.now()}`);
        } catch {
          /* nothing to keep */
        }
      }
      this.cache = blank();
    }
    this.cache.persona = this.personaFromFile(this.cache.persona);
    this.cache.personaProfile = normalizePersonaProfile(
      this.cache.personaProfile,
    );
    try {
      this.cache.householdProfiles = normalizeHouseholdProfiles(
        saved.householdProfiles ?? [
          {
            id: "primary",
            label: "Gebruiker",
            personaProfile: this.cache.personaProfile,
            communicationPreferences: [],
          },
        ],
      );
    } catch {
      this.cache.householdProfiles = [
        {
          id: "primary",
          label: "Gebruiker",
          personaProfile: this.cache.personaProfile,
          communicationPreferences: [],
        },
      ];
    }
    const active = this.cache.householdProfiles.find(
      (profile) => profile.id === this.cache!.activeHouseholdProfileId,
    );
    this.cache.activeHouseholdProfileId =
      active?.id ?? this.cache.householdProfiles[0]!.id;
    this.cache.personaProfile =
      active?.personaProfile ?? this.cache.householdProfiles[0]!.personaProfile;
    this.cache.toolOverrides ||= {};
    this.cache.skills ||= [];
    this.cache.widgets ||= [];
    this.cache.helper = { ...blank().helper, ...this.cache.helper };
    this.cache.modelRoles = { ...defaultModelRoles, ...this.cache.modelRoles };
    try {
      this.cache.personaStyle = normalizePersonaStyle(this.cache.personaStyle);
    } catch {
      this.cache.personaStyle = "friendly";
    }
    return this.cache;
  }

  /** Keep the original bytes before the settings-page transition, including private skill headers.
   * The snapshot stays local at 0600, is never exported, and an existing snapshot is never overwritten.
   */
  backupBeforeSettingsPage(): void {
    const backup = `${this.file}.before-settings-page-v1`;
    if (fs.existsSync(backup) || !fs.existsSync(this.file)) return;
    const temporary = `${backup}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, fs.readFileSync(this.file), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      // Link a fully written file without replacing a snapshot another request already made.
      fs.linkSync(temporary, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  /** A copy: changing it changes nothing. */
  get(): NovaSettings {
    return structuredClone(this.load());
  }

  /** Change a copy, then save it. A change that throws leaves the saved settings alone. */
  update(change: (next: NovaSettings) => void): NovaSettings {
    const current = this.load();
    const next = structuredClone(current);
    change(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    const personaChanged = next.persona !== current.persona;
    if (personaChanged) this.writePersonaFile(next.persona);
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 1), {
        mode: 0o600,
      });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      if (personaChanged) this.writePersonaFile(current.persona);
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    this.cache = next;
    return structuredClone(next);
  }

  quickActions(): QuickAction[] {
    return this.load().quickActions ?? DEFAULT_QUICK_ACTIONS;
  }

  /** For tests: read the file again. */
  reset(): void {
    this.cache = null;
  }
}
