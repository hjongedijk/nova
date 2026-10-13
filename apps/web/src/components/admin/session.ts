import { storage } from "#lib/util/storage.ts";

/** The browser's conversation id, the same one the chat uses (localStorage novaSessionId). */
export function sessionId(): string {
  let id = storage.get("novaSessionId", "");
  if (!id) {
    id = crypto?.randomUUID
      ? crypto.randomUUID()
      : `nova-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    storage.set("novaSessionId", id);
  }
  return id;
}
