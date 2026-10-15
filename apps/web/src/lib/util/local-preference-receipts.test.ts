import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionReceipt } from "../stores/chat.svelte.ts";
import { onSettingsReceipt } from "../api/settings-receipt-events.ts";
import {
  publishLocalPreferenceReceipt,
  type LocalPreferenceReceiptKind,
} from "./local-preference-receipts.ts";

const kinds: LocalPreferenceReceiptKind[] = [
  "tts-voice",
  "tts-prosody",
  "wake-sensitivity",
  "pronunciations",
  "audio-input",
  "audio-output",
  "conversation-language",
  "volume",
  "wake",
  "voice-alerts",
  "panels",
  "light-sync",
];
const receipts: ActionReceipt[] = [];
let unsubscribe: () => void;

beforeEach(() => {
  receipts.length = 0;
  unsubscribe = onSettingsReceipt((receipt) => receipts.push(receipt));
});
afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
});

describe("local preference receipts", () => {
  it.each(kinds)(
    "limits confirmed %s receipts to fresh browser storage evidence",
    (kind) => {
      publishLocalPreferenceReceipt(kind, true);
      expect(receipts).toHaveLength(1);
      const receipt = receipts[0]!;
      expect(receipt.requested).toMatch(/aanpassen$/);
      expect(receipt.performed).toContain("keuze op dit apparaat opgeslagen");
      expect(receipt.verification).toBe(
        "Browseropslag opnieuw gelezen en gecontroleerd. Hardware, spraak en server niet gecontroleerd.",
      );
      expect(receipt.id).toMatch(/^local-settings-\d+-\d+$/);
    },
  );

  it.each(kinds)(
    "never claims %s was saved when storage is unconfirmed",
    (kind) => {
      publishLocalPreferenceReceipt(kind, false);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.performed).toContain("opslag niet bevestigd");
      expect(receipts[0]!.performed).not.toMatch(
        /opgeslagen|toegepast|geslaagd/i,
      );
      expect(receipts[0]!.verification).toBe(
        "Browseropslag niet bevestigd. Hardware, spraak en server niet gecontroleerd.",
      );
    },
  );

  it("emits only fixed labels and safe settings links without reading preference values", () => {
    for (const kind of kinds) publishLocalPreferenceReceipt(kind, true);
    for (const receipt of receipts) {
      expect(
        Object.keys(receipt)
          .filter((key) => key !== "recoverHref")
          .sort(),
      ).toEqual(["id", "performed", "requested", "verification"]);
      if (receipt.recoverHref)
        expect(receipt.recoverHref).toBe("/settings?section=voice");
      expect(JSON.stringify(receipt)).not.toMatch(
        /deviceId|voiceId|username|password|apiKey|https?:\/\//i,
      );
    }
    expect(
      receipts.find((receipt) => receipt.requested === "Spreekstem aanpassen")
        ?.recoverHref,
    ).toBe("/settings?section=voice");
    expect(
      receipts.find((receipt) => receipt.requested === "Zijpanelen aanpassen")
        ?.recoverHref,
    ).toBeUndefined();
  });

  it("keeps IDs unique at one clock tick and separate from both settings receipt owners", async () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    for (let index = 0; index < 20; index++)
      publishLocalPreferenceReceipt("volume", index % 2 === 0);
    const { settingsWriteReceipt } =
      await import("../api/settings-receipts.ts");
    const { settingsActionReceipt } =
      await import("../../components/settings/action-receipts.ts");
    const central = settingsWriteReceipt(
      "PUT",
      "/abilities/fixture",
      undefined,
      { ok: true },
    );
    const legacy = settingsActionReceipt(
      { kind: "persona-rules", text: "Synthetic rules." },
      null,
    );
    const ids = [
      ...receipts.map((receipt) => receipt.id),
      central!.id,
      legacy.id,
    ];
    expect(new Set(ids).size).toBe(22);
    expect(
      receipts.every((receipt) =>
        receipt.id.startsWith("local-settings-12345-"),
      ),
    ).toBe(true);
  });

  it("does not publish a receipt for a future or untrusted preference kind", () => {
    publishLocalPreferenceReceipt(
      "private-device-name" as LocalPreferenceReceiptKind,
      true,
    );
    publishLocalPreferenceReceipt(
      "__proto__" as LocalPreferenceReceiptKind,
      true,
    );
    expect(receipts).toHaveLength(0);
  });

  it("works without a mounted interface or storage globals", () => {
    unsubscribe();
    expect(() => publishLocalPreferenceReceipt("volume", false)).not.toThrow();
    expect(receipts).toHaveLength(0);
  });
});
