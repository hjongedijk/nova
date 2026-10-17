import { describe, expect, it } from "vitest";
import {
  MASKED_TEXT,
  confidenceWord,
  kindLabel,
  memoryQueryPath,
  visibleText,
} from "./memory.ts";

describe("memory helpers", () => {
  it("words the confidence", () => {
    expect(confidenceWord(1)).toBe("zeker");
    expect(confidenceWord(0.8)).toBe("zeker");
    expect(confidenceWord(0.6)).toBe("waarschijnlijk");
    expect(confidenceWord(0.4)).toBe("niet bevestigd");
    expect(confidenceWord(undefined)).toBe("zeker");
    expect(confidenceWord(Number.NaN)).toBe("zeker");
  });
  it("masks sensitive text until revealed", () => {
    const item = { id: "a", text: "Mijn BSN is 123", sensitive: true };
    expect(visibleText(item, false)).toBe(MASKED_TEXT);
    expect(visibleText(item, false)).not.toContain("123");
    expect(visibleText(item, true)).toBe("Mijn BSN is 123");
    expect(visibleText({ id: "b", text: "Hallo" }, false)).toBe("Hallo");
  });
  it("labels kinds", () => {
    expect(kindLabel("decision")).toBe("Besluit");
    expect(kindLabel(undefined)).toBe("Feit");
  });
  it("builds the list query", () => {
    expect(memoryQueryPath({})).toBe("/memories?limit=20");
    expect(
      memoryQueryPath({
        kind: "project",
        q: " nova ",
        history: true,
        cursor: 40,
      }),
    ).toBe("/memories?limit=20&kind=project&q=nova&history=true&offset=40");
  });
});
