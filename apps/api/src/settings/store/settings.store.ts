import type { HelperPreferences } from "@nova/contracts";
import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../../core/config/nova-config.js";

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
  quickActions: QuickAction[] | null;
  toolOverrides: Record<string, ToolOverride>;
  skills: Record<string, unknown>[];
  widgets: Record<string, unknown>[];
  sidebar: { items: Record<string, unknown>[] } | null;
  /** What the Windows PC shows: the wallpaper (default), the helper overlay, or both. */
  helper: HelperChoice;
}

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
    cues: {
      enabled: true,
      volume: 0.35,
      theme: "soft",
      quiet: { enabled: false, start: "22:00", end: "07:00" },
    },
  },
  persona: "",
  quickActions: null,
  toolOverrides: {},
  skills: [],
  widgets: [],
  sidebar: null,
  helper: { mode: "wallpaper", display: 0 },
});

/**
 * settings.json: written atomically and readable only by NOVA, because skills may hold secrets.
 * A damaged file is set aside for inspection, never overwritten silently.
 */
@Injectable()
export class SettingsStore {
  private cache: NovaSettings | null = null;
  private readonly file: string;

  constructor(config: NovaConfig) {
    this.file = config.dataFile("settings.json");
  }

  private load(): NovaSettings {
    if (this.cache) return this.cache;
    try {
      this.cache = {
        ...blank(),
        ...(JSON.parse(
          fs.readFileSync(this.file, "utf8"),
        ) as Partial<NovaSettings>),
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
    this.cache.toolOverrides ||= {};
    this.cache.skills ||= [];
    this.cache.widgets ||= [];
    this.cache.helper = { ...blank().helper, ...this.cache.helper };
    return this.cache;
  }

  /** A copy: changing it changes nothing. */
  get(): NovaSettings {
    return structuredClone(this.load());
  }

  /** Change a copy, then save it. A change that throws leaves the saved settings alone. */
  update(change: (next: NovaSettings) => void): NovaSettings {
    const next = structuredClone(this.load());
    change(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 1), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
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
