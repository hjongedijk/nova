export type CookingCommand = "next" | "repeat" | "previous" | "stop";

/** Treat each non-empty line as one step; do not send pasted recipe text to a model. */
export function parseRecipe(input: string): string[] {
  if (input.length > 12_000) return [];
  const steps = input
    .split(/\n+/)
    .map((line) => line.trim().replace(/^(?:stap\s*)?\d+[.)\-:]\s*/i, ""))
    .filter(Boolean);
  return steps.length >= 1 &&
    steps.length <= 30 &&
    steps.every((s) => s.length <= 400)
    ? steps
    : [];
}

export function cookingCommand(text: string): CookingCommand | null {
  const command = text
    .trim()
    .toLocaleLowerCase("nl-NL")
    .replace(/[.!?]+$/, "");
  if (/^(?:nova[, ]+)?volgende(?: stap)?$/.test(command)) return "next";
  if (/^(?:nova[, ]+)?(?:herhaal|herhaal(?: deze| de)? stap)$/.test(command))
    return "repeat";
  if (/^(?:nova[, ]+)?vorige(?: stap)?$/.test(command)) return "previous";
  if (/^(?:nova[, ]+)?stop kookmodus$/.test(command)) return "stop";
  return null;
}
