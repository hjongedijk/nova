import type {
  ToolUsageReport,
  FreePolicyOptions,
  FreePolicySelection,
  FreePolicyResult,
  FreePolicyHistory,
  OmniRouteAccountsReport,
  OmniRouteApiKeyInventory,
  OmniRouteUsageReport,
  OmniRouteModelVisibilityReport,
  OmniRouteAccountRemovalResult,
  OmniRouteAccountCreateResult,
  OmniRouteAccountKeyUpdateResult,
  OmniRouteAccountRenameResult,
  OmniRouteAccountRenameHistory,
  OmniRouteAccountActivationResult,
  OmniRouteActivationHistoryEntry,
  OmniRouteKeyActivationResult,
  OmniRouteKeyModelAccessOptions,
  OmniRouteKeyModelAccessHistory,
  OmniRouteKeyModelAccessResult,
  OmniRouteComboCreateResult,
  OmniRouteComboRemovalResult,
  OmniRouteComboUpdateHistory,
  OmniRouteTokenLimitsReport,
  OmniRouteTokenLimitResult,
  OmniRouteTokenResetInterval,
  OmniRouteComboUpdateResult,
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
  StackRestartResult,
  StackServiceId,
  ManagedTargetsAccessHistory,
  WorkspaceProjectsReport,
  WorkspaceProjectSelectionHistory,
  WorkspaceProjectSelectionResult,
} from "@nova/contracts";
import type {
  NativeGatewayReport,
  NativeMemoryRecordResult,
  NativeMemoryHistory,
  NativeMemoryRecords,
  NativeMemoryResult,
  NativeSkillDocument,
  NativeSkillMode,
  NativeSkillModeHistory,
  NativeSkillModeResult,
  NativeSkillRemovalResult,
  NativePromptReplacement,
  NativePromptResult,
  NativePromptHistory,
  WindowsAgentStatus,
  WindowsHelperDebugStatus,
  HelperHotkeyHistory,
  HelperHotkeyRollbackResult,
  UpdateReport,
  ModelMetricsReport,
  SettingsImportResult,
  ServiceConnection,
  RuntimeSettingGroup,
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
import { settingsWriteReceipt } from "./settings-receipts.ts";
import { publishSettingsReceipt } from "./settings-receipt-events.ts";

function headers(): Record<string, string> {
  return {};
}

const read = <T>(path: string) =>
  getJson<T>(`/settings${path}`, { headers: headers() });
const write = async <T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) => {
  const receiptRequest =
    body !== null && typeof body === "object" && "approve" in body
      ? { approve: body.approve }
      : undefined;
  const result = await sendJson<T>(method, `/settings${path}`, body, headers());
  const receipt = settingsWriteReceipt(method, path, receiptRequest, result);
  if (receipt) publishSettingsReceipt(receipt);
  return result;
};

const enc = encodeURIComponent;

export const getSettings = () => read<SettingsOverview>("");
export const getNativeGateway = () =>
  read<NativeGatewayReport>("/omniroute/native");
export const setNativeMemory = (enabled: boolean) =>
  write<NativeMemoryResult>("POST", "/omniroute/native/memory", { enabled });
export const getNativeMemoryHistory = () =>
  read<NativeMemoryHistory>("/omniroute/native/memory/history");
export const getNativeMemoryRecords = (offset = 0) =>
  read<NativeMemoryRecords>(`/omniroute/native/memories?offset=${offset}`);
export const deleteNativeMemoryRecord = (id: string) =>
  write<NativeMemoryRecordResult>("POST", "/omniroute/native/memories/delete", {
    id,
  });
export const deleteNativeMemoryRecords = (ids: string[]) =>
  write<NativeMemoryRecordResult>(
    "POST",
    "/omniroute/native/memories/delete-many",
    { ids },
  );
export const updateNativeMemoryRecord = (id: string, content: string) =>
  write<NativeMemoryRecordResult>("POST", "/omniroute/native/memories/update", {
    id,
    content,
  });
export const rollbackNativeMemory = (revisionId: string) =>
  write<NativeMemoryResult>("POST", "/omniroute/native/memory/rollback", {
    revisionId,
  });
export const replaceNativePrompt = (value: NativePromptReplacement) =>
  write<NativePromptResult>("POST", "/omniroute/native/prompt", value);
export const getNativePromptHistory = () =>
  read<NativePromptHistory>("/omniroute/native/prompt/history");
