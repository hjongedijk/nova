import type { CommunicationPreference, PendingConfirmation } from "./chat.js";
import type { Risk, ToolInfo } from "./tools.js";
import type { ModelRolePreferences } from "./model-roles.js";

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

export interface SkillVersionHistory {
  currentVersion: number;
  scannedEntries: number;
  truncated: boolean;
  versions: { version: number; at: string; action: "created" | "updated" }[];
}

/** Private, PIN-protected content history for instruction skills only. */
export interface InstructionSkillContentRevision {
  id: string;
  skillId: string;
  at: string;
  before: {
    version: number;
    instructions: string;
    name?: string;
    description?: string;
    examples?: string[];
    enabled?: boolean;
  } | null;
  after: {
    version: number;
    instructions: string;
    name?: string;
    description?: string;
    examples?: string[];
    enabled?: boolean;
  };
}
export interface InstructionSkillContentHistory {
  currentVersion: number;
  revisions: InstructionSkillContentRevision[];
  truncated: boolean;
}
export interface InstructionSkillContentRollbackResult {
  ok: true;
  skill?: InstructionSkill;
  removed?: true;
  historyWarning?: string;
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

export type WidgetDisplaySnapshot =
  | { type: "value"; title: string; unit: string }
  | { type: "list"; title: string; itemPath: string; max: number };
export interface WidgetDisplayRevision {
  id: string;
  at: string;
  widgetId: string;
  before: WidgetDisplaySnapshot;
  after: WidgetDisplaySnapshot;
  revertedFrom?: string;
}
export interface WidgetDisplayHistory {
  revisions: WidgetDisplayRevision[];
  truncated: boolean;
}

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

export type PersonaStyleId =
  "professional" | "friendly" | "playful" | "concise";

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

export interface QuickActionRevision {
  id: string;
  at: string;
  before: QuickActionSnapshot;
  after: QuickActionSnapshot;
}
export interface QuickActionSnapshot {
  isDefault: boolean;
  items: QuickAction[];
}
export interface QuickActionHistory {
  revisions: QuickActionRevision[];
  truncated: boolean;
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
  personaStyle: PersonaStyleId;
  personaProfile: PersonaProfile;
  householdProfiles: HouseholdProfile[];
  activeHouseholdProfileId: string;
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

/** User-editable identity cues for the conversation role only. */
export interface PersonaProfile {
  name: string;
  character: string;
  address: string;
  avoid: string;
}

/** Shared-household persona switch; this does not isolate chat history or memory. */
export interface HouseholdProfile {
  id: string;
  label: string;
  personaProfile: PersonaProfile;
  communicationPreferences: CommunicationPreference[];
}

export interface PersonaPreferencesSnapshot {
  style: PersonaStyleId;
  profile: PersonaProfile;
}
export interface PersonaPreferencesRevision {
  id: string;
  at: string;
  before: PersonaPreferencesSnapshot;
  after: PersonaPreferencesSnapshot;
  revertedFrom?: string;
}
export interface PersonaPreferencesHistory {
  revisions: PersonaPreferencesRevision[];
  truncated: boolean;
}
export interface PersonaPreferencesRollbackResult {
  ok: true;
  snapshot: PersonaPreferencesSnapshot;
  auditWarning?: string;
}

export interface HouseholdProfileSwitchRevision {
  id: string;
  at: string;
  beforeProfileId: string;
  afterProfileId: string;
  revertedFrom?: string;
}
export interface HouseholdProfileSwitchHistory {
  revisions: HouseholdProfileSwitchRevision[];
  truncated: boolean;
}

export interface HouseholdProfileDefinitionRevision {
  id: string;
  at: string;
  beforeCount: number;
  afterCount: number;
  changedProfileIds: string[];
  revertedFrom?: string;
}
export interface HouseholdProfileDefinitionHistory {
  revisions: HouseholdProfileDefinitionRevision[];
  truncated: boolean;
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
  /** Optional to retain compatibility with earlier version-one exports. */
  helper?: { mode: HelperMode; display: number };
  helperPreferences?: HelperPreferences;
  /** Optional in older v1 files; model IDs are rechecked against free policy before use. */
  modelRoles?: ModelRolePreferences;
  /** Optional in older v1 files. Flow definitions only; credentials are never exported. */
  nodeRedFlows?: Record<string, unknown>[];
  /** False means Node-RED access was not configured when this backup was created. */
  nodeRedFlowsIncluded?: boolean;
  /** Optional in older v1 files. Contains named user lists, not timers or alerts. */
  lists?: Record<string, SettingsBackupListItem[]>;
  /** Optional in older v1 files. Excludes credentials and preserves those on import. */
  connections?: Record<string, Record<string, string | boolean>>;
  format: "nova-settings";
  version: 1;
  exportedAt: string;
  persona: string;
  /** Optional for compatibility with older version-one backups. */
  personaStyle?: PersonaStyleId;
  /** Optional in older v1 files. */
  personaProfile?: PersonaProfile;
  /** Optional in older v1 files. */
  householdProfiles?: HouseholdProfile[];
  activeHouseholdProfileId?: string;
  quickActions: QuickAction[] | null;
  toolOverrides: Record<string, ToolOverride>;
  skills: Skill[];
  widgets: Widget[];
  sidebar: SidebarItem[] | null;
}

export interface SettingsBackupListItem {
  id: string;
  text: string;
  addedAt: string;
}

/** Home Assistant entities are allowed by selected area, device, or entity ID. */
export interface HomeAssistantAccessPolicy {
  mode: "all" | "allowlist";
  areaIds: string[];
  deviceIds: string[];
  entityIds: string[];
}

export interface HomeAssistantAccessRevision {
  id: string;
  at: string;
  before: HomeAssistantAccessPolicy;
  after: HomeAssistantAccessPolicy;
  revertedFrom?: string;
}

export interface HomeAssistantAccessHistory {
  revisions: HomeAssistantAccessRevision[];
  truncated: boolean;
}

/** Allowlist for infrastructure targets exposed to NOVA's tools. */
export interface ManagedTargetsAccessPolicy {
  mode: "all" | "allowlist";
  proxmoxNodeIds: string[];
  /** Stable node/vmid pair, formatted as `<node>/<vmid>`. */
  proxmoxGuestIds: string[];
  termixHostIds: string[];
  pangolinSiteIds: string[];
  pangolinResourceIds: string[];
}

export interface ManagedTargetsAccessRevision {
  id: string;
  at: string;
  before: ManagedTargetsAccessPolicy;
  after: ManagedTargetsAccessPolicy;
  revertedFrom?: string;
}

export interface ManagedTargetsAccessHistory {
  revisions: ManagedTargetsAccessRevision[];
  truncated: boolean;
}

export interface ImportResult {
  ok: true;
  imported: number;
  importedLists: number;
  importedFlows: number;
  changedConnections: number;
  missingSecrets: MissingSecret[];
}

export interface SettingsImportSummary {
  connectionsChanged: boolean;
  changedConnections: number;
  connectionChanges: {
    service: string;
    before: Record<string, string | boolean>;
    after: Record<string, string | boolean>;
  }[];
  helperChanged: boolean;
  helperPreferencesChanged: boolean;
  modelRolesChanged: boolean;
  listsChanged: boolean;
  nodeRedFlowsChanged: boolean;
  personaChanged: boolean;
  personaProfileChanged: boolean;
  householdProfilesChanged: boolean;
  personaStyleChanged: boolean;
  quickActionsChanged: boolean;
  toolOverridesChanged: boolean;
  sidebarChanged: boolean;
  mode: "merge" | "replace";
  incomingSkills: number;
  totalSkills: number;
  incomingWidgets: number;
  totalWidgets: number;
  incomingLists: number;
  totalLists: number;
  removedLists: number;
  incomingFlows: number;
  totalFlows: number;
  removedFlows: number;
  replacedSkills: number;
  removedSkills: number;
  removedWidgets: number;
  missingSecrets: MissingSecret[];
}
export interface SettingsImportPrepared {
  ok: true;
  summary: SettingsImportSummary;
  action: PendingConfirmation;
}
export type SettingsImportResult =
  | (ImportResult & { cancelled?: true; auditWarning?: string })
  | { ok: false; error: string };

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
      historyWarning?: string;
      /** What the agent is running now (absent on an agent that predates the helper). */
      mode?: HelperMode;
      helperDisplay?: number;
    }
  | {
      available: false;
      reason: "no-agent" | "old-agent" | "unreachable";
      error?: string;
      historyWarning?: string;
    };

/** The helper choice as saved in NOVA, next to what the agent on the PC reports. */
export interface HelperState {
  settings: HelperSettings;
  desktop: WallpaperState;
  /** False when the choice was saved but the agent could not apply it (PC off, agent too old). */
  applied?: boolean;
  error?: string;
  historyWarning?: string;
}

/** Private settings projection of /v1/status; excludes user, host and process details. */
export interface WindowsAgentStatus {
  available: boolean;
  version: string | null;
  helperOpen: boolean | null;
  paused: boolean | null;
  mode: HelperMode | null;
  display: number | null;
  error?: string;
}

/** Read-only live window measurement returned by the Windows helper agent. */
export interface WindowsHelperDebugStatus {
  available: boolean;
  helper: string | null;
  view: string | null;
  display: number | null;
  checkedAt: string | null;
  error?: string;
}

/** Non-secret helper appearance and sound preferences, persisted by NOVA. */
export type NotificationMode = "screen" | "helper" | "speak";
export interface NotificationModes {
  info: NotificationMode;
  /** Optional for settings saved before briefing delivery had its own mode. */
  briefing?: NotificationMode;
  warning: NotificationMode;
  critical: NotificationMode;
  timer: NotificationMode;
}
export interface HelperPreferences {
  wardrobe?: {
    theme: "nova" | "violet" | "gold";
    seasonal: boolean;
    birthday: string;
  };
  autohide: boolean;
  contrast: boolean;
  shape: "orb" | "ring" | "mist";
  notifications?: NotificationModes;
  rituals?: {
    morning: { enabled: boolean; time: string };
    evening: { enabled: boolean; time: string };
    checkIn: { enabled: boolean; afterHours: number };
    weeklyOverview: { enabled: boolean; time: string };
    dailyHighlight: { enabled: boolean; time: string };
    smallSurprises: { enabled: boolean };
    welcomeHome: { enabled: boolean };
    calendarReminders: { enabled: boolean; minutesBefore: 5 | 15 | 30 };
  };
  cues: {
    enabled: boolean;
    volume: number;
    theme: "soft" | "playful" | "minimal";
    cues?: Record<string, boolean>;
    quiet: { enabled: boolean; start: string; end: string };
  };
}

/* ---------- private service connection management ---------- */
export interface ServiceConnectionField {
  key: string;
  label: string;
  kind: "url" | "text" | "boolean" | "secret";
  source: "environment" | "settings";
  value?: string | boolean;
  set?: boolean;
}
export interface ServiceConnection {
  id: string;
  label: string;
  fields: ServiceConnectionField[];
  restartRequired: boolean;
}
export interface ServiceConnectionRevision {
  id: string;
  service: string;
  at: string;
  before: Record<string, string | boolean>;
  after: Record<string, string | boolean>;
  secretChanges: string[];
  revertedFrom?: string;
}
export interface ServiceConnectionTest {
  ok: boolean;
  message: string;
  checkedAt: string;
  status?: number;
}

export interface MqttRecentMessage {
  topic: string;
  at: string;
  summary: string;
  delivery: "pending" | "accepted" | "failed";
}

export interface MqttOverview {
  connected: boolean;
  topics: string[];
  recent: MqttRecentMessage[];
}

export interface McpWorkerStatus {
  server: "sequential-thinking" | "filesystem" | "context7" | "workspace-git";
  state: "running" | "starting" | "stopped" | "missing" | "mixed";
  workerCount: number;
  connected: boolean | null;
}

export interface McpServerStatus {
  workers?: McpWorkerStatus[];
  servers: Array<{
    id: string;
    description?: string;
    rights?: string;
    howToDisable?: string;
    enabled: boolean;
    connected: boolean;
    toolCount: number;
    defaultRisk: Risk;
    tools: Array<{ name: string; risk: Risk }>;
  }>;
}

export interface McpServerCatalog {
  editable?: boolean;
  installed: string[];
  available: { id: string; description: string; rights: string; risk: Risk }[];
}

export interface McpServerConfigStatus {
  fields: Array<{ key: string; configured: boolean; value?: string }>;
}

export interface McpServerActivity {
  events: Array<{
    at: string;
    kind:
      | "connected"
      | "connection_failed"
      | "disconnected"
      | "connection_tested"
      | "connection_test_failed"
      | "tool_succeeded"
      | "tool_failed";
    tool?: string;
  }>;
  truncated: boolean;
}

export interface McpSettingRevision {
  id: string;
  at: string;
  server: string;
  change:
    | { kind: "enabled"; before: boolean; after: boolean }
    | {
        kind: "tool-risk";
        tool: string;
        before: Risk;
        after: Risk;
      }
    | { kind: "catalog"; operation: "add" | "remove" };
}

export interface McpSettingHistory {
  revisions: McpSettingRevision[];
  truncated: boolean;
}

export interface QdrantOverview {
  ok: boolean;
  message: string;
  truncated: boolean;
  activeMemoryCollection?: string | null;
  collections: {
    name: string;
    points: number | null;
    indexedVectors: number | null;
    segments: number | null;
    diskBytes: number | null;
    ramBytes: number | null;
    status: string;
  }[];
}

export interface WorkspaceProject {
  id: string;
  name: string;
  createdAt: string;
}

export interface WorkspaceProjectsReport {
  version: 1;
  activeId: string | null;
  projects: WorkspaceProject[];
  historyWarning?: string;
}

export interface WorkspaceProjectSelectionHistory {
  revisions: {
    id: string;
    at: string;
    kind?: "selection" | "created";
    projectId?: string;
    beforeId: string | null;
    afterId: string | null;
  }[];
  truncated: boolean;
}

export interface WorkspaceProjectSelectionPrepared {
  ok: boolean;
  error?: string;
  fromName?: string;
  toName?: string;
  action?: PendingConfirmation;
}

export interface WorkspaceProjectSelectionResult {
  ok: boolean;
  verified?: boolean;
  error?: string;
  auditWarning?: string;
  historyWarning?: string;
}

export interface QdrantIndexHistory {
  activeCollection: string | null;
  revisions: { id: string; at: string; points: number; current: boolean }[];
}

export interface ManagedTargetInventory {
  checkedAt: string;
  proxmox: {
    configured: boolean;
    error?: string;
    nodes: { id?: string; name: string }[];
    guests: { id?: string; name: string }[];
  };
  termix: {
    configured: boolean;
    error?: string;
    hosts: { id?: string; name: string }[];
  };
  pangolin: {
    configured: boolean;
    error?: string;
    sites: { id?: string; name: string }[];
    resources: { id?: string; name: string }[];
  };
}

export interface ServiceConnectionWrite {
  ok: true;
  services: ServiceConnection[];
  auditWarning?: string;
}
export interface ServiceRestartStatus {
  available: boolean;
  pendingChanges: boolean;
  restartPending: boolean;
  reason?: string;
}
export interface ServiceRestartResult {
  ok: boolean;
  error?: string;
  scheduled?: boolean;
}
export type StackServiceId =
  | "nova"
  | "node-red"
  | "omniroute"
  | "mqtt"
  | "qdrant"
  | "home-assistant"
  | "mcp-egress"
  | "stack-control";
export interface StackServiceStatus {
  id: StackServiceId;
  label: string;
  state:
    | "running"
    | "exited"
    | "created"
    | "restarting"
    | "paused"
    | "dead"
    | "missing"
    | "unknown";
  health: "healthy" | "unhealthy" | "starting" | null;
  canRestart: boolean;
  revision: string;
  startedAt?: string | null;
}
export interface StackControlStatus {
  mcpWorkers?: Omit<McpWorkerStatus, "connected">[];
  available: boolean;
  reason?: string;
  services: StackServiceStatus[];
}
export interface StackRestartPrepared {
  ok: boolean;
  service?: StackServiceId;
  label?: string;
  action?: PendingConfirmation;
  error?: string;
}
export interface StackRestartResult {
  ok: boolean;
  service?: StackServiceId;
  error?: string;
}
export interface HelperPreferenceRevision {
  id: string;
  at: string;
  before: HelperPreferences;
  after: HelperPreferences;
  revertedFrom?: string;
}
export interface HelperPreferenceHistory {
  revisions: HelperPreferenceRevision[];
  truncated: boolean;
}
export interface HelperPreferenceRollbackResult {
  ok: true;
  preferences: HelperPreferences;
  auditWarning?: string;
}
export interface HelperModeRevision {
  id: string;
  at: string;
  before: HelperSettings;
  after: HelperSettings;
  revertedFrom?: string;
}
export interface HelperModeHistory {
  revisions: HelperModeRevision[];
  truncated: boolean;
}
export interface WallpaperRevision {
  id: string;
  at: string;
  display: number;
  before: WallpaperMode;
  after: WallpaperMode;
  revertedFrom?: string;
}
export interface WallpaperHistory {
  revisions: WallpaperRevision[];
  truncated: boolean;
}
export interface NodeRedFlowInventory {
  revision: string | null;
  flows: {
    id: string;
    label: string;
    disabled: boolean;
    nodeCount: number;
    lastRun: string | null;
    lastError: string | null;
    runnableFlowId: string | null;
    manageable: boolean;
    templates: string[];
  }[];
  truncated: boolean;
  editorUrl: string | null;
}
export interface HelperHotkeys extends Record<string, string> {
  open: string;
  speak: string;
  mute: string;
  desktop: string;
}
export interface HelperHotkeyRevision {
  id: string;
  at: string;
  before: HelperHotkeys;
  after: HelperHotkeys;
  revertedFrom?: string;
}
export interface HelperHotkeyHistory {
  revisions: HelperHotkeyRevision[];
  truncated: boolean;
}
export interface HelperHotkeyRollbackResult {
  ok: boolean;
  error?: string;
  hotkeys?: HelperHotkeys;
  warnings?: string[];
  historyWarning?: string;
}
export interface PersonaRevision {
  id: string;
  at: string;
  before: string;
  after: string;
  revertedFrom?: string;
}
export interface PersonaHistory {
  revisions: PersonaRevision[];
  truncated: boolean;
}
export interface PersonaRollbackResult {
  ok: true;
  persona: string;
  auditWarning?: string;
}
export interface ToolSwitchRevision {
  id: string;
  at: string;
  before: Record<string, boolean>;
  after: Record<string, boolean>;
  revertedFrom?: string;
}
export interface ToolSwitchHistory {
  revisions: ToolSwitchRevision[];
  truncated: boolean;
}
export interface ToolSwitchRollbackResult {
  ok: true;
  auditWarning?: string;
}
export interface ToolDescriptionRevision {
  id: string;
  at: string;
  tool: string;
  before: string | null;
  after: string | null;
}
export interface ToolDescriptionHistory {
  revisions: ToolDescriptionRevision[];
  truncated: boolean;
}
export interface SidebarRevision {
  id: string;
  at: string;
  before: SidebarItem[];
  after: SidebarItem[];
  revertedFrom?: string;
}
export interface SidebarHistory {
  revisions: SidebarRevision[];
  truncated: boolean;
}
export interface SidebarRollbackResult {
  ok: true;
  sidebar: SidebarItem[];
  auditWarning?: string;
}

/** Private projections of the bounded audit tail, with no arguments or session identifiers. */
export interface ToolUsageReport {
  scannedEntries: number;
  entryLimit: 500;
  logByteLimit: 2000000;
  activityLimit: 50;
  oldestAt: string | null;
  latestAt: string | null;
  toolsTruncated: boolean;
  recentActivity: {
    at: string;
    tool: string;
    source: string;
    context: "chat" | "settings" | "background" | "unknown";
    ok: boolean;
    errorType?:
      | "timeout"
      | "authorization"
      | "not_found"
      | "invalid_request"
      | "unavailable"
      | "other";
  }[];
  tools: {
    name: string;
    source: string;
    risk: Risk;
    enabled: boolean;
    attempts: number;
    okResults: number;
    failedResults: number;
    lastAt: string | null;
    averageDurationMs: number | null;
    contexts: {
      chat: number;
      settings: number;
      background: number;
      unknown: number;
    };
  }[];
}
