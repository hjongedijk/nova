import { describe, expect, it } from "vitest";
import type { SettingsOverview } from "@nova/contracts";
import { settingsActionReceipt } from "./action-receipts.ts";

const overview = {
  tools: [{ name: "secret-tool-name", switchedOff: true }],
  sidebar: [{ id: "w:secret-widget-id", column: "left", page: 1, shown: true }],
  personaStyle: "friendly",
  persona: "My private instruction and token abc123",
  quickActions: [
    { label: "Private label", prompt: "Private prompt token abc123" },
  ],
} as SettingsOverview;

describe("settings action receipts", () => {
  it("checks description edits and default restoration without exposing private content", () => {
    const saved = {
      ...overview,
      tools: [
        { name: "private-tool", description: "private rule", edited: true },
      ],
    } as SettingsOverview;
    const target = {
      kind: "tool-description",
      name: "private-tool",
      description: "private rule",
    } as const;
    const receipt = settingsActionReceipt(target, saved);
    expect(receipt.verification).toBe(
      "Opgeslagen waarde opnieuw gelezen en gecontroleerd",
    );
    expect(receipt.recoverHref).toBe("/settings?section=abilities");
    expect(JSON.stringify(receipt)).not.toMatch(/private-tool|private rule/);
    expect(
      settingsActionReceipt({ ...target, description: "different" }, saved)
        .verification,
    ).toContain("niet gecontroleerd");
    expect(settingsActionReceipt(target, null).verification).toContain(
      "niet gecontroleerd",
    );
    expect(
      settingsActionReceipt({ ...target, name: "missing" }, saved).verification,
    ).toContain("niet gecontroleerd");
    const reset = { ...target, description: null };
    expect(settingsActionReceipt(reset, saved).verification).toContain(
      "niet gecontroleerd",
    );
    const restored = {
      ...saved,
      tools: [
        {
          ...saved.tools[0]!,
          edited: false,
          description: "built-in description",
        },
      ],
    };
    expect(settingsActionReceipt(reset, restored).verification).toBe(
      "Opgeslagen waarde opnieuw gelezen en gecontroleerd",
    );
  });
  it("checks a tool toggle by reading the stored override without exposing its name", () => {
    const receipt = settingsActionReceipt(
      { kind: "tool-switch", name: "secret-tool-name", enabled: false },
      overview,
    );
    expect(receipt.verification).toContain("gecontroleerd");
    expect(receipt.recoverHref).toBe(
      "/settings?section=system#tool-switch-history",
    );
    expect(JSON.stringify(receipt)).not.toContain("secret-tool-name");
    expect(
      settingsActionReceipt(
        { kind: "tool-switch", name: "secret-tool-name", enabled: true },
        overview,
      ).verification,
    ).toContain("niet gecontroleerd");
  });

  it("checks the saved sidebar but keeps widget ids out of the card", () => {
    const receipt = settingsActionReceipt(
      { kind: "sidebar", items: overview.sidebar },
      overview,
    );
    expect(receipt.verification).toContain("gecontroleerd");
    expect(JSON.stringify(receipt)).not.toContain("secret-widget-id");
    expect(
      settingsActionReceipt(
        { kind: "sidebar", items: [{ ...overview.sidebar[0]!, shown: false }] },
        overview,
      ).verification,
    ).toContain("niet gecontroleerd");
    expect(
      settingsActionReceipt({ kind: "sidebar", items: [] }, null).verification,
    ).toContain("niet gecontroleerd");
  });

  it("checks persona settings without copying private rules to the card", () => {
    const style = settingsActionReceipt(
      { kind: "persona-style", style: "friendly" },
      overview,
    );
    expect(style.verification).toContain("gecontroleerd");
    expect(style.recoverHref).toBe(
      "/settings?section=personality#persona-preferences-history",
    );
    const rules = settingsActionReceipt(
      { kind: "persona-rules", text: overview.persona },
      overview,
    );
    expect(rules.verification).toContain("gecontroleerd");
    expect(rules.recoverHref).toBe(
      "/settings?section=personality#persona-history",
    );
    expect(JSON.stringify(rules)).not.toContain(overview.persona);
    expect(
      settingsActionReceipt(
        { kind: "persona-rules", text: "other instruction" },
        overview,
      ).verification,
    ).toContain("niet gecontroleerd");
  });

  it("checks quick actions in order without copying labels or prompts", () => {
    const receipt = settingsActionReceipt(
      {
        kind: "quick-actions",
        items: overview.quickActions,
        operation: "reset",
      },
      overview,
    );
    expect(receipt.verification).toContain("gecontroleerd");
    expect(receipt.requested).toBe("Standaard snelle opdrachten herstellen");
    expect(receipt.recoverHref).toBe(
      "/settings?section=general#quick-actions-history",
    );
    expect(receipt.recovery).toBe("quick-actions");
    expect(JSON.stringify(receipt)).not.toContain("Private");
    expect(JSON.stringify(receipt)).not.toContain("abc123");
    expect(
      settingsActionReceipt(
        { kind: "quick-actions", items: [], operation: "save" },
        overview,
      ).verification,
    ).toContain("niet gecontroleerd");
  });
});
