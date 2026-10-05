import type {
  HttpMethod,
  InstructionSkill,
  Skill,
  SkillHeader,
  SkillInput,
  SkillParameter,
  SkillParameterType,
  SkillRisk,
  WebhookSkill,
} from "@nova/contracts";
import { ValidationError } from "../../core/errors/validation.error.js";

/*
 * User-made skills. Two kinds:
 *  - instruction: a playbook NOVA follows with the tools it already has ("filmavond":
 *    dim the lights, start the TV). It is offered to the model when the request matches.
 *  - webhook: an HTTP call with parameters of your own, which becomes a real tool.
 */

/** A webhook as stored: the secret header values are still in it. */
export type StoredWebhookSkill = Omit<WebhookSkill, "http"> & {
  http: Omit<WebhookSkill["http"], "secretHeaders"> & {
    secretHeaders: SkillHeader[];
  };
};
export type StoredSkill = InstructionSkill | StoredWebhookSkill;

export const RISKS: SkillRisk[] = ["READ_ONLY", "SAFE", "CONFIRM"];
const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const PARAMETER_TYPES: SkillParameterType[] = [
  "string",
  "number",
  "integer",
  "boolean",
];
const placeholder = () => /\{([a-z][a-z0-9_]*)\}/g;

export const slugify = (name: unknown): string =>
  String(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

export const toolNameFor = (skill: { id: string }): string =>
  `skill_${skill.id}`;

const clean = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
const fail = (message: string): never => {
  throw new ValidationError([message]);
};

function placeholdersIn(...templates: unknown[]): Set<string> {
  const found = new Set<string>();
  for (const template of templates)
    for (const match of String(template ?? "").matchAll(placeholder()))
      found.add(match[1]!);
  return found;
}

function normalizeParameters(input: unknown): SkillParameter[] {
  if (input == null) return [];
  if (!Array.isArray(input))
    return fail("De parameters moeten een lijst zijn.");
  if (input.length > 8) fail("Maximaal 8 parameters.");
  const seen = new Set<string>();
  return input.map((item: Record<string, unknown> | null, index) => {
    const name = clean(item?.name);
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(name))
      fail(
        `Parameter ${index + 1}: de naam moet met een kleine letter beginnen en mag alleen kleine letters, cijfers en _ bevatten.`,
      );
    if (seen.has(name)) fail(`De parameter “${name}” staat er twee keer in.`);
    seen.add(name);
    const type = PARAMETER_TYPES.includes(item?.type as SkillParameterType)
      ? (item?.type as SkillParameterType)
      : "string";
    const description = clean(item?.description).slice(0, 200);
    const choices = Array.isArray(item?.enum)
      ? (item.enum as unknown[]).map(clean).filter(Boolean)
      : [];
    if (choices.length > 20) fail(`Parameter “${name}”: maximaal 20 keuzes.`);
    if (choices.length && type !== "string")
      fail(`Parameter “${name}”: keuzes kunnen alleen bij tekst.`);
    return {
      name,
      type,
      description,
      required: item?.required !== false,
      ...(choices.length ? { enum: choices } : {}),
    };
  });
}

function normalizeHttp(
  input: SkillInput["http"],
  parameters: SkillParameter[],
  existing?: StoredSkill,
): StoredWebhookSkill["http"] {
  if (!input || typeof input !== "object")
    return fail("De HTTP-aanroep ontbreekt.");
  const upper = String(input.method).toUpperCase() as HttpMethod;
  const method = METHODS.includes(upper) ? upper : "GET";
  const url = clean(input.url);
  if (!url) fail("De URL is verplicht.");
  if (url.length > 500) fail("De URL is te lang.");
  try {
    const probe = new URL(url.replace(placeholder(), "x"));
    if (!["http:", "https:"].includes(probe.protocol))
      fail("De URL moet met http:// of https:// beginnen.");
    if (probe.username || probe.password)
      fail(
        "Zet geen gebruikersnaam of wachtwoord in de URL; gebruik een geheime header.",
      );
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail("Dit is geen geldige URL.");
  }
  const body = typeof input.body === "string" ? input.body : "";
  if (body.length > 4000) fail("De body is te lang (maximaal 4000 tekens).");
  if (body && method === "GET") fail("Een GET-aanroep heeft geen body.");

  const headerRows = Array.isArray(input.headers) ? input.headers : [];
  const secretRows = Array.isArray(input.secretHeaders)
    ? input.secretHeaders
    : [];
  if (headerRows.length + secretRows.length > 8) fail("Maximaal 8 headers.");
  const names = new Set<string>();
  const header = (row: Partial<SkillHeader> | null): string => {
    const name = clean(row?.name);
    if (!/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(name))
      fail(`Ongeldige headernaam: “${name}”.`);
    if (/^(?:host|content-length|connection|transfer-encoding)$/i.test(name))
      fail(`De header “${name}” kan niet worden ingesteld.`);
    if (names.has(name.toLowerCase()))
      fail(`De header “${name}” staat er twee keer in.`);
    names.add(name.toLowerCase());
    return name;
  };
  const headers = headerRows.map((row) => ({
    name: header(row),
    value: String(row?.value ?? "").slice(0, 500),
  }));
  const previous = new Map(
    (existing?.type === "webhook" ? existing.http.secretHeaders : []).map(
      (row) => [row.name.toLowerCase(), row.value],
    ),
  );
  const secretHeaders = secretRows.map((row) => {
    const name = header(row);
    // An empty value means "keep the stored secret"; the screen never shows it again.
    const value = row?.value
      ? String(row.value).slice(0, 500)
      : previous.get(name.toLowerCase());
    if (!value) fail(`Geef een waarde op voor de geheime header “${name}”.`);
    return { name, value: value as string };
  });

  const declared = new Set(parameters.map((item) => item.name));
  const used = placeholdersIn(url, body, ...headers.map((row) => row.value));
  for (const name of used)
    if (!declared.has(name))
      fail(
        `In de aanroep staat {${name}}, maar er is geen parameter met die naam.`,
      );

  const timeoutMs = Math.min(
    30000,
    Math.max(1000, Number(input.timeoutMs) || 10000),
  );
  const extract = clean(input.extract);
  if (extract && !/^[A-Za-z0-9_.[\]-]{1,100}$/.test(extract))
    fail(
      "Het pad voor het antwoord mag alleen letters, cijfers, punten en [0] bevatten.",
    );
  return {
    method,
    url,
    headers,
    secretHeaders,
    body,
    timeoutMs,
    allowPrivate: input.allowPrivate === true,
    extract,
  };
}

