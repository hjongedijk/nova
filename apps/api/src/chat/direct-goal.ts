/**
 * Explicit delegation without a model: "regel dat voor me", "zoek uit waarom mijn wifi traag is", "sort this out" start a
 * background goal straight away; "houd mijn servers in de gaten" / "laat me weten als cover.garage open is" create a standing
 * objective when one of the known templates clearly fits. Everything vaguer, and every plain question, goes to the model.
 */
export type DirectGoal =
  | { kind: "agent"; goal: string }
  | {
      kind: "objective";
      title: string;
      template: "servers_gezond" | "ha_waarde" | "agenda_leeg";
      params: Record<string, unknown>;
    };

export const DELEGATION_REPLY =
  "Ik ga ermee aan de slag en meld me zodra het klaar is.";

const MIN_WORDS = 4;
const MAX_LENGTH = 600;

const POLITE =
  /^(?:(?:nova|hey nova|hallo nova)[,:]?\s+)?(?:(?:(?:kun|kan|kunt|wil|wilt|zou|zouden)\s+(?:je|jij|u|jullie)|(?:could|can|would|will)\s+you|please|alsjeblieft|alstublieft|even|graag|nu)\s+)*/i;

/** A sentence that starts like this asks something; it does not delegate anything. */
const QUESTION_START = new Set([
  "wat",
  "wie",
  "waar",
  "wanneer",
  "waarom",
  "hoe",
  "welke",
  "welk",
  "hoeveel",
  "is",
  "zijn",
  "was",
  "waren",
  "kan",
  "kun",
  "kunt",
  "heb",
  "heeft",
  "hebben",
  "doe",
  "doet",
  "wordt",
  "worden",
  "what",
  "who",
  "where",
  "when",
  "why",
  "how",
  "which",
  "are",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "will",
  "would",
]);

/** "regel is ...", "onderzoek naar ..." are nouns, not commands. */
const NOUN_FOLLOW = new Set([
  "is",
  "zijn",
  "was",
  "waren",
  "van",
  "naar",
  "heeft",
  "hebben",
  "wordt",
  "worden",
  "toont",
  "laat",
  "kost",
  "duurt",
  "blijkt",
  "bevestigt",
  "doet",
  "en",
  "of",
]);

/** After "zoek ... uit" the word "uit" is a particle only at the end or before one of these. */
const UIT_THEN = new Set([
  "waarom",
  "hoe",
  "wat",
  "of",
  "wie",
  "waar",
  "wanneer",
  "welke",
  "welk",
  "hoeveel",
  "voor",
  "en",
  "zodat",
  "dat",
  "en",
  "daarna",
  "alvast",
]);

const INFINITIVE_END =
  /(?:^|\s)(?:regelen|uitzoeken|onderzoeken|afwerken|afhandelen)$/;

const words = (text: string) => text.split(/\s+/).filter(Boolean);

function normalise(message: string): { rest: string; polite: boolean } | null {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_LENGTH) return null;
  const prefix = POLITE.exec(text)?.[0] ?? "";
  const rest = text.slice(prefix.length).replace(/[.!\s]+$/, "");
  const polite =
    /(?:kun|kan|kunt|wil|wilt|zou|zouden|could|can|would|will)\s/i.test(prefix);
  const question = /\?\s*$/.test(rest);
  if (question && !polite) return null;
  return { rest: rest.replace(/\s*\?+$/, "").trim(), polite };
}

function particle(
  tokens: string[],
  verb: string,
  particleWord: string,
): boolean {
  // verb at the start, particle later; for "uit" the next word decides.
  if (tokens[0]?.toLowerCase() !== verb) return false;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i]!.toLowerCase() !== particleWord) continue;
    if (particleWord !== "uit") return true;
    const next = tokens[i + 1]?.toLowerCase();
    if (next === undefined || UIT_THEN.has(next)) return true;
  }
  return false;
}

