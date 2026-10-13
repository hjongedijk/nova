import { describe, expect, it } from "vitest";
import type { SettingsOverview } from "@nova/contracts";
import { settingsActionReceipt } from "./action-receipts.ts";

const overview = {
  tools: [{ name: "secret-tool-name", switchedOff: true }],
  sidebar: [{ id: "w:secret-widget-id", column: "left", page: 1, shown: true }],
} as SettingsOverview;

describe("settings action receipts", () => {
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
});
