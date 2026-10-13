import type { OrbEvent } from "#lib/entity/orb.ts";

interface EasterEgg {
  reply: string;
  event: OrbEvent;
}

/** Exact, harmless local phrases. No model or tool call, and no substring triggers. */
export function easterEgg(text: string): EasterEgg | null {
  const phrase = text
    .trim()
    .toLocaleLowerCase("nl-NL")
    .replace(/[.!?]+$/, "");
  if (/^(?:nova[, ]+)?high[ -]?five$/.test(phrase))
    return { reply: "High five!", event: "check" };
  if (/^(?:nova[, ]+)?feestmodus$/.test(phrase))
    return { reply: "Een klein feestje voor jou!", event: "heart" };
  if (/^(?:nova[, ]+)?slaap lekker$/.test(phrase))
    return { reply: "Slaap lekker. Ik houd het rustig.", event: "sleep" };
  return null;
}
