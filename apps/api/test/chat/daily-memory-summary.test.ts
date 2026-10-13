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

  it("keeps the latest decision within the transcript limit in chronological order", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: "user" as const,
      content: `Earlier discussion ${index}: ${"a".repeat(1180)}`,
      at: new Date(Date.UTC(2026, 9, 11, 8, index)).toISOString(),
    }));
    messages.push({
      role: "user",
      content: "Final decision: renovate the kitchen next month.",
      at: "2026-10-11T09:00:00.000Z",
    });

    const input = summaryInput(messages, "2026-10-11", "Europe/Amsterdam");

    expect(input.at(-1)?.content).toContain("Final decision");
    expect(input.map((message) => message.at)).toEqual(
      [...input.map((message) => message.at)].sort(),
    );
    expect(
      input.reduce((length, message) => length + message.content.length, 0),
    ).toBeLessThanOrEqual(12_000);
  });
});
