import type {
  ImportResult,
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
  WallpaperMode,
  WallpaperState,
  QuickAction,
} from "@nova/contracts";
import { getJson, sendJson } from "./client.ts";
import { storage } from "#lib/util/storage.ts";

/** The PIN lives in localStorage and goes along as x-nova-pin. */
export const PIN_KEY = "novaPin";
export const getPin = (): string => storage.get(PIN_KEY, "");
export const setPin = (pin: string): void => storage.set(PIN_KEY, pin);

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

export const exportSettings = () => read<SettingsBackup>("/export");
export const importSettings = (data: unknown, mode: "merge" | "replace") =>
  write<ImportResult>("POST", "/import", { data, mode });
