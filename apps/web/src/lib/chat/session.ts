import { storage } from "#lib/util/storage.ts";

function createSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return "nova-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

let sessionId = "";

export type ConversationLanguage = "nl" | "en";
const LANGUAGE_KEY = "novaConversationLanguage";

export function getConversationLanguage(): ConversationLanguage {
  const language = storage.get(`${LANGUAGE_KEY}:${getSessionId()}`, "nl");
  return language === "en" ? "en" : "nl";
}

export function setConversationLanguage(
  language: ConversationLanguage,
): ConversationLanguage {
  storage.set(`${LANGUAGE_KEY}:${getSessionId()}`, language);
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("nova-conversation-language-changed"));
  return language;
}

/** The id of this browser's conversation, kept in localStorage ("novaSessionId"). */
export function getSessionId(): string {
  if (!sessionId) {
    sessionId = storage.get("novaSessionId", "");
    if (!sessionId) {
      sessionId = createSessionId();
      storage.set("novaSessionId", sessionId);
    }
  }
  return sessionId;
}

/** Start a fresh server conversation when the user explicitly clears chat. */
export function resetSession(): void {
  sessionId = createSessionId();
  storage.set("novaSessionId", sessionId);
}
