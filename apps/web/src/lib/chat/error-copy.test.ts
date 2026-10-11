import { describe, expect, it } from "vitest";
import { friendlyChatError } from "./error-copy.ts";

describe("friendly chat errors", () => {
  it("translates missing free-route setup in the selected language", () => {
    expect(friendlyChatError(new Error("OmniRoute is not configured"))).toBe(
      "NOVA heeft nu geen beschikbare gratis AI-route. Controleer de modelinstellingen.",
    );
    expect(
      friendlyChatError(new Error("OmniRoute is not configured"), "en"),
    ).toBe(
      "NOVA has no available free AI route right now. Check the model settings.",
    );
  });

  it.each([
    "ECONNREFUSED 10.0.0.7:8123 private-service-stack",
    "ETIMEDOUT while calling hidden-provider.internal",
    "Unknown model provider raw diagnostic",
  ])("hides raw diagnostics from the conversation: %s", (diagnostic) => {
    for (const language of ["nl", "en"] as const) {
      const result = friendlyChatError(new Error(diagnostic), language);
      expect(result).not.toContain(diagnostic);
      expect(result).not.toMatch(/ECONN|ETIMEDOUT|internal|provider/i);
      expect(result.length).toBeLessThan(130);
    }
  });

  it("gives known network and attachment failures plain next steps", () => {
    expect(friendlyChatError(new Error("fetch failed"))).toContain(
      "Probeer het zo nog eens",
    );
    expect(friendlyChatError(new Error("Unsupported file type"), "en")).toBe(
      "I could not read that attachment. Check the file type and size, then try again.",
    );
  });
});
