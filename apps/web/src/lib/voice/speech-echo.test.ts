import { describe, expect, it } from "vitest";
import { isSpeechEcho } from "./speech-echo.ts";

describe("speech echo guard", () => {
  it("recognizes punctuation and case variants of the current spoken answer", () => {
    expect(isSpeechEcho("NOVA!", "Ik ben NOVA, zal ik verder kijken?")).toBe(
      true,
    );
  });

  it("allows a distinct wake phrase to interrupt speech", () => {
    expect(
      isSpeechEcho("Hey NOVA, stop alsjeblieft", "Ik controleer de server."),
    ).toBe(false);
  });

  it("does not treat empty recognition as an echo", () => {
    expect(isSpeechEcho("   ", "Ik luister.")).toBe(false);
  });
});
