import { describe, expect, it } from "vitest";
import { confirmationQuestion } from "../../src/confirmations/confirmation-words.js";
import { plainOutcome } from "../../src/chat/outcome.service.js";

describe("conversation language", () => {
  it("states briefing schedule changes and event-only mode in confirmations", () => {
    const action = {
      tool: "node_red_briefing_schedule",
      args: {
        kind: "evening_review",
        time: "20:30",
        timezone: "Europe/Amsterdam",
      },
    };
    expect(confirmationQuestion(action)).toContain(
      "het avondoverzicht dagelijks om 20:30 plannen (Europe/Amsterdam)",
    );
    expect(confirmationQuestion(action)).toContain("60 seconden");
    expect(
      confirmationQuestion({ ...action, args: { ...action.args, time: "" } }),
    ).toContain("alleen op gekoppelde gebeurtenissen");
  });
  it("uses English for confirmation and confirmed-action fallback text", () => {
    const action = {
      tool: "windows_lock",
      args: {},
    };
    expect(confirmationQuestion(action, true)).toContain("Shall I");
    expect(
      plainOutcome({ ok: true, result: { output: "Locked" } }, "en"),
    ).toContain("Here is the result");
    expect(plainOutcome({ ok: true }, "en")).toBe("Done.");
  });
});
