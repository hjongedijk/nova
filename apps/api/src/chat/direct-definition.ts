export interface DirectDefinitionRequest {
  query: string;
  language: "nl" | "en";
}

/** Match only explicit, short definition/look-up wording; ordinary questions stay in chat. */
export function directDefinitionQuery(
  message: string,
  responseLanguage?: "nl" | "en",
): DirectDefinitionRequest | null {
  const text = message.trim();
  const patterns: [RegExp, "nl" | "en"][] = [
    [
      /^(?:definieer|wat betekent|wat is de betekenis van|zoek (?:eens )?op)\s+(.+?)[?.!]*$/i,
      "nl",
    ],
    [/^define\s+(.+?)[?.!]*$/i, "en"],
    [/^look up\s+(.+?)[?.!]*$/i, "en"],
    [/^what does\s+(.+?)\s+mean[?.!]*$/i, "en"],
  ];
  for (const [pattern, detectedLanguage] of patterns) {
    const match = text.match(pattern);
    const query = match?.[1]?.trim().replace(/\s+/g, " ");
    if (!query || query.length < 2 || query.length > 100) continue;
    if (/https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(query))
      return null;
    return { query, language: responseLanguage ?? detectedLanguage };
  }
  return null;
}

export function directDefinitionReply(
  value: unknown,
  language: "nl" | "en",
  spoken = false,
): string {
  const result = value as
    { title?: unknown; summary?: unknown; url?: unknown } | undefined;
  if (
    !result ||
    typeof result.title !== "string" ||
    typeof result.summary !== "string" ||
    !result.summary.trim()
  )
    return language === "en"
      ? "I couldn't find a short definition for that in Wikipedia."
      : "Ik vond daar geen korte definitie van op Wikipedia.";
  const summary = result.summary.trim().slice(0, 1200);
  const title = result.title.trim().slice(0, 120);
  const prefix =
    language === "en" ? "According to Wikipedia" : "Volgens Wikipedia";
  const citation =
    !spoken &&
    typeof result.url === "string" &&
    /^https:\/\/[a-z]{2,3}\.wikipedia\.org\/wiki\//.test(result.url)
      ? ` ([${title}](${result.url}))`
      : "";
  return `${prefix}: ${title}. ${summary}${citation}`;
}
