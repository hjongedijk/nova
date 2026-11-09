import { describe, expect, it } from "vitest";
import { isOwnSpeech, isSpeechEcho } from "./speech-echo.ts";

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

describe("own speech while NOVA talks", () => {
  const spoken =
    "Morgen wordt het zonnig in Utrecht met een graad of achttien en weinig wind.";
  it("lets a distinct sentence of the owner through", () => {
    expect(isOwnSpeech("wacht even en zaterdag dan", spoken)).toBe(true);
  });
  it("treats a garbled repeat of her own words as echo", () => {
    expect(isOwnSpeech("het zonnig in utrecht met graad", spoken)).toBe(false);
    expect(isOwnSpeech("zonnig in Utrecht", spoken)).toBe(false);
  });
  it("needs at least three words", () => {
    expect(isOwnSpeech("stop nou", spoken)).toBe(false);
  });
});
