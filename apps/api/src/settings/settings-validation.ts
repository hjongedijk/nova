import type {
  BuiltinPanel,
  HelperPreferences,
  MaxPages,
  QuickAction,
  SidebarItem,
  ToolOverride,
  PersonaStyleId,
  PersonaProfile,
} from "@nova/contracts";
import { ValidationError } from "../core/errors/validation.error.js";

const PERSONA_STYLE_IDS: PersonaStyleId[] = [
  "professional",
  "friendly",
  "playful",
  "concise",
];

export function normalizePersonaProfile(value: unknown): PersonaProfile {
  const defaults: PersonaProfile = {
    name: "NOVA",
    character: "warm, nieuwsgierig en met af en toe droge humor",
    address: "je/jij",
    avoid: "doen alsof ik een mens ben of gevoelens en ervaringen verzinnen",
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return defaults;
  const input = value as Record<string, unknown>;
  const clean = (key: keyof PersonaProfile, max: number) =>
    typeof input[key] === "string"
      ? input[key].trim().slice(0, max)
      : defaults[key];
  return {
    name: clean("name", 40) || defaults.name,
    character: clean("character", 300),
    address: clean("address", 40),
    avoid: clean("avoid", 300),
  };
}

/** Trimmed text with Dutch validation messages. */
export function cleanText(
  value: unknown,
  label: string,
  { min = 0, max = Infinity, required = false } = {},
): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (value != null && typeof value !== "string")
    throw new ValidationError([`${label} moet tekst zijn.`]);
  if (required && !clean) throw new ValidationError([`${label} is verplicht.`]);
  if (clean && clean.length < min)
    throw new ValidationError([
      `${label} is te kort (minstens ${min} tekens).`,
    ]);
  if (clean.length > max)
    throw new ValidationError([
      `${label} is te lang (maximaal ${max} tekens).`,
    ]);
  return clean;
}

export const normalizePersona = (value: unknown): string =>
  cleanText(value, "De eigen regels", { max: 2000 });

export const normalizePersonaStyle = (value: unknown): PersonaStyleId => {
  if (PERSONA_STYLE_IDS.includes(value as PersonaStyleId))
    return value as PersonaStyleId;
  throw new ValidationError(["Kies een geldige gespreksstijl."]);
};

export function normalizeQuickActions(items: unknown): QuickAction[] {
  if (!Array.isArray(items))
    throw new ValidationError(["Snelle opdrachten moeten een lijst zijn."]);
  if (items.length > 8)
    throw new ValidationError(["Maximaal 8 snelle opdrachten."]);
  return items.map((item: { label?: unknown; prompt?: unknown }, index) => ({
    label: cleanText(item?.label, `Opdracht ${index + 1}: de knoptekst`, {
      required: true,
      max: 40,
    }),
    prompt: cleanText(
      item?.prompt,
      `Opdracht ${index + 1}: wat NOVA moet doen`,
      { required: true, max: 300 },
    ),
  }));
}

export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function normalizeToolOverride(
  name: string,
  input: { enabled?: unknown; description?: unknown } | undefined,
): ToolOverride {
  if (!TOOL_NAME.test(name)) throw new ValidationError(["Ongeldige toolnaam."]);
  const override: ToolOverride = {};
  if (input?.enabled !== undefined) {
    if (typeof input.enabled !== "boolean")
      throw new ValidationError(["enabled moet waar of onwaar zijn."]);
    if (input.enabled === false) override.enabled = false;
  }
  if (
    input?.description !== undefined &&
    input.description !== null &&
    String(input.description).trim() !== ""
  )
    override.description = cleanText(input.description, "De beschrijving", {
      min: 10,
      max: 1500,
    });
  return override;
}

/* ---------- the sidebar: which panels, where, in what order ---------- */

/** Every panel that is built into the screen, in its default place. */
export const BUILTIN_PANELS: BuiltinPanel[] = [
  { id: "systeem", name: "Systeem", column: "left", page: 1 },
  { id: "vms", name: "Virtuele machines", column: "left", page: 1 },
  { id: "opslag", name: "Opslag", column: "left", page: 1 },
  { id: "buiten", name: "Buiten", column: "left", page: 2 },
  { id: "lucht", name: "Lucht", column: "left", page: 2 },
  { id: "maan", name: "Maan en dag", column: "left", page: 2 },
  { id: "huis", name: "Huis", column: "left", page: 3 },
  { id: "markt", name: "Markt", column: "left", page: 3 },
  { id: "iss", name: "ISS", column: "left", page: 3 },
  { id: "nu", name: "Nu", column: "right", page: 1 },
  { id: "server", name: "Server", column: "right", page: 1 },
  { id: "stem", name: "Stem", column: "right", page: 1 },
  { id: "planning", name: "Planning", column: "right", page: 1 },
  { id: "nieuws", name: "Nieuws", column: "right", page: 2 },
  { id: "activiteit", name: "Activiteit", column: "right", page: 2 },
];
export const MAX_PAGES: MaxPages = { left: 4, right: 3 };

interface SidebarSource {
  widgets: { id?: unknown }[];
  sidebar?: { items: { id?: unknown }[] } | null;
}

const knownPanels = (settings: SidebarSource) => {
  const widgetIds = new Set(
    settings.widgets.map((widget) => `w:${String(widget.id)}`),
  );
  return {
    widgetIds,
    known: new Set([...BUILTIN_PANELS.map((panel) => panel.id), ...widgetIds]),
  };
};

