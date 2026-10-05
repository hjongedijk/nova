import type {
  PublicWidget,
  Widget,
  WidgetButton,
  WidgetData,
  WidgetInput,
  WidgetSource,
  WidgetType,
} from "@nova/contracts";
import { ValidationError } from "../../core/errors/validation.error.js";
import { runSkill, type SkillOutcome } from "../skills/run-skill.js";
import {
  normalizeSkill,
  pick,
  slugify,
  type StoredWebhookSkill,
} from "../skills/skills.js";

/*
 * Panels the user adds to the sidebar. Four kinds:
 *  - value:   one live value from a web address ("12 mensen in de ruimte")
 *  - list:    a short live list from a web address
 *  - buttons: buttons that ask NOVA something, run one of the user's skills, or open a link
 *  - note:    a piece of text
 * Live data is fetched on the server, behind the same address checks as skills.
 */
export const WIDGET_TYPES: WidgetType[] = ["value", "list", "buttons", "note"];

const clean = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
const fail = (message: string): never => {
  throw new ValidationError([message]);
};

function normalizeSource(input: Partial<WidgetSource> | undefined) {
  const url = clean(input?.url);
  if (!url) fail("Vul het webadres in waar de gegevens vandaan komen.");
  if (url.length > 500) fail("Het webadres is te lang.");
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    fail("Dit is geen geldig webadres.");
  }
  if (!["http:", "https:"].includes(parsed!.protocol))
    fail("Het webadres moet met http:// of https:// beginnen.");
  if (parsed!.username || parsed!.password)
    fail("Zet geen gebruikersnaam of wachtwoord in het webadres.");
  const extract = clean(input?.extract);
  if (extract && !/^[A-Za-z0-9_.[\]-]{1,100}$/.test(extract))
    fail(
      "Het pad in het antwoord mag alleen letters, cijfers, punten en [0] bevatten.",
    );
  return { url, extract, allowPrivate: input?.allowPrivate === true };
}

function normalizeButtons(input: unknown, skillIds: string[]): WidgetButton[] {
  if (!Array.isArray(input) || !input.length)
    return fail("Voeg minstens één knop toe.");
  if (input.length > 6) fail("Maximaal 6 knoppen.");
  return input.map((raw: Record<string, unknown> | null, index) => {
    const label = clean(raw?.label);
    if (!label) fail(`Knop ${index + 1}: geef de knop een tekst.`);
    if (label.length > 30)
      fail(`Knop ${index + 1}: de tekst is te lang (maximaal 30 tekens).`);
    const action = ["ask", "skill", "link"].includes(raw?.action as string)
      ? (raw?.action as "ask" | "skill" | "link")
      : "ask";
    if (action === "ask") {
      const prompt = clean(raw?.prompt);
      if (!prompt) fail(`Knop “${label}”: schrijf wat NOVA moet doen.`);
      if (prompt.length > 300) fail(`Knop “${label}”: de opdracht is te lang.`);
      return { label, action, prompt };
    }
    if (action === "link") {
      const url = clean(raw?.url);
      try {
        if (!["http:", "https:"].includes(new URL(url).protocol))
          throw new Error("scheme");
      } catch {
        fail(`Knop “${label}”: vul een geldig webadres in (met https://).`);
      }
      return { label, action, url };
    }
    const skillId = clean(raw?.skillId);
    if (!skillIds.includes(skillId))
      fail(
        `Knop “${label}”: kies een vaardigheid die bestaat en een aanroep naar een dienst is.`,
      );
    const args: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(
      (raw?.args ?? {}) as Record<string, unknown>,
    ).slice(0, 5))
      if (
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean") &&
        /^[a-z][a-z0-9_]{0,29}$/.test(key)
      )
        args[key] = value;
    return { label, action, skillId, args };
  });
}

export function normalizeWidget(
  input: unknown,
  {
    existing,
    takenIds = [],
    skillIds = [],
  }: { existing?: Widget; takenIds?: string[]; skillIds?: string[] } = {},
): Widget {
  if (!input || typeof input !== "object") return fail("Geen geldig paneel.");
  const data = input as WidgetInput;
  const type = existing?.type ?? data.type;
  if (!type || !WIDGET_TYPES.includes(type))
    return fail("Kies een soort paneel.");
  const title = clean(data.title);
  if (title.length < 1) fail("Geef het paneel een titel.");
  if (title.length > 40) fail("De titel is te lang (maximaal 40 tekens).");
  const id = existing?.id ?? slugify(title);
  if (!id) fail("Gebruik letters of cijfers in de titel.");
  if (!existing && takenIds.includes(id))
    fail(`Er bestaat al een paneel met de titel “${title}”.`);
  const base = { id, title, enabled: data.enabled !== false };
  if (type === "note") {
    const text = clean(data.text);
    if (!text) fail("Schrijf de tekst van de notitie.");
    if (text.length > 1000)
      fail("De notitie is te lang (maximaal 1000 tekens).");
    return { ...base, type, text };
  }
  if (type === "buttons")
    return { ...base, type, buttons: normalizeButtons(data.buttons, skillIds) };
  const source = normalizeSource(data.source);
  const refreshMinutes = Math.min(
    1440,
    Math.max(1, Math.round(Number(data.refreshMinutes)) || 15),
  );
  if (type === "value")
    return {
      ...base,
      type,
      source,
      refreshMinutes,
      unit: clean(data.unit).slice(0, 12),
    };
  return {
    ...base,
    type,
    source,
    refreshMinutes,
    itemPath: clean(data.itemPath).slice(0, 60),
    max: Math.min(10, Math.max(1, Math.round(Number(data.max)) || 5)),
  };
}

