import { storage } from "#lib/util/storage.ts";

/** The browser's conversation id, the same one the chat uses (localStorage jarvisSessionId). */
export function sessionId(): string {
  let id = storage.get("jarvisSessionId", "");
  if (!id) {
    id = crypto?.randomUUID
      ? crypto.randomUUID()
      : `jarvis-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    storage.set("jarvisSessionId", id);
  }
  return id;
}
