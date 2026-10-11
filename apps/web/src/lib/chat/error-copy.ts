import type { ConversationLanguage } from "./session.ts";

/** Turn backend diagnostics into short chat copy; raw details stay in developer logs. */
export function friendlyChatError(
  error: unknown,
  language: ConversationLanguage = "nl",
): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.toLowerCase();
  if (
    /omniroute.*not configured|no verified free|no available free|geen geverifieerde gratis/.test(
      message,
    )
  )
    return language === "en"
      ? "NOVA has no available free AI route right now. Check the model settings."
      : "NOVA heeft nu geen beschikbare gratis AI-route. Controleer de modelinstellingen.";
  if (/already active|al actief|session.*busy/.test(message))
    return language === "en"
      ? "A reply is already in progress in this chat. Wait a moment and try again."
      : "Er loopt al een antwoord in dit gesprek. Wacht even en probeer het opnieuw.";
  if (
    /timeout|timed out|etimedout|econnreset|econnrefused|fetch failed|network|502|503|504/.test(
      message,
    )
  )
    return language === "en"
      ? "NOVA could not reach a service just now. Please try again in a moment."
      : "NOVA kon een dienst net niet bereiken. Probeer het zo nog eens.";
  if (
    /attachment|bijlage|file|bestand|unsupported|mime|too large|te groot/.test(
      message,
    )
  )
    return language === "en"
      ? "I could not read that attachment. Check the file type and size, then try again."
      : "Ik kon die bijlage niet lezen. Controleer het bestandstype en de grootte en probeer het opnieuw.";
  return language === "en"
    ? "That did not work. Please try again; if it keeps happening, tell me what you were doing."
    : "Dat ging niet goed. Probeer het opnieuw; blijft dit gebeuren, vertel dan wat je aan het doen was.";
}
