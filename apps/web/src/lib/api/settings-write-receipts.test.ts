import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionReceipt } from "../stores/chat.svelte.ts";
import { onSettingsReceipt } from "./settings-receipt-events.ts";

const receipts: ActionReceipt[] = [];
let unsubscribe: () => void;

import {
  confirmNodeRedPalette,
  createSkill,
  getSettings,
  prepareNodeRedPalette,
  savePersona,
  saveServiceConnection,
  setAbility,
} from "./settings.ts";

function response(value: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => Response.json(value, { status })),
  );
}

describe("settings writes publish action receipts", () => {
  beforeEach(() => {
    receipts.length = 0;
    unsubscribe = onSettingsReceipt((receipt) => {
      receipts.unshift(receipt);
    });
  });
  afterEach(() => {
    unsubscribe();
    vi.unstubAllGlobals();
  });

  it("publishes one card per success and preserves the response", async () => {
    response({ ok: true });
    for (let i = 0; i < 12; i++) {
      expect(await setAbility("private-ability", true)).toEqual({ ok: true });
    }
    expect(receipts).toHaveLength(12);
    expect(new Set(receipts.map((r) => (r as { id: string }).id)).size).toBe(
      12,
    );
    expect(JSON.stringify(receipts)).not.toContain("private-ability");
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/settings/abilities/private-ability",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ "x-nova-admin": "1" }),
      }),
    );
  });

  it("does not publish while the network request is still pending", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = createSkill({} as Parameters<typeof createSkill>[0]);
    expect(receipts).toHaveLength(0);
    finish(Response.json({ ok: true, skill: { id: "private" } }));
    await pending;
    expect(receipts).toHaveLength(1);
  });

  it("keeps credentials and upstream warning prose out of cards", async () => {
    response({ ok: true, restartRequired: true, warning: "private-password" });
    await saveServiceConnection("omniroute", {
      apiKey: "private-key",
      url: "https://private-host.invalid",
    });
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts)).not.toMatch(/private-|omniroute/);
  });

  it("preserves failures without a success card", async () => {
    response({ ok: false, error: "failed" });
    expect(await setAbility("fixture", true)).toEqual({
      ok: false,
      error: "failed",
    });
    response({ error: "failed" }, 500);
    await expect(setAbility("fixture", true)).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(setAbility("fixture", true)).rejects.toThrow("offline");
    expect(receipts).toHaveLength(0);
  });

  it("leaves reads, preparations, rejections and existing readback owners alone", async () => {
    response({ ok: true });
    await getSettings();
    await savePersona("private rules");
    await prepareNodeRedPalette("fixture", true, "revision");
    await confirmNodeRedPalette("session", "confirmation", false);
    response({ ok: true, cancelled: true });
    await confirmNodeRedPalette("session", "confirmation", true);
    expect(receipts).toHaveLength(0);
  });

  it("keeps a staged palette upgrade distinct from a verified running change", async () => {
    response({ ok: true, verified: false, pendingRestart: true });
    await confirmNodeRedPalette("session", "confirmation", true);
    expect(receipts).toHaveLength(1);
    const staged = receipts[0] as { performed: string; verification: string };
    expect(staged.performed).toMatch(/herstart/i);
    expect(staged.verification).toMatch(/niet|ontbreekt/i);
  });

  it("does not treat a generic ok response as independent verification", async () => {
    response({ ok: true, verified: true });
    await setAbility("fixture", true);
    expect(receipts).toHaveLength(1);
    expect((receipts[0] as { verification: string }).verification).toMatch(
      /niet|ontbreekt/i,
    );
  });
});
