import type { SkillInput, SkillSuggestion } from "@nova/contracts";
import { normalizeSkill } from "../skills/skills.js";

/** A draft is valid when a real skill could be made from it. */
const validateDraft = (draft: SkillInput) => normalizeSkill(draft);

export const IMPROVE_SYSTEM = `Je verbetert vaardigheden voor NOVA, een Nederlandse spraakassistent. Je krijgt een concept van een vaardigheid, soms het doel van de gebruiker en recente aanroepen (met fouten).
Antwoord uitsluitend met een JSON-object met alleen de velden die je wilt veranderen uit:
- "name": korte, duidelijke naam
- "description": zegt in een of twee zinnen WANNEER NOVA deze vaardigheid moet gebruiken (dit leest het taalmodel)
- "examples": zinnen zoals een gebruiker ze hardop zegt (maximaal 6)
- "instructions": alleen bij een instructie-vaardigheid: duidelijke stappen in gewone taal die NOVA met zijn bestaande tools uitvoert
- "parameterDescriptions": object met parameternaam -> betere beschrijving (de namen en typen blijven gelijk)
- "notes": 1 tot 3 korte Nederlandse zinnen: wat je veranderde en waarom
Regels: behoud de bedoeling. Verander nooit een URL, header, geheim, risiconiveau, parameternaam of type. Schrijf in het Nederlands. Als de fouten laten zien dat een parameter onduidelijk is, maak de beschrijving daarvan beter. Geen uitleg buiten het JSON-object.`;

const limits = { name: 60, description: 300, instructions: 4000 } as const;

type Loose = Record<string, unknown>;

export function parseSuggestion(raw: unknown, draft: Loose): SkillSuggestion {
  const match = /\{[\s\S]*\}/.exec(String(raw || ""));
  if (!match) throw new Error("NOVA gaf geen bruikbaar voorstel terug.");
  let data: Loose;
  try {
    data = JSON.parse(match[0]) as Loose;
  } catch {
    throw new Error("NOVA gaf geen bruikbaar voorstel terug.");
  }
  const out: SkillSuggestion["changes"] = {};
  for (const key of ["name", "description", "instructions"] as const) {
    const value = data[key];
    if (
      typeof value === "string" &&
      value.trim() &&
      value.trim() !== String(draft[key] ?? "").trim()
    )
      out[key] = value.trim().slice(0, limits[key]);
  }
  if (draft.type !== "instruction") delete out.instructions;
  if (Array.isArray(data.examples)) {
    const examples = (data.examples as unknown[])
      .filter(
        (item): item is string => typeof item === "string" && !!item.trim(),
      )
      .map((item) => item.trim().slice(0, 120))
      .slice(0, 6);
    if (
      examples.length &&
      JSON.stringify(examples) !== JSON.stringify(draft.examples ?? [])
    )
      out.examples = examples;
  }
  const known = new Set(
    ((draft.parameters ?? []) as { name: string }[]).map((item) => item.name),
  );
  if (
    data.parameterDescriptions &&
    typeof data.parameterDescriptions === "object"
  ) {
    const described = Object.fromEntries(
      Object.entries(data.parameterDescriptions as Loose)
        .filter(
          (entry): entry is [string, string] =>
            known.has(entry[0]) &&
            typeof entry[1] === "string" &&
            !!entry[1].trim(),
        )
        .map(([name, text]) => [name, text.trim().slice(0, 200)]),
    );
    if (Object.keys(described).length) out.parameterDescriptions = described;
  }
  const notes =
    typeof data.notes === "string" ? data.notes.trim().slice(0, 500) : "";
  return { changes: out, notes };
}

export const DRAFT_SYSTEM = `Je maakt een vaardigheid voor NOVA, een Nederlandse spraakassistent, uit wat een gewone gebruiker in eigen woorden beschrijft.
Er zijn twee soorten:
- "instruction": een draaiboek. NOVA voert het uit met gereedschappen die hij al heeft (lampen, timers, muziek, servers, weer, zoeken). Gebruik dit tenzij de gebruiker een webadres geeft of vraagt om een dienst aan te roepen.
- "webhook": een aanroep naar een dienst. Alleen als de gebruiker zelf een URL noemt.
Antwoord uitsluitend met een JSON-object:
{ "type": "instruction" of "webhook", "name": korte naam, "description": een of twee zinnen die zeggen WANNEER NOVA dit gebruikt, "examples": 3 tot 5 zinnen zoals een gebruiker ze hardop zegt, "notes": een korte uitleg voor de gebruiker }
Bij instruction ook: "instructions": duidelijke stappen in gewone taal.
Bij webhook ook: "method", "url" (uitsluitend de URL die de gebruiker noemde, nooit zelf verzinnen), "body" (optioneel), "parameters": [{"name","type","description","required"}], "risk": "READ_ONLY" bij alleen lezen, anders "CONFIRM", "extract" (optioneel pad naar het nuttige deel van het antwoord).
Gebruik {parameternaam} in de url of body waar NOVA een waarde moet invullen. Schrijf in het Nederlands, zonder uitleg buiten het JSON-object.`;

