export type ErrorLanguage = "nl" | "en";

/** Keep transport and integration diagnostics out of user-facing UI. */
export function friendlyApiError(
  error: unknown,
  status = 0,
  language: ErrorLanguage = "nl",
): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.toLowerCase();
  const copy = {
    route:
      language === "en"
        ? "NOVA has no verified free AI route right now. Check model settings."
        : "NOVA heeft nu geen geverifieerde gratis AI-route. Controleer de modelinstellingen.",
    network:
      language === "en"
        ? "NOVA could not reach a connected service. Try again shortly."
        : "NOVA kon een gekoppelde dienst niet bereiken. Probeer het zo opnieuw.",
    generic:
      language === "en"
        ? "That did not work. Check the settings and try again."
        : "Dat is niet gelukt. Controleer de instellingen en probeer het opnieuw.",
  };

  if (
    /omniroute.*not configured|no verified free|geen geverifieerde gratis/.test(
      message,
    )
  )
    return copy.route;
  if (
    /attachment|bijlage|unsupported.*file|file.*type|bestandstype/.test(message)
  )
    return language === "en"
      ? "NOVA could not read that file. Check its type and size."
      : "NOVA kon dat bestand niet lezen. Controleer het type en de grootte.";
  if (/already active|al actief|session.*busy/.test(message))
    return language === "en"
      ? "A request is already running. Wait a moment and try again."
      : "Er loopt al een aanvraag. Wacht even en probeer het opnieuw.";
  if (
    /timeout|timed out|econnreset|econnrefused|fetch failed|network|502|503|504/.test(
      message,
    )
  )
    return copy.network;
  if (status === 401 || /pin required|pincode required/.test(message))
    return language === "en"
      ? "Settings are locked. Enter your PIN and try again."
      : "Instellingen zijn vergrendeld. Voer je pincode in en probeer opnieuw.";
  if (status === 403)
    return language === "en"
      ? "You are not allowed to do that."
      : "Je mag deze actie niet uitvoeren.";
  if (status === 404)
    return language === "en"
      ? "That setting or service was not found. Reload and try again."
      : "Die instelling of dienst is niet gevonden. Laad opnieuw en probeer het nog eens.";
  if (status === 409)
    return language === "en"
      ? "The settings changed. Reload before trying again."
      : "De instellingen zijn gewijzigd. Laad ze opnieuw en probeer het nog eens.";
  if (status === 413 || /too large|te groot/.test(message))
    return language === "en"
      ? "That file or request is too large. Reduce it and try again."
      : "Dat bestand of verzoek is te groot. Verklein het en probeer opnieuw.";
  if (status === 429)
    return language === "en"
      ? "Too many requests. Wait a moment and try again."
      : "Te veel aanvragen. Wacht even en probeer het opnieuw.";
  if (status >= 500) return copy.network;
  if (status === 400 || status === 422)
    return language === "en"
      ? "Some information is missing or invalid. Check it and try again."
      : "Er ontbreekt informatie of iets is ongeldig. Controleer je invoer en probeer opnieuw.";
  return copy.generic;
}

export function uiErrorLanguage(): ErrorLanguage {
  return typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("en")
    ? "en"
    : "nl";
}
