const DEFAULT_LINES = [
  "Ik kijk het even na.",
  "Moment, ik zoek dat voor je uit.",
  "Ik controleer dat even.",
] as const;

const CONTEXT: [RegExp, readonly string[]][] = [
  [
    /^(ha_|home_|media_|sonos_|music_)/,
    [
      "Ik kijk eerst welke apparaten beschikbaar zijn.",
      "Ik zet de gevraagde sfeer nu voor je klaar.",
      "Ik controleer zo of alles goed staat.",
    ],
  ],
  [
    /^calendar_/,
    [
      "Ik kijk eerst in je agenda.",
      "Ik controleer de afspraakgegevens.",
      "Ik werk je agenda nu bij.",
    ],
  ],
  [
    /^(documents_|notes_)/,
    [
      "Ik zoek in je eigen documenten.",
      "Ik haal de relevante informatie erbij.",
      "Ik controleer nog een detail in je documenten.",
    ],
  ],
  [
    /^(web_search|web_read|wikipedia|news_headlines)/,
    [
      "Ik zoek daar eerst betrouwbare informatie over op.",
      "Ik lees de relevante bron erbij.",
      "Ik vergelijk dit nog even met een tweede bron.",
    ],
  ],
];

export function nextToolInterjection(
  previous: string,
  toolNameOrRandom: string | (() => number) = "",
  stepOrRandom: number | (() => number) = 1,
  random: () => number = Math.random,
): string {
  const toolName = typeof toolNameOrRandom === "string" ? toolNameOrRandom : "";
  if (typeof toolNameOrRandom === "function") random = toolNameOrRandom;
  if (typeof stepOrRandom === "function") random = stepOrRandom;
  const contextual = CONTEXT.find(([pattern]) => pattern.test(toolName))?.[1];
  const lines = contextual ?? DEFAULT_LINES;
  const choices = lines.filter((line) => line !== previous);
  const index = Math.min(
    choices.length - 1,
    Math.floor(random() * choices.length),
  );
  const line = choices[index] ?? lines[0] ?? DEFAULT_LINES[0];
  return typeof stepOrRandom === "number" && stepOrRandom > 1
    ? `Vervolgens: ${line}`
    : line;
}
