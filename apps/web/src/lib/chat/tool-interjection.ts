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
  language: "nl" | "en" = "nl",
): string {
  const toolName = typeof toolNameOrRandom === "string" ? toolNameOrRandom : "";
  if (typeof toolNameOrRandom === "function") random = toolNameOrRandom;
  if (typeof stepOrRandom === "function") random = stepOrRandom;
  const english = /^(ha_|home_|media_|sonos_|music_)/.test(toolName)
    ? [
        "I am checking which devices are available.",
        "I am setting that up for you now.",
        "I will check that everything is in place.",
      ]
    : /^calendar_/.test(toolName)
      ? [
          "I am checking your calendar.",
          "I am checking the event details.",
          "I am updating your calendar now.",
        ]
      : /^(documents_|notes_)/.test(toolName)
        ? [
            "I am searching your documents.",
            "I am finding the relevant details.",
            "I am checking one more detail in your documents.",
          ]
        : /^(web_search|web_read|wikipedia|news_headlines)/.test(toolName)
          ? [
              "I am looking for reliable information.",
              "I am reading the relevant source.",
              "I am comparing this with another source.",
            ]
          : [
              "I am checking that for you.",
              "One moment, I am looking into it.",
              "I am verifying the next step.",
            ];
  const contextual = CONTEXT.find(([pattern]) => pattern.test(toolName))?.[1];
  const lines = language === "en" ? english : (contextual ?? DEFAULT_LINES);
  const choices = lines.filter((line) => line !== previous);
  const index = Math.min(
    choices.length - 1,
    Math.floor(random() * choices.length),
  );
  const line = choices[index] ?? lines[0] ?? DEFAULT_LINES[0];
  return typeof stepOrRandom === "number" && stepOrRandom > 1
    ? language === "en"
      ? `Next, ${line}`
      : `Vervolgens: ${line}`
    : line;
}
