import type {
  ToolUsageReport,
  FreePolicyOptions,
  FreePolicySelection,
  FreePolicyPrepared,
  FreePolicyResult,
  FreePolicyHistory,
  OmniRouteAccountsReport,
  OmniRouteApiKeyInventory,
  OmniRouteUsageReport,
  OmniRouteModelVisibilityReport,
  OmniRouteAccountRemovalPrepared,
  OmniRouteAccountRemovalResult,
  OmniRouteAccountCreatePrepared,
  OmniRouteAccountCreateResult,
  OmniRouteAccountKeyUpdatePrepared,
  OmniRouteAccountKeyUpdateResult,
  OmniRouteAccountRenamePrepared,
  OmniRouteAccountRenameResult,
  OmniRouteAccountRenameHistory,
  OmniRouteAccountActivationPrepared,
  OmniRouteAccountActivationResult,
  OmniRouteActivationHistoryEntry,
  OmniRouteKeyActivationPrepareResult,
  OmniRouteKeyActivationResult,
  OmniRouteKeyModelAccessOptions,
  OmniRouteKeyModelAccessHistory,
  OmniRouteKeyModelAccessPrepareResult,
  OmniRouteKeyModelAccessResult,
  OmniRouteComboCreatePrepared,
  OmniRouteComboCreateResult,
  OmniRouteComboRemovalPrepared,
  OmniRouteComboRemovalResult,
  OmniRouteComboUpdatePrepared,
  OmniRouteComboUpdateHistory,
  OmniRouteTokenLimitsReport,
  OmniRouteTokenLimitPrepared,
  OmniRouteTokenLimitResult,
  OmniRouteTokenResetInterval,
  OmniRouteComboUpdateResult,
  OmniRouteComboActivationPrepared,
  OmniRouteComboActivationResult,
  ModelRoleHistory,
  ModelRolesSettings,
  PersonaProfile,
  HouseholdProfile,
  MqttOverview,
  McpServerStatus,
  McpServerCatalog,
  McpServerConfigStatus,
  McpServerActivity,
  McpSettingHistory,
  Risk,
  QdrantOverview,
  QdrantIndexHistory,
  ManagedTargetInventory,
  InstructionSkillContentHistory,
  InstructionSkillContentRollbackResult,
  QuickActionHistory,
  StackControlStatus,
  StackRestartPrepared,
  StackRestartResult,
  StackServiceId,
  ManagedTargetsAccessHistory,
  PendingConfirmation,
  WorkspaceProjectsReport,
  WorkspaceProjectSelectionHistory,
  WorkspaceProjectSelectionPrepared,
  WorkspaceProjectSelectionResult,
} from "@nova/contracts";
import type {
  NativeGatewayReport,
  NativeMemoryPrepared,
  NativeMemoryRecordPrepared,
  NativeMemoryRecordResult,
  NativeMemoryRecordsDeletePrepared,
  NativeMemoryHistory,
  NativeMemoryRecords,
  NativeMemoryResult,
  NativeSkillDocument,
  NativeSkillMode,
  NativeSkillModeHistory,
  NativeSkillModePrepared,
  NativeSkillModeResult,
  NativeSkillRemovalPrepared,
  NativeSkillRemovalResult,
  NativePromptReplacement,
  NativePromptPrepared,
  NativePromptResult,
  NativePromptHistory,
  WindowsAgentStatus,
  WindowsHelperDebugStatus,
  HelperHotkeyHistory,
  HelperHotkeyRollbackResult,
  UpdateReport,
  ModelMetricsReport,
  SettingsImportPrepared,
  SettingsImportResult,
  ServiceConnection,
  ServiceConnectionRevision,
  ServiceConnectionTest,
  ServiceConnectionWrite,
  ServiceRestartStatus,
  ServiceRestartResult,
  HelperPreferenceHistory,
  HelperPreferenceRollbackResult,
  HelperModeHistory,
  ToolSwitchHistory,
  ToolSwitchRollbackResult,
  ToolDescriptionHistory,
  SidebarHistory,
  SidebarRollbackResult,
  PersonaHistory,
  PersonaRollbackResult,
  PersonaPreferencesHistory,
  PersonaPreferencesRollbackResult,
  PersonaStyleId,
  HelperPreferences,
  Skill,
  SkillDraftResult,
  SkillInput,
  SkillRun,
  SkillVersionHistory,
  SkillSuggestion,
  SkillTestResult,
  SettingsBackup,
  SettingsOverview,
  HomeAssistantAccessPolicy,
  HomeAssistantAccessHistory,
  HouseholdProfileSwitchHistory,
  HouseholdProfileDefinitionHistory,
  ManagedTargetsAccessPolicy,
  SidebarItem,
  ToolOverride,
  Widget,
  WidgetInput,
  WidgetPreviewResult,
  HelperMode,
  HelperState,
  WallpaperMode,
  WallpaperHistory,
  NodeRedFlowInventory,
  WallpaperState,
  QuickAction,
  WidgetDisplayHistory,
} from "@nova/contracts";
import { getJson, sendJson } from "./client.ts";
import { getPin } from "./pin-session.ts";
export { getPin, setPin, PIN_KEY } from "./pin-session.ts";

/** Every settings call carries these; writes also need x-nova-admin. */
function headers(): Record<string, string> {
  const pin = getPin();
  return { "x-nova-admin": "1", ...(pin ? { "x-nova-pin": pin } : {}) };
}

const read = <T>(path: string) =>
  getJson<T>(`/settings${path}`, { headers: headers() });
const write = <T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) => sendJson<T>(method, `/settings${path}`, body, headers());

const enc = encodeURIComponent;

