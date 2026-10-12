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
  it("keeps sensitive cards open for spoken or typed approval words", async () => {
    Object.assign(globalThis, { $state: (value: unknown) => value });
    const {
      isApproveReply,
      requiresScreenConfirmation,
      keepCardAfterReply,
      confirmationShortcutApproval,
    } = await import("./cards.svelte.ts");
    const base: PendingConfirmation = {
      confirmationId: "confirm-1",
      sessionId: "session-1",
      tool: "ha_call_service",
      args: { domain: "alarm_control_panel", service: "alarm_arm_home" },
      risk: "CONFIRM",
      createdAt: 0,
      expiresAt: 60_000,
    };
    expect(isApproveReply("ja!")).toBe(true);
    expect(isApproveReply("nee")).toBe(false);
    expect(requiresScreenConfirmation(base)).toBe(true);
    expect(keepCardAfterReply(base, "ja!")).toBe(true);
    expect(keepCardAfterReply(base, "nee")).toBe(false);
    expect(confirmationShortcutApproval({ screenOnly: true }, "y")).toBe(null);
    expect(confirmationShortcutApproval({ screenOnly: true }, "n")).toBe(false);
    expect(confirmationShortcutApproval({ screenOnly: false }, "y")).toBe(true);
    expect(
      requiresScreenConfirmation({ ...base, args: { domain: "light" } }),
    ).toBe(false);
    expect(
      requiresScreenConfirmation({
        ...base,
        args: { domain: "cover", service: "open_cover" },
      }),
    ).toBe(true);
    expect(
      requiresScreenConfirmation({
        ...base,
        args: { domain: "script", service: "turn_on" },
      }),
    ).toBe(true);
    expect(
      requiresScreenConfirmation({ ...base, tool: "browser_click_confirmed" }),
    ).toBe(true);
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
