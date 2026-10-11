import { describe, expect, it } from "vitest";
import {
  dueSummaryDate,
  summaryInput,
} from "../../src/chat/daily-memory-summary.service.js";

describe("daily memory summary schedule", () => {
  it("waits until 02:45 local time and targets the previous calendar day", () => {
    expect(
      dueSummaryDate(new Date("2026-10-12T00:44:59Z"), "Europe/Amsterdam"),
    ).toBeNull();
    expect(
      dueSummaryDate(new Date("2026-10-12T00:45:00Z"), "Europe/Amsterdam"),
    ).toBe("2026-10-11");
    expect(
      dueSummaryDate(new Date("2026-10-12T01:45:00Z"), "Europe/Amsterdam"),
    ).toBe("2026-10-11");
  });

  it("keeps only the requested local date and removes refusal noise", () => {
    const input = summaryInput(
      [
        {
          role: "user",
          content: "Kan je me helpen met de planning van de verbouwing?",
          at: "2026-10-11T19:59:00.000Z",
        },
        {
          role: "assistant",
          content: "Ik kan dat niet vinden.",
          at: "2026-10-11T20:01:00.000Z",
        },
        {
          role: "user",
          content: "We hebben besloten de keuken volgende maand te verbouwen.",
          at: "2026-10-11T20:02:00.000Z",
        },
        {
          role: "user",
          content: "Deze hoort bij een andere dag en moet weg.",
          at: "2026-10-10T20:00:00.000Z",
        },
      ],
      "2026-10-11",
      "Europe/Amsterdam",
    );
    expect(input).toHaveLength(1);
    expect(input[0]?.content).toContain("keuken");
  });
});
