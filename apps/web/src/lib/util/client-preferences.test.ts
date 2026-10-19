import { describe, expect, it } from "vitest";
import { preferenceChanges } from "./client-preferences.ts";

describe("shared preference edits", () => {
  it("does not send unchanged stale values from another client", () => {
    expect(
      preferenceChanges(
        { novaVolume: "0.2", novaWake: "on" },
        { novaVolume: "0.2", novaWake: "on" },
      ),
    ).toEqual({});
    expect(
      preferenceChanges(
        { novaVolume: "0.6", novaWake: "on" },
        { novaVolume: "0.2", novaWake: "on" },
      ),
    ).toEqual({ novaVolume: "0.6" });
  });
  it("excludes hardware identifiers, sessions and secrets", () => {
    expect(
      preferenceChanges(
        {
          novaAudioInput: "private-mic",
          novaSessionId: "private-chat",
          token: "secret",
          novaWake: "off",
        },
        {},
      ),
    ).toEqual({ novaWake: "off" });
  });
});