export interface YoutubeOAuthStatus {
  configured: boolean;
  connected: boolean;
  callbackUrl: string | null;
}
export const getYoutubeOAuthStatus = () =>
  read<YoutubeOAuthStatus>("/youtube/oauth/status");
export const saveYoutubeOAuthClient = (
  clientId: string,
  clientSecret: string,
) =>
  write<YoutubeOAuthStatus>("POST", "/youtube/oauth/config", {
    clientId,
    clientSecret,
  });
export const startYoutubeOAuth = () =>
  write<{ authorizationUrl: string }>("POST", "/youtube/oauth/start", {});
export const disconnectYoutubeOAuth = () =>
  write<YoutubeOAuthStatus>("POST", "/youtube/oauth/disconnect", {});

export const getSettings = () => read<SettingsOverview>("");
export const getNativeGateway = () =>
  read<NativeGatewayReport>("/omniroute/native");
export const prepareNativeMemory = (
  enabled: boolean,
  acknowledgeGlobal: true,
) =>
  write<NativeMemoryPrepared>("POST", "/omniroute/native/memory/prepare", {
    enabled,
    acknowledgeGlobal,
  });
export const getNativeMemoryHistory = () =>
  read<NativeMemoryHistory>("/omniroute/native/memory/history");
export const getNativeMemoryRecords = (offset = 0) =>
  read<NativeMemoryRecords>(`/omniroute/native/memories?offset=${offset}`);
export const prepareNativeMemoryRecordDelete = (id: string) =>
  write<NativeMemoryRecordPrepared>(
    "POST",
    "/omniroute/native/memories/delete/prepare",
    { id },
  );
export const prepareNativeMemoryRecordsDelete = (ids: string[]) =>
  write<NativeMemoryRecordsDeletePrepared>(
    "POST",
    "/omniroute/native/memories/delete-many/prepare",
    { ids },
  );
export const prepareNativeMemoryRecordUpdate = (id: string, content: string) =>
  write<NativeMemoryRecordPrepared>(
    "POST",
    "/omniroute/native/memories/update/prepare",
    { id, content },
  );
export const confirmNativeMemoryRecordUpdate = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<NativeMemoryRecordResult>(
    "POST",
    "/omniroute/native/memories/update/confirm",
    {
      sessionId,
      confirmationId,
      approve,
    },
  );
export const confirmNativeMemoryRecordDelete = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<NativeMemoryRecordResult>(
    "POST",
    "/omniroute/native/memories/delete/confirm",
    {
      sessionId,
      confirmationId,
      approve,
    },
  );
export const confirmNativeMemoryRecordsDelete = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<NativeMemoryRecordResult>(
    "POST",
    "/omniroute/native/memories/delete-many/confirm",
    { sessionId, confirmationId, approve },
  );
export const prepareNativeMemoryRollback = (revisionId: string) =>
  write<NativeMemoryPrepared>(
    "POST",
    "/omniroute/native/memory/rollback/prepare",
    { revisionId, acknowledgeGlobal: true },
  );
export const confirmNativeMemory = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<NativeMemoryResult>("POST", "/omniroute/native/memory/confirm", {
    sessionId,
    confirmationId,
    approve,
  });
export const prepareNativePrompt = (value: NativePromptReplacement) =>
  write<NativePromptPrepared>(
    "POST",
    "/omniroute/native/prompt/prepare",
    value,
  );
export const getNativePromptHistory = () =>
  read<NativePromptHistory>("/omniroute/native/prompt/history");
export const confirmNativePrompt = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<NativePromptResult>("POST", "/omniroute/native/prompt/confirm", {
    sessionId,
    confirmationId,
    approve,
  });
export const prepareNativeSkillMode = (
  id: string,
  mode: NativeSkillMode,
  acknowledgeGlobal = false,
) =>
  write<NativeSkillModePrepared>(
    "POST",
    `/omniroute/native/skills/${enc(id)}/prepare`,
    { mode, acknowledgeGlobal },
  );
export const getNativeSkillModeHistory = (id: string) =>
  read<NativeSkillModeHistory>(
    `/omniroute/native/skills/${encodeURIComponent(id)}/history`,
  );
export const prepareNativeSkillModeRollback = (
  id: string,
  revisionId: string,
  acknowledgeGlobal: boolean,
) =>
  write<NativeSkillModePrepared>(
    "POST",
    `/omniroute/native/skills/${encodeURIComponent(id)}/rollback/prepare`,
    { revisionId, acknowledgeGlobal },
  );
