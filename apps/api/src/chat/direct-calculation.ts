import { calculate } from "../integrations/world/calculate.js";

/** Return a result only for an explicit, self-contained calculator request. */
export function directCalculation(message: string): number | null {
  const match = message
    .trim()
    .match(
      /^(?:please\s+)?(?:calculate|compute|work out|what is|how much is|bereken|reken uit|wat is|hoeveel is)\s+(.+?)[?.!]*$/i,
    );
  if (!match) return null;

  const expression = match[1]!
    .replace(/\bdivided by\b/gi, "/")
    .replace(/\bdivided\s+by\b/gi, "/")
    .replace(/\b(gedeeld door)\b/gi, "/")
    .replace(/\b(multiplied by|times)\b/gi, "*")
    .replace(/\b(keer|maal)\b/gi, "*")
    .replace(/\bplus\b/gi, "+")
    .replace(/\bminus\b/gi, "-");
  if (!/^[\d\s.,()+\-*/^%×÷a-z]+$/i.test(expression)) return null;
  try {
    return calculate(expression);
  } catch {
    return null;
  }
}

export function directCalculationReply(
  value: number,
  language: "nl" | "en" | undefined,
): string {
  const formatted = String(value).replace(".", language === "en" ? "." : ",");
  return language === "en"
    ? `The answer is ${formatted}.`
    : `Het antwoord is ${formatted}.`;
}
