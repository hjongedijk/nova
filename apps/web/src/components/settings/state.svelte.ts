import type {
  Skill,
  SkillInput,
  SkillType,
  SettingsOverview,
  Widget,
  WidgetType,
} from "@nova/contracts";
import { ApiError } from "#lib/api/client.ts";
import { getSettings, setPin } from "#lib/api/settings.ts";
import { loadSidebar } from "#lib/stores/sidebar.svelte.ts";

export type Tab = "abilities" | "skills" | "sidebar" | "behavior" | "more";

export interface SkillEditing {
  type: SkillType;
  skill: Skill | null;
  /** A proposal from "Maak een voorstel": prefilled, not saved yet. */
  draft?: SkillInput;
}

export interface WidgetEditing {
  type?: WidgetType;
  widget: Widget | null;
}

/** What the settings dialog shows. One writer: the dialog and its tabs, through the functions below. */
export const settings = $state({
  data: null as SettingsOverview | null,
  tab: "abilities" as Tab,
  editing: null as SkillEditing | null,
  editingWidget: null as WidgetEditing | null,
  toolsOpen: false,
  /** The API wants a PIN that is missing or wrong. */
  needPin: false,
});

/** The status line. `n` counts every message, so tests (and timers) can tell old from new. */
export const message = $state({
  text: "",
  kind: "" as "" | "ok" | "bad",
  details: [] as string[],
  n: 0,
});

let timer: ReturnType<typeof setTimeout> | undefined;

/** A result message goes away by itself after 4 s; a problem stays a little longer (10 s). */
export function say(
  text: string,
  kind: "" | "ok" | "bad" = "",
  details?: string[],
): void {
  const n = ++message.n;
  message.text = text;
  message.kind = kind;
  message.details = details && details.length > 1 ? details : [];
  clearTimeout(timer);
  if (text)
    timer = setTimeout(
      () => {
        if (message.n === n) {
          message.text = "";
          message.details = [];
        }
      },
      kind === "bad" ? 10000 : 4000,
    );
}

export function fail(error: unknown): void {
  if (error instanceof ApiError) say(error.message, "bad", error.details);
  else
    say(error instanceof Error ? error.message : "Dat is niet gelukt.", "bad");
}

/** Load the overview. A 401 with pinRequired switches the dialog to the PIN prompt. */
export async function reload(): Promise<void> {
  try {
    settings.data = await getSettings();
    settings.needPin = false;
    say("");
  } catch (error) {
    if (error instanceof ApiError && error.pinRequired) {
      settings.needPin = true;
      say("");
    } else fail(error);
  }
}

export function unlock(pin: string): Promise<void> {
  setPin(pin);
  return reload();
}

/** After every change: fetch the overview again, say what happened, refresh the sidebar on the home screen. */
export async function afterChange(text: string): Promise<void> {
  settings.data = await getSettings();
  say(text, "ok");
  void loadSidebar();
}

export function startEditing(
  type: SkillType,
  skill?: Skill | null,
  draft?: SkillInput,
): void {
  settings.editing = { type, skill: skill ?? null, draft };
  say("");
}

export function resetState(): void {
  settings.editing = null;
  settings.editingWidget = null;
}
