import { afterEach, describe, expect, it, vi } from "vitest";
import { storage } from "#lib/util/storage.ts";
import {
  getConversationLanguage,
  getSessionId,
  resetSession,
  setConversationLanguage,
} from "./session.ts";

describe("per-conversation language preference", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stores the language against this session and starts a new session in Dutch", () => {
    const values = new Map<string, string>([["jarvisSessionId", "session-a"]]);
    vi.spyOn(storage, "get").mockImplementation(
      (key, fallback) => values.get(key) ?? fallback,
    );
    vi.spyOn(storage, "set").mockImplementation((key, value) =>
      values.set(key, value),
    );

    expect(getConversationLanguage()).toBe("nl");
    expect(setConversationLanguage("en")).toBe("en");
    expect(getConversationLanguage()).toBe("en");
    expect(values.get(`novaConversationLanguage:${getSessionId()}`)).toBe("en");

    resetSession();
    expect(getConversationLanguage()).toBe("nl");
  });
});
