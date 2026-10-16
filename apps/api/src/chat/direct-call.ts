export interface DirectCall {
  /** "me" means the one saved contact (the user's own phone). */
  to: string;
  message: string;
}

const DEFAULT_MESSAGE = "Hallo, met Nova. Je vroeg me om je te bellen.";
const ME = new Set(["mij", "me", "mezelf", "ik", "mijn telefoon"]);

/**
 * A plain "bel mij" / "bel Harm" / "bel Harm en zeg dat het eten klaar is" never needs a model: the request is exact,
 * so it also works while every free model is down. Anything vaguer ("bel mij en vertel het weer") goes to the model.
 */
export function directCallQuery(message: string): DirectCall | null {
  const match =
    /^\s*(?:(?:kun|kan|wil|zou) je |please )?(?:even )?(?:bel|call)\s+(?<who>\p{L}[\p{L}'-]{0,30})(?: (?:even|nu|alsjeblieft|a?lsjeblieft))?(?:\s*(?:,|en|and)?\s*(?:zeg|say)(?: dat)?\s+(?<text>.{1,300}?))?\s*[.!?]*\s*$/iu.exec(
      message,
    );
  const who = match?.groups?.who;
  if (!who) return null;
  const text = match.groups?.text?.trim();
  return {
    to: ME.has(who.toLowerCase()) ? "me" : who,
    message: text || DEFAULT_MESSAGE,
  };
}
