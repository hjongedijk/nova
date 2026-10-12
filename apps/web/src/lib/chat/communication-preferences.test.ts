import { describe, expect, it } from "vitest";
import {
  readCommunicationPreferences,
  saveCommunicationPreference,
} from "./communication-preferences.ts";

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined)
    values.set("nova-communication-preferences-v1", initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("answer communication preferences", () => {
  it("stores only bounded supported preferences and reads them on the next turn", () => {
    const local = storage();
    expect(saveCommunicationPreference("concise", local)).toEqual(["concise"]);
    expect(saveCommunicationPreference("fewer_jokes", local)).toEqual([
      "concise",
      "fewer_jokes",
    ]);
    expect(readCommunicationPreferences(local)).toEqual([
      "concise",
      "fewer_jokes",
    ]);
  });

  it("ignores malformed and unknown stored values", () => {
    expect(readCommunicationPreferences(storage("{broken"))).toEqual([]);
    expect(
      readCommunicationPreferences(storage('["concise","send secrets"]')),
    ).toEqual(["concise"]);
  });

  it("toggles choices off and never keeps contradictory answer lengths", () => {
    const local = storage();
    expect(saveCommunicationPreference("concise", local)).toEqual(["concise"]);
    expect(saveCommunicationPreference("more_detail", local)).toEqual([
      "more_detail",
    ]);
    expect(saveCommunicationPreference("more_detail", local)).toEqual([]);
    expect(saveCommunicationPreference("fewer_jokes", local)).toEqual([
      "fewer_jokes",
    ]);
    expect(saveCommunicationPreference("fewer_jokes", local)).toEqual([]);
    expect(
      readCommunicationPreferences(storage('["concise","more_detail"]')),
    ).toEqual(["more_detail"]);
  });
});