export const setNativeSkillMode = (id: string, mode: NativeSkillMode) =>
  write<NativeSkillModeResult>("POST", `/omniroute/native/skills/${enc(id)}`, {
    mode,
  });
export const getNativeSkillModeHistory = (id: string) =>
  read<NativeSkillModeHistory>(
    `/omniroute/native/skills/${encodeURIComponent(id)}/history`,
  );
export const rollbackNativeSkillMode = (id: string, revisionId: string) =>
  write<NativeSkillModeResult>(
    "POST",
    `/omniroute/native/skills/${enc(id)}/rollback`,
    { revisionId },
  );
export const removeNativeSkill = (id: string) =>
  write<NativeSkillRemovalResult>(
    "POST",
    `/omniroute/native/skills/${enc(id)}/remove`,
    {},
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
export const rollbackWorkspaceProjectSelection = (revision: string) =>
  write<WorkspaceProjectSelectionResult>(
    "POST",
    `/workspace/projects/history/${enc(revision)}/rollback`,
    {},
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
export const getWorkspaceCodeRun = async () => {
  const value = await read<{
    projectId: string;
    command: string[];
    output: string;
    exitCode: number | null;
    durationMs: number;
  } | null>("/workspace/code/latest-run");
  // Older servers returned an empty HTTP body, parsed as {} by the shared client.
  if (value === null || (value && Object.keys(value).length === 0)) return null;
  if (
    !value ||
    !Array.isArray(value.command) ||
    value.command.some((part) => typeof part !== "string")
  )
    throw new Error("Testuitvoer is niet beschikbaar. Probeer opnieuw.");
  return value;
};
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
export interface NodeRedPaletteState {
  revision: string;
  modules: {
    name: string;
    installed: boolean;
    version: string | null;
    targetVersion?: string | null;
    pendingVersion?: string | null;
    restartRequired?: boolean;
  }[];
}
export const getNodeRedPalette = () =>
  read<NodeRedPaletteState>("/node-red/palette");
export const changeNodeRedPalette = (module: string, install: boolean) =>
  write<
    | {
        ok: true;
        state?: NodeRedPaletteState;
        verified?: boolean;
        pendingRestart?: boolean;
      }
    | { ok: false; error: string }
  >("POST", "/node-red/palette/change", { module, install });
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
export const restoreNodeRedFlowRevision = (id: string) =>
  write<
    | {
        ok: true;
        revision: NodeRedFlowRevision & { historyWarning?: string };
      }
    | { ok: false; error: string }
  >("POST", `/node-red/flow-revisions/${enc(id)}/restore`, {});
export const getHelper = () => read<HelperState>("/helper");
export const getWindowsAgentStatus = () =>
  read<WindowsAgentStatus>("/windows/status");
export const getWindowsHelperDebug = () =>
  read<WindowsHelperDebugStatus>("/windows/helper-debug");
export const setHelper = (mode: HelperMode, display: number) =>
  write<HelperState>("POST", "/helper", { mode, display });

export const exportSettings = () => read<SettingsBackup>("/export");
export const importSettings = (data: unknown, mode: "merge" | "replace") =>
  write<SettingsImportResult>("POST", "/import", { data, mode });

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
export const restartStackService = (service: StackServiceId) =>
  write<StackRestartResult>("POST", "/stack-control/restart", { service });
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
export const changeMcpServerCatalog = (
  id: string,
  operation: "add" | "remove",
) =>
  write<{
    ok: boolean;
    verified?: boolean | null;
    server?: string;
    operation?: "add" | "remove";
    warning?: string;
    error?: string;
  }>("POST", `/mcp/servers/${enc(id)}/catalog`, { operation });
export const getMcpServerActivity = (id: string) =>
  read<McpServerActivity>(`/mcp/servers/${enc(id)}/activity`);
export const getMcpServerHistory = (id: string) =>
  read<McpSettingHistory>(`/mcp/servers/${enc(id)}/history`);
export const rollbackMcpServerHistory = (id: string, revisionId: string) =>
  write<{
    ok: boolean;
    verified?: boolean | null;
    server?: string;
    enabled?: boolean;
    tool?: string;
    risk?: Risk;
    warning?: string;
    error?: string;
  }>("POST", `/mcp/servers/${enc(id)}/history/${enc(revisionId)}/rollback`, {});
export const testMcpServerConnection = (id: string) =>
  write<{ ok: boolean; toolCount: number }>(
    "POST",
    `/mcp/servers/${enc(id)}/test`,
    {},
  );
export const setMcpServerEnabled = (id: string, enabled: boolean) =>
  write<{
    ok: boolean;
    error?: string;
    warning?: string;
    server?: string;
    enabled?: boolean;
  }>("POST", `/mcp/servers/${enc(id)}/toggle`, { enabled });
export const setMcpToolRisk = (server: string, tool: string, risk: Risk) =>
  write<{
    ok: boolean;
    error?: string;
    warning?: string;
    risk?: Risk;
  }>("POST", `/mcp/servers/${enc(server)}/tools/${enc(tool)}/risk`, { risk });
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
export const rollbackManagedTargetsAccess = (revision: string) =>
  write<{
    ok: boolean;
    error?: string;
    historyWarning?: string;
    auditWarning?: string;
    policy?: ManagedTargetsAccessPolicy;
  }>("POST", `/managed-targets/access/history/${enc(revision)}/rollback`, {});
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
export const rollbackHomeAssistantAccess = (revision: string) =>
  write<{
    ok: boolean;
    error?: string;
    historyWarning?: string;
    auditWarning?: string;
    policy?: HomeAssistantAccessPolicy;
  }>("POST", `/home-assistant/access/history/${enc(revision)}/rollback`, {});
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
export const rollbackConnection = (id: string) =>
  write<{
    ok: boolean;
    error?: string;
    auditWarning?: string;
    services?: ServiceConnection[];
  }>("POST", `/services/history/${enc(id)}/rollback`, {});
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
export const rollbackOmniRouteKeyModelAccess = (
  id: string,
  revisionId: string,
) =>
  write<OmniRouteKeyModelAccessResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/model-access/rollback`,
    { revisionId },
  );
export const setOmniRouteKeyModelAccess = (
  id: string,
  allowedModels: string[],
) =>
  write<OmniRouteKeyModelAccessResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/model-access`,
    { allowedModels },
  );
export const getOmniRouteModelVisibility = () =>
  read<OmniRouteModelVisibilityReport>("/omniroute/accounts/model-visibility");
export const getOmniRouteUsage = () =>
  read<OmniRouteUsageReport>("/omniroute/accounts/usage");

export const setOmniRouteKeyActivation = (id: string, enabled: boolean) =>
  write<OmniRouteKeyActivationResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/activation`,
    { enabled },
  );
export const getOmniRouteKeyActivationHistory = (id: string) =>
  read<{ revisions: OmniRouteActivationHistoryEntry[] }>(
    `/omniroute/accounts/keys/${enc(id)}/activation/history`,
  );
export const rollbackOmniRouteKeyActivation = (id: string, revision: string) =>
  write<OmniRouteKeyActivationResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/activation/history/${enc(revision)}/rollback`,
    {},
  );
