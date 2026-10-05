import { storage } from "#lib/util/storage.ts";

function createSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return "jarvis-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

let sessionId = "";

/** The id of this browser's conversation, kept in localStorage ("jarvisSessionId"). */
export function getSessionId(): string {
  if (!sessionId) {
    sessionId = storage.get("jarvisSessionId", "");
    if (!sessionId) {
      sessionId = createSessionId();
      storage.set("jarvisSessionId", sessionId);
    }
  }
  return sessionId;
}
