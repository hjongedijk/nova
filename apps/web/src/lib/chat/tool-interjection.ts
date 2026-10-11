const LINES = [
  "Ik kijk het even na.",
  "Moment, ik zoek dat voor je uit.",
  "Ik controleer dat even.",
] as const;

export function nextToolInterjection(
  previous: string,
  random: () => number = Math.random,
): string {
  const choices = LINES.filter((line) => line !== previous);
  const index = Math.min(
    choices.length - 1,
    Math.floor(random() * choices.length),
  );
  return choices[index] ?? LINES[0];
}
