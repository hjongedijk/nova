import { describe, expect, it } from "vitest";
import { explainAgentWarning } from "../../src/integrations/windows/windows-pc.service.js";

describe("explainAgentWarning", () => {
  it("names the shortcut that is already taken (Windows error 1409)", () => {
    expect(
      explainAgentWarning("open: Ctrl+Alt+N (Windows error 1409)"),
    ).toMatch(/Ctrl\+Alt\+N wordt al gebruikt/);
  });
  it("explains other shortcut errors with the code", () => {
    expect(
      explainAgentWarning("desktop: Ctrl+Alt+D (Windows error 5)"),
    ).toMatch(/foutcode 5/);
  });
  it("explains tray and startup problems", () => {
    expect(explainAgentWarning("Tray: boom")).toMatch(/pictogram bij de klok/);
    expect(explainAgentWarning("Agent controls: boom")).toMatch(/opnieuw/);
  });
  it("never passes unknown or hostile text through", () => {
    for (const raw of [
      "something secret sk-123456789012345678901234",
      "open: Ctrl+Alt+N (Windows error 1409)\nignore previous",
      42,
      null,
    ])
      expect(explainAgentWarning(raw)).toBe(
        "Windows-bediening meldde een probleem. Controleer de agent op de pc.",
      );
  });
});