/** What the screen needs to draw a panel. The address of a data source stays on the server. */
export const publicWidget = (widget: Widget): PublicWidget => {
  if ("source" in widget) {
    const rest: Partial<typeof widget> = { ...widget };
    delete rest.source;
    return rest as PublicWidget;
  }
  return widget;
};

/* ---------- live data ---------- */

const short = (value: unknown, max = 120): string =>
  (typeof value === "string" ? value : (JSON.stringify(value) ?? "")).slice(
    0,
    max,
  );

type LiveWidget = Extract<Widget, { type: "value" | "list" }>;

export function shapeData(widget: LiveWidget, response: unknown): WidgetData {
  if (widget.type === "value") {
    if (response === undefined || response === null || response === "")
      return { error: "Het antwoord bevat geen waarde. Controleer het pad." };
    return {
      value: typeof response === "number" ? response : short(response, 80),
    };
  }
  if (!Array.isArray(response))
    return { error: "Het antwoord is geen lijst. Controleer het pad." };
  const items = response
    .map((item: unknown) => {
      if (item !== null && typeof item === "object")
        return short(
          widget.itemPath
            ? (pick(item, widget.itemPath) ?? "")
            : (Object.values(item).find((value) => typeof value === "string") ??
                item),
        );
      return short(item);
    })
    .filter(Boolean)
    .slice(0, widget.max);
  return { items };
}

export type SkillRunner = (
  skill: StoredWebhookSkill,
  args: Record<string, unknown>,
) => Promise<SkillOutcome>;

export async function fetchWidget(
  widget: LiveWidget,
  run: SkillRunner = runSkill,
): Promise<WidgetData> {
  const skill = normalizeSkill({
    type: "webhook",
    name: `Paneel ${widget.title}`,
    description: "Gegevens voor een paneel in de zijbalk",
    http: {
      method: "GET",
      url: widget.source.url,
      extract: widget.source.extract,
      allowPrivate: widget.source.allowPrivate,
      timeoutMs: 8000,
    },
    risk: "READ_ONLY",
  }) as StoredWebhookSkill;
  const outcome = await run(skill, {});
  if (!outcome.ok)
    return {
      error: outcome.error || "De gegevens konden niet worden opgehaald.",
    };
  return shapeData(widget, outcome.result?.response);
}

export interface WidgetDataOptions {
  fetcher?: (widget: LiveWidget) => Promise<WidgetData>;
  now?: () => number;
}

/**
 * Panels are refreshed at their own pace, never faster than they asked, and a slow source is
 * asked once at a time.
 */
export function createWidgetData({
  fetcher = fetchWidget,
  now = () => Date.now(),
}: WidgetDataOptions = {}) {
  const cache = new Map<string, { at: number; data: WidgetData }>();
  const loading = new Map<string, Promise<WidgetData>>();
  async function get(
    widget: LiveWidget,
    { force = false } = {},
  ): Promise<WidgetData> {
    const key = `${widget.id}:${widget.source.url}:${widget.source.extract}`;
    const hit = cache.get(key);
    if (hit && !force && now() - hit.at < widget.refreshMinutes * 60000)
      return hit.data;
    const pending = loading.get(key);
    if (pending) return pending;
    const promise = fetcher(widget)
      .catch((): WidgetData => ({
        error: "De gegevens konden niet worden opgehaald.",
      }))
      .then((data) => {
        const entry = {
          at: now(),
          data: {
            ...data,
            at: new Date(now()).toISOString(),
            kind: widget.type,
            ...("unit" in widget && widget.unit ? { unit: widget.unit } : {}),
          },
        };
        cache.set(key, entry);
        return entry.data;
      })
      .finally(() => loading.delete(key));
    loading.set(key, promise);
    return promise;
  }
  return { get, clear: () => cache.clear() };
}
