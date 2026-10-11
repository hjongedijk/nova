import { describe, expect, it } from "vitest";
import { nextToolInterjection } from "./tool-interjection.ts";

describe("tool waiting phrases", () => {
  it("does not repeat the previous phrase and varies across the available choices", () => {
    const first = nextToolInterjection("", () => 0);
    const second = nextToolInterjection(first, () => 0);
    const third = nextToolInterjection(second, () => 0.99);

    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("speaks about the current work and marks later steps conversationally", () => {
    expect(nextToolInterjection("", "ha_scene", 1, () => 0)).toContain(
      "apparaten",
    );
    expect(nextToolInterjection("", "calendar_events", 2, () => 0)).toBe(
      "Vervolgens: Ik kijk eerst in je agenda.",
    );
  });
});
