import { describe, expect, it } from "vitest";
import {
  clearHandoff,
  handoffPrompt,
  latestQuestion,
  readHandoff,
  saveHandoff,
} from "./handoff.ts";

function local() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("local conversation handoff", () => {
  it("keeps one bounded card across visits and clears it on request", () => {
    const storage = local();
    expect(
      latestQuestion([
        { role: "user", text: "eerste" },
        { role: "assistant", text: "antwoord" },
        { role: "user", text: "volgende vraag" },
      ]),
    ).toBe("volgende vraag");
    const saved = saveHandoff(
      "  volgende vraag ",
      "a.ts\nb.md",
      "Controleer de tests",
      storage,
      1000,
    )!;
    expect(readHandoff(storage, 2000)).toEqual(saved);
    expect(handoffPrompt(saved)).toContain("Relevante bestanden: a.ts, b.md");
    clearHandoff(storage);
    expect(readHandoff(storage, 2000)).toBeNull();
  });

  it("rejects incomplete, malformed and stale cards", () => {
    const storage = local();
    expect(saveHandoff("vraag", "", "", storage)).toBeNull();
    storage.setItem("nova-handoff-v1", "{broken");
    expect(readHandoff(storage)).toBeNull();
    saveHandoff("vraag", "", "stap", storage, 1000);
    expect(readHandoff(storage, 31 * 24 * 60 * 60_000)).toBeNull();
    expect(storage.getItem("nova-handoff-v1")).toBeNull();
  });
});