/**
 * The saved layout merged with what exists now: removed widgets vanish, new panels appear in
 * their default place.
 */
export function resolveSidebar(settings: SidebarSource): SidebarItem[] {
  const { widgetIds, known } = knownPanels(settings);
  const saved = (settings.sidebar?.items ?? []).filter((item) =>
    known.has(item.id as string),
  ) as unknown as SidebarItem[];
  const seen = new Set(saved.map((item) => item.id));
  const missing: SidebarItem[] = [
    ...BUILTIN_PANELS.filter((panel) => !seen.has(panel.id)).map((panel) => ({
      id: panel.id,
      column: panel.column,
      page: panel.page,
      shown: true,
    })),
    ...[...widgetIds]
      .filter((id) => !seen.has(id))
      .map((id) => ({
        id,
        column: "right" as const,
        page: MAX_PAGES.right,
        shown: true,
      })),
  ];
  return [...saved, ...missing];
}

export function normalizeSidebar(
  items: unknown,
  settings: SidebarSource,
): SidebarItem[] {
  if (!Array.isArray(items))
    throw new ValidationError(["De indeling moet een lijst zijn."]);
  const { known } = knownPanels(settings);
  const seen = new Set<string>();
  const clean: SidebarItem[] = [];
  for (const item of items as Record<string, unknown>[]) {
    if (!known.has(item?.id as string))
      throw new ValidationError([
        `Onbekend paneel: ${String(item?.id).slice(0, 40)}.`,
      ]);
    const id = item.id as string;
    if (seen.has(id))
      throw new ValidationError(["Een paneel staat er twee keer in."]);
    seen.add(id);
    const column = item.column === "right" ? "right" : "left";
    const page = Math.min(
      MAX_PAGES[column],
      Math.max(1, Math.round(Number(item.page)) || 1),
    );
    clean.push({ id, column, page, shown: item.shown !== false });
  }
  return clean;
}

/** Validate the saved helper presentation and cue choices. */
export function normalizeHelperPreferences(
  body: Record<string, unknown> | undefined,
): HelperPreferences {
  const shape = body?.shape;
  const cues = body?.cues as Record<string, unknown> | undefined;
  const quiet = cues?.quiet as Record<string, unknown> | undefined;
  const notifications = body?.notifications as
    Record<string, unknown> | undefined;
  if (
    typeof body?.autohide !== "boolean" ||
    typeof body.contrast !== "boolean" ||
    !["orb", "ring", "mist"].includes(String(shape)) ||
    !cues ||
    typeof cues.enabled !== "boolean" ||
    typeof cues.volume !== "number" ||
    !Number.isFinite(cues.volume) ||
    cues.volume < 0 ||
    cues.volume > 1 ||
    !["soft", "playful", "minimal"].includes(String(cues.theme)) ||
    !quiet ||
    typeof quiet.enabled !== "boolean" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(quiet.start)) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(quiet.end))
  )
    throw new ValidationError(["Ongeldige helperinstellingen."]);
  const names = [
    "listening-start",
    "listening-end",
    "thinking",
    "done",
    "notice",
    "error",
    "approved",
    "declined",
    "greet",
    "goodnight",
    "file",
    "touch",
    "dizzy",
    "heart",
    "wake",
  ];
  const perCue: Record<string, boolean> = {};
  if (cues.cues !== undefined) {
    if (!cues.cues || typeof cues.cues !== "object" || Array.isArray(cues.cues))
      throw new ValidationError(["Ongeldige geluiden."]);
    for (const [key, value] of Object.entries(cues.cues)) {
      if (!names.includes(key) || typeof value !== "boolean")
        throw new ValidationError(["Onbekend geluid."]);
      perCue[key] = value;
    }
  }
  const wardrobe = body.wardrobe as Record<string, unknown> | undefined;
  if (
    wardrobe &&
    (!["nova", "violet", "gold"].includes(String(wardrobe.theme)) ||
      typeof wardrobe.seasonal !== "boolean" ||
      typeof wardrobe.birthday !== "string" ||
      (wardrobe.birthday !== "" &&
        !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(wardrobe.birthday)))
  )
    throw new ValidationError(["Ongeldige orbkleuren of verjaardag."]);
  const preferences: HelperPreferences = {
    ...(wardrobe
      ? {
          wardrobe: {
            theme: wardrobe.theme as NonNullable<
              HelperPreferences["wardrobe"]
            >["theme"],
            seasonal: wardrobe.seasonal as boolean,
            birthday: wardrobe.birthday as string,
          },
        }
      : {}),
    autohide: body.autohide,
    contrast: body.contrast,
    shape: shape as HelperPreferences["shape"],
    notifications: {
      info: notificationMode(notifications?.info, "helper"),
      warning: notificationMode(notifications?.warning, "speak"),
      critical: notificationMode(notifications?.critical, "speak"),
      timer: notificationMode(notifications?.timer, "speak"),
    },
    cues: {
      enabled: cues.enabled,
      volume: cues.volume,
      theme: cues.theme as HelperPreferences["cues"]["theme"],
      cues: perCue,
      quiet: {
        enabled: quiet.enabled,
        start: String(quiet.start),
        end: String(quiet.end),
      },
    },
  };
  return preferences;
}

function notificationMode(
  value: unknown,
  fallback: "screen" | "helper" | "speak",
): "screen" | "helper" | "speak" {
  if (value === undefined) return fallback;
  if (value === "screen" || value === "helper" || value === "speak")
    return value;
  throw new ValidationError(["Ongeldige meldingsvoorkeur."]);
}
