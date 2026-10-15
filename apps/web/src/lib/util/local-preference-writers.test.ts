import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionReceipt } from "../stores/chat.svelte.ts";
import { onSettingsReceipt } from "../api/settings-receipt-events.ts";
import { storage } from "./storage.ts";
import {
  saveTtsProsody,
  saveTtsVoice,
  setServerDefaultVoice,
  ttsVoice,
} from "../voice/voice-preference.ts";
import {
  saveWakeSensitivity,
  wakeSensitivity,
} from "../voice/wake-preference.ts";
import {
  savePronunciationEntries,
  pronunciationEntries,
} from "../voice/speech-filter.ts";
import {
  setSelectedInputDevice,
  selectedInputDevice,
} from "../voice/input-device.ts";
import {
  getConversationLanguage,
  setConversationLanguage,
} from "../chat/session.ts";

describe("user preference persistence receipts", () => {
  let cards: ActionReceipt[];
  let values: Map<string, string>;
  let stop: () => void;
  beforeEach(() => {
    cards = [];
    values = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    });
    vi.stubGlobal("window", new EventTarget());
    stop = onSettingsReceipt((card) => {
      cards.push(card);
    });
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
  });

  function changePreferences(): void {
    saveTtsVoice("en-GB-RyanNeural");
    saveTtsProsody(2, 1);
    saveWakeSensitivity("high");
    savePronunciationEntries([
      { term: "private-family", say: "private pronunciation" },
    ]);
    setSelectedInputDevice("private-device-id");
    setConversationLanguage("en");
  }

  it("checks all six real writers after persistence without projecting values", () => {
    changePreferences();
    expect(cards).toHaveLength(6);
    expect(cards.every((card) => card.performed.includes("opgeslagen"))).toBe(
      true,
    );
    expect(
      cards.every((card) =>
        card.verification.includes(
          "Hardware, spraak en server niet gecontroleerd",
        ),
      ),
    ).toBe(true);
    expect(JSON.stringify(cards)).not.toMatch(
      /private-|RyanNeural|private pronunciation/,
    );
    expect(ttsVoice()).toBe("en-GB-RyanNeural");
    expect(wakeSensitivity()).toBe("high");
    expect(pronunciationEntries()).toEqual([
      { term: "private-family", say: "private pronunciation" },
    ]);
    expect(selectedInputDevice()).toBe("private-device-id");
    expect(getConversationLanguage()).toBe("en");
  });

  it("does not claim persistence when the actual storage writer throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(changePreferences).not.toThrow();
    expect(cards).toHaveLength(6);
    expect(
      cards.every((card) => card.performed.includes("opslag niet bevestigd")),
    ).toBe(true);
    expect(cards.every((card) => !card.performed.includes("opgeslagen"))).toBe(
      true,
    );
  });

  it("does not verify partially stored prosody or an unavailable readback", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === "novaTtsPitch") throw new Error("blocked");
        values.set(key, value);
      },
    });
    saveTtsProsody(2, 1);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.performed).toContain("opslag niet bevestigd");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    });
    saveTtsVoice("en-GB-RyanNeural");
    expect(cards[1]?.performed).toContain("opslag niet bevestigd");
  });

  it("keeps passive reads, legacy migration, server defaults and automatic writes silent", () => {
    values.set("jarvisPanels", "off");
    expect(storage.get("novaPanels", "on")).toBe("off");
    setServerDefaultVoice("nl-NL-FennaNeural");
    ttsVoice();
    wakeSensitivity();
    pronunciationEntries();
    selectedInputDevice();
    getConversationLanguage();
    storage.set("novaWake", "off");
    storage.set("novaAudioOutput", "");
    expect(cards).toHaveLength(0);
  });

  it("keeps live prosody preview persistent and emits one card at the end of the adjustment", () => {
    saveTtsProsody(1, 0, false);
    saveTtsProsody(2, 0, false);
    saveTtsProsody(3, 0, false);
    expect(values.get("novaTtsRate")).toBe("3");
    expect(cards).toHaveLength(0);
    saveTtsProsody(3, 0);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.performed).toContain("opgeslagen");
  });
});
