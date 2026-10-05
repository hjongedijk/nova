import type {
  BuiltinPanel,
  MaxPages,
  QuickAction,
  SidebarItem,
  ToolOverride,
} from "@nova/contracts";
import { ValidationError } from "../core/errors/validation.error.js";

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
