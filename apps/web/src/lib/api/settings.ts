import type { OmniRouteAccountsReport } from "@nova/contracts";
import type {
  NativeGatewayReport,
  NativeSkillDocument,
  NativeSkillMode,
  NativeSkillModePrepared,
  NativeSkillModeResult,
  NativePromptReplacement,
  NativePromptPrepared,
  NativePromptResult,
  WindowsAgentStatus,
  UpdateReport,
  ModelMetricsReport,
  ImportResult,
  ServiceConnection,
  ServiceConnectionRevision,
  ServiceConnectionTest,
  ServiceConnectionWrite,
  HelperPreferences,
  Skill,
  SkillDraftResult,
  SkillInput,
  SkillRun,
  SkillSuggestion,
  SkillTestResult,
  SettingsBackup,
  SettingsOverview,
  SidebarItem,
  ToolOverride,
  Widget,
  WidgetInput,
  WidgetPreviewResult,
  HelperMode,
  HelperState,
  WallpaperMode,
  WallpaperState,
  QuickAction,
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

export const getSettings = () => read<SettingsOverview>("");
export const getNativeGateway = () =>
  read<NativeGatewayReport>("/omniroute/native");
export const prepareNativePrompt = (value: NativePromptReplacement) =>
  write<NativePromptPrepared>(
    "POST",
    "/omniroute/native/prompt/prepare",
    value,
  );
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
export const prepareNativeSkillMode = (id: string, mode: NativeSkillMode) =>
  write<NativeSkillModePrepared>(
    "POST",
    `/omniroute/native/skills/${enc(id)}/prepare`,
    { mode },
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
export const getNativeSkillDocument = (id: string) =>
  read<NativeSkillDocument>(`/omniroute/native/documentation/${enc(id)}`);
export const getModelMetrics = () =>
  read<ModelMetricsReport>("/models/metrics");
export const getUpdates = () => read<UpdateReport>("/updates");
export const checkUpdates = () => write<UpdateReport>("POST", "/updates/check");

export const savePersona = (text: string) =>
  write<{ ok: true; persona: string }>("PUT", "/persona", { text });

export const saveQuickActions = (items: QuickAction[]) =>
  write<{ ok: true; quickActions: QuickAction[] }>("PUT", "/quick-actions", {
    items,
  });
export const resetQuickActions = () =>
  write<{ ok: true; quickActions: QuickAction[] }>("PUT", "/quick-actions", {
    reset: true,
  });

export const saveToolOverride = (name: string, override: ToolOverride) =>
  write<{ ok: true; override: ToolOverride }>(
    "PUT",
    `/tools/${enc(name)}`,
    override,
  );
export const resetTool = (name: string) =>
  write<{ ok: true }>("DELETE", `/tools/${enc(name)}`);

export const setAbility = (id: string, enabled: boolean) =>
  write<{ ok: true }>("PUT", `/abilities/${enc(id)}`, { enabled });

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
export const improveSkill = (skill: SkillInput, goal: string) =>
  write<SkillSuggestion>("POST", "/skills/improve", { skill, goal });

/* ---------- sidebar panels ---------- */

export const createWidget = (widget: WidgetInput) =>
  write<{ widget: Widget }>("POST", "/widgets", widget);
export const updateWidget = (id: string, widget: WidgetInput) =>
  write<{ widget: Widget }>("PUT", `/widgets/${enc(id)}`, widget);
export const deleteWidget = (id: string) =>
  write<{ ok: true }>("DELETE", `/widgets/${enc(id)}`);
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

export const getHelper = () => read<HelperState>("/helper");
export const getWindowsAgentStatus = () =>
  read<WindowsAgentStatus>("/windows/status");
export const setHelper = (mode: HelperMode, display: number) =>
  write<HelperState>("POST", "/helper", { mode, display });

export const exportSettings = () => read<SettingsBackup>("/export");
export const importSettings = (data: unknown, mode: "merge" | "replace") =>
  write<ImportResult>("POST", "/import", { data, mode });

export const revokeStandingApproval = (id: string) =>
  write<{ ok: true }>("DELETE", `/standing-approvals/${enc(id)}`);

export interface HelperHotkeys {
  ok: boolean;
  error?: string;
  preferences?: {
    hotkeys: Record<string, string>;
    warnings: string[];
    paused: boolean;
  };
}
export const getHelperHotkeys = () => read<HelperHotkeys>("/helper/hotkeys");
export const saveHelperHotkeys = (hotkeys: Record<string, string>) =>
  write<HelperHotkeys>("PUT", "/helper/hotkeys", { hotkeys });

export const getHelperPreferences = () =>
  read<HelperPreferences>("/helper/preferences");
export const persistHelperPreferences = (preferences: HelperPreferences) =>
  write<{ ok: true }>("PUT", "/helper/preferences", preferences);

/* ---------- service connections (credentials never returned) ---------- */
export const getServiceConnections = () =>
  read<{ services: ServiceConnection[] }>("/services");
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
  write<ServiceConnectionWrite>(
    "POST",
    `/services/history/${enc(id)}/rollback`,
  );

export const getOmniRouteAccounts = () =>
  read<OmniRouteAccountsReport>("/omniroute/accounts");
