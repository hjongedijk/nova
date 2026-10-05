import type {
  MaxPages,
  PublicWidget,
  QuickAction,
  SidebarItem,
  WidgetData,
} from "@nova/contracts";
import { getPublicConfig, getWidgetData } from "#lib/api/widgets.ts";

/**
 * What GET /api/settings/public says: which panels are shown where, the custom panels, and the
 * other things the home screen needs from the settings (quick actions, examples, public address).
 */
export const sidebar = $state({
  /** False until the first answer; the columns stay empty until then. */
  loaded: false,
  layout: [] as SidebarItem[],
  widgets: [] as PublicWidget[],
  maxPages: { left: 3, right: 3 } as MaxPages,
  quickActions: [] as QuickAction[],
  skillExamples: [] as { name: string; examples: string[] }[],
  publicUrl: "",
  /** Live data of the custom panels, by panel id. */
  data: {} as Record<string, WidgetData>,
});

/** (Re)load the layout. The settings dialog calls this after every change to the sidebar or the panels. */
export async function loadSidebar(): Promise<void> {
  try {
    const config = await getPublicConfig();
    sidebar.layout = config.sidebar ?? [];
    sidebar.widgets = config.widgets ?? [];
    sidebar.maxPages = config.maxPages ?? sidebar.maxPages;
    sidebar.quickActions = config.quickActions ?? [];
    sidebar.skillExamples = config.skillExamples ?? [];
    sidebar.publicUrl = config.publicUrl || "";
    sidebar.loaded = true;
    void pollWidgetData();
  } catch {
    /* the layout that was there stays */
  }
}

/** Custom panels with live data: value and list panels that are switched on. */
export function hasLiveWidgets(): boolean {
  return sidebar.widgets.some(
    (widget) => widget.enabled && widget.type !== "note",
  );
}

export async function pollWidgetData(): Promise<void> {
  if (!hasLiveWidgets()) return;
  try {
    sidebar.data = await getWidgetData();
  } catch {
    /* the panels keep what they showed */
  }
}

let requested = false;
/** Load the layout once (the first column that mounts asks for it). */
export function ensureSidebar(): void {
  if (requested) return;
  requested = true;
  void loadSidebar();
}