export const createOmniRouteCombo = (name: string, models: string[]) =>
  write<OmniRouteComboCreateResult>("POST", "/omniroute/combos/create", {
    name,
    models,
  });
export const removeOmniRouteCombo = (id: string) =>
  write<OmniRouteComboRemovalResult>(
    "POST",
    `/omniroute/combos/${enc(id)}/removal`,
    {},
  );
export const updateOmniRouteCombo = (
  id: string,
  name: string,
  models: string[],
) =>
  write<OmniRouteComboUpdateResult>(
    "POST",
    `/omniroute/combos/${enc(id)}/update`,
    { name, models },
  );
export const getOmniRouteComboUpdateHistory = (id: string) =>
  read<OmniRouteComboUpdateHistory>(
    `/omniroute/combos/${enc(id)}/update/history`,
  );
export const rollbackOmniRouteComboUpdate = (id: string, revision: string) =>
  write<OmniRouteComboUpdateResult>(
    "POST",
    `/omniroute/combos/${enc(id)}/update/history/${enc(revision)}/rollback`,
    {},
  );
export const getOmniRouteTokenLimits = (id: string) =>
  read<OmniRouteTokenLimitsReport>(
    `/omniroute/accounts/keys/${enc(id)}/token-limits`,
  );
export const setOmniRouteTokenLimit = (
  id: string,
  tokenLimit: number,
  resetInterval: OmniRouteTokenResetInterval,
) =>
  write<OmniRouteTokenLimitResult>(
    "POST",
    `/omniroute/accounts/keys/${enc(id)}/token-limits`,
    { tokenLimit, resetInterval },
  );

