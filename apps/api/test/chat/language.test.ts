import { describe, expect, it } from "vitest";
import { confirmationQuestion } from "../../src/confirmations/confirmation-words.js";
import { plainOutcome } from "../../src/chat/outcome.service.js";

describe("conversation language", () => {
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