export function normalizeSkill(
  input: unknown,
  {
    existing,
    takenIds = [],
  }: { existing?: StoredSkill; takenIds?: string[] } = {},
): StoredSkill {
  if (!input || typeof input !== "object")
    return fail("Geen geldige vaardigheid.");
  const data = input as SkillInput;
  const type = existing?.type ?? data.type;
  if (type !== "instruction" && type !== "webhook")
    return fail("Kies een soort: instructie of webhook.");
  const name = clean(data.name);
  if (name.length < 2)
    fail("Geef de vaardigheid een naam van minstens 2 tekens.");
  if (name.length > 60) fail("De naam is te lang (maximaal 60 tekens).");
  const id = existing?.id ?? slugify(name);
  if (!id) fail("Gebruik letters of cijfers in de naam.");
  if (!existing && takenIds.includes(id))
    fail(`Er bestaat al een vaardigheid met de naam “${name}”.`);

  const description = clean(data.description);
  if (type === "webhook" && description.length < 10)
    fail(
      "Beschrijf wanneer NOVA deze aanroep moet gebruiken (minstens 10 tekens). Dat is wat het model leest.",
    );
  if (description.length > 300)
    fail("De beschrijving is te lang (maximaal 300 tekens).");

  const examples = (Array.isArray(data.examples) ? data.examples : [])
    .map(clean)
    .filter(Boolean);
  if (examples.length > 8) fail("Maximaal 8 voorbeelden.");
  if (examples.some((item) => item.length > 120))
    fail("Een voorbeeld is te lang (maximaal 120 tekens).");

  const now = new Date().toISOString();
  const base = {
    id,
    name,
    description,
    examples,
    enabled: data.enabled !== false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
  };

  if (type === "instruction") {
    const instructions = clean(data.instructions);
    if (!instructions) fail("Schrijf de instructies: wat moet NOVA doen?");
    if (instructions.length > 4000)
      fail("De instructies zijn te lang (maximaal 4000 tekens).");
    return { ...base, type, instructions };
  }
  const parameters = normalizeParameters(data.parameters);
  const http = normalizeHttp(data.http, parameters, existing);
  let risk: SkillRisk = RISKS.includes(data.risk as SkillRisk)
    ? (data.risk as SkillRisk)
    : "SAFE";
  // Anything that is not a plain read cannot be called READ_ONLY.
  if (http.method !== "GET" && risk === "READ_ONLY") risk = "SAFE";
  return { ...base, type, parameters, http, risk };
}

/** The skill as the screen sees it: secret header values never leave the server. */
export function publicSkill(skill: StoredSkill): Skill {
  if (skill.type !== "webhook") return skill;
  return {
    ...skill,
    http: {
      ...skill.http,
      secretHeaders: skill.http.secretHeaders.map((row) => ({
        name: row.name,
        set: true as const,
      })),
    },
  };
}

/* ---------- running a webhook ---------- */

