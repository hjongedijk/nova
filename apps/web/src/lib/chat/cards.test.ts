import { describe, expect, it } from "vitest";
import type { PendingConfirmation } from "@nova/contracts";

describe("confirmation labels", () => {
  it("distinguishes performed actions from verified outcomes", async () => {
    Object.assign(globalThis, { $state: (value: unknown) => value });
    const { actionReceipt } = await import("./cards.svelte.ts");
    const card = {
      id: "confirmation-1",
      tool: "code_file_write",
      label: "Wijzig bestand a.ts.\nBevestiging verloopt.",
    };
    expect(actionReceipt(card, { ok: true, verified: true })).toMatchObject({
      requested: "Wijzig bestand a.ts.",
      performed: "code file write: uitgevoerd",
      verification: "Werkelijk gecontroleerd",
    });
    expect(actionReceipt(card, { ok: true, accepted: true }).verification).toBe(
      "Aangenomen; voltooiing niet gecontroleerd",
    );
    expect(actionReceipt(card, { ok: false }).performed).toContain(
      "niet uitgevoerd",
    );
  });
  it("approves any card by spoken or typed yes and the Y key", async () => {
    Object.assign(globalThis, { $state: (value: unknown) => value });
    const cards = await import("./cards.svelte.ts");
    expect(cards.isApproveReply("ja!")).toBe(true);
    expect(cards.isApproveReply("nee")).toBe(false);
    expect("requiresScreenConfirmation" in cards).toBe(false);
    expect(cards.confirmationShortcutApproval("y")).toBe(true);
    expect(cards.confirmationShortcutApproval("n")).toBe(false);
    expect(cards.confirmationShortcutApproval("x")).toBe(null);
  });

  it("uses the selected language without hiding destructive consequences", async () => {
    const action: PendingConfirmation = {
      confirmationId: "confirm-1",
      sessionId: "session-1",
      tool: "code_file_delete",
      args: { projectId: "nova", path: "src/example.ts" },
      createdAt: 0,
      expiresAt: 60_000,
    };

    Object.assign(globalThis, { $state: (value: unknown) => value });
    const { confirmationLabel } = await import("./cards.svelte.ts");
    expect(confirmationLabel(action, "en")).toContain(
      "Delete file nova/src/example.ts. This cannot be undone.",
    );
    expect(confirmationLabel(action, "en")).toContain(
      "Confirmation expires in 60 seconds.",
    );
    expect(confirmationLabel(action, "nl")).toContain(
      "Dit kan niet ongedaan worden gemaakt.",
    );
    expect(
      confirmationLabel(
        {
          ...action,
          tool: "ha_call_service",
          args: {
            entity_id: "alarm_control_panel.house",
            domain: "alarm_control_panel",
            service: "alarm_disarm",
          },
        },
        "en",
      ),
    ).toContain("alarm_control_panel.alarm_disarm");
  });
});