function isAgentGoal(rest: string, polite: boolean): boolean {
  const tokens = words(rest);
  if (tokens.length < MIN_WORDS) return false;
  const first = tokens[0]!.toLowerCase();
  const second = tokens[1]?.toLowerCase() ?? "";
  if (QUESTION_START.has(first)) return false;
  const lower = rest.toLowerCase();
  if (first === "regel") return !NOUN_FOLLOW.has(second);
  if (first === "onderzoek") return !NOUN_FOLLOW.has(second);
  if (first === "zoek")
    return !NOUN_FOLLOW.has(second) && particle(tokens, "zoek", "uit");
  if (first === "werk") return particle(tokens, "werk", "af");
  if (first === "handel") return particle(tokens, "handel", "af");
  if (first === "plan") return /^plan en voer\b.*\buit\b/.test(lower);
  if (first === "sort") return /^sort (?:out\b.+|.+\bout\b.*)/.test(lower);
  if (first === "figure") return /^figure (?:out\b.+|.+\bout\b.*)/.test(lower);
  return polite && INFINITIVE_END.test(lower);
}

const HA_ENTITY =
  /\b((?:cover|light|switch|binary_sensor|sensor|lock|climate|fan|media_player|input_boolean|alarm_control_panel)\.[a-z0-9_]+)\b\s*(?:(==|!=|>=|<=|>|<)\s*)?([a-z0-9_.-]{1,40})?/i;

function objectiveFor(
  subject: string,
): Pick<
  Extract<DirectGoal, { kind: "objective" }>,
  "template" | "params"
> | null {
  const text = subject.toLowerCase();
  const entity = HA_ENTITY.exec(text);
  if (entity) {
    const value = entity[3];
    if (!value || ["is", "staat", "blijft", "de", "het"].includes(value))
      return null;
    return {
      template: "ha_waarde",
      params: {
        entity: entity[1],
        operator: entity[2] ?? "==",
        value,
        consecutive: 2,
      },
    };
  }
  if (
    /\b(agenda|kalender|calendar)\b/.test(text) &&
    /\b(leeg|empty)\b/.test(text)
  )
    return { template: "agenda_leeg", params: {} };
  if (
    /\b(servers?|proxmox|nodes?|vm'?s|homelab|virtuele machines|containers?)\b/.test(
      text,
    )
  )
    return { template: "servers_gezond", params: {} };
  return null;
}

const OBJECTIVE_PATTERNS: RegExp[] = [
  /^houd\s+(.+?)\s+(?:goed\s+)?in\s+de\s+gaten\b.*$/i,
  /^(?:laat|let)\s+(?:het\s+)?(?:me|mij)\s+weten\s+(?:als|wanneer|zodra)\s+(.+)$/i,
  /^zorg\s+(?:er\s+)?(?:voor\s+)?dat\s+(.+?)\s+(?:gezond\s+|online\s+|in\s+orde\s+)?(?:blijft|blijven)\b.*$/i,
  /^keep\s+an\s+eye\s+on\s+(.+)$/i,
  /^let\s+me\s+know\s+(?:if|when)\s+(.+)$/i,
];

function objectiveRequest(rest: string): DirectGoal | null {
  if (words(rest).length < 3) return null;
  for (const pattern of OBJECTIVE_PATTERNS) {
    const subject = pattern.exec(rest)?.[1];
    if (!subject) continue;
    const template = objectiveFor(subject);
    if (!template) return null;
    return { kind: "objective", title: rest.slice(0, 120), ...template };
  }
  return null;
}

export function directGoalQuery(message: string): DirectGoal | null {
  if (typeof message !== "string") return null;
  const parsed = normalise(message);
  if (!parsed) return null;
  const objective = objectiveRequest(parsed.rest);
  if (objective) return objective;
  if (isAgentGoal(parsed.rest, parsed.polite))
    return { kind: "agent", goal: parsed.rest };
  return null;
}