export function validateArguments(
  skill: StoredWebhookSkill,
  args: Record<string, unknown> | undefined,
): string[] {
  const problems: string[] = [];
  const known = new Set(skill.parameters.map((item) => item.name));
  for (const key of Object.keys(args ?? {}))
    if (!known.has(key)) problems.push(`Onbekende parameter: ${key}.`);
  for (const item of skill.parameters) {
    const value = args?.[item.name];
    if (value === undefined || value === null || value === "") {
      if (item.required) problems.push(`De parameter ${item.name} ontbreekt.`);
      continue;
    }
    if (item.type === "string" && typeof value !== "string")
      problems.push(`${item.name} moet tekst zijn.`);
    if (
      ["number", "integer"].includes(item.type) &&
      (typeof value !== "number" || !Number.isFinite(value))
    )
      problems.push(`${item.name} moet een getal zijn.`);
    if (item.type === "integer" && !Number.isInteger(value))
      problems.push(`${item.name} moet een geheel getal zijn.`);
    if (item.type === "boolean" && typeof value !== "boolean")
      problems.push(`${item.name} moet waar of onwaar zijn.`);
    if (item.enum && !item.enum.includes(value as string))
      problems.push(
        `${item.name} moet een van deze zijn: ${item.enum.join(", ")}.`,
      );
    if (typeof value === "string" && value.length > 1000)
      problems.push(`${item.name} is te lang.`);
  }
  return problems;
}

const jsonEscape = (value: unknown) =>
  JSON.stringify(String(value)).slice(1, -1);

export function render(
  template: string,
  args: Record<string, unknown> | undefined,
  mode: "url" | "json" | "text",
): string {
  return String(template).replace(placeholder(), (_, name: string) => {
    const value = args?.[name];
    if (value === undefined || value === null) return "";
    return mode === "url"
      ? encodeURIComponent(String(value))
      : mode === "json"
        ? jsonEscape(value)
        : String(value);
  });
}

export function renderRequest(
  skill: StoredWebhookSkill,
  args: Record<string, unknown>,
): {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
} {
  const { http } = skill;
  const headers: Record<string, string> = {};
  for (const row of http.headers)
    headers[row.name] = render(row.value, args, "text");
  for (const row of http.secretHeaders) headers[row.name] = row.value;
  let body: string | undefined;
  if (http.body) {
    body = render(http.body, args, "json");
    if (!headers["Content-Type"] && !headers["content-type"])
      headers["Content-Type"] = /^\s*[{[]/.test(http.body)
        ? "application/json"
        : "text/plain";
  }
  return {
    method: http.method,
    url: render(http.url, args, "url"),
    headers,
    body,
  };
}

/** "data.items[0].name" -> the value, or undefined. */
export function pick(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current = value;
  for (const part of path.split(/[.[\]]+/).filter(Boolean)) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The tool definition parts of a webhook skill. */
export function toolDefinition(skill: StoredWebhookSkill) {
  const properties = Object.fromEntries(
    skill.parameters.map((item) => [
      item.name,
      {
        type: item.type,
        ...(item.description ? { description: item.description } : {}),
        ...(item.enum ? { enum: item.enum } : {}),
      },
    ]),
  );
  return {
    name: toolNameFor(skill),
    description: skill.description,
    properties,
    required: skill.parameters
      .filter((item) => item.required)
      .map((item) => item.name),
    risk: skill.risk,
    timeout: skill.http.timeoutMs + 2000,
  };
}

/* ---------- which playbooks fit the request ---------- */

const STOP = new Set([
  "de",
  "het",
  "een",
  "en",
  "of",
  "ik",
  "je",
  "jij",
  "mijn",
  "dat",
  "dit",
  "die",
  "wat",
  "hoe",
  "is",
  "zijn",
  "voor",
  "met",
  "van",
  "naar",
  "aan",
  "uit",
  "op",
  "in",
  "te",
  "nova",
  "alsjeblieft",
  "even",
]);
const tokens = (value: unknown): string[] =>
  String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP.has(word));

export function relevantPlaybooks(
  message: unknown,
  skills: StoredSkill[],
  limit = 3,
): InstructionSkill[] {
  const said = String(message || "").toLowerCase();
  const words = new Set(tokens(message));
  if (!words.size) return [];
  return skills
    .filter(
      (skill): skill is InstructionSkill =>
        skill.type === "instruction" && skill.enabled,
    )
    .map((skill) => {
      let score = 0;
      for (const example of skill.examples)
        if (example && said.includes(example.toLowerCase())) score += 10;
      for (const word of tokens(skill.name)) if (words.has(word)) score += 3;
      for (const word of tokens(skill.examples.join(" ")))
        if (words.has(word)) score += 1;
      for (const word of tokens(skill.description))
        if (words.has(word)) score += 0.5;
      return { skill, score };
    })
    .filter((item) => item.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.skill);
}

export function formatPlaybooks(playbooks: InstructionSkill[]): string {
  return [
    "Eigen vaardigheden van de gebruiker die bij deze vraag passen. Volg de instructies als ze echt bij de vraag horen, en gebruik je gewone tools om ze uit te voeren:",
    ...playbooks.map(
      (skill) =>
        `- ${skill.name}${skill.description ? ` (${skill.description})` : ""}: ${skill.instructions}`,
    ),
  ].join("\n");
}