export const confirmNativeSkillMode = (
  id: string,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<NativeSkillModeResult>(
    "POST",
    `/omniroute/native/skills/${enc(id)}/confirm`,
    { sessionId, confirmationId, approve },
  );
export const prepareNativeSkillRemoval = (id: string) =>
  write<NativeSkillRemovalPrepared>(
    "POST",
    `/omniroute/native/skills/${enc(id)}/remove/prepare`,
    {},
  );
export const confirmNativeSkillRemoval = (
  id: string,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<NativeSkillRemovalResult>(
    "POST",
    `/omniroute/native/skills/${enc(id)}/remove/confirm`,
    { sessionId, confirmationId, approve },
  );
export const getNativeSkillDocument = (id: string) =>
  read<NativeSkillDocument>(`/omniroute/native/documentation/${enc(id)}`);
export const getModelMetrics = () =>
  read<ModelMetricsReport>("/models/metrics");
export const getModelRoles = () => read<ModelRolesSettings>("/model-roles");
export const saveModelRoles = (roles: ModelRolesSettings["roles"]) =>
  write<ModelRolesSettings>("PUT", "/model-roles", roles);
export const getModelRoleHistory = () =>
  read<ModelRoleHistory>("/model-roles/history");
export const rollbackModelRoleHistory = (id: string) =>
  write<ModelRolesSettings>(
    "POST",
    `/model-roles/history/${enc(id)}/rollback`,
    {},
  );
export const getWorkspaceProjects = () =>
  read<WorkspaceProjectsReport>("/workspace/projects");
export const createWorkspaceProject = (name: string) =>
  write<WorkspaceProjectsReport>("POST", "/workspace/projects", { name });
export const selectWorkspaceProject = (id: string) =>
  write<WorkspaceProjectsReport>("PUT", "/workspace/projects/active", { id });
export const getWorkspaceProjectSelectionHistory = () =>
  read<WorkspaceProjectSelectionHistory>("/workspace/projects/history");
export const prepareWorkspaceProjectSelectionRollback = (revision: string) =>
  write<WorkspaceProjectSelectionPrepared>(
    "POST",
    `/workspace/projects/history/${enc(revision)}/prepare-rollback`,
    {},
  );
export const confirmWorkspaceProjectSelectionRollback = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<WorkspaceProjectSelectionResult>(
    "POST",
    "/workspace/projects/history/confirm-rollback",
    { sessionId, confirmationId, approve },
  );
export const getWorkspaceCodeTree = () =>
  read<{
    projectId: string;
    files: { path: string; bytes: number }[];
    truncated: boolean;
  }>("/workspace/code/tree");
export const getWorkspaceCodeFile = (path: string) =>
  read<{ path: string; bytes: number; sha256: string; content: string }>(
    `/workspace/code/file?path=${enc(path)}`,
  );
export const getWorkspaceCodeRun = () =>
  read<{
    projectId: string;
    command: string[];
    output: string;
    exitCode: number | null;
    durationMs: number;
  } | null>("/workspace/code/latest-run");
export const getUpdates = () => read<UpdateReport>("/updates");
export const checkUpdates = () => write<UpdateReport>("POST", "/updates/check");

export const savePersona = (text: string) =>
  write<{ ok: true; persona: string; historyWarning?: string }>(
    "PUT",
    "/persona",
    { text },
  );
export const savePersonaStyle = (style: PersonaStyleId) =>
  write<{ ok: true; personaStyle: PersonaStyleId }>("PUT", "/persona/style", {
    style,
  });
export const savePersonaProfile = (profile: PersonaProfile) =>
  write<{ ok: true; personaProfile: PersonaProfile }>(
    "PUT",
    "/persona/profile",
    { profile },
  );
export const saveHouseholdProfiles = (
  profiles: HouseholdProfile[],
  activeProfileId: string,
) =>
  write<{
    ok: true;
    householdProfiles: HouseholdProfile[];
    activeHouseholdProfileId: string;
  }>("PUT", "/household-profiles", { profiles, activeProfileId });
export const getHouseholdProfileHistory = () =>
  read<HouseholdProfileSwitchHistory>("/household-profiles/history");
export const rollbackHouseholdProfile = (id: string) =>
  write<{ ok: true; activeHouseholdProfileId: string; auditWarning?: string }>(
    "POST",
    `/household-profiles/history/${enc(id)}/rollback`,
    {},
  );
export const getHouseholdProfileDefinitionHistory = () =>
  read<HouseholdProfileDefinitionHistory>(
    "/household-profiles/definitions/history",
  );
export const rollbackHouseholdProfileDefinition = (id: string) =>
  write<{
    ok: true;
    householdProfiles: HouseholdProfile[];
    activeHouseholdProfileId: string;
    auditWarning?: string;
  }>("POST", `/household-profiles/definitions/history/${enc(id)}/rollback`, {});
export const getPersonaPreferencesHistory = () =>
  read<PersonaPreferencesHistory>("/persona/preferences/history");
export const rollbackPersonaPreferences = (id: string) =>
  write<PersonaPreferencesRollbackResult>(
    "POST",
    `/persona/preferences/history/${enc(id)}/rollback`,
    {},
  );
export const getPersonaHistory = () => read<PersonaHistory>("/persona/history");
export const rollbackPersonaRevision = (id: string) =>
  write<PersonaRollbackResult>(
    "POST",
    `/persona/history/${enc(id)}/rollback`,
    {},
  );
export const getInstructionSkillContentHistory = (id: string) =>
  read<InstructionSkillContentHistory>(`/skills/${enc(id)}/content-history`);
export const rollbackInstructionSkillContent = (id: string, revision: string) =>
  write<InstructionSkillContentRollbackResult>(
    "POST",
    `/skills/${enc(id)}/content-history/${enc(revision)}/rollback`,
    {},
  );

export const saveQuickActions = (items: QuickAction[]) =>
  write<{ ok: true; quickActions: QuickAction[]; historyWarning?: string }>(
    "PUT",
    "/quick-actions",
    { items },
  );
export const resetQuickActions = () =>
  write<{ ok: true; quickActions: QuickAction[]; historyWarning?: string }>(
    "PUT",
    "/quick-actions",
    { reset: true },
  );
export const getQuickActionsHistory = () =>
  read<QuickActionHistory>("/quick-actions/history");
export const rollbackQuickActions = (id: string) =>
  write<{ ok: true; quickActions: QuickAction[]; auditWarning?: string }>(
    "POST",
    `/quick-actions/history/${enc(id)}/rollback`,
    {},
  );

export const saveToolOverride = (name: string, override: ToolOverride) =>
  write<{ ok: true; override: ToolOverride; historyWarning?: string }>(
    "PUT",
    `/tools/${enc(name)}`,
    override,
  );
export const getToolDescriptionHistory = (name: string) =>
  read<ToolDescriptionHistory>(`/tools/${enc(name)}/description-history`);
export const rollbackToolDescription = (name: string, id: string) =>
  write<{ ok: true; description: string | null; auditWarning?: string }>(
    "POST",
    `/tools/${enc(name)}/description-history/${enc(id)}/rollback`,
    {},
  );
export const resetTool = (name: string) =>
  write<{ ok: true; historyWarning?: string }>("DELETE", `/tools/${enc(name)}`);

export const setAbility = (id: string, enabled: boolean) =>
  write<{ ok: true; auditWarning?: string }>("PUT", `/abilities/${enc(id)}`, {
    enabled,
  });

/* ---------- skills ---------- */

export const draftSkill = (description: string) =>
  write<SkillDraftResult>("POST", "/skills/draft", { description });
export const createSkill = (skill: SkillInput) =>
  write<{ ok: true; skill: Skill }>("POST", "/skills", skill);
export const updateSkill = (id: string, skill: SkillInput | Skill) =>
  write<{ ok: true; skill: Skill }>("PUT", `/skills/${enc(id)}`, skill);
export const deleteSkill = (id: string) =>
  write<{ ok: true }>("DELETE", `/skills/${enc(id)}`);
export const testSkill = (
  skill: SkillInput,
  extra: { phrase?: string; args?: Record<string, unknown> },
) => write<SkillTestResult>("POST", "/skills/test", { skill, ...extra });
export const skillRuns = (id: string) =>
  read<{ runs: SkillRun[] }>(`/skills/${enc(id)}/runs`);
export const skillVersions = (id: string) =>
  read<SkillVersionHistory>(`/skills/${enc(id)}/versions`);
export const improveSkill = (skill: SkillInput, goal: string) =>
  write<SkillSuggestion>("POST", "/skills/improve", { skill, goal });

/* ---------- sidebar panels ---------- */

export const createWidget = (widget: WidgetInput) =>
  write<{ widget: Widget; historyWarning?: string }>(
    "POST",
    "/widgets",
    widget,
  );
export const updateWidget = (id: string, widget: WidgetInput) =>
  write<{ widget: Widget; historyWarning?: string }>(
    "PUT",
    `/widgets/${enc(id)}`,
    widget,
  );
export type NoteWidgetRevision = {
  id: string;
  at: string;
  before: string;
  after: string;
  beforeSnapshot?: { title: string; enabled: boolean; text: string };
  afterSnapshot?: { title: string; enabled: boolean; text: string };
  createdSnapshot?: { title: string; enabled: boolean; text: string };
  revertedFrom?: string;
};
export const getNoteWidgetHistory = (id: string) =>
  read<{ revisions: NoteWidgetRevision[]; truncated: boolean }>(
    `/widgets/${enc(id)}/history`,
  );
export const rollbackNoteWidget = (id: string, revision: string) =>
  write<{
    ok: true;
    widget?: Widget;
    removed?: true;
    historyWarning?: string;
  }>("POST", `/widgets/${enc(id)}/history/${enc(revision)}/rollback`, {});
export const deleteWidget = (id: string) =>
  write<{ ok: true; historyWarning?: string }>("DELETE", `/widgets/${enc(id)}`);
export const previewWidget = (widget: WidgetInput) =>
  write<WidgetPreviewResult>("POST", "/widgets/preview", widget);

export const saveSidebar = (items: SidebarItem[]) =>
  write<{ sidebar: SidebarItem[] }>("PUT", "/sidebar", { items });
export const resetSidebar = () =>
  write<{ sidebar: SidebarItem[] }>("PUT", "/sidebar", { reset: true });

/* ---------- wallpaper, back-up ---------- */

export const getWallpaper = () => read<WallpaperState>("/wallpaper");
export const setWallpaper = (display: number, mode: WallpaperMode) =>
  write<WallpaperState>("POST", "/wallpaper", { display, mode });
export const getWallpaperHistory = () =>
  read<WallpaperHistory>("/wallpaper/history");
export const rollbackWallpaper = (id: string) =>
  write<WallpaperState>("POST", `/wallpaper/history/${enc(id)}/rollback`, {});
export const getNodeRedFlows = () =>
  read<NodeRedFlowInventory>("/node-red/flows");
export const exportNodeRedFlows = () =>
  write<Record<string, unknown>[]>("POST", "/node-red/flows/export", {});
export interface NodeRedFlowRevision {
  id: string;
  at: string;
  nodeCount: number;
}
export const getNodeRedFlowRevisions = () =>
  read<{ revisions: NodeRedFlowRevision[]; truncated: boolean }>(
    "/node-red/flow-revisions",
  );
export const captureNodeRedFlowRevision = () =>
  write<NodeRedFlowRevision>("POST", "/node-red/flow-revisions/capture", {});
export const prepareNodeRedFlowRestore = (id: string) =>
  write<{
    ok: true;
    warning: string;
    action: PendingConfirmation;
  }>("POST", `/node-red/flow-revisions/${enc(id)}/prepare-restore`, {});
export const confirmNodeRedFlowRestore = (
  id: string,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<
    | { ok: true; cancelled: true }
    | {
        ok: true;
        revision: NodeRedFlowRevision & { historyWarning?: string };
      }
    | { ok: false; error: string }
  >("POST", `/node-red/flow-revisions/${enc(id)}/confirm-restore`, {
    sessionId,
    confirmationId,
    approve,
  });

export const getHelper = () => read<HelperState>("/helper");
export const getWindowsAgentStatus = () =>
  read<WindowsAgentStatus>("/windows/status");
export const getWindowsHelperDebug = () =>
  read<WindowsHelperDebugStatus>("/windows/helper-debug");
export const setHelper = (mode: HelperMode, display: number) =>
  write<HelperState>("POST", "/helper", { mode, display });

export const exportSettings = () => read<SettingsBackup>("/export");
export const prepareSettingsImport = (
  data: unknown,
  mode: "merge" | "replace",
) =>
  write<SettingsImportPrepared>("POST", "/import/prepare", {
    data,
    mode,
    acknowledgeEffects: true,
  });
export const importSettings = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<SettingsImportResult>("POST", "/import", {
    sessionId,
    confirmationId,
    approve,
  });

export const revokeStandingApproval = (id: string) =>
  write<{ ok: true }>("DELETE", `/standing-approvals/${enc(id)}`);

export interface HelperHotkeys {
  ok: boolean;
  error?: string;
  historyWarning?: string;
  preferences?: {
    hotkeys: Record<string, string>;
    warnings: string[];
    paused: boolean;
  };
}
export const getHelperHotkeys = () => read<HelperHotkeys>("/helper/hotkeys");
export const saveHelperHotkeys = (hotkeys: Record<string, string>) =>
  write<HelperHotkeys>("PUT", "/helper/hotkeys", { hotkeys });
export const getHelperHotkeyHistory = () =>
  read<HelperHotkeyHistory>("/helper/hotkeys/history");
export const rollbackHelperHotkeys = (id: string) =>
  write<HelperHotkeyRollbackResult>(
    "POST",
    `/helper/hotkeys/history/${enc(id)}/rollback`,
    {},
  );

export const getHelperPreferences = () =>
  read<HelperPreferences>("/helper/preferences");
export const persistHelperPreferences = (preferences: HelperPreferences) =>
  write<{
    ok: true;
    preferences: HelperPreferences;
    auditWarning?: string;
  }>("PUT", "/helper/preferences", preferences);
export const getHelperPreferenceHistory = () =>
  read<HelperPreferenceHistory>("/helper/preferences/history");
export const rollbackHelperPreferenceRevision = (id: string) =>
  write<HelperPreferenceRollbackResult>(
    "POST",
    `/helper/preferences/history/${enc(id)}/rollback`,
    {},
  );
export const getHelperModeHistory = () =>
  read<HelperModeHistory>("/helper/history");
export const rollbackHelperModeRevision = (id: string) =>
  write<HelperState>("POST", `/helper/history/${enc(id)}/rollback`, {});
export const getToolSwitchHistory = () =>
  read<ToolSwitchHistory>("/tools/history");
export const rollbackToolSwitchRevision = (id: string) =>
  write<ToolSwitchRollbackResult>(
    "POST",
    `/tools/history/${enc(id)}/rollback`,
    {},
  );
export const getSidebarHistory = () => read<SidebarHistory>("/sidebar/history");
export const rollbackSidebarRevision = (id: string) =>
  write<SidebarRollbackResult>(
    "POST",
    `/sidebar/history/${enc(id)}/rollback`,
    {},
  );

/* ---------- service connections (credentials never returned) ---------- */
export const getServiceConnections = () =>
  read<{ services: ServiceConnection[] }>("/services");
export const getServiceConnectionStatus = (id: string) =>
  read<{ test: ServiceConnectionTest | null }>(`/services/${enc(id)}/status`);
export const getServiceRestartStatus = () =>
  read<ServiceRestartStatus>("/services/restart");
export const requestServiceRestart = () =>
  write<ServiceRestartResult>("POST", "/services/restart", {});

export const getStackControlStatus = () =>
  read<StackControlStatus>("/stack-control/services");
export const prepareStackServiceRestart = (service: StackServiceId) =>
  write<StackRestartPrepared>("POST", "/stack-control/restart/prepare", {
    service,
  });
export const confirmStackServiceRestart = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<StackRestartResult>("POST", "/stack-control/restart/confirm", {
    sessionId,
    confirmationId,
    approve,
  });
export const getMqttOverview = () =>
  read<MqttOverview>("/services/mqtt/overview");
export const getMcpServerStatus = () => read<McpServerStatus>("/mcp/servers");
export const getMcpServerCatalog = () =>
  read<McpServerCatalog>("/mcp/servers/catalog");
export const getMcpServerConfig = (id: string) =>
  read<McpServerConfigStatus>(`/mcp/servers/${enc(id)}/config`);
export const saveMcpServerConfig = (
  id: string,
  values: Record<string, string>,
  clear = false,
) =>
  write<McpServerConfigStatus>("POST", `/mcp/servers/${enc(id)}/config`, {
    values,
    clear,
  });
export const prepareMcpServerCatalogChange = (
  id: string,
  operation: "add" | "remove",
) =>
  write<{
    ok: boolean;
    error?: string;
    warning?: string;
    action?: PendingConfirmation;
  }>("POST", `/mcp/servers/${enc(id)}/prepare-catalog`, { operation });
export const confirmMcpServerCatalogChange = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<{
    ok: boolean;
    verified?: boolean | null;
    cancelled?: boolean;
    server?: string;
    operation?: "add" | "remove";
    warning?: string;
    error?: string;
  }>("POST", "/mcp/servers/confirm-catalog", {
    sessionId,
    confirmationId,
    approve,
  });
export const getMcpServerActivity = (id: string) =>
  read<McpServerActivity>(`/mcp/servers/${enc(id)}/activity`);
export const getMcpServerHistory = (id: string) =>
  read<McpSettingHistory>(`/mcp/servers/${enc(id)}/history`);
export const prepareMcpServerHistoryRollback = (
  id: string,
  revisionId: string,
) =>
  write<{
    ok: boolean;
    error?: string;
    warning?: string;
    action?: PendingConfirmation;
  }>(
    "POST",
    `/mcp/servers/${enc(id)}/history/${enc(revisionId)}/prepare-rollback`,
    {},
  );
export const testMcpServerConnection = (id: string) =>
  write<{ ok: boolean; toolCount: number }>(
    "POST",
    `/mcp/servers/${enc(id)}/test`,
    {},
  );
export const prepareMcpServerToggle = (id: string, enabled: boolean) =>
  write<{
    ok: boolean;
    error?: string;
    warning?: string;
    action?: PendingConfirmation;
  }>("POST", `/mcp/servers/${enc(id)}/prepare-toggle`, { enabled });
export const confirmMcpServerToggle = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<{
    ok: boolean;
    error?: string;
    warning?: string;
    server?: string;
    enabled?: boolean;
  }>("POST", "/mcp/servers/confirm-toggle", {
    sessionId,
    confirmationId,
    approve,
  });
export const prepareMcpToolRisk = (server: string, tool: string, risk: Risk) =>
  write<{
    ok: boolean;
    error?: string;
    warning?: string;
    action?: PendingConfirmation;
  }>("POST", `/mcp/servers/${enc(server)}/tools/${enc(tool)}/prepare-risk`, {
    risk,
  });
export const confirmMcpToolRisk = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<{
    ok: boolean;
    error?: string;
    warning?: string;
    risk?: Risk;
  }>("POST", "/mcp/servers/confirm-tool-risk", {
    sessionId,
    confirmationId,
    approve,
  });
export const getQdrantOverview = () =>
  read<QdrantOverview>("/services/qdrant/overview");
export const getWidgetDisplayHistory = (id: string) =>
  read<WidgetDisplayHistory>(`/widgets/${enc(id)}/display-history`);
export const rollbackWidgetDisplay = (id: string, revision: string) =>
  write<{
    ok: true;
    widget: Widget;
    historyWarning?: string;
  }>(
    "POST",
    `/widgets/${enc(id)}/display-history/${enc(revision)}/rollback`,
    {},
  );
export const runQdrantMaintenance = () =>
  write<{ ok: boolean; scanned?: number; archived?: number; more?: boolean }>(
    "POST",
    "/services/qdrant/maintenance",
    {},
  );
export const runQdrantReindex = () =>
  write<{
    ok: boolean;
    points?: number;
    collection?: string;
    warning?: string;
    error?: string;
  }>("POST", "/services/qdrant/reindex", {});
export const getQdrantIndexHistory = () =>
  read<QdrantIndexHistory>("/services/qdrant/index-history");
export const rollbackQdrantIndex = (id: string) =>
  write<{ ok: boolean; collection?: string; error?: string }>(
    "POST",
    `/services/qdrant/index-history/${enc(id)}/rollback`,
    {},
  );
export const getManagedTargetInventory = () =>
  read<ManagedTargetInventory>("/managed-targets/inventory");
export const getManagedTargetsAccess = () =>
  read<ManagedTargetsAccessPolicy>("/managed-targets/access");
export const getManagedTargetsAccessHistory = () =>
  read<ManagedTargetsAccessHistory>("/managed-targets/access/history");
export const prepareManagedTargetsAccessRollback = (revision: string) =>
  write<{
    ok: boolean;
    warning?: string;
    error?: string;
    action?: PendingConfirmation;
  }>(
    "POST",
    `/managed-targets/access/history/${enc(revision)}/prepare-rollback`,
    {},
  );
export const confirmManagedTargetsAccessRollback = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<{
    ok: boolean;
    error?: string;
    historyWarning?: string;
    auditWarning?: string;
    policy?: ManagedTargetsAccessPolicy;
  }>("POST", "/managed-targets/access/history/confirm-rollback", {
    sessionId,
    confirmationId,
    approve,
  });
export const saveManagedTargetsAccess = (policy: ManagedTargetsAccessPolicy) =>
  write<{
    ok: true;
    policy: ManagedTargetsAccessPolicy;
    historyWarning?: string;
  }>("PUT", "/managed-targets/access", policy);
export type HomeAssistantInventory = {
  syncedAt: string | null;
  areas: { id: string; name: string }[];
  devices: { id: string; name: string; areaId: string | null }[];
  entities: {
    id: string;
    name: string;
    domain: string;
    areaId: string | null;
    deviceId: string | null;
  }[];
};
export const getHomeAssistantInventory = () =>
  read<HomeAssistantInventory>("/home-assistant/inventory");
export const getHomeAssistantAccess = () =>
  read<HomeAssistantAccessPolicy>("/home-assistant/access");
export const getHomeAssistantAccessHistory = () =>
  read<HomeAssistantAccessHistory>("/home-assistant/access/history");
export const prepareHomeAssistantAccessRollback = (revision: string) =>
  write<{
    ok: boolean;
    warning?: string;
    error?: string;
    action?: PendingConfirmation;
  }>(
    "POST",
    `/home-assistant/access/history/${enc(revision)}/prepare-rollback`,
    {},
  );
export const confirmHomeAssistantAccessRollback = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<{
    ok: boolean;
    error?: string;
    historyWarning?: string;
    auditWarning?: string;
    policy?: HomeAssistantAccessPolicy;
  }>("POST", "/home-assistant/access/history/confirm-rollback", {
    sessionId,
    confirmationId,
    approve,
  });
export const saveHomeAssistantAccess = (policy: HomeAssistantAccessPolicy) =>
  write<{
    ok: true;
    policy: HomeAssistantAccessPolicy;
    historyWarning?: string;
  }>("PUT", "/home-assistant/access", policy);
export const saveServiceConnection = (
  id: string,
  values: Record<string, string | boolean>,
  clearSecrets: string[] = [],
) =>
  write<ServiceConnectionWrite>("PUT", `/services/${enc(id)}`, {
    values,
    clearSecrets,
  });
export const testServiceConnection = (
  id: string,
  values: Record<string, string | boolean>,
  clearSecrets: string[] = [],
) =>
  write<ServiceConnectionTest>("POST", `/services/${enc(id)}/test`, {
    values,
    clearSecrets,
  });
export const getConnectionHistory = () =>
  read<{ revisions: ServiceConnectionRevision[] }>("/services/history");
export const prepareConnectionRollback = (id: string) =>
  write<{
    ok: boolean;
    warning?: string;
    error?: string;
    action?: PendingConfirmation;
  }>("POST", `/services/history/${enc(id)}/prepare-rollback`, {});
export const confirmConnectionRollback = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<{
    ok: boolean;
    error?: string;
    auditWarning?: string;
    services?: ServiceConnection[];
  }>("POST", "/services/history/confirm-rollback", {
    sessionId,
    confirmationId,
    approve,
  });

export const getOmniRouteAccounts = () =>
  read<OmniRouteAccountsReport>("/omniroute/accounts");
export const getOmniRouteApiKeys = () =>
  read<OmniRouteApiKeyInventory>("/omniroute/accounts/keys");
export const getOmniRouteKeyModelAccess = (id: string) =>
  read<OmniRouteKeyModelAccessOptions>(
    `/omniroute/accounts/keys/${enc(id)}/model-access`,
  );
export const getOmniRouteKeyModelAccessHistory = (id: string) =>
  read<OmniRouteKeyModelAccessHistory>(
    `/omniroute/accounts/keys/${enc(id)}/model-access/history`,
  );
export const prepareOmniRouteKeyModelAccessRollback = (
  id: string,
  revisionId: string,
) =>
  write<OmniRouteKeyModelAccessPrepareResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/model-access/prepare-rollback`,
    { revisionId, acknowledgeGlobalEffect: true },
  );
export const prepareOmniRouteKeyModelAccess = (
  id: string,
  allowedModels: string[],
  revision: string,
) =>
  write<OmniRouteKeyModelAccessPrepareResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/model-access/prepare`,
    { allowedModels, revision, acknowledgeGlobalEffect: true },
  );
export const confirmOmniRouteKeyModelAccess = (
  id: string,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteKeyModelAccessResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/model-access/confirm`,
    { sessionId, confirmationId, approve },
  );
export const getOmniRouteModelVisibility = () =>
  read<OmniRouteModelVisibilityReport>("/omniroute/accounts/model-visibility");
export const getOmniRouteUsage = () =>
  read<OmniRouteUsageReport>("/omniroute/accounts/usage");

export const prepareOmniRouteAccountActivation = (
  id: string,
  enabled: boolean,
) =>
  write<OmniRouteAccountActivationPrepared>(
    "POST",
    `/omniroute/accounts/${enc(id)}/activation/prepare`,
    { enabled, acknowledgeGlobalEffect: true },
  );
export const confirmOmniRouteAccountActivation = (
  id: string,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteAccountActivationResult>(
    "POST",
    `/omniroute/accounts/${enc(id)}/activation/confirm`,
    { sessionId, confirmationId, approve },
  );

export const prepareOmniRouteKeyActivation = (id: string, enabled: boolean) =>
  write<OmniRouteKeyActivationPrepareResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/activation/prepare`,
    { enabled, acknowledgeGlobalEffect: true },
  );
export const confirmOmniRouteKeyActivation = (
  id: string,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteKeyActivationResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/activation/confirm`,
    { sessionId, confirmationId, approve },
  );
export const getOmniRouteKeyActivationHistory = (id: string) =>
  read<{ revisions: OmniRouteActivationHistoryEntry[] }>(
    `/omniroute/accounts/keys/${enc(id)}/activation/history`,
  );
export const prepareOmniRouteKeyActivationRollback = (
  id: string,
  revision: string,
) =>
  write<OmniRouteKeyActivationPrepareResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/activation/history/${enc(revision)}/prepare-rollback`,
    {},
  );
export const prepareOmniRouteComboCreate = (name: string, models: string[]) =>
  write<OmniRouteComboCreatePrepared>(
    "POST",
    "/omniroute/combos/create/prepare",
    {
      name,
      models,
      acknowledgeGlobalEffect: true,
    },
  );
export const confirmOmniRouteComboCreate = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteComboCreateResult>(
    "POST",
    "/omniroute/combos/create/confirm",
    {
      sessionId,
      confirmationId,
      approve,
    },
  );
export const prepareOmniRouteComboRemoval = (id: string) =>
  write<OmniRouteComboRemovalPrepared>(
    "POST",
    `/omniroute/combos/${enc(id)}/removal/prepare`,
    { acknowledgeEffects: true },
  );
export const confirmOmniRouteComboRemoval = (
  id: string,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteComboRemovalResult>(
    "POST",
    `/omniroute/combos/${enc(id)}/removal/confirm`,
    { sessionId, confirmationId, approve },
  );
export const prepareOmniRouteComboUpdate = (
  id: string,
  name: string,
  models: string[],
) =>
  write<OmniRouteComboUpdatePrepared>(
    "POST",
    `/omniroute/combos/${enc(id)}/update/prepare`,
    { name, models, acknowledgeGlobalEffect: true },
  );
export const getOmniRouteComboUpdateHistory = (id: string) =>
  read<OmniRouteComboUpdateHistory>(
    `/omniroute/combos/${enc(id)}/update/history`,
  );
export const prepareOmniRouteComboUpdateRollback = (
  id: string,
  revision: string,
) =>
  write<OmniRouteComboUpdatePrepared>(
    "POST",
    `/omniroute/combos/${enc(id)}/update/history/${enc(revision)}/prepare-rollback`,
    {},
  );
export const confirmOmniRouteComboUpdate = (
  id: string,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteComboUpdateResult>(
    "POST",
    `/omniroute/combos/${enc(id)}/update/confirm`,
    { sessionId, confirmationId, approve },
  );
export const getOmniRouteTokenLimits = (id: string) =>
  read<OmniRouteTokenLimitsReport>(
    `/omniroute/accounts/keys/${enc(id)}/token-limits`,
  );
export const prepareOmniRouteTokenLimit = (
  id: string,
  tokenLimit: number,
  resetInterval: OmniRouteTokenResetInterval,
) =>
  write<OmniRouteTokenLimitPrepared>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/token-limits/prepare`,
    { tokenLimit, resetInterval, acknowledgeGlobalEffect: true },
  );
export const confirmOmniRouteTokenLimit = (
  id: string,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteTokenLimitResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/token-limits/confirm`,
    { sessionId, confirmationId, approve },
  );

export const prepareOmniRouteAccountRemoval = (id: string) =>
  write<OmniRouteAccountRemovalPrepared>(
    "POST",
    `/omniroute/accounts/${enc(id)}/removal/prepare`,
    { acknowledgeEffects: true },
  );
export const confirmOmniRouteAccountRemoval = (
  id: string,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteAccountRemovalResult>(
    "POST",
    `/omniroute/accounts/${enc(id)}/removal/confirm`,
    { sessionId, confirmationId, approve },
  );
export const prepareOmniRouteAccountCreate = (
  provider: string,
  name: string,
  apiKey: string,
  acknowledgeEffects: boolean,
) =>
  write<OmniRouteAccountCreatePrepared>(
    "POST",
    "/omniroute/accounts/create/prepare",
    { provider, name, apiKey, acknowledgeEffects },
  );
export const confirmOmniRouteAccountCreate = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteAccountCreateResult>(
    "POST",
    "/omniroute/accounts/create/confirm",
    { sessionId, confirmationId, approve },
  );
export const prepareOmniRouteAccountKeyUpdate = (
  id: string,
  apiKey: string,
  acknowledgeEffects: boolean,
) =>
  write<OmniRouteAccountKeyUpdatePrepared>(
    "POST",
    "/omniroute/accounts/key-update/prepare",
    { id, apiKey, acknowledgeEffects },
  );
export const confirmOmniRouteAccountKeyUpdate = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteAccountKeyUpdateResult>(
    "POST",
    "/omniroute/accounts/key-update/confirm",
    { sessionId, confirmationId, approve },
  );
export const prepareOmniRouteAccountRename = (
  id: string,
  name: string,
  acknowledgeEffects: boolean,
) =>
  write<OmniRouteAccountRenamePrepared>(
    "POST",
    "/omniroute/accounts/rename/prepare",
    { id, name, acknowledgeEffects },
  );
export const getOmniRouteAccountRenameHistory = (id: string) =>
  read<OmniRouteAccountRenameHistory>(
    `/omniroute/accounts/rename/${enc(id)}/history`,
  );
export const prepareOmniRouteAccountRenameRollback = (
  id: string,
  revisionId: string,
  acknowledgeEffects: boolean,
) =>
  write<OmniRouteAccountRenamePrepared>(
    "POST",
    `/omniroute/accounts/rename/${enc(id)}/history/${enc(revisionId)}/prepare-rollback`,
    { acknowledgeEffects },
  );
export const confirmOmniRouteAccountRename = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteAccountRenameResult>(
    "POST",
    "/omniroute/accounts/rename/confirm",
    { sessionId, confirmationId, approve },
  );

export const prepareOmniRouteComboActivation = (id: string, enabled: boolean) =>
  write<OmniRouteComboActivationPrepared>(
    "POST",
    `/omniroute/combos/${enc(id)}/activation/prepare`,
    { enabled, acknowledgeGlobalEffect: true },
  );
export const confirmOmniRouteComboActivation = (
  id: string,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<OmniRouteComboActivationResult>(
    "POST",
    `/omniroute/combos/${enc(id)}/activation/confirm`,
    { sessionId, confirmationId, approve },
  );
export const getOmniRouteComboActivationHistory = (id: string) =>
  read<{ revisions: OmniRouteActivationHistoryEntry[] }>(
    `/omniroute/combos/${enc(id)}/activation/history`,
  );
export const prepareOmniRouteComboActivationRollback = (
  id: string,
  revision: string,
) =>
  write<OmniRouteComboActivationPrepared>(
    "POST",
    `/omniroute/combos/${enc(id)}/activation/history/${enc(revision)}/prepare-rollback`,
    {},
  );

export const getFreePolicyOptions = () =>
  read<FreePolicyOptions>("/omniroute/policy");
export const getFreePolicyHistory = () =>
  read<FreePolicyHistory>("/omniroute/policy/history");
export const prepareFreePolicy = (value: FreePolicySelection) =>
  write<FreePolicyPrepared>("POST", "/omniroute/policy/prepare", value);
export const confirmFreePolicy = (
  sessionId: string,
  confirmationId: string,
  approve: boolean,
) =>
  write<FreePolicyResult>("POST", "/omniroute/policy/confirm", {
    sessionId,
    confirmationId,
    approve,
  });
export const getOmniRouteAccountActivationHistory = (id: string) =>
  read<{ revisions: OmniRouteActivationHistoryEntry[] }>(
    `/omniroute/accounts/${enc(id)}/activation/history`,
  );
export const prepareOmniRouteAccountActivationRollback = (
  id: string,
  revision: string,
) =>
  write<OmniRouteAccountActivationPrepared>(
    "POST",
    `/omniroute/accounts/${enc(id)}/activation/history/${enc(revision)}/prepare-rollback`,
    {},
  );

export const getToolUsage = () => read<ToolUsageReport>("/tools/usage");