const URL_IN_TEXT = /https?:\/\/[^\s"')]+/gi;

export interface DraftResult {
  draft: SkillInput;
  fellBack: boolean;
  notes: string;
}

/** Whatever the model says, the result is always a skill that passes the same checks as one typed by hand. */
export function buildDraft(raw: unknown, userText: string): DraftResult {
  const text = String(userText).trim();
  const fallback = (): SkillInput => ({
    type: "instruction",
    name:
      text
        .split(/\s+/)
        .slice(0, 4)
        .join(" ")
        .replace(/[^\p{L}\p{N} ]/gu, "")
        .trim() || "Nieuwe vaardigheid",
    description: (text.split(/[.!?\n]/)[0] ?? "").slice(0, 200),
    examples: [],
    instructions: text.slice(0, 4000),
  });
  let data: Loose;
  try {
    data = JSON.parse(
      /\{[\s\S]*\}/.exec(String(raw || ""))?.[0] ?? "",
    ) as Loose;
  } catch {
    return {
      draft: fallback(),
      fellBack: true,
      notes:
        "Ik kon geen mooi voorstel maken, dus ik heb je eigen tekst als instructie gebruikt. Pas hem gerust aan.",
    };
  }
  const draft: SkillInput = {
    type: data.type === "webhook" ? "webhook" : "instruction",
    name: String(data.name ?? "")
      .trim()
      .slice(0, 60),
    description: String(data.description ?? "")
      .trim()
      .slice(0, 300),
    examples: (Array.isArray(data.examples) ? (data.examples as unknown[]) : [])
      .filter(
        (item): item is string => typeof item === "string" && !!item.trim(),
      )
      .map((item) => item.trim().slice(0, 120))
      .slice(0, 6),
  };
  if (draft.type === "instruction") {
    // Models sometimes answer with a list of steps instead of one text.
    const steps = Array.isArray(data.instructions)
      ? (data.instructions as unknown[])
          .map((step) => String(step).trim())
          .join("\n")
      : String(data.instructions ?? "");
    draft.instructions = steps.trim().slice(0, 4000);
  } else {
    // A web address is only ever the one the person wrote themselves.
    const given = text.match(URL_IN_TEXT) ?? [];
    const asked = String(data.url ?? "").trim();
    const host = (value: string) => {
      try {
        return new URL(value.replace(/\{[a-z0-9_]+\}/gi, "x")).host;
      } catch {
        return null;
      }
    };
    if (
      !asked ||
      !host(asked) ||
      !given.some((url) => host(url) === host(asked))
    )
      return {
        draft: fallback(),
        fellBack: true,
        notes:
          "De dienst die je noemde kon ik niet zeker overnemen, dus ik heb er een draaiboek van gemaakt. Wil je een echte aanroep, kies dan “Meer instellingen”.",
      };
    const method = String(data.method).toUpperCase();
    const known = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)
      ? method
      : "GET";
    draft.http = {
      method: known,
      url: asked,
      body: typeof data.body === "string" ? data.body : "",
      extract: typeof data.extract === "string" ? data.extract : "",
      headers: [],
      secretHeaders: [],
      timeoutMs: 10000,
      allowPrivate: false,
    };
    draft.parameters = Array.isArray(data.parameters)
      ? (data.parameters as SkillInput["parameters"])
      : [];
    draft.risk =
      data.risk === "READ_ONLY" && known === "GET" ? "READ_ONLY" : "CONFIRM";
  }
  try {
    validateDraft(draft);
  } catch {
    return {
      draft: fallback(),
      fellBack: true,
      notes:
        "Het voorstel klopte niet helemaal, dus ik heb je eigen tekst als instructie gebruikt. Pas hem gerust aan.",
    };
  }
  return {
    draft,
    fellBack: false,
    notes:
      typeof data.notes === "string" ? data.notes.trim().slice(0, 400) : "",
  };
}