export const setOmniRouteAccountActivation = (id: string, enabled: boolean) =>
  write<OmniRouteAccountActivationResult>(
    "POST",
    `/omniroute/accounts/${enc(id)}/activation`,
    { enabled },
  );
export const rollbackOmniRouteAccountActivation = (
  id: string,
  revision: string,
) =>
  write<OmniRouteAccountActivationResult>(
    "POST",
    `/omniroute/accounts/${enc(id)}/activation/history/${enc(revision)}/rollback`,
    {},
  );
export const removeOmniRouteAccount = (id: string) =>
  write<OmniRouteAccountRemovalResult>(
    "POST",
    `/omniroute/accounts/${enc(id)}/removal`,
    {},
  );
export const createOmniRouteAccount = (
  provider: string,
  name: string,
  apiKey: string,
) =>
  write<OmniRouteAccountCreateResult>("POST", "/omniroute/accounts/create", {
    provider,
    name,
    apiKey,
  });
export const updateOmniRouteAccountKey = (id: string, apiKey: string) =>
  write<OmniRouteAccountKeyUpdateResult>(
    "POST",
    "/omniroute/accounts/key-update",
    { id, apiKey },
  );
export const renameOmniRouteAccount = (id: string, name: string) =>
  write<OmniRouteAccountRenameResult>("POST", "/omniroute/accounts/rename", {
    id,
    name,
  });
export const rollbackOmniRouteAccountRename = (
  id: string,
  revisionId: string,
) =>
  write<OmniRouteAccountRenameResult>(
    "POST",
    `/omniroute/accounts/rename/${enc(id)}/history/${enc(revisionId)}/rollback`,
    {},
  );
export const getOmniRouteAccountRenameHistory = (id: string) =>
  read<OmniRouteAccountRenameHistory>(
    `/omniroute/accounts/rename/${enc(id)}/history`,
  );

export const setOmniRouteComboActivation = (id: string, enabled: boolean) =>
  write<OmniRouteComboActivationResult>(
    "POST",
    `/omniroute/combos/${enc(id)}/activation`,
    { enabled },
  );
export const getOmniRouteComboActivationHistory = (id: string) =>
  read<{ revisions: OmniRouteActivationHistoryEntry[] }>(
    `/omniroute/combos/${enc(id)}/activation/history`,
  );
export const rollbackOmniRouteComboActivation = (
  id: string,
  revision: string,
) =>
  write<OmniRouteComboActivationResult>(
    "POST",
    `/omniroute/combos/${enc(id)}/activation/history/${enc(revision)}/rollback`,
    {},
  );

export const getFreePolicyOptions = () =>
  read<FreePolicyOptions>("/omniroute/policy");
export const getFreePolicyHistory = () =>
  read<FreePolicyHistory>("/omniroute/policy/history");
export const applyFreePolicy = (value: FreePolicySelection) =>
  write<FreePolicyResult>("POST", "/omniroute/policy", value);
export const getOmniRouteAccountActivationHistory = (id: string) =>
  read<{ revisions: OmniRouteActivationHistoryEntry[] }>(
    `/omniroute/accounts/${enc(id)}/activation/history`,
  );

export const getToolUsage = () => read<ToolUsageReport>("/tools/usage");

export interface NodeRedLogs {
  available: boolean;
  reason?: string;
  limited: true;
  truncated: boolean;
  flowLinksAvailable: boolean;
  entries: {
    at: string;
    stream: "stdout" | "stderr";
    text: string;
    level: "info" | "warn" | "error" | "debug" | "trace" | "fatal" | "unknown";
    source: { type: string; label: string } | null;
    truncated?: boolean;
    flowId: string | null;
  }[];
}
export const getNodeRedLogs = () =>
  read<NodeRedLogs>("/stack-control/node-red/logs");

export const pairWindowsAgent = (code: string) =>
  write<ServiceConnectionWrite>("POST", "/services/windows/pair", { code });

export const getRuntimeSettings = () =>
  read<{ groups: RuntimeSettingGroup[] }>("/runtime");
export const saveRuntimeSettings = (
  id: string,
  values: Record<string, string | boolean>,
  reset: string[] = [],
) =>
  write<{ groups: RuntimeSettingGroup[] }>("PUT", `/runtime/${enc(id)}`, {
    values,
    reset,
  });
