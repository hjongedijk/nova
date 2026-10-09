import type { Risk, ToolInfo } from "./tools.js";

/* ---------- skills ---------- */

/** Skills can only ever be read-only, safe or confirm: never DANGEROUS. */
export type SkillRisk = Extract<Risk, "READ_ONLY" | "SAFE" | "CONFIRM">;
export type SkillType = "instruction" | "webhook";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type SkillParameterType = "string" | "number" | "integer" | "boolean";

export interface SkillParameter {
  name: string;
  type: SkillParameterType;
  description: string;
  required: boolean;
  /** Only for type "string". */
  enum?: string[];
}

export interface SkillHeader {
  name: string;
  value: string;
}

/** What the screen sees of a secret header: its name, never its value. */
export interface SkillSecretHeader {
  name: string;
  set: true;
}

export interface SkillHttp {
  method: HttpMethod;
  url: string;
  headers: SkillHeader[];
  secretHeaders: SkillSecretHeader[];
  body: string;
  timeoutMs: number;
  allowPrivate: boolean;
  /** Path to the useful part of the answer, e.g. "data.items[0].name". */
  extract: string;
}

interface SkillBase {
  /** Slug of the name; never changes. The tool is called skill_<id>. */
  id: string;
  name: string;
  description: string;
  examples: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** A playbook NOVA follows with the tools it already has. */
export interface InstructionSkill extends SkillBase {
  type: "instruction";
  instructions: string;
}

/** An HTTP call with parameters of the user's own; becomes the tool skill_<id>. */
export interface WebhookSkill extends SkillBase {
  type: "webhook";
  parameters: SkillParameter[];
  http: SkillHttp;
  risk: SkillRisk;
}

/** A skill as the screen sees it (secret values removed). */
export type Skill = InstructionSkill | WebhookSkill;

/** What the screen sends to create or change a skill. Everything is validated by the server. */
export interface SkillInput {
  type?: SkillType;
  name?: string;
  description?: string;
  examples?: string[];
  enabled?: boolean;
  instructions?: string;
  parameters?: Partial<SkillParameter>[];
  risk?: string;
  http?: {
    method?: string;
    url?: string;
    body?: string;
    headers?: Partial<SkillHeader>[];
    /** An empty value keeps the stored secret. */
    secretHeaders?: Partial<SkillHeader>[];
    timeoutMs?: number;
    allowPrivate?: boolean;
    extract?: string;
  };
}

export interface SkillRun {
  at: string;
  ok: boolean;
  error: string | null;
  arguments: Record<string, unknown>;
}

/** POST /settings/skills/test */
export type SkillTestResult =
  | { ok: true; type: "instruction"; matched: boolean; phrase: string }
  | {
      type: "webhook";
      ok: boolean;
      error?: string;
      verified?: boolean | null;
      result?: {
        status: number;
        untrusted: true;
        response: unknown;
        note?: string;
        location?: string;
        truncated?: boolean;
      };
    };

/** POST /settings/skills/improve */
export interface SkillSuggestion {
  ok?: true;
  changes: {
    name?: string;
    description?: string;
    instructions?: string;
    examples?: string[];
    parameterDescriptions?: Record<string, string>;
  };
  notes: string;
}

/** POST /settings/skills/draft */
export interface SkillDraftResult {
  ok?: true;
  draft: SkillInput;
  fellBack: boolean;
  notes: string;
}

export interface MissingSecret {
  skill: string;
  headers: string[];
}

/* ---------- panels in the sidebar ---------- */

export type WidgetType = "value" | "list" | "buttons" | "note";

export interface WidgetSource {
  url: string;
  extract: string;
  allowPrivate: boolean;
}

export type WidgetButton =
  | { label: string; action: "ask"; prompt: string }
  | { label: string; action: "link"; url: string }
  | {
      label: string;
      action: "skill";
      skillId: string;
      args: Record<string, string | number | boolean>;
    };

interface WidgetBase {
  /** Slug of the title. The sidebar item is called w:<id>. */
  id: string;
  title: string;
  enabled: boolean;
}

export interface NoteWidget extends WidgetBase {
  type: "note";
  text: string;
}
export interface ButtonsWidget extends WidgetBase {
  type: "buttons";
  buttons: WidgetButton[];
}
export interface ValueWidget extends WidgetBase {
  type: "value";
  source: WidgetSource;
  refreshMinutes: number;
  unit: string;
}
export interface ListWidget extends WidgetBase {
  type: "list";
  source: WidgetSource;
  refreshMinutes: number;
  itemPath: string;
  max: number;
}

/** A panel as the settings screen has it (with the address of its data source). */
export type Widget = NoteWidget | ButtonsWidget | ValueWidget | ListWidget;

/** A panel as the home screen has it: the address of a data source stays on the server. */
export type PublicWidget =
  | NoteWidget
  | ButtonsWidget
  | Omit<ValueWidget, "source">
  | Omit<ListWidget, "source">;

/** What the screen sends to create or change a panel. */
export interface WidgetInput {
  type?: WidgetType;
  title?: string;
  enabled?: boolean;
  text?: string;
  buttons?: Partial<WidgetButton & { args: Record<string, unknown> }>[];
  source?: Partial<WidgetSource>;
  refreshMinutes?: number;
  unit?: string;
  itemPath?: string;
  max?: number;
}

/** Live data of one panel (GET /widgets/data answers a map of panel id to this). */
export type WidgetData = {
  kind?: WidgetType;
  at?: string;
  unit?: string;
  error?: string;
  value?: number | string;
  items?: string[];
};

/** POST /widgets/:id/press */
export type ButtonPress =
  | { action: "ask"; prompt: string }
  | { action: "link"; url: string }
  | { action: "ran"; ok: boolean; message: string };

/* ---------- sidebar layout ---------- */

export type SidebarColumn = "left" | "right";

export interface SidebarItem {
  /** A built-in panel id, or w:<widget id>. */
  id: string;
  column: SidebarColumn;
  page: number;
  shown: boolean;
}

export interface BuiltinPanel {
  id: string;
  name: string;
  column: SidebarColumn;
  page: number;
}

export type MaxPages = Record<SidebarColumn, number>;

/* ---------- abilities, persona, quick actions ---------- */

export interface Ability {
  id: string;
  name: string;
  description: string;
  example: string | null;
  /** True when switching it on lets NOVA change things. */
  changes?: boolean;
  /** Tool names. */
  tools: string[];
  total: number;
  enabledCount: number;
  state: "on" | "off" | "partial";
}

export interface QuickAction {
  label: string;
  prompt: string;
}

export interface ToolOverride {
  enabled?: false;
  description?: string;
}

/* ---------- the overview screens ---------- */

/** GET /settings */
export interface SettingsOverview {
  standingApprovals?: {
    id: string;
    tool: string;
    scope?: string;
    createdAt: number;
  }[];
  persona: string;
  quickActions: QuickAction[];
  quickActionsAreDefault: boolean;
  skills: Skill[];
  widgets: Widget[];
  sidebar: SidebarItem[];
  builtinPanels: BuiltinPanel[];
  maxPages: MaxPages;
  abilities: Ability[];
  tools: ToolInfo[];
  pinRequired: boolean;
}

/** GET /settings/public: no PIN needed. */
export interface PublicConfig {
  publicUrl: string;
  sidebar: SidebarItem[];
  widgets: PublicWidget[];
  maxPages: MaxPages;
  quickActions: QuickAction[];
  skillExamples: { name: string; examples: string[] }[];
}

/** GET /settings/export, and the body of POST /settings/import. */
export interface SettingsBackup {
  format: "nova-settings";
  version: 1;
  exportedAt: string;
  persona: string;
  quickActions: QuickAction[] | null;
  toolOverrides: Record<string, ToolOverride>;
  skills: Skill[];
  widgets: Widget[];
  sidebar: SidebarItem[] | null;
}

export interface ImportResult {
  ok: true;
  imported: number;
  missingSecrets: MissingSecret[];
}

/* ---------- wallpaper on the Windows PC ---------- */

export type WallpaperMode = "full" | "sphere" | "off";

export interface WallpaperDisplay {
  index: number;
  name: string;
  primary: boolean;
  width: number;
  height: number;
  mode: WallpaperMode;
}

/** What the Windows PC shows: NOVA as wallpaper, as a small helper overlay at the top, or both. */
export type HelperMode = "wallpaper" | "helper" | "both";

/** display 0 = the primary display, otherwise the display number (1, 2, ...). */
export interface HelperSettings {
  mode: HelperMode;
  display: number;
}

export type WallpaperState =
  | {
      available: true;
      displays: WallpaperDisplay[];
      /** What the agent is running now (absent on an agent that predates the helper). */
      mode?: HelperMode;
      helperDisplay?: number;
    }
  | {
      available: false;
      reason: "no-agent" | "old-agent" | "unreachable";
      error?: string;
    };

/** The helper choice as saved in NOVA, next to what the agent on the PC reports. */
export interface HelperState {
  settings: HelperSettings;
  desktop: WallpaperState;
  /** False when the choice was saved but the agent could not apply it (PC off, agent too old). */
  applied?: boolean;
  error?: string;
}

/** Non-secret helper appearance and sound preferences, persisted by NOVA. */
export interface HelperPreferences {
  wardrobe?: {
    theme: "nova" | "violet" | "gold";
    seasonal: boolean;
    birthday: string;
  };
  autohide: boolean;
  contrast: boolean;
  shape: "orb" | "ring" | "mist";
  cues: {
    enabled: boolean;
    volume: number;
    theme: "soft" | "playful" | "minimal";
    cues?: Record<string, boolean>;
    quiet: { enabled: boolean; start: string; end: string };
  };
}
