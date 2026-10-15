import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommunicationPreference } from "@nova/contracts";
import type { ActionReceipt } from "../stores/chat.svelte.ts";
import { onSettingsReceipt } from "../api/settings-receipt-events.ts";
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

describe("remembered communication preference receipts", () => {
  let cards: ActionReceipt[];
  let stop: () => void;
  beforeEach(() => {
    cards = [];
    stop = onSettingsReceipt((card) => cards.push(card));
  });
  afterEach(() => stop());

  it("confirms primary storage on each explicit toggle without copying options", () => {
    const local = storage('["PRIVATE_STORED_OPTION"]');
    for (const choice of [
      "concise",
      "fewer_jokes",
      "more_detail",
      "warmer",
    ] as const)
      saveCommunicationPreference(choice, local);
    expect(cards).toHaveLength(4);
    expect(cards.every((card) => card.performed.includes("opgeslagen"))).toBe(
      true,
    );
    expect(
      cards.every((card) =>
        card.verification.includes("Browseropslag opnieuw gelezen"),
      ),
    ).toBe(true);
    const projected = JSON.stringify(cards);
    for (const secret of [
      "PRIVATE_STORED_OPTION",
      "concise",
      "fewer_jokes",
      "more_detail",
      "warmer",
      "nova-communication-preferences-v1",
    ])
      expect(projected).not.toContain(secret);
    expect(new Set(cards.map((card) => card.id)).size).toBe(4);
  });

  it.each(["write throws", "read throws", "write discarded", "no storage"])(
    "keeps preferences usable but does not claim persistence when %s",
    (mode) => {
      const local =
        mode === "no storage"
          ? null
          : {
              getItem: () => {
                if (mode === "read throws")
                  throw new Error("PRIVATE_STORAGE_ERROR");
                return null;
              },
              setItem: () => {
                if (mode === "write throws")
                  throw new Error("PRIVATE_STORAGE_ERROR");
              },
            };
      expect(saveCommunicationPreference("warmer", local)).toEqual(["warmer"]);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.performed).toContain("opslag niet bevestigd");
      expect(cards[0]!.performed).not.toContain("opgeslagen");
      expect(JSON.stringify(cards)).not.toContain("PRIVATE_STORAGE_ERROR");
    },
  );

  it("does not publish on passive reads or rejected choices", () => {
    const local = storage('["concise"]');
    expect(readCommunicationPreferences(local)).toEqual(["concise"]);
    expect(readCommunicationPreferences(storage("invalid"))).toEqual([]);
    expect(
      saveCommunicationPreference(
        "PRIVATE_UNKNOWN" as CommunicationPreference,
        local,
      ),
    ).toEqual(["concise"]);
    expect(cards).toEqual([]);
  });
});
