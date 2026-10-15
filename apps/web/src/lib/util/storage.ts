import {
  publishLocalPreferenceReceipt,
  type LocalPreferenceReceiptKind as LocalPreferenceKind,
} from "./local-preference-receipts.ts";

const legacyKeys: Readonly<Record<string, string>> = {
  novaSessionId: "jarvisSessionId",
  novaWake: "jarvisWake",
  novaPanels: "jarvisPanels",
  novaVoiceAlerts: "jarvisVoiceAlerts",
};

/** localStorage that never throws; legacy copies retain rollback compatibility. */
export const storage = {
  get(key: string, fallback: string): string {
    try {
      const current = localStorage.getItem(key);
      if (current !== null) return current;
      const legacy = legacyKeys[key];
      const previous = legacy ? localStorage.getItem(legacy) : null;
      if (previous === null) return fallback;
      try {
        localStorage.setItem(key, previous);
      } catch {
        /* Reading existing preferences remains possible when writes are blocked. */
      }
      return previous;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string, receipt?: LocalPreferenceKind): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* this visit only */
    }
    const legacy = legacyKeys[key];
    if (legacy) {
      try {
        localStorage.setItem(legacy, value);
      } catch {
        /* A failed rollback copy must not invalidate the current value. */
      }
    }
    if (receipt)
      publishLocalPreferenceReceipt(receipt, storage.matches(key, value));
  },
  /** Read the primary key again; a default or legacy fallback is not persistence evidence. */
  matches(key: string, expected: string): boolean {
    try {
      return localStorage.getItem(key) === expected;
    } catch {
      return false;
    }
  },
};
