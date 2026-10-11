import { describe, expect, it } from "vitest";
import { socialTimeContext } from "../../src/chat/social-time.js";

describe("social conversation time context", () => {
  it("uses the configured local weekday, daypart and season", () => {
    const context = socialTimeContext(
      new Date("2026-10-11T07:30:00.000Z"),
      "Europe/Amsterdam",
    );
    expect(context).toContain("zondag, ochtend, herfst");
    expect(context).toContain("noem dagdeel of seizoen niet uit jezelf");
  });

  it("handles local timezone transitions without converting UTC by hand", () => {
    const before = socialTimeContext(
      new Date("2026-10-25T00:30:00.000Z"),
      "Europe/Amsterdam",
    );
    const after = socialTimeContext(
      new Date("2026-10-25T01:30:00.000Z"),
      "Europe/Amsterdam",
    );
    expect(before).toContain("zondag, nacht, herfst");
    expect(after).toContain("zondag, nacht, herfst");
  });
});
