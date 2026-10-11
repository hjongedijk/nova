export interface DirectCurrencyRequest {
  amount: number;
  from: string;
  to: string;
  language: "nl" | "en";
}

/** Explicit currency-code conversion only; ambiguous words such as "pound" are not guessed. */
export function directCurrencyQuery(
  message: string,
  responseLanguage?: "nl" | "en",
): DirectCurrencyRequest | null {
  const match = message
    .trim()
    .match(
      /^(?:please\s+)?(?:convert|converteer|reken\s+om|hoeveel\s+is|how\s+much\s+is)\s+(\d+(?:[.,]\d+)?)\s+([a-z]{3})\s+(?:to|naar|in)\s+([a-z]{3})[?.!]*$/i,
    );
  if (!match) return null;
  const amount = Number(match[1]!.replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  const detectedLanguage = /^(?:converteer|reken\s+om|hoeveel\s+is)/i.test(
    message.trim(),
  )
    ? "nl"
    : "en";
  return {
    amount,
    from: match[2]!.toUpperCase(),
    to: match[3]!.toUpperCase(),
    language: responseLanguage ?? detectedLanguage,
  };
}

export function directCurrencyReply(
  value: unknown,
  language: "nl" | "en",
): string {
  const result = value as
    | {
        amount?: unknown;
        from?: unknown;
        to?: unknown;
        converted?: unknown;
        date?: unknown;
        source?: unknown;
      }
    | undefined;
  if (
    !result ||
    typeof result.amount !== "number" ||
    typeof result.from !== "string" ||
    typeof result.to !== "string" ||
    typeof result.converted !== "number"
  )
    return language === "en"
      ? "I couldn't get a current exchange rate."
      : "Ik kon geen actuele wisselkoers ophalen.";
  const format = (number: number) =>
    new Intl.NumberFormat(language === "en" ? "en-US" : "nl-NL", {
      maximumFractionDigits: 2,
    }).format(number);
  const date = typeof result.date === "string" ? ` (${result.date})` : "";
  const source = typeof result.source === "string" ? result.source : "ECB";
  return `${format(result.amount)} ${result.from} = ${format(result.converted)} ${result.to} (${source}${date}).`;
}
