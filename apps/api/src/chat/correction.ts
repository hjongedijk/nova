import { looksSensitive } from "../memory/semantic/lifecycle.js";
import type { MemoryType } from "../memory/semantic/candidate.js";

/**
 * What a correction turn teaches. Pure: no I/O. "Nee, mijn hond heet Max" corrects a fact; "doe dat
 * niet meer" is a procedure to stop; "de grote lamp is light.woonkamer" teaches a home alias.
 */
export interface CorrectionSignal {
  /** The corrected fact, preference or rule in the owner's words, ready for memory. Null: nothing to store. */
  statement: string | null;
  type: MemoryType;
  alias: { name: string; entity: string } | null;
  /** The owner told NOVA to stop doing something ("doe dat niet meer"). */
  stop: boolean;
}

const MARKER = new RegExp(
  "^\\s*(?:" +
    [
      "nee+[,.!:]?",
      "no[,.!:]",
      "nope[,.!:]?",
      "dat klopt niet[,.!:]?",
      "(?:het|dat) klopt niet[,.!:]?",
      "klopt niet[,.!:]?",
      "dat is (?:niet (?:juist|waar|goed|correct)|fout|onjuist|verkeerd)[,.!:]?",
      "(?:het is |dat is )?fout[,.!:]?",
      "(?:dat|dit) bedoelde ik niet[,.!:]?",
      "dat bedoel ik niet[,.!:]?",
      "dat is niet wat ik bedoel(?:de)?[,.!:]?",
      "that(?:'s| is) (?:not right|not correct|wrong|incorrect)[,.!:]?",
      "that(?:'s| is) not what i meant[,.!:]?",
      "(?:that|this) is not true[,.!:]?",
      "you(?:'re| are) wrong[,.!:]?",
      "wrong[,.!:]",
      "not quite[,.!:]?",
      "i didn'?t mean that[,.!:]?",
    ].join("|") +
    ")\\s*",
  "i",
);
const STOP =
  /\b(?:doe (?:dat|het|dit) (?:niet|nooit) meer|doe dat niet|niet meer doen|stop (?:daar|ermee|hiermee|daarmee)|(?:please )?(?:don'?t|do not|never) do that(?: again| anymore)?|stop doing that)\b/i;
const QUESTION = /\?\s*$/;
const ENTITY =
  /\b((?:light|switch|climate|cover|media_player|sensor|binary_sensor|fan|lock|scene|script|input_boolean|vacuum|camera|automation|humidifier|water_heater)\.[a-z0-9_]{2,60})\b/i;
const ALIAS_IS = new RegExp(
  "^(?:(?:die|dat|de|het|een)\\s+)?([\\p{L}][\\p{L}\\p{N} '-]{1,40}?)\\s+(?:is|=|was|betekent|means|=>)\\s+(?:de |het |the )?" +
    ENTITY.source +
    "\\b",
  "iu",
);
const ALIAS_MEANT = new RegExp(
  "^(?:met\\s+)?(?:die|dat|de|het)?\\s*([\\p{L}][\\p{L}\\p{N} '-]{1,40}?)\\s+(?:bedoel ik|bedoelde ik|i mean|i meant)\\s+(?:de |het |the )?" +
    ENTITY.source +
    "\\b",
  "iu",
);

/** A correction is a short turn; long pasted text is content, not feedback. */
const MAX_CORRECTION = 400;

function trimStatement(value: string): string {
  return value.replace(/^[\s,.:;!-]+|[\s]+$/g, "");
}

export function detectCorrection(message: string): CorrectionSignal | null {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_CORRECTION) return null;
  const marker = MARKER.exec(text);
  const stop = STOP.test(text);
  if (!marker && !stop) {
    // "Met de grote lamp bedoel ik light.woonkamer" teaches a name without being a rebuke.
    const taught = ALIAS_MEANT.exec(text);
    return taught && /^met\s/i.test(text) ? buildSignal(text, false) : null;
  }
  // A bare "nee" answers a yes/no question; it only corrects when something follows.
  const rest = trimStatement(marker ? text.slice(marker[0].length) : text);
  if (marker && !rest && !stop) return null;
  if (marker && QUESTION.test(rest) && !stop) return null;
  return buildSignal(rest, stop);
}

function buildSignal(rest: string, stop: boolean): CorrectionSignal | null {
  const aliasMatch = ALIAS_IS.exec(rest) ?? ALIAS_MEANT.exec(rest);
  if (aliasMatch) {
    const name = aliasMatch[1]!.trim();
    const entity = aliasMatch[2]!.toLowerCase();
    if (!/^(?:dit|dat|het|die|deze|it|this|that)$/i.test(name))
      return {
        statement: `${name} is ${entity}`,
        type: "LEARNED_ALIAS",
        alias: { name, entity },
        stop,
      };
  }
  if (stop) {
    const only = trimStatement(rest.replace(STOP, ""));
    return {
      statement: only.length >= 5 ? `${only}. Doe dat niet meer.` : null,
      type: "PROCEDURE",
      alias: null,
      stop: true,
    };
  }
  if (rest.length < 5 || QUESTION.test(rest)) return null;
  const type: MemoryType =
    /\b(voorkeur|prefer|graag|liever|altijd|nooit|always|never)\b/i.test(rest)
      ? "PREFERENCE"
      : "USER_FACT";
  return { statement: rest, type, alias: null, stop: false };
}

/** Secrets never reach memory; the candidate filter also checks, this is the cheap first gate. */
export const learnable = (statement: string): boolean =>
  !looksSensitive(statement);
